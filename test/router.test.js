/**
 * Router: the L1→L2 routing core (spec「工具契约」route_to_owner / query_tasks / reply_source) with the #66
 * reliability model: tickets are stored as 待触发 (idle) BEFORE any prompt is admitted, the OutboxRunner
 * delivers with retry/order, a human message releases blocked/failed tasks, follow-ups never re-bind
 * trigger/authorization (票面权威), and outward replies are truncated by code at 100 words.
 * Tested against a fake Sessions port and a deterministic clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { Router, RouterError, RECOVERY_NOTE } from '../src/router.js'
import { DeferredRegistry } from '../src/deferred.js'
import { discardOutboxRows } from '../src/outbox.js'

/** A registry+router with a scriptable fake Sessions port and a deterministic clock. */
function fixture({ failSessions = [], config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const calls = { create: [], prompt: [] }
  const sessions = {
    create: async request => {
      calls.create.push(request)
      return { sessionId: 'session-fake-' + calls.create.length }
    },
    prompt: async request => {
      calls.prompt.push(request)
      if (failSessions.includes(request.sessionId)) {
        const error = new Error('session ' + request.sessionId + ' is absent from persistence')
        error.name = 'ApiSessionNotFound'
        throw error
      }
      return { accepted: true }
    },
  }
  const router = new Router({ store, registry, sessions, config, now: () => new Date(nowMs).toISOString() })
  const advance = (ms) => { nowMs += ms }
  return { router, registry, store, calls, advance, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('route stores the ticket as 待触发 first, then the runner delivers it into 进行中', async () => {
  const { router, registry, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '继续工单 66' })
    assert.equal(receipt.createdSession, true)
    assert.equal(receipt.rebuilt, false)
    assert.equal(receipt.stage, 'working', 'delivered in the same tick: 待触发 → 进行中')
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].cwd, '/repos/DSH-Workflow')
    const ticket = router.getTicket(receipt.ticketId)
    assert.equal(ticket.stage, 'working')
    assert.equal(ticket.mechanism, 'inject')
    assert.equal(ticket.targetSession, receipt.sessionId)
    assert.deepEqual(ticket.transitions.map(t => t.from + '>' + t.to), ['idle>working'])
    // 先存后做: the stored outbox row carried the exact injected text.
    const row = router.listOutbox().find(r => r.ticketId === receipt.ticketId)
    assert.equal(row.kind, 'inject')
    assert.equal(row.state, 'sent')
    assert.match(row.body, /继续工单 66/)
    assert.match(row.body, /授权/)
    const trigger = router.getTrigger(ticket.triggerId)
    assert.equal(trigger.message, '继续工单 66')
    assert.equal(calls.prompt.length, 1)
    assert.match(calls.prompt[0].text, /授权/)
    // Second route reuses the live Session — no new creation.
    const again = await router.routeToOwner({ ownerId: owner.id, message: '补一句' })
    assert.equal(again.createdSession, false)
    assert.equal(calls.create.length, 1)
    assert.equal(calls.prompt.length, 2)
  } finally { cleanup() }
})

test('route refuses unknown owners and the chief itself', async () => {
  const { router, cleanup } = fixture()
  try {
    await assert.rejects(() => router.routeToOwner({ ownerId: 'nope', message: 'x' }), RouterError)
    await assert.rejects(() => router.routeToOwner({ ownerId: 'chief', message: 'x' }), RouterError)
    await assert.rejects(() => router.routeToOwner({ ownerId: 'chief' }), RouterError)
  } finally { cleanup() }
})

test('one trigger accepted twice produces one task: triggerRef dedupes the whole route', async () => {
  const { router, registry, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'm', triggerRef: 'feishu:om_1' })
    const second = await router.routeToOwner({ ownerId: owner.id, message: 'm', triggerRef: 'feishu:om_1' })
    assert.equal(second.deduped, true)
    assert.equal(second.ticketId, first.ticketId)
    assert.equal(second.stage, 'working')
    assert.equal(calls.prompt.length, 1)
    assert.equal(router.queryTasks({}).length, 1)
    await router.routeToOwner({ ownerId: owner.id, message: 'm', triggerRef: 'feishu:om_2' })
    assert.equal(router.queryTasks({}).length, 2)
  } finally { cleanup() }
})

test('a transient delivery failure leaves the ticket 待触发; the 2s retry delivers it (先存后做)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
  registry.bindSession(owner.id, 'session-live')
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  let prompts = 0
  const router = new Router({ store, registry, now: () => new Date(nowMs).toISOString(), sessions: {
    create: async () => { throw new Error('must not be called') },
    prompt: async () => { prompts++; if (prompts === 1) { const e = new Error('provider overloaded'); e.name = 'RemoteError'; throw e } return { accepted: true } },
  } })
  try {
    // 先存后做: a transient failure does NOT reject the route — the work is stored and retried.
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    assert.equal(receipt.stage, 'idle', 'ticket waits as 待触发 while the first attempt backs off')
    assert.equal(router.getTicket(receipt.ticketId).stage, 'idle')
    assert.equal(registry.get(owner.id).sessionId, 'session-live', 'no rebuild for transient failures')
    const row = router.listOutbox().find(r => r.ticketId === receipt.ticketId)
    assert.equal(row.state, 'queued')
    assert.equal(row.attempts, 1)
    assert.equal(row.nextRetryAt, nowMs + 2000, '2s first retry')
    // Before the backoff elapses the retry does not fire.
    await router.tick()
    assert.equal(prompts, 1)
    // At the 2s mark the stored row delivers and the ticket enters 进行中.
    nowMs += 2000
    await router.tick()
    assert.equal(prompts, 2)
    assert.equal(router.getTicket(receipt.ticketId).stage, 'working')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a deleted owner Session rebuilds on delivery and the registry is updated', async () => {
  const dead = []
  const { router, registry, calls, cleanup } = fixture({ failSessions: dead })
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'first' })
    dead.push(first.sessionId)
    const rebuilt = await router.routeToOwner({ ownerId: owner.id, message: 'after delete' })
    assert.equal(rebuilt.rebuilt, true)
    assert.notEqual(rebuilt.sessionId, first.sessionId)
    assert.equal(registry.get(owner.id).sessionId, rebuilt.sessionId)
    assert.equal(registry.get(owner.id).status, 'created')
    assert.equal(router.getTicket(rebuilt.ticketId).targetSession, rebuilt.sessionId)
    assert.equal(calls.create.length, 2)
    assert.equal(calls.prompt.length, 3) // first + failed attempt + retried after rebuild
  } finally { cleanup() }
})

test('a rebuilt owner receives current durable facts with the original delivery request', async () => {
  const dead = []
  const { router, registry, store, calls, cleanup } = fixture({ failSessions: dead })
  let reopened
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Cold start fixture', cwd: '/repos/fixture' })
    const other = registry.create({ kind: 'repo', workspace: 'Other owner', cwd: '/repos/other' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'first fixture task' })
    router.tasks.bindWorkerSession(first.ticketId, { sessionId: 'cold-start-original-worker', cwd: owner.cwd })
    const outside = await router.routeToOwner({ ownerId: other.id, message: 'other task' })
    router.tasks.report({ ticketId: outside.ticketId, summary: 'unrelated-report-marker' })
    router.installDeferred(new DeferredRegistry({ store, tasks: router.tasks, now: router.now,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    const waiting = router.openQuestion({ ticketId: first.ticketId, question: 'Which saved fixture input?' })
    store.close()
    reopened = new Store(store.stateDir)
    const currentRegistry = new OwnerRegistry(reopened, { scratchRoot: join(reopened.stateDir, 'scratch') })
    const routerAfter = new Router({ store: reopened, registry: currentRegistry, sessions: router.sessions, now: router.now })
    await routerAfter.markRestart()
    assert.equal(currentRegistry.get(owner.id).sessionId, first.sessionId)
    assert.equal(calls.create.length, 2)
    dead.push(first.sessionId)
    const input = { ownerId: owner.id, message: 'resume after loss', triggerRef: 'fixture-owner-rebuild' }
    const recovered = await routerAfter.routeToOwner(input)
    const prompts = calls.prompt.slice(-2)
    assert.equal(recovered.rebuilt, true)
    assert.equal(calls.create.at(-1).agentPreset, 'hub-bot-owner')
    assert.equal(prompts[0].sessionId, first.sessionId)
    assert.equal(prompts[0].requestId, prompts[1].requestId)
    assert.equal(prompts[1].requestId, recovered.requestId)
    assert.ok(prompts[1].text.includes('Cold start fixture'))
    assert.ok(prompts[1].text.includes(waiting.deferred.requestId))
    assert.ok(prompts[1].text.includes(waiting.deferred.expiresAt))
    assert.ok(prompts[1].text.includes('cold-start-original-worker'))
    assert.ok(!prompts[1].text.includes('unrelated-report-marker'))
    assert.deepEqual(routerAfter.getTicket(first.ticketId).authorization, waiting.authorization)
    assert.equal(routerAfter.getTicket(first.ticketId).deferred.expiresAt, waiting.deferred.expiresAt)
    assert.equal((await routerAfter.routeToOwner(input)).deduped, true)
    assert.equal(calls.prompt.at(-1), prompts[1])
    await routerAfter.routeToOwner({ ownerId: owner.id, message: 'later ordinary request' })
    assert.ok(!calls.prompt.at(-1).text.includes(waiting.deferred.requestId))
  } finally { reopened?.close(); cleanup() }
})

test('owner rebuild reuses its persisted proposal after the host response is lost', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture()
  let reopened
  try {
    const owner = registry.create({ kind: 'dir', cwd: '/repos/rebuild' })
    const oldSession = 'deleted-owner-fixture'
    registry.bindSession(owner.id, oldSession)
    const created = new Set()
    const sessions = {
      create: async input => {
        calls.create.push(input)
        assert.ok(input.sessionId)
        assert.equal(input.agentPreset, 'hub-bot-owner')
        if (!created.has(input.sessionId)) {
          created.add(input.sessionId)
          throw new Error('The create result was lost after the host committed it.')
        }
        return { sessionId: input.sessionId, agentPreset: input.agentPreset }
      },
      prompt: async input => {
        calls.prompt.push(input)
        if (input.sessionId === oldSession) throw Object.assign(new Error('fixture missing session'), { code: 'session/not-found' })
        assert.ok(created.has(input.sessionId))
        return { accepted: true }
      },
    }
    router.sessions = sessions
    const work = await router.routeToOwner({ ownerId: owner.id, message: 'fixture first request' })
    assert.equal(work.stage, 'idle')
    assert.equal(registry.get(owner.id).sessionId, null)
    store.close()
    reopened = new Store(store.stateDir)
    const nextRegistry = new OwnerRegistry(reopened, { scratchRoot: join(reopened.stateDir, 'scratch') })
    const restarted = new Router({ store: reopened, registry: nextRegistry, sessions, now: router.now })
    advance(2000)
    await restarted.markRestart()
    await restarted.tick()
    assert.equal(calls.create.length, 2)
    assert.equal(calls.create[0].sessionId, calls.create[1].sessionId)
    assert.equal(created.size, 1)
    assert.equal(nextRegistry.get(owner.id).sessionId, calls.create[0].sessionId)
    assert.equal(calls.prompt[0].requestId, work.requestId)
    assert.equal(calls.prompt[1].requestId, work.requestId)
    assert.match(calls.prompt[1].text, /负责人事实/)
    assert.equal(restarted.getTicket(work.ticketId).lastDelivery.state, 'sent')
  } finally { reopened?.close(); cleanup() }
})

test('a replacement has no current binding until its first fact-bearing request is accepted', async () => {
  const { router, registry, calls, advance, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'dir', cwd: '/repos/await-bind' })
    registry.bindSession(owner.id, 'missing-manager')
    let replacement
    const unboundAtPrompt = []
    router.sessions.create = async input => { calls.create.push(input); replacement = input.sessionId; return { sessionId: replacement, agentPreset: input.agentPreset } }
    let refused = false
    router.sessions.prompt = async input => {
      calls.prompt.push(input)
      if (input.sessionId === 'missing-manager') throw Object.assign(new Error('fixture missing'), { code: 'session/not-found' })
      unboundAtPrompt.push(!registry.findByCurrentSession(input.sessionId))
      assert.match(input.text, /负责人事实/)
      if (!refused) { refused = true; throw Error('fixture first intake refused') }
      return { accepted: true }
    }
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: 'fixture pending initialization' })
    assert.equal(receipt.stage, 'idle')
    assert.equal(registry.get(owner.id).sessionId, null)
    assert.equal(registry.findByCurrentSession(replacement), undefined)
    advance(2000)
    await router.tick()
    assert.deepEqual(unboundAtPrompt, [true, true])
    assert.equal(calls.create.length, 1)
    assert.equal(registry.get(owner.id).sessionId, replacement)
    assert.ok(calls.prompt.every(prompt => prompt.requestId === receipt.requestId))
  } finally { cleanup() }
})

