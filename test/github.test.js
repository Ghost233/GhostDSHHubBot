/** GitHubSource integration tests use fake GitHub and session ports with the real Router and Store. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { DeferredRegistry } from '../src/deferred.js'
import { Router } from '../src/router.js'
import { GitHubSource, watermarkPath, DSH_BADGE } from '../src/github.js'
import { resolveConfig } from '../src/config.js'

const REPO = 'Ghost233/DSH-Workflow'
const REPO_CFG = { repo: REPO, workspace: 'DSH-Workflow', cwd: '/Volumes/home/DSH-Workflow', enabled: true }

/** Scripted GitHub responses are keyed by endpoint. POST requests are recorded locally. */
function fakeGh(script) {
  const posts = []
  const reads = []
  const gh = async (args) => {
    if (args.includes('POST')) { posts.push(args); return '{"id": 9001}' }
    reads.push(args)
    const endpoint = args[1].split('?')[0]
    const response = script[endpoint] ?? (args.includes('--slurp') ? [[]] : { state: 'open' })
    const value = typeof response === 'function' ? await response(args) : response
    if (value instanceof Error) throw value
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { gh, posts, reads }
}

function issue({ number = 42, title = '修一下登录重试', body = '正文', login = 'Ghost233', labels = [], pr = false, state = 'open' } = {}) {
  const item = {
    number, title, body, state,
    user: { login },
    labels: labels.map(name => ({ name })),
    html_url: 'https://github.com/' + REPO + '/issues/' + number,
    created_at: '2026-11-15T01:00:00Z',
  }
  if (pr) item.pull_request = { url: 'x' }
  return item
}
function comment({ id = 5001, body = '继续', login = 'Ghost233', issueNumber = 42 } = {}) {
  return { id, body, user: { login }, html_url: 'https://github.com/' + REPO + '/issues/' + issueNumber + '#issuecomment-' + id, issue_url: 'https://api.github.com/repos/' + REPO + '/issues/' + issueNumber, created_at: '2026-11-15T01:05:00Z' }
}

/** registry+router+source with fake sessions and a scripted fake gh. 监听清单跟随注册表（repo owners 的
 *  origin——fake git 按 cwd 返回 remote URL）；repo owner 已在下方注册，config 不再有 repos 列表。 */
function fixture({ allowlist = ['Ghost233'], script = {}, repos = [REPO_CFG] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-gh-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  for (const r of repos) registry.create({ kind: 'repo', workspace: r.workspace, cwd: r.cwd })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const calls = { create: [], prompt: [] }
  const sessions = {
    create: async request => { calls.create.push(request); return { sessionId: 'session-' + calls.create.length } },
    prompt: async request => { calls.prompt.push(request); return { accepted: true } },
  }
  const router = new Router({ store, registry, sessions, now: () => new Date(nowMs).toISOString() })
  const { gh, posts, reads } = fakeGh(script)
  const config = { enabled: true, intervalMs: 300000, loginAllowlist: allowlist, mentionHandle: '@hub-bot' }
  const warnings = []
  const git = async (args) => {
    const cwd = args[args.indexOf('-C') + 1]
    const match = repos.find(r => r.cwd === cwd)
    if (!match) throw new Error('git remote get-url: no origin')
    return 'https://github.com/' + match.repo + '.git\n'
  }
  const source = new GitHubSource({ store, registry, router, sessions, config, logger: { info() {}, warn: (...a) => warnings.push(a.join(' ')) }, gh, git, now: () => new Date(nowMs).toISOString() })
  return {
    source, registry, router, store, calls, posts, reads, script, gh, warnings,
    setNow: (iso) => { nowMs = Date.parse(iso) },
    triggers: () => store.db.prepare('SELECT value FROM trigger').all().map(r => JSON.parse(String(r.value))),
    tickets: () => store.db.prepare('SELECT value FROM ticket').all().map(r => JSON.parse(String(r.value))),
    outbox: () => store.db.prepare('SELECT value FROM outbox ORDER BY rowid').all().map(r => JSON.parse(String(r.value))),
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('config: the github section validates and defaults disabled with 5min polling', () => {
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: 'x' }), /config\.github must be an object/)
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: { nope: 1 } }), /does not know config\.github key/)
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: { intervalMs: 1000 } }), /intervalMs/)
  // repos 键已移除（监听清单跟随 owner 注册表）——残留旧键被严格校验拒绝
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: { repos: [{ repo: 'a/b', workspace: 'w', cwd: '/tmp/w' }] } }), /does not know config\.github key \["repos"\]/)
  assert.deepEqual(resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y' }).github, { enabled: false, intervalMs: 300000, loginAllowlist: [] })
})

