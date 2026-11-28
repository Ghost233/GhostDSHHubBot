/**
 * S11 延迟确认登记 (issue #42): the deferred confirm / action / ask registry.
 *
 * These tests pin the contract the Router wires against — the six behaviours the ticket calls out by name:
 *  1. fixed expiration       — `expiresAt` is set ONCE (24h default, per-type overridable), can never be extended,
 *                              and a due request fails closed with a durable timeout outcome;
 *  2. duplicate answer       — an accepted action is executed at most once; a byte-identical retry is an
 *                              idempotent `{ duplicate: true, executed: false }`, never a second execution;
 *  3. mismatched actor       — only the recorded authority may decide; prose is never a decision; refusals are
 *                              durable and leave the request pending;
 *  4. missing destination    — an unfillable stored action fails closed without reaching the handler;
 *  5. stable worker          — the stored action target is never rewritten, and stays separate from the owner
 *                              binding recorded at request time;
 *  6. owner binding          — a recycled / deregistered / stale owner binding fails closed, the current one decides.
 *
 * Everything is faked: a temp SQLite store, a fixed clock, fake owner bindings and mock action handlers. No action
 * side effects exist — the "handler" only counts calls and echoes the request it was given.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { TaskBoard } from '../src/tasks.js'
import {
  DeferredError,
  DeferredRegistry,
  DEFERRED_DECISIONS,
  DEFERRED_STATUSES,
  DEFERRED_TTL_MS,
  DEFERRED_TYPES,
  actionNeedsTarget,
} from '../src/deferred.js'

/** The requester that opens every request in these tests (the authenticated human). */
const REQUESTER = { actor: 'user' }

/**
 * A temp store + TaskBoard + registry over one controllable clock.
 * `owners` is the fake live-binding port; `handlers` are mock executors.
 */
function fixture({ ttlMs, ttlByAction, handlers, owners } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-deferred-'))
  const store = new Store(dir)
  const clock = { at: '2026-11-15T00:00:00.000Z' }
  const now = () => clock.at
  const board = new TaskBoard({ store, now })
  const registry = new DeferredRegistry({ store, tasks: board, now, ttlMs, ttlByAction, handlers, owners })
  const seed = (stage = 'working', extra = {}) => {
    const ticket = {
      id: 'tsk-' + Math.random().toString(36).slice(2, 8), triggerId: 'trg-seed', owner: 'repo-W', stage, mechanism: 'inject',
      targetSession: 'session-owner', requestId: 'req-seed',
      authorization: { actor: 'user', source: 'dsh', at: '2026-11-14T00:00:00.000Z' },
      createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', ...extra,
    }
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
    return ticket
  }
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, board, registry, clock, seed, cleanup }
}

/** The canonical request facts for one seeded ticket; overrides pin the per-test variation. */
function facts(ticket, overrides = {}) {
  return {
    ticketId: ticket.id,
    ownerId: 'owner-A',
    requester: REQUESTER,
    source: { kind: 'dsh' },
    action: { type: 'fork' },
    target: { sessionId: 'sess-worker-1' },
    receiver: { ownerId: 'owner-A', sessionId: 'sess-owner-1' },
    ...overrides,
  }
}

/** Seeds a ticket and opens the standard fork confirmation on it (working → person/confirm). */
function openConfirm(env, { requestId, question = '确认 fork：新建会话并继续？', ...overrides } = {}) {
  const ticket = env.seed('working')
  const doc = env.registry.request({ requestId: requestId ?? 'dfr-' + ticket.id, ...facts(ticket, overrides), question })
  return { ticket, doc }
}

function askForAnswer(env, ticket = env.seed()) {
  const doc = env.registry.request({
    ...facts(ticket, { type: 'answer', action: { type: 'ask-user' }, target: null, receiver: { kind: 'owner', ownerId: 'owner-A' } }),
    question: '请提供编号',
  })
  return { ticket, input: { requestId: doc.requestId, decision: 'answer', text: 'A-123', actor: REQUESTER } }
}

test('module contract: the exported vocabulary and fail-closed constructor', () => {
  assert.deepEqual(DEFERRED_STATUSES, ['pending', 'answered', 'cancelled', 'expired'])
  assert.deepEqual(DEFERRED_DECISIONS, ['approve', 'reject', 'answer', 'cancel'])
  assert.deepEqual(DEFERRED_TYPES, ['confirm', 'answer'])
  assert.equal(DEFERRED_TTL_MS, 24 * 60 * 60 * 1000)
  assert.equal(actionNeedsTarget({ type: 'fork' }), true)
  assert.equal(actionNeedsTarget({ type: 'dangerous-inject' }), true)
  assert.equal(actionNeedsTarget({ type: 'dangerous-inject', entry: 'owner-inject' }), true)
  assert.equal(actionNeedsTarget({ type: 'anything-else' }), false)

  assert.throws(() => new DeferredRegistry({}), e => e instanceof DeferredError && e.code === 'store-required')
  const store = { get: () => undefined, set: () => {}, db: undefined }
  assert.throws(() => new DeferredRegistry({ store }), e => e.code === 'tasks-required')
  const registry = new DeferredRegistry({ store, tasks: {} })
  assert.throws(() => registry.setHandler('fork', 'not-a-function'), e => e.code === 'handler-invalid')
  assert.equal(registry.setHandler('fork', () => {}), registry, 'setHandler is chainable')
})

