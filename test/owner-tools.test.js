/**
 * 负责人工具插件的观测面回归 (issue #34, v2 原生阶段一 · S03 stage01-fork)。
 *
 * RED first：fork 是重操作，切点（dsh-api-session-controller SessionForkRequest.atSeq，含边界）必须由代码可核验地
 * 交给模型 —— 证据 docs/evidence-task-7.md L63 记录过活实证缺陷：read_session 返回的消息不含事件 seq，L2 只能
 * 缺省 fork，拿不出「污染前」的精确切点。
 *
 * 本文件是本缺陷的第一条观测驱动回归：经真实插件边界（src/owner-tools.js 的 apply(ctx) 注册 read_session），
 * 对着一个假装的 Session Controller（page() 返回 DSH 真实转录页形状 record.event.{type,seq,data.message}，
 * seq 为真实数字）调用工具，断言工具结果里能观察到页面上真实的事件序号，且该序号可作为 buildForkAction 的
 * atSeq 被接受（合法含边界）。
 *
 * 只断言行为（事件序号可观测且可用作切点），不预设新的输出 schema —— 先让行为成立，形状后定。
 * 本文件同时承载同一批的身份收口回归（issue #34）：调用方必须是「当前绑定」的负责人会话、
 * 负责人实例（当前/历史/已回收）永远不是 L3 执行目标 —— 均为行为断言，不锁实现细节。
 *
 * RED first regression for issue #34: an owner reading a transcript page through the real registered
 * `read_session` tool must be able to observe the page's REAL event seq values and use one of them as the
 * inclusive fork boundary (`atSeq`) accepted by `buildForkAction`. The assertion is behavioral (the seq is
 * observable and usable), not a prescribed output schema.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { Router } from '../src/router.js'
import { buildForkAction, forkConfirmText, FORK_ACTION_TYPE } from '../src/fork.js'
import * as ownerTools from '../src/owner-tools.js'

/** registry+router over a fresh tmp store with a real owner (identity/cwd guards stay genuine). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-owner-tools-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/Volumes/home/W' })
  // 负责人身份 = 会话 id（dsh-agent 保持 agent.id === session.id）：必须有一条真实的「当前绑定」，
  // 否则 callerOwner 按设计拒绝一切调用。这里绑定的是注册表真身，不是测试假造的旁路。
  const ownerSessionId = 'session-owner-l2'
  registry.bindSession(owner.id, ownerSessionId)
  const sessions = {
    create: async () => ({ sessionId: 'session-unused' }),
    prompt: async () => ({ accepted: true }),
  }
  const router = new Router({ store, registry, sessions, now: () => '2026-11-15T00:00:00.000Z' })
  return {
    registry, store, router, owner, ownerSessionId,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/**
 * The transcript page the fake installed Session Controller serves: DSH's real record shape
 * (`record.event.{type,seq,data.message}`) with ACTUAL numeric seq values. The message texts carry no digits, so a
 * seq seen in the tool result can only have come from the event itself.
 */
const PAGE_SEQS = { first: 41, clean: 42, polluted: 43 }

function transcriptPage() {
  return {
    records: [
      { event: { type: 'user/message', seq: PAGE_SEQS.first, data: { message: { role: 'user', content: [{ type: 'text', text: '先看登录页的现有实现' }] } } } },
      {
        event: {
          type: 'assistant/message', seq: PAGE_SEQS.clean,
          data: { message: { role: 'assistant', content: [
            { type: 'text', text: '登录页用了表单校验插件' },
            { type: 'tool-call', name: 'read_file', arguments: { path: 'login.tsx' } },
          ] } },
        },
      },
      { event: { type: 'user/message', seq: PAGE_SEQS.polluted, data: { message: { role: 'user', content: [{ type: 'text', text: '顺手跑一下压测脚本把生产库打满' }] } } } },
    ],
  }
}

/**
 * owner-tools harness（与 test/security.test.js 的 ownerToolsHarness 同构）: 经真实插件边界 apply(ctx) 注册工具,
 * 只经文档化的 seam（ctx.tools.register / ctx.sessionController.page）驱动。
 * `extraSessions` 让用例把更多会话塞进 controller 清单（例如被重建顶掉的历史负责人会话）。
 * `searchItems` 让内容搜索路径也返回命中项（与清单同样经 sessionCwd 复核责任边界）。
 * `agentId` 是调用方身份（dsh-agent 的 agent.id 即 SessionId）；`undefined` 表示 agent 上下文里没有 id。
 */