test('the first poll of a repo records ONLY the watermark — 存量不触发', async () => {
  const f = fixture({ script: { ['repos/' + REPO + '/issues']: [issue({ number: 40 }), issue({ number: 41 })] } })
  try {
    const result = await f.source.pollAll()
    assert.equal(result.triggered, 0, 'existing backlog never triggers')
    assert.equal(f.calls.prompt.length, 0)
    const wm = JSON.parse(readFileSync(watermarkPath(f.store.stateDir), 'utf8'))
    assert.equal(wm.repos[REPO].maxNumber, 41)
    assert.equal(wm.repos[REPO].initialized, true)
  } finally { f.cleanup() }
})

test('a new issue above the watermark: ack recorded with the badge, routed to the repo owner with the source mark; re-poll dedups', async () => {
  const f = fixture({ script: { ['repos/' + REPO + '/issues']: [issue({ number: 41 })] } })
  try {
    await f.source.pollAll() // watermark at 41
    assert.equal(f.calls.prompt.length, 0)
    f.script['repos/' + REPO + '/issues'] = [issue({ number: 41 }), issue({ number: 42 })]
    const result = await f.source.pollAll()
    assert.equal(result.triggered, 1)
    assert.equal(f.calls.prompt.length, 1)
    const injected = f.calls.prompt[0].text
    assert.ok(injected.includes('[hub-bot github ' + REPO + '#42]'), 'source mark (同飞书机制)')
    assert.ok(injected.includes('修一下登录重试'))
    assert.ok(injected.includes("reply_source to='github:" + REPO + ":42'"), 'the reply channel address travels with the message')
    assert.ok(injected.includes('永不直推主分支'), '永不直推主分支 travels with the task')
    assert.ok(injected.includes('powered_by-dsh'), 'the badge requirement travels with the task')
    const trigger = f.triggers().find(t => t.id === 'github:' + REPO + ':issue:42')
    assert.ok(trigger, 'router trigger row carries the triggerRef')
    assert.equal(trigger.authorization.source, 'github')
    assert.equal(trigger.authorization.actor, 'Ghost233')
    const ticket = f.tickets().find(t => t.triggerId === 'github:' + REPO + ':issue:42')
    assert.ok(ticket, 'ticket 落库（先存后做）')
    assert.equal(ticket.owner, 'repo-DSH-Workflow')
    assert.equal(ticket.workerSession.sessionId, f.calls.prompt[0].sessionId)
    assert.equal(f.registry.get(ticket.owner).sessionId, null)
    assert.deepEqual(trigger.source, { kind: 'github', repo: REPO, issueNumber: 42, url: issue().html_url, event: 'issue' })
    assert.deepEqual(trigger.policy, { addressing: 'direct', mode: 'independent', allowed: true, reason: null })
    const ack = f.outbox().find(r => r.kind === 'reply' && r.to === 'github:' + REPO + ':42')
    assert.ok(ack && ack.state === 'recorded', 'ack 先存后做 (recorded intent)')
    assert.equal(ack.triggerId, trigger.id)
    assert.equal(ack.ticketId, ticket.id)
    assert.ok(ack.body.includes('已受理'), 'ack 一句话回 Issue')
    assert.ok(ack.body.includes(DSH_BADGE), 'ack carries the dsh-badge')
    const second = await f.source.pollAll()
    assert.equal(second.triggered, 0, '重放/再轮询去重 (triggerRef 幂等)')
    assert.deepEqual(await f.source.handleIssueEvent(issue(), REPO_CFG), { deduped: true, ticketId: ticket.id })
    assert.equal(f.calls.prompt.length, 1)
    assert.equal(f.outbox().filter(row => row.requestId === ack.requestId).length, 1)
  } finally { f.cleanup() }
})