test('fixed expiration: expiry is fixed once, never extended, and a due request fails closed', async () => {
  const env = fixture({ ttlMs: 60_000, ttlByAction: { 'dangerous-inject': 3_600_000 } })
  try {
    const { ticket, doc } = openConfirm(env, { requestId: 'dfr-expiry' })
    assert.equal(doc.status, 'pending')
    assert.equal(doc.expiresAt, '2026-11-15T00:01:00.000Z', 'the default TTL is applied once, at request time')
    assert.equal(env.board.getTicket(ticket.id).stage, 'person/confirm', 'the question reached the ticket face')

    // 重复登记: identical facts are an idempotent no-op, expiry included.
    const again = env.registry.request({ requestId: 'dfr-expiry', ...facts(ticket) })
    assert.equal(again.expiresAt, doc.expiresAt)
    assert.equal(again.openedAt, doc.openedAt)

    // Per-type configuration: a dangerous injection gets its own fixed lifetime.
    const injectTicket = env.seed('working')
    const inject = env.registry.request({
      requestId: 'dfr-ttl',
      ...facts(injectTicket, { action: { type: 'dangerous-inject', entry: 'runner', message: 'rm -rf build' } }),
    })
    assert.equal(inject.expiresAt, '2026-11-15T01:00:00.000Z')

    // Expiry is fixed: a later re-request may not extend it.
    assert.throws(
      () => env.registry.request({ requestId: 'dfr-expiry', ...facts(ticket, { expiresAt: '2026-11-16T00:00:00.000Z' }) }),
      e => e.code === 'request-immutable',
    )
    assert.equal(env.registry.get('dfr-expiry').expiresAt, '2026-11-15T00:01:00.000Z', 'the stored expiry is untouched')
    assert.deepEqual(env.registry.get('dfr-expiry').refusals.map(r => r.kind), ['immutable-drift'])

    // An explicit expiry in the past is refused at request time — it can never be born dead.
    const fresh = env.seed('working')
    assert.throws(
      () => env.registry.request({ requestId: 'dfr-past', ...facts(fresh, { expiresAt: '2026-11-14T00:00:00.000Z' }) }),
      e => e.code === 'expires-at-invalid',
    )

    // Sweep closes the due request as expired and auto-cancels the ticket exactly like the legacy 24h sweep.
    env.clock.at = '2026-11-15T00:02:00.000Z'
    const expired = env.registry.sweep()
    assert.deepEqual(expired.map(d => d.requestId), ['dfr-expiry'])
    assert.equal(expired[0].status, 'expired')
    assert.equal(expired[0].outcome.kind, 'timeout')
    const face = env.board.getTicket(ticket.id)
    assert.equal(face.stage, 'done')
    assert.equal(face.confirmOutcome.kind, 'timeout')
    assert.equal(face.deferred.status, 'expired')
    assert.equal(env.registry.sweep().length, 0, 'sweep is idempotent')
    assert.deepEqual(env.registry.list({ status: 'pending' }).map(d => d.requestId), ['dfr-ttl'])
    assert.deepEqual(env.registry.pendingFor({ ticketId: ticket.id }), [])

    // A decision on an expired request fails closed with an informative code, never executes.
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-expiry', decision: 'approve', actor: REQUESTER }),
      e => e.code === 'request-expired',
    )
    assert.equal(env.registry.get('dfr-expiry').status, 'expired')
  } finally { env.cleanup() }
})

test('duplicate answer: an accepted action runs once and a repeat is an idempotent duplicate', async () => {
  let calls = 0
  const env = fixture({ handlers: { fork: async ({ request }) => { calls += 1; return { forked: request.target.sessionId } } } })
  try {
    const { ticket } = openConfirm(env, { requestId: 'dfr-dup' })
    const first = await env.registry.resolve({ requestId: 'dfr-dup', decision: 'approve', actor: REQUESTER })
    assert.equal(first.duplicate, false)
    assert.equal(first.executed, true)
    assert.equal(first.status, 'answered')
    assert.equal(first.outcome.decision, 'approve')
    assert.deepEqual(first.outcome.result, { forked: 'sess-worker-1' })
    assert.equal(calls, 1, 'the stored action ran exactly once')
    const face = env.board.getTicket(ticket.id)
    assert.equal(face.stage, 'working', 'the confirm landed on the ticket')
    assert.equal(face.confirmOutcome.kind, 'confirmed')
    assert.equal(face.deferred.status, 'fulfilled', 'the face mirrors the registry terminal status')

    // 重复投递不重复执行: the same decision by the same actor is an idempotent duplicate.
    const second = await env.registry.resolve({ requestId: 'dfr-dup', decision: 'approve', actor: REQUESTER })
    assert.equal(second.duplicate, true)
    assert.equal(second.executed, false)
    assert.equal(second.status, 'answered')
    assert.equal(calls, 1, 'a duplicate answer never re-runs the action')

    // A different decision on a closed request never reopens it.
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-dup', decision: 'reject', actor: REQUESTER }),
      e => e.code === 'request-closed',
    )
    assert.equal(calls, 1)
    assert.equal(env.registry.get('dfr-dup').status, 'answered')

    // markExecuted is idempotent for an action the registry already ran.
    assert.equal(env.registry.markExecuted('dfr-dup', { result: { again: true } }).duplicate, true)
  } finally { env.cleanup() }
})

