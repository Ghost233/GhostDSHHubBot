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
