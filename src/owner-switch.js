import { randomUUID } from 'node:crypto'

const OPERATIONS = 'owner-switch:operation:'
const OPERATIONS_END = 'owner-switch:operation;'
const HOLD = 'owner-switch:hold:'
const REQUESTS = 'owner-switch:request:'
const HELD = new Set(['waiting', 'preparing'])
const PENDING = new Set([...HELD, 'committed'])
const OWNER_PRESETS = { chief: 'hub-bot-router', owner: 'hub-bot-owner' }
const INITIALIZATION = '先接收以下负责人事实，等绑定完成和下一条任务。此轮只需确认已接收，不调用工具、执行任务或发送消息。'
const PREPARATION_FAILURE = {
  status: '无法确认原负责人会话状态。',
  stop: '无法停止原负责人会话。',
  facts: '无法加载负责人事实清单。',
  create: '无法创建新负责人会话。',
  prompt: '无法向新负责人会话加载事实清单。',
  commit: '无法提交负责人会话绑定。',
}

export class OwnerSwitchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OwnerSwitchError'
    this.code = code
  }
}

class ProgressWriteError extends Error {}

function receipt(row) {
  const { revision, initializationText, ...value } = row
  return value
}

function identifier(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Durable, explicitly authorized switches of a stable L1/L2 identity to a fresh session. */
export class OwnerSwitch {
  #inFlight = new Set()

  /** recordChange writes progress synchronously to this Store within the switch transaction. */
  constructor({ store, registry, sessions, buildFacts, now, ids, recordChange, withAdmission }) {
    this.store = store
    this.registry = registry
    this.sessions = sessions
    this.buildFacts = buildFacts
    this.now = now ?? (() => new Date().toISOString())
    this.ids = ids ?? { uuid: randomUUID }
    this.recordChange = recordChange
    this.withAdmission = withAdmission ?? ((_ownerId, work) => work())
  }

  #transaction(work) {
    const db = this.store.db
    // Feishu can call us within an intake transaction. Roll back local writes if it handles an error.
    const nested = db.isTransaction
    db.exec(nested ? 'SAVEPOINT owner_switch' : 'BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec(nested ? 'RELEASE owner_switch' : 'COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec(nested ? 'ROLLBACK TO owner_switch; RELEASE owner_switch' : 'ROLLBACK')
      throw error
    }
  }

  #read(operationId) {
    return this.store.get(OPERATIONS + operationId)
  }

  #hold(ownerId) {
    const id = this.store.get(HOLD + ownerId)
    return id ? this.#read(id) : undefined
  }

  #rows(ownerId) {
    return this.store.db.prepare(`
      SELECT value FROM kv WHERE key >= ? AND key < ?
      AND (? IS NULL OR json_extract(value, '$.ownerId') = ?) ORDER BY rowid DESC
    `).all(OPERATIONS, OPERATIONS_END, ownerId ?? null, ownerId ?? null).map(({ value }) => JSON.parse(value))
  }

  #recordProgress(row) {
    try {
      this.recordChange?.(receipt(row))
    } catch (error) {
      throw new ProgressWriteError('Unable to record owner switch progress.', { cause: error })
    }
  }

  #same(row) {
    return !this.store.closed && this.#read(row.operationId)?.revision === row.revision
  }

  #transition(row, changes, bind) {
    if (this.store.closed) return undefined
    return this.#transaction(() => {
      if (!this.#same(row)) return undefined
      const value = { ...row, ...changes, revision: row.revision + 1, updatedAt: this.now() }
      bind?.()
      this.store.db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(value), OPERATIONS + row.operationId)
      if (HELD.has(row.status) && !HELD.has(value.status)) {
        this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(HOLD + row.ownerId)
      }
      if (value.status !== row.status) this.#recordProgress(value)
      return value
    })
  }

  #requireOldBinding({ ownerId, oldSessionId }) {
    const owner = this.registry.findByCurrentSession(oldSessionId)
    if (owner?.id !== ownerId || !Object.hasOwn(OWNER_PRESETS, owner?.role)) {
      throw new OwnerSwitchError('stale-owner-binding', 'The selected session is no longer the current owner binding.')
    }
    return owner
  }

  #requireFreshSession(sessionId) {
    if (this.registry.isOwnerSession(sessionId)) {
      throw new OwnerSwitchError('owner-switch-id-conflict', 'The proposed owner session ID is already in use.')
    }
  }

  /** Caller must authorize the original explicit user request before registering it here. */
  request({ ownerId, expectedSessionId, mode = 'wait', requestId }) {
    if (!identifier(ownerId) || !identifier(expectedSessionId) || (mode !== 'wait' && mode !== 'stop')
      || (requestId !== undefined && !identifier(requestId))) {
      throw new OwnerSwitchError('invalid-owner-switch', 'Specify the owner, its current session, and a supported switch mode.')
    }
    const matches = row => row.ownerId === ownerId && row.oldSessionId === expectedSessionId && row.mode === mode
    const requestKey = requestId === undefined ? null : REQUESTS + requestId
    const row = this.#transaction(() => {
      const existingId = requestKey && this.store.get(requestKey)
      if (existingId) {
        const existing = this.#read(existingId)
        if (!matches(existing)) {
          throw new OwnerSwitchError('owner-switch-request-conflict', 'This request ID belongs to a different switch.')
        }
        return existing
      }
      this.#requireOldBinding({ ownerId, oldSessionId: expectedSessionId })
      const held = this.#hold(ownerId)
      if (held) {
        if (!matches(held)) throw new OwnerSwitchError('owner-switch-in-progress', 'This owner already has a pending switch.')
        if (requestKey) this.store.set(requestKey, held.operationId)
        return held
      }

      const nonce = this.ids.uuid()
      const operationId = 'switch-' + nonce
      const newSessionId = 'session-' + nonce
      if (this.#read(operationId)) {
        throw new OwnerSwitchError('owner-switch-id-conflict', 'The proposed switch operation ID is already in use.')
      }
      this.#requireFreshSession(newSessionId)
      const at = this.now()
      const value = {
        operationId, ownerId, oldSessionId: expectedSessionId, newSessionId,
        initializationRequestId: 'hub-bot-switch-' + nonce, mode, requestId: requestId ?? null,
        status: 'waiting', reason: null, errorCode: null, createdAt: at, updatedAt: at, revision: 0,
      }
      this.store.set(OPERATIONS + operationId, value)
      this.store.set(HOLD + ownerId, operationId)
      if (requestKey) this.store.set(requestKey, operationId)
      this.#recordProgress(value)
      return value
    })
    return receipt(row)
  }

  #ownedOperation({ ownerId, operationId }) {
    const row = this.#read(operationId)
    return row?.ownerId === ownerId ? row : undefined
  }

  #requireOperation(address) {
    const row = this.#ownedOperation(address)
    if (!row) throw new OwnerSwitchError('owner-switch-not-found', 'The switch operation does not belong to the selected owner.')
    return row
  }

  /** Cancel an operation while it is still waiting for the original session to become idle. */
  cancel(address) {
    return this.#transaction(() => {
      const row = this.#requireOperation(address)
      if (row.status === 'cancelled') return receipt(row)
      if (row.status !== 'waiting') throw new OwnerSwitchError('owner-switch-not-waiting', 'Only a waiting switch can be cancelled.')
      return receipt(this.#transition(row, { status: 'cancelled' }))
    })
  }

  /** Requeue archival of the original session after a committed switch. */
  retryArchive(address) {
    return this.#transaction(() => {
      const row = this.#requireOperation(address)
      if (row.status === 'committed' || row.status === 'completed') return receipt(row)
      if (row.status !== 'archive-failed') {
        throw new OwnerSwitchError('owner-switch-not-retryable', 'Archival can only be retried after the new owner has taken over.')
      }
      return receipt(this.#transition(row, { status: 'committed', reason: null, errorCode: null }))
    })
  }

  get(address) {
    const row = this.#ownedOperation(address)
    return row && receipt(row)
  }

  list({ ownerId } = {}) {
    return this.#rows(ownerId).map(receipt)
  }

  /** Deferred owner replies can pass while waiting. Preparing holds them as well as regular prompts. */
  phaseFor(ownerId) {
    return this.#hold(ownerId)?.status
  }

  isHeld(ownerId) {
    return HELD.has(this.phaseFor(ownerId))
  }

  async #oldStatus(row) {
    if (!this.#same(row)) return undefined
    this.#requireOldBinding(row)
    const status = await this.sessions.status({ sessionId: row.oldSessionId })
    if (!this.#same(row)) return undefined
    this.#requireOldBinding(row)
    if (status !== 'idle' && status !== 'busy') {
      throw new OwnerSwitchError('old-session-unavailable', 'The old owner session is unavailable. Its idle state could not be confirmed.')
    }
    return status
  }

  async #prepare(row) {
    let phase = 'status'
    try {
      if (row.status === 'waiting') {
        const preparing = await this.withAdmission(row.ownerId, async () => {
          const status = await this.#oldStatus(row)
          if (status === 'idle') return this.#transition(row, { status: 'preparing' })
          if (status !== 'busy' || row.mode !== 'stop' || row.stopRequestedAt) return undefined

          // Cancel has no host request ID. Record the dispatch claim before issuing the stop so a reload
          // never stops a later turn under the original authorization. A subsequent tick must still see idle.
          const stopping = this.#transition(row, { stopRequestedAt: this.now() })
          if (!stopping) return undefined
          row = stopping
          phase = 'stop'
          const accepted = await this.sessions.cancel({ sessionId: row.oldSessionId })
          if (accepted?.accepted !== true) throw new Error('The host did not accept the stop request.')
          return undefined
        })
        if (!preparing) return
        row = preparing
      }
      if (!this.#same(row)) return
      if (!row.initializedAt && !row.initializationText) {
        phase = 'facts'
        this.#requireOldBinding(row)
        const facts = await this.buildFacts({ ownerId: row.ownerId })
        if (typeof facts !== 'string' || !facts.trim()) throw new Error('The owner facts are unavailable.')
        const prepared = this.#transition(row, { initializationText: INITIALIZATION + '\n\n' + facts })
        if (!prepared) return
        row = prepared
      }
      if (!row.newSessionCreatedAt) {
        phase = 'create'
        if (!row.creationStartedAt) {
          const status = await this.sessions.status({ sessionId: row.newSessionId })
          if (!this.#same(row)) return
          if (status !== 'missing') {
            throw new OwnerSwitchError('owner-switch-id-conflict', 'The proposed owner session ID is already in use.')
          }
          // Persist the claim before host creation so a reload can safely use the same identity.
          const started = this.#transition(row, { creationStartedAt: this.now() })
          if (!started) return
          row = started
        }
        const owner = this.#requireOldBinding(row)
        this.#requireFreshSession(row.newSessionId)
        const created = await this.sessions.create({ owner, sessionId: row.newSessionId })
        if (created?.sessionId !== row.newSessionId || created.agentPreset !== OWNER_PRESETS[owner.role]) {
          throw new Error('The host did not create the proposed session with the owner preset.')
        }
        const prepared = this.#transition(row, { newSessionCreatedAt: this.now() })
        if (!prepared) return
        row = prepared
      }
      if (!row.initializedAt) {
        phase = 'prompt'
        this.#requireOldBinding(row)
        this.#requireFreshSession(row.newSessionId)
        const accepted = await this.sessions.prompt({
          sessionId: row.newSessionId, requestId: row.initializationRequestId, text: row.initializationText,
        })
        if (accepted?.accepted !== true) throw new Error('The host did not accept the owner facts.')
        const initialized = this.#transition(row, { initializedAt: this.now(), initializationText: undefined })
        if (!initialized) return
        row = initialized
      }
      phase = 'commit'
      await this.withAdmission(row.ownerId, async () => {
        const oldStatus = await this.#oldStatus(row)
        if (oldStatus === undefined) return
        this.#requireFreshSession(row.newSessionId)
        // Sample the replacement last so its readiness is checked immediately before binding.
        const replacementStatus = await this.sessions.status({ sessionId: row.newSessionId })
        if (!this.#same(row)) return
        if (replacementStatus !== 'idle' && replacementStatus !== 'busy') {
          throw new OwnerSwitchError('new-session-unavailable', 'The initialized owner session is unavailable.')
        }
        if (this.sessions.isArchived?.(row.newSessionId)) {
          throw new OwnerSwitchError('new-session-archived', 'The initialized owner session is archived.')
        }
        if (oldStatus !== 'idle' || replacementStatus !== 'idle') return
        this.#transition(row, { status: 'committed', committedAt: this.now() }, () => {
          this.#requireOldBinding(row)
          this.#requireFreshSession(row.newSessionId)
          this.registry.bindSession(row.ownerId, row.newSessionId)
        })
      })
    } catch (error) {
      if (error instanceof ProgressWriteError) throw error
      this.#fail(row, 'failed', 'owner-switch-preparation-failed', PREPARATION_FAILURE[phase], error)
    }
  }

  #fail(row, status, fallbackCode, fallbackReason, error) {
    // Host failures can include provider configuration. Persist only the phase or a local rule violation.
    const known = error instanceof OwnerSwitchError
    this.#transition(row, { status, reason: known ? error.message : fallbackReason, initializationText: undefined,
      errorCode: known ? error.code : fallbackCode,
    })
  }

  async #archive(row) {
    if (!this.#same(row)) return
    try {
      if (this.registry.findByCurrentSession(row.oldSessionId)) {
        throw new OwnerSwitchError('owner-switch-archive-target-current', 'The original session is currently bound and cannot be archived.')
      }
      await this.sessions.archive({ sessionId: row.oldSessionId })
    } catch (error) {
      this.#fail(row, 'archive-failed', 'owner-switch-archive-failed', '无法归档原负责人会话。', error)
      return
    }
    this.#transition(row, { status: 'completed', archivedAt: this.now() })
  }

  /** Deliver persisted work once per operation per tick. A committed binding releases delivery before archival. */
  async tick() {
    if (this.store.closed) return
    const due = this.#rows().filter(row => PENDING.has(row.status) && !this.#inFlight.has(row.operationId))
    await Promise.all(due.map(async row => {
      this.#inFlight.add(row.operationId)
      try {
        if (row.status === 'committed') await this.#archive(row)
        else await this.#prepare(row)
      } finally {
        this.#inFlight.delete(row.operationId)
      }
    }))
  }
}