test('approval is durable before dispatch and survives reopen and expiry while the handler waits', async () => {
  let calls = 0
  const { promise, resolve: finish } = Promise.withResolvers()
  const handler = async () => {
    calls += 1
    await promise
    return { ok: true }
  }
  const env = fixture({ ttlMs: 1000, handlers: { fork: handler } })
  const { doc, ticket } = openConfirm(env)
  const input = { requestId: doc.requestId, decision: 'approve', actor: REQUESTER }
  const resolving = env.registry.resolve(input)
  let reopened
  try {
    reopened = new Store(env.store.stateDir)
    const board = new TaskBoard({ store: reopened, now: () => env.clock.at })
    const registry = new DeferredRegistry({ store: reopened, tasks: board, now: () => env.clock.at, handlers: { fork: handler } })
    const stored = registry.get(doc.requestId)
    assert.equal(stored.status, 'answered')
    assert.equal(stored.outcome.kind, 'fulfillment-uncertain')
    assert.equal(stored.outcome.decision, 'approve')
    assert.deepEqual(board.getDeferred(ticket.id).outcome, stored.outcome)
    await assert.rejects(env.registry.resolve(input), { code: 'fulfillment-uncertain' })
    await assert.rejects(registry.resolve(input), { code: 'fulfillment-uncertain' })
    await assert.rejects(registry.resolve({ ...input, decision: 'cancel' }), { code: 'request-closed' })
    env.clock.at = '2026-11-15T00:00:02.000Z'
    assert.deepEqual(registry.sweep(), [])
    assert.equal(board.getTicket(ticket.id).stage, 'person/confirm')
    finish()
    const completed = await resolving
    assert.equal(completed.executed, true)
    assert.equal(calls, 1)
    assert.equal(board.getDeferred(ticket.id).status, 'fulfilled')
    assert.deepEqual(board.getDeferred(ticket.id).outcome, registry.get(doc.requestId).outcome)
    assert.equal((await registry.resolve(input)).duplicate, true)
    assert.equal(calls, 1)
  } finally {
    finish()
    await resolving.catch(() => {})
    reopened?.close()
    env.cleanup()
  }
})

test('a pending decision cannot authorize a later wait on the same ticket', async () => {
  let calls = 0
  const env = fixture({ handlers: { fork: () => { calls += 1 } } })
  try {
    const { doc, ticket } = openConfirm(env)
    env.board.resume(ticket.id)
    env.board.askConfirm({ ticketId: ticket.id, action: doc.action, question: '新的确认请求' })
    await assert.rejects(env.registry.resolve({ requestId: doc.requestId, decision: 'approve', actor: REQUESTER }), { code: 'stale-deferred' })
    assert.equal(calls, 0)
    assert.equal(env.registry.get(doc.requestId).status, 'cancelled')
    const face = env.board.getTicket(ticket.id)
    assert.equal(face.stage, 'person/confirm')
    assert.equal(face.pendingConfirm.text, '新的确认请求')
    assert.equal(face.deferred.outcome.refused, 'stale-deferred')
    const replacement = env.registry.request({ ...facts(ticket), question: '新的确认请求' })
    assert.equal(env.board.getTicket(ticket.id).deferred.requestId, replacement.requestId)
  } finally { env.cleanup() }
})

test('sweep expires an unanswered question and preserves a later wait on the same ticket', () => {
  const env = fixture({ ttlMs: 1000 })
  try {
    const question = '请提供审批编号'
    const openAnswer = ticket => env.registry.request({
      ...facts(ticket, { type: 'answer', action: { type: 'ask-user' }, target: null }), question,
    })
    const ticket = env.seed()
    const active = openAnswer(ticket)
    const advancedTicket = env.seed()
    const advanced = openAnswer(advancedTicket)
    env.board.resume(advancedTicket.id)
    env.board.ask({ ticketId: advancedTicket.id, question: '新的问题' })
    env.clock.at = active.expiresAt
    assert.deepEqual(new Set(env.registry.sweep().map(doc => doc.requestId)), new Set([active.requestId, advanced.requestId]))
    const face = env.board.getTicket(ticket.id)
    assert.equal(face.stage, 'blocked')
    assert.equal(face.deferred.status, 'expired')
    assert.match(env.board.summarize(ticket.id).detail, /过期/)
    assert.equal(face.transitions.at(-1).by, 'system')
    assert.equal(env.board.getTicket(advancedTicket.id).stage, 'person/answer')
    assert.equal(env.board.getTicket(advancedTicket.id).question.text, '新的问题')
    assert.deepEqual(env.registry.pendingFor({ ticketId: ticket.id }), [])
  } finally { env.cleanup() }
})

