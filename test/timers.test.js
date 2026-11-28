/**
 * TimerService tests (S09 / issue #40): persistent ONE-SHOT follow-up timers.
 *
 * These run against the real Store (a throwaway SQLite database per test), a fake clock, and a fake Router
 * port — no host, no network, no Session. What is asserted is the reliability contract:
 *   - the due intent (stable `timer:<id>:<occurrence>` triggerRef) is persisted BEFORE delivery;
 *   - repeated ticks, concurrent ticks and a reopen all inject that one occurrence exactly once;
 *   - lateness is measured against the real due instant, never hardcoded;
 *   - cancel stops later wakes but never terminates an already-executing run;
 *   - owner and creator are separate stored identities, and only an authorized caller may create.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { TimerService, TimerError, TIMER_TRIGGER_PREFIX, LATE_GRACE_MS } from '../src/timers.js'

const T0 = Date.parse('2026-11-15T00:00:00.000Z')
const at = ms => new Date(ms).toISOString()

/** A registered-owner row shaped like OwnerRegistry's, so `getOwner` behaves like the real port. */
function owner(id, extra = {}) {
  return {
    id, role: 'owner', kind: 'repo', workspace: '/tmp/' + id, cwd: '/tmp/' + id,
    sessionId: 'session-' + id, status: 'active', transient: false, recycled: false,
    createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', ...extra,
  }
}

const OWNERS = {
  'repo-DSH': owner('repo-DSH'),
  'repo-Other': owner('repo-Other'),
  'repo-Gone': owner('repo-Gone', { recycled: true }),
  'owner-scratch': owner('owner-scratch', { transient: true }),
  chief: owner('chief', { role: 'chief', sessionId: 'session-chief' }),
}

/**
 * Opens a real Store + TimerService over a throwaway directory with a controllable clock and a fake Router.
 * The fake Router mirrors the real one's idempotency contract: the same `triggerRef` yields the SAME ticket
 * with `deduped: true`, which is what makes a retried timer occurrence harmless.
 */
function fixture({ dir, owners = OWNERS, route, getTicket, authorizeCreate, startAt = T0 } = {}) {
  const stateDir = dir ?? mkdtempSync(join(tmpdir(), 'hub-bot-timers-'))
  const store = new Store(stateDir)
  let clock = startAt
  const calls = []
  const tickets = new Map()
  const registry = owners
  const routeBackground = async request => {
    calls.push(request)
    if (route) return route(request, calls.length)
    const existing = tickets.get(request.triggerRef)
    if (existing) return { ...existing, deduped: true }
    const ticketId = 'tsk-' + (tickets.size + 1)
    const receipt = {
      ownerId: request.ownerId, sessionId: 'session-' + request.ownerId, ticketId,
      requestId: 'req-' + (tickets.size + 1), createdSession: false, rebuilt: false, deduped: false, stage: 'working', admitted: true,
    }
    tickets.set(request.triggerRef, receipt)
    return receipt
  }
  const timers = new TimerService({
    store, getOwner: id => registry[id], getTicket, routeBackground, now: () => clock,
    ...(authorizeCreate && { authorizeCreate }),
  })
  return {
    stateDir, store, timers, calls, tickets,
    now: () => clock,
    setNow: ms => { clock = ms },
    advance: ms => { clock += ms },
    cleanup: () => { try { store.close() } finally { rmSync(stateDir, { recursive: true, force: true }) } },
    closeOnly: () => store.close(),
  }
}

/** Creates one timer one minute out from the current clock and returns its stored document. */
function schedule(timers, overrides = {}) {
  return timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', fireAt: at(T0 + 60_000),
    message: '跟进：检查 #40 的定时器是否已落地', ...overrides,
  })
}

