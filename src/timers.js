/**
 * TimerService — persistent ONE-SHOT follow-up timers (S09 / issue #40).
 *
 * A timer is a durable schedule document: 谁创建（createdBy）、替谁跟进（ownerId）、何时到点（fireAt）、
 * 到点说什么（message）、现在什么状态（status）. It survives host restarts because it lives in the SQLite
 * `timer` table (schema 1→2, appended migration in src/store.js).
 *
 * 先存后做 discipline (the same one the outbox and Router obey): before a due timer is handed to the Router
 * we PERSIST the due intent — the stable `triggerRef` (`timer:<timer-id>:<occurrence>`), the occurrence id,
 * the due instant and the lateness verdict. Only then do we call `routeBackground`. A crash between the two
 * leaves a 'firing' row whose next `tick()` retries with the SAME triggerRef, and the Router dedupes by
 * triggerRef, so one occurrence can never produce two tasks. Repeated ticks, concurrent ticks and reopen
 * all converge on "exactly one injection per occurrence".
 *
 * The service never prompts a Session itself: it hands the follow-up to the normal Router background port
 * (`routeBackground`), which owns admission, slots, the dedicated worker Session, authorization storage and
 * delivery. That is why this module has no host dependencies and is testable with a fake clock and a fake
 * Router port.
 *
 * Scope boundary (deliberate):
 *   - one-shot only. There is no repeat schedule until S10; `occurrenceId` is the hook S10 extends.
 *   - `cancel()` stops future wakes and preserves the timer's history. The Router owns Session stops.
 *   - creating timers is a caller-authorized tool action (L1/L2 only). This module validates identity and
 *     owner state; the tool/permission layer decides who may call it (optional `authorizeCreate` seam).
 */
import { randomUUID } from 'node:crypto'

/** `triggerRef` prefix: the stable identity of one timer occurrence is `timer:<timer-id>:<occurrence>`. */
export const TIMER_TRIGGER_PREFIX = 'timer:'

/** Every timer state. A one-shot walks pending → firing → fired, or leaves the walk via paused/cancelled/failed. */
export const TIMER_STATUSES = ['pending', 'paused', 'firing', 'fired', 'cancelled', 'failed']

/** The statuses `tick()` will still act on: a crashed 'firing' row is retried (idempotent by triggerRef). */
const FIREABLE = new Set(['pending', 'firing'])

/**
 * Router error codes that will never heal by retrying — retrying them would hot-spin the 1s tick forever.
 * Everything else (a transient host/prompt failure) returns the timer to 'pending' with exponential backoff.
 * These are the real codes `src/router.js` raises for a request that is structurally unacceptable.
 */
const PERMANENT_ROUTER_CODES = new Set([
  'unknown-owner', 'owner-recycled', 'cannot-route-to-chief', 'background-owner-transient',
  'invalid-background-source', 'authorization-missing', 'message-required',
  'background-worker-is-owner', 'background-preset-invalid',
])

/** Retry backoff: 2s, 4s, 8s … capped at 5 min (the same ladder the outbox uses for injections). */
const BACKOFF_BASE_MS = 2_000
const BACKOFF_CAP_MS = 5 * 60_000

/**
 * Sentinel written to the indexed `at` column for rows that must not be scanned by `tick()` (paused,
 * cancelled, fired, failed). Keeping the real `fireAt` in the document means the human still sees the true
 * schedule, while the due scan stays proportional to timers that can actually wake.
 */
const NEVER_DUE = '9999-12-31T23:59:59.999Z'

/**
 * Lateness grace. The host ticks every second, so a normal fire lands within ~1s of its due instant and is
 * NOT late. Lateness is claimed only when the due instant was genuinely missed — a stopped host, a paused
 * process, a suspended machine — which is exactly the case the spec wants marked 迟到.
 */
export const LATE_GRACE_MS = 60_000