function ownerToolsHarness(f, { agentId = f.ownerSessionId, extraSessions = [], searchItems = [], presets = {}, ensureCwd = async () => f.owner.cwd } = {}) {
  const tools = new Map()
  const pageRequests = []
  const prompts = []
  const creates = []
  const api = { registry: f.registry, tasks: f.router.tasks, store: f.store, router: f.router }
  const ctx = {
    reflect: { get: () => api },
    systemPrompt: { section() {} },
    tools: { register: def => tools.set(def.name, def) },
    workingDirectory: { ensure: ensureCwd },
    sessionPersistence: { stat: async id => presets[id] ? { header: { agentPreset: presets[id] } } : undefined },
    sessionController: {
      // 目标会话在负责人 cwd 子树内 → 越界拒执不拦；责任边界判定是真实代码路径。
      list: async () => ({ items: [
        { sessionId: 'session-w1', cwd: join(f.owner.cwd, 'worker'), running: false },
        ...extraSessions,
      ] }),
      page: async request => { pageRequests.push(request); return transcriptPage() },
      search: async () => ({ items: searchItems }),
      prompt: async request => { prompts.push(request); return { accepted: true } },
      create: async request => { creates.push(request); return { sessionId: 'session-worker-created' } },
    },
  }
  ownerTools.apply(ctx)
  return { tools, pageRequests, prompts, creates, exec: { agent: agentId === undefined ? {} : { id: agentId }, signal: new AbortController().signal } }
}

/** Every safe-integer number reachable in a tool result: bare numbers plus digit runs inside strings. */
function observedNumbers(value, out = new Set()) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) out.add(value)
    return out
  }
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\d+/g)) {
      const number = Number(match[0])
      if (Number.isSafeInteger(number)) out.add(number)
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) observedNumbers(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) observedNumbers(item, out)
    return out
  }
  return out
}

test('S03 regression: read_session exposes a verifiable event seq usable as fork atSeq', async () => {
  const f = fixture()
  try {
    const h = ownerToolsHarness(f)
    const tool = h.tools.get('read_session')
    assert.ok(tool && typeof tool.execute === 'function', 'read_session 经 apply(ctx) 真实注册')

    const result = await tool.execute({ sessionId: 'session-w1', maxMessages: 50 }, h.exec)
    assert.ok(result && typeof result === 'object', 'read_session 返回结果对象')

    // 只经文档化的 seam 取页：address 指向目标会话（真实插件路径，不是内部 helper）。
    assert.equal(h.pageRequests.length, 1, 'read_session 经 sessionController.page 读取真实转录页')
    assert.deepEqual(h.pageRequests[0].address, { kind: 'session', sessionId: 'session-w1' })

    // 行为断言一：转录页上真实的事件序号必须能在工具结果里被核验地观察到 —— 负责人才能表达「污染前」的切点
    // （docs/evidence-task-7.md L63 记录的活实证缺陷正是 read_session 不附带事件 seq）。
    // 模型能看到的两条通道都算数：结果值本身，以及 output.render 生成的模型可读文本（行为先立，形状后定）。
    const args = { sessionId: 'session-w1', maxMessages: 50 }
    const rendered = typeof tool.output?.render === 'function' ? tool.output.render(args, result) : undefined
    const observed = observedNumbers([result, rendered])
    // 只认页面上真实存在的序号（消息文本里不含数字，所以任何命中的序号只能来自事件本身，不可能蒙对）。
    const realSeqs = Object.values(PAGE_SEQS)
    const exposed = [...observed].filter(seq => realSeqs.includes(seq))
    assert.ok(
      exposed.length > 0,
      'read_session 结果必须暴露转录页上真实的事件序号（可核验的 fork 切点）；实际观察到: '
        + JSON.stringify([...observed]) + '；实际结果: ' + JSON.stringify(result)
        + '；模型可读文本: ' + JSON.stringify(rendered),
    )

    // 行为断言二：必须能在「污染事件之前」取到边界 —— 即存在一个可观察的、页面上真实的事件序号早于被污染的那条，
    // 否则上下文污染场景下的精确切点仍然表达不出来（只能缺省 fork）。
    const cutCandidates = exposed.filter(seq => seq < PAGE_SEQS.polluted)
    assert.ok(
      cutCandidates.length > 0,
      '必须能观察到早于污染事件（seq ' + PAGE_SEQS.polluted + '）的真实事件序号作为切点；实际可观察序号: ' + JSON.stringify(exposed),
    )

    // 行为断言三：可观察到的序号就是 fork 的含边界 atSeq —— 直接喂给 buildForkAction 不得抛错，且原样落进 action。
    const cwd = join(f.owner.cwd, 'worker')
    const reason = '会话尾巴被压测指令污染，从干净边界切出续作'
    for (const atSeq of exposed) {
      const action = buildForkAction({ sessionId: 'session-w1', cwd, reason, atSeq })
      assert.equal(action.type, FORK_ACTION_TYPE)
      assert.equal(action.atSeq, atSeq, '页面上观察到的事件序号可作为 buildForkAction 的 atSeq: ' + atSeq)
      assert.ok(forkConfirmText(action, 'tsk-s03-fork').includes(String(atSeq)), '确认文本向用户指明切点序号: ' + atSeq)
    }
  } finally { f.cleanup() }
})