test('three consecutive delivery failures report a system problem (一次性错误不惊动人)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
  registry.bindSession(owner.id, 'session-down')
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const problems = []
  const router = new Router({ store, registry, now: () => new Date(nowMs).toISOString(), onSystemProblem: p => problems.push(p), sessions: {
    create: async () => { throw new Error('must not be called') },
    prompt: async () => { const e = new Error('provider overloaded'); e.name = 'RemoteError'; throw e },
  } })
  try {
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    assert.equal(problems.length, 0)
    nowMs += 2000; await router.tick()
    assert.equal(problems.length, 0, 'two failures do not escalate')
    nowMs += 4000; await router.tick()
    assert.equal(problems.length, 1, 'the third consecutive failure reports a system problem')
    assert.equal(problems[0].ticketId, receipt.ticketId)
    assert.ok(router.listOutbox().some(r => r.kind === 'system-problem'))
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('follow-up resume: a review ticket resumes to working and injects into the same owner session', async () => {
  const { router, registry, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: '写 hello 脚本' })
    router.tasks.report({ ticketId: first.ticketId, summary: 'done, see .scratch/hello.js' })
    assert.equal(router.getTicket(first.ticketId).stage, 'person/review')
    const resumed = await router.routeToOwner({ ownerId: owner.id, message: '顺带输出一行时间戳', ticketId: first.ticketId })
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.ticketId, first.ticketId)
    assert.equal(resumed.stage, 'working')
    assert.equal(router.getTicket(first.ticketId).stage, 'working')
    assert.equal(calls.prompt.length, 2)
    assert.match(calls.prompt[1].text, /顺带输出一行时间戳/)
    assert.match(calls.prompt[1].text, /授权/)
    assert.match(calls.prompt[1].text, /再次 report/)
    assert.equal(router.queryTasks({}).length, 1)
    // 追问不绑定新触发 (spec #66): the trigger table holds exactly the original route's trigger.
    assert.equal(store3(router), 1)
  } finally { cleanup() }
  function store3(router) {
    return router.store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get().n
  }
})

test('a human message releases blocked and failed tasks back to working (人的消息直接释放)', async () => {
  const { router, registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const t1 = await router.routeToOwner({ ownerId: owner.id, message: 'one' })
    router.tasks.escalate({ ticketId: t1.ticketId, reason: '越界' })
    assert.equal(router.getTicket(t1.ticketId).stage, 'blocked')
    const r1 = await router.routeToOwner({ ownerId: owner.id, message: '已授权，继续', ticketId: t1.ticketId })
    assert.equal(r1.resumed, true)
    assert.equal(router.getTicket(t1.ticketId).stage, 'working')
    const t2 = await router.routeToOwner({ ownerId: owner.id, message: 'two' })
    router.tasks.fail({ ticketId: t2.ticketId, reason: '目标会话已删除' })
    assert.equal(router.getTicket(t2.ticketId).stage, 'failed')
    const r2 = await router.routeToOwner({ ownerId: owner.id, message: '重试', ticketId: t2.ticketId })
    assert.equal(r2.resumed, true)
    assert.equal(router.getTicket(t2.ticketId).stage, 'working')
  } finally { cleanup() }
})

test('follow-up rejects done tickets and any attempt to re-bind authorization (票面权威)', async () => {
  const { router, registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    await assert.rejects(
      () => router.routeToOwner({ ownerId: owner.id, message: '换个授权', ticketId: first.ticketId, authorization: { actor: 'user', source: 'feishu', at: 'now' } }),
      (e) => e instanceof RouterError && e.code === 'authorization-immutable')
    router.tasks.report({ ticketId: first.ticketId, summary: 'done' })
    await router.routeToOwner({ ownerId: owner.id, message: '验收', ticketId: first.ticketId, resolution: 'accept' })
    await assert.rejects(() => router.routeToOwner({ ownerId: owner.id, message: 'again', ticketId: first.ticketId }),
      (e) => e.code === 'illegal-transition')
  } finally { cleanup() }
})

test("resolution 'accept' gates person/review → done; 'cancel' closes a person/confirm ticket", async () => {
  const { router, registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const t1 = await router.routeToOwner({ ownerId: owner.id, message: 'one' })
    // accept is rejected while the task is still working
    await assert.rejects(() => router.routeToOwner({ ownerId: owner.id, message: '验收', ticketId: t1.ticketId, resolution: 'accept' }),
      (e) => e.code === 'illegal-transition')
    router.tasks.report({ ticketId: t1.ticketId, summary: 'ok' })
    const accepted = await router.routeToOwner({ ownerId: owner.id, message: '验收', ticketId: t1.ticketId, resolution: 'accept' })
    assert.equal(accepted.accepted, true)
    assert.equal(accepted.stage, 'done')
    const t2 = await router.routeToOwner({ ownerId: owner.id, message: 'two' })
    router.tasks.askConfirm({ ticketId: t2.ticketId, question: 'fork 执行会话？' })
    const cancelled = await router.routeToOwner({ ownerId: owner.id, message: '取消', ticketId: t2.ticketId, resolution: 'cancel' })
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.stage, 'done')
  } finally { cleanup() }
})

test('chief ticket resolution passes the state machine (面板裁决不是路由，不能被 cannot-route-to-chief 拦)', async () => {
  const { router, store, cleanup } = fixture()
  try {
    // chief 票的来源不是 routeToOwner（新建被拒），而是黑名单挂起的注入——直接票面构造该状态。
    const ticket = {
      id: 'tsk-chief-1', owner: 'chief', stage: 'person/confirm', requestId: 'req-1',
      createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z',
      authorization: { actor: 'ghost', source: 'feishu', at: '2026-11-15T00:00:00.000Z' },
      pendingConfirm: { text: '改动会推送到 main，确认执行？' },
      assignments: [],
    }
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
    const rejected = await router.routeToOwner({ ownerId: 'chief', message: '面板拒绝', ticketId: ticket.id, resolution: 'reject' })
    assert.equal(rejected.rejected, true)
    assert.equal(rejected.stage, 'blocked')
    assert.equal(router.getTicket(ticket.id).stage, 'blocked')
    // 新建路由仍然拒绝 chief
    await assert.rejects(() => router.routeToOwner({ ownerId: 'chief', message: '新任务' }), (e) => e.code === 'cannot-route-to-chief')
  } finally { cleanup() }
})