test('create stores the schedule, the owner and the creator as separate identities', t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  assert.match(timer.id, /^tmr-/)
  assert.equal(timer.ownerId, 'repo-DSH')
  // 谁下的令 and 替谁跟进 are different people and are stored separately: the ticket face carries createdBy.
  assert.equal(timer.createdBy, 'user:l1')
  assert.notEqual(timer.createdBy, timer.ownerId)
  assert.equal(timer.status, 'pending')
  assert.equal(timer.occurrenceId, '1')
  assert.equal(timer.fireAt, at(T0 + 60_000))
  assert.equal(timer.fireAtInput, at(T0 + 60_000))
  assert.equal(timer.createdAt, at(T0))
  assert.equal(timer.remainingMs, 60_000)
  assert.equal(timer.attempts, 0)
  assert.equal(timer.late, null)
  assert.equal(timer.delivery, null)
  // Durable, not in-memory: the row is in the timer table with its due instant and owner denormalized.
  const row = f.store.db.prepare('SELECT id, at, owner FROM timer WHERE id = ?').get(timer.id)
  assert.equal(row.at, at(T0 + 60_000))
  assert.equal(row.owner, 'repo-DSH')
})

test('create refuses a relative, ambiguous or past fireAt and unknown targets', t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const bad = (overrides, code) => assert.throws(() => schedule(f.timers, overrides),
    error => error instanceof TimerError && error.code === code, `expected ${code} for ${JSON.stringify(overrides)}`)
  // An absolute timestamp MUST carry an explicit timezone — a bare local time is ambiguous.
  bad({ fireAt: '2026-11-15 09:00' }, 'fire-at-format')
  bad({ fireAt: '2026-11-15T09:00:00' }, 'fire-at-format')
  bad({ fireAt: 'in 5 minutes' }, 'fire-at-format')
  bad({ fireAt: '' }, 'fire-at-required')
  bad({ fireAt: '2026-11-14T09:00:00+08:00' }, 'fire-at-past')
  bad({ ownerId: '' }, 'owner-required')
  bad({ createdBy: '' }, 'created-by-required')
  bad({ message: '   ' }, 'message-required')
  bad({ ownerId: 'repo-Nobody' }, 'unknown-owner')
  bad({ ownerId: 'chief' }, 'cannot-timer-chief')
  bad({ ownerId: 'repo-Gone' }, 'owner-recycled')
  bad({ ownerId: 'owner-scratch' }, 'background-owner-transient')
  // A non-UTC offset is accepted and normalized to the same instant.
  const tokyo = f.timers.create({ ownerId: 'repo-DSH', createdBy: 'user:l1', fireAt: '2026-11-15T09:01:00+09:00', message: 'ok' })
  assert.equal(tokyo.fireAt, at(T0 + 60_000))
})

test('only an authorized caller may create a timer (L1/L2 tools, never L3/c-class)', t => {
  // The tool layer owns the actual permission rule; TimerService exposes the seam and refuses a denial.
  const denied = fixture({ authorizeCreate: ({ ownerId, createdBy }) => ownerId !== 'repo-Other' && createdBy !== 'agent:c-class' })
  t.after(() => denied.cleanup())
  assert.throws(() => schedule(denied.timers, { createdBy: 'agent:c-class' }),
    error => error instanceof TimerError && error.code === 'timer-create-unauthorized')
  assert.throws(() => schedule(denied.timers, { ownerId: 'repo-Other' }),
    error => error instanceof TimerError && error.code === 'timer-create-unauthorized')
  // An allowed caller still creates normally, and the seam sees both identities.
  const seen = []
  const allowed = fixture({ authorizeCreate: request => { seen.push(request); return true } })
  t.after(() => allowed.cleanup())
  schedule(allowed.timers)
  assert.deepEqual(seen, [{ ownerId: 'repo-DSH', createdBy: 'user:l1' }])
})