/** Awaits one tool call that MUST be refused, returning the Error so the message can be asserted. */
async function rejection(promise, label) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail(label + '：本应拒绝，但调用却成功了')
  return undefined
}

/**
 * 身份收口（issue #34）：调用方身份只能是「当前绑定」的负责人会话。
 * 执行会话（worker）也住在负责人目录里，所以 cwd 相同不足以证明身份 —— 会话 id 才是身份。
 *
 * Identity hardening (issue #34): the caller is the Session id on the agent context, and only the CURRENT binding of a
 * registered L2 owner row may act. A worker Session lives in the same directory, so a cwd match alone cannot prove
 * identity; every owner tool refuses a non-owner caller before touching anything.
 */
test('S03 regression: a worker Session caller is refused by the L2 owner tools', async () => {
  const f = fixture()
  try {
    // 调用方 = 执行会话 session-w1（真实存在于 controller 清单、cwd 就在负责人目录子树内）。
    const h = ownerToolsHarness(f, { agentId: 'session-w1' })
    const read = await rejection(
      h.tools.get('read_session').execute({ sessionId: 'session-w1', maxMessages: 10 }, h.exec),
      'read_session 必须拒绝执行会话调用方',
    )
    assert.ok(read instanceof Error, 'read_session 对执行会话调用方抛错')
    assert.match(read.message, /session-w1/, '拒绝信息必须点名调用方会话（便于排查是谁越权）')
    assert.match(read.message, /not the current binding of a registered owner/, '拒绝理由：不是任何负责人行的当前绑定')

    // 其余负责人工具同样在第一步就被拦下 —— 不存在「某些工具漏拦」的旁路。
    const search = await rejection(h.tools.get('search_sessions').execute({}, h.exec), 'search_sessions 必须拒绝执行会话调用方')
    assert.match(search.message, /not the current binding of a registered owner/, 'search_sessions 同样拒绝非负责人调用方')
    const inject = await rejection(
      h.tools.get('inject_session').execute({ sessionId: 'session-w1', text: '继续实现' }, h.exec),
      'inject_session 必须拒绝执行会话调用方',
    )
    assert.match(inject.message, /not the current binding of a registered owner/, 'inject_session 同样拒绝非负责人调用方')
    const fork = await rejection(
      h.tools.get('fork_session').execute({ sessionId: 'session-w1', ticketId: 'tsk-s03-fork', reason: '走偏' }, h.exec),
      'fork_session 必须拒绝执行会话调用方',
    )
    assert.match(fork.message, /not the current binding of a registered owner/, 'fork_session 同样拒绝非负责人调用方')

    // 无副作用：被拒绝的调用没有读页、没有注入、没有落到票面。
    assert.equal(h.pageRequests.length, 0, '被拒绝的 read_session 不得读取任何转录页')
    assert.equal(h.prompts.length, 0, '被拒绝的 inject_session 不得向任何会话注入')

    // agent 上下文连 Session id 都没有时，同样拒绝（不猜身份）。
    const anonymous = ownerToolsHarness(f, { agentId: null })
    const noId = await rejection(
      anonymous.tools.get('read_session').execute({ sessionId: 'session-w1' }, anonymous.exec),
      '没有 Session id 的调用方必须被拒绝',
    )
    assert.match(noId.message, /carries no Session id/, '缺 Session id 的拒绝理由必须明说，而不是静默放行')
  } finally { f.cleanup() }
})