test('a ticket without an authorization record is failed, never executed on a guess (缺上下文升级不编造)', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    // Corrupt the record: strip its authorization (e.g. a hand-edited row).
    const ticket = router.getTicket(first.ticketId)
    const { authorization, ...stripped } = ticket
    store.db.prepare('UPDATE ticket SET value = ? WHERE id = ?').run(JSON.stringify(stripped), ticket.id)
    await assert.rejects(
      () => router.routeToOwner({ ownerId: owner.id, message: '继续', ticketId: first.ticketId }),
      (e) => e.code === 'authorization-missing')
    assert.equal(router.getTicket(first.ticketId).stage, 'blocked', 'escalated instead of fabricated')
    // And the stored-work path also refuses: an inject row for an authorization-less ticket fails permanently.
    const bare = { id: 'tsk-bare', triggerId: 'trg-bare', owner: owner.id, stage: 'idle', mechanism: 'inject', targetSession: 's', requestId: 'r', createdAt: 'x', updatedAt: 'x' }
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(bare.id, JSON.stringify(bare))
    router.runner.enqueue({ ticketId: bare.id, kind: 'inject', to: 'session:s', body: 'x', requestId: 'r2' })
    await router.tick()
    assert.equal(router.getTicket(bare.id).stage, 'failed')
    assert.ok(router.listOutbox().some(r => r.kind === 'system-problem'))
  } finally { cleanup() }
})

test('restart recovery: markRestart auto-resumes working tickets oldest-first with the recovery note (spec L329, #72 AC1)', async () => {
  const { router, registry, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    await router.markRestart()
    // 无人干预: the working ticket receives a fresh recovery injection immediately (no human message needed)
    const resumed = calls.prompt.at(-1).text
    assert.ok(resumed.startsWith(RECOVERY_NOTE), 'recovery note heads the auto-resume injection')
    assert.ok(resumed.includes('[hub-bot 恢复 ' + first.ticketId + ']'), '恢复注入语义标记')
    assert.equal(router.getTicket(first.ticketId).recoveryPending, undefined, 'carried exactly once')
    await router.routeToOwner({ ownerId: owner.id, message: '再来', ticketId: first.ticketId })
    assert.ok(!calls.prompt.at(-1).text.includes(RECOVERY_NOTE), 'the note is not repeated on later follow-ups')
  } finally { cleanup() }
})

test('redelivery after a crash prepends the recovery note to the STORED body (双轴审查 P2: idle-at-crash gap)', async () => {
  const { router, registry, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const t = await router.routeToOwner({ ownerId: owner.id, message: '干活' })
    // a row stored BEFORE the crash (its body carries no note) is what the fresh runner resumes first
    router.runner.enqueue({ ticketId: t.ticketId, kind: 'inject', to: 'session:' + t.sessionId, sessionId: t.sessionId, body: '[hub-bot 追问 ' + t.ticketId + '] 旧正文', requestId: 'r-old' })
    await router.markRestart() // crash + restart: working ticket becomes recoveryPending + auto-resume row queues behind
    await router.tick()
    const redelivered = calls.prompt.find(p => p.text.includes('旧正文'))
    assert.ok(redelivered.text.startsWith(RECOVERY_NOTE), 'the redelivered stored body heads the recovery note')
    assert.equal(router.getTicket(t.ticketId).recoveryPending, undefined, 'carried exactly once across both rows')
    const autoResume = calls.prompt.find(p => p.text.includes('[hub-bot 恢复 ' + t.ticketId + ']'))
    assert.ok(autoResume, 'working 票的自动恢复注入也到达')
    assert.ok(!autoResume.text.includes(RECOVERY_NOTE), 'note carried exactly once (by the older row)')
  } finally { cleanup() }
})

test('replySource stores a 100-word-capped reply through the runner and announces truncation', async () => {
  const { router, registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    const short = await router.replySource({ text: '工单 66 已收尾', to: 'dsh:session:chief' })
    assert.equal(short.truncated, false)
    assert.equal(short.state, 'sent')
    const longText = '完成了。' + '细节细节细节细节细节 '.repeat(60)
    const long = await router.replySource({ text: longText, to: 'dsh:session:chief' })
    assert.equal(long.truncated, true)
    const stored = router.listOutbox().find(r => r.id === long.outboxId)
    assert.match(stored.body, /（超过 100 词已截断）$/)
  } finally { cleanup() }
})

test('queryTasks filters by owner/stage and every row carries the verbatim stageText reading', async () => {
  const { router, registry, cleanup } = fixture()
  try {
    const a = registry.create({ kind: 'repo', workspace: 'A', cwd: '/a' })
    const b = registry.create({ kind: 'repo', workspace: 'B', cwd: '/b' })
    await router.routeToOwner({ ownerId: a.id, message: 'one' })
    await router.routeToOwner({ ownerId: b.id, message: 'two' })
    assert.equal(router.queryTasks({}).length, 2)
    assert.equal(router.queryTasks({ owner: a.id }).length, 1)
    assert.equal(router.queryTasks({ stage: 'working' }).length, 2)
    assert.equal(router.queryTasks({ stage: 'done' }).length, 0)
    for (const row of router.queryTasks({})) assert.equal(row.stageText, '进行中', '状态摘要是状态的朗读')
    router.tasks.report({ ticketId: router.queryTasks({ owner: a.id })[0].id, summary: 'ok' })
    assert.equal(router.queryTasks({ stage: 'person/review' })[0].stageText, '等您验收')
  } finally { cleanup() }
})


// ---------- #67 汇报链: digest/reply delivery to the chief + scheduled auto-summary ----------

/** Fake sessions port with a running-set, tracking prompts per session. */
function chainFixture({ reporting } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const calls = { create: [], prompt: [] }
  const running = new Set()
  const sessions = {
    create: async request => { calls.create.push(request); return { sessionId: 'session-fake-' + (calls.create.length) } },
    prompt: async request => { calls.prompt.push(request); return { accepted: true } },
    isRunning: async sessionId => running.has(sessionId),
  }
  const config = { stateDir: dir, homeRepo: '/Volumes/home', reporting: reporting ?? { auto: false, intervalMs: 60000 } }
  const router = new Router({ store, registry, sessions, config, now: () => new Date(nowMs).toISOString() })
  return { router, registry, store, calls, running, advance: (ms) => { nowMs += ms }, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('digest delivery waits for the owner to go idle, then lands ONE merged message on the chief', async () => {
  const { router, registry, store, calls, running, advance, cleanup } = chainFixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    registry.bindSession('chief', 'session-chief')
    const t1 = await router.routeToOwner({ ownerId: owner.id, message: 'one' })
    const t2 = await router.routeToOwner({ ownerId: owner.id, message: 'two' })
    const { recordReportFact } = await import('../src/reporting.js')
    router.tasks.report({ ticketId: t1.ticketId, summary: 'one done' })
    recordReportFact(store, owner.id, router.getTicket(t1.ticketId))
    router.tasks.report({ ticketId: t2.ticketId, summary: 'two done' })
    recordReportFact(store, owner.id, router.getTicket(t2.ticketId))
    const ownerSession = router.getTicket(t1.ticketId).targetSession
    running.add(ownerSession)
    await router.tick()
    const digestPromptsBefore = calls.prompt.filter(p => p.sessionId === 'session-chief')
    assert.equal(digestPromptsBefore.length, 0, 'owner still running — the digest waits (每次唤醒至多一条)')
    running.clear()
    advance(2000) // the postpone backoff elapses
    await router.tick()
    const digestPrompts = calls.prompt.filter(p => p.sessionId === 'session-chief')
    assert.equal(digestPrompts.length, 1, 'one outward digest for two reports')
    assert.ok(digestPrompts[0].text.includes('[hub-bot 汇报 repo-'))
    assert.ok(digestPrompts[0].text.includes(t1.ticketId) && digestPrompts[0].text.includes(t2.ticketId))
    assert.match(digestPrompts[0].text, /one done/)
    assert.match(digestPrompts[0].text, /two done/)
  } finally { cleanup() }
})

test('reply rows addressable to a session are actually delivered (统一出口), others are recorded intents', async () => {
  const { router, registry, calls, cleanup } = chainFixture()
  try {
    registry.bindSession('chief', 'session-chief')
    const sent = await router.replySource({ text: '给用户的一句话', to: 'dsh:session:chief' })
    assert.equal(sent.state, 'sent')
    const prompt = calls.prompt.find(p => p.sessionId === 'session-chief')
    assert.ok(prompt, 'the reply reached the chief session — the unified outlet')
    assert.match(prompt.text, /给用户的一句话/)
    const feishu = await router.replySource({ text: '飞书答复', to: 'feishu:om_9' })
    // P1 双轴审查 (#64 不假装发了飞书): an undelivered external target is a RECORDED persistent intent,
    // never a fake 'sent' — a future channel scans state:'recorded' rows.
    assert.equal(feishu.state, 'recorded', 'undelivered intent is recorded, not marked sent')
    assert.equal(calls.prompt.filter(p => p.text.includes('飞书答复')).length, 0, 'no session delivery for external targets')
    const plain = await router.replySource({ text: '默认去向' })
    assert.equal(plain.state, 'recorded', 'the default dsh target without a channel is recorded, not sent')
  } finally { cleanup() }
})

test('autoReport: OFF by default (no rows); when enabled a forced tick posts one truncated summary', async () => {
  const off = chainFixture()
  try {
    const owner = off.registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    await off.router.routeToOwner({ ownerId: owner.id, message: 'x' })
    const res = await off.router.autoReportTick({ force: true })
    assert.equal(res.skipped, 'disabled', '开关默认关 — 无自动汇报')
    assert.equal(off.router.listOutbox().filter(r => r.kind === 'reply').length, 0)
  } finally { off.cleanup() }

  const on = chainFixture({ reporting: { auto: true, intervalMs: 60000 } })
  try {
    const owner = on.registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    on.registry.bindSession('chief', 'session-chief')
    const t = await on.router.routeToOwner({ ownerId: owner.id, message: 'x' })
    on.router.tasks.report({ ticketId: t.ticketId, summary: '落地完成' })
    const first = await on.router.autoReportTick()
    assert.equal(first.skipped, undefined)
    const again = await on.router.autoReportTick()
    assert.equal(again.skipped, 'interval')
    on.advance(60000)
    const t2 = await on.router.routeToOwner({ ownerId: owner.id, message: 'y' })
    on.router.tasks.report({ ticketId: t2.ticketId, summary: '第二个结果落地' })
    const third = await on.router.autoReportTick()
    assert.equal(third.skipped, undefined, 'interval elapsed AND the status changed — a fresh summary fires')
    const replies = on.router.listOutbox().filter(r => r.kind === 'reply')
    assert.equal(replies.length, 2)
    assert.ok(replies[0].body.includes('[hub-bot 定时汇总]'))
    assert.match(replies[0].body, /等您验收/)
    assert.match(replies[0].body, /落地完成/)
    const chiefPrompts = on.calls.prompt.filter(p => p.sessionId === 'session-chief')
    assert.equal(chiefPrompts.length, 2, 'summaries delivered to the chief session')
  } finally { on.cleanup() }
})

test('queryTasks rows are lossless JSON (detail null, never undefined — tool output schema)', async () => {
  const { router, registry, cleanup } = chainFixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const t = await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    const rows = router.queryTasks({})
    const row = rows.find(r => r.id === t.ticketId)
    assert.ok('detail' in row, 'detail key present')
    assert.equal(row.detail, null, 'working ticket has no face detail — null, not undefined')
    JSON.parse(JSON.stringify(rows)) // round-trip must not drop anything
  } finally { cleanup() }
})