test('a due timer is delivered once through the Router background port with a stable trigger identity', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)

  // Not yet due: nothing is delivered and nothing is scanned into a delivery.
  assert.deepEqual(await f.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 0)

  f.setNow(T0 + 60_000)
  assert.deepEqual(await f.timers.tick(), { due: 1, fired: 1, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 1)
  const call = f.calls[0]
  // The stable identity of this occurrence — what the Router dedupes on.
  assert.equal(call.triggerRef, TIMER_TRIGGER_PREFIX + timer.id + ':1')
  assert.equal(call.triggerRef, 'timer:' + timer.id + ':1')
  assert.equal(call.ownerId, 'repo-DSH')
  assert.equal(call.message, '跟进：检查 #40 的定时器是否已落地')
  assert.deepEqual(call.source, {
    kind: 'timer', timerId: timer.id, occurrenceId: '1', fireAt: at(T0 + 60_000), late: false,
  })
  // 票面权威: the creator and the creation moment ARE the authorization; the source must match the kind or
  // the real Router rejects the request as an invalid background source.
  assert.deepEqual(call.authorization, { actor: 'user:l1', source: 'timer', at: at(T0) })

  const stored = f.timers.get(timer.id)
  assert.equal(stored.status, 'fired')
  assert.equal(stored.firedAt, at(T0 + 60_000))
  assert.equal(stored.late, false)
  assert.equal(stored.attempts, 1)
  assert.equal(stored.delivery.state, 'sent')
  assert.equal(stored.delivery.triggerRef, call.triggerRef)
  assert.equal(stored.delivery.ticketId, 'tsk-1')
  assert.equal(stored.nextAttemptAt, null)

  // Repeated ticks never inject a second time, and never even re-read a terminal row.
  f.advance(5_000)
  assert.deepEqual(await f.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 1)
})

test('repeated and concurrent ticks retry the same occurrence and inject it exactly once', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)

  // Concurrent ticks collapse into one single-flight pass, so one occurrence cannot be admitted twice.
  const first = f.timers.tick()
  const second = f.timers.tick()
  assert.equal(first, second, 'a concurrent tick must join the in-flight pass instead of starting another')
  const results = await Promise.all([first, second])
  assert.deepEqual(results[0], { due: 1, fired: 1, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 1)

  // Sequential retries after completion are no-ops, and the trigger identity never changes.
  for (let i = 0; i < 3; i++) await f.timers.tick()
  assert.equal(f.calls.length, 1)
  assert.equal(new Set(f.calls.map(call => call.triggerRef)).size, 1)
  assert.equal(f.timers.get(timer.id).status, 'fired')
  assert.equal(f.tickets.size, 1)
})

test('a crash between persisting the intent and delivering is retried with the same triggerRef', async t => {
  // The first delivery dies (the process was killed mid-call); the persisted 'firing' row is the retry ledger.
  let fail = true
  const f = fixture({
    route: async (request, n) => {
      if (fail) { fail = false; const error = new Error('host went away'); error.code = 'session-create-empty'; throw error }
      return { ownerId: request.ownerId, ticketId: 'tsk-retry', requestId: 'req-retry', deduped: false, stage: 'working' }
    },
  })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)

  assert.deepEqual(await f.timers.tick(), { due: 1, fired: 0, retried: 1, failed: 0, skipped: 0 })
  const retried = f.timers.get(timer.id)
  assert.equal(retried.status, 'pending', 'a transient delivery failure returns the timer to pending, it does not lose the follow-up')
  assert.equal(retried.delivery.state, 'queued')
  assert.equal(retried.lastError.code, 'session-create-empty')
  assert.equal(retried.nextAttemptAt, at(T0 + 60_000 + 2_000))

  // Backoff keeps the 1s tick from hot-spinning on a broken host: the row is still due, but this pass skips it.
  assert.deepEqual(await f.timers.tick(), { due: 1, fired: 0, retried: 0, failed: 0, skipped: 1 })
  assert.equal(f.calls.length, 1)

  f.setNow(T0 + 60_000 + LATE_GRACE_MS + 2_000)
  assert.deepEqual(await f.timers.tick(), { due: 1, fired: 1, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1], f.calls[0], 'the retry carries the original occurrence, authorization, and source timing')
  const fired = f.timers.get(timer.id)
  assert.equal(fired.status, 'fired')
  assert.equal(fired.firedAt, at(T0 + 60_000))
  assert.equal(fired.delivery.at, at(T0 + 60_000))
  assert.equal(fired.late, false)
  assert.equal(fired.lateMs, 0)
})