test('a trusted in-window receipt survives a delayed dequeue and sets the real acceptance time', async () => {
  const env = fixture({ ttlMs: 1000 })
  try {
    const accepted = openConfirm(env).doc
    const late = openConfirm(env).doc
    const expired = openConfirm(env).doc
    env.clock.at = '2026-11-15T00:00:02.000Z'
    const skipRequestIds = new Set([accepted.requestId, late.requestId])
    assert.deepEqual(env.registry.sweep({ skipRequestIds }).map(doc => doc.requestId), [expired.requestId])
    const input = { requestId: accepted.requestId, decision: 'approve', actor: REQUESTER }
    await assert.rejects(env.registry.resolve({ ...input, receivedAt: '2026-11-14T23:59:59.999Z' }), { code: 'receipt-invalid' })
    await assert.rejects(env.registry.resolve({ ...input, receivedAt: '2026-11-15T00:00:03.000Z' }), { code: 'receipt-invalid' })
    assert.equal(env.registry.get(accepted.requestId).status, 'pending')
    const result = await env.registry.resolve({ ...input, receivedAt: '2026-11-15T00:00:00.999Z' })
    assert.equal(result.request.decidedAt, env.clock.at)
    assert.equal(result.request.receivedAt, '2026-11-15T00:00:00.999Z')
    await assert.rejects(env.registry.resolve({ ...input, requestId: late.requestId, receivedAt: late.expiresAt }), { code: 'request-expired' })
    assert.equal(env.registry.get(late.requestId).status, 'expired')
  } finally { env.cleanup() }
})

test('registry write failures roll back phases and an unrecorded dispatch result cannot be retried', async () => {
  let calls = 0
  const env = fixture({ handlers: { fork: () => { calls += 1; return { dispatched: true } } } })
  const set = env.store.set.bind(env.store)
  let rejectWrite = () => true
  env.store.set = (key, value) => {
    if (rejectWrite(value)) throw new Error('fixture storage failure')
    set(key, value)
  }
  try {
    const ticket = env.seed()
    const factsForRequest = { ...facts(ticket), requestId: 'dfr-storage', question: '继续？' }
    const approve = () => env.registry.resolve({ requestId: 'dfr-storage', decision: 'approve', actor: REQUESTER })
    assert.throws(() => env.registry.request(factsForRequest), /fixture storage failure/)
    assert.equal(env.board.getTicket(ticket.id).stage, 'working')
    assert.equal(env.board.getDeferred(ticket.id), undefined)
    assert.equal(env.registry.get('dfr-storage'), undefined)

    rejectWrite = () => false
    env.registry.request(factsForRequest)
    rejectWrite = doc => doc.status === 'answered'
    await assert.rejects(approve(), /fixture storage failure/)
    assert.equal(env.registry.get('dfr-storage').status, 'pending')
    assert.equal(env.board.getDeferred(ticket.id).status, 'pending')
    assert.equal(calls, 0)

    rejectWrite = doc => doc.outcome?.executed === true
    await assert.rejects(approve(), /fixture storage failure/)
    assert.equal(calls, 1)
    const stored = env.registry.get('dfr-storage')
    assert.equal(stored.outcome.kind, 'fulfillment-uncertain')
    assert.equal(env.board.getTicket(ticket.id).stage, 'person/confirm')
    assert.deepEqual(env.board.getDeferred(ticket.id).outcome, stored.outcome)

    rejectWrite = () => false
    assert.throws(() => env.registry.markExecuted('dfr-storage'), { code: 'request-not-executable' })
    await assert.rejects(approve(), { code: 'fulfillment-uncertain' })
    assert.equal(calls, 1)
  } finally { env.cleanup() }
})

test('a copied pending request with a prior dispatch failure cannot dispatch on upgrade', async () => {
  let calls = 0
  const env = fixture({ handlers: { fork: () => { calls += 1 } } })
  try {
    const { doc, ticket } = openConfirm(env)
    const prior = { kind: 'fulfillment-failed', action: 'fork', at: env.clock.at, error: 'fixture lost acknowledgment' }
    env.store.set('deferred/req/' + doc.requestId, { ...doc, refusals: [prior] })
    env.board.noteDeferred(ticket.id, { refusals: [prior] })
    const approve = () => env.registry.resolve({ requestId: doc.requestId, decision: 'approve', actor: REQUESTER })
    await assert.rejects(approve(), { code: 'fulfillment-uncertain' })
    assert.equal(calls, 0)
    assert.equal(env.registry.get(doc.requestId).outcome.kind, 'fulfillment-uncertain')
    assert.deepEqual(env.board.getDeferred(ticket.id).outcome, env.registry.get(doc.requestId).outcome)
    await assert.rejects(approve(), { code: 'fulfillment-uncertain' })
  } finally { env.cleanup() }
})

