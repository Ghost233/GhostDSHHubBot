/**
 * S11 延迟确认登记 (issue #42): the deferred confirm / action / ask registry.
 *
 * The registry gathers structured decisions for ticket actions and questions. SQLite transactions keep the
 * registry document and its ticket face in sync. A handler starts only after its approval commits. An
 * approval without a recorded result remains uncertain and cannot dispatch again.
 *
 * The requester identifies the actor allowed to decide. The action target stays fixed, while an owner
 * receiver uses the current owner binding. A worker receiver stays bound to the original session.
 * TaskBoard owns the ticket lifecycle. Registered handlers fulfill approved actions.
 */
import { randomUUID } from 'node:crypto'

/** Registry status vocabulary. `answered` covers both approve and reject; the decision rides in `outcome`. */
export const DEFERRED_STATUSES = ['pending', 'answered', 'cancelled', 'expired']

/** The ONLY decision vocabulary — anything else (including prose like "确认") is rejected, never interpreted. */
export const DEFERRED_DECISIONS = ['approve', 'reject', 'answer', 'cancel']

/** What a request waits for: a confirmation of a stored action, or a free-text answer. */
export const DEFERRED_TYPES = ['confirm', 'answer']

/** Default fixed lifetime (spec「错误场景」+ #69: 24h). Per-action overrides arrive through `ttlByAction`. */
export const DEFERRED_TTL_MS = 24 * 60 * 60 * 1000

/** Action types whose fulfillment needs a real execution destination — resolve fails closed without one. */
export const DEFERRED_REQUIRES_TARGET = ['fork', 'dangerous-inject']

/** Facts that must never change after the first attach （票面权威）. Mirrors TaskBoard's immutable set. */
export const DEFERRED_IMMUTABLE_FACTS = [
  'requestId', 'type', 'action', 'ticketId', 'ownerId', 'requester', 'target', 'receiver', 'source', 'expiresAt', 'openedAt',
]

/** Bounded refusal ledger: a request remembers why decisions were refused, without growing without bound. */
export const DEFERRED_REFUSAL_LIMIT = 20

/** The kv namespace for registry documents (the `kv` table already ships in schema 2 — no migration needed). */
const KEY_PREFIX = 'deferred/req/'
const UNCERTAIN_REASON = 'The approval was recorded. Its execution outcome is unknown and the action will not be repeated.'

/** The canonical JSON reading of one fact, so immutability compares values rather than object identity. */
function sameFact(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Whether approval requires a fixed action destination. */
export function actionNeedsTarget(action) {
  return DEFERRED_REQUIRES_TARGET.includes(action?.type)
}

function targetsOwner(action) {
  return action.type === 'dangerous-inject' && ['route', 'follow-up'].includes(action.entry)
}

/** A deferred-registry failure with a machine-readable code (mirrors TaskError's contract for tool surfaces). */
export class DeferredError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DeferredError'
    this.code = code
  }
}

/**
 * The deferred confirm/action/ask registry.
 *
 * @param {object} deps
 * @param {import('./store.js').Store} deps.store - the hub-bot store (kv documents, no schema change).
 * @param {import('./tasks.js').TaskBoard} deps.tasks - the ONE lifecycle; every stage change goes through it.
 * @param {() => string} [deps.now] - injectable clock (tests use a fixed instant).
 * @param {number} [deps.ttlMs] - default fixed lifetime, 24h.
 * @param {Record<string, number>} [deps.ttlByAction] - per-action-type (or per-request-type) lifetime override.
 * @param {Record<string, Function>} [deps.handlers] - action.type → async executor, wired by the Router.
 * @param {{ currentBinding?: (ownerId: string) => ({ sessionId?: string }|undefined), isOwnerSession?: (sessionId: string) => boolean }} [deps.owners]
 *        live owner bindings (src/registry.js). Optional: without it only the stored receiver is compared.
 */
export class DeferredRegistry {
  /** Fallback id index for stores without a raw db handle (the real Store always has one). */
  #index = new Set()

  constructor({ store, tasks, now, ttlMs = DEFERRED_TTL_MS, ttlByAction, handlers, owners } = {}) {
    if (!store) throw new DeferredError('store-required', 'deferred: a store is required')
    if (!tasks) throw new DeferredError('tasks-required', 'deferred: a TaskBoard is required')
    this.store = store
    this.tasks = tasks
    this.now = now ?? (() => new Date().toISOString())
    this.ttlMs = ttlMs
    this.ttlByAction = { ...(ttlByAction ?? {}) }
    this.handlers = Object.assign(Object.create(null), handlers)
    this.owners = owners ?? null
  }