test('non-allowlisted authors are recorded but never processed (login 白名单)', async () => {
  const f = fixture()
  try {
    const result = await f.source.handleIssueEvent(issue({ number: 42, login: 'stranger' }), REPO_CFG)
    assert.equal(result.dropped, 'not-allowlisted')
    assert.equal(f.calls.prompt.length, 0)
    const rec = f.triggers().find(t => t.kind === 'github-dropped' && t.number === 42)
    assert.ok(rec && rec.dropped === 'not-allowlisted', '只记录不处理')
    assert.ok(!f.outbox().some(r => r.to === 'github:' + REPO + ':42'), 'no ack for strangers')
  } finally { f.cleanup() }
})

test('bot:ignore-labeled issues are recorded but never processed (随手记想法)', async () => {
  const f = fixture()
  try {
    const result = await f.source.handleIssueEvent(issue({ number: 42, labels: ['bug', 'bot:ignore'] }), REPO_CFG)
    assert.equal(result.dropped, 'bot-ignore')
    assert.equal(f.calls.prompt.length, 0)
    const record = f.triggers().find(t => t.kind === 'github-dropped')
    assert.equal(record.dropped, 'bot-ignore')
    assert.deepEqual(record.source, { kind: 'github', repo: REPO, issueNumber: 42, url: issue().html_url, event: 'issue' })
    assert.deepEqual(record.policy, { addressing: 'direct', mode: 'drop', allowed: false, reason: 'bot-ignore' })
    assert.equal(record.authorization, undefined)
  } finally { f.cleanup() }
})

test('a new PR routes with the initial-review instruction (摘要+风险点)', async () => {
  const f = fixture()
  try {
    const result = await f.source.handleIssueEvent(issue({ number: 77, title: '登录重试修复', pr: true }), REPO_CFG)
    assert.equal(result.routed, true)
    assert.equal(f.calls.prompt.length, 1)
    const injected = f.calls.prompt[0].text
    assert.ok(injected.includes('[hub-bot github ' + REPO + '#77] 新 PR'), 'PR kind in the mark')
    assert.ok(injected.includes('摘要'), '初审指令: 摘要')
    assert.ok(injected.includes('风险'), '初审指令: 风险点')
    assert.ok(f.triggers().some(t => t.id === 'github:' + REPO + ':pr:77'))
  } finally { f.cleanup() }
})

test('an allowlisted stop terminates all live work for the item and notifies the chief once per task', async () => {
  const f = fixture()
  try {
    const ownerId = 'repo-DSH-Workflow'
    f.registry.bindSession(ownerId, 'repo-owner')
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const follow = await f.source.handleCommentEvent(comment({ id: 5003 }), REPO_CFG)
    const unrelated = await f.router.routeToOwner({ ownerId, message: 'unrelated management work' })
    const otherIssue = await f.source.handleIssueEvent(issue({ number: 43 }), REPO_CFG)
    const stop = comment({ body: '停' })
    const result = await f.source.handleCommentEvent(stop, REPO_CFG)
    assert.equal(result.terminated, routed.ticketId)
    assert.deepEqual(new Set(result.terminatedTicketIds), new Set([routed.ticketId, follow.ticketId]))
    for (const id of result.terminatedTicketIds) {
      const ticket = f.router.getTicket(id)
      assert.equal(ticket.stage, 'failed')
      assert.ok(ticket.failed.reason.includes('停'))
    }
    assert.equal(f.router.getTicket(unrelated.ticketId).stage, 'working')
    assert.equal(f.router.getTicket(otherIssue.ticketId).stage, 'queued')
    assert.equal(f.registry.get(ownerId).sessionId, 'repo-owner')
    assert.equal((await f.source.handleCommentEvent({ ...stop, body: '@hub-bot 重试' }, REPO_CFG)).deduped, true)
    const notices = f.outbox().filter(r => r.kind === 'reply' && r.body.includes('已终止'))
    assert.deepEqual(notices.map(r => r.ticketId), result.terminatedTicketIds)
    assert.ok(notices.every(r => r.to === 'dsh:session:chief' && r.state === 'queued'))
  } finally { f.cleanup() }
})