test('a structurally invalid target fails the timer instead of retrying forever', async t => {
  const f = fixture({
    route: async () => { const error = new Error('unknown owner'); error.code = 'unknown-owner'; throw error },
  })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)
  assert.deepEqual(await f.timers.tick(), { due: 1, fired: 0, retried: 0, failed: 1, skipped: 0 })
  const stored = f.timers.get(timer.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.delivery.state, 'failed')
  assert.equal(stored.nextAttemptAt, null)
  assert.equal(stored.lastError.code, 'unknown-owner')
  // A failed row leaves the due scan, so it cannot hot-spin.
  assert.deepEqual(await f.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 1)
})

test('lateness is measured against the real due instant, not hardcoded', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const onTime = schedule(f.timers)
  // Tick jitter (the host ticks every second) is not lateness.
  f.setNow(T0 + 60_000 + LATE_GRACE_MS)
  await f.timers.tick()
  assert.equal(f.calls[0].source.late, false)
  assert.equal(f.calls[0].source.occurrenceId, '1')
  assert.equal(f.timers.get(onTime.id).late, false)

  // A follow-up whose instant was genuinely missed while the host was down IS late, and says by how much.
  const g = fixture()
  t.after(() => g.cleanup())
  const missed = schedule(g.timers)
  g.setNow(T0 + 60_000 + 10 * 60_000)
  await g.timers.tick()
  assert.equal(g.calls[0].source.late, true)
  assert.equal(g.calls[0].source.fireAt, at(T0 + 60_000))
  const stored = g.timers.get(missed.id)
  assert.equal(stored.late, true)
  assert.equal(stored.lateMs, 10 * 60_000)
  assert.equal(stored.status, 'fired')
})

test('a pending one-shot survives downtime and fires once, late, after reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-timers-'))
  const before = fixture({ dir })
  const timer = schedule(before.timers)
  before.closeOnly()

  // Host was down across the fireAt; a new process opens the same database and runs its normal tick.
  const after = fixture({ dir, startAt: T0 + 60_000 + 30 * 60_000 })
  t.after(() => after.cleanup())
  assert.equal(after.timers.list().length, 1, 'the pending timer must be restored from disk, not lost with the process')
  assert.deepEqual(await after.timers.tick(), { due: 1, fired: 1, retried: 0, failed: 0, skipped: 0 })
  assert.equal(after.calls.length, 1)
  assert.equal(after.calls[0].triggerRef, 'timer:' + timer.id + ':1')
  assert.equal(after.calls[0].source.late, true)
  assert.equal(after.timers.get(timer.id).status, 'fired')

  // A second reopen must not replay the occurrence that already fired.
  after.closeOnly()
  const third = fixture({ dir, startAt: T0 + 60_000 + 60 * 60_000 })
  t.after(() => third.cleanup())
  assert.deepEqual(await third.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(third.calls.length, 0)
  assert.equal(third.timers.get(timer.id).status, 'fired')
})

test('resuming an overdue follow-up catches up its original occurrence once', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers, { fireAt: at(T0 + 600_000) })

  f.setNow(T0 + 240_000)
  const paused = f.timers.pause(timer.id)
  assert.equal(paused.changed, true)
  assert.equal(paused.timer.status, 'paused')
  assert.equal(paused.timer.remainingMs, 360_000)
  assert.equal(f.timers.pause(timer.id).changed, false)

  f.setNow(T0 + 20 * 60_000)
  await f.timers.tick()
  assert.equal(f.calls.length, 0)

  const resumed = f.timers.resume(timer.id)
  assert.equal(resumed.changed, true)
  assert.equal(resumed.timer.status, 'pending')
  assert.equal(resumed.timer.fireAt, timer.fireAt)
  assert.equal(resumed.timer.occurrenceId, '1')
  await f.timers.tick()
  await f.timers.tick()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].triggerRef, 'timer:' + timer.id + ':1')
  assert.equal(f.calls[0].source.late, true)
})