  /** Registers (or replaces) the executor for one action type. */
  setHandler(actionType, handler) {
    if (typeof handler !== 'function') throw new DeferredError('handler-invalid', 'deferred: handler must be a function')
    this.handlers[actionType] = handler
    return this
  }

  /**
   * Opens a deferred request: validates the caller-supplied facts, fixes `expiresAt` ONCE, persists the document and
   * mirrors the immutable facts onto the ticket face.
   *
   * Idempotent by `requestId` (重复登记不产生第二份请求): re-requesting the same facts returns the stored document
   * untouched; re-requesting different facts is refused — the stored action target is never rewritten.
   *
   * @param {object} input
   * @param {{ type: string } & Record<string, any>} input.action - the stored intent, passed to the ticket verbatim.
   * @param {string} input.ticketId
   * @param {string} input.ownerId
   * @param {{ actor: string, source?: any }} input.requester - the authority opening the request.
   * @param {{ kind: string } & Record<string, any>} input.source - where the request came from (github/timer/dsh/...).
   * @param {{ sessionId?: string, ownerId?: string }} [input.target] - fixed action destination.
   * @param {{ kind?: 'owner'|'worker', ownerId?: string, sessionId?: string }} [input.receiver] - destination for the answer.
   * @param {string} [input.type] - 'confirm' (default) or 'answer'.
   * @param {string} [input.requestId] - caller-chosen id (defaults to a generated one).
   * @param {string} [input.expiresAt] - explicit fixed expiry (defaults to now + ttl).
   * @param {any} [input.payload] - opaque data the handler needs; stored, never interpreted.
   * @param {string} [input.question] - convenience: render the question on the ticket face when the stage allows it.
   * @returns {object} the persisted request document.
   */
  request({ action, requestId, ticketId, ownerId, requester, target, receiver, source, payload, expiresAt, type, question } = {}) {
    const at = this.now()
    if (typeof ticketId !== 'string' || !ticketId.trim()) {
      throw new DeferredError('ticket-required', 'deferred: ticketId must be a non-empty string')
    }
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new DeferredError('owner-required', 'deferred: ownerId must be a non-empty string')
    }
    if (typeof action !== 'object' || action === null || Array.isArray(action) || typeof action.type !== 'string' || !action.type.trim()) {
      throw new DeferredError('action-invalid', 'deferred: action must be an object with a non-empty string type')
    }
    const kind = type ?? 'confirm'
    if (!DEFERRED_TYPES.includes(kind)) {
      throw new DeferredError('type-invalid', 'deferred: type must be one of ' + DEFERRED_TYPES.join('/'))
    }
    if (typeof requester !== 'object' || requester === null || typeof requester.actor !== 'string' || !requester.actor.trim()) {
      throw new DeferredError('requester-required', 'deferred: requester must be an object carrying the opening actor')
    }
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new DeferredError('source-required', 'deferred: source must be an object')
    }
    if (target !== undefined && target !== null && (typeof target !== 'object' || Array.isArray(target))) {
      throw new DeferredError('target-invalid', 'deferred: target must be an object or null')
    }
    if (actionNeedsTarget(action) && (typeof target !== 'object' || target === null)) {
      throw new DeferredError('target-missing', 'deferred: action ' + action.type + ' needs a stored destination (target)')
    }
    if (receiver !== undefined && (typeof receiver !== 'object' || receiver === null || Array.isArray(receiver))) {
      throw new DeferredError('receiver-invalid', 'deferred: receiver must be an object')
    }
    const id = requestId ?? 'dfr-' + randomUUID()
    if (typeof id !== 'string' || !id.trim()) throw new DeferredError('request-invalid', 'deferred: requestId must be a non-empty string')

    // Deterministic normalization: the same caller inputs always produce the same facts, so an identical re-request
    // compares clean while any changed fact is refused below.
    const facts = {
      requestId: id,
      type: kind,
      action,
      ticketId,
      ownerId,
      requester: { actor: requester.actor, source: requester.source ?? source },
      target: target ?? null,
      receiver: receiver ?? { ownerId },
      source,
    }

    const requested = this.#write(() => {
      const existing = this.#load(id)
      if (existing !== undefined) {
        // 重复登记: identical facts are an idempotent no-op; a changed fact is refused and remembered.
        const drift = DEFERRED_IMMUTABLE_FACTS.filter(field => field !== 'expiresAt' && field !== 'openedAt' && !sameFact(existing[field], facts[field]))
        if (drift.length > 0) {
          this.#refuse(existing, 'immutable-drift', { fields: drift }, at)
          return new DeferredError('request-immutable', 'deferred: request ' + id + ' facts are immutable — refused to change ' + drift.join(', '))
        }
        if (expiresAt !== undefined && !sameFact(existing.expiresAt, expiresAt)) {
          this.#refuse(existing, 'immutable-drift', { fields: ['expiresAt'] }, at)
          return new DeferredError('request-immutable', 'deferred: request ' + id + ' expiry is fixed at ' + existing.expiresAt + ' — it can never be extended')
        }
        return existing
      }

      const expires = expiresAt ?? new Date(Date.parse(at) + this.#ttlFor(action.type, kind)).toISOString()
      if (typeof expires !== 'string' || !Number.isFinite(Date.parse(expires))) {
        throw new DeferredError('expires-at-invalid', 'deferred: expiresAt must be an ISO instant')
      }
      if (Date.parse(expires) <= Date.parse(at)) {
        throw new DeferredError('expires-at-invalid', 'deferred: expiresAt must be after the request instant — expiry is fixed, never extended')
      }

      const doc = {
        ...facts,
        payload: payload ?? null,
        createdAt: at,
        openedAt: at,
        expiresAt: expires,
        status: 'pending',
        refusals: [],
        outcome: null,
        decidedAt: null,
        executedAt: null,
      }
      const ticket = this.tasks.getTicket(ticketId)
      const previous = this.#load(ticket?.deferred?.requestId)
      if (previous?.status === 'pending' && !this.#waitingTicket(previous)) this.#retireStale(previous, at)
      this.#attach(doc)
      this.#save(doc)
      this.#askQuestion(doc, question)
      const waiting = this.tasks.getTicket(ticketId)
      const waitRevision = waiting.stage === this.#waitStage(doc) ? (waiting.transitions?.length ?? 0) : null
      this.tasks.noteDeferred(ticketId, { waitRevision })
      return this.#load(id)
    })
    if (requested instanceof DeferredError) throw requested
    return requested
  }

  /** One request document by id, or undefined. */
  get(requestId) {
    return this.#load(requestId)
  }

  /** Registers a synchronous callback that persists delivery intents in the closing transaction. */
  setCloseHandler(handler) {
    this.closeHandler = handler
  }

  /** The ticket still waiting on a durably accepted approval. */
  acceptedTicket(requestId) {
    const request = this.#load(requestId)
    if (request?.status === 'answered' && request.outcome?.kind === 'fulfillment-uncertain') {
      return this.#waitingTicket(request)
    }
    return undefined
  }

  /** Requests matching the given filters, oldest first. */
  list({ ownerId, ticketId, status } = {}) {
    return this.#scan()
      .filter(doc => (ownerId === undefined || doc.ownerId === ownerId)
        && (ticketId === undefined || doc.ticketId === ticketId)
        && (status === undefined || doc.status === status))
      .sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || String(a.requestId).localeCompare(String(b.requestId)))
  }

  /** The still-pending requests on one ticket face. */
  pendingFor({ ticketId } = {}) {
    return this.list({ ticketId, status: 'pending' })
  }

  /**
   * Applies one structured decision. A registered handler runs only after its approval commits.
   * `hasTimelyReceipt` is trusted evidence from the caller's persisted receipt scan.
   */
  async resolve({ requestId, decision, actor, text, receivedAt, workerUnavailable, hasTimelyReceipt } = {}) {
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw new DeferredError('request-required', 'deferred: requestId must be a non-empty string')
    }
    if (!DEFERRED_DECISIONS.includes(decision)) {
      throw new DeferredError('decision-invalid', 'deferred: decision must be one of ' + DEFERRED_DECISIONS.join('/'))
    }
    const at = this.now()
    const answerText = typeof text === 'string' ? text.trim() : ''
    const canDispatch = !this.store.db?.isTransaction
    const prepared = this.#write(() => this.#prepareDecision({
      requestId, decision, actor, answerText, receivedAt, at, canDispatch, workerUnavailable, hasTimelyReceipt,
    }))
    if (prepared instanceof DeferredError) throw prepared
    if (!prepared.handler) return prepared

    const { handler, request, who, decisionFacts } = prepared
    let result
    try {
      result = await handler({ request, actor: who, decision, text: answerText || null })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (this.store.closed) throw new DeferredError('deferred-stopped', 'Hub Bot stopped before the approval result was recorded.')
      this.#write(() => {
        const current = this.#load(requestId)
        if (this.#waitingTicket(current)) this.tasks.fail({ ticketId: current.ticketId, reason: reason || '确认动作未能完成' })
        this.#close(current, 'answered', { ...current.outcome, kind: 'fulfillment-failed', reason }, this.now())
      })
      throw new DeferredError('fulfillment-failed', reason, { cause: error })
    }
    if (this.store.closed) throw new DeferredError('deferred-stopped', 'Hub Bot stopped before the approval result was recorded.')
    return this.#write(() => this.#finishApproval(this.#load(requestId), decisionFacts, result, true))
  }

  #prepareDecision({ requestId, decision, actor, answerText, receivedAt, at, canDispatch, workerUnavailable, hasTimelyReceipt }) {
    const doc = this.#load(requestId)
    if (!doc) return new DeferredError('request-unknown', 'deferred: unknown request ' + requestId)
    let who
    try {
      who = this.#authority(doc, actor, at)
    } catch (error) {
      if (error instanceof DeferredError) return error
      throw error
    }

    if (doc.status === 'expired') {
      return new DeferredError('request-expired', 'deferred: request ' + requestId + ' expired at ' + doc.expiresAt)
    }
    if (doc.status !== 'pending') {
      if (doc.status === 'answered' && doc.outcome?.decision === decision && doc.outcome.by === who.actor
        && (decision !== 'answer' || doc.outcome.text === answerText)) {
        if (['fulfillment-uncertain', 'fulfillment-failed'].includes(doc.outcome.kind)) {
          return new DeferredError(doc.outcome.kind, doc.outcome.reason)
        }
        return this.#result(doc, decision, { duplicate: true, executed: false, text: null })
      }
      return new DeferredError('request-closed', 'deferred: request ' + requestId + ' is already ' + doc.status)
    }

    // Older registry rows could keep a request pending after dispatch threw.
    const previousFailure = doc.refusals?.findLast(refusal => refusal.kind === 'fulfillment-failed')
    if (previousFailure) {
      if (this.#waitingTicket(doc)) this.tasks.fail({ ticketId: doc.ticketId, reason: UNCERTAIN_REASON })
      this.#close(doc, 'answered', {
        decision: 'approve', by: doc.requester.actor, at: previousFailure.at ?? at,
        kind: 'fulfillment-uncertain', reason: UNCERTAIN_REASON,
      }, at)
      return new DeferredError('fulfillment-uncertain', UNCERTAIN_REASON)
    }

    const receipt = receivedAt === undefined ? {} : { receivedAt }
    const cutoff = receivedAt === undefined ? Date.parse(at) : typeof receivedAt === 'string' ? Date.parse(receivedAt) : NaN
    if (receivedAt !== undefined && (!Number.isFinite(cutoff)
      || cutoff < Date.parse(doc.openedAt) || cutoff > Date.parse(at))) {
      return new DeferredError('receipt-invalid', 'deferred: the receipt time must be between opening and processing')
    }
    if (cutoff >= Date.parse(doc.expiresAt)) {
      // A late decision cannot expire a request with an earlier authenticated receipt awaiting delivery.
      if (hasTimelyReceipt !== true) this.#expireIfDue(doc, decision, at, cutoff)
      return new DeferredError('request-expired', 'deferred: request ' + requestId + ' expired at ' + doc.expiresAt)
    }

    if (decision !== 'cancel' && (decision === 'answer') !== (doc.type === 'answer')) {
      return new DeferredError('decision-invalid', 'deferred: request ' + requestId + ' expects ' + doc.type)
    }
    if (decision === 'answer' && !answerText) {
      return new DeferredError('text-required', 'deferred: an answer decision requires the answer text')
    }
    const ticket = this.#waitingTicket(doc)
    if (!ticket) return this.#retireStale(doc, at)

    const decisionFacts = { decision, by: who.actor, at, ...receipt }
    if (decision === 'cancel') {
      const reason = answerText || null
      if (doc.type === 'answer') this.tasks.resume(doc.ticketId, { by: 'user' })
      else this.tasks.cancel(doc.ticketId, { by: 'user', reason: reason ?? undefined, kind: 'cancelled' })
      const closed = this.#close(doc, 'cancelled', { ...decisionFacts, reason, ticketDriven: true }, at)
      return this.#result(closed, decision, { duplicate: false, executed: true, text: null })
    }
    if (decision === 'reject') {
      const reason = answerText || '用户拒绝该动作'
      this.tasks.rejectConfirm({ ticketId: doc.ticketId, reason, by: 'user' })
      const closed = this.#close(doc, 'answered', { ...decisionFacts, reason, ticketDriven: true, executed: false }, at)
      return this.#result(closed, decision, { duplicate: false, executed: false, text: null })
    }
    if (decision === 'answer') {
      if (doc.receiver?.kind === 'worker') {
        const sessionId = doc.receiver.sessionId
        if (workerUnavailable === true || typeof sessionId !== 'string' || !sessionId.trim()
          || ticket.workerSession?.sessionId !== sessionId || this.#isOwnerSession(sessionId)) {
          const reason = 'The original execution session is no longer an eligible receiver.'
          this.tasks.escalate({ ticketId: doc.ticketId, reason, by: 'system' })
          this.#close(doc, 'cancelled', { ...decisionFacts, refused: 'receiver-stale', reason }, at)
          return new DeferredError('receiver-stale', reason)
        }
      }
      this.tasks.resume(doc.ticketId, { by: 'route' })
      const closed = this.#close(doc, 'answered', {
        ...decisionFacts, text: answerText, ticketDriven: true, executed: false, delivery: { state: 'queued' },
      }, at)
      return this.#result(closed, decision, { duplicate: false, executed: true, text: answerText })
    }

    const targetError = this.#checkTarget(doc)
    if (targetError) {
      this.tasks.cancel(doc.ticketId, { by: 'system', reason: targetError.message, kind: targetError.code })
      this.#close(doc, 'cancelled', { ...decisionFacts, refused: targetError.code, reason: targetError.message }, at)
      return targetError
    }
    const handler = this.handlers[doc.action.type]
    if (typeof handler !== 'function') return this.#finishApproval(doc, decisionFacts, null, false)
    if (!canDispatch) return new DeferredError('deferred-transaction-active', 'deferred: approval must commit before dispatch')

    const outcome = {
      ...decisionFacts, action: doc.action.type, kind: 'fulfillment-uncertain',
      reason: UNCERTAIN_REASON,
    }
    this.tasks.noteDeferred(doc.ticketId, { status: 'accepted', decidedAt: at, outcome })
    const request = this.#save({ ...doc, ...receipt, status: 'answered', decidedAt: at, outcome })
    return { handler, request, who, decisionFacts }
  }

  /**
   * Records that the caller finished executing an approved action it ran itself (no handler was registered).
   * Idempotent: a second call reports `{ duplicate: true }` and never re-runs anything — an accepted action is
   * executed at most once （重复投递不重复执行）.
   */
  markExecuted(requestId, { result } = {}) {
    return this.#write(() => {
      const doc = this.#load(requestId)
      if (!doc) throw new DeferredError('request-unknown', 'deferred: unknown request ' + requestId)
      if (doc.status === 'pending') throw new DeferredError('request-pending', 'deferred: request ' + requestId + ' has no accepted decision')
      if (doc.status !== 'answered' || doc.outcome?.decision !== 'approve' || typeof doc.outcome.executed !== 'boolean') {
        throw new DeferredError('request-not-executable', 'deferred: request ' + requestId + ' has no completed approval')
      }
      if (doc.outcome.executed) return { request: doc, duplicate: true }
      const executedAt = this.now()
      const outcome = { ...doc.outcome, executed: true, execution: result ?? null }
      this.tasks.recordDeferredExecution(doc.ticketId, { requestId, executedAt, result })
      const next = this.#save({ ...doc, executedAt, outcome })
      return { request: next, duplicate: false }
    })
  }

  /** Persists the exact receiver before dispatch, so a crash cannot silently move an ambiguous prompt. */
  noteAnswerDeliveryAttempt(requestId, sessionId) {
    return this.#write(() => {
      const doc = this.#load(requestId)
      const previous = doc?.outcome?.delivery
      if (doc?.outcome?.decision !== 'answer' || (previous && previous.state !== 'queued')) return
      if ((previous?.attemptedSessionId ?? null) === sessionId) return
      const delivery = { state: 'queued' }
      if (sessionId !== null) delivery.attemptedSessionId = sessionId
      this.tasks.recordDeferredAnswerDelivery(doc.ticketId, { requestId, delivery })
      this.#save({ ...doc, outcome: { ...doc.outcome, delivery } })
    })
  }

  /** Records a terminal delivery receipt separately from the accepted answer. */
  recordAnswerDelivery(requestId, { state, reason, sessionId } = {}) {
    if (state !== 'sent' && state !== 'failed') {
      throw new DeferredError('delivery-state-invalid', 'deferred: delivery receipt state must be sent or failed')
    }
    return this.#write(() => {
      const doc = this.#load(requestId)
      if (!doc) throw new DeferredError('request-unknown', 'deferred: unknown request ' + requestId)
      if (doc.status !== 'answered' || doc.outcome?.decision !== 'answer') {
        throw new DeferredError('request-not-answer', 'deferred: delivery receipt requires an accepted answer')
      }
      const previous = doc.outcome.delivery
      if (previous && previous.state !== 'queued') return { request: doc, duplicate: true }
      let detail = typeof reason === 'string' ? reason.trim() : ''
      if (state === 'failed' && !detail) detail = 'The answer could not be delivered to its original receiver.'
      const receiver = sessionId ?? previous?.attemptedSessionId
      const delivery = { state, at: this.now(), ...(receiver && { sessionId: receiver }), ...(detail && { reason: detail }) }
      this.tasks.recordDeferredAnswerDelivery(doc.ticketId, { requestId, delivery })
      const request = this.#save({ ...doc, outcome: { ...doc.outcome, delivery } })
      return { request, duplicate: false }
    })
  }

  /**
   * Expires due pending requests except those identified by the caller's trusted receipt scan. A ticket still
   * waiting on an expired confirmation is cancelled. A ticket still waiting on an expired question is blocked.
   * @returns {object[]} the requests that just expired.
   */
  sweep({ skipRequestIds } = {}) {
    const at = this.now()
    const expired = []
    for (const doc of this.#scan()) {
      if (skipRequestIds?.has(doc.requestId) || doc.status !== 'pending' || Date.parse(doc.expiresAt) > Date.parse(at)) continue
      const closed = this.#write(() => {
        const current = this.#load(doc.requestId)
        return current && this.#expireIfDue(current, undefined, at)
      })
      if (closed) expired.push(closed)
    }
    return expired
  }

  /** The fixed lifetime for one action/request type: per-action table first, then the registry default. */
  #ttlFor(actionType, type) {
    const configured = this.ttlByAction[actionType] ?? this.ttlByAction[type]
    return Number.isFinite(configured) && configured > 0 ? configured : this.ttlMs
  }

  #write(write) {
    const db = this.store.db
    if (!db) return write()
    const nested = db.isTransaction
    db.exec(nested ? 'SAVEPOINT deferred_registry' : 'BEGIN IMMEDIATE')
    try {
      const result = write()
      db.exec(nested ? 'RELEASE deferred_registry' : 'COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) {
        if (nested) {
          db.exec('ROLLBACK TO deferred_registry')
          db.exec('RELEASE deferred_registry')
        } else {
          db.exec('ROLLBACK')
        }
      }
      throw error
    }
  }

  #finishApproval(doc, decisionFacts, result, executed) {
    // Some handlers have already moved the ticket. Only drive the original wait if it is still current.
    const ticketDriven = Boolean(this.#waitingTicket(doc))
    if (ticketDriven) this.tasks.confirm({ ticketId: doc.ticketId, result: result ?? { deferred: doc.requestId }, by: 'user' })
    const completedAt = this.now()
    const closed = this.#close({ ...doc, executedAt: executed ? completedAt : null }, 'answered', {
      ...decisionFacts, action: doc.action.type, executed, ticketDriven, result: result ?? null,
    }, completedAt)
    return this.#result(closed, 'approve', { duplicate: false, executed, text: null })
  }

  #key(requestId) {
    return KEY_PREFIX + requestId
  }

  #load(requestId) {
    if (typeof requestId !== 'string' || !requestId.trim()) return undefined
    const doc = this.store.get(this.#key(requestId))
    return doc === undefined || doc === null ? undefined : doc
  }

  #save(doc) {
    this.store.set(this.#key(doc.requestId), doc)
    this.#index.add(doc.requestId)
    return doc
  }

  /** Every registry document; list() imposes the order. */
  #scan() {
    const db = this.store.db
    if (db && typeof db.prepare === 'function') {
      const rows = db.prepare('SELECT value FROM kv WHERE key LIKE ?').all(KEY_PREFIX + '%')
      return rows
        .map(row => JSON.parse(String(row.value)))
        .filter(doc => doc && typeof doc.requestId === 'string')
    }
    return [...this.#index].map(id => this.store.get(this.#key(id))).filter(doc => doc !== undefined && doc !== null)
  }

  /** Mirrors the immutable facts onto the ticket face （票面权威） — the face and the document are written together. */
  #attach(doc) {
    const facts = {
      requestId: doc.requestId,
      type: doc.type,
      action: doc.action,
      source: doc.source,
      requester: doc.requester,
      target: doc.target,
      receiver: doc.receiver,
      expiresAt: doc.expiresAt,
      openedAt: doc.openedAt,
    }
    try {
      this.tasks.attachDeferred(doc.ticketId, facts)
    } catch (error) {
      throw this.#asDeferred(error)
    }
  }

  /**
   * Renders the question on the ticket face when the stage allows it. Best-effort by design: the request facts are
   * already durable, and a ticket that cannot take the question (e.g. it is mid-execution) is recorded instead of
   * losing the whole request.
   */
  #askQuestion(doc, question) {
    if (typeof question !== 'string' || !question.trim()) return
    const ticket = this.tasks.getTicket(doc.ticketId)
    if (!ticket) return
    try {
      if (doc.type === 'confirm') {
        if (ticket.stage === 'person/confirm') return // already asked — re-entry never asks twice
        this.tasks.askConfirm({ ticketId: doc.ticketId, question, action: doc.action })
      } else {
        if (ticket.stage === 'person/answer') return
        this.tasks.ask({ ticketId: doc.ticketId, question })
      }
    } catch (error) {
      if (error?.code !== 'illegal-transition') throw error
      this.#refuse(doc, 'question-not-asked', { stage: ticket.stage, error: error.message }, this.now())
    }
  }

  /** Records a refused decision on the request (durable, informative) and mirrors it onto the ticket face. */
  #refuse(doc, kind, extra, at) {
    const refusals = [...(doc.refusals ?? []), { kind, at, ...extra }].slice(-DEFERRED_REFUSAL_LIMIT)
    const face = this.tasks.getTicket(doc.ticketId)?.deferred
    if (face?.requestId === doc.requestId && ['pending', 'accepted'].includes(face.status)) {
      this.tasks.noteDeferred(doc.ticketId, { refusals })
    }
    this.#save({ ...doc, refusals })
  }

  /**
   * Authority check against the recorded requester and the live owner binding. A mismatch is refused with a durable
   * entry and the request STAYS pending (a forged attempt must never be able to kill a legitimate request).
   */
  #authority(doc, actor, at) {
    if (typeof actor !== 'object' || actor === null || Array.isArray(actor) || typeof actor.actor !== 'string' || !actor.actor.trim()) {
      throw new DeferredError('actor-required', 'deferred: resolve needs an authenticated caller descriptor { actor, ownerId?, sessionId? }')
    }
    if (actor.actor !== doc.requester.actor) {
      this.#refuse(doc, 'actor-mismatch', { actor: actor.actor, expected: doc.requester.actor }, at)
      throw new DeferredError('actor-mismatch', 'deferred: request ' + doc.requestId + ' was opened by ' + doc.requester.actor + ', not ' + actor.actor + ' — refusing the decision')
    }
    if (actor.ownerId !== undefined && actor.ownerId !== doc.ownerId) {
      this.#refuse(doc, 'owner-mismatch', { ownerId: actor.ownerId, expected: doc.ownerId }, at)
      throw new DeferredError('owner-mismatch', 'deferred: request ' + doc.requestId + ' belongs to owner ' + doc.ownerId + ', not ' + actor.ownerId)
    }
    if (!this.owners || doc.receiver?.kind === 'worker') {
      const expected = doc.receiver?.sessionId
      if (expected && actor.sessionId !== undefined && actor.sessionId !== expected) {
        this.#refuse(doc, 'receiver-mismatch', { sessionId: actor.sessionId, expected }, at)
        throw new DeferredError('receiver-mismatch', 'deferred: caller Session ' + actor.sessionId + ' is not the recorded receiver ' + expected)
      }
      return actor
    }
    const owner = this.#ownerBinding(doc.ownerId)
    const live = owner && owner.recycled !== true && typeof owner.sessionId === 'string' && owner.sessionId.trim()
      && (owner.status === 'created' || owner.status === undefined)
    const initialRoute = doc.action.type === 'dangerous-inject' && doc.action.entry === 'route'
      && !doc.receiver?.sessionId && actor.sessionId === undefined
      && owner?.status === 'pending' && owner.recycled !== true && !owner.sessionId
    if (!live && !initialRoute) {
      this.#refuse(doc, 'owner-missing', { ownerId: doc.ownerId }, at)
      throw new DeferredError('owner-missing', 'deferred: owner ' + doc.ownerId + ' has no current binding')
    }
    if (actor.sessionId !== undefined && actor.sessionId !== owner.sessionId) {
      this.#refuse(doc, 'receiver-stale', { sessionId: actor.sessionId, current: owner.sessionId }, at)
      throw new DeferredError('receiver-stale', 'deferred: caller Session ' + actor.sessionId + ' is not the current owner binding')
    }
    return actor
  }

  /** Reads the owner identity and its binding, if the port has one. */
  #ownerBinding(ownerId) {
    const owners = this.owners
    if (typeof owners === 'function') return this.#safeCall(() => owners(ownerId), undefined)
    if (typeof owners?.currentBinding === 'function') return this.#safeCall(() => owners.currentBinding(ownerId), undefined)
    if (typeof owners?.get === 'function') return this.#safeCall(() => owners.get(ownerId), undefined)
    return undefined
  }

  /** Lazily expires a due request and moves only its original waiting ticket. */
  #expireIfDue(doc, decision, at, cutoff = Date.parse(at)) {
    if (doc.status !== 'pending' || Date.parse(doc.expiresAt) > cutoff) return undefined
    const reason = '请求超过有效期未回应，自动过期'
    if (this.#waitingTicket(doc)) {
      if (doc.type === 'confirm') this.tasks.cancel(doc.ticketId, { by: 'system', reason, kind: 'timeout' })
      else this.tasks.escalate({ ticketId: doc.ticketId, by: 'system', reason })
    }
    const outcome = { kind: 'timeout', reason, at }
    if (decision !== undefined) outcome.decision = decision
    return this.#close(doc, 'expired', outcome, at)
  }

  #waitStage(doc) {
    return doc.type === 'confirm' ? 'person/confirm' : 'person/answer'
  }

  #waitingTicket(doc) {
    const ticket = this.tasks.getTicket(doc.ticketId)
    const face = ticket?.deferred
    if (face?.requestId !== doc.requestId || ticket.stage !== this.#waitStage(doc)) return undefined
    if (face.status !== (doc.status === 'pending' ? 'pending' : 'accepted')) return undefined
    const transitions = ticket.transitions ?? []
    if (face.waitRevision !== undefined) {
      if (face.waitRevision !== transitions.length) return undefined
    } else if (transitions.some(event => event.from === ticket.stage && Date.parse(event.at) >= Date.parse(doc.openedAt))) {
      // Legacy rows have no revision. A departure since opening invalidates the stored wait.
      return undefined
    }
    const question = doc.type === 'confirm' ? ticket.pendingConfirm : ticket.question
    if (!question || (doc.type === 'confirm' && !sameFact(question.action, doc.action))) return undefined
    return ticket
  }

  #retireStale(doc, at) {
    const reason = 'The task is no longer waiting for this decision.'
    this.#close(doc, 'cancelled', { refused: 'stale-deferred', reason, at }, at)
    return new DeferredError('stale-deferred', reason)
  }

  #checkTarget(doc) {
    if (!actionNeedsTarget(doc.action)) return undefined
    const { ownerId, sessionId } = doc.target ?? {}
    if (targetsOwner(doc.action)) {
      if (typeof ownerId !== 'string' || !ownerId.trim()) {
        return new DeferredError('target-missing', 'deferred: request ' + doc.requestId + ' has no stored owner destination')
      }
      if (ownerId !== doc.ownerId || (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim()))) {
        return new DeferredError('target-ineligible', 'deferred: the stored destination must identify the original owner')
      }
      return undefined
    }

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return new DeferredError('target-missing', 'deferred: request ' + doc.requestId + ' has no stored session destination')
    }
    if (ownerId != null || (doc.action.sessionId !== undefined && doc.action.sessionId !== sessionId) || this.#isOwnerSession(sessionId)) {
      return new DeferredError('target-ineligible', 'deferred: target Session ' + sessionId + ' cannot be used as the original execution destination')
    }
    return undefined
  }

  #isOwnerSession(sessionId) {
    return typeof this.owners?.isOwnerSession === 'function'
      && this.#safeCall(() => this.owners.isOwnerSession(sessionId), true) !== false
  }

  /** Closes a request for good and mirrors the terminal status onto the ticket face. */
  #close(doc, status, outcome, at) {
    const receipt = outcome.receivedAt === undefined ? {} : { receivedAt: outcome.receivedAt }
    const closed = { ...doc, ...receipt, status, decidedAt: doc.decidedAt ?? outcome.at ?? at, outcome }
    this.#save(closed)
    this.#mirror(closed)
    this.closeHandler?.(closed)
    return closed
  }

  /** Ticket-face status vocabulary differs (fulfilled/rejected/cancelled/expired) — map, never invent a second lifecycle. */
  #mirror(closed) {
    const status = ['fulfillment-failed', 'fulfillment-uncertain'].includes(closed.outcome?.kind) ? 'cancelled'
      : closed.status === 'answered' ? (closed.outcome?.decision === 'reject' ? 'rejected' : 'fulfilled')
      : closed.status
    const face = this.tasks.getTicket(closed.ticketId)?.deferred
    // A stale registry row may outlive its ticket face. Never write into a replacement request.
    if (face?.requestId === closed.requestId) {
      this.tasks.closeDeferred(closed.ticketId, { status, outcome: closed.outcome, decidedAt: closed.decidedAt, executedAt: closed.executedAt })
    }
  }

  #result(doc, decision, extra) {
    return {
      request: doc,
      decision,
      status: doc.status,
      duplicate: extra.duplicate,
      executed: extra.executed,
      action: doc.action,
      target: doc.target,
      receiver: doc.receiver,
      text: extra.text,
      outcome: doc.outcome ?? null,
    }
  }

  #safeCall(fn, fallback) {
    try {
      const value = fn()
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }

  /** Normalizes a TaskBoard failure into the registry's error shape (codes are preserved). */
  #asDeferred(error) {
    if (error instanceof DeferredError) return error
    const code = typeof error?.code === 'string' && error.code ? error.code : 'deferred-failed'
    const message = error instanceof Error ? error.message : String(error)
    return new DeferredError(code, message, { cause: error })
  }
}