test('a tracked work comment uses an independent worker while the owner is busy, and its ID survives edits', async () => {
  const f = fixture()
  try {
    const ownerId = 'repo-DSH-Workflow'
    f.registry.bindSession(ownerId, 'owner-busy')
    await f.router.routeToOwner({ ownerId, message: 'synthetic management task' })
    const original = await f.source.handleIssueEvent(issue({ number: 42 }), REPO_CFG)
    const strangerComment = comment({ id: 6001, body: '停', login: 'stranger' })
    assert.deepEqual(await f.source.handleCommentEvent(strangerComment, REPO_CFG), { dropped: 'not-allowlisted' })
    const denied = f.router.getTrigger('github:' + REPO + ':comment:6001')
    assert.deepEqual(denied.source, { kind: 'github', repo: REPO, issueNumber: 42, commentId: 6001,
      url: strangerComment.html_url, event: 'comment' })
    assert.deepEqual(denied.policy, { addressing: 'direct', mode: 'drop', allowed: false, reason: 'not-allowlisted' })
    assert.equal(denied.authorization, undefined)
    assert.equal(f.router.getTicket(original.ticketId).stage, 'working')
    const request = comment({ id: 6002, body: '补充：重试间隔要指数退避' })
    const follow = await f.source.handleCommentEvent(request, REPO_CFG)
    assert.equal(follow.routed, true)
    assert.notEqual(follow.ticketId, original.ticketId)
    const execution = f.router.getTicket(follow.ticketId)
    assert.equal(execution.owner, ownerId)
    assert.notEqual(execution.workerSession.sessionId, f.router.getTicket(original.ticketId).workerSession.sessionId)
    assert.equal(f.calls.prompt.length, 3)
    assert.deepEqual(f.calls.prompt.filter(p => p.sessionId === 'owner-busy').map(p => p.text.includes('synthetic management task')), [true])
    assert.ok(f.calls.prompt[2].text.includes('指数退避'))
    assert.equal(f.calls.prompt[2].sessionId, execution.workerSession.sessionId)
    const replay = await f.source.handleCommentEvent({ ...request, body: '停', html_url: request.html_url + '?edited' }, REPO_CFG)
    assert.equal(replay.deduped, true)
    assert.equal(f.router.getTicket(follow.ticketId).stage, 'working')
    assert.equal(f.calls.prompt.length, 3)
  } finally { f.cleanup() }
})

test('an @-mention comment on an untracked issue becomes a new trigger (mention 寻址)', async () => {
  const f = fixture()
  try {
    const result = await f.source.handleCommentEvent(comment({ body: '@hub-bot 看一下这个', issueNumber: 55 }), REPO_CFG)
    assert.equal(result.routed, true)
    const injected = f.calls.prompt[0].text
    assert.ok(injected.includes('[hub-bot github ' + REPO + '#55]'), 'source mark')
    const trigger = f.router.getTrigger('github:' + REPO + ':comment:5001')
    assert.equal(trigger.authorization.addressing, 'mention')
    assert.deepEqual(trigger.source, { kind: 'github', repo: REPO, issueNumber: 55, commentId: 5001,
      url: comment({ issueNumber: 55 }).html_url, event: 'comment' })
    assert.deepEqual(trigger.policy, { addressing: 'mention', mode: 'independent', allowed: true, reason: null })
  } finally { f.cleanup() }
})

test('GitHub work held for approval is delivered only to its independent worker', async () => {
  const f = fixture()
  try {
    const ownerId = 'repo-DSH-Workflow'
    f.registry.bindSession(ownerId, 'repo-owner')
    f.router.installDeferred(new DeferredRegistry({
      store: f.store, tasks: f.router.tasks, now: f.source.now,
      owners: { currentBinding: id => f.registry.get(id), isOwnerSession: id => f.registry.isOwnerSession(id) },
    }))
    const routed = await f.source.handleCommentEvent(comment({ body: '@hub-bot 请检查 sudo 配置' }), REPO_CFG)
    const pending = f.router.getTicket(routed.ticketId)
    assert.equal(pending.stage, 'person/confirm')
    assert.equal(f.calls.prompt.length, 0)
    await f.router.resolveDeferred({ ticketId: pending.id, requestId: pending.deferred.requestId, decision: 'approve', channel: 'panel' })
    await f.router.tick()
    const started = f.router.getTicket(pending.id)
    assert.equal(started.stage, 'working')
    assert.equal(f.calls.prompt.length, 1)
    assert.equal(f.calls.prompt[0].sessionId, started.workerSession.sessionId)
    assert.notEqual(started.workerSession.sessionId, 'repo-owner')
  } finally { f.cleanup() }
})