/**
 * 负责人会话不是 L3 执行会话（issue #34）：当前绑定、被重建顶掉的历史 id、被回收负责人的会话，
 * 都不能被 read/inject/fork 当成执行目标 —— 注入进去等于跟另一个负责人说话，或对着重建留下的孤儿干活。
 *
 * An owner instance is never an L3 execution target: a current binding, an id displaced by a rebuild, and a recycled
 * owner's Session all count. read_session/inject_session/fork_session refuse them by name instead of no-oping.
 */
test('S03 regression: an owner Session is refused as an L3 target for read/inject/fork', async () => {
  const f = fixture()
  try {
    const h = ownerToolsHarness(f)
    // 当前绑定：负责人自己的会话。
    const read = await rejection(
      h.tools.get('read_session').execute({ sessionId: f.ownerSessionId }, h.exec),
      'read_session 必须拒绝负责人会话作为目标',
    )
    assert.ok(read.message.includes(f.ownerSessionId), '拒绝信息点名被拒的目标会话')
    assert.match(read.message, /is an owner session/, '拒绝理由：这是负责人实例，不是 L3 执行会话')
    const inject = await rejection(
      h.tools.get('inject_session').execute({ sessionId: f.ownerSessionId, text: '继续实现' }, h.exec),
      'inject_session 必须拒绝负责人会话作为目标',
    )
    assert.match(inject.message, /is an owner session/, 'inject_session 同样拒绝负责人会话')
    const fork = await rejection(
      h.tools.get('fork_session').execute({ sessionId: f.ownerSessionId, ticketId: 'tsk-s03-fork', reason: '走偏' }, h.exec),
      'fork_session 必须拒绝负责人会话作为目标',
    )
    assert.match(fork.message, /is an owner session/, 'fork_session 同样拒绝负责人会话')
    assert.equal(h.pageRequests.length, 0, '被拒绝的 read_session 不得读取负责人会话的转录')
    assert.equal(h.prompts.length, 0, '被拒绝的 inject_session 不得注入负责人会话')

    // 历史 id：负责人被重建后，旧会话仍然活着 —— 它依旧是负责人实例，不能当 L3 目标。
    const current = 'session-owner-rebuilt'
    f.registry.bindSession(f.owner.id, current)
    const h2 = ownerToolsHarness(f, { agentId: current })
    const displaced = await rejection(
      h2.tools.get('read_session').execute({ sessionId: f.ownerSessionId }, h2.exec),
      '被重建顶掉的历史负责人会话也必须被拒绝',
    )
    assert.match(displaced.message, /is an owner session/, '历史（被顶掉的）负责人会话同样不是 L3 执行目标')

    // 对照组：真正的执行会话照常可读 —— 收口只针对负责人实例，不误伤 worker。
    const worker = await h2.tools.get('read_session').execute({ sessionId: 'session-w1' }, h2.exec)
    assert.ok(Array.isArray(worker.lines), '普通执行会话仍可读取（收口不误伤 worker）')
  } finally { f.cleanup() }
})

/**
 * 历史绑定不得授权（issue #34）：负责人重建后，旧会话 id 只留在历史里，绝不能再当成身份用。
 *
 * A displaced binding never authorizes: after a rebuild the old Session id is history only. Acting on it must be
 * refused, while the new CURRENT binding keeps working.
 */
