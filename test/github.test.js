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
import { discardOutboxRows } from '../src/outbox.js'

const REPO = 'Ghost233/DSH-Workflow'
const REPO_CFG = { repo: REPO, workspace: 'DSH-Workflow', cwd: '/Volumes/home/DSH-Workflow', enabled: true }

/** Scripted GitHub responses are keyed by endpoint, with a POST prefix for sends. */
function fakeGh(script) {
  const posts = []
  const reads = []
  const gh = async (args) => {
    const posting = args.includes('POST')
    const endpoint = args[posting ? args.indexOf('POST') + 1 : 1].split('?')[0]
    if (posting) posts.push(args)
    else reads.push(args)
    const key = posting ? 'POST ' + endpoint : endpoint
    const query = new URLSearchParams(args[1].split('?')[1])
    const defaultRead = endpoint === 'user' ? { login: 'Ghost233' } : query.has('page') ? [] : { state: 'open' }
    const response = script[key] ?? (posting ? { id: 9001 } : defaultRead)
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
function comment({ id = 5001, body = '继续', login = 'Ghost233', issueNumber = 42,
  createdAt = '2026-11-15T00:00:00Z', updatedAt = createdAt } = {}) {
  return { id, body, user: { login }, html_url: 'https://github.com/' + REPO + '/issues/' + issueNumber + '#issuecomment-' + id,
    issue_url: 'https://api.github.com/repos/' + REPO + '/issues/' + issueNumber, created_at: createdAt, updated_at: updatedAt }
}

/** registry+router+source with fake sessions and a scripted fake gh. 监听清单跟随注册表（repo owners 的
 *  origin——fake git 按 cwd 返回 remote URL）；repo owner 已在下方注册，config 不再有 repos 列表。 */
function fixture({ allowlist = ['Ghost233'], script = {}, repos = [REPO_CFG], routerConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-gh-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  for (const r of repos) registry.create({ kind: 'repo', workspace: r.workspace, cwd: r.cwd })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const calls = { create: [], prompt: [], cancel: [] }
  const sessions = {
    create: async request => { calls.create.push(request); return { sessionId: 'session-' + calls.create.length } },
    prompt: async request => { calls.prompt.push(request); return { accepted: true } },
    cancel: async request => { calls.cancel.push(request.sessionId) },
  }
  const router = new Router({ store, registry, sessions, config: routerConfig, now: () => new Date(nowMs).toISOString() })
  const { gh, posts, reads } = fakeGh(script)
  const config = { enabled: true, intervalMs: 300000, loginAllowlist: allowlist, mentionHandle: '@hub-bot' }
  const warnings = []
  const git = async (args) => {
    const cwd = args[args.indexOf('-C') + 1]
    const match = repos.find(r => r.cwd === cwd)
    if (!match) throw new Error('git remote get-url: no origin')
    return 'https://github.com/' + match.repo + '.git\n'
  }
  const makeSource = (store, registry, router) => new GitHubSource({
    store, registry, router, sessions, config, logger: { info() {}, warn: (...a) => warnings.push(a.join(' ')) }, gh, git,
    now: () => new Date(nowMs).toISOString(),
  })
  const source = makeSource(store, registry, router)
  const reopen = () => {
    const nextStore = new Store(dir)
    const nextRegistry = new OwnerRegistry(nextStore, { scratchRoot: join(dir, 'scratch') })
    const nextRouter = new Router({ store: nextStore, registry: nextRegistry, sessions, config: routerConfig, now: source.now })
    return { store: nextStore, source: makeSource(nextStore, nextRegistry, nextRouter) }
  }
  return {
    source, registry, router, store, sessions, calls, posts, reads, script, gh, warnings, reopen,
    setNow: (iso) => { nowMs = Date.parse(iso) },
    triggers: () => store.db.prepare('SELECT value FROM trigger').all().map(r => JSON.parse(String(r.value))),
    tickets: () => store.db.prepare('SELECT value FROM ticket').all().map(r => JSON.parse(String(r.value))),
    outbox: () => store.db.prepare('SELECT value FROM outbox ORDER BY rowid').all().map(r => JSON.parse(String(r.value))),
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('background GitHub checks leave silent, accepted and failed notification evidence', async () => {
  const f = fixture()
  let reopened
  try {
    const silent = await f.source.handleIssueEvent(issue({ number: 100 }), REPO_CFG)
    await f.source.deliverReplies() // the existing intake acknowledgement is separate from the run decision
    const postedBefore = f.posts.length
    const worker = f.router.getTicket(silent.ticketId).workerSession.sessionId
    assert.throws(() => f.router.tasks.accept(silent.ticketId), { code: 'illegal-transition' })
    await assert.rejects(f.router.reportBackground({ ticketId: silent.ticketId, sessionId: 'different-worker', silenceReason: 'no-change' }), /bound worker/)
    assert.equal((await f.router.reportBackground({ ticketId: silent.ticketId, sessionId: worker, silenceReason: 'no-change' })).stage, 'done')
    await f.router.tick()
    await f.source.deliverReplies()
    assert.equal(f.posts.length, postedBefore)
    const quiet = f.router.runs.get('run-' + silent.ticketId)
    assert.equal(quiet.status, 'silent')
    assert.equal(quiet.decisions.at(-1).reasonCode, 'no-change')
    assert.equal(f.router.getTicket(silent.ticketId).transitions.at(-1).reason, 'background-no-result')
    assert.equal(quiet.notification, null)

    const result = await f.source.handleIssueEvent(issue({ number: 101 }), REPO_CFG)
    const failed = await f.source.handleIssueEvent(issue({ number: 102 }), REPO_CFG)
    await f.source.deliverReplies()
    const replyPost = number => 'POST repos/' + REPO + '/issues/' + number + '/comments'
    f.script[replyPost(101)] = { id: 9101 }
    f.script[replyPost(102)] = Object.assign(new Error('fixture rate limit'), { status: 429 })
    const sessionOf = id => f.router.getTicket(id).workerSession.sessionId
    await f.router.reportBackground({ ticketId: result.ticketId, sessionId: sessionOf(result.ticketId), summary: 'Fixture outcome' })
    await f.router.reportBackground({ ticketId: failed.ticketId, sessionId: sessionOf(failed.ticketId), failure: 'Fixture execution error' })
    assert.equal(f.router.runs.list({ status: 'waiting', source: 'github' }).length, 2)
    for (let attempt = 0; attempt < 5; attempt++) await f.source.deliverReplies()
    const accepted = f.router.runs.get('run-' + result.ticketId)
    const error = f.router.runs.get('run-' + failed.ticketId)
    assert.equal(accepted.stage, 'person/review')
    assert.equal(accepted.status, 'sent')
    assert.equal(accepted.notification.channelAccepted, true)
    assert.equal(accepted.result.kind, 'result')
    assert.equal(error.stage, 'failed')
    assert.equal(error.status, 'failed')
    assert.equal(error.notification.channelAccepted, false)
    assert.equal(error.result.kind, 'failure')
    assert.equal(discardOutboxRows(f.store, [error.notification.id]), 1)
    reopened = f.reopen()
    assert.equal(reopened.source.router.runs.get(error.id).notification.discarded, true)
    assert.deepEqual(reopened.source.router.runs.list({ status: 'silent' }).map(row => row.id), [quiet.id])
  } finally { reopened?.store.close(); f.cleanup() }
})

test('an explicit GitHub comment receives a reply and progress keeps its ticket active', async () => {
  const f = fixture()
  try {
    const direct = await f.source.handleCommentEvent(comment({ body: '@hub-bot 请检查有没有新情况？' }), REPO_CFG)
    const { ticketId } = direct
    const sessionId = f.router.getTicket(ticketId).workerSession.sessionId
    const progress = await f.router.reportBackground({ ticketId, sessionId, silenceReason: 'progress-only' })
    assert.equal(progress.stage, 'working')
    assert.equal(f.router.runs.get('run-' + ticketId).lastProgressAt, f.router.now())
    assert.equal(f.outbox().filter(row => row.kind === 'reply').length, 0)
    const answer = await f.router.reportBackground({ ticketId, sessionId, silenceReason: 'no-change' })
    assert.equal(answer.stage, 'done')
    assert.equal(f.router.runs.get('run-' + ticketId).status, 'waiting')
    await f.source.deliverReplies()
    assert.equal(f.posts.length, 1)
    assert.match(f.posts[0].find(arg => arg.startsWith('body=')), /本次检查没有变化/)
    assert.equal(f.router.runs.get('run-' + ticketId).status, 'sent')
  } finally { f.cleanup() }
})

test('config: the github section validates and defaults disabled with 5min polling', () => {
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: 'x' }), /config\.github must be an object/)
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: { nope: 1 } }), /does not know config\.github key/)
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: { intervalMs: 1000 } }), /intervalMs/)
  // repos 键已移除（监听清单跟随 owner 注册表）——残留旧键被严格校验拒绝
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', github: { repos: [{ repo: 'a/b', workspace: 'w', cwd: '/tmp/w' }] } }), /does not know config\.github key \["repos"\]/)
  assert.deepEqual(resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y' }).github, { enabled: false, intervalMs: 300000, loginAllowlist: [] })
})

