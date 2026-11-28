/**
 * fork 路径与确认流程（issue #69）: fork 是重操作——L2 经 fork_session 发起确认（票转 person/confirm，
 * 确认文本由代码生成：对象+预期结果+原因），用户确认（route_to_owner resolution:"confirm"）后由代码执行
 * fork（dsh-api-session-controller fork()），任务绑到新会话续作、原会话保留可查；用户否定（"reject"）票转
 * 被卡住、保持原会话；取消（"cancel"）是终态；确认超过 24h 未回应自动取消并告知（spec「错误场景」）。
 * RED first（#69 TDD）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { TaskBoard, CONFIRM_TIMEOUT_MS } from '../src/tasks.js'
import { Router } from '../src/router.js'
import { buildForkAction, forkConfirmText, confirmTicketFork, FORK_ACTION_TYPE } from '../src/fork.js'

/** A tmp store + deterministic TaskBoard. */
function boardFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-fork-'))
  const store = new Store(dir)
  let clock = 0
  const board = new TaskBoard({ store, now: () => '2026-11-15T00:00:' + String(clock++).padStart(2, '0') + '.000Z' })
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
  return { store, board, seed, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** A Router with a fake Sessions port (create/prompt/fork scriptable) and a deterministic clock. */
function routerFixture({ forkImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-fork-router-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const calls = { create: [], prompt: [], fork: [] }
  const sessions = {
    create: async request => {
      calls.create.push(request)
      return { sessionId: 'session-fake-' + calls.create.length }
    },
    prompt: async request => {
      calls.prompt.push(request)
      return { accepted: true }
    },
    fork: async request => {
      calls.fork.push(request)
      if (forkImpl) return forkImpl(request)
      return { sessionId: 'session-forked-' + calls.fork.length }
    },
  }
  const router = new Router({ store, registry, sessions, now: () => new Date(nowMs).toISOString() })
  const advance = ms => { nowMs += ms }
  return { router, registry, store, calls, advance, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** Routes one task to owner W and puts it into person/confirm with a fork action (the L2 proposal). */
async function seedPendingFork({ router }) {
  const owner = router.registry.get('repo-W') ?? router.registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
  const receipt = await router.routeToOwner({ ownerId: owner.id, message: '开发登录功能' })
  const action = buildForkAction({ sessionId: 'session-l3-polluted', cwd: '/w', reason: '原会话上下文被无关实验污染，fork 干净副本续作' })
  router.tasks.bindWorkerSession(receipt.ticketId, { sessionId: action.sessionId, cwd: action.cwd })
  router.tasks.askConfirm({ ticketId: receipt.ticketId, question: forkConfirmText(action, receipt.ticketId), action })
  return { owner, ticketId: receipt.ticketId, action }
}

test('fork action builder validates its payload (对象必填、atSeq 非负整数)', () => {
  const ok = buildForkAction({ sessionId: 'session-a', cwd: '/w', reason: '上下文污染' })
  assert.deepEqual(ok, { type: FORK_ACTION_TYPE, sessionId: 'session-a', cwd: '/w', reason: '上下文污染' })
  const withSeq = buildForkAction({ sessionId: 'session-a', cwd: '/w', reason: 'r', atSeq: 0 })
  assert.equal(withSeq.atSeq, 0, 'atSeq 0 is a legal inclusive boundary')
  assert.throws(() => buildForkAction({ sessionId: ' ', cwd: '/w', reason: 'r' }), (e) => e.code === 'fork-session-required')
  assert.throws(() => buildForkAction({ sessionId: 'session-a', cwd: '', reason: 'r' }), (e) => e.code === 'fork-cwd-required')
  assert.throws(() => buildForkAction({ sessionId: 'session-a', cwd: '/w', reason: ' ' }), (e) => e.code === 'fork-reason-required')
  assert.throws(() => buildForkAction({ sessionId: 'session-a', cwd: '/w', reason: 'r', atSeq: -1 }), (e) => e.code === 'fork-atseq-invalid')
  assert.throws(() => buildForkAction({ sessionId: 'session-a', cwd: '/w', reason: 'r', atSeq: 1.5 }), (e) => e.code === 'fork-atseq-invalid')
})

test('the confirmation text is code-built: object + expected outcome + reason, original session preserved (消息纪律)', () => {
  const action = buildForkAction({ sessionId: 'session-a', cwd: '/w', reason: '走偏', atSeq: 42 })
  const text = forkConfirmText(action, 'tsk-1')
  assert.match(text, /session-a/)
  assert.match(text, /cwd=\/w/)
  assert.match(text, /走偏/)
  assert.match(text, /tsk-1/)
  assert.match(text, /42/)
  assert.match(text, /原会话保留可查/)
  assert.match(text, /确认后/)
})

test('confirmTicketFork executes the stored fork action: ticket → working, mechanism fork, bound to the new session', async () => {
  const { board, seed, cleanup } = boardFixture()
  try {
    const t = seed('working', { workerSession: { sessionId: 'session-l3-polluted', cwd: '/w', at: '2026-11-14T01:00:00.000Z' } })
    const action = buildForkAction({ sessionId: 'session-l3-polluted', cwd: '/w', reason: '上下文污染' })
    board.askConfirm({ ticketId: t.id, question: forkConfirmText(action, t.id), action })
    const forkCalls = []
    const sessions = { fork: async request => { forkCalls.push(request); return { sessionId: 'session-fork-new' } } }
    const result = await confirmTicketFork({ tasks: board, sessions, ticketId: t.id })
    assert.deepEqual(forkCalls, [{ sessionId: 'session-l3-polluted' }], 'omitted atSeq selects the latest completed-turn prefix')
    assert.equal(result.fromSessionId, 'session-l3-polluted')
    assert.equal(result.sessionId, 'session-fork-new')
    const ticket = board.getTicket(t.id)
    assert.equal(ticket.stage, 'working', '确认后回到进行中')
    assert.equal(ticket.mechanism, 'fork')
    assert.equal(ticket.workerSession.sessionId, 'session-fork-new', '任务绑到新会话')
    assert.equal(ticket.assignments.at(-1).sessionId, 'session-fork-new')
    assert.equal(ticket.confirmOutcome.kind, 'confirmed')
    assert.equal(ticket.confirmOutcome.by, 'user')
    assert.deepEqual(ticket.confirmOutcome.result, { fork: { fromSessionId: 'session-l3-polluted', sessionId: 'session-fork-new' } })
    assert.equal(typeof ticket.pendingConfirm.text, 'string', 'pendingConfirm 留在票面供审计')
    assert.deepEqual(ticket.transitions.map(x => x.from + '>' + x.to), ['working>person/confirm', 'person/confirm>working'])
  } finally { cleanup() }
})

test('confirmTicketFork passes an explicit atSeq through to the fork call (丢掉污染的尾巴)', async () => {
  const { board, seed, cleanup } = boardFixture()
  try {
    const t = seed('working')
    const action = buildForkAction({ sessionId: 'session-l3', cwd: '/w', reason: '走偏', atSeq: 17 })
    board.askConfirm({ ticketId: t.id, question: 'q', action })
    const forkCalls = []
    await confirmTicketFork({ tasks: board, sessions: { fork: async r => { forkCalls.push(r); return { sessionId: 'session-new' } } }, ticketId: t.id })
    assert.deepEqual(forkCalls, [{ sessionId: 'session-l3', atSeq: 17 }])
  } finally { cleanup() }
})

test('confirmTicketFork failure leaves the ticket at person/confirm (重试仍可能)', async () => {
  const { board, seed, cleanup } = boardFixture()
  try {
    const t = seed('working')
    const action = buildForkAction({ sessionId: 'session-l3', cwd: '/w', reason: 'r' })
    board.askConfirm({ ticketId: t.id, question: 'q', action })
    const sessions = { fork: async () => { throw new Error('session/fork-unavailable: no completed turn') } }
    await assert.rejects(() => confirmTicketFork({ tasks: board, sessions, ticketId: t.id }), (e) => e.code === 'fork-failed')
    assert.equal(board.getTicket(t.id).stage, 'person/confirm', 'fork 失败票保持等您确认')
    // A port without fork capability fails loudly, never silently no-ops.
    await assert.rejects(() => confirmTicketFork({ tasks: board, sessions: {}, ticketId: t.id }), (e) => e.code === 'fork-unavailable')
    assert.equal(board.getTicket(t.id).stage, 'person/confirm')
    // A fork value without a session id is rejected.
    await assert.rejects(() => confirmTicketFork({ tasks: board, sessions: { fork: async () => ({}) }, ticketId: t.id }), (e) => e.code === 'fork-empty')
    assert.equal(board.getTicket(t.id).stage, 'person/confirm')
  } finally { cleanup() }
})

test('confirmTicketFork requires a person/confirm ticket carrying a fork action', async () => {
  const { board, seed, cleanup } = boardFixture()
  try {
    const working = seed('working')
    await assert.rejects(() => confirmTicketFork({ tasks: board, sessions: { fork: async () => ({ sessionId: 's' }) }, ticketId: working.id }), (e) => e.code === 'illegal-transition')
    const plain = seed('working')
    board.askConfirm({ ticketId: plain.id, question: '只是确认，不带动作' })
    await assert.rejects(() => confirmTicketFork({ tasks: board, sessions: { fork: async () => ({ sessionId: 's' }) }, ticketId: plain.id }), (e) => e.code === 'no-pending-fork')
    await assert.rejects(() => confirmTicketFork({ tasks: board, sessions: { fork: async () => ({ sessionId: 's' }) }, ticketId: 'tsk-nope' }), (e) => e.code === 'unknown-ticket')
  } finally { cleanup() }
})

test('resolution:"confirm" executes the fork, rebinds the task and wakes the owner (全链接线)', async () => {
  const { router, calls, cleanup } = routerFixture()
  try {
    const { owner, ticketId } = await seedPendingFork({ router })
    assert.equal(router.getTicket(ticketId).stage, 'person/confirm')
    const promptsBefore = calls.prompt.length
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '确认', ticketId, resolution: 'confirm' })
    assert.equal(receipt.confirmed, true)
    assert.equal(receipt.stage, 'working')
    assert.equal(receipt.fork.fromSessionId, 'session-l3-polluted')
    assert.match(receipt.fork.sessionId, /^session-forked-/)
    assert.equal(calls.fork.length, 1)
    assert.deepEqual(calls.fork[0], { sessionId: 'session-l3-polluted' })
    const ticket = router.getTicket(ticketId)
    assert.equal(ticket.stage, 'working')
    assert.equal(ticket.mechanism, 'fork')
    assert.equal(ticket.workerSession.sessionId, receipt.fork.sessionId)
    // The owner wake is stored-then-delivered (先存后做), carries the fork result and the authorization record.
    const wake = router.listOutbox().find(r => r.ticketId === ticketId && r.kind === 'inject' && r.body.includes('用户已确认 fork'))
    assert.ok(wake, 'owner wake row exists')
    assert.equal(wake.state, 'sent')
    assert.match(wake.body, new RegExp(receipt.fork.sessionId))
    assert.match(wake.body, /原会话保留可查/)
    assert.match(wake.body, /授权：user 经 dsh/)
    assert.equal(calls.prompt.length, promptsBefore + 1)
  } finally { cleanup() }
})

test('a pending legacy fork cannot use a worker after its ticket binding changes', async () => {
  const { router, calls, cleanup } = routerFixture()
  try {
    const { owner, ticketId } = await seedPendingFork({ router })
    const original = router.getTicket(ticketId)
    router.tasks.bindWorkerSession(ticketId, { sessionId: 'fixture-new-worker', cwd: owner.cwd })
    await assert.rejects(router.routeToOwner({ ownerId: owner.id, ticketId, resolution: 'confirm', message: 'Approve the old fixture' }),
      { code: 'legacy-confirm-target-invalid' })
    assert.deepEqual(calls.fork, [])
    assert.equal(router.getTicket(ticketId).stage, 'person/confirm')
    assert.deepEqual(router.getTicket(ticketId).pendingConfirm, original.pendingConfirm)
  } finally { cleanup() }
})

test('resolution:"confirm" on a fork failure keeps person/confirm and reports fork-failed', async () => {
  const { router, cleanup } = routerFixture({ forkImpl: async () => { throw new Error('session "session-l3-polluted" not found') } })
  try {
    const { owner, ticketId } = await seedPendingFork({ router })
    await assert.rejects(
      () => router.routeToOwner({ ownerId: owner.id, message: '确认', ticketId, resolution: 'confirm' }),
      (e) => e.name === 'RouterError' && e.code === 'fork-failed')
    assert.equal(router.getTicket(ticketId).stage, 'person/confirm')
  } finally { cleanup() }
})

test('resolution:"reject" refuses the fork: ticket → blocked, original session kept, fork never called', async () => {
  const { router, calls, cleanup } = routerFixture()
  try {
    const { owner, ticketId } = await seedPendingFork({ router })
    const before = router.getTicket(ticketId)
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '不用 fork，原会话继续', ticketId, resolution: 'reject' })
    assert.equal(receipt.rejected, true)
    assert.equal(receipt.stage, 'blocked')
    const ticket = router.getTicket(ticketId)
    assert.equal(ticket.stage, 'blocked', '票回被卡住')
    assert.equal(ticket.targetSession, before.targetSession, '保持原会话')
    assert.equal(ticket.mechanism, 'inject', 'mechanism 不变')
    assert.equal(ticket.confirmOutcome.kind, 'rejected')
    assert.equal(ticket.confirmOutcome.reason, '不用 fork，原会话继续')
    assert.equal(calls.fork.length, 0, 'fork 未执行')
    // 人的消息直接释放：a follow-up releases the rejected ticket back to working.
    const follow = await router.routeToOwner({ ownerId: owner.id, message: '那就在原会话小心继续', ticketId })
    assert.equal(follow.resumed, true)
    assert.equal(router.getTicket(ticketId).stage, 'working')
  } finally { cleanup() }
})