test('S03 regression: a stale displaced binding does not authorize the owner tools', async () => {
  const f = fixture()
  try {
    const staleSessionId = f.ownerSessionId
    const currentSessionId = 'session-owner-current'
    f.registry.bindSession(f.owner.id, currentSessionId)

    // 旧会话（历史绑定）自称负责人：拒绝。
    const stale = ownerToolsHarness(f, { agentId: staleSessionId })
    const refused = await rejection(
      stale.tools.get('read_session').execute({ sessionId: 'session-w1' }, stale.exec),
      '历史绑定不得授权',
    )
    assert.match(refused.message, /not the current binding of a registered owner/, '历史绑定被拒的正是「不是当前绑定」')
    assert.equal(stale.pageRequests.length, 0, '被拒绝的历史绑定调用不得读取任何转录页')

    // 新绑定（当前绑定）照常工作：收口不是把工具关死。
    const live = ownerToolsHarness(f, { agentId: currentSessionId })
    const result = await live.tools.get('read_session').execute({ sessionId: 'session-w1' }, live.exec)
    assert.ok(Array.isArray(result.lines) && result.lines.length > 0, '当前绑定照常可用（只拒绝历史绑定）')
  } finally { f.cleanup() }
})

/**
 * 会话清单里的角色标注（issue #34）：当前绑定与被顶掉的历史负责人会话都标 role='owner'，
 * 让模型一眼看出「这些不能注入」，两条搜索路径（清单 / 内容搜索）判定一致。
 *
 * search_sessions tags every owner instance — current binding and displaced history — as role 'owner', so the model
 * never mistakes one for a reusable L3 worker; the list path and the content-search path classify identically.
 */
test('S03 regression: search_sessions tags current and displaced owner Sessions as owner', async () => {
  const f = fixture()
  try {
    const displacedSessionId = 'session-owner-displaced'
    const currentSessionId = 'session-owner-current'
    f.registry.bindSession(f.owner.id, displacedSessionId)
    f.registry.bindSession(f.owner.id, currentSessionId)
    const extraSessions = [
      { sessionId: currentSessionId, cwd: join(f.owner.cwd, 'live'), running: false },
      { sessionId: displacedSessionId, cwd: join(f.owner.cwd, 'displaced'), running: false },
    ]
    const h = ownerToolsHarness(f, { agentId: currentSessionId, extraSessions, searchItems: extraSessions.map(s => ({ sessionId: s.sessionId, snippet: '登录页' })) })

    // 清单路径。
    const listed = await h.tools.get('search_sessions').execute({}, h.exec)
    const roles = new Map(listed.sessions.map(s => [s.sessionId, s.role]))
    assert.equal(roles.get(currentSessionId), 'owner', '当前负责人会话在清单里标 role=owner')
    assert.equal(roles.get(displacedSessionId), 'owner', '被顶掉的历史负责人会话在清单里同样标 role=owner（否则会被误当 worker 注入）')
    assert.equal(roles.get('session-w1'), 'session', '普通执行会话不被误标为负责人')

    // 内容搜索路径：同一判定，不能出现「清单里标 owner、搜索里当 worker」的两套标准。
    const searched = await h.tools.get('search_sessions').execute({ query: '登录' }, h.exec)
    const searchRoles = new Map(searched.sessions.map(s => [s.sessionId, s.role]))
    assert.equal(searchRoles.get(currentSessionId), 'owner', '内容搜索路径同样把当前负责人会话标 role=owner')
    assert.equal(searchRoles.get(displacedSessionId), 'owner', '内容搜索路径同样把历史负责人会话标 role=owner')
  } finally { f.cleanup() }
})

test('legacy owner presets are not exposed as workers when old bindings were never stored', async () => {
  const f = fixture()
  try {
    const sessionId = 'session-v1-displaced-owner'
    assert.equal(f.registry.isOwnerSession(sessionId), false)
    const h = ownerToolsHarness(f, {
      extraSessions: [{ sessionId, cwd: f.owner.cwd, running: false }],
      searchItems: [{ sessionId, snippet: 'old owner' }],
      presets: { [sessionId]: 'hub-bot-owner' },
    })
    for (const args of [{}, { query: 'old owner' }]) {
      const { sessions } = await h.tools.get('search_sessions').execute(args, h.exec)
      assert.equal(sessions.find(item => item.sessionId === sessionId).role, 'owner')
    }
    await assert.rejects(h.tools.get('read_session').execute({ sessionId }, h.exec), /is an owner session/)
    await assert.rejects(h.tools.get('inject_session').execute({ sessionId, text: 'fixture' }, h.exec), /is an owner session/)
    await assert.rejects(h.tools.get('fork_session').execute({ sessionId, ticketId: 'fixture', reason: 'fixture' }, h.exec), /is an owner session/)
    assert.equal(h.pageRequests.length, 0)
    assert.equal(h.prompts.length, 0)
  } finally { f.cleanup() }
})