test('bootstrap reads only the newest issue or PR and records its number', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture({ script: { [issues]: [issue({ number: 41, pr: true })] } })
  try {
    const result = await f.source.pollWatchedRepo(REPO)
    assert.equal(result.triggered, 0)
    assert.equal(f.calls.prompt.length, 0)
    const wm = JSON.parse(readFileSync(watermarkPath(f.store.stateDir), 'utf8'))
    assert.equal(wm.repos[REPO].maxNumber, 41)
    assert.equal(wm.repos[REPO].initialized, true)
    const issueReads = f.reads.filter(args => args[1].startsWith(issues + '?'))
    assert.deepEqual(issueReads, [['api', issues + '?state=all&sort=created&direction=desc&per_page=1&page=1', '--hostname', 'github.com']])
    assert.equal(f.reads.filter(args => args[1].startsWith(issues + '/comments?')).length, 1)
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

test('a GitHub stop cancels its bound workers and leaves management sessions and unrelated work alone', async () => {
  const f = fixture({ routerConfig: { concurrency: { slotsPerOwner: 10 } } })
  try {
    const ownerId = 'repo-DSH-Workflow'
    f.registry.bindSession(ownerId, 'old-repo-owner')
    f.registry.bindSession(ownerId, 'repo-owner')
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const follow = await f.source.handleCommentEvent(comment({ id: 5003 }), REPO_CFG)
    const unrelated = await f.router.routeToOwner({ ownerId, message: 'unrelated management work' })
    const otherIssue = await f.source.handleIssueEvent(issue({ number: 43 }), REPO_CFG)
    const legacyComment = comment({ id: 5004 })
    const legacy = await f.router.routeToOwner({ ownerId, message: 'legacy work',
      triggerRef: 'github:' + REPO + ':comment:5004',
      authorization: { actor: 'Ghost233', source: 'github', at: f.source.now(), messageId: legacyComment.html_url } })
    f.router.tasks.bindWorkerSession(legacy.ticketId, { sessionId: 'legacy-worker', cwd: REPO_CFG.cwd })
    const stale = await f.source.handleCommentEvent(comment({ id: 5005 }), REPO_CFG)
    f.router.tasks.bindWorkerSession(stale.ticketId, { sessionId: 'old-repo-owner', cwd: REPO_CFG.cwd })
    const workerOf = id => f.router.getTicket(id).workerSession.sessionId
    const conflicting = await f.source.handleCommentEvent(comment({ id: 5006 }), REPO_CFG)
    f.router.tasks.bindWorkerSession(conflicting.ticketId, { sessionId: workerOf(otherIssue.ticketId), cwd: REPO_CFG.cwd })
    const shared = await f.source.handleCommentEvent(comment({ id: 5007 }), REPO_CFG)
    f.router.tasks.bindWorkerSession(shared.ticketId, { sessionId: workerOf(routed.ticketId), cwd: REPO_CFG.cwd })
    const stop = comment({ body: '停' })
    const result = await f.source.handleCommentEvent(stop, REPO_CFG)
    const stopped = [routed, follow, legacy, stale, conflicting, shared].map(work => work.ticketId)
    assert.deepEqual(new Set(result.transitionedTicketIds), new Set(stopped))
    for (const id of stopped) {
      const ticket = f.router.getTicket(id)
      assert.equal(ticket.stage, 'failed')
      assert.ok(ticket.failed.reason.includes('停'))
    }
    assert.equal(f.router.getTicket(unrelated.ticketId).stage, 'working')
    assert.equal(f.router.getTicket(otherIssue.ticketId).stage, 'working')
    assert.equal(f.registry.get(ownerId).sessionId, 'repo-owner')
    assert.equal((await f.source.handleCommentEvent({ ...stop, body: '@hub-bot 重试' }, REPO_CFG)).deduped, true)
    assert.deepEqual(f.calls.cancel, [workerOf(routed.ticketId), workerOf(follow.ticketId)])
    const notices = f.outbox().filter(r => r.kind === 'reply' && r.body.includes('已标记为失败'))
    assert.deepEqual(notices.map(r => r.ticketId), result.transitionedTicketIds)
    assert.ok(notices.every(r => r.to === 'dsh:session:chief' && r.state === 'queued'))
  } finally { f.cleanup() }
})

test('a failed GitHub worker cancel is visible in the result and notice and is never replayed', async () => {
  const comments = 'repos/' + REPO + '/issues/comments'
  const f = fixture({ routerConfig: { concurrency: { slotsPerOwner: 5 } } })
  try {
    await f.source.pollWatchedRepo(REPO)
    const issueWork = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const replyWork = await f.source.handleCommentEvent(comment({ id: 5002 }), REPO_CFG)
    const unrelated = await f.source.handleIssueEvent(issue({ number: 43 }), REPO_CFG)
    const sessionId = f.router.getTicket(issueWork.ticketId).workerSession.sessionId
    const otherWorker = f.router.getTicket(replyWork.ticketId).workerSession.sessionId
    f.sessions.cancel = async request => {
      f.calls.cancel.push(request.sessionId)
      if (request.sessionId === sessionId) throw new Error('synthetic worker cancel failed')
    }
    const stop = comment({ body: '停' })
    const expected = {
      transitionedTicketIds: [issueWork.ticketId, replyWork.ticketId],
      workerOutcomes: [{ sessionId, status: 'failed', error: 'synthetic worker cancel failed' },
        { sessionId: otherWorker, status: 'cancelled' }],
    }
    f.script[comments] = [stop]
    assert.deepEqual(await f.source.pollWatchedRepo(REPO), { triggered: 0, dropped: 0, terminated: 2,
      stops: [{ repo: REPO, commentId: stop.id, ...expected }] })
    assert.equal(f.router.getTicket(issueWork.ticketId).stage, 'failed')
    assert.equal(f.router.getTicket(unrelated.ticketId).stage, 'working')
    const notice = f.outbox().find(row => row.ticketId === issueWork.ticketId && row.to === 'dsh:session:chief')
    assert.match(notice.body, /已标记为失败/)
    assert.match(notice.body, /执行会话停止失败：synthetic worker cancel failed/)
    assert.doesNotMatch(notice.body, /执行会话已停止/)
    assert.deepEqual(await f.source.handleCommentEvent({ ...stop, body: 'edited' }, REPO_CFG), { deduped: true, ...expected })
    assert.deepEqual(f.calls.cancel, [sessionId, otherWorker])
    assert.deepEqual(f.router.getTrigger('github:' + REPO + ':comment:5001').stop.outcomes, expected.workerOutcomes)
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

test('the hidden marker does not change the recorded reply body or its word cap', async () => {
  const f = fixture()
  try {
    const to = 'github:' + REPO + ':42'
    const text = Array.from({ length: 110 }, (_, index) => 'word' + index).join(' ')
    const reply = await f.router.replySource({ to, text })
    const row = f.outbox().find(item => item.id === reply.outboxId)
    assert.equal(reply.truncated, true)
    assert.equal((await f.source.deliverReplies()).delivered, 1)
    const sentBody = f.posts[0].find(arg => arg.startsWith('body=')).slice('body='.length)
    const [marker, ...parts] = sentBody.split('\n\n')
    assert.match(marker, /^<!-- hub-bot-github-reply:[0-9a-f-]{36} -->$/)
    assert.equal(parts.join('\n\n'), row.body + '\n\n' + DSH_BADGE)
    assert.equal(f.outbox().find(item => item.id === reply.outboxId).body, row.body)
  } finally { f.cleanup() }
})

test('a posted acknowledgement does not become work after reopen, even when a manual comment has the same login and body', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture({ allowlist: [], script: { user: { login: 'Ghost233' }, [issues]: [issue({ number: 41 })] } })
  let store
  try {
    assert.deepEqual(await f.source.resolveSelfLogin(), ['Ghost233'])
    await f.source.pollAll()
    f.script[issues] = [issue(), issue({ number: 41 })]
    assert.equal((await f.source.pollAll()).triggered, 1)
    let posted
    f.script['POST ' + issues + '/42/comments'] = args => {
      posted = comment({ id: 9001, body: args[args.indexOf('-f') + 1].slice('body='.length) })
      return posted
    }
    assert.equal((await f.source.deliverReplies()).delivered, 1)
    assert.ok(posted.body.includes(DSH_BADGE))
    const manual = comment({ id: 9002, body: f.outbox().find(r => r.kind === 'reply').body })
    f.script[issues + '/comments'] = [posted, manual]
    const reopened = f.reopen()
    store = reopened.store
    const result = await reopened.source.pollWatchedRepo(REPO)
    assert.deepEqual({ triggered: result.triggered, ids: f.tickets().map(row => row.triggerId) }, {
      triggered: 1, ids: ['github:' + REPO + ':issue:42', 'github:' + REPO + ':comment:9002'],
    })
    assert.equal(f.posts.length, 1)
  } finally { store?.close(); f.cleanup() }
})

test('a POST accepted before a lost response is suppressed by poll and recovered without another POST', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const target = issues + '/42/comments'
  const f = fixture()
  let reopened
  try {
    await f.source.pollWatchedRepo(REPO)
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const ack = f.outbox().find(row => row.ticketId === routed.ticketId && row.state === 'recorded')
    let posted
    f.script.user = { login: 'Ghost233' }
    f.script['POST ' + target] = args => {
      posted = comment({ id: 9001, body: args[args.indexOf('-f') + 1].slice('body='.length) })
      throw new Error('synthetic timeout after remote accepted POST')
    }
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.equal(f.outbox().find(row => row.id === ack.id).state, 'recorded')
    const manual = comment({ id: 9002, body: ack.body })
    f.script[target] = new Error('synthetic marker lookup timeout')
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.equal(f.outbox().find(row => row.id === ack.id).state, 'recorded')
    assert.equal(f.posts.length, 1)
    assert.match(posted.body, /<!--.*[a-f0-9-]{32,}.*-->/)
    const copiedByOther = comment({ id: 9003, login: 'someone-else', body: posted.body })
    f.script[issues + '/comments'] = [posted, manual, copiedByOther]
    reopened = f.reopen()
    // Polling recognizes and ignores the outbound reply before the delivery retry runs.
    const result = await reopened.source.pollWatchedRepo(REPO)
    assert.deepEqual({ triggered: result.triggered, ids: f.tickets().map(row => row.triggerId) }, {
      triggered: 1, ids: ['github:' + REPO + ':issue:42', 'github:' + REPO + ':comment:9002'],
    })
    assert.equal(f.triggers().find(row => row.source?.commentId === 9003).dropped, 'not-allowlisted')
    const settled = f.outbox().find(row => row.id === ack.id)
    assert.equal(settled.state, 'sent')
    assert.equal(settled.lastError, null)
    assert.equal((await reopened.source.deliverReplies()).delivered, 0)
    assert.equal(f.posts.length, 1)
  } finally { reopened?.store.close(); f.cleanup() }
})

test('polling recognizes every own comment with the same marker and preserves the first receipt', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const target = issues + '/42/comments'
  const f = fixture()
  try {
    await f.source.pollWatchedRepo(REPO)
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const ack = f.outbox().find(row => row.ticketId === routed.ticketId && row.state === 'recorded')
    let posted
    f.script['POST ' + target] = args => {
      posted = comment({ id: 9001, body: args.find(arg => arg.startsWith('body=')).slice('body='.length) })
      return posted
    }
    assert.equal((await f.source.deliverReplies()).delivered, 1)
    const duplicate = comment({ id: 9002, body: posted.body })
    const manual = comment({ id: 9003, body: ack.body })
    f.script[issues + '/comments'] = [posted, duplicate, manual]
    assert.equal((await f.source.pollWatchedRepo(REPO)).triggered, 1)
    assert.deepEqual(f.tickets().map(t => t.triggerId), [
      'github:' + REPO + ':issue:42', 'github:' + REPO + ':comment:9003',
    ])
    assert.equal(f.store.get('github:reply-receipt:' + ack.id).commentId, posted.id)
    assert.equal(f.store.get('github:posted-comment:' + REPO.toLowerCase() + ':' + duplicate.id).commentId, duplicate.id)
    assert.deepEqual(await f.source.handleCommentEvent({ ...duplicate, body: 'edited' }, REPO_CFG), { skipped: 'self-generated' })
  } finally { f.cleanup() }
})

test('a retry finds the exact marker on a later item page after reopening', async () => {
  const target = 'repos/' + REPO + '/issues/42/comments'
  const f = fixture({ allowlist: ['other-operator'] })
  let reopened
  try {
    const { insertOutbox } = await import('../src/outbox.js')
    const row = insertOutbox(f.store, { kind: 'reply', to: 'github:' + REPO + ':42', body: 'status', state: 'recorded' })
    let posted
    f.script['POST ' + target] = args => {
      posted = comment({ id: 9001, body: args[args.indexOf('-f') + 1].slice('body='.length) })
      throw new Error('synthetic lost response')
    }
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    f.script[target] = args => {
      const query = new URLSearchParams(args[1].split('?')[1])
      return query.get('page') === '1'
        ? Array.from({ length: Number(query.get('per_page')) }, (_, index) => comment({
          id: 8000 + index, body: posted.body, ...(index % 2 ? { login: 'other-operator' } : { issueNumber: 43 }),
        }))
        : [posted]
    }
    reopened = f.reopen()
    assert.equal((await reopened.source.deliverReplies()).delivered, 1)
    const settled = f.outbox().find(item => item.id === row.id)
    assert.equal(settled.state, 'sent')
    assert.equal(settled.lastError, null)
    assert.equal(f.posts.length, 1)
    assert.equal(f.reads.filter(args => args[1].startsWith(target + '?')).length, 2)
    assert.deepEqual(await reopened.source.handleCommentEvent({ ...posted, body: 'edited' }, REPO_CFG), { skipped: 'self-generated' })
  } finally { reopened?.store.close(); f.cleanup() }
})

test('a confirmed HTTP 429 retries with its original marker and posting account after reopen', async () => {
  const target = 'repos/' + REPO + '/issues/42/comments'
  const f = fixture()
  let reopened
  try {
    const { outboxId } = await f.router.replySource({ to: 'github:' + REPO + ':42', text: 'status' })
    const readRow = () => f.outbox().find(row => row.id === outboxId)
    f.script['POST ' + target] = Object.assign(new Error('gh exited'), {
      code: 1, stderr: 'gh: API rate limit exceeded (HTTP 429)\n',
    })
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.match(readRow().lastError, /rejected.*HTTP 429/i)
    f.script['POST ' + target] = { id: 9001 }
    reopened = f.reopen()
    f.script.user = { login: 'different-account' }
    assert.equal((await reopened.source.deliverReplies()).delivered, 0)
    assert.match(readRow().lastError, /posting account changed/i)
    assert.equal(f.posts.length, 1)
    f.script.user = { login: 'Ghost233' }
    assert.equal((await reopened.source.deliverReplies()).delivered, 1)
    assert.equal(readRow().state, 'sent')
    assert.equal(readRow().lastError, null)
    assert.equal(f.posts.length, 2)
    assert.equal(f.posts[0].find(arg => arg.startsWith('body=')), f.posts[1].find(arg => arg.startsWith('body=')))
  } finally { reopened?.store.close(); f.cleanup() }
})

test('an ambiguous response after a confirmed rejection consumes the safe retry', async () => {
  const endpoint = 'repos/' + REPO + '/issues/42/comments'
  const post = 'POST ' + endpoint
  const f = fixture()
  try {
    const { outboxId } = await f.router.replySource({ to: 'github:' + REPO + ':42', text: 'status' })
    f.script[post] = Object.assign(new Error('validation failed'), { status: 422 })
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    f.script[post] = Object.assign(new Error('bad gateway'), { status: 502 })
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.equal(f.posts.length, 2)
    f.script[post] = { id: 9001 }
    f.script[endpoint] = Object.assign(new Error('lookup rate limited'), { status: 429 })
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.match(f.outbox().find(row => row.id === outboxId).lastError, /outcome unknown.*lookup/i)
    f.script[endpoint] = []
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.equal(f.posts.length, 2)
  } finally { f.cleanup() }
})

test('HTTP 408, killed gh, and malformed success never enable another POST', async () => {
  const target = 'repos/' + REPO + '/issues/42/comments'
  const ambiguousResponses = [
    Object.assign(new Error('request timeout'), { status: 408 }),
    Object.assign(new Error('gh timed out'), { code: 1, killed: true, stderr: 'gh: HTTP 429: Too Many Requests' }),
    new Error('connection failed while reporting HTTP 429'),
    { unexpected: 'missing comment id' },
  ]
  for (const response of ambiguousResponses) {
    const f = fixture()
    try {
      const { outboxId } = await f.router.replySource({ to: 'github:' + REPO + ':42', text: 'status' })
      f.script['POST ' + target] = response
      assert.equal((await f.source.deliverReplies()).delivered, 0)
      assert.match(f.outbox().find(row => row.id === outboxId).lastError, /outcome unknown/i)
      f.script[target] = []
      f.script['POST ' + target] = { id: 9001 }
      assert.equal((await f.source.deliverReplies()).delivered, 0)
      assert.equal(f.posts.length, 1)
    } finally { f.cleanup() }
  }
})

test('repeated empty and failed lookups leave an ambiguous reply retryable without posting again', async () => {
  const target = 'repos/' + REPO + '/issues/42/comments'
  const f = fixture()
  let reopened
  try {
    const { insertOutbox, retryOutboxRows } = await import('../src/outbox.js')
    const row = insertOutbox(f.store, { kind: 'reply', to: 'github:' + REPO + ':42', body: 'status', state: 'recorded' })
    const readRow = () => f.outbox().find(item => item.id === row.id)
    let posted
    f.script['POST ' + target] = args => {
      posted = comment({ id: 9001, body: args.find(arg => arg.startsWith('body=')).slice('body='.length) })
      throw new Error('synthetic timeout after remote accepted POST')
    }
    assert.equal((await f.source.deliverReplies()).delivered, 0)
    f.script['POST ' + target] = { id: 9002 }
    reopened = f.reopen()
    for (const response of [[], new Error('synthetic unavailable lookup'), [], new Error('synthetic unavailable lookup again')]) {
      f.script[target] = response
      assert.equal((await reopened.source.deliverReplies()).delivered, 0)
      assert.equal(f.posts.length, 1)
      assert.match(readRow().lastError, /outcome unknown/i)
    }
    assert.equal(readRow().state, 'failed')
    assert.equal(readRow().originState, 'recorded')
    f.script[target] = [posted]
    assert.equal(retryOutboxRows(reopened.store, [row.id]), 1)
    assert.equal((await reopened.source.deliverReplies()).delivered, 1)
    assert.equal(readRow().state, 'sent')
    assert.equal(f.posts.length, 1)
  } finally { reopened?.store.close(); f.cleanup() }
})

test('a late exact GitHub receipt settles ordinary work held for manual retry', async () => {
  const target = 'repos/' + REPO + '/issues/42/comments'
  const f = fixture()
  try {
    const { insertOutbox, retryOutboxRows } = await import('../src/outbox.js')
    const row = insertOutbox(f.store, { kind: 'reply', to: 'github:' + REPO + ':42', body: 'fixture ordinary', state: 'recorded', notificationWindowMs: 60_000 })
    let posted
    f.script['POST ' + target] = args => {
      posted = comment({ id: 9001, body: args.find(arg => arg.startsWith('body=')).slice('body='.length) })
      throw new Error('fixture timeout with ambiguous outcome')
    }
    for (let attempt = 0; attempt < 5; attempt++) await f.source.deliverReplies()
    assert.equal(retryOutboxRows(f.store, [row.id], f.source.now), 1)
    const read = () => f.outbox().find(item => item.id === row.id)
    assert.equal(read().state, 'held')
    assert.equal(read().notificationRetry, true)
    assert.deepEqual(await f.source.handleCommentEvent(posted, REPO_CFG), { skipped: 'self-generated' })
    assert.equal(read().state, 'sent')
    assert.equal(read().notificationRetry, undefined)
    assert.equal(read().requestId, row.requestId)
    assert.equal(f.posts.length, 1)
  } finally { f.cleanup() }
})

test('polling settles a failed ambiguous reply when its marker becomes visible', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const target = issues + '/42/comments'
  const f = fixture()
  try {
    await f.source.pollWatchedRepo(REPO)
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const readAck = () => f.outbox().find(row => row.ticketId === routed.ticketId && row.kind === 'reply')
    let posted
    f.script['POST ' + target] = args => {
      posted = comment({ id: 9001, body: args.find(arg => arg.startsWith('body=')).slice('body='.length) })
      throw new Error('synthetic lost response')
    }
    for (let i = 0; i < 5; i++) assert.equal((await f.source.deliverReplies()).delivered, 0)
    assert.equal(readAck().state, 'failed')
    assert.equal(f.posts.length, 1)
    f.script[issues + '/comments'] = [posted]
    assert.equal((await f.source.pollWatchedRepo(REPO)).triggered, 0)
    assert.equal(readAck().state, 'sent')
    assert.equal(readAck().lastError, null)
    assert.equal(f.posts.length, 1)
  } finally { f.cleanup() }
})

test('polling recognizes an in-flight reply without waiting to admit a manual comment', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture()
  const visible = Promise.withResolvers()
  const release = Promise.withResolvers()
  let delivery
  try {
    await f.source.pollAll()
    await f.source.handleIssueEvent(issue(), REPO_CFG)
    const human = comment({ id: 9002, body: 'manual comment' })
    f.script['POST ' + issues + '/42/comments'] = async args => {
      const self = comment({ id: 9001, body: args[args.indexOf('-f') + 1].slice('body='.length) })
      f.script[issues + '/comments'] = [self, human]
      visible.resolve()
      await release.promise
      return self
    }
    delivery = f.source.deliverReplies()
    await visible.promise
    assert.equal((await f.source.pollWatchedRepo(REPO)).triggered, 1)
    release.resolve()
    assert.equal((await delivery).delivered, 1)
    assert.deepEqual(f.tickets().map(t => t.triggerId), [
      'github:' + REPO + ':issue:42', 'github:' + REPO + ':comment:9002',
    ])
  } finally {
    release.resolve()
    await Promise.allSettled([delivery])
    f.cleanup()
  }
})