test('mismatched actor: only the recorded authority decides, prose is never a decision', async () => {
  const env = fixture()
  try {
    const { ticket } = openConfirm(env, { requestId: 'dfr-actor' })

    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-actor', decision: 'approve' }),
      e => e.code === 'actor-required',
    )
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-actor', decision: 'approve', actor: { actor: 'owner-W' } }),
      e => e.code === 'actor-mismatch',
    )
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-actor', decision: 'approve', actor: { actor: 'user', ownerId: 'owner-B' } }),
      e => e.code === 'owner-mismatch',
    )
    // 票面权威: free-form prose ("确认", "yes", …) is never interpreted as a decision.
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-actor', decision: '确认', actor: REQUESTER }),
      e => e.code === 'decision-invalid',
    )
    // An `answer` on a confirm request is the wrong vocabulary, not an answer.
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-actor', decision: 'answer', actor: REQUESTER, text: '好' }),
      e => e.code === 'decision-invalid',
    )

    const refused = env.registry.get('dfr-actor')
    assert.equal(refused.status, 'pending', 'a forged attempt can never kill a legitimate request')
    assert.deepEqual(refused.refusals.map(r => r.kind), ['actor-mismatch', 'owner-mismatch'])
    assert.equal(env.board.getTicket(ticket.id).stage, 'person/confirm', 'the question stays on the face')

    // The legitimate authority still decides afterwards.
    const rejected = await env.registry.resolve({ requestId: 'dfr-actor', decision: 'reject', actor: REQUESTER, text: '不做' })
    assert.equal(rejected.status, 'answered')
    assert.equal(rejected.outcome.decision, 'reject')
    assert.equal(rejected.outcome.reason, '不做')
    const face = env.board.getTicket(ticket.id)
    assert.equal(face.stage, 'blocked', 'legacy rejectConfirm keeps the original session and blocks')
    assert.equal(face.confirmOutcome.kind, 'rejected')
    assert.equal(face.deferred.status, 'rejected')
  } finally { env.cleanup() }
})

test('missing destination: an unfillable stored action fails closed without reaching the handler', async () => {
  let calls = 0
  const owners = {
    get: ownerId => ({ id: ownerId, status: 'created', recycled: false, sessionId: 'sess-owner-1' }),
    isOwnerSession: sessionId => sessionId === 'sess-owner-1',
  }
  const env = fixture({ handlers: { fork: async () => { calls += 1; return {} } }, owners })
  try {
    // The destination was never captured: no sessionId on the stored target.
    const noTarget = openConfirm(env, { requestId: 'dfr-no-target', target: {} })
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-no-target', decision: 'approve', actor: REQUESTER }),
      e => e.code === 'target-missing',
    )
    const missing = env.registry.get('dfr-no-target')
    assert.equal(missing.status, 'cancelled', 'an unfillable request closes for good')
    assert.equal(missing.outcome.refused, 'target-missing')
    assert.equal(missing.target.sessionId, undefined, 'the stored target is never rewritten')
    assert.equal(env.board.getTicket(noTarget.ticket.id).stage, 'done', 'the face is released, not left waiting')
    assert.equal(env.board.getTicket(noTarget.ticket.id).deferred.status, 'cancelled')

    // An owner Session can never be an execution destination.
    const ownerTarget = openConfirm(env, { requestId: 'dfr-owner-target', target: { sessionId: 'sess-owner-1' } })
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-owner-target', decision: 'approve', actor: REQUESTER }),
      e => e.code === 'target-ineligible',
    )
    const ineligible = env.registry.get('dfr-owner-target')
    assert.equal(ineligible.status, 'cancelled')
    assert.equal(ineligible.outcome.refused, 'target-ineligible')
    assert.equal(env.board.getTicket(ownerTarget.ticket.id).stage, 'done')

    assert.equal(calls, 0, 'a fail-closed request never executes the action')
    // Withdrawing still works on an unfillable request: no destination is needed to cancel.
    const withdraw = openConfirm(env, { requestId: 'dfr-withdraw', target: {} })
    const cancelled = await env.registry.resolve({ requestId: 'dfr-withdraw', decision: 'cancel', actor: REQUESTER })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.outcome.decision, 'cancel')
    assert.equal(env.board.getTicket(withdraw.ticket.id).stage, 'done')
    assert.equal(calls, 0)
  } finally { env.cleanup() }
})

test('an initial route may target its registered owner before a session exists', async () => {
  let binding = { id: 'owner-A', status: 'pending', sessionId: null, recycled: false }
  const calls = []
  const capture = ({ request }) => calls.push(request.target)
  const env = fixture({ owners: { get: () => binding }, handlers: { 'dangerous-inject': capture, fork: capture } })
  try {
    const route = openConfirm(env, {
      action: { type: 'dangerous-inject', entry: 'route' },
      receiver: { kind: 'owner', ownerId: 'owner-A' }, target: { ownerId: 'owner-A' },
    })
    const decide = requestId => env.registry.resolve({ requestId, decision: 'approve', actor: REQUESTER })
    assert.equal((await decide(route.doc.requestId)).executed, true)
    assert.deepEqual(calls, [{ ownerId: 'owner-A' }])

    const followUp = openConfirm(env, {
      action: { type: 'dangerous-inject', entry: 'follow-up' }, target: { ownerId: 'owner-A' },
    })
    await assert.rejects(decide(followUp.doc.requestId), { code: 'owner-missing' })
    binding = { ...binding, status: 'created', sessionId: 'sess-owner-1' }
    const wrongOwner = openConfirm(env, {
      action: route.doc.action, target: { ownerId: 'owner-B' },
    })
    await assert.rejects(decide(wrongOwner.doc.requestId), { code: 'target-ineligible' })
    const wrongWorker = openConfirm(env, {
      action: { type: 'fork', sessionId: 'sess-worker-2' }, target: { sessionId: 'sess-worker-1' },
    })
    await assert.rejects(decide(wrongWorker.doc.requestId), { code: 'target-ineligible' })
    const workerMissing = openConfirm(env, {
      action: { type: 'dangerous-inject', entry: 'owner-inject' }, target: {},
    })
    await assert.rejects(decide(workerMissing.doc.requestId), { code: 'target-missing' })
    assert.deepEqual(calls, [{ ownerId: 'owner-A' }])
  } finally { env.cleanup() }
})