test('autoReport never repeats an unchanged summary (dev 实证: chief 收到第八份重复汇总)', async () => {
  const { router, registry, cleanup } = chainFixture({ reporting: { auto: true, intervalMs: 60000 } })
  try {
    registry.bindSession('chief', 'session-chief')
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    await router.routeToOwner({ ownerId: owner.id, message: 'x' })
    const first = await router.autoReportTick({ force: true })
    assert.equal(first.skipped, undefined)
    const second = await router.autoReportTick({ force: true })
    assert.equal(second.skipped, 'unchanged', 'same status, no new words')
    assert.equal(router.listOutbox().filter(r => r.kind === 'reply').length, 1)
  } finally { cleanup() }
})

test('autoReport with no active tasks stays silent (只在结果可用或需要行动时说话)', async () => {
  const { router, registry, cleanup } = chainFixture({ reporting: { auto: true, intervalMs: 60000 } })
  try {
    registry.bindSession('chief', 'session-chief')
    const res = await router.autoReportTick({ force: true })
    assert.equal(res.skipped, 'empty')
    assert.equal(router.listOutbox().filter(r => r.kind === 'reply').length, 0)
  } finally { cleanup() }
})
test("legacy 'review' tickets surface as person/review in queryTasks", async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const legacy = { id: 'tsk-legacy', triggerId: 'trg-l', owner: owner.id, stage: 'review', mechanism: 'inject', targetSession: 's', requestId: 'r', authorization: { actor: 'user', source: 'dsh', at: 'x' }, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: 'x' }
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(legacy.id, JSON.stringify(legacy))
    const rows = router.queryTasks({})
    assert.equal(rows[0].stage, 'person/review')
    assert.equal(rows[0].stageText, '等您验收')
  } finally { cleanup() }
})

test('restart auto-resume respects execution slots: the overflow demotes to queued with a held injection (#72 闸门)', async () => {
  const { router, registry, store, calls, cleanup } = fixture({ config: { concurrency: { slotsPerOwner: 1 } } })
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const a = await router.routeToOwner({ ownerId: owner.id, message: '任务A' })
    const b = await router.routeToOwner({ ownerId: owner.id, message: '任务B' }) // 槽满 → queued + held
    assert.equal(router.getTicket(b.ticketId).stage, 'queued')
    router.tasks.promote(b.ticketId) // 模拟崩溃前 B 也占着槽（如 slot 配置从 2 收紧到 1 前的现场）
    assert.equal(router.getTicket(b.ticketId).stage, 'working')
    await router.markRestart()
    assert.equal(router.getTicket(a.ticketId).stage, 'working', '最旧优先：A 留在槽内')
    assert.equal(router.getTicket(b.ticketId).stage, 'queued', '溢出票让位排队')
    const heldRow = router.listOutbox().find(r => r.ticketId === b.ticketId && r.kind === 'inject')
    assert.ok(heldRow, 'B 的恢复注入已存（先存后做）')
    assert.equal(heldRow.state, 'held', '溢出注入 held 等位')
    // A 完成让出槽 → B 被提升、held 行释放、恢复注记随投递带上
    router.tasks.report({ ticketId: a.ticketId, summary: 'done' })
    await router.routeToOwner({ ownerId: owner.id, ticketId: a.ticketId, message: '验收', resolution: 'accept' })
    await router.tick()
    assert.equal(router.getTicket(b.ticketId).stage, 'working', '槽空后 B 自动提升')
    const bPrompts = calls.prompt.filter(p => p.text.includes(b.ticketId))
    assert.ok(bPrompts.some(p => p.text.includes('[hub-bot 恢复 ' + b.ticketId + ']')), 'B 的恢复注入送达')
    assert.ok(bPrompts.some(p => p.text.startsWith(RECOVERY_NOTE)), 'B 的恢复注记随释放投递（由该票最旧的存行携带，恰好一次）')
    assert.equal(router.getTicket(b.ticketId).recoveryPending, undefined)
  } finally { cleanup() }
})

// ---------- S01 (#32 stage01-reliability): 取消/失败与投递竞态 ----------

/**
 * S01 (#32 stage01-reliability) 取消后仍在排队的重试行 / a cancelled ticket's still-queued retry row.
 * 先存后做 stores the injection row BEFORE delivery, so a transient failure leaves a 'queued' row with a 2s
 * backoff. If a human cancels the ticket while that retry is pending, the retry must NOT inject: the ticket
 * face (票面权威) is 'done', and the row must land terminal instead of staying queued forever. The same
 * verdict must hold after a restart: a fresh Router over the same store re-scans 'queued' rows and must
 * reach the same conclusion. Deferred promises only (no timers), nothing asserted before the awaits settle.
 */
test('S01 regression: a cancelled ticket is never injected again by its queued retry row, not even after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
  registry.bindSession(owner.id, 'session-live')
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const clock = () => new Date(nowMs).toISOString()
  let prompts = 0
  const router = new Router({ store, registry, now: clock, sessions: {
    create: async () => { throw new Error('must not be called') },
    prompt: async () => { prompts++; const error = new Error('provider overloaded'); error.name = 'RemoteError'; throw error },
  } })
  try {
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '一个会被取消的活' })
    assert.equal(receipt.stage, 'idle', '首次投递失败 → 票停在待触发（先存后做）')
    const row = router.listOutbox().find(r => r.ticketId === receipt.ticketId)
    assert.equal(row.state, 'queued', '重试仍在 queued 等 2s 退避')
    // 人在退避期间取消任务：票面走到终态 done
    router.tasks.cancel(receipt.ticketId, { by: 'user', reason: '人取消了这个任务' })
    assert.equal(router.getTicket(receipt.ticketId).stage, 'done', '前置条件：退避期间票被取消')
    // 退避到期后的下一轮 tick：绝不注入（也不抛错），行落终态而不是永远排队
    nowMs += 2000
    await router.tick()
    assert.equal(prompts, 1, '取消后到期的那次重试不得再注入（票面权威）')
    assert.notEqual(router.listOutbox().find(r => r.id === row.id).state, 'queued', '被跳过的行必须落终态，不得永远 queued')
    const cancelled = router.getTicket(receipt.ticketId)
    assert.equal(cancelled.stage, 'done', '票面仍是 done（旧快照没有复活它）')
    assert.ok((cancelled.transitions ?? []).some(t => t.to === 'done'), '取消这一步留在审计历史里')
    // 重启/重载：同一 store 上的一台新 Router 重新扫描存行 —— 结论必须一样
    const restartPrompts = []
    const restarted = new Router({ store, registry, now: clock, sessions: {
      create: async () => { throw new Error('must not be called') },
      prompt: async request => { restartPrompts.push(request); return { accepted: true } },
    } })
    restarted.runner.enqueue({ ticketId: receipt.ticketId, kind: 'inject', to: 'session:session-live', body: '重启后才被扫到的旧存行', requestId: 'req-s01-restart' })
    await restarted.tick()
    assert.equal(restartPrompts.length, 0, '重启后重新扫描也不得给已取消的票注入')
    assert.equal(restarted.getTicket(receipt.ticketId).stage, 'done', '重启后票面仍是 done')
    assert.notEqual(restarted.listOutbox().find(r => r.requestId === 'req-s01-restart').state, 'queued', '重启后跳过的行同样落终态')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

/**
 * S01 (#32 stage01-reliability) 重建 Session 期间被取消 / cancelled while an awaited Session rebuild is in
 * flight. The delivery sits inside `await sessions.create(...)` (the owner Session was deleted, so the first
 * prompt failed and the router is rebuilding it) and the human cancels the ticket during that await. The stale
 * snapshot taken BEFORE the await must not be written back: the ticket stays done, the rebuild is never
 * injected a second time, and the stored row lands terminal instead of staying queued. The deferred rebuild
 * gate is released BEFORE any assertion so a red run fails on a count, never hangs.
 */