test('cancel stops every later wake and keeps the row for the human to see', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  // A second timer that is paused before the clock moves, so its fireAt is still in the future when created.
  const pausedTimer = schedule(f.timers, { fireAt: at(T0 + 120_000) })
  f.timers.pause(pausedTimer.id)

  const cancelled = f.timers.cancel(timer.id)
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.timer.status, 'cancelled')
  assert.equal(cancelled.timer.cancelledAt, at(T0))
  assert.equal(f.timers.cancel(timer.id).changed, false)

  // Far past both original instants: a cancelled one-shot must never wake, and never schedule a second occurrence.
  f.setNow(T0 + 60 * 60_000)
  assert.deepEqual(await f.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 0)
  // Still listable — cancel is a state, not a delete.
  assert.equal(f.timers.list({ ownerId: 'repo-DSH' }).length, 2)
  assert.equal(f.timers.get(timer.id).status, 'cancelled')

  // Cancelling a paused timer also stops it, and leaves no pending wake behind.
  assert.equal(f.timers.cancel(pausedTimer.id).changed, true)
  assert.equal(f.timers.get(pausedTimer.id).status, 'cancelled')
  assert.deepEqual(await f.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(f.calls.length, 0)
})

test('cancel during an executing delivery never retries and never spawns another run', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let admitted = 0
  const f = fixture({
    route: async request => {
      admitted++
      await gate
      return { ownerId: request.ownerId, ticketId: 'tsk-running', requestId: 'req-running', deduped: false, stage: 'working', admitted: true }
    },
  })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)

  const firing = f.timers.tick()
  // The delivery is in flight and the row is already 'firing' — the run has been admitted by the Router.
  await Promise.resolve()
  assert.equal(f.timers.get(timer.id).status, 'firing')
  const cancelled = f.timers.cancel(timer.id)
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.timer.cancelRequestedDuringFire, true)

  release()
  assert.deepEqual(await firing, { due: 1, fired: 1, retried: 0, failed: 0, skipped: 0 })
  // The already-executing run is NOT terminated (that is a separate explicit action)…
  assert.equal(admitted, 1)
  // …but the record stays cancelled, so no later wake is ever scheduled from this row.
  const stored = f.timers.get(timer.id)
  assert.equal(stored.status, 'cancelled')
  assert.equal(stored.delivery.state, 'sent')

  f.setNow(T0 + 600_000)
  assert.deepEqual(await f.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(admitted, 1)
})

test('a timer that already fired cannot be cancelled retroactively', t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)
  return f.timers.tick().then(() => {
    const result = f.timers.cancel(timer.id)
    assert.equal(result.changed, false)
    assert.equal(result.alreadyFired, true)
    assert.equal(result.timer.status, 'fired')
  })
})

test('pause, resume and cancel refuse unknown ids and impossible states', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const missing = error => error instanceof TimerError && error.code === 'timer-not-found'
  assert.throws(() => f.timers.pause('tmr-nope'), missing)
  assert.throws(() => f.timers.resume('tmr-nope'), missing)
  assert.throws(() => f.timers.cancel('tmr-nope'), missing)
  assert.equal(f.timers.get('tmr-nope'), undefined)

  const timer = schedule(f.timers)
  // A pending timer is already armed, so resume is a no-op rather than an error.
  assert.equal(f.timers.resume(timer.id).changed, false)
  assert.equal(f.timers.resume(timer.id).timer.status, 'pending')
  f.setNow(T0 + 60_000)
  await f.timers.tick()
  assert.throws(() => f.timers.pause(timer.id),
    error => error instanceof TimerError && error.code === 'timer-not-pausable')
  assert.throws(() => f.timers.resume(timer.id),
    error => error instanceof TimerError && error.code === 'timer-not-resumable')
})

test('list scopes by owner and reports the computed remaining time', t => {
  const f = fixture()
  t.after(() => f.cleanup())
  // All three share the SAME createdAt (the clock is still at T0), so this pins the insertion-order tiebreak:
  // sorting on the random `id` instead would shuffle them.
  const mine = schedule(f.timers, { fireAt: at(T0 + 60_000) })
  const other = schedule(f.timers, { ownerId: 'repo-Other', createdBy: 'user:l2', fireAt: at(T0 + 120_000) })
  const paused = schedule(f.timers, { fireAt: at(T0 + 180_000) })
  f.setNow(T0 + 30_000)
  f.timers.pause(paused.id)

  const all = f.timers.list()
  assert.deepEqual(all.map(timer => timer.id), [mine.id, other.id, paused.id])
  assert.deepEqual(all.map(timer => timer.remainingMs), [30_000, 90_000, 150_000])

  const scoped = f.timers.list({ ownerId: 'repo-Other' })
  assert.deepEqual(scoped.map(timer => timer.id), [other.id])
  assert.equal(scoped[0].createdBy, 'user:l2')
  assert.deepEqual(f.timers.list({ ownerId: 'repo-Nobody' }), [])
})