test('owner route and follow-up confirmations preserve the fixed owner session', async () => {
  const targets = []
  const owners = { get: () => ({ id: 'owner-A', status: 'created', sessionId: 'sess-owner-1' }) }
  const env = fixture({ owners, handlers: { 'dangerous-inject': ({ request }) => targets.push(request.target) } })
  try {
    const decide = doc => env.registry.resolve({ requestId: doc.requestId, decision: 'approve', actor: REQUESTER })
    const target = { ownerId: 'owner-A', sessionId: 'sess-owner-1' }
    for (const entry of ['route', 'follow-up']) {
      const { doc, ticket } = openConfirm(env, { action: { type: 'dangerous-inject', entry }, target })
      assert.deepEqual((await decide(doc)).target, target)
      assert.deepEqual(env.board.getDeferred(ticket.id).target, target)
    }
    const action = { type: 'dangerous-inject', entry: 'route' }
    for (const invalid of [{ ...target, ownerId: 'owner-B' }, { ...target, sessionId: ' ' }, { ...target, sessionId: null }]) {
      const { doc } = openConfirm(env, { action, target: invalid })
      await assert.rejects(decide(doc), { code: 'target-ineligible' })
    }
    assert.deepEqual(targets, [target, target])
  } finally { env.cleanup() }
})

test('a worker answer needs its exact ticket binding and does not need an owner session', async () => {
  const owners = { currentBinding: () => ({ id: 'owner-A', status: 'pending', sessionId: null }) }
  const env = fixture({ owners })
  try {
    const openAnswer = () => {
      const ticket = env.seed('working', { workerSession: { sessionId: 'sess-worker-1' } })
      const doc = env.registry.request({
        ...facts(ticket, { action: { type: 'ask-user' }, target: null, type: 'answer', receiver: { kind: 'worker', sessionId: 'sess-worker-1' } }),
        question: '请提供编号',
      })
      return { ticket, doc }
    }
    const answer = doc => env.registry.resolve({ requestId: doc.requestId, decision: 'answer', text: 'A-123', actor: REQUESTER })
    const valid = openAnswer()
    assert.equal((await answer(valid.doc)).text, 'A-123')
    assert.equal(env.board.getTicket(valid.ticket.id).stage, 'working')
    const replaced = openAnswer()
    env.board.bindWorkerSession(replaced.ticket.id, { sessionId: 'sess-worker-2', cwd: '/tmp' })
    await assert.rejects(answer(replaced.doc), { code: 'receiver-stale' })
    assert.equal(env.board.getTicket(replaced.ticket.id).stage, 'blocked')
    assert.equal(env.registry.get(replaced.doc.requestId).status, 'cancelled')
    assert.equal(env.registry.get(replaced.doc.requestId).receiver.sessionId, 'sess-worker-1')

    const unavailable = openAnswer()
    const input = { requestId: unavailable.doc.requestId, decision: 'answer', text: 'B-456', actor: REQUESTER, workerUnavailable: true }
    await assert.rejects(env.registry.resolve({ ...input, actor: { actor: 'other' } }), { code: 'actor-mismatch' })
    await assert.rejects(env.registry.resolve({ ...input, decision: 'approve' }), { code: 'decision-invalid' })
    assert.equal(env.registry.get(unavailable.doc.requestId).status, 'pending')
    await assert.rejects(env.registry.resolve(input), { code: 'receiver-stale' })
    assert.equal(env.registry.get(unavailable.doc.requestId).status, 'cancelled')
    const face = env.board.getTicket(unavailable.ticket.id)
    assert.equal(face.stage, 'blocked')
    assert.equal(face.deferred.outcome.refused, 'receiver-stale')
    assert.equal(face.transitions.at(-1).by, 'system')

    const expired = openAnswer()
    env.clock.at = expired.doc.expiresAt
    await assert.rejects(env.registry.resolve({ ...input, requestId: expired.doc.requestId }), { code: 'request-expired' })
    assert.equal(env.registry.get(expired.doc.requestId).outcome.kind, 'timeout')
  } finally { env.cleanup() }
})