/** An absolute timestamp MUST carry an explicit timezone: `Z` or `±HH:MM`. A bare local time is ambiguous. */
const ABSOLUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** A timer operation was refused. `code` is the stable machine-readable reason the tools/panel render. */
export class TimerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TimerError'
    this.code = code
  }
}

/** Normalizes an injected clock reading (epoch ms, Date, or ISO string) to epoch milliseconds. */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new TimerError('clock-invalid',
    'TimerService: now() must return epoch milliseconds or an absolute ISO timestamp, got ' + String(value))
}

/** Epoch milliseconds → canonical UTC ISO string. Canonical form makes `at` comparisons in SQL correct. */
function toIso(ms) {
  return new Date(ms).toISOString()
}

/** Keeps just the identity of a Feishu origin resolved by the caller. */
function feishuOrigin(origin) {
  if (origin === undefined) return undefined
  const { kind, triggerId, chatId, actor } = origin ?? {}
  if (kind !== 'feishu' || [triggerId, chatId, actor].some(value => typeof value !== 'string' || !value.trim())) {
    throw new TimerError('timer-origin-invalid', 'A timer origin requires a Feishu trigger, chat, and actor.')
  }
  return { kind, triggerId, chatId, actor }
}

/**
 * Persistent one-shot follow-up timers.
 *
 * @param {{ store: import('./store.js').Store,
 *   getOwner: (ownerId: string) => (object | undefined),
 *   getTicket?: (ticketId: string) => (object | undefined),
 *   routeBackground: (request: { ownerId: string, message: string, triggerRef: string,
 *     authorization: object, source: object }) => Promise<object>,
 *   now?: () => (number | string | Date),
 *   lateGraceMs?: number,
 *   authorizeCreate?: (request: { ownerId: string, createdBy: string }) => boolean }} deps
 */
export class TimerService {
  #store
  #getOwner
  #getTicket
  #routeBackground
  #now
  #lateGraceMs
  #authorizeCreate
  /** Single-flight guard: concurrent ticks share one pass, so one occurrence can never be double-admitted. */
  #inFlight = null

  constructor({ store, getOwner, getTicket, routeBackground, now = Date.now, lateGraceMs = LATE_GRACE_MS, authorizeCreate } = {}) {
    if (!store || typeof store.db?.prepare !== 'function') {
      throw new TimerError('store-required', 'TimerService: a Store instance is required')
    }
    if (typeof getOwner !== 'function') {
      throw new TimerError('get-owner-required', 'TimerService: getOwner(ownerId) is required to validate timer ownership')
    }
    if (typeof routeBackground !== 'function') {
      throw new TimerError('route-background-required', 'TimerService: the Router routeBackground port is required — timers never prompt independently')
    }
    if (typeof now !== 'function') throw new TimerError('clock-required', 'TimerService: now() must be a function')
    if (typeof lateGraceMs !== 'number' || !Number.isFinite(lateGraceMs) || lateGraceMs < 0) {
      throw new TimerError('late-grace-invalid', 'TimerService: lateGraceMs must be a non-negative number of milliseconds')
    }
    if (authorizeCreate !== undefined && typeof authorizeCreate !== 'function') {
      throw new TimerError('authorize-create-invalid', 'TimerService: authorizeCreate must be a function when given')
    }
    this.#store = store
    this.#getOwner = getOwner
    this.#getTicket = getTicket
    this.#routeBackground = routeBackground
    this.#now = now
    this.#lateGraceMs = lateGraceMs
    this.#authorizeCreate = authorizeCreate
  }