test('a restart reuses the receipt for the same outbox row when a POST completes during shutdown', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture()
  const posted = comment({ id: 9001, body: 'recorded acknowledgement' })
  const started = Promise.withResolvers()
  const reply = Promise.withResolvers()
  let delivery, reopened
  try {
    await f.source.pollAll()
    const routed = await f.source.handleIssueEvent(issue(), REPO_CFG)
    const outboxId = f.outbox().find(row => row.ticketId === routed.ticketId && row.state === 'recorded').id
    f.script['POST ' + issues + '/42/comments'] = () => { started.resolve(); return reply.promise }
    delivery = f.source.deliverReplies()
    await started.promise
    f.store.close()
    reply.resolve(posted)
    await assert.rejects(delivery, /database.*(?:closed|not open)/i)
    reopened = f.reopen()
    const readRow = () => JSON.parse(reopened.store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(outboxId).value)
    assert.equal(readRow().state, 'recorded')
    assert.equal((await reopened.source.deliverReplies()).delivered, 1)
    assert.equal(readRow().state, 'sent')
    assert.equal(f.posts.length, 1)
    f.script[issues + '/comments'] = [posted]
    assert.equal((await reopened.source.pollWatchedRepo(REPO)).triggered, 0)
    assert.equal(f.calls.prompt.length, 1)
  } finally {
    reply.resolve(posted)
    await Promise.allSettled([delivery])
    reopened?.store.close()
    f.cleanup()
  }
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
    const fetched = comment({ body: '@hub-bot 处理这条', createdAt: '2026-11-15T01:05:00Z' })
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

test('issue pagination crosses number gaps, deduplicates overlap and stops at the saved floor', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture({ script: { [issues]: [issue({ number: 41 })] } })
  try {
    await f.source.pollAll()
    const highPage = Array.from({ length: 100 }, (_, index) => issue({ number: 250 - index * 2, login: 'stranger' }))
    const pull = issue({ number: 47, pr: true })
    const opened = issue()
    f.script[issues] = args => {
      const query = new URLSearchParams(args[1].split('?')[1])
      assert.equal(query.get('state'), 'all')
      assert.equal(query.get('sort'), 'created')
      assert.equal(query.get('direction'), 'desc')
      assert.deepEqual(args.slice(2), ['--hostname', 'github.com'])
      if (query.get('page') === '1') return highPage
      if (query.get('page') === '2') return [highPage.at(-1), pull, opened, issue({ number: 40 })]
      throw new Error('old history must not be fetched')
    }
    const first = comment({ id: 5001, body: '@hub-bot 确认行为' })
    const second = comment({ id: 5002, body: '补充说明', issueNumber: 47 })
    f.script[issues + '/comments'] = [second, first, second]
    assert.deepEqual(await f.source.pollWatchedRepo(REPO), { triggered: 4, dropped: 100, terminated: 0 })
    assert.deepEqual(new Set(f.tickets().map(t => t.triggerId)), new Set([
      'github:' + REPO + ':issue:42', 'github:' + REPO + ':pr:47',
      'github:' + REPO + ':comment:5001', 'github:' + REPO + ':comment:5002',
    ]))
    const issueReads = f.reads.filter(args => args[1].startsWith(issues + '?'))
    assert.deepEqual(issueReads.map(args => new URLSearchParams(args[1].split('?')[1]).get('page')), ['1', '1', '2'])
    const commentReads = f.reads.filter(args => args[1].startsWith(issues + '/comments?'))
    assert.deepEqual(commentReads.map(args => args.slice(2)), [['--hostname', 'github.com'], ['--hostname', 'github.com']])
    assert.equal((await f.source.status()).repos[REPO].maxCommentId, 5002)
    assert.equal((await f.source.status()).repos[REPO].maxNumber, 250)
  } finally { f.cleanup() }
})

