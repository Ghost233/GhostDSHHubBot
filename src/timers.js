/**
 * Persistent one-shot follow-ups and Asia/Shanghai daily or weekly reminders.
 *
 * Timers survive restart in the SQLite `timer` table. Before calling `routeBackground`, persist the stable
 * `triggerRef` (`timer:<timer-id>:<occurrence>`), due instant and lateness. The Router dedupes by triggerRef
 * when a retry or a restart replays the intent.
 *
 * For recurring work, `fireAt` and `occurrenceId` track the next occurrence to submit. A Router receipt
 * advances that schedule. `delivery` tracks the latest intent or receipt, and `queuedDeliveries` retains
 * any older receipts whose worker prompt still awaits admission.
 *
 * The Router owns worker delivery and execution. This service validates the owner and the creator from the
 * authorized L1/L2 tool. Cancellation stops future wakes and preserves admitted work.
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

/** Grace for ordinary tick delays while the timer is armed. */
export const LATE_GRACE_MS = 60_000

/** An absolute timestamp MUST carry an explicit timezone: `Z` or `±HH:MM`. A bare local time is ambiguous. */
const ABSOLUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const TIME_ZONE = 'Asia/Shanghai'
const DAY_MS = 86_400_000
const shanghaiOffset = new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })

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

function shanghaiOffsetMs(ms) {
  const { value } = shanghaiOffset.formatToParts(ms).find(part => part.type === 'timeZoneName')
  const [hours, minutes, seconds = 0] = value.slice(4).split(':').map(Number)
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000
}

// Shanghai calendar days represented as UTC midnights so date arithmetic is independent of the host zone.
function shanghaiDay(ms) {
  return Math.floor((ms + shanghaiOffsetMs(ms)) / DAY_MS) * DAY_MS
}

function shanghaiWeekday(day) {
  return new Date(day).getUTCDay() || 7
}

function periodMs(schedule) {
  return schedule.frequency === 'daily' ? DAY_MS : 7 * DAY_MS
}

function fireOnDay(schedule, day) {
  const [hours, minutes] = schedule.time.split(':').map(Number)
  const wallTime = day + (hours * 60 + minutes) * 60_000
  const priorOffset = shanghaiOffsetMs(wallTime - DAY_MS)
  const first = wallTime - priorOffset
  const actualOffset = shanghaiOffsetMs(first)
  if (actualOffset === priorOffset) return first
  // Prefer the first instant of an overlap and move forward through a gap in historical offset rules.
  const adjusted = wallTime - actualOffset
  return adjusted + shanghaiOffsetMs(adjusted) === wallTime ? adjusted : Math.max(first, adjusted)
}

function parseSchedule(input, nowMs) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['frequency', 'time', 'weekday'].includes(key))) {
    throw new TimerError('timer-schedule-invalid', 'timer_create: schedule must specify frequency, time and optional weekday.')
  }
  const { frequency, time, weekday } = input
  if (frequency !== 'daily' && frequency !== 'weekly') {
    throw new TimerError('timer-schedule-frequency', 'timer_create: schedule frequency must be daily or weekly.')
  }
  if (typeof time !== 'string' || !LOCAL_TIME.test(time)) {
    throw new TimerError('timer-schedule-time', 'timer_create: schedule time must be HH:mm in Asia/Shanghai.')
  }
  if (weekday !== undefined && (frequency !== 'weekly' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
    throw new TimerError('timer-schedule-weekday', 'timer_create: weekday is only for weekly schedules and must be 1 (Monday) through 7 (Sunday).')
  }
  return { frequency, time, timeZone: TIME_ZONE,
    ...(frequency === 'weekly' && { weekday: weekday ?? shanghaiWeekday(shanghaiDay(nowMs)) }),
  }
}

function firstScheduledFire(schedule, nowMs) {
  const today = shanghaiDay(nowMs)
  const daysUntilFire = schedule.frequency === 'weekly' ? (schedule.weekday - shanghaiWeekday(today) + 7) % 7 : 0
  const day = today + daysUntilFire * DAY_MS
  const fireAt = fireOnDay(schedule, day)
  return fireAt > nowMs ? fireAt : fireOnDay(schedule, day + periodMs(schedule))
}