test('S01 regression: a cancel during an awaited Session rebuild is honoured once and the terminal stage is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
  registry.bindSession(owner.id, 'session-live')
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  let prompts = 0
  let creates = 0
  let releaseRebuild
  const rebuildGate = new Promise(resolve => { releaseRebuild = resolve })
  let markRebuildStarted
  const rebuildStarted = new Promise(resolve => { markRebuildStarted = resolve })
  const router = new Router({ store, registry, now: () => new Date(nowMs).toISOString(), sessions: {
    create: async () => { creates++; markRebuildStarted(); await rebuildGate; return { sessionId: 'session-rebuilt' } },
    prompt: async request => {
      prompts++
      if (request.sessionId === 'session-live') {
        const error = new Error('session ' + request.sessionId + ' is absent from persistence')
        error.name = 'ApiSessionNotFound'
        throw error
      }
      return { accepted: true }
    },
  } })
  try {
    const routing = router.routeToOwner({ ownerId: owner.id, message: '会话被删了要重建' })
    await rebuildStarted // 投递已进入「重建 Session」的 await（纯 promise 同步点，无定时器）
    const ticketId = router.queryTasks({})[0].id
    router.tasks.cancel(ticketId, { by: 'user', reason: '重建在途时人取消了' })
    assert.equal(router.getTicket(ticketId).stage, 'done', '前置条件：重建在途时票被取消')
    releaseRebuild() // 先放行再断言：红灯只会挂在计数上，绝不卡死
    const receipt = await routing
    assert.equal(receipt.stage, 'done', '收据朗读票面真实状态（取消就是 done，不假装送达）')
    assert.equal(creates, 1, '只重建一次 Session')
    assert.equal(prompts, 1, '重建之后绝不再注入第二次（一次投递决定）')
    const settled = router.getTicket(ticketId)
    assert.equal(settled.stage, 'done', '旧快照不得把已取消的票复活成 working/idle')
    assert.ok((settled.transitions ?? []).some(t => t.to === 'done'), '取消的审计记录保留')
    assert.equal(settled.lastDelivery, undefined, '没注入就不许记 lastDelivery（不假装送达 #64）')
    assert.notEqual(router.listOutbox().find(r => r.ticketId === ticketId).state, 'queued', '被跳过的存行必须落终态，不得永远 queued')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

/**
 * S01 (#32 stage01-reliability) 重建期间上游失败 / a failure recorded while the awaited rebuild is in
 * flight. The ticket face becomes 'failed' (with its reason and audit trail) before the deliverer's stale
 * pre-await snapshot would be merged back. A metadata-only merge must never resurrect the terminal stage nor
 * erase the recorded history (transitions / failed / authorization / trigger binding) — and the ticket must
 * not be injected afterwards. The rebuild gate is released BEFORE any assertion (red fails on a count).
 */
test('S01 regression: an old delivery snapshot cannot resurrect a failed ticket nor erase its recorded history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
  registry.bindSession(owner.id, 'session-live')
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  let prompts = 0
  let creates = 0
  let releaseRebuild
  const rebuildGate = new Promise(resolve => { releaseRebuild = resolve })
  let markRebuildStarted
  const rebuildStarted = new Promise(resolve => { markRebuildStarted = resolve })
  const router = new Router({ store, registry, now: () => new Date(nowMs).toISOString(), sessions: {
    create: async () => { creates++; markRebuildStarted(); await rebuildGate; return { sessionId: 'session-rebuilt' } },
    prompt: async request => {
      prompts++
      if (request.sessionId === 'session-live') {
        const error = new Error('session ' + request.sessionId + ' is absent from persistence')
        error.name = 'ApiSessionNotFound'
        throw error
      }
      return { accepted: true }
    },
  } })
  try {
    const routing = router.routeToOwner({ ownerId: owner.id, message: '重建在途时会失败的活' })
    await rebuildStarted // 投递已进入「重建 Session」的 await
    const ticketId = router.queryTasks({})[0].id
    const before = router.getTicket(ticketId)
    router.tasks.fail({ ticketId, reason: '上游执行失败（票面权威）' })
    assert.equal(router.getTicket(ticketId).stage, 'failed', '前置条件：重建在途时票面失败')
    releaseRebuild() // 先放行再断言：红灯只会挂在计数上，绝不卡死
    const receipt = await routing
    assert.equal(receipt.stage, 'failed', '收据朗读票面真实状态（失败就是 failed，不假装送达）')
    assert.equal(creates, 1, '只重建一次 Session')
    assert.equal(prompts, 1, '重建之后绝不再注入（失败是终态）')
    const settled = router.getTicket(ticketId)
    assert.equal(settled.stage, 'failed', '旧快照不得把失败的票复活成 idle/working')
    assert.equal(settled.failed?.reason, '上游执行失败（票面权威）', '失败原因（审计历史）原样保留')
    assert.ok((settled.transitions ?? []).some(t => t.to === 'failed'), '失败这一步留在审计历史里')
    assert.deepEqual(settled.authorization, before.authorization, '授权记录不因元数据合并而丢失')
    assert.equal(settled.triggerId, before.triggerId, '触发绑定不因元数据合并而丢失')
    assert.equal(settled.createdAt, before.createdAt, '创建时间不因元数据合并而改写')
    assert.equal(settled.lastDelivery, undefined, '没注入就不许记 lastDelivery（不假装送达 #64）')
    assert.notEqual(router.listOutbox().find(r => r.ticketId === ticketId).state, 'queued', '被跳过的存行必须落终态，不得永远 queued')
    // 之后再 tick 也不得给这张终态票补注入
    await router.tick()
    assert.equal(prompts, 1, '失败终态票在后续 tick 中同样不得被注入')
    assert.equal(router.getTicket(ticketId).stage, 'failed', '后续 tick 也不得复活终态票')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

for (const outcome of ['accepted', 'missing']) {
  test('S01 records the ' + outcome + ' initial prompt accurately after cancellation', { timeout: 2500 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-bot-s01-in-flight-'))
    const store = new Store(dir)
    const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
    const owner = registry.create({ kind: 'repo', workspace: 'Fixture', cwd: dir })
    registry.bindSession(owner.id, 'existing-owner')
    const started = Promise.withResolvers()
    const settle = Promise.withResolvers()
    let creates = 0
    const sessions = {
      create: async () => { creates++; return { sessionId: 'replacement-owner' } },
      prompt: async () => {
        started.resolve()
        await settle.promise
        if (outcome === 'missing') {
          throw Object.assign(new Error('fixture source session not found'), { name: 'ApiSessionNotFound' })
        }
        return { accepted: true }
      },
    }
    const router = new Router({ store, registry, sessions })
    try {
      const request = router.routeToOwner({ ownerId: owner.id, message: 'fixture work' })
      await started.promise
      const row = router.listOutbox().find(entry => entry.kind === 'inject')
      const cancelled = router.tasks.cancel(row.ticketId, { by: 'user', reason: 'fixture cancellation' })
      settle.resolve()
      await request
      const saved = router.listOutbox().find(entry => entry.id === row.id)
      const ticket = router.getTicket(row.ticketId)
      assert.equal(ticket.stage, 'done')
      assert.deepEqual(ticket.transitions, cancelled.transitions)
      assert.equal(creates, 0)
      assert.equal(saved.state, outcome === 'accepted' ? 'sent' : 'recorded')
      if (outcome === 'missing') assert.equal(saved.skipReason, 'ticket-terminal')
    } finally {
      settle.resolve()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('a routed request survives a failed session create and reopens with its saved authorization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-bot-route-recovery-'))
  let now = '2026-11-15T00:00:00.000Z'
  let failCreate = true
  const prompts = []
  const sessions = {
    async create() {
      if (failCreate) { failCreate = false; throw new Error('fixture session creation unavailable') }
      return { sessionId: 'recovered-session' }
    },
    async prompt(request) { prompts.push(request); return { accepted: true } },
  }
  let store
  function open() {
    store?.close()
    store = new Store(directory)
    const registry = new OwnerRegistry(store, { scratchRoot: join(directory, 'scratch') })
    const owner = registry.create({ kind: 'repo', workspace: 'Route fixture', cwd: directory })
    return { owner, router: new Router({ store, registry, sessions, now: () => now }) }
  }
  try {
    let { owner, router } = open()
    const authorization = { actor: 'original sender', source: 'dsh', at: now }
    const input = { ownerId: owner.id, message: 'original request', triggerRef: 'route-restart-fixture', authorization }
    const receipt = await router.routeToOwner(input)
    assert.equal(receipt.stage, 'idle')
    assert.equal(prompts.length, 0)
    const saved = router.listOutbox().find(row => row.ticketId === receipt.ticketId)
    assert.equal(saved.state, 'queued')
    assert.equal(saved.requestId, receipt.requestId)
    ;({ owner, router } = open())
    now = '2026-11-15T00:00:05.000Z'
    await router.tick()
    const duplicate = await router.routeToOwner({ ...input, message: 'untrusted replay text' })
    assert.equal(duplicate.deduped, true)
    assert.equal(duplicate.ticketId, receipt.ticketId)
    assert.deepEqual(router.getTicket(receipt.ticketId).authorization, authorization)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].requestId, receipt.requestId)
    assert.match(prompts[0].text, /original request/)
    assert.equal(router.getTicket(receipt.ticketId).stage, 'working')
  } finally {
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('overlapping stop requests are recorded without interrupting the next turn', { timeout: 2500 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-bot-stop-overlap-'))
  const store = new Store(directory)
  const registry = new OwnerRegistry(store, { scratchRoot: join(directory, 'scratch') })
  registry.ensureChief({ cwd: directory, workspace: 'Fixture' })
  registry.bindSession('chief', 'fixture-chief')
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const cancelled = []
  let turn = 'first'
  const router = new Router({ store, registry, sessions: {
    async cancel({ sessionId }) {
      assert.equal(sessionId, 'fixture-chief')
      cancelled.push(turn)
      entered.resolve()
      await release.promise
      return { accepted: true }
    },
  } })
  const stop = number => {
    const at = '2026-11-15T00:00:00.000Z'
    const messageId = 'stop-fixture-' + number
    return router.acceptFeishuTrigger({
      id: 'feishu-' + messageId, kind: 'feishu', message: '停止', at,
      source: { chatId: 'fixture-chat', messageId, addressing: 'direct' },
      authorization: { actor: 'fixture-user', source: 'feishu', at },
    })
  }
  try {
    const first = stop(1)
    await entered.promise
    const second = await stop(2)
    assert.equal(second.queued, false)
    release.resolve()
    await first
    turn = 'next'
    await router.tick()
    assert.deepEqual(cancelled, ['first'])
    const saved = router.listOutbox().find(row => row.id === second.outboxId)
    assert.equal(saved.state, 'recorded')
    assert.equal(saved.skipReason, 'interrupt-in-flight')
  } finally {
    release.resolve()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('background GitHub work stays independent and respects its stable owner’s slots', async () => {
  const { router, registry, calls, cleanup } = fixture({ config: { concurrency: { slotsPerOwner: 2 } } })
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Fixture project', cwd: '/repos/project' })
    registry.bindSession(owner.id, 'owner-before')
    await router.routeToOwner({ ownerId: owner.id, message: 'regular owner work' })
    const authorization = { actor: 'fixture-user', source: 'github', at: '2026-11-15T00:00:00.000Z' }
    const event = number => ({
      ownerId: owner.id, triggerRef: 'github:fixture/project:issue:' + number, authorization,
      source: { kind: 'github', repo: 'fixture/project', issueNumber: number }, message: 'fixture issue ' + number,
    })
    const first = await router.routeBackground(event(1))
    const second = await router.routeBackground(event(2))
    const duplicate = await router.routeBackground(event(1))
    assert.equal(first.stage, 'working')
    assert.equal(second.stage, 'queued')
    assert.equal(duplicate.ticketId, first.ticketId)
    const worker = router.getTicket(first.ticketId).workerSession.sessionId
    assert.notEqual(worker, 'owner-before')
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].agentPreset, undefined)
    assert.equal(router.getTrigger(event(1).triggerRef).policy.mode, 'independent')
    assert.deepEqual(router.getTicket(first.ticketId).authorization, authorization)
    await assert.rejects(router.reportBackground({ ticketId: first.ticketId, sessionId: 'owner-before', summary: 'wrong caller' }), { code: 'background-worker-mismatch' })
    registry.bindSession(owner.id, 'owner-after')
    await router.reportBackground({ ticketId: first.ticketId, sessionId: worker, summary: 'fixture finished' })
    await router.tick()
    assert.equal(router.getTicket(first.ticketId).stage, 'person/review')
    const secondWorker = router.getTicket(second.ticketId).workerSession.sessionId
    assert.notEqual(secondWorker, worker)
    assert.equal(registry.get(owner.id).sessionId, 'owner-after')
    assert.ok(calls.prompt.some(prompt => prompt.sessionId === 'owner-after' && prompt.text.includes('fixture finished')))
  } finally { cleanup() }
})

test('restart resumes interrupted background work in its original execution sessions', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Recovery fixture', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'owner-recovery-fixture')
    const receipts = []
    for (const kind of ['github', 'timer']) {
      const authorization = { actor: 'fixture-user', source: kind, at: router.now() }
      const source = kind === 'timer' ? { kind, timerId: 'restart-fixture', fireAt: router.now() } : { kind, repo: 'fixture/repo', issueNumber: 1 }
      receipts.push(await router.routeBackground({ ownerId: owner.id, message: kind + ' fixture work',
        triggerRef: kind + ':restart-fixture:1', authorization, source }))
    }
    const original = receipts.map(receipt => router.getTicket(receipt.ticketId))
    let busy = true
    router.sessions.isRunning = async sessionId => busy && sessionId === original[1].workerSession.sessionId
    const restarted = new Router({ store, registry, sessions: router.sessions, now: router.now })
    assert.deepEqual(await restarted.markRestart(), { resumed: 2, queued: 0 })
    assert.equal(calls.prompt.filter(prompt => prompt.text.startsWith(RECOVERY_NOTE)).length, 1)
    assert.equal(restarted.getTicket(original[1].id).recoveryPending, true)
    busy = false
    advance(1000)
    await restarted.tick()
    assert.equal(calls.create.length, 2)
    const recovery = calls.prompt.filter(prompt => prompt.text.startsWith(RECOVERY_NOTE))
    assert.deepEqual(recovery.map(prompt => prompt.sessionId), original.map(ticket => ticket.workerSession.sessionId))
    for (const [index, old] of original.entries()) {
      const current = restarted.getTicket(old.id)
      assert.equal(current.triggerId, old.triggerId)
      assert.deepEqual(current.authorization, old.authorization)
      assert.deepEqual(current.lastDelivery, old.lastDelivery)
      assert.equal(current.recoveryPending, undefined)
      assert.equal(current.assignments.at(-2).endReason, 'host restarted')
      assert.equal(current.assignments.at(-1).state, 'running')
      assert.ok(recovery[index].text.includes(old.id))
    }
  } finally { cleanup() }
})

test('a local timer result records a panel-only outcome without channel delivery', async () => {
  const { router, registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'dir', cwd: '/repos/local-timer' })
    const source = { kind: 'timer', timerId: 'local-fixture', occurrenceId: '1', fireAt: router.now() }
    const authorization = { actor: 'fixture-local', source: 'timer', at: router.now() }
    const launch = await router.routeBackground({ ownerId: owner.id, message: 'fixture local timer', triggerRef: 'timer:local-fixture:1', source, authorization })
    await router.reportBackground({ ticketId: launch.ticketId, sessionId: launch.workerSession.sessionId, summary: 'Fixture result' })
    const run = router.runs.get('run-' + launch.ticketId)
    assert.equal(run.stage, 'person/review')
    assert.equal(run.status, 'silent')
    assert.equal(run.decisions.at(-1).reasonCode, 'local-panel')
    assert.equal(run.notification, null)
    assert.equal(run.result.kind, 'result')
    assert.equal(router.listOutbox().some(row => row.kind === 'reply'), false)
  } finally { cleanup() }
})

test('a paused recurring occurrence leaves the next owner slot available and resumes its saved request', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture({ config: { concurrency: { slotsPerOwner: 1 } } })
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Paused occurrence', cwd: '/repos/fixture' })
    const work = await router.routeToOwner({ ownerId: owner.id, message: 'occupy the owner slot' })
    const { TimerService } = await import('../src/timers.js')
    const timers = new TimerService({ store, now: router.now, getOwner: id => registry.get(id), getTicket: id => router.getTicket(id),
      routeBackground: request => router.routeBackground(request) })
    router.timerDeliveryState = (id, ref) => timers.deliveryState(id, ref)
    const timer = timers.create({ ownerId: owner.id, createdBy: 'fixture-owner', message: 'queued recurring check',
      schedule: { frequency: 'daily', time: '08:01' } })
    advance(60_000)
    await timers.tick()
    const { ticketId } = timers.get(timer.id).delivery
    const requestId = router.getTicket(ticketId).requestId
    assert.equal(router.getTicket(ticketId).stage, 'queued')
    timers.pause(timer.id)
    const later = await router.routeToOwner({ ownerId: owner.id, message: 'later user request' })
    router.tasks.report({ ticketId: work.ticketId, summary: 'released the slot' })
    await router.tick()
    assert.equal(router.getTicket(ticketId).stage, 'queued')
    assert.equal(router.getTicket(later.ticketId).stage, 'working')
    assert.equal(calls.prompt.some(call => call.requestId === requestId), false)
    router.tasks.report({ ticketId: later.ticketId, summary: 'released the slot again' })
    timers.resume(timer.id)
    advance(1000)
    await router.tick()
    assert.equal(calls.prompt.filter(call => call.requestId === requestId).length, 1)
    assert.equal(timers.get(timer.id).delivery.state, 'sent')
  } finally { cleanup() }
})