test('a failed later issue page leaves the saved floor available after reopening', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture({ script: { [issues]: [issue({ number: 41 })] } })
  let reopened
  try {
    await f.source.pollWatchedRepo(REPO)
    const checkpoint = () => readFileSync(watermarkPath(f.store.stateDir), 'utf8')
    const before = checkpoint()
    const first = Array.from({ length: 100 }, (_, index) => issue({ number: 142 - index, login: 'stranger' }))
    f.script[issues] = args => args[1].endsWith('&page=1') ? first : new Error('synthetic second page timeout')
    await assert.rejects(f.source.pollWatchedRepo(REPO), /synthetic second page timeout/)
    assert.equal(checkpoint(), before)
    assert.equal(f.triggers().length, 0)
    assert.equal((await f.source.status()).repos[REPO].lastError, 'synthetic second page timeout')
    f.script[issues] = args => args[1].endsWith('&page=1') ? first : [issue(), issue({ number: 41 })]
    reopened = f.reopen()
    assert.deepEqual(await reopened.source.pollWatchedRepo(REPO), { triggered: 1, dropped: 100, terminated: 0 })
    assert.equal(f.tickets()[0].triggerId, 'github:' + REPO + ':issue:42')
    assert.equal((await reopened.source.status()).repos[REPO].maxNumber, 142)
  } finally { reopened?.store.close(); f.cleanup() }
})