  /**
   * Creates one pending one-shot follow-up.
   *
   * `createdBy` (谁下的令) and `ownerId` (替谁跟进) are separate identities and both are stored: the creator
   * is what the ticket face carries as authorization actor, the owner is what the task belongs to.
   *
   * @param {{ ownerId: string, createdBy: string, fireAt: string, message: string,
   *   origin?: { kind: 'feishu', triggerId: string, chatId: string, actor: string } }} request
   * @returns {object} the stored timer document.
   */
  create({ ownerId, createdBy, fireAt, message, origin } = {}) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new TimerError('owner-required', 'timer_create: ownerId must be a non-empty string — a follow-up always belongs to one owner')
    }
    if (typeof createdBy !== 'string' || !createdBy.trim()) {
      throw new TimerError('created-by-required', 'timer_create: createdBy must be a non-empty string — the creator is recorded separately from the owner')
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw new TimerError('message-required', 'timer_create: message must be a non-empty string — that is what fires at fireAt')
    }
    const fireAtMs = this.#parseAbsoluteFireAt(fireAt)
    const nowMs = this.#nowMs()
    if (fireAtMs <= nowMs) {
      throw new TimerError('fire-at-past',
        'timer_create: fireAt ' + fireAt + ' is not in the future (now ' + toIso(nowMs) + ') — a one-shot follow-up must be scheduled ahead')
    }
    const owner = this.#getOwner(ownerId)
    if (!owner) {
      throw new TimerError('unknown-owner', 'timer_create: unknown owner "' + ownerId + '" — a follow-up must belong to a registered owner')
    }
    if (owner.role === 'chief') {
      throw new TimerError('cannot-timer-chief', 'timer_create: the chief is the router, not a follow-up target')
    }
    if (owner.recycled) {
      throw new TimerError('owner-recycled', 'timer_create: owner ' + ownerId + ' 已回收 — its directory is gone, schedule a follow-up for a live owner instead')
    }
    // Background work needs a persistent owner: a transient scratch owner's directory disappears with the
    // process, so a timer pointing at it would fire into nothing.
    if (owner.transient) {
      throw new TimerError('background-owner-transient', 'timer_create: owner ' + ownerId + ' is transient — background work requires a persistent owner')
    }
    if (this.#authorizeCreate && this.#authorizeCreate({ ownerId, createdBy: createdBy.trim() }) === false) {
      throw new TimerError('timer-create-unauthorized', 'timer_create: ' + createdBy + ' is not allowed to schedule follow-ups (only the human-facing L1/L2 tools may create timers)')
    }
    const sourceOrigin = feishuOrigin(origin)
    const at = toIso(nowMs)
    const timer = {
      id: 'tmr-' + randomUUID(),
      kind: 'timer',
      ownerId,
      createdBy: createdBy.trim(),
      message: message.trim(),
      ...(sourceOrigin && { origin: sourceOrigin }),
      // Canonical UTC instant for comparison/delivery + the exact string the human gave, kept for display.
      fireAt: toIso(fireAtMs),
      fireAtInput: fireAt,
      createdAt: at,
      updatedAt: at,
      status: 'pending',
      // One-shot: the single occurrence identity. S10 turns this into a counter for repeating schedules.
      occurrenceId: '1',
      attempts: 0,
      nextAttemptAt: null,
      delivery: null,
      lastError: null,
      pausedAt: null,
      firedAt: null,
      cancelledAt: null,
      late: null,
    }
    this.#insert(timer)
    return this.#view(timer, nowMs)
  }

  /**
   * Lists timers in creation order (oldest first), optionally scoped to one owner. `remainingMs` is a computed
   * view field (never persisted): how long until the next fire for a pending timer, or the frozen remainder for
   * a paused one.
   *
   * The SQL `ORDER BY at` only pre-sorts the scan; `at` is the NEVER_DUE sentinel for paused/terminal rows, so
   * it is NOT a display order. The authoritative order is applied below: `createdAt`, then `rowid` (insertion
   * sequence). The rowid tiebreak matters — two timers created within the same clock reading share a
   * `createdAt`, and `id` is a random uuid, so tiebreaking on `id` would shuffle them randomly.
   *
   * @param {{ ownerId?: string }} [filter]
   * @returns {Array<object>}
   */
  list({ ownerId } = {}) {
    const nowMs = this.#nowMs()
    const rows = this.#store.db.prepare('SELECT id, value, rowid AS seq FROM timer ORDER BY at, rowid').all()
    return rows
      .map(row => ({ seq: Number(row.seq), timer: JSON.parse(String(row.value)) }))
      .filter(entry => ownerId === undefined || entry.timer.ownerId === ownerId)
      .sort((a, b) => (a.timer.createdAt === b.timer.createdAt
        ? a.seq - b.seq
        : (a.timer.createdAt < b.timer.createdAt ? -1 : 1)))
      .map(entry => this.#view(entry.timer, nowMs))
  }

  /** Reads one timer by id, or undefined when it does not exist. */
  get(id) {
    const timer = this.#read(id)
    return timer === undefined ? undefined : this.#view(timer, this.#nowMs())
  }

  /** Whether the current persisted occurrence may still deliver its initial worker prompt. */
  canDeliver(timerId, triggerRef) {
    if (this.#store.closed || typeof triggerRef !== 'string' || !triggerRef) return false
    const timer = this.#read(timerId)
    return Boolean(timer && (FIREABLE.has(timer.status) || timer.status === 'fired')
      && timer.delivery?.triggerRef === triggerRef && timer.delivery.occurrenceId === timer.occurrenceId
      && this.#delivery(timer.delivery).state === 'queued')
  }

  /**
   * Pauses a pending timer. Its absolute fireAt stays fixed while dispatch is suspended.
   *
   * @returns {{ timer: object, changed: boolean }}
   */
  pause(id) {
    const timer = this.#mustGet(id)
    const nowMs = this.#nowMs()
    if (timer.status === 'paused') return { timer: this.#view(timer, nowMs), changed: false }
    if (timer.status !== 'pending') {
      throw new TimerError('timer-not-pausable', 'timer_pause: timer ' + id + ' is ' + timer.status + ' — only a pending timer can be paused')
    }
    const next = this.#write({
      ...timer,
      status: 'paused',
      pausedAt: toIso(nowMs),
      nextAttemptAt: null,
      updatedAt: toIso(nowMs),
    })
    return { timer: this.#view(next, nowMs), changed: true }
  }

  /**
   * Resumes the same occurrence. The next scan catches up once if its absolute fireAt has passed.
   *
   * @returns {{ timer: object, changed: boolean }}
   */
  resume(id) {
    const timer = this.#mustGet(id)
    const nowMs = this.#nowMs()
    if (timer.status === 'pending') return { timer: this.#view(timer, nowMs), changed: false }
    if (timer.status !== 'paused') {
      throw new TimerError('timer-not-resumable', 'timer_resume: timer ' + id + ' is ' + timer.status + ' — only a paused timer can be resumed')
    }
    const next = this.#write({
      ...timer,
      status: 'pending',
      resumedAt: toIso(nowMs),
      resumeCount: (timer.resumeCount ?? 0) + 1,
      nextAttemptAt: null,
      updatedAt: toIso(nowMs),
    })
    return { timer: this.#view(next, nowMs), changed: true }
  }

  /**
   * Cancels a pending or queued occurrence and keeps its timer record.
   * Once the initial prompt is sent, cancel reports `alreadyFired`.
   *
   * @returns {{ timer: object, changed: boolean, alreadyFired?: boolean, alreadyFailed?: boolean }}
   */
  cancel(id) {
    const timer = this.#mustGet(id)
    const nowMs = this.#nowMs()
    const view = this.#view(timer, nowMs)
    if (timer.status === 'cancelled') return { timer: view, changed: false }
    if (timer.status === 'failed') return { timer: view, changed: false, alreadyFailed: true }
    if (view.delivery?.state === 'sent' || (timer.status === 'fired' && view.delivery?.state !== 'queued')) {
      return { timer: view, changed: false, alreadyFired: true }
    }
    const nowIso = toIso(nowMs)
    const next = this.#write({
      ...timer,
      status: 'cancelled',
      cancelledAt: nowIso,
      cancelRequestedDuringFire: timer.status === 'firing',
      nextAttemptAt: null,
      delivery: view.delivery && { ...view.delivery, state: 'cancelled' },
      updatedAt: nowIso,
    })
    return { timer: this.#view(next, nowMs), changed: true }
  }

  /**
   * Drives every due timer once. Called from the existing 1-second host tick.
   *
   * Deterministic under repetition: the due intent (stable triggerRef) is persisted before delivery, so a
   * second tick, a concurrent tick, or a reopen after a crash all retry the SAME occurrence identity and the
   * Router returns the ticket it already created. A timer therefore fires exactly once.
   *
   * @returns {Promise<{ due: number, fired: number, retried: number, failed: number, skipped: number }>}
   */
  tick() {
    if (this.#inFlight) return this.#inFlight
    const pass = this.#tick().finally(() => { this.#inFlight = null })
    this.#inFlight = pass
    return pass
  }

  /** One tick pass, single-flight by `tick()`. */
  async #tick() {
    const nowMs = this.#nowMs()
    const nowIso = toIso(nowMs)
    // `at` holds the canonical UTC due instant, so the comparison is lexicographic-correct and index-backed.
    const rows = this.#store.db.prepare('SELECT id FROM timer WHERE at <= ? ORDER BY at, rowid').all(nowIso)
    const result = { due: rows.length, fired: 0, retried: 0, failed: 0, skipped: 0 }
    for (const row of rows) {
      if (this.#store.closed) break
      const timer = this.#read(row.id)
      if (!timer || !FIREABLE.has(timer.status) || timer.fireAt > nowIso) { result.skipped++; continue }
      // Already delivered (the row is kept for the human): never a second injection.
      if (timer.delivery?.state === 'sent') { result.skipped++; continue }
      // Backoff gate: a transient failure must not hot-spin the 1s tick.
      if (timer.nextAttemptAt && Date.parse(timer.nextAttemptAt) > nowMs) { result.skipped++; continue }
      const outcome = await this.#fire(timer, nowMs)
      if (outcome === 'fired') result.fired++
      else if (outcome === 'retried') result.retried++
      else if (outcome === 'failed') result.failed++
      else result.skipped++
    }
    return result
  }

  /**
   * Fires one occurrence: persist the due intent, then hand it to the Router.
   * @returns {Promise<'fired'|'retried'|'failed'|'skipped'>}
   */
  async #fire(timer, nowMs) {
    const nowIso = toIso(nowMs)
    const occurrenceId = timer.occurrenceId
    const triggerRef = TIMER_TRIGGER_PREFIX + timer.id + ':' + occurrenceId
    const previous = timer.delivery?.triggerRef === triggerRef ? timer.delivery : null
    const recovered = this.#delivery(previous)
    if (recovered?.state === 'sent') return this.#settle(timer, recovered, nowIso)
    // Retries carry the due instant and lateness recorded by the first attempt.
    const fireAt = previous?.fireAt ?? timer.fireAt
    const lateMs = previous?.lateMs ?? Math.max(0, nowMs - Date.parse(fireAt))
    const late = previous?.late ?? (lateMs > this.#lateGraceMs)
    const source = {
      kind: 'timer', timerId: timer.id, occurrenceId, fireAt, late,
      ...(timer.origin && { origin: timer.origin }),
    }
    // 先存后做: the due intent is durable BEFORE anything is delivered.
    const intent = this.#write({
      ...timer,
      status: 'firing',
      attempts: (timer.attempts ?? 0) + 1,
      late,
      lateMs,
      nextAttemptAt: null,
      lastError: null,
      delivery: {
        state: 'queued', at: previous?.at ?? nowIso, triggerRef, occurrenceId, fireAt, late, lateMs,
        ...(previous?.ticketId && { ticketId: previous.ticketId }),
      },
      updatedAt: nowIso,
    })
    let receipt
    try {
      receipt = await this.#routeBackground({
        ownerId: timer.ownerId,
        message: timer.message,
        triggerRef,
        // 票面权威: the creator and the moment of creation ARE the authorization for this follow-up.
        authorization: { actor: timer.createdBy, source: 'timer', at: timer.createdAt },
        source,
      })
      if (!receipt?.ticketId) throw new TimerError('missing-timer-ticket', 'The router did not accept this timer occurrence.')
    } catch (error) {
      if (this.#store.closed) return 'skipped'
      const latest = this.#read(timer.id)
      if (latest?.delivery?.triggerRef !== triggerRef || latest.attempts !== intent.attempts
        || !['firing', 'cancelled'].includes(latest.status)) return 'skipped'
      const evidence = this.#delivery(latest.delivery)
      if (evidence.state === 'sent') return this.#settle(latest, evidence, toIso(this.#nowMs()))
      if (latest.status !== 'firing') return 'skipped'
      const code = error?.code ?? null
      const permanent = error?.permanent === true || (code !== null && PERMANENT_ROUTER_CODES.has(code))
      const attempts = latest.attempts
      const message = error?.message ?? String(error)
      const finishedMs = this.#nowMs()
      const finishedAt = toIso(finishedMs)
      const next = this.#write({
        ...latest,
        status: permanent ? 'failed' : 'pending',
        nextAttemptAt: permanent ? null : toIso(finishedMs + Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)),
        lastError: { code, message, at: finishedAt },
        delivery: { ...latest.delivery, state: permanent ? 'failed' : 'queued', lastError: message },
        updatedAt: finishedAt,
      })
      return next.status === 'failed' ? 'failed' : 'retried'
    }
    if (this.#store.closed) return 'skipped'
    const latest = this.#read(timer.id)
    if (latest?.delivery?.triggerRef !== triggerRef || latest.attempts !== intent.attempts
      || !['firing', 'cancelled'].includes(latest.status)) return 'skipped'
    const finishedAt = toIso(this.#nowMs())
    let delivery = this.#delivery({
      ...latest.delivery,
      ticketId: receipt.ticketId,
      deduped: receipt.deduped === true,
      stage: receipt.stage ?? null,
      ...(receipt.workerSession && { workerSession: receipt.workerSession }),
    })
    if (receipt.admitted === true && delivery.state !== 'sent') {
      delivery = { ...delivery, state: 'sent', sentAt: finishedAt }
    }
    return this.#settle(latest, delivery, finishedAt)
  }

  #settle(timer, delivery, at) {
    const cancelled = timer.status === 'cancelled'
    const sent = delivery.state === 'sent'
    this.#write({
      ...timer,
      status: cancelled ? 'cancelled' : 'fired',
      firedAt: cancelled && !sent ? timer.firedAt : delivery.at,
      nextAttemptAt: null,
      lastError: null,
      delivery,
      updatedAt: at,
    })
    return cancelled && !sent ? 'skipped' : 'fired'
  }

  /** Validates an absolute `fireAt`: parseable AND carrying an explicit timezone/offset. */
  #parseAbsoluteFireAt(fireAt) {
    if (typeof fireAt !== 'string' || !fireAt.trim()) {
      throw new TimerError('fire-at-required', 'timer_create: fireAt must be an absolute timestamp string, e.g. 2026-11-15T09:00:00+08:00')
    }
    const value = fireAt.trim()
    if (!ABSOLUTE_TIMESTAMP.test(value)) {
      throw new TimerError('fire-at-format',
        'timer_create: fireAt "' + value + '" must be an absolute timestamp with an explicit timezone/offset (Z or ±HH:MM) — a bare local time is ambiguous')
    }
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) {
      throw new TimerError('fire-at-format', 'timer_create: fireAt "' + value + '" is not a real instant')
    }
    return ms
  }

  /** The injected clock, normalized to epoch milliseconds. */
  #nowMs() {
    return toEpochMs(this.#now())
  }

  /** The stored document plus the computed `remainingMs` a management view needs. */
  #view(timer, nowMs) {
    let remainingMs = null
    if (['pending', 'paused'].includes(timer.status)) remainingMs = Math.max(0, Date.parse(timer.fireAt) - nowMs)
    return { ...timer, remainingMs, delivery: this.#delivery(timer.delivery) }
  }

  /** Projects the ticket's current evidence onto the durable occurrence receipt. */
  #delivery(delivery) {
    if (!delivery) return delivery
    const ticket = this.#ticketFor(delivery)
    const current = ticket ? {
      ...delivery,
      ...(ticket.id && { ticketId: ticket.id }),
      stage: ticket.stage,
      workerSession: ticket.workerSession ?? delivery.workerSession ?? null,
    } : delivery
    if (delivery.state === 'sent') return current
    if (ticket?.lastDelivery?.state === 'sent') {
      return { ...current, state: 'sent', sentAt: ticket.lastDelivery.at }
    }
    if (delivery.state !== 'queued') return current
    if (current.stage === 'failed') return { ...current, state: 'failed' }
    if (current.stage === 'done') return { ...current, state: 'cancelled' }
    return current
  }

  /** A persisted trigger can locate its ticket even if the Router receipt was never returned. */
  #ticketFor(delivery) {
    if (delivery.ticketId && this.#getTicket) return this.#getTicket(delivery.ticketId)
    const raw = delivery.ticketId
      ? this.#store.db.prepare('SELECT value FROM ticket WHERE id = ?').get(delivery.ticketId)
      : this.#store.db.prepare(`SELECT value FROM ticket
          WHERE json_extract(value, '$.triggerId') = ?
            AND json_extract(value, '$.background.kind') = 'timer' LIMIT 1`).get(delivery.triggerRef)
    return raw && JSON.parse(String(raw.value))
  }

  /** Reads one row without validating existence. */
  #read(id) {
    if (typeof id !== 'string' || !id) return undefined
    const row = this.#store.db.prepare('SELECT value FROM timer WHERE id = ?').get(id)
    return row === undefined ? undefined : JSON.parse(String(row.value))
  }

  /** Reads one row, refusing unknown ids. */
  #mustGet(id) {
    const timer = this.#read(id)
    if (timer === undefined) {
      throw new TimerError('timer-not-found', 'timer: no timer with id "' + String(id) + '"')
    }
    return timer
  }

  /** Inserts a new timer document. `at`/`owner` are denormalized columns for the due scan and owner filter. */
  #insert(timer) {
    this.#store.db.prepare('INSERT INTO timer (id, value, at, owner) VALUES (?, ?, ?, ?)')
      .run(timer.id, JSON.stringify(timer), this.#dueColumn(timer), timer.ownerId)
    return timer
  }

  /** Replaces a timer document (and its denormalized due instant / owner). */
  #write(timer) {
    this.#store.db.prepare('UPDATE timer SET value = ?, at = ?, owner = ? WHERE id = ?')
      .run(JSON.stringify(timer), this.#dueColumn(timer), timer.ownerId, timer.id)
    return timer
  }

  /**
   * The value of the indexed `at` column: the due instant while the timer can still wake, otherwise a
   * far-future sentinel. Terminal and paused rows therefore fall out of the `at <= now` scan instead of being
   * re-read on every one-second tick forever — the document itself keeps the truthful `fireAt` for display.
   * A 'firing' row keeps its real due instant so a crashed delivery is retried by the next tick.
   */
  #dueColumn(timer) {
    return timer.status === 'pending' || timer.status === 'firing' ? timer.fireAt : NEVER_DUE
  }
}
