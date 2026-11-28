import { randomUUID } from 'node:crypto'

const DRAFTS = 'handoff-summary:draft:'
const DRAFTS_END = 'handoff-summary:draft;'
const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000
const TRANSCRIPT_MAX_BYTES = 32 * 1024
const SUMMARY_MAX_BYTES = 8 * 1024
const OWNER_ROLES = new Set(['chief', 'owner'])

export class HandoffSummaryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'HandoffSummaryError'
    this.code = code
  }
}

function identifier(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function boundedText(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes && value.trim() !== ''
}

function publicDraft({ sourceBindingVersion, ...draft }) {
  return draft
}

/**
 * Durable discussion context for an exact live L1/L2 binding. Callers authorize the user first.
 * readTranscript returns bounded text with source { sessionId, throughSeq, hasMore }.
 * summarize receives those excerpts and returns text within maxBytes. Neither port runs inside a write transaction.
 */
export class HandoffSummaryRegistry {
  constructor({ store, registry, readTranscript, summarize, now, ids }) {
    this.store = store
    this.registry = registry
    this.readTranscript = readTranscript
    this.summarize = summarize
    this.now = now ?? (() => new Date().toISOString())
    this.ids = ids ?? { uuid: randomUUID }
  }

  #requireOpen() {
    if (this.store.closed) {
      throw new HandoffSummaryError('handoff-summary-unavailable', 'Handoff summaries are temporarily unavailable.')
    }
  }

  #write(work) {
    this.#requireOpen()
    const db = this.store.db
    // Work performs one write after its checks and can participate in an intake transaction.
    if (db.isTransaction) return work()
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      db.exec('COMMIT')
      return value
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  #requireBinding({ ownerId, expectedSessionId }, expectedVersion) {
    this.#requireOpen()
    if (!identifier(ownerId) || !identifier(expectedSessionId)) {
      throw new HandoffSummaryError('invalid-handoff-summary', 'Specify the owner and its current session.')
    }
    const owner = this.registry.findByCurrentSession(expectedSessionId)
    // Include displaced sessions because different bindings can share a timestamp.
    const version = JSON.stringify([owner?.updatedAt, owner?.previousSessionIds ?? []])
    if (owner?.id !== ownerId || !OWNER_ROLES.has(owner.role) || (expectedVersion !== undefined && version !== expectedVersion)) {
      throw new HandoffSummaryError('stale-owner-binding', 'The selected session is no longer the current owner binding.')
    }
    return version
  }

  #requireFresh(expiresAt, at) {
    if (Date.parse(expiresAt) <= Date.parse(at)) {
      throw new HandoffSummaryError('handoff-summary-expired', 'This handoff summary draft has expired.')
    }
  }

  async #fromHost(work) {
    try {
      return await work()
    } catch {
      throw new HandoffSummaryError('handoff-summary-generation-failed', 'Could not generate a handoff summary from the selected session.')
    }
  }

  async generate({ ownerId, expectedSessionId } = {}) {
    const address = { ownerId, expectedSessionId }
    const sourceBindingVersion = this.#requireBinding(address)
    if (typeof this.readTranscript !== 'function' || typeof this.summarize !== 'function') {
      throw new HandoffSummaryError('handoff-summary-unavailable', 'Handoff summary generation is unavailable.')
    }
    const expiresAt = new Date(Date.parse(this.now()) + DRAFT_LIFETIME_MS).toISOString()
    const input = await this.#fromHost(() => this.readTranscript({ ownerId, sessionId: expectedSessionId, maxBytes: TRANSCRIPT_MAX_BYTES }))
    this.#requireBinding(address, sourceBindingVersion)
    const sourceReadAt = this.now()
    this.#requireFresh(expiresAt, sourceReadAt)
    const { text: transcript, source } = input ?? {}
    if (source?.sessionId !== expectedSessionId || typeof source.hasMore !== 'boolean'
      || (source.throughSeq !== null && (!Number.isSafeInteger(source.throughSeq) || source.throughSeq < 0))
      || !boundedText(transcript, TRANSCRIPT_MAX_BYTES)) {
      throw new HandoffSummaryError('handoff-summary-generation-failed', 'The selected session did not provide usable transcript excerpts.')
    }
    const provenance = { sourceSessionId: expectedSessionId, sourceReadAt, sourceThroughSeq: source.throughSeq, sourceHasMore: source.hasMore }
    const text = await this.#fromHost(() => this.summarize({
      ownerId, sessionId: expectedSessionId, transcript, maxBytes: SUMMARY_MAX_BYTES,
      source: { sessionId: expectedSessionId, throughSeq: provenance.sourceThroughSeq, hasMore: provenance.sourceHasMore },
    }))
    return this.#write(() => {
      this.#requireBinding(address, sourceBindingVersion)
      const at = this.now()
      this.#requireFresh(expiresAt, at)
      if (!boundedText(text, SUMMARY_MAX_BYTES)) {
        throw new HandoffSummaryError('handoff-summary-generation-failed', 'The generated handoff summary is empty or exceeds the size limit.')
      }
      const draftId = 'summary-' + this.ids.uuid()
      const key = DRAFTS + draftId
      if (this.store.get(key)) {
        throw new HandoffSummaryError('handoff-summary-id-conflict', 'A handoff summary with this ID already exists.')
      }
      const draft = {
        draftId, ownerId, ...provenance, sourceBindingVersion, text,
        status: 'draft', revision: 1, createdAt: at, updatedAt: at, expiresAt,
      }
      this.store.set(key, draft)
      return publicDraft(draft)
    })
  }

  #read(address) {
    const sourceBindingVersion = this.#requireBinding(address)
    if (!identifier(address.draftId)) {
      throw new HandoffSummaryError('invalid-handoff-summary', 'Specify the handoff summary draft.')
    }
    const draft = this.store.get(DRAFTS + address.draftId)
    if (draft?.ownerId !== address.ownerId || draft.sourceSessionId !== address.expectedSessionId) {
      throw new HandoffSummaryError('handoff-summary-not-found', 'This handoff summary draft does not belong to the selected owner and session.')
    }
    if (draft.sourceBindingVersion !== sourceBindingVersion) {
      throw new HandoffSummaryError('stale-owner-binding', 'The selected session is no longer the current owner binding.')
    }
    this.#requireFresh(draft.expiresAt, this.now())
    return draft
  }

  #requireUndiscarded(draft) {
    if (draft.status === 'discarded') {
      throw new HandoffSummaryError('handoff-summary-discarded', 'This handoff summary draft was discarded.')
    }
  }

  #requireRevision(draft, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HandoffSummaryError('invalid-handoff-summary', 'Specify the handoff summary revision.')
    }
    if (draft.revision !== revision) {
      throw new HandoffSummaryError('handoff-summary-revision-conflict', 'This handoff summary draft has changed. Reopen it before continuing.')
    }
  }

  #update(address, changes) {
    return this.#write(() => {
      const draft = this.#read(address)
      this.#requireRevision(draft, address.revision)
      const patch = changes(draft)
      if (!patch) return publicDraft(draft)
      const next = { ...draft, ...patch, revision: draft.revision + 1, updatedAt: this.now() }
      this.store.set(DRAFTS + draft.draftId, next)
      return publicDraft(next)
    })
  }

  get(address = {}) {
    return publicDraft(this.#read(address))
  }

  list({ ownerId, expectedSessionId } = {}) {
    const version = this.#requireBinding({ ownerId, expectedSessionId })
    const at = new Date(this.now()).toISOString()
    return this.store.db.prepare(`
      SELECT json_remove(value, '$.text', '$.sourceBindingVersion') AS metadata FROM kv
      WHERE key >= ? AND key < ?
        AND json_extract(value, '$.ownerId') = ?
        AND json_extract(value, '$.sourceSessionId') = ?
        AND json_extract(value, '$.sourceBindingVersion') = ?
        AND json_extract(value, '$.status') IN ('draft', 'confirmed')
        AND json_extract(value, '$.expiresAt') > ?
      ORDER BY rowid DESC
    `).all(DRAFTS, DRAFTS_END, ownerId, expectedSessionId, version, at).map(({ metadata }) => JSON.parse(metadata))
  }

  edit({ text, ...address } = {}) {
    return this.#update(address, draft => {
      this.#requireUndiscarded(draft)
      if (!boundedText(text, SUMMARY_MAX_BYTES)) {
        throw new HandoffSummaryError('invalid-handoff-summary', 'Enter a non-empty handoff summary of at most 8 KiB.')
      }
      return { text, status: 'draft' }
    })
  }

  confirm(address = {}) {
    return this.#update(address, draft => {
      this.#requireUndiscarded(draft)
      if (draft.status === 'confirmed') return undefined
      return { status: 'confirmed' }
    })
  }

  discard(address = {}) {
    return this.#update(address, draft => {
      if (draft.status === 'discarded') return undefined
      return { status: 'discarded', text: null }
    })
  }

  /** Called synchronously inside the transaction that accepts a switch. */
  confirmedSnapshot(address = {}) {
    const draft = this.#read(address)
    this.#requireRevision(draft, address.revision)
    this.#requireUndiscarded(draft)
    if (draft.status !== 'confirmed') {
      throw new HandoffSummaryError('handoff-summary-not-confirmed', 'Confirm this handoff summary revision before starting the switch.')
    }
    const { draftId, revision, text, sourceSessionId, sourceReadAt, sourceThroughSeq, sourceHasMore } = draft
    return { draftId, revision, text, sourceSessionId, sourceReadAt, sourceThroughSeq, sourceHasMore }
  }
}