test('separate occurrences reuse the same follow-up worker without reusing the owner', async () => {
  const { router, registry, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Fixture project', cwd: '/repos/project' })
    registry.bindSession(owner.id, 'fixture-owner')
    const authorization = { actor: 'fixture-user', source: 'timer', at: '2026-11-15T00:00:00.000Z' }
    const fire = n => router.routeBackground({
      ownerId: owner.id, triggerRef: 'timer:fixture-timer:' + n, authorization, message: 'fixture follow-up',
      source: { kind: 'timer', timerId: 'fixture-timer', occurrenceId: String(n) },
    })
    const first = await fire(1)
    const second = await fire(2)
    const ticket1 = router.getTicket(first.ticketId)
    const ticket2 = router.getTicket(second.ticketId)
    assert.notEqual(ticket1.id, ticket2.id)
    assert.equal(ticket1.workerSession.sessionId, ticket2.workerSession.sessionId)
    assert.notEqual(ticket1.workerSession.sessionId, 'fixture-owner')
    assert.equal(calls.create.length, 1)
    assert.equal(calls.prompt.length, 2)
    assert.notEqual(calls.prompt[0].requestId, calls.prompt[1].requestId)
  } finally { cleanup() }
})

test('an exhausted approval cannot restart the original work at a changed target', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture({ config: { security: { dangerousPatterns: ['needs-approval'] } } })
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Approval failure', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'approval-before-failure')
    const install = target => target.installDeferred(new DeferredRegistry({ store, tasks: target.tasks, now: target.now,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    install(router)
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'needs-approval' })
    const { requestId } = router.getTicket(ticketId).deferred
    await router.resolveDeferred({ ticketId, requestId, decision: 'approve', channel: 'panel' })
    const originalPrompt = router.sessions.prompt
    router.sessions.prompt = async () => { throw Error('fixture rejected approval prompt') }
    for (const waitMs of [0, 2000, 4000]) {
      advance(waitMs)
      await router.tick()
    }
    assert.equal(router.listOutbox().find(row => row.requestId === 'hub-bot-approved-' + requestId).state, 'failed')
    registry.bindSession(owner.id, 'approval-after-failure')
    router.sessions.prompt = originalPrompt
    const restarted = new Router({ store, registry, sessions: router.sessions, now: router.now })
    install(restarted)
    await restarted.markRestart()
    assert.equal(calls.prompt.length, 0)
    assert.equal(restarted.getTicket(ticketId).stage, 'failed')
  } finally { cleanup() }
})