function latestScheduledOccurrence(timer, nowMs) {
  const period = periodMs(timer.schedule)
  const firstDay = shanghaiDay(Date.parse(timer.fireAt))
  let skipped = Math.floor((shanghaiDay(nowMs) - firstDay) / period)
  if (skipped <= 0) return timer
  let fireAt = fireOnDay(timer.schedule, firstDay + skipped * period)
  if (fireAt > nowMs) {
    skipped--
    if (skipped === 0) return timer
    fireAt = fireOnDay(timer.schedule, firstDay + skipped * period)
  }
  return {
    ...timer,
    fireAt: toIso(fireAt),
    occurrenceId: String(Number(timer.occurrenceId) + skipped),
  }
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

/** The caller verifies the source event before supplying its original authorization. */
function feishuAuthorization(authorization, origin) {
  if (authorization === undefined) return undefined
  const saved = { ...authorization }
  const { at } = saved
  // Date.parse can normalize an impossible calendar day, such as February 30.
  const validTimestamp = typeof at === 'string' && ABSOLUTE_TIMESTAMP.test(at) && Number.isFinite(Date.parse(at))
    && new Date(at.slice(0, 10) + 'T00:00:00Z').getUTCDate() === Number(at.slice(8, 10))
  if (!origin || saved.actor !== origin.actor || saved.source !== origin.kind || !validTimestamp) {
    throw new TimerError('timer-authorization-invalid', 'Timer authorization must match its Feishu origin and have a valid absolute timestamp.')
  }
  return saved
}

/**
 * Persistent follow-up and recurring timers.
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
  #startedAtMs
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
    this.#startedAtMs = this.#nowMs()
    this.#lateGraceMs = lateGraceMs
    this.#authorizeCreate = authorizeCreate
  }

  /**
   * Creates a pending follow-up with an absolute `fireAt` or a daily or weekly `schedule`.
   * Weekly schedules without a weekday use the Shanghai weekday at creation.
   *
   * `createdBy` identifies who set the reminder. `ownerId` identifies who owns the follow-up.
   * A verified Feishu event supplies the original ticket authorization. Direct reminders use the creator.
   *
   * @param {{ ownerId: string, createdBy: string, message: string, fireAt?: string,
   *   schedule?: { frequency: 'daily' | 'weekly', time: string, weekday?: number },
   *   origin?: { kind: 'feishu', triggerId: string, chatId: string, actor: string },
   *   authorization?: { actor: string, source: 'feishu', at: string, messageId?: string, addressing?: string } }} request
   * @returns {object} the stored timer document.
   */
  create({ ownerId, createdBy, fireAt, schedule, message, origin, authorization } = {}) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new TimerError('owner-required', 'timer_create: ownerId must be a non-empty string — a follow-up always belongs to one owner')
    }
    if (typeof createdBy !== 'string' || !createdBy.trim()) {
      throw new TimerError('created-by-required', 'timer_create: createdBy must be a non-empty string — the creator is recorded separately from the owner')
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw new TimerError('message-required', 'timer_create: message must be a non-empty string — that is what fires at fireAt')
    }
    if (fireAt !== undefined && schedule !== undefined) {
      throw new TimerError('timer-schedule-conflict', 'timer_create: provide either fireAt or schedule.')
    }
    const nowMs = this.#nowMs()
    const recurrence = schedule === undefined ? undefined : parseSchedule(schedule, nowMs)
    const fireAtMs = recurrence ? firstScheduledFire(recurrence, nowMs) : this.#parseAbsoluteFireAt(fireAt)
    if (fireAtMs <= nowMs) {
      throw new TimerError('fire-at-past',
        'timer_create: fireAt ' + fireAt + ' is not in the future (now ' + toIso(nowMs) + ') — a one-shot follow-up must be scheduled ahead')
    }
    const owner = this.#getOwner(ownerId)
    if (!owner) {
      throw new TimerError('unknown-owner', 'timer_create: unknown owner "' + ownerId + '" — a follow-up must belong to a registered owner')
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
    const sourceAuthorization = feishuAuthorization(authorization, sourceOrigin)
    const at = toIso(nowMs)
    const timer = {
      id: 'tmr-' + randomUUID(),
      kind: 'timer',
      ownerId,
      createdBy: createdBy.trim(),
      message: message.trim(),
      ...(sourceOrigin && { origin: sourceOrigin }),
      ...(sourceAuthorization && { authorization: sourceAuthorization }),
      // Canonical UTC instant for comparison and delivery. Preserve the input for one-shot display.
      fireAt: toIso(fireAtMs),
      ...(recurrence ? { schedule: recurrence } : { fireAtInput: fireAt }),
      createdAt: at,
      updatedAt: at,
      status: 'pending',
      // Scheduled slots are numbered from creation, including any later misses that are coalesced.
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
   * view field (never persisted): time until the stored `fireAt` for a pending or paused timer.
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

  /** Whether a persisted occurrence may deliver its initial worker prompt. */
  canDeliver(timerId, triggerRef) {
    return this.deliveryState(timerId, triggerRef) === 'ready'
  }

  /** @returns {'ready' | 'paused' | 'closed'} Admission state of an exact persisted occurrence. */
  deliveryState(timerId, triggerRef) {
    if (this.#store.closed || typeof triggerRef !== 'string' || !triggerRef) return 'closed'
    const timer = this.#read(timerId)
    if (!timer || timer.status === 'cancelled') return 'closed'
    const { delivery, occurrenceId, queuedDeliveries, schedule } = timer
    const earlier = queuedDeliveries?.find(candidate => candidate.triggerRef === triggerRef)
    const latest = delivery?.triggerRef === triggerRef && (schedule || delivery.occurrenceId === occurrenceId)
    const receipt = earlier ?? (latest && timer.status !== 'failed' ? delivery : null)
    if (this.#delivery(receipt)?.state !== 'queued') return 'closed'
    return timer.status === 'paused' ? 'paused' : 'ready'
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
   * Resumes scanning and allows the Router to admit already-queued occurrences.
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
   * Cancels future recurring occurrences and outstanding queued receipts, including after a scheduling failure.
   * A one-shot with an admitted or failed prompt returns its existing terminal result.
   *
   * @returns {{ timer: object, changed: boolean, alreadyFired?: boolean, alreadyFailed?: boolean }}
   */
  cancel(id) {
    const timer = this.#mustGet(id)
    const nowMs = this.#nowMs()
    const view = this.#view(timer, nowMs)
    if (timer.status === 'cancelled') return { timer: view, changed: false }
    if (!timer.schedule && (timer.status === 'failed' || view.delivery?.state === 'failed')) {
      return { timer: view, changed: false, alreadyFailed: true }
    }
    if (!timer.schedule && (view.delivery?.state === 'sent' || (timer.status === 'fired' && view.delivery?.state !== 'queued'))) {
      return { timer: view, changed: false, alreadyFired: true }
    }
    const cancelQueued = delivery => delivery?.state === 'queued' ? { ...delivery, state: 'cancelled' } : delivery
    const nowIso = toIso(nowMs)
    const next = this.#write({
      ...timer,
      status: 'cancelled',
      cancelledAt: nowIso,
      cancelRequestedDuringFire: timer.status === 'firing',
      nextAttemptAt: null,
      delivery: cancelQueued(view.delivery),
      ...(view.queuedDeliveries && { queuedDeliveries: view.queuedDeliveries.map(cancelQueued) }),
      updatedAt: nowIso,
    })
    return { timer: this.#view(next, nowMs), changed: true }
  }

  /**
   * Drives every due timer once. Called from the existing 1-second host tick.
   *
   * Deterministic under repetition: the due intent (stable triggerRef) is persisted before delivery, so a
   * second tick, a concurrent tick, or a reopen after a crash all retry the same occurrence identity and the
   * Router returns the ticket it already created.
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
      if (!timer.schedule && timer.delivery?.state === 'sent') { result.skipped++; continue }
      // Backoff gate: a transient failure must not hot-spin the 1s tick.
      if (timer.nextAttemptAt && Date.parse(timer.nextAttemptAt) > nowMs) { result.skipped++; continue }
      // An existing intent owns its slot through retries. Coalesce only slots without an intent.
      const occurrence = timer.schedule && timer.delivery?.occurrenceId !== timer.occurrenceId
        ? latestScheduledOccurrence(timer, nowMs) : timer
      const outcome = await this.#fire(occurrence, nowMs)
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
    const fireAtMs = Date.parse(fireAt)
    const lateMs = previous?.lateMs ?? Math.max(0, nowMs - fireAtMs)
    const missedWhileInactive = fireAtMs < this.#startedAtMs || fireAtMs < Date.parse(timer.resumedAt)
    const late = previous?.late ?? (missedWhileInactive || lateMs > this.#lateGraceMs)
    const source = {
      kind: 'timer', timerId: timer.id, occurrenceId, fireAt, late,
      ...(timer.origin && { origin: timer.origin }),
    }
    // Keep older Router tickets eligible while advancing to a new occurrence.
    const queuedDeliveries = timer.schedule && [
      ...(timer.queuedDeliveries ?? []),
      ...(timer.delivery && !previous ? [timer.delivery] : []),
    ].map(delivery => this.#delivery(delivery)).filter(delivery => delivery.state === 'queued')
    // 先存后做: the due intent is durable BEFORE anything is delivered.
    const intent = this.#write({
      ...timer,
      ...(queuedDeliveries && { queuedDeliveries }),
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
        authorization: timer.authorization ?? { actor: timer.createdBy, source: 'timer', at: timer.createdAt },
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
    const next = timer.schedule && !cancelled ? {
      status: 'pending',
      fireAt: toIso(fireOnDay(timer.schedule, shanghaiDay(Date.parse(delivery.fireAt)) + periodMs(timer.schedule))),
      occurrenceId: String(Number(delivery.occurrenceId) + 1),
      attempts: 0,
    } : { status: cancelled ? 'cancelled' : 'fired' }
    this.#write({
      ...timer,
      ...next,
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
    return {
      ...timer,
      remainingMs,
      delivery: this.#delivery(timer.delivery),
      ...(timer.queuedDeliveries && { queuedDeliveries: timer.queuedDeliveries.map(delivery => this.#delivery(delivery)) }),
    }
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
    if (current.stage === 'failed') return { ...current, state: 'failed', lastError: ticket?.failed?.reason ?? delivery.lastError ?? null }
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