test('a partial comment-page fetch keeps the old checkpoint and a reopened poll catches up across equal timestamps', async () => {
  const comments = 'repos/' + REPO + '/issues/comments'
  const f = fixture()
  let reopened
  try {
    await f.source.pollWatchedRepo(REPO)
    const before = readFileSync(watermarkPath(f.store.stateDir), 'utf8')
    f.setNow('2026-11-15T01:05:00.000Z')
    const one = comment({ id: 5001, body: '@hub-bot 第一条' })
    const two = comment({ id: 5002, body: '@hub-bot 第二条' })
    const filler = Array.from({ length: 99 }, (_, index) => comment({ id: 6000 + index, login: 'stranger' }))
    f.script[comments] = args => {
      const query = new URLSearchParams(args[1].split('?')[1])
      if (args.includes('--slurp')) throw new Error('unbounded combined response')
      if (query.get('page') === '1') return [one, ...filler].slice(0, Number(query.get('per_page')))
      throw new Error('synthetic second comment page timeout')
    }
    await assert.rejects(f.source.pollWatchedRepo(REPO), /synthetic second comment page timeout/)
    assert.equal(readFileSync(watermarkPath(f.store.stateDir), 'utf8'), before)
    assert.equal(f.calls.prompt.length, 0)
    f.script[comments] = args => {
      const query = new URLSearchParams(args[1].split('?')[1])
      const size = Number(query.get('per_page'))
      if (query.get('page') === '1') return [one, ...filler].slice(0, size)
      if (query.get('page') === '2') return [one, two]
      throw new Error('unneeded extra comment page')
    }
    reopened = f.reopen()
    assert.equal((await reopened.source.pollWatchedRepo(REPO)).triggered, 2)
    assert.deepEqual(f.tickets().map(row => row.triggerId), [
      'github:' + REPO + ':comment:5001', 'github:' + REPO + ':comment:5002',
    ])
  } finally { reopened?.store.close(); f.cleanup() }
})