test('resolution:"cancel" on a pending fork stays the terminal cancel (done) with an audited outcome', async () => {
  const { router, calls, cleanup } = routerFixture()
  try {
    const { owner, ticketId } = await seedPendingFork({ router })
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '取消', ticketId, resolution: 'cancel' })
    assert.equal(receipt.cancelled, true)
    assert.equal(receipt.stage, 'done')
    const ticket = router.getTicket(ticketId)
    assert.equal(ticket.confirmOutcome.kind, 'cancelled')
    assert.equal(ticket.confirmOutcome.by, 'user')
    assert.equal(calls.fork.length, 0)
  } finally { cleanup() }
})

test('resolution guards: confirm needs person/confirm; unknown resolution values are rejected with the full vocabulary', async () => {
  const { router, cleanup } = routerFixture()
  try {
    const owner = router.registry.get('repo-W') ?? router.registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    const working = await router.routeToOwner({ ownerId: owner.id, message: '干活' })
    await assert.rejects(
      () => router.routeToOwner({ ownerId: owner.id, message: '确认', ticketId: working.ticketId, resolution: 'confirm' }),
      (e) => e.code === 'illegal-transition')
    await assert.rejects(
      () => router.routeToOwner({ ownerId: owner.id, message: 'x', ticketId: working.ticketId, resolution: 'bogus' }),
      (e) => e.code === 'unknown-resolution' && /confirm/.test(e.message) && /reject/.test(e.message))
  } finally { cleanup() }
})