test('answer acceptance queues delivery and sent evidence survives a duplicate or late failure', async () => {
  const env = fixture()
  try {
    const closed = []
    let canEnqueue = false
    env.registry.setCloseHandler(request => {
      assert.equal(env.store.db.isTransaction, true)
      if (!canEnqueue) throw new Error('fixture outbox write failed')
      closed.push(request)
    })
    const { ticket, input } = askForAnswer(env)
    await assert.rejects(env.registry.resolve(input), /fixture outbox write failed/)
    assert.equal(env.registry.get(input.requestId).status, 'pending')
    assert.equal(env.board.getTicket(ticket.id).stage, 'person/answer')
    canEnqueue = true
    const accepted = await env.registry.resolve(input)
    assert.deepEqual(accepted.outcome.delivery, { state: 'queued' })
    assert.deepEqual(closed, [accepted.request])
    assert.deepEqual(env.board.getDeferred(ticket.id).outcome, accepted.outcome)

    env.clock.at = '2026-11-15T00:00:45.000Z'
    const sent = env.registry.recordAnswerDelivery(input.requestId, { state: 'sent' })
    assert.equal(sent.duplicate, false)
    assert.equal(sent.request.decidedAt, accepted.request.decidedAt)
    assert.equal(sent.request.outcome.text, input.text)
    assert.deepEqual(sent.request.outcome.delivery, { state: 'sent', at: env.clock.at })
    assert.deepEqual(env.board.getDeferred(ticket.id).outcome, sent.request.outcome)

    env.clock.at = '2026-11-15T00:01:00.000Z'
    const prior = { request: sent.request, duplicate: true }
    assert.deepEqual(env.registry.recordAnswerDelivery(input.requestId, { state: 'sent' }), prior)
    assert.deepEqual(env.registry.recordAnswerDelivery(input.requestId, { state: 'failed', reason: 'worker later retired' }), prior)
    assert.equal(env.board.getTicket(ticket.id).stage, 'working')
    assert.equal(closed.length, 1)
  } finally { env.cleanup() }
})

test('answer delivery failure blocks only the working run resumed by that answer', async () => {
  const env = fixture()
  try {
    const current = askForAnswer(env)
    const advanced = askForAnswer(env)
    const replaced = askForAnswer(env)
    for (const opened of [current, advanced, replaced]) await env.registry.resolve(opened.input)
    env.board.escalate({ ticketId: advanced.ticket.id, reason: 'Later blocker' })
    env.board.resume(advanced.ticket.id)
    const replacement = askForAnswer(env, replaced.ticket)

    env.clock.at = '2026-11-15T00:02:00.000Z'
    const reason = 'Original worker was archived.'
    const delivery = { state: 'failed', reason, at: env.clock.at }
    for (const { input } of [current, advanced, replaced]) {
      const result = env.registry.recordAnswerDelivery(input.requestId, { state: 'failed', reason })
      assert.equal(result.duplicate, false)
      assert.equal(result.request.status, 'answered')
      assert.deepEqual(result.request.outcome.delivery, delivery)
    }
    const blocked = env.board.getTicket(current.ticket.id)
    assert.equal(blocked.stage, 'blocked')
    assert.equal(blocked.escalated.reason, reason)
    assert.equal(blocked.transitions.at(-1).by, 'system')
    assert.deepEqual(blocked.deferred.outcome.delivery, delivery)
    assert.equal(env.board.getTicket(advanced.ticket.id).stage, 'working')
    assert.deepEqual(env.board.getDeferred(advanced.ticket.id).outcome.delivery, delivery)
    assert.equal(env.board.getTicket(replaced.ticket.id).stage, 'person/answer')
    assert.equal(env.board.getDeferred(replaced.ticket.id).requestId, replacement.input.requestId)
  } finally { env.cleanup() }
})

test('answer delivery evidence and its system block roll back together on a storage failure', async () => {
  const env = fixture()
  try {
    const { ticket, input } = askForAnswer(env)
    const accepted = await env.registry.resolve(input)
    const persist = env.store.set.bind(env.store)
    env.store.set = () => { throw new Error('fixture receipt write failed') }
    const failure = { state: 'failed' }
    assert.throws(() => env.registry.recordAnswerDelivery(input.requestId, failure), /receipt write failed/)
    assert.equal(env.board.getTicket(ticket.id).stage, 'working')
    assert.deepEqual(env.board.getDeferred(ticket.id).outcome, accepted.outcome)
    assert.deepEqual(env.registry.get(input.requestId), accepted.request)

    env.store.set = persist
    const recorded = env.registry.recordAnswerDelivery(input.requestId, failure)
    assert.equal(recorded.duplicate, false)
    const blocked = env.board.getTicket(ticket.id)
    assert.equal(blocked.stage, 'blocked')
    assert.equal(blocked.escalated.reason, recorded.request.outcome.delivery.reason)
    assert.deepEqual(blocked.deferred.outcome, recorded.request.outcome)
    assert.deepEqual(env.registry.recordAnswerDelivery(input.requestId, failure), { request: recorded.request, duplicate: true })
    assert.deepEqual(env.board.getTicket(ticket.id), blocked)
  } finally { env.cleanup() }
})