test('a deletion between comment pages exposes a moved boundary and a fresh poll recovers the skipped comment', async () => {
  const comments = 'repos/' + REPO + '/issues/comments'
  const f = fixture()
  let reopened
  try {
    await f.source.pollWatchedRepo(REPO)
    const checkpoint = () => readFileSync(watermarkPath(f.store.stateDir), 'utf8')
    const before = checkpoint()
    f.setNow('2026-11-15T02:00:00.000Z')
    const createdAt = '2026-11-15T01:05:00Z'
    const records = Array.from({ length: 32 }, (_, i) => comment({ id: 5001 + i, createdAt, login: 'stranger' }))
    records[30] = comment({ id: 5031, createdAt, body: '@hub-bot recover the skipped comment' })
    let deleted = false
    f.script[comments] = args => {
      const query = new URLSearchParams(args[1].split('?')[1])
      const page = Number(query.get('page'))
      const size = Number(query.get('per_page'))
      if (page === 2 && !deleted) { records.shift(); deleted = true }
      return records.slice((page - 1) * size, page * size)
    }
    await assert.rejects(f.source.pollWatchedRepo(REPO), /comment page boundary changed/i)
    assert.equal(checkpoint(), before)
    assert.equal(f.calls.prompt.length, 0)
    assert.match((await f.source.status()).repos[REPO].lastError, /comment page boundary changed/i)
    reopened = f.reopen()
    assert.equal((await reopened.source.pollWatchedRepo(REPO)).triggered, 1)
    assert.deepEqual(f.tickets().map(t => t.triggerId), ['github:' + REPO + ':comment:5031'])
    assert.equal((await reopened.source.status()).repos[REPO].maxCommentId, 5032)
  } finally { reopened?.store.close(); f.cleanup() }
})