test('a timely authenticated panel answer survives a restart during the original worker check', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture()
  let reopened
  const release = Promise.withResolvers()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Panel restart', cwd: '/repos/fixture' })
    const install = (target, database) => target.installDeferred(new DeferredRegistry({ store: database, tasks: target.tasks, now: target.now,
      owners: { currentBinding: id => target.registry.get(id), isOwnerSession: id => target.registry.isOwnerSession(id) }, ttlMs: 1000 }))
    install(router, store)
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'fixture work' })
    const worker = 'panel-restart-worker'
    router.tasks.bindWorkerSession(ticketId, { sessionId: worker, cwd: owner.cwd })
    router.askWorker({ ticketId, sessionId: worker, question: 'Which fixture?' })
    const { requestId } = router.getTicket(ticketId).deferred
    const entered = Promise.withResolvers()
    router.sessions.workerInfo = async () => { entered.resolve(); return release.promise }
    advance(900)
    const receiptAt = router.now()
    const answer = router.resolveDeferred({ ticketId, requestId, decision: 'answer', text: 'durable panel reply', channel: 'panel' }).catch(error => error)
    await entered.promise
    store.close()
    advance(200)
    reopened = new Store(store.stateDir)
    const restarted = new Router({ store: reopened, registry: new OwnerRegistry(reopened, { scratchRoot: join(reopened.stateDir, 'scratch') }), now: router.now,
      sessions: { ...router.sessions, workerInfo: async () => ({ cwd: owner.cwd }) } })
    install(restarted, reopened)
    await restarted.markRestart()
    await restarted.tick()
    release.resolve({ cwd: owner.cwd })
    await answer
    const decided = restarted.deferred.get(requestId)
    assert.equal(decided.status, 'answered')
    assert.equal(decided.receivedAt, receiptAt)
    assert.equal(decided.outcome.text, 'durable panel reply')
    assert.equal(decided.outcome.delivery.state, 'sent')
    assert.deepEqual(calls.prompt.filter(prompt => prompt.requestId === 'hub-bot-answer-' + requestId).map(prompt => prompt.sessionId), [worker])
  } finally { release.resolve(); reopened?.close(); cleanup() }
})

test('a pending panel answer keeps the receipt time during host lookup and sweeping', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Panel deadline', cwd: '/repos/fixture' })
    router.installDeferred(new DeferredRegistry({ store, tasks: router.tasks, now: router.now, ttlMs: 1000,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'fixture work' })
    const sessionId = 'panel-deadline-worker'
    router.tasks.bindWorkerSession(ticketId, { sessionId, cwd: owner.cwd })
    router.askWorker({ ticketId, sessionId, question: 'Choose a value?' })
    const { requestId } = router.getTicket(ticketId).deferred
    const entered = Promise.withResolvers()
    const lookup = Promise.withResolvers()
    router.sessions.workerInfo = async () => { entered.resolve(); return lookup.promise }
    advance(900)
    const received = router.now()
    const answer = router.resolveDeferred({ ticketId, requestId, decision: 'answer', text: 'Fixture value', channel: 'panel' })
    await entered.promise
    advance(200)
    const pulse = router.tick()
    await new Promise(resolve => setImmediate(resolve))
    lookup.resolve({ cwd: owner.cwd })
    await Promise.all([answer, pulse])
    await router.tick()
    assert.equal(router.deferred.get(requestId).receivedAt, received)
    assert.equal(calls.prompt.find(prompt => prompt.requestId === 'hub-bot-answer-' + requestId).sessionId, sessionId)
  } finally { cleanup() }
})

test('an archived timer worker blocks recovery of the old occurrence and a new occurrence may create a worker', async () => {
  const { router, registry, store, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Archived worker fixture', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'timer-recovery-owner')
    const fire = (target, ordinal) => target.routeBackground({
      ownerId: owner.id, triggerRef: 'timer:archive-fixture:' + ordinal, message: 'fixture timer occurrence',
      source: { kind: 'timer', timerId: 'archive-fixture', occurrenceId: String(ordinal), fireAt: router.now() },
      authorization: { actor: 'fixture', source: 'timer', at: router.now() },
    })
    const first = await fire(router, 1)
    const originalWorker = router.getTicket(first.ticketId).workerSession.sessionId
    router.sessions.isArchived = sessionId => sessionId === originalWorker
    const restarted = new Router({ store, registry, sessions: router.sessions, now: router.now })
    await restarted.markRestart()
    await restarted.tick()
    const old = restarted.getTicket(first.ticketId)
    assert.equal(old.stage, 'blocked')
    assert.equal(old.workerSession.sessionId, originalWorker)
    assert.equal(old.lastDelivery.state, 'sent')
    assert.equal(calls.create.length, 1)
    assert.ok(calls.prompt.some(prompt => prompt.sessionId === 'timer-recovery-owner' && prompt.text.includes('原后台执行会话已归档')))
    const second = await fire(restarted, 2)
    assert.notEqual(second.workerSession.sessionId, originalWorker)
    assert.equal(calls.create.length, 2)
  } finally { cleanup() }
})

test('an exhausted initial reminder appears failed without claiming delivery', async () => {
  const { router, registry, store, advance, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Failed reminder fixture', cwd: '/repos/fixture' })
    let instant = Date.parse(router.now())
    const { TimerService } = await import('../src/timers.js')
    const timers = new TimerService({ store, now: () => instant, getOwner: id => registry.get(id),
      getTicket: id => router.getTicket(id), routeBackground: request => router.routeBackground(request) })
    router.timerDeliveryState = (id, ref) => timers.deliveryState(id, ref)
    const timer = timers.create({ ownerId: owner.id, createdBy: 'fixture-creator',
      fireAt: new Date(instant + 1000).toISOString(), message: 'fixture timer failing transport' })
    router.sessions.prompt = async () => { throw Error('fixture host unavailable') }
    instant += 1000
    advance(1000)
    await timers.tick()
    assert.equal(timers.get(timer.id).delivery.state, 'queued')
    for (const waitMs of [2000, 4000]) {
      advance(waitMs)
      instant += waitMs
      await router.tick()
    }
    const failed = timers.get(timer.id).delivery
    assert.equal(failed.state, 'failed')
    assert.equal(failed.lastError, 'fixture host unavailable')
    assert.equal(timers.cancel(timer.id).alreadyFailed, true)
    assert.equal(router.getTicket(failed.ticketId).failed.reason, 'fixture host unavailable')
  } finally { cleanup() }
})