test('确认超时：person/confirm 超过 24h 未确认自动取消（done）并告知 L1 统一出口', async () => {
  const { router, advance, cleanup } = routerFixture()
  try {
    const { ticketId } = await seedPendingFork({ router })
    assert.equal(CONFIRM_TIMEOUT_MS, 24 * 60 * 60 * 1000)
    advance(CONFIRM_TIMEOUT_MS - 1000)
    await router.tick()
    assert.equal(router.getTicket(ticketId).stage, 'person/confirm', '未到 24h 不取消')
    assert.equal(router.listOutbox().some(r => r.body && r.body.includes('已取消')), false)
    advance(2000) // now 24h+1s past pendingConfirm.at
    await router.tick()
    const ticket = router.getTicket(ticketId)
    assert.equal(ticket.stage, 'done', '超时自动取消')
    assert.equal(ticket.confirmOutcome.kind, 'timeout')
    assert.equal(ticket.confirmOutcome.by, 'system')
    const notice = router.listOutbox().find(r => r.kind === 'reply' && r.body.includes('已取消') && r.body.includes(ticketId))
    assert.ok(notice, '告知行已落库')
    assert.equal(notice.to, 'dsh:session:chief')
    assert.equal(notice.state, 'sent', '告知经统一出口实际投递（fake port）')
    // 幂等：后续 tick 不重复告知
    const rowsAfter = router.listOutbox().filter(r => r.body && r.body.includes('已取消')).length
    await router.tick()
    assert.equal(router.listOutbox().filter(r => r.body && r.body.includes('已取消')).length, rowsAfter)
  } finally { cleanup() }
})