test('bootstrap skips observed comments and admits a new comment in the same GitHub second', async () => {
  const comments = 'repos/' + REPO + '/issues/comments'
  const f = fixture()
  let reopened
  try {
    f.setNow('2026-11-15T00:00:00.800Z')
    const historical = comment({ id: 5001, body: '@hub-bot already present at startup' })
    const earlier = comment({ id: 4999, body: '@hub-bot older backlog', createdAt: '2026-11-14T23:59:58Z' })
    let records = [earlier, historical]
    f.script[comments] = args => {
      const since = new URLSearchParams(args[1].split('?')[1]).get('since')
      return records.filter(item => Date.parse(item.updated_at) > Date.parse(since))
    }
    assert.equal((await f.source.pollWatchedRepo(REPO)).triggered, 0)
    assert.equal(f.tickets().length, 0)
    const newcomer = comment({ id: 5002, body: '@hub-bot arrived after the bootstrap' })
    records = [...records, newcomer]
    f.setNow('2026-11-15T00:00:01.200Z')
    reopened = f.reopen()
    assert.equal((await reopened.source.pollWatchedRepo(REPO)).triggered, 1)
    assert.deepEqual(f.tickets().map(item => item.triggerId), ['github:' + REPO + ':comment:5002'])
    records = [{ ...historical, updated_at: '2026-11-15T00:00:02Z' }, newcomer]
    f.setNow('2026-11-15T00:00:03Z')
    assert.equal((await reopened.source.pollWatchedRepo(REPO)).triggered, 0)
  } finally { reopened?.store.close(); f.cleanup() }
})