test('the constructor refuses to run without the Router port, the clock or owner lookup', t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const noPort = () => new TimerService({ store: f.store, getOwner: id => OWNERS[id], now: () => T0 })
  assert.throws(noPort, error => error instanceof TimerError && error.code === 'route-background-required')
  assert.throws(() => new TimerService({ store: f.store, routeBackground: async () => {}, now: () => T0 }),
    error => error instanceof TimerError && error.code === 'get-owner-required')
  // `now` defaults to Date.now, so the clock is only invalid when a non-function is passed explicitly.
  assert.throws(() => new TimerService({ store: f.store, getOwner: id => OWNERS[id], routeBackground: async () => {}, now: null }),
    error => error instanceof TimerError && error.code === 'clock-required')
  assert.throws(() => new TimerService({ getOwner: id => OWNERS[id], routeBackground: async () => {} }),
    error => error instanceof TimerError && error.code === 'store-required')
  assert.throws(() => new TimerService({ store: f.store, getOwner: id => OWNERS[id], routeBackground: async () => {}, lateGraceMs: -1 }),
    error => error instanceof TimerError && error.code === 'late-grace-invalid')
})

test('a timer cancelled while an earlier due timer is firing never submits work', async t => {
  const entered = Promise.withResolvers()
  const released = Promise.withResolvers()
  const f = fixture({ route: async (request, count) => {
    if (count === 1) { entered.resolve(); await released.promise }
    return { ownerId: request.ownerId, ticketId: 'tsk-' + count, stage: 'working', admitted: true }
  } })
  t.after(() => f.cleanup())
  schedule(f.timers)
  const later = schedule(f.timers, { fireAt: at(T0 + 60_001) })
  f.setNow(T0 + 62_000)
  const pulse = f.timers.tick()
  try {
    await entered.promise
    f.timers.cancel(later.id)
  } finally { released.resolve(); await pulse }
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.get(later.id).status, 'cancelled')
})

test('a queued timer occurrence records its ticket without claiming Session delivery', async t => {
  const f = fixture({ route: async () => ({ ticketId: 'tsk-at-capacity', stage: 'queued', admitted: false }) })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)
  await f.timers.tick()
  const saved = f.timers.get(timer.id)
  assert.equal(saved.status, 'fired')
  assert.equal(saved.delivery.ticketId, 'tsk-at-capacity')
  assert.equal(saved.delivery.state, 'queued')
  assert.equal(saved.delivery.sentAt ?? null, null)
  await f.timers.tick()
  assert.equal(f.calls.length, 1)
})

test('only the current persisted occurrence may deliver the initial prompt', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const workerSession = { sessionId: 'session-worker', cwd: '/tmp/repo-DSH' }
  let stage = 'queued'
  const f = fixture({
    getTicket: id => id === 'tsk-queued' ? { stage, workerSession } : undefined,
    route: async request => {
      entered.resolve(request)
      await release.promise
      return { ticketId: 'tsk-queued', stage: 'queued', admitted: false }
    },
  })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  const triggerRef = 'timer:' + timer.id + ':1'
  assert.equal(f.timers.canDeliver(timer.id, triggerRef), false)

  f.setNow(T0 + 60_000)
  const pulse = f.timers.tick()
  try {
    const request = await entered.promise
    assert.equal(request.triggerRef, triggerRef)
    assert.equal(f.timers.canDeliver(timer.id, triggerRef), true)
    assert.equal(f.timers.canDeliver(timer.id, 'timer:' + timer.id + ':2'), false)
    assert.equal(f.timers.canDeliver('tmr-missing', triggerRef), false)
    assert.equal(f.timers.canDeliver(timer.id, undefined), false)
  } finally {
    release.resolve()
    await pulse
  }
  stage = 'working'
  assert.equal(f.timers.canDeliver(timer.id, triggerRef), true, 'a worker binding can precede the initial prompt')
  assert.deepEqual(f.timers.get(timer.id).delivery.workerSession, workerSession)
  const cancelled = f.timers.cancel(timer.id)
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.timer.status, 'cancelled')
  assert.equal(cancelled.timer.delivery.state, 'cancelled')
  assert.equal(cancelled.timer.delivery.ticketId, 'tsk-queued')
  assert.equal(cancelled.timer.delivery.sentAt ?? null, null)
  stage = 'failed'
  assert.equal(f.timers.get(timer.id).delivery.state, 'cancelled')
  assert.equal(f.timers.canDeliver(timer.id, triggerRef), false)
})