test('create_session checks ticket ownership before creating a worker', async () => {
  const f = fixture()
  try {
    const h = ownerToolsHarness(f)
    const tool = h.tools.get('create_session')
    await assert.rejects(tool.execute({ ticketId: 'missing-ticket' }, h.exec), /unknown ticket/)
    assert.equal(h.creates.length, 0)
  } finally { f.cleanup() }
})

test('create_session refuses a displaced owner after directory lookup', { timeout: 2000 }, async () => {
  const f = fixture()
  const lookupStarted = Promise.withResolvers()
  const directory = Promise.withResolvers()
  try {
    const h = ownerToolsHarness(f, { ensureCwd() {
      lookupStarted.resolve()
      return directory.promise
    } })
    const creation = h.tools.get('create_session').execute({}, h.exec)
    await lookupStarted.promise
    f.registry.bindSession(f.owner.id, 'session-new-owner')
    directory.resolve(f.owner.cwd)
    await assert.rejects(creation, /no longer the current owner binding/)
    assert.equal(h.creates.length, 0)
  } finally { directory.resolve(f.owner.cwd); f.cleanup() }
})

test('create_session validates the normalized absolute worker directory', async () => {
  const f = fixture()
  try {
    const h = ownerToolsHarness(f)
    const tool = h.tools.get('create_session')
    const adjacentDirectory = f.owner.cwd + '/sandbox/../../another-project'
    await assert.rejects(tool.execute({ cwd: adjacentDirectory }, h.exec), /outside this/)
    assert.equal(h.creates.length, 0)
  } finally { f.cleanup() }
})

test('read_session requests the chosen history page and exposes its continuation', async () => {
  const f = fixture()
  try {
    const h = ownerToolsHarness(f)
    const page = await h.tools.get('read_session').execute({ sessionId: 'session-w1', maxMessages: 12, beforeSeq: 800 }, h.exec)
    assert.deepEqual(h.pageRequests[0], {
      address: { kind: 'session', sessionId: 'session-w1' }, maxMessages: 12, beforeSeq: 800,
    })
    assert.equal(page.hasMore, false)
  } finally { f.cleanup() }
})

test('fork_session verifies the cut in the selected worker before requesting confirmation', async () => {
  const f = fixture()
  try {
    const ticket = await f.router.routeToOwner({ ownerId: f.owner.id, message: 'fixture work' })
    const h = ownerToolsHarness(f)
    const tool = h.tools.get('fork_session')
    const args = { sessionId: 'session-w1', ticketId: ticket.ticketId, reason: 'fixture clean boundary' }
    await assert.rejects(tool.execute({ ...args, atSeq: 800 }, h.exec), /fork-atseq-not-found/)
    assert.equal(f.router.getTicket(ticket.ticketId).stage, 'working')
    await tool.execute({ ...args, atSeq: PAGE_SEQS.clean }, h.exec)
    assert.deepEqual(h.pageRequests.map(request => request.throughSeq), [800, PAGE_SEQS.clean])
    const saved = f.router.getTicket(ticket.ticketId).pendingConfirm?.action
    assert.equal(saved.sessionId, 'session-w1')
    assert.equal(saved.atSeq, PAGE_SEQS.clean)
  } finally { f.cleanup() }
})

test('the worker tools refuse out-of-scope sessions before host effects', async () => {
  const f = fixture()
  try {
    const sessionId = 'fixture-sibling-worker'
    const h = ownerToolsHarness(f, { extraSessions: [{ sessionId, cwd: '/Volumes/home/sibling' }] })
    await assert.rejects(h.tools.get('read_session').execute({ sessionId }, h.exec), /outside this/)
    await assert.rejects(h.tools.get('inject_session').execute({ sessionId, text: 'fixture' }, h.exec), /outside this/)
    await assert.rejects(h.tools.get('fork_session').execute({ sessionId, ticketId: 'fixture', reason: 'fixture' }, h.exec), /outside this/)
    assert.equal(h.pageRequests.length, 0)
    assert.equal(h.prompts.length, 0)
  } finally { f.cleanup() }
})