test('a frozen cutoff defers late updates and replays only unseen IDs on its boundary', async () => {
  const comments = 'repos/' + REPO + '/issues/comments'
  const f = fixture()
  try {
    await f.source.pollAll()
    f.setNow('2026-11-15T01:05:00.500Z')
    const boundary = comment({ id: 5003, body: '@hub-bot boundary', createdAt: '2026-11-15T01:05:00Z' })
    const late = comment({ id: 5001, body: '@hub-bot late update', createdAt: '2026-11-14T23:59:00Z', updatedAt: '2026-11-15T01:05:01Z' })
    f.script[comments] = () => {
      f.setNow('2026-11-15T01:05:02.000Z')
      return [late, boundary]
    }
    assert.equal((await f.source.pollWatchedRepo(REPO)).triggered, 1)
    const atBoundary = comment({ id: 5002, body: '@hub-bot same second', createdAt: boundary.created_at })
    f.script[comments] = args => {
      const query = new URLSearchParams(args[1].split('?')[1])
      assert.equal(query.get('sort'), 'created')
      assert.equal(query.get('direction'), 'asc')
      const since = Date.parse(query.get('since'))
      return [late, atBoundary, { ...boundary, body: '停', updated_at: '2026-11-15T01:05:01Z' }]
        .filter(item => Date.parse(item.updated_at) > since)
    }
    assert.equal((await f.source.pollWatchedRepo(REPO)).triggered, 2)
    assert.deepEqual(f.tickets().map(row => row.triggerId), [5003, 5001, 5002].map(id => 'github:' + REPO + ':comment:' + id))
    assert.equal(f.calls.cancel.length, 0)
    assert.equal((await f.source.status()).repos[REPO].maxCommentId, 5003)
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
    f.script[comments] = [comment({ body: '@hub-bot 第一条' }), comment({ id: 5002, body: '@hub-bot 第二条' })]
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
    f.reads.length = 0
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
      return [comment({ body: '@hub-bot 查看' })]
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
    assert.equal(f.reads.length, 2)
    assert.ok(f.reads[0][1].startsWith('repos/' + added.repo + '/issues?'))
    assert.ok(f.reads[1][1].startsWith('repos/' + added.repo + '/issues/comments?'))
    f.source.config.enabled = false
    assert.equal((await f.source.pollWatchedRepo(added.repo)).disabled, true)
    f.source.config.enabled = true
    f.registry.markRecycled(owner.id)
    assert.equal(await f.source.pollWatchedRepo(added.repo), null)
    assert.equal(f.reads.length, 2)
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

test('manual and scheduled polling wait for one default login check and retry after failure', async () => {
  const issues = 'repos/' + REPO + '/issues'
  const f = fixture({ script: { [issues]: [issue({ number: 41 })] } })
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let manual, scheduled
  try {
    await f.source.pollWatchedRepo(REPO)
    f.source.config.loginAllowlist = []
    f.setNow('2026-11-15T02:00:00.000Z')
    f.script[issues] = [issue(), issue({ number: 41 })]
    const checkpoint = () => readFileSync(watermarkPath(f.store.stateDir), 'utf8')
    const before = checkpoint()
    f.reads.length = 0
    f.script.user = async () => {
      started.resolve()
      await release.promise
      throw new Error('synthetic auth timeout')
    }
    manual = f.source.pollWatchedRepo(REPO)
    scheduled = f.source.pollAll()
    await started.promise
    assert.deepEqual(f.reads, [['api', 'user', '--hostname', 'github.com']])
    assert.equal(checkpoint(), before)
    release.resolve()
    await assert.rejects(manual, /synthetic auth timeout/)
    assert.deepEqual(await scheduled, { triggered: 0, dropped: 0, terminated: 0 })
    assert.deepEqual(f.reads, [['api', 'user', '--hostname', 'github.com']])
    assert.equal(checkpoint(), before)
    assert.equal((await f.source.status()).repos[REPO].lastError, 'synthetic auth timeout')
    f.script.user = { login: 'Ghost233' }
    const recovered = await f.source.pollWatchedRepo(REPO)
    assert.equal(recovered.triggered, 1)
    assert.equal(f.reads.filter(args => args[1] === 'user').length, 2)
    assert.equal((await f.source.status()).repos[REPO].lastError, undefined)
    assert.deepEqual(f.source.config.loginAllowlist, ['Ghost233'])
  } finally {
    release.resolve()
    await Promise.allSettled([manual, scheduled])
    f.cleanup()
  }
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