test('a timer forwards only the saved identity of its optional Feishu origin', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const source = { kind: 'feishu', triggerId: 'trg-original', chatId: 'oc-original', actor: 'ou-sender' }
  const input = { ...source, message: 'incoming message' }
  const timer = schedule(f.timers, { origin: input })
  input.chatId = 'oc-other'
  const pending = f.timers.get(timer.id)
  assert.deepEqual(pending.origin, source)
  assert.equal(pending.createdBy, 'user:l1')
  assert.throws(() => schedule(f.timers, { origin: { ...source, actor: '' } }),
    error => error instanceof TimerError && error.code === 'timer-origin-invalid')

  f.setNow(T0 + 60_000)
  await f.timers.tick()
  assert.deepEqual(f.calls[0].source.origin, source)
  assert.equal(f.calls[0].authorization.actor, 'user:l1')
})

test('ticket evidence protects the original sent receipt from later cancellation or failure', async t => {
  const workerSession = { sessionId: 'session-worker', cwd: '/tmp/repo-DSH' }
  const ticket = { stage: 'queued' }
  const f = fixture({
    getTicket: () => ticket,
    route: async () => ({ ticketId: 'tsk-worker', stage: 'queued', admitted: false }),
  })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)
  await f.timers.tick()

  const sentAt = at(T0 + 61_000)
  Object.assign(ticket, { stage: 'working', workerSession, lastDelivery: { state: 'sent', at: sentAt } })
  assert.equal(f.timers.canDeliver(timer.id, f.calls[0].triggerRef), false)
  const result = f.timers.cancel(timer.id)
  assert.equal(result.changed, false)
  assert.equal(result.alreadyFired, true)
  assert.equal(result.timer.delivery.state, 'sent')
  assert.equal(result.timer.delivery.sentAt, sentAt)
  assert.deepEqual(result.timer.delivery.workerSession, workerSession)

  ticket.stage = 'failed'
  const later = f.timers.list()[0].delivery
  assert.equal(later.stage, 'failed')
  assert.equal(later.state, 'sent')
  assert.equal(later.sentAt, sentAt)
})

test('reopen finds a sent ticket before the timer recorded its Router receipt', async t => {
  const f = fixture({ route: async ({ triggerRef }) => {
    const ticket = {
      id: 'tsk-sent-before-stop', triggerId: triggerRef, stage: 'working',
      background: { kind: 'timer', timerId: timer.id },
      workerSession: { sessionId: 'session-worker', cwd: '/tmp/repo-DSH' },
      lastDelivery: { state: 'sent', at: at(T0 + 60_000) },
    }
    f.store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
    f.closeOnly()
    return { ticketId: ticket.id, stage: ticket.stage, admitted: true }
  } })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers)
  f.setNow(T0 + 60_000)
  await f.timers.tick()

  const reopened = fixture({ dir: f.stateDir, startAt: T0 + 120_000 })
  t.after(() => reopened.cleanup())
  const result = reopened.timers.cancel(timer.id)
  assert.equal(result.changed, false)
  assert.equal(result.alreadyFired, true)
  assert.equal(result.timer.delivery.state, 'sent')
  assert.equal(result.timer.delivery.ticketId, 'tsk-sent-before-stop')
  assert.equal(reopened.timers.canDeliver(timer.id, f.calls[0].triggerRef), false)
  await reopened.timers.tick()
  assert.equal(reopened.calls.length, 0)
  assert.equal(reopened.timers.get(timer.id).status, 'fired')
})