test('a stop for another repository cannot affect this repo, and an unaddressed comment records no authority', async () => {
  const f = fixture()
  try {
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const stop = { ...comment({ body: '停' }), issue_url: 'https://api.github.com/repos/example/elsewhere/issues/42' }
    assert.deepEqual(await f.source.handleCommentEvent(stop, REPO_CFG), { dropped: 'malformed' })
    assert.equal(f.router.getTicket(routed.ticketId).stage, 'working')
    const plain = comment({ id: 5002, issueNumber: 43 })
    assert.deepEqual(await f.source.handleCommentEvent(plain, REPO_CFG), { dropped: 'untracked-comment' })
    const trigger = f.router.getTrigger('github:' + REPO + ':comment:5002')
    assert.deepEqual(trigger.policy, { addressing: 'none', mode: 'drop', allowed: false, reason: 'untracked-comment' })
    assert.equal(trigger.authorization, undefined)
    assert.equal(trigger.source.issueNumber, 43)
  } finally { f.cleanup() }
})

test('closure resolves original refs and comment-only work, including a merged PR', async () => {
  const f = fixture()
  try {
    const ownerId = 'repo-DSH-Workflow'
    const legacyIssue = await f.router.routeToOwner({ ownerId, message: 'original issue task',
      triggerRef: 'github:' + REPO + ':issue:42', authorization: { actor: 'Ghost233', source: 'github', at: f.source.now() } })
    const prComment = await f.source.handleCommentEvent(comment({ id: 5002, body: '@hub-bot 初审', issueNumber: 77 }), REPO_CFG)
    const oldComment = comment({ id: 5003, issueNumber: 77 })
    const legacyMention = await f.router.routeToOwner({ ownerId, message: 'original PR mention',
      triggerRef: 'github:' + REPO + ':comment:5003',
      authorization: { actor: 'Ghost233', source: 'github', at: f.source.now(), messageId: oldComment.html_url } })
    f.script['repos/' + REPO + '/issues/42'] = { state: 'closed' }
    f.script['repos/' + REPO + '/issues/77'] = { state: 'closed', pull_request: { url: 'fixture' } }
    f.script['repos/' + REPO + '/pulls/77'] = { merged_at: '2026-11-15T02:00:00Z' }
    const result = await f.source.checkClosures(REPO_CFG)
    assert.deepEqual(new Set(result.terminated), new Set([legacyIssue.ticketId, prComment.ticketId, legacyMention.ticketId]))
    assert.equal(f.router.tasks.getTicket(legacyIssue.ticketId).stage, 'failed')
    for (const id of [prComment.ticketId, legacyMention.ticketId]) {
      assert.ok(f.router.tasks.getTicket(id).failed.reason.includes('已合并'))
    }
    assert.deepEqual(f.reads.map(args => args[1]), [
      'repos/' + REPO + '/issues/42', 'repos/' + REPO + '/issues/77', 'repos/' + REPO + '/pulls/77',
    ])
    const notices = f.outbox().filter(r => r.kind === 'reply' && r.to === 'dsh:session:chief' && r.state === 'queued' && r.body.includes('已终止'))
    assert.equal(notices.length, 3)
  } finally { f.cleanup() }
})

test('deliverReplies posts recorded github replies as real comments with the badge; failures follow the 5-strike discipline', async () => {
  const f = fixture()
  try {
    const { insertOutbox } = await import('../src/outbox.js')
    insertOutbox(f.store, { ticketId: null, kind: 'reply', to: 'github:' + REPO + ':42', body: '进展：已定位到重试逻辑', state: 'recorded', requestId: 'r-gh-1' })
    const first = await f.source.deliverReplies()
    assert.equal(first.delivered, 1)
    assert.equal(f.posts.length, 1)
    const posted = f.posts[0].join(' ')
    assert.ok(posted.includes('repos/' + REPO + '/issues/42/comments'), 'POST 到该 issue 的评论端点')
    assert.ok(posted.includes('进展：已定位到重试逻辑'))
    assert.ok(posted.includes('powered_by-dsh'), '缺 badge 的 body 由代码补上')
    const row = f.outbox().find(r => r.requestId === 'r-gh-1')
    assert.equal(row.state, 'sent', '真实送达才标 sent')
    assert.ok(row.sentAt)
  } finally { f.cleanup() }
})