test('fork 会话与原会话互不干扰：fork 只读源会话事件，原会话不收到任何注入', async () => {
  const { router, calls, cleanup } = routerFixture()
  try {
    const { owner, ticketId } = await seedPendingFork({ router })
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '确认', ticketId, resolution: 'confirm' })
    const original = 'session-l3-polluted'
    const injected = calls.prompt.map(p => p.sessionId)
    assert.ok(!injected.includes(original), '原会话全程未被注入（互不干扰）')
    assert.ok(injected.includes(receipt.sessionId), '唤醒只发给负责人会话')
  } finally { cleanup() }
})

/** Awaits one call that MUST throw, returning the Error so its code/message can be asserted. */
async function forkRejection(promise, label) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail(label + '：本应拒绝，但调用却成功了')
  return undefined
}

/**
 * fork 的授权与确认闸门不得被切点改动放松（issue #34, #69）：真实事件序号（read_session 暴露的那种大序号）
 * 原样穿过 action → 确认文本 → sessions.fork；且确认闸门在 fork 之前就把关 —— 票不在 person/confirm 时
 * 一次 fork 都不许发生。atSeq 只能是真实非负安全整数，编造的切点直接被拒。
 *
 * The fork authorization + confirmation gate stays intact while the cut point becomes verifiable (issue #34, #69):
 * a REAL event seq flows verbatim through action → confirm text → sessions.fork; the gate still runs BEFORE any fork
 * side effect (a ticket not at person/confirm never reaches the fork call); and a fabricated atSeq is refused.
 */
