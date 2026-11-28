/**
 * TimerService tests for durable one-shot and recurring timers.
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

test('daily creation stores the first Shanghai occurrence across local midnight', t => {
  // 23:59 Sunday in Shanghai, still Sunday afternoon in UTC.
  const f = fixture({ startAt: Date.parse('2026-11-15T15:59:00Z') })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '00:01' },
  })
  assert.deepEqual(timer.schedule, { frequency: 'daily', time: '00:01', timeZone: 'Asia/Shanghai' })
  assert.equal(timer.fireAt, '2026-11-15T16:01:00.000Z')
  assert.equal(timer.occurrenceId, '1')
  assert.equal(timer.remainingMs, 120_000)
  assert.deepEqual(f.timers.get(timer.id), timer)
})

test('weekly downtime catches up only the latest Shanghai occurrence', async t => {
  const before = fixture({ startAt: Date.parse('2026-11-15T15:59:00Z') })
  t.after(() => before.cleanup())
  const timer = before.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Weekly follow-up',
    schedule: { frequency: 'weekly', weekday: 1, time: '00:10' },
  })
  assert.equal(timer.fireAt, '2026-11-15T16:10:00.000Z')
  before.closeOnly()

  const f = fixture({ dir: before.stateDir, startAt: Date.parse('2026-12-08T00:00:00Z') })
  t.after(() => f.closeOnly())
  await Promise.all([f.timers.tick(), f.timers.tick(), f.timers.tick()])
  await f.timers.tick()
  assert.deepEqual(f.calls.map(call => call.source), [{
    kind: 'timer', timerId: timer.id, occurrenceId: '4', fireAt: '2026-12-06T16:10:00.000Z', late: true,
  }])
  assert.equal(f.calls[0].triggerRef, `timer:${timer.id}:4`)
  assert.equal(f.timers.get(timer.id).status, 'pending')
  assert.equal(f.timers.get(timer.id).fireAt, '2026-12-13T16:10:00.000Z')
  assert.equal(f.timers.get(timer.id).occurrenceId, '5')

  f.setNow(Date.parse('2026-12-13T16:10:00Z'))
  await f.timers.tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].triggerRef, `timer:${timer.id}:5`)
  assert.equal(f.calls[1].source.late, false)
  assert.equal(f.timers.get(timer.id).fireAt, '2026-12-20T16:10:00.000Z')
})

test('a single recurring slot missed during short downtime fires once and is late', async t => {
  const before = fixture()
  t.after(() => before.cleanup())
  const timer = before.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  before.closeOnly()
  const reopened = fixture({ dir: before.stateDir, startAt: Date.parse('2026-11-15T00:01:05Z') })
  t.after(() => reopened.closeOnly())
  await reopened.timers.tick()
  await reopened.timers.tick()
  assert.deepEqual(reopened.calls.map(call => call.source), [{
    kind: 'timer', timerId: timer.id, occurrenceId: '1', fireAt: '2026-11-15T00:01:00.000Z', late: true,
  }])
  assert.equal(reopened.timers.get(timer.id).fireAt, '2026-11-16T00:01:00.000Z')
})

test('a later occurrence preserves an earlier queued receipt across restart', async t => {
  const f = fixture({ route: async (_request, count) => ({ ticketId: `tsk-${count}`, stage: 'queued', admitted: false }) })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  await f.timers.tick()
  const first = f.calls[0].triggerRef
  assert.equal(f.timers.canDeliver(timer.id, first), true)

  f.setNow(Date.parse('2026-11-16T00:01:00Z'))
  await f.timers.tick()
  const second = f.calls[1].triggerRef
  assert.notEqual(first, second)
  assert.equal(f.timers.get(timer.id).delivery.ticketId, 'tsk-2')
  assert.equal(f.timers.canDeliver(timer.id, first), true)
  f.closeOnly()

  const reopened = fixture({ dir: f.stateDir, startAt: f.now() })
  t.after(() => reopened.closeOnly())
  assert.equal(reopened.timers.deliveryState(timer.id, first), 'ready')
  assert.equal(reopened.timers.deliveryState(timer.id, second), 'ready')
  assert.equal(reopened.timers.deliveryState(timer.id, `timer:${timer.id}:3`), 'closed')
  assert.equal(reopened.timers.get(timer.id).fireAt, '2026-11-17T00:01:00.000Z')
  await reopened.timers.tick()
  assert.equal(reopened.calls.length, 0)
})

test('cancelling a recurring timer after host admission keeps the sent receipt and stops later wakes', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  await f.timers.tick()
  const receipt = f.timers.get(timer.id).delivery
  assert.equal(receipt.state, 'sent')

  const result = f.timers.cancel(timer.id)
  assert.equal(result.changed, true)
  assert.equal(result.timer.status, 'cancelled')
  assert.deepEqual(result.timer.delivery, receipt)
  assert.equal(f.timers.deliveryState(timer.id, receipt.triggerRef), 'closed')
  f.setNow(Date.parse('2026-11-20T00:01:00Z'))
  await f.timers.tick()
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.cancel(timer.id).changed, false)
})

test('pausing suspends queued recurring work and resume catches up only the latest day', async t => {
  const f = fixture({ route: async (_request, count) => ({ ticketId: `tsk-${count}`, stage: 'queued', admitted: false }) })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  await f.timers.tick()
  const first = f.calls[0].triggerRef
  assert.equal(f.timers.pause(timer.id).timer.fireAt, '2026-11-16T00:01:00.000Z')
  assert.equal(f.timers.deliveryState(timer.id, first), 'paused')
  assert.equal(f.timers.canDeliver(timer.id, first), false)
  f.setNow(Date.parse('2026-11-18T00:01:30Z'))
  await f.timers.tick()
  assert.equal(f.calls.length, 1)

  assert.equal(f.timers.resume(timer.id).changed, true)
  assert.equal(f.timers.deliveryState(timer.id, first), 'ready')
  await f.timers.tick()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].source, {
    kind: 'timer', timerId: timer.id, occurrenceId: '4', fireAt: '2026-11-18T00:01:00.000Z', late: true,
  })
  assert.equal(f.timers.get(timer.id).fireAt, '2026-11-19T00:01:00.000Z')
  const second = f.calls[1].triggerRef
  assert.equal(f.timers.deliveryState(timer.id, first), 'ready')
  assert.equal(f.timers.deliveryState(timer.id, second), 'ready')

  const cancelled = f.timers.cancel(timer.id)
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.timer.delivery.state, 'cancelled')
  assert.equal(f.timers.deliveryState(timer.id, first), 'closed')
  assert.equal(f.timers.deliveryState(timer.id, second), 'closed')
})

test('weekly creation defaults to the Shanghai weekday and validates the timing inputs', t => {
  // This is Monday in Shanghai. Creation at the scheduled instant chooses next Monday.
  const f = fixture({ startAt: Date.parse('2026-11-15T16:10:00Z') })
  t.after(() => f.cleanup())
  const request = { ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Weekly follow-up' }
  const schedule = { frequency: 'weekly', time: '00:10' }
  const timer = f.timers.create({ ...request, schedule })
  assert.deepEqual(timer.schedule, { ...schedule, timeZone: 'Asia/Shanghai', weekday: 1 })
  assert.equal(timer.fireAt, '2026-11-22T16:10:00.000Z')
  const bad = (timing, code) => assert.throws(() => f.timers.create({ ...request, ...timing }),
    error => error instanceof TimerError && error.code === code)
  bad({}, 'fire-at-required')
  bad({ fireAt: '2026-11-17T00:00:00Z', schedule }, 'timer-schedule-conflict')
  bad({ schedule: { ...schedule, timeZone: 'UTC' } }, 'timer-schedule-invalid')
  bad({ schedule: null }, 'timer-schedule-invalid')
  bad({ schedule: { ...schedule, frequency: 'monthly' } }, 'timer-schedule-frequency')
  bad({ schedule: { ...schedule, time: '24:00' } }, 'timer-schedule-time')
  bad({ schedule: { ...schedule, time: '8:00' } }, 'timer-schedule-time')
  bad({ schedule: { ...schedule, weekday: 0 } }, 'timer-schedule-weekday')
  bad({ schedule: { ...schedule, weekday: '1' } }, 'timer-schedule-weekday')
  bad({ schedule: { ...schedule, frequency: 'daily', weekday: 1 } }, 'timer-schedule-weekday')
  assert.equal(f.timers.list().length, 1)
})

test('a recurring retry keeps its original occurrence and Feishu authorization across downtime', async t => {
  const before = fixture({ route: async () => { throw new Error('temporarily unavailable') } })
  t.after(() => before.cleanup())
  const origin = { kind: 'feishu', triggerId: 'trg-original', chatId: 'oc-original', actor: 'ou-sender' }
  const authorization = { actor: 'ou-sender', source: 'feishu', at: '2026-11-15T07:55:00+08:00', addressing: 'mention' }
  const timer = before.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up', origin, authorization,
    schedule: { frequency: 'daily', time: '08:01' },
  })
  before.setNow(Date.parse('2026-11-15T00:01:00Z'))
  assert.equal((await before.timers.tick()).retried, 1)
  const initial = before.calls[0]
  assert.equal(initial.triggerRef, `timer:${timer.id}:1`)
  assert.equal(initial.source.late, false)
  before.closeOnly()

  const f = fixture({ dir: before.stateDir, startAt: Date.parse('2026-11-20T00:01:15Z') })
  t.after(() => f.closeOnly())
  assert.equal(f.timers.get(timer.id).createdBy, 'user:l1')
  await f.timers.tick()
  assert.deepEqual(f.calls[0], initial)
  await f.timers.tick()
  await f.timers.tick()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].source, {
    kind: 'timer', timerId: timer.id, occurrenceId: '6', fireAt: '2026-11-20T00:01:00.000Z', late: true, origin,
  })
  assert.deepEqual(f.calls[1].authorization, authorization)
  assert.equal(f.timers.get(timer.id).fireAt, '2026-11-21T00:01:00.000Z')
})

test('a crash after host admission settles the original occurrence before catching up', async t => {
  const f = fixture({ route: async ({ source, triggerRef }) => {
    const ticket = {
      id: 'tsk-sent-before-stop', triggerId: triggerRef, stage: 'working',
      background: { kind: 'timer', timerId: source.timerId },
      workerSession: { sessionId: 'session-worker', cwd: '/tmp/repo-DSH' },
      lastDelivery: { state: 'sent', at: '2026-11-15T00:01:00.000Z' },
    }
    f.store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
    f.closeOnly()
    return { ticketId: ticket.id, stage: ticket.stage, admitted: true }
  } })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  await f.timers.tick()
  const first = f.calls[0].triggerRef

  const reopened = fixture({ dir: f.stateDir, startAt: Date.parse('2026-11-18T00:02:00Z') })
  t.after(() => reopened.closeOnly())
  assert.equal(reopened.timers.deliveryState(timer.id, first), 'closed')
  await reopened.timers.tick()
  assert.equal(reopened.calls.length, 0)
  const recovered = reopened.timers.get(timer.id)
  assert.equal(recovered.delivery.ticketId, 'tsk-sent-before-stop')
  assert.equal(recovered.delivery.triggerRef, first)
  assert.equal(recovered.delivery.state, 'sent')
  assert.equal(recovered.delivery.workerSession.sessionId, 'session-worker')
  assert.equal(recovered.fireAt, '2026-11-16T00:01:00.000Z')

  await reopened.timers.tick()
  await reopened.timers.tick()
  assert.deepEqual(reopened.calls.map(call => call.triggerRef), [`timer:${timer.id}:4`])
  assert.equal(reopened.calls[0].source.fireAt, '2026-11-18T00:01:00.000Z')
  assert.equal(reopened.timers.get(timer.id).fireAt, '2026-11-19T00:01:00.000Z')
})

test('recurring cancellation during admission preserves a host receipt returned afterward', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const f = fixture({ route: async request => {
    entered.resolve(request)
    await release.promise
    return { ticketId: 'tsk-host-admitted', stage: 'working', admitted: true }
  } })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  const pulse = f.timers.tick()
  try {
    const { triggerRef } = await entered.promise
    assert.equal(f.timers.deliveryState(timer.id, triggerRef), 'ready')
    assert.equal(f.timers.cancel(timer.id).changed, true)
    assert.equal(f.timers.deliveryState(timer.id, triggerRef), 'closed')
  } finally {
    release.resolve()
    await pulse
  }
  const saved = f.timers.get(timer.id)
  assert.equal(saved.status, 'cancelled')
  assert.equal(saved.delivery.state, 'sent')
  assert.equal(saved.delivery.ticketId, 'tsk-host-admitted')
  f.setNow(Date.parse('2026-11-17T00:01:00Z'))
  await f.timers.tick()
  assert.equal(f.calls.length, 1)
})

test('a later permanent scheduling error leaves an older Router receipt eligible', async t => {
  const f = fixture({ route: async (_request, count) => {
    if (count === 2) throw Object.assign(new Error('later route refused'), { permanent: true })
    return { ticketId: 'tsk-queued', stage: 'queued', admitted: false }
  } })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  await f.timers.tick()
  f.setNow(Date.parse('2026-11-16T00:01:00Z'))
  await f.timers.tick()
  assert.equal(f.timers.get(timer.id).status, 'failed')
  assert.equal(f.timers.deliveryState(timer.id, f.calls[1].triggerRef), 'closed')
  assert.equal(f.timers.deliveryState(timer.id, f.calls[0].triggerRef), 'ready')
})

test('a terminal failed Router receipt advances a recurring timer to its next occurrence', async t => {
  const f = fixture({ route: async (_request, count) => count === 1
    ? { ticketId: 'tsk-failed', stage: 'failed', admitted: false }
    : { ticketId: 'tsk-sent', stage: 'working', admitted: true },
  })
  t.after(() => f.cleanup())
  const timer = f.timers.create({
    ownerId: 'repo-DSH', createdBy: 'user:l1', message: 'Daily follow-up',
    schedule: { frequency: 'daily', time: '08:01' },
  })
  f.setNow(Date.parse('2026-11-15T00:01:00Z'))
  await f.timers.tick()
  assert.equal(f.timers.get(timer.id).delivery.state, 'failed')
  assert.equal(f.timers.get(timer.id).fireAt, '2026-11-16T00:01:00.000Z')
  f.setNow(Date.parse('2026-11-16T00:01:00Z'))
  await f.timers.tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.timers.get(timer.id).delivery.state, 'sent')
})

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

test('an authorized L1 caller can schedule a one-shot that belongs to chief', async t => {
  const f = fixture({ authorizeCreate: ({ ownerId, createdBy }) => ownerId === 'chief' && createdBy === 'session-chief' })
  t.after(() => f.cleanup())
  const timer = schedule(f.timers, { ownerId: 'chief', createdBy: 'session-chief' })
  assert.equal(timer.ownerId, 'chief')
  assert.equal(timer.createdBy, 'session-chief')
  assert.throws(() => schedule(f.timers, { ownerId: 'chief', createdBy: 'agent:c-class' }),
    error => error instanceof TimerError && error.code === 'timer-create-unauthorized')

  f.setNow(T0 + 60_000)
  await f.timers.tick()
  assert.equal(f.calls[0].ownerId, 'chief')
  assert.equal(f.calls[0].authorization.actor, 'session-chief')
  assert.equal(f.timers.get(timer.id).status, 'fired')
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

test('a pending one-shot missed during short downtime fires once and is late after reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-timers-'))
  const before = fixture({ dir })
  const timer = schedule(before.timers)
  before.setNow(T0 + 59_200)
  before.closeOnly()

  // The host was down for 1.8 seconds and the reminder was due during that gap.
  const after = fixture({ dir, startAt: T0 + 61_000 })
  t.after(() => after.cleanup())
  assert.equal(after.timers.list().length, 1, 'the pending timer must be restored from disk, not lost with the process')
  assert.deepEqual(await after.timers.tick(), { due: 1, fired: 1, retried: 0, failed: 0, skipped: 0 })
  assert.equal(after.calls.length, 1)
  assert.equal(after.calls[0].triggerRef, 'timer:' + timer.id + ':1')
  assert.equal(after.calls[0].source.late, true)
  const fired = after.timers.get(timer.id)
  assert.equal(fired.status, 'fired')
  assert.equal(fired.late, true)
  assert.equal(fired.lateMs, 1_000)

  // A second reopen must not replay the occurrence that already fired.
  after.closeOnly()
  const third = fixture({ dir, startAt: T0 + 60_000 + 60 * 60_000 })
  t.after(() => third.cleanup())
  assert.deepEqual(await third.timers.tick(), { due: 0, fired: 0, retried: 0, failed: 0, skipped: 0 })
  assert.equal(third.calls.length, 0)
  assert.equal(third.timers.get(timer.id).status, 'fired')
})

test('resuming a briefly overdue follow-up catches up its original occurrence once and marks it late', async t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const timer = schedule(f.timers, { fireAt: at(T0 + 600_000) })

  f.setNow(T0 + 240_000)
  const paused = f.timers.pause(timer.id)
  assert.equal(paused.changed, true)
  assert.equal(paused.timer.status, 'paused')
  assert.equal(paused.timer.remainingMs, 360_000)
  assert.equal(f.timers.pause(timer.id).changed, false)

  f.setNow(T0 + 601_000)
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
  assert.equal(f.timers.get(timer.id).lateMs, 1_000)
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

test('only the persisted one-shot occurrence may deliver the initial prompt', async t => {
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

test('a Feishu reminder dispatches its original authorization after reopen and retry', async t => {
  const before = fixture()
  const origin = { kind: 'feishu', triggerId: 'trg-original', chatId: 'oc-original', actor: 'ou-sender' }
  const authorization = {
    actor: 'ou-sender', source: 'feishu', at: '2026-11-15T07:55:00+08:00',
    messageId: 'om-original', addressing: 'mention',
  }
  const timer = schedule(before.timers, { origin, authorization })
  before.closeOnly()

  const after = fixture({ dir: before.stateDir, startAt: T0 + 60_000, route: async (request, attempt) => {
    if (attempt === 1) throw new Error('temporary Router failure')
    return { ticketId: 'tsk-feishu-reminder', admitted: true }
  } })
  t.after(() => after.cleanup())
  const pending = after.timers.get(timer.id)
  assert.equal(pending.createdBy, 'user:l1')
  assert.equal(pending.createdAt, at(T0))
  assert.deepEqual(pending.authorization, authorization)

  await after.timers.tick()
  after.advance(2_000)
  await after.timers.tick()
  assert.equal(after.calls.length, 2)
  for (const request of after.calls) {
    assert.deepEqual(request.source.origin, origin)
    assert.deepEqual(request.authorization, authorization)
  }
})

test('stored Feishu authorization must match the origin and carry an absolute timestamp', t => {
  const f = fixture()
  t.after(() => f.cleanup())
  const origin = { kind: 'feishu', triggerId: 'trg-original', chatId: 'oc-original', actor: 'ou-sender' }
  const authorization = { actor: 'ou-sender', source: 'feishu', at: at(T0 - 60_000) }
  const bad = (input, message) => assert.throws(() => schedule(f.timers, input),
    error => error instanceof TimerError && error.code === 'timer-authorization-invalid', message)

  bad({ authorization }, 'requires the verified origin')
  bad({ origin, authorization: { ...authorization, actor: 'ou-other' } }, 'requires the exact actor')
  bad({ origin, authorization: { ...authorization, source: 'timer' } }, 'requires the Feishu source')
  bad({ origin, authorization: { ...authorization, at: '2026-11-14T23:59:00' } }, 'requires an explicit time zone')
  bad({ origin, authorization: { ...authorization, at: '2026-13-14T23:59:00Z' } }, 'requires a valid instant')
  bad({ origin, authorization: { ...authorization, at: '2026-02-30T23:59:00Z' } }, 'rejects an impossible calendar date')
  assert.deepEqual(f.timers.list(), [])
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