test('deliverReplies failures: recorded stays recorded with the shared attempts counter; five failures fail the row + system problem', async () => {
  const f = fixture()
  f.source.gh = async () => { throw new Error('HTTP 403') }
  try {
    const { insertOutbox } = await import('../src/outbox.js')
    const row = insertOutbox(f.store, { ticketId: null, kind: 'reply', to: 'github:' + REPO + ':42', body: 'x', state: 'recorded', requestId: 'r-gh-2' })
    for (let i = 0; i < 4; i++) await f.source.deliverReplies()
    let stored = f.outbox().find(r => r.id === row.id)
    assert.equal(stored.state, 'recorded')
    assert.equal(stored.attempts, 4, '统一计数器命名')
    await f.source.deliverReplies()
    stored = f.outbox().find(r => r.id === row.id)
    assert.equal(stored.state, 'failed')
    assert.equal(f.outbox().filter(r => r.kind === 'system-problem').length, 1)
  } finally { f.cleanup() }
})

test('watermarks persist across source instances — 重启不重放', async () => {
  const script = { ['repos/' + REPO + '/issues']: [issue({ number: 41 })] }
  const f1 = fixture({ script })
  let dir
  try {
    await f1.source.pollAll()
    dir = f1.store.stateDir
    script['repos/' + REPO + '/issues'] = [issue({ number: 41 }), issue({ number: 42 })]
    const registry2 = new OwnerRegistry(f1.store, { scratchRoot: join(dir, 'scratch') })
    const sessions2 = { create: async () => ({ sessionId: 'session-r2' }), prompt: async () => ({ accepted: true }) }
    const router2 = new Router({ store: f1.store, registry: registry2, sessions: sessions2, now: () => new Date().toISOString() })
    const restarted = new GitHubSource({ store: f1.store, registry: registry2, router: router2, sessions: sessions2, config: f1.source.config, logger: { info() {}, warn() {} }, gh: f1.gh, git: async () => 'https://github.com/' + REPO + '.git\n' })
    assert.equal((await restarted.status()).repos[REPO].maxNumber, 41, '水位线从落盘恢复')
    const result = await restarted.pollAll()
    assert.equal(result.triggered, 1, '只触发水位线之后的新事件（#42，#41 不重放）')
    assert.ok(!f1.triggers().some(t => t.id === 'github:' + REPO + ':issue:41'), '#41 never triggered')
  } finally { f1.cleanup() }
})

test('a failed comment fetch preserves the checkpoint and the next instance catches up', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const comments = issues + '/comments'
  const f = fixture({ script: { [issues]: [issue()] } })
  try {
    await f.source.pollAll()
    const checkpoint = () => JSON.parse(readFileSync(watermarkPath(f.store.stateDir), 'utf8')).repos[REPO].commentsSince
    const before = checkpoint()
    f.setNow('2026-11-15T02:00:00.000Z')
    f.script[comments] = new Error('synthetic GitHub comment timeout')
    await f.source.pollAll()
    const failedCheckpoint = checkpoint()
    assert.equal((await f.source.status()).repos[REPO].lastError, 'synthetic GitHub comment timeout')
    const fetched = comment({ body: '@hub-bot 处理这条' })
    f.script[comments] = args => {
      const since = new URLSearchParams(args[1].split('?')[1]).get('since')
      return Date.parse(since) > Date.parse(fetched.created_at) ? [] : [fetched]
    }
    const reopened = new GitHubSource({
      store: f.store, registry: f.registry, router: f.router, config: f.source.config,
      gh: f.gh, git: f.source.git, now: f.source.now, logger: { info() {}, warn() {} },
    })
    const retried = await reopened.pollAll()
    assert.deepEqual({ checkpoint: failedCheckpoint, triggered: retried.triggered }, { checkpoint: before, triggered: 1 })
  } finally { f.cleanup() }
})