test('S03 regression: fork keeps its confirmation gate and forwards the exact real atSeq', async () => {
  const { board, seed, cleanup } = boardFixture()
  try {
    // 真实转录页上的事件序号（docs/evidence-task-12.md 记录的活实证量级：四位数全局序号，不是页内下标）。
    const realSeq = 1601
    const action = buildForkAction({ sessionId: 'session-l3', cwd: '/w', reason: '上下文被压测指令污染，从干净边界切出续作', atSeq: realSeq })
    assert.equal(action.type, FORK_ACTION_TYPE)
    assert.equal(action.atSeq, realSeq, 'buildForkAction 原样保留真实事件序号作为含边界切点')
    assert.ok(forkConfirmText(action, 'tsk-s03-fork').includes(String(realSeq)), '确认文本向用户指明真实切点序号（对象+预期结果，不靠模型自觉）')

    // 编造的切点必须被拒（不合法 → 不允许悄悄降级成「缺省 fork」）。
    for (const bogus of [-1, 1.5, '1601', Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(
        () => buildForkAction({ sessionId: 'session-l3', cwd: '/w', reason: 'r', atSeq: bogus }),
        { code: 'fork-atseq-invalid' },
        '非法 atSeq ' + JSON.stringify(bogus) + ' 必须被拒',
      )
    }

    // 确认闸门在 fork 之前：票还在 working（没到 person/confirm）→ 一次 fork 都不许发生。
    const working = seed('working')
    const earlyCalls = []
    const early = await forkRejection(
      confirmTicketFork({ tasks: board, sessions: { fork: async r => { earlyCalls.push(r); return { sessionId: 'session-nope' } } }, ticketId: working.id }),
      'working 票不得执行 fork',
    )
    assert.equal(early.code, 'illegal-transition', '票不在 person/confirm 时拒绝（确认闸门未放松）')
    assert.deepEqual(earlyCalls, [], '被闸门拦下时不得发生任何 fork 副作用')

    // 放行后：action 上的真实 atSeq 必须一字不差地传给 sessions.fork（含边界，不四舍五入、不改写）。
    const t = seed('working')
    board.askConfirm({ ticketId: t.id, question: forkConfirmText(action, t.id), action })
    const forkCalls = []
    const result = await confirmTicketFork({
      tasks: board,
      sessions: { fork: async request => { forkCalls.push(request); return { sessionId: 'session-forked-s03' } } },
      ticketId: t.id,
    })
    assert.deepEqual(forkCalls, [{ sessionId: 'session-l3', atSeq: realSeq }], 'sessions.fork 收到 { sessionId, atSeq } 原样请求（atSeq 含边界）')
    assert.equal(result.atSeq, realSeq, '回执保留真实切点序号，供审计')
    assert.equal(result.fromSessionId, 'session-l3', '回执记录源会话（原会话保留可查）')
    assert.equal(result.sessionId, 'session-forked-s03', '回执记录新会话（任务绑到新会话续作）')
    const ticket = board.getTicket(t.id)
    assert.equal(ticket.mechanism, 'fork', '确认后任务机制记为 fork')
    assert.equal(ticket.workerSession.sessionId, 'session-forked-s03', '任务绑到新会话')
    assert.equal(ticket.stage, 'working', '确认后回到进行中')
  } finally { cleanup() }
})