test('stable worker: the stored action target is frozen and stays separate from the owner binding', async () => {
  const seen = []
  let binding = { status: 'created', recycled: false, sessionId: 'sess-owner-1' }
  const env = fixture({
    handlers: { fork: async ({ request }) => { seen.push(request.target); return { forked: request.target.sessionId } } },
    owners: { get: () => binding },
  })
  try {
    const { ticket, doc } = openConfirm(env, { requestId: 'dfr-target' })
    assert.equal(doc.target.sessionId, 'sess-worker-1', 'target = the action destination')
    assert.equal(doc.receiver.sessionId, 'sess-owner-1', 'receiver = the owner binding at request time')

    // 目标不被改写: re-pointing the stored action at another Session is refused.
    assert.throws(
      () => env.registry.request({ requestId: 'dfr-target', ...facts(ticket, { target: { sessionId: 'sess-worker-2' } }) }),
      e => e.code === 'request-immutable',
    )
    assert.equal(env.registry.get('dfr-target').target.sessionId, 'sess-worker-1')
    // Changing the owner binding is equally immutable on the request facts.
    assert.throws(
      () => env.registry.request({ requestId: 'dfr-target', ...facts(ticket, { receiver: { ownerId: 'owner-A', sessionId: 'sess-owner-9' } }) }),
      e => e.code === 'request-immutable',
    )

    // The owner is re-bound later; the decision comes from the NEW binding while the action still targets the
    // ORIGINAL worker Session — the two facts never collapse into one.
    binding = { status: 'created', recycled: false, sessionId: 'sess-owner-2' }
    const approved = await env.registry.resolve({
      requestId: 'dfr-target', decision: 'approve', actor: { actor: 'user', ownerId: 'owner-A', sessionId: 'sess-owner-2' },
    })
    assert.equal(approved.status, 'answered')
    assert.equal(approved.target.sessionId, 'sess-worker-1', 'the action destination is stable')
    assert.equal(approved.receiver.sessionId, 'sess-owner-1', 'the recorded receiver is history, not a live claim')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].sessionId, 'sess-worker-1', 'the handler received the original worker Session')

    const stored = env.registry.get('dfr-target')
    assert.equal(stored.target.sessionId, 'sess-worker-1')
    assert.equal(stored.receiver.sessionId, 'sess-owner-1')
    const face = env.board.getTicket(ticket.id).deferred
    assert.equal(face.target.sessionId, 'sess-worker-1')
    assert.equal(face.receiver.sessionId, 'sess-owner-1')
  } finally { env.cleanup() }
})

test('owner binding: a missing or stale binding fails closed, the current one decides', async () => {
  let binding = { status: 'created', recycled: false, sessionId: 'sess-owner-1' }
  const env = fixture({ owners: { get: () => binding } })
  try {
    const { ticket } = openConfirm(env, { requestId: 'dfr-binding' })

    // Recycled binding: the owner's Session was handed back — it is history, not an authority.
    binding = { status: 'created', recycled: true, sessionId: 'sess-owner-1' }
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-binding', decision: 'approve', actor: { actor: 'user' } }),
      e => e.code === 'owner-missing',
    )
    // Deregistered owner.
    binding = { status: 'missing', recycled: false, sessionId: 'sess-owner-1' }
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-binding', decision: 'approve', actor: { actor: 'user' } }),
      e => e.code === 'owner-missing',
    )
    // Live binding, but the caller still holds the OLD Session.
    binding = { status: 'created', recycled: false, sessionId: 'sess-owner-2' }
    await assert.rejects(
      env.registry.resolve({ requestId: 'dfr-binding', decision: 'approve', actor: { actor: 'user', sessionId: 'sess-owner-1' } }),
      e => e.code === 'receiver-stale',
    )

    const refused = env.registry.get('dfr-binding')
    assert.equal(refused.status, 'pending')
    assert.deepEqual(refused.refusals.map(r => r.kind), ['owner-missing', 'owner-missing', 'receiver-stale'])
    assert.equal(env.board.getTicket(ticket.id).stage, 'person/confirm')

    // The owner's CURRENT binding decides.
    const approved = await env.registry.resolve({
      requestId: 'dfr-binding', decision: 'approve', actor: { actor: 'user', sessionId: 'sess-owner-2' },
    })
    assert.equal(approved.status, 'answered')
    assert.equal(approved.outcome.decision, 'approve')

    // Without an owners port the recorded receiver is the only authority available — a foreign Session still fails
    // closed, and a caller carrying no Session at all is accepted against the recorded facts.
    const bare = fixture()
    try {
      const { ticket: bareTicket } = openConfirm(bare, { requestId: 'dfr-bare' })
      await assert.rejects(
        bare.registry.resolve({ requestId: 'dfr-bare', decision: 'approve', actor: { actor: 'user', sessionId: 'sess-owner-9' } }),
        e => e.code === 'receiver-mismatch',
      )
      assert.equal(bare.registry.get('dfr-bare').status, 'pending')
      assert.equal(bare.board.getTicket(bareTicket.id).stage, 'person/confirm')
      const noHandler = await bare.registry.resolve({ requestId: 'dfr-bare', decision: 'approve', actor: REQUESTER })
      assert.equal(noHandler.status, 'answered')
      assert.equal(noHandler.executed, false, 'no handler was wired, so nothing ran')
      // The caller that ran the action itself records it once.
      assert.equal(bare.registry.markExecuted('dfr-bare', { result: { ran: 'caller' } }).duplicate, false)
      assert.equal(bare.registry.markExecuted('dfr-bare').duplicate, true)
      assert.equal(bare.registry.get('dfr-bare').outcome.executed, true)
      assert.deepEqual(bare.board.getDeferred(bareTicket.id).outcome, bare.registry.get('dfr-bare').outcome)
    } finally { bare.cleanup() }
  } finally { env.cleanup() }
})