test('paginated issues and comments are processed once across overlapping pages', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture({ script: { [issues]: [[issue({ number: 41 })], [issue({ number: 40 })]] } })
  try {
    await f.source.pollAll()
    const pull = issue({ number: 43, pr: true })
    const opened = issue()
    f.script[issues] = [[pull, opened], [opened, issue({ number: 41 })]]
    const first = comment({ id: 5001, body: '@hub-bot 确认行为' })
    const second = comment({ id: 5002, body: '补充说明', issueNumber: 43 })
    f.script[issues + '/comments'] = [[second], [first, second]]
    assert.deepEqual(await f.source.pollAll(), { triggered: 4, dropped: 0, terminated: 0 })
    assert.deepEqual(f.triggers().map(t => t.id), [
      'github:' + REPO + ':issue:42', 'github:' + REPO + ':pr:43',
      'github:' + REPO + ':comment:5001', 'github:' + REPO + ':comment:5002',
    ])
    const listReads = f.reads.filter(args => args[1].startsWith(issues + '?') || args[1].startsWith(issues + '/comments?'))
    assert.equal(listReads.length, 3)
    for (const args of listReads) assert.deepEqual(args.slice(2), ['--paginate', '--slurp'])
    assert.equal((await f.source.status()).repos[REPO].maxCommentId, 5002)
  } finally { f.cleanup() }
})

test('a comment processing failure preserves both checkpoint fields and a reopen deduplicates committed work', async () => {
  const comments = 'repos/' + REPO + '/issues/comments'
  const f = fixture()
  let reopenedStore
  try {
    await f.source.pollWatchedRepo(REPO)
    const checkpoint = () => JSON.parse(readFileSync(watermarkPath(f.store.stateDir), 'utf8')).repos[REPO]
    const before = checkpoint()
    f.setNow('2026-11-15T02:00:00.000Z')
    f.script[comments] = [[comment({ body: '@hub-bot 第一条' }), comment({ id: 5002, body: '@hub-bot 第二条' })]]
    const routeBackground = f.router.routeBackground.bind(f.router)
    f.router.routeBackground = request => {
      if (request.source.commentId === 5002) throw new Error('synthetic dispatch failure')
      return routeBackground(request)
    }
    await assert.rejects(f.source.pollWatchedRepo(REPO), /synthetic dispatch failure/)
    assert.deepEqual(checkpoint(), before)
    assert.equal((await f.source.status()).repos[REPO].lastError, 'synthetic dispatch failure')
    assert.equal(f.calls.prompt.length, 1)
    reopenedStore = new Store(f.store.stateDir)
    const registry = new OwnerRegistry(reopenedStore, { scratchRoot: join(f.store.stateDir, 'scratch') })
    const router = new Router({ store: reopenedStore, registry, sessions: f.router.sessions, now: f.source.now })
    const reopened = new GitHubSource({ store: reopenedStore, registry, router, config: f.source.config,
      gh: f.gh, git: f.source.git, now: f.source.now, logger: { info() {}, warn() {} } })
    const retried = await reopened.pollWatchedRepo(REPO)
    assert.deepEqual(retried, { triggered: 1, dropped: 0, terminated: 0 })
    assert.equal(f.calls.prompt.length, 2)
    assert.equal(f.triggers().length, 2)
    assert.deepEqual(checkpoint(), { ...before, maxCommentId: 5002, commentsSince: '2026-11-15T02:00:00.000Z' })
  } finally { reopenedStore?.close(); f.cleanup() }
})

test('manual and scheduled polling share the active repo cycle', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture()
  try {
    await f.source.pollAll()
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const secondResolution = Promise.withResolvers()
    const lookup = f.source.git
    let resolving = 0
    f.source.git = async args => {
      if (++resolving === 2) secondResolution.resolve()
      return lookup(args)
    }
    f.script[issues + '/comments'] = async () => {
      entered.resolve()
      await release.promise
      return [[comment({ body: '@hub-bot 查看' })]]
    }
    const scheduled = f.source.pollAll()
    await entered.promise
    const manual = f.source.pollWatchedRepo(REPO)
    await secondResolution.promise
    release.resolve()
    assert.deepEqual(await Promise.all([scheduled, manual]), [
      { triggered: 1, dropped: 0, terminated: 0 }, { triggered: 1, dropped: 0, terminated: 0 },
    ])
    assert.equal(f.reads.filter(args => args[1].startsWith(issues + '/comments?')).length, 1)
    assert.equal(f.calls.prompt.length, 1)
  } finally { f.cleanup() }
})