test('a dangerous follow-up stays addressed to the owner session shown when approval was requested', async () => {
  const { router, registry, store, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Fixed owner target', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'fixed-original-owner')
    router.installDeferred(new DeferredRegistry({ store, tasks: router.tasks, now: router.now,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'fixture original work' })
    const action = { type: 'dangerous-inject', entry: 'follow-up', message: 'fixture additional work' }
    const { requestId } = router.openQuestion({ ticketId, question: 'Approving the original owner session?', action }).deferred
    registry.bindSession(owner.id, 'different-owner-session')
    await assert.rejects(router.resolveDeferred({ ticketId, requestId, decision: 'approve', channel: 'panel' }), /original owner session/)
    await router.tick()
    assert.equal(calls.prompt.length, 1)
    assert.deepEqual(router.deferred.get(requestId).target, { ownerId: owner.id, sessionId: 'fixed-original-owner' })

    const { ticketId: queuedTicket } = await router.routeToOwner({ ownerId: owner.id, message: 'fixture new work' })
    const queuedApproval = router.openQuestion({ ticketId: queuedTicket, question: 'Approve this destination?', action }).deferred.requestId
    const accepted = await router.resolveDeferred({ ticketId: queuedTicket, requestId: queuedApproval, decision: 'approve', channel: 'panel' })
    assert.equal(accepted.outcome, 'answered')
    registry.bindSession(owner.id, 'different-owner-after-approval')
    await router.tick()
    assert.equal(router.getTicket(queuedTicket).stage, 'failed')
    assert.equal(calls.prompt.some(prompt => prompt.requestId === 'hub-bot-approved-' + queuedApproval), false)
    const background = await router.routeBackground({
      ownerId: owner.id, triggerRef: 'github:fixed-owner-fixture:1', message: 'fixture background work',
      authorization: { actor: 'fixture', source: 'github', at: router.now() },
      source: { kind: 'github', repo: 'fixture/repo', issueNumber: 1 },
    })
    const backgroundApproval = router.openQuestion({ ticketId: background.ticketId, question: 'Approve this follow-up?', action }).deferred
    assert.equal(backgroundApproval.target.sessionId, 'different-owner-after-approval')
    registry.bindSession(owner.id, 'different-owner-after-background')
    await assert.rejects(router.resolveDeferred({ requestId: backgroundApproval.requestId, decision: 'approve', channel: 'panel' }), /original owner session/)
  } finally { cleanup() }
})

test('a managed worker can ask directly and an already archived worker cannot accept a reply', async () => {
  const { router, registry, store, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Managed worker', cwd: '/repos/fixture' })
    const worker = 'managed-worker'
    let archived = false
    router.sessions.isArchived = sessionId => sessionId === worker && archived
    router.sessions.workerInfo = async sessionId => sessionId === worker ? { cwd: owner.cwd } : undefined
    router.installDeferred(new DeferredRegistry({ store, tasks: router.tasks, now: router.now,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    for (const archiveAt of ['never', 'before-answer', 'after-answer']) {
      archived = false
      const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'fixture work' })
      router.tasks.bindWorkerSession(ticketId, { sessionId: worker, cwd: owner.cwd })
      assert.throws(() => router.askWorker({ ticketId, sessionId: 'different-worker', question: 'Which input?' }), /bound worker/)
      assert.equal(router.askWorker({ ticketId, sessionId: worker, question: 'Which input?' }).stage, 'person/answer')
      const { requestId } = router.getTicket(ticketId).deferred
      const answer = { ticketId, requestId, decision: 'answer', text: 'Fixture input.', channel: 'panel' }
      archived = archiveAt === 'before-answer'
      if (archived) {
        await assert.rejects(router.resolveDeferred(answer), { code: 'receiver-stale' })
      } else {
        assert.equal((await router.resolveDeferred(answer)).outcome, 'answered')
        archived = archiveAt === 'after-answer'
        await router.tick()
        assert.equal(router.deferred.get(requestId).outcome.delivery.state, archived ? 'failed' : 'sent')
      }
      const delivered = calls.prompt.find(prompt => prompt.requestId === 'hub-bot-answer-' + requestId)
      assert.equal(delivered?.sessionId, archived ? undefined : worker)
      assert.equal(router.getTicket(ticketId).stage, archived ? 'blocked' : 'working')
    }
  } finally { cleanup() }
})

test('a replaced confirmation cannot dispatch or bind work using the earlier approval', async () => {
  for (const actionType of ['dangerous-inject', 'fork']) {
    const { router, registry, store, calls, cleanup } = fixture()
    try {
      const owner = registry.create({ kind: 'repo', workspace: 'Fixture approval', cwd: '/repos/fixture' })
      registry.bindSession(owner.id, 'approval-owner')
      router.installDeferred(new DeferredRegistry({ store, tasks: router.tasks, now: router.now,
        owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
      const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'prepare fixture' })
      const sessionId = 'original-worker'
      const worker = { sessionId, cwd: '/repos/fixture' }
      let entered, release
      const reachedHost = new Promise(resolve => { entered = resolve })
      const gate = new Promise(resolve => { release = resolve })
      router.sessions.workerInfo = async () => {
        if (actionType === 'dangerous-inject') {
          entered()
          await gate
        }
        return worker
      }
      let requestedFork
      router.sessions.fork = async args => {
        requestedFork = args
        entered()
        await gate
        return { sessionId: 'fixture-fork' }
      }
      const action = actionType === 'fork'
        ? { type: actionType, sessionId, cwd: worker.cwd, atSeq: 17, reason: 'fixture fork' }
        : { type: actionType, entry: 'owner-inject', sessionId, text: 'approved fixture' }
      const waiting = router.openQuestion({ ticketId, question: 'Approve the first request?', action })
      const approval = router.resolveDeferred({ ticketId, requestId: waiting.deferred.requestId, decision: 'approve', channel: 'panel' })
      const rejected = assert.rejects(approval, { code: 'fulfillment-failed' })
      await Promise.race([reachedHost, approval])
      try {
        router.tasks.rejectConfirm({ ticketId, reason: 'The earlier wait was superseded' })
        router.tasks.resume(ticketId)
        router.tasks.askConfirm({ ticketId, question: 'Approve the later request?', action })
      } finally { release() }
      await rejected
      assert.equal(router.getTicket(ticketId).stage, 'person/confirm')
      assert.equal(router.getTicket(ticketId).workerSession, undefined)
      assert.equal(calls.prompt.some(prompt => prompt.sessionId === sessionId), false)
      if (actionType === 'fork') assert.deepEqual(requestedFork, { sessionId, atSeq: 17 })
    } finally { cleanup() }
  }
})

test('a timely Feishu answer arriving before dequeue expiry goes to the current owner exactly once', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Fixture owner', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'owner-before-answer')
    router.installDeferred(new DeferredRegistry({
      store, tasks: router.tasks, now: router.now, ttlMs: 1000,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) },
    }))
    function receive(messageId, message) {
      return router.acceptFeishuTrigger({
        id: 'feishu-' + messageId, kind: 'feishu', message, at: router.now(),
        source: { kind: 'feishu', chatId: 'fixture-origin-chat', messageId, openId: 'fixture-original-user', addressing: 'direct' },
        authorization: { actor: 'fixture-original-user', source: 'feishu', at: router.now() },
      })
    }
    const original = await receive('question-origin', 'boot fixture')
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, triggerRef: original.triggerId, message: 'fixture request' })
    const waiting = router.openQuestion({ ticketId, question: 'Which fixture file?' })
    const { requestId } = waiting.deferred
    assert.equal(waiting.stage, 'person/answer')
    const responseIntent = router.listOutbox().find(row => row.requestId === 'hub-bot-question-' + requestId)
    assert.equal(responseIntent.to, 'feishu:chat:fixture-origin-chat')
    assert.equal(responseIntent.triggerId, original.triggerId)
    await assert.rejects(router.resolveDeferred({ requestId, decision: 'answer', text: 'untrusted', channel: 'feishu',
      chatId: 'different-chat', actor: 'fixture-original-user' }), { code: 'deferred-actor-mismatch' })
    await receive('plain-text', 'answer ordinary chat')
    await router.tick()
    assert.equal(router.getTicket(ticketId).stage, 'person/answer')
    registry.bindSession(owner.id, 'owner-after-answer')
    advance(900)
    const response = '/hub-answer ' + requestId + ' answer Use the checked fixture.'
    await receive('answer-receipt', response)
    advance(1100)
    await router.tick()
    await receive('answer-receipt', response)
    await router.tick()
    const delivered = calls.prompt.filter(prompt => prompt.requestId === 'hub-bot-answer-' + requestId)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].sessionId, 'owner-after-answer')
    assert.match(delivered[0].text, /Use the checked fixture/)
    assert.equal(router.getTicket(ticketId).stage, 'working')
  } finally { cleanup() }
})

test('a structured answer commits with its intent and a discarded attempt stays discarded', async () => {
  const { router, registry, store, calls, advance, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Fixture answer discard', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'answer-fixture-owner')
    const install = target => target.installDeferred(new DeferredRegistry({ store, tasks: target.tasks, now: target.now,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    install(router)
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, message: 'fixture work' })
    const { requestId } = router.openQuestion({ ticketId, question: 'Which fixture?' }).deferred
    const answer = { requestId, ticketId, decision: 'answer', text: 'The checked fixture.', channel: 'panel' }
    store.db.exec(`CREATE TEMP TRIGGER fail_answer_outbox BEFORE INSERT ON outbox
      WHEN NEW.id LIKE 'out-answer-%' BEGIN SELECT RAISE(ABORT, 'fixture outbox write failed'); END`)
    await assert.rejects(router.resolveDeferred(answer), /fixture outbox write failed/)
    assert.equal(router.getTicket(ticketId).stage, 'person/answer')
    assert.equal(router.getTicket(ticketId).deferred.status, 'pending')
    store.db.exec('DROP TRIGGER fail_answer_outbox')
    await router.resolveDeferred(answer)
    const id = 'out-answer-' + requestId
    const originalPrompt = router.sessions.prompt
    router.sessions.prompt = async () => { throw Error('fixture session refused the answer') }
    for (const waitMs of [0, 2000, 4000]) {
      advance(waitMs)
      await router.tick()
    }
    assert.equal(router.listOutbox().find(row => row.id === id).state, 'failed')
    assert.equal(discardOutboxRows(store, [id]), 1)
    router.sessions.prompt = originalPrompt
    const restarted = new Router({ store, registry, sessions: router.sessions, now: router.now })
    install(restarted)
    await restarted.markRestart()
    await restarted.tick()
    assert.equal(restarted.listOutbox().some(row => row.id === id), false)
    assert.equal(calls.prompt.length, 1)
    assert.equal(restarted.getTicket(ticketId).stage, 'blocked')
    assert.equal(restarted.deferred.get(requestId).outcome.delivery.state, 'failed')
  } finally { cleanup() }
})

test('a background question resumes its bound worker instead of the current owner', async () => {
  const { router, registry, store, calls, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Fixture worker', cwd: '/repos/fixture' })
    registry.bindSession(owner.id, 'owner-worker-before')
    router.installDeferred(new DeferredRegistry({ store, tasks: router.tasks, now: router.now,
      owners: { currentBinding: id => registry.get(id), isOwnerSession: id => registry.isOwnerSession(id) } }))
    const work = await router.routeBackground({
      ownerId: owner.id, triggerRef: 'timer:fixture-question:1', message: 'fixture timer',
      authorization: { actor: 'fixture-creator', source: 'timer', at: router.now() },
      source: { kind: 'timer', timerId: 'fixture-question', fireAt: router.now() },
    })
    const { ticketId } = work
    const sessionId = router.getTicket(ticketId).workerSession.sessionId
    router.askWorker({ ticketId, sessionId, question: 'Choose fixture input.' })
    const { requestId } = router.getTicket(ticketId).deferred
    registry.bindSession(owner.id, 'owner-worker-after')
    const answer = { requestId, ticketId, decision: 'answer', text: 'Use this fixture.', channel: 'panel' }
    const done = await router.resolveDeferred(answer)
    assert.equal(done.outcome, 'answered')
    assert.equal((await router.resolveDeferred(answer)).duplicate, true)
    await router.tick()
    const delivered = calls.prompt.filter(prompt => prompt.requestId === 'hub-bot-answer-' + requestId)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].sessionId, sessionId)
    assert.equal(router.getTicket(ticketId).stage, 'working')
  } finally { cleanup() }
})