test('manual poll resolves current registry origins, returns null for absent repos, and obeys the enable flag', async () => {
  const repos = [REPO_CFG]
  const f = fixture({ repos })
  try {
    const added = { repo: 'example/dynamic', workspace: 'dynamic', cwd: '/fixture/dynamic' }
    assert.equal(await f.source.pollWatchedRepo(added.repo), null)
    assert.equal(f.reads.length, 0)
    repos.push(added)
    const owner = f.registry.create({ kind: 'repo', workspace: added.workspace, cwd: added.cwd })
    const initialized = await f.source.pollWatchedRepo(added.repo)
    assert.equal(initialized.initialized, true)
    assert.equal((await f.source.status()).repos[added.repo].ownerId, owner.id)
    assert.equal(f.reads.length, 1)
    assert.ok(f.reads[0][1].startsWith('repos/' + added.repo + '/issues?'))
    f.source.config.enabled = false
    assert.equal((await f.source.pollWatchedRepo(added.repo)).disabled, true)
    f.source.config.enabled = true
    f.registry.markRecycled(owner.id)
    assert.equal(await f.source.pollWatchedRepo(added.repo), null)
    assert.equal(f.reads.length, 1)
  } finally { f.cleanup() }
})

test('status() follows the registry: watched repos come from repo owners\' origins, with watermarks', async () => {
  const f = fixture({ script: { ['repos/' + REPO + '/issues']: [issue({ number: 41 })] } })
  try {
    await f.source.pollAll()
    const status = await f.source.status()
    assert.equal(status.enabled, true)
    assert.equal(status.intervalMs, 300000)
    assert.equal(status.loginAllowlist[0], 'Ghost233')
    assert.equal(status.repos[REPO].ownerId, 'repo-DSH-Workflow', '监听项带来负责人身份')
    assert.equal(status.repos[REPO].maxNumber, 41)
    assert.deepEqual(status.followed, [{ repo: REPO, ownerId: 'repo-DSH-Workflow' }])
    // 未注册的 owner 不出现；origin 非 GitHub 记 resolveErrors 不炸
    f.registry.create({ kind: 'repo', workspace: 'plain', cwd: '/Volumes/home/plain' })
    await f.source.pollAll()
    const status2 = await f.source.status()
    assert.equal(status2.followed.some(w => w.ownerId === 'repo-plain'), false, '无 origin 的 owner 不进监听')
    assert.ok(status2.resolveErrors['owner:repo-plain'], '解析失败留痕')
    const originalGit = f.source.git
    f.source.git = args => args.includes('/Volumes/home/plain')
      ? Promise.resolve('https://github.com/example/plain.git') : originalGit(args)
    await f.source.pollAll()
    const repaired = await f.source.status()
    assert.ok(repaired.followed.some(w => w.ownerId === 'repo-plain'))
    assert.equal(repaired.resolveErrors['owner:repo-plain'], undefined)
  } finally { f.cleanup() }
})

test('a pending default GitHub login lookup respects an allowlist the user saves', async () => {
  const f = fixture({ allowlist: [] })
  try {
    let resolveLogin
    f.source.gh = () => new Promise(resolve => { resolveLogin = resolve })
    const pending = f.source.resolveSelfLogin()
    f.source.config.loginAllowlist = ['explicit-owner']
    resolveLogin(JSON.stringify({ login: 'default-owner' }))
    assert.deepEqual(await pending, ['explicit-owner'])
    assert.deepEqual((await f.source.status()).loginAllowlist, ['explicit-owner'])
  } finally { f.cleanup() }
})

test('resolveSelfLogin failure warns (not silently swallowed) and keeps the allowlist unchanged', async () => {
  const f = fixture({ allowlist: [] })
  f.source.gh = async () => { throw new Error('gh not authenticated') }
  try {
    const result = await f.source.resolveSelfLogin()
    assert.deepEqual(result, [], '解析失败白名单恒空')
    assert.ok(f.warnings.some(w => w.includes('could not resolve')), '至少 warn 一次（全静默 record-drop 是隐患）')
  } finally { f.cleanup() }
})
