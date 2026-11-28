/**
 * Panel domain (#73 面板三问与设置页): settings patch/overlay validation + persistence, the 三问 overview
 * assembly (票面权威 — tickets carry their own facts, the panel never invents state), and the settings view
 * builder. Pure functions over Store/OwnerRegistry; HTTP wiring lives in src/index.js.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync, openSync, closeSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { insertOutbox } from '../src/outbox.js'
import { OwnerRegistry } from '../src/registry.js'
import { Router } from '../src/router.js'
import { resolveConfig } from '../src/config.js'
import {
  SETTINGS_FILE, SettingsError,
  applySettingsPatch, applySettingsOverlay, loadSettingsOverlay, saveSettingsOverlay, mergeSettingsOverlay,
  buildSettingsView, buildOverview, buildOutboxHealth, readMessageDetail, readTicketDetail, buildIntakePolicy,
} from '../src/panel.js'

/** A fully resolved config with feishu/github sections on — the shape the panel mutates. */
function baseConfig() {
  return resolveConfig({
    stateDir: '/tmp/hub-bot-panel-config',
    homeRepo: '/Volumes/home',
    feishu: { enabled: true },
    github: { enabled: true, intervalMs: 300000, loginAllowlist: ['ghost'] },
  })
}

/** A registry+router with a fake Sessions port (same pattern as router.test.js). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-panel-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const sessions = {
    create: async () => ({ sessionId: 'session-fake-' + Math.random().toString(36).slice(2, 8) }),
    prompt: async () => ({ accepted: true }),
  }
  const router = new Router({ store, registry, sessions, now: () => new Date(nowMs).toISOString() })
  return { router, registry, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('settings patch applies whitelisted keys live and returns the storable overlay', () => {
  const config = baseConfig()
  const overlay = applySettingsPatch(config, {
    concurrency: { slotsPerOwner: 2 },
    reporting: { auto: true, intervalMs: 5000 },
    github: { enabled: false, intervalMs: 60000, loginAllowlist: ['ghost', 'hub-bot-app'] },
  })
  assert.equal(config.concurrency.slotsPerOwner, 2)
  assert.equal(config.reporting.auto, true)
  assert.equal(config.reporting.intervalMs, 5000)
  assert.equal(config.github.enabled, false)
  assert.equal(config.github.intervalMs, 60000)
  assert.deepEqual(config.github.loginAllowlist, ['ghost', 'hub-bot-app'])
  assert.deepEqual(overlay, {
    concurrency: { slotsPerOwner: 2 },
    reporting: { auto: true, intervalMs: 5000 },
    github: { enabled: false, intervalMs: 60000, loginAllowlist: ['ghost', 'hub-bot-app'] },
  }, 'the overlay is exactly the validated patch — restart replays it onto the profile config')
})

test('settings patch rejects unknown sections and keys (typos cannot pass silently)', () => {
  const config = baseConfig()
  assert.throws(() => applySettingsPatch(config, { telemetry: { on: true } }), (error) => {
    assert.equal(error.name, 'SettingsError')
    assert.match(error.message, /unknown settings section "telemetry"/)
    return true
  })
  assert.throws(() => applySettingsPatch(config, { reporting: { bogus: true } }), /does not know settings key "reporting.bogus"/)
  assert.equal(config.reporting.auto, false, 'a rejected patch mutates nothing')
})

test('a GitHub switch only changes after the entire patch is validated and persisted', () => {
  const config = baseConfig()
  const github = config.github
  assert.throws(() => applySettingsPatch(config, { github: { enabled: false, intervalMs: 1000 } }), /github.intervalMs/)
  assert.equal(github.enabled, true)
  assert.throws(() => applySettingsPatch(config, { github: { enabled: false } }, () => { throw new Error('disk full') }), /disk full/)
  assert.equal(github.enabled, true)
  applySettingsPatch(config, { github: { enabled: false } }, patch => {
    assert.equal(patch.github.enabled, false)
    assert.equal(github.enabled, true)
  })
  assert.equal(config.github, github)
  assert.equal(github.enabled, false)
})

test('settings patch validates values: slots >= 1, github interval >= 30s, allowlists are string arrays', () => {
  const config = baseConfig()
  assert.throws(() => applySettingsPatch(config, { concurrency: { slotsPerOwner: 0 } }), /slotsPerOwner must be a positive integer/)
  assert.throws(() => applySettingsPatch(config, { concurrency: { slotsPerOwner: 1.5 } }), /slotsPerOwner must be a positive integer/)
  assert.throws(() => applySettingsPatch(config, { reporting: { auto: 'yes' } }), /reporting.auto must be a boolean/)
  assert.throws(() => applySettingsPatch(config, { reporting: { intervalMs: 0 } }), /reporting.intervalMs must be a positive number/)
  assert.throws(() => applySettingsPatch(config, { github: { intervalMs: 1000 } }), /github.intervalMs must be an integer >= 30000/)
  assert.throws(() => applySettingsPatch(config, { github: { loginAllowlist: 'ghost' } }), /github.loginAllowlist must be an array of non-empty strings/)
  assert.throws(() => applySettingsPatch(config, { feishu: { openIdAllowlist: ['ou_a'] } }), /does not know settings key/, 'feishu.openIdAllowlist 已移除（授权边界在飞书侧）')
  // chief.model: null 回到部署默认; 对象需 provider+model; 未知键与坏形状拒绝
  const config2 = baseConfig()
  const applied = applySettingsPatch(config2, { chief: { model: { provider: 'magpie', model: 'zhipu/glm-4.5', reasoningEffort: 'high' } } })
  assert.deepEqual(config2.chief.model, { provider: 'magpie', model: 'zhipu/glm-4.5', reasoningEffort: 'high' })
  assert.deepEqual(applied.chief.model, config2.chief.model)
  assert.throws(() => applySettingsPatch(baseConfig(), { chief: { model: { provider: 'magpie' } } }), /model.model must be a non-empty string/)
  assert.throws(() => applySettingsPatch(baseConfig(), { chief: { model: { provider: 'magpie', model: 'm', bogus: 1 } } }), /does not know key/)
  const config3 = baseConfig()
  applySettingsPatch(config3, { chief: { model: null } })
  assert.equal(config3.chief.model, null, 'null 显式回到部署默认')
  // github.repos 已移除（监听清单跟随 owner 注册表）——旧键按未知键拒绝
  assert.throws(() => applySettingsPatch(config, { github: { repos: { 'o/r': false } } }), /does not know settings key "github\.repos"/)
})

test('settings overlay persists 0600 and round-trips; missing or corrupt files read as empty (boot must not break)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-overlay-'))
  try {
    assert.deepEqual(loadSettingsOverlay(dir), {}, 'no overlay file → empty')
    const overlay = { reporting: { auto: true }, github: { enabled: false } }
    saveSettingsOverlay(dir, overlay)
    assert.equal(statSync(join(dir, SETTINGS_FILE)).mode & 0o777, 0o600, 'owner-only like the credentials file')
    assert.deepEqual(loadSettingsOverlay(dir), overlay)
    writeFileSync(join(dir, SETTINGS_FILE), '{not json')
    assert.deepEqual(loadSettingsOverlay(dir), {}, 'corrupt overlay → empty, plugin still boots')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings overlay replays onto the profile config at boot (applySettingsOverlay)', () => {
  const config = baseConfig()
  applySettingsOverlay(config, { concurrency: { slotsPerOwner: 1 }, github: { intervalMs: 60000 } })
  assert.equal(config.concurrency.slotsPerOwner, 1)
  assert.equal(config.github.intervalMs, 60000)
  // 覆盖层与面板补丁同一条校验路径：坏键同样拒绝（写层即产生，不可能漂移出非法值）
  assert.throws(() => applySettingsOverlay(config, { reporting: { bogus: true } }), /does not know settings key/)
})

test('settings overlay merge accumulates sections key-wise instead of clobbering', () => {
  let overlay = {}
  overlay = mergeSettingsOverlay(overlay, { github: { enabled: true }, reporting: { auto: true } })
  overlay = mergeSettingsOverlay(overlay, { github: { intervalMs: 60000 } })
  overlay = mergeSettingsOverlay(overlay, { concurrency: { slotsPerOwner: 1 } })
  assert.deepEqual(overlay, {
    github: { enabled: true, intervalMs: 60000 },
    reporting: { auto: true },
    concurrency: { slotsPerOwner: 1 },
  }, '两次补丁的 github 键都还在')
})

test('overview answers the three questions from ticket faces: state / doing / outcome', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    const r1 = await router.routeToOwner({ ownerId: owner.id, message: '实现登录功能' })
    const t1 = router.getTicket(r1.ticketId)
    assert.equal(t1.stage, 'working')
    // L2 建执行会话后票面记 Assignment（bindWorkerSession 是 assignments 的唯一来源）
    router.tasks.bindWorkerSession(r1.ticketId, { sessionId: 'session-worker-1', cwd: '/repos/DSH-Workflow' })
    router.tasks.report({
      ticketId: r1.ticketId, summary: '登录已实现',
      sections: { result: '登录可用', changes: 'auth.ts', verification: 'npm test 绿', risks: '无' },
    })
    const r2 = await router.routeToOwner({ ownerId: owner.id, message: '重构存储层' })
    router.tasks.askConfirm({ ticketId: r2.ticketId, question: '要 fork 会话执行吗？', action: { type: 'fork', sessionId: 'session-fake-1' } })
    const listing = ['app/', 'proof.txt']
    const overview = buildOverview({
      store, registry, now: () => '2026-11-15T00:00:00.000Z',
      health: { feishu: { credentialState: 'ok' } },
      listDir: () => listing,
    })
    assert.equal(overview.generatedAt, '2026-11-15T00:00:00.000Z')
    assert.deepEqual(overview.health, { feishu: { credentialState: 'ok' } }, 'health passes through untouched')
    assert.equal(overview.owners.length, 2, 'chief + repo owner')
    assert.ok(overview.owners.some(o => o.role === 'chief'))
    const repo = overview.owners.find(o => o.id === owner.id)
    assert.equal(repo.kind, 'repo')
    assert.equal(repo.workspace, 'DSH-Workflow')
    assert.equal(repo.cwd, '/repos/DSH-Workflow')
    assert.equal(repo.recycled, false)
    // Q1 什么状态: stage + stageText 朗读, counts derivable from the list (诚实状态: 计数 = 列表长度)
    const ticket1 = overview.tickets.find(t => t.id === r1.ticketId)
    const ticket2 = overview.tickets.find(t => t.id === r2.ticketId)
    assert.equal(ticket1.stage, 'person/review')
    assert.equal(ticket1.stageText, '等您验收')
    assert.equal(ticket2.stage, 'person/confirm')
    assert.equal(ticket2.stageText, '等您确认')
    assert.equal(ticket2.pendingConfirm.text, '要 fork 会话执行吗？', '确认票带着待裁决问题')
    // Q3 结果在哪: report 四段事实 + 产物目录清单 + 授权记录
    assert.equal(ticket1.message, '实现登录功能', 'trigger 原文随票面')
    assert.equal(ticket1.report.sections.result, '登录可用')
    assert.equal(ticket1.report.sections.risks, '无')
    assert.deepEqual(ticket1.dirListing, listing, '等验收票列出产物目录')
    assert.ok(ticket1.authorization && typeof ticket1.authorization.actor === 'string' && typeof ticket1.authorization.at === 'string', '授权记录在票面 (AC 11: 谁授权的、什么时候)')
    assert.ok(ticket1.trigger && ticket1.trigger.id === ticket1.trigger.id, '基于哪条消息: Trigger 引用在票面')
    assert.equal(ticket2.dirListing, null, '非等验收票不列目录')
    assert.ok(Array.isArray(ticket1.assignments) && ticket1.assignments.length >= 1, '任务历史: Assignment 段在票面')
    // 最近消息流: trigger 倒序投影，带票面的 owner/阶段，倒序排列
    assert.ok(Array.isArray(overview.recentTriggers), 'recentTriggers 在 overview 里')
    assert.equal(overview.recentTriggers.length, 2, '两条 trigger 都在流里')
    const confirmMsg = overview.recentTriggers.find(t => t.message === '重构存储层')
    const reviewMsg = overview.recentTriggers.find(t => t.message === '实现登录功能')
    assert.ok(confirmMsg && reviewMsg, '两条消息都在流里（fixture 的 now 固定，at 相同，不断言顺序）')
    assert.equal(confirmMsg.ownerLabel, 'DSH-Workflow', '消息带 owner 标签')
    assert.equal(confirmMsg.stage, 'person/confirm', '消息带票面阶段')
    assert.equal(confirmMsg.kind, 'route', 'kind 投影（fixture 里 routeToOwner 直记的 kind）')
    assert.ok(confirmMsg.ticketId && reviewMsg.ticketId, 'ticketId 投影在')
  } finally {
    cleanup()
  }
})

test('Overview shows answers, confirmations, reviews, and attention before work in stable order', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Overview', cwd: '/repos/Overview' })
    const first = await router.routeToOwner({ ownerId: owner.id, message: 'Started first' })
    const queued = await router.routeToOwner({ ownerId: owner.id, message: 'Waiting for a slot' })
    router.tasks.demote(queued.ticketId)
    const review = await router.routeToOwner({ ownerId: owner.id, message: 'Ready for review' })
    router.tasks.report({ ticketId: review.ticketId, summary: 'Ready' })
    const confirm = await router.routeToOwner({ ownerId: owner.id, message: 'Needs confirmation' })
    router.tasks.askConfirm({ ticketId: confirm.ticketId, question: 'Proceed?' })
    const answer = await router.routeToOwner({ ownerId: owner.id, message: 'Needs an answer' })
    router.tasks.ask({ ticketId: answer.ticketId, question: 'Which file?' })
    const nextAnswer = await router.routeToOwner({ ownerId: owner.id, message: 'Needs another answer' })
    router.tasks.ask({ ticketId: nextAnswer.ticketId, question: 'Which branch?' })
    const attention = await router.routeToOwner({ ownerId: owner.id, message: 'Needs attention' })
    router.tasks.fail({ ticketId: attention.ticketId, reason: 'Test failure' })

    const overview = buildOverview({ store, registry, compact: true })
    assert.deepEqual(overview.tickets.map(ticket => ticket.id), [
      answer.ticketId, nextAnswer.ticketId, confirm.ticketId, review.ticketId, attention.ticketId, first.ticketId, queued.ticketId,
    ])
  } finally {
    cleanup()
  }
})

test('large Overview history keeps report previews and opens one full result on demand', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Results', cwd: '/repos/Results' })
    const result = await router.routeToOwner({ ownerId: owner.id, message: 'Build the result' })
    registry.bindSession(owner.id, 'session-current-owner')
    const evidence = ('Verification log: ' + 'full result and artifacts. '.repeat(250)).trimEnd()
    const report = { summary: 'Ready for review', evidence,
      sections: { result: 'Success', changes: 'Artifacts', verification: evidence, risks: 'None' } }
    router.tasks.report({ ticketId: result.ticketId, ...report })

    // Seed retained records directly so the fixture can represent a long-running installation.
    const insert = store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)')
    store.db.exec('BEGIN')
    for (let i = 0; i < 1000; i++) {
      const id = 'historical-' + i
      insert.run(id, JSON.stringify({ id, owner: owner.id, stage: 'done', report,
        routedMessage: 'Completed task ' + i, assignments: [{ note: evidence }] }))
    }
    store.db.exec('COMMIT')

    let directoryReads = 0
    const listDir = () => { directoryReads += 1; return ['proof.txt'] }
    const overview = buildOverview({ store, registry, compact: true, listDir })
    assert.equal(overview.tickets.length, 1001)
    assert.equal(overview.tickets[0].id, result.ticketId)
    assert.equal(overview.tickets[0].report.summary, report.summary)
    assert.equal(overview.tickets.at(-1).id, 'historical-999')
    assert.ok(JSON.stringify(overview).length < 600_000, 'the list stays compact across retained results')
    assert.equal(directoryReads, 0, 'directory is read when the report opens')

    const detail = readTicketDetail({ store, registry, ticketId: result.ticketId, listDir })
    assert.equal(detail.message, 'Build the result')
    assert.equal(detail.report.sections.verification, evidence)
    assert.equal(detail.report.evidence, evidence)
    assert.deepEqual(detail.dirListing, ['proof.txt'])
    assert.equal(detail.ownerSessionId, 'session-current-owner')
    assert.equal(directoryReads, 1)
    assert.equal(readTicketDetail({ store, registry, ticketId: 'missing' }), null)
  } finally {
    cleanup()
  }
})

test('overview lists artifacts for working tickets too (round 45)', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    const r1 = await router.routeToOwner({ ownerId: owner.id, message: '持续改造中' })
    const listing = ['src/', 'wip-notes.md']
    const overview = buildOverview({ store, registry, listDir: () => listing })
    const ticket = overview.tickets.find(t => t.id === r1.ticketId)
    assert.equal(ticket.stage, 'working')
    assert.deepEqual(ticket.dirListing, listing, '进行中的票也列产物目录')
  } finally {
    cleanup()
  }
})

test('overview counts unprocessed triggers older than 5 minutes (round 67)', async () => {
  const { store, registry, cleanup } = fixture()
  try {
    const now = '2026-11-19T12:00:00.000Z'
    const put = (id, at, chatId, extra = {}) => store.db
      .prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
      .run(id, JSON.stringify({ id, kind: 'feishu', message: id, at, source: { chatId }, ...extra }), at)
    put('trg-old-unhandled', '2026-11-19T11:00:00.000Z', 'chat-y')              // 无票据无回复且超时 → 计数
    put('trg-young-unhandled', '2026-11-19T11:59:00.000Z', 'chat-z')            // 太新 → 不计
    put('trg-dropped', '2026-11-19T11:00:00.000Z', 'chat-w', { dropped: 'unsupported' }) // dropped → 不计
    put('trg-replied', '2026-11-19T11:00:00.000Z', 'chat-x')                    // 有直接回复 → 不计
    insertOutbox(store, { kind: 'reply', state: 'sent', to: 'feishu:chat:chat-x', triggerId: 'trg-replied', body: '收到' }, () => '2026-11-19T11:01:00.000Z')
    const overview = buildOverview({ store, registry, now: () => now, health: {} })
    assert.equal(overview.unprocessedTriggers, 1, '只有又老又没人理的触发被计数')
  } finally { cleanup() }
})

test('Feishu self-test only matches its own reply, even outside the recent message list', () => {
  const { store, registry, cleanup } = fixture()
  try {
    const messageId = 'om_selftest-1234567890abcdef1234567890abcdef'
    const triggerId = 'feishu-' + messageId
    const marker = '[hub-bot-check:' + messageId + ']'
    const chatId = 'same-chat'
    const at = '2026-11-19T11:59:00.000Z'
    const read = () => buildOverview({ store, registry, now: () => '2026-11-19T12:00:00.000Z' })
    const insertTrigger = store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
    insertTrigger.run(triggerId, JSON.stringify({ id: triggerId, kind: 'feishu', at, source: { chatId, messageId } }), at)
    const reply = (body, ref) => insertOutbox(store, { kind: 'reply', state: 'sent', to: 'feishu:chat:' + chatId, triggerId: ref, body },
      () => '2026-11-19T11:59:30.000Z')
    reply('Unrelated reply in the same chat')
    reply('Wrong reply even with the correct trigger reference', triggerId)
    reply('[hub-bot-check:om_selftest-abcdef1234567890abcdef1234567890]', triggerId)
    assert.equal(read().recentTriggers[0].reply, null)

    const expected = reply(marker)
    for (let i = 0; i < 12; i++) {
      const id = 'new-trigger-' + i
      const newerAt = '2026-11-19T11:59:50.000Z'
      insertTrigger.run(id, JSON.stringify({ id, kind: 'route', at: newerAt }), newerAt)
    }
    const overview = read()
    assert.ok(!overview.recentTriggers.some(row => row.id === triggerId))
    const testRun = overview.selfTests.find(row => row.id === triggerId)
    assert.equal(testRun.reply.id, expected.id)
    assert.equal(testRun.reply.state, 'sent')
  } finally { cleanup() }
})

test('recent messages separate dispatch, legacy chat replies and replies to a single message', async () => {
  const { router, store, registry, cleanup } = fixture()
  try {
    const at = '2026-11-15T00:01:00.000Z'
    const put = store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
    for (const [id, tracked] of [['one', true], ['two', true], ['old', false]]) {
      const trigger = {
        id: 'feishu-' + id, kind: 'feishu', at, message: id, source: { chatId: 'same-chat', messageId: id },
        ...(tracked && { injectedAt: at }),
      }
      put.run(trigger.id, JSON.stringify(trigger), at)
    }
    const when = () => '2026-11-15T00:02:00.000Z'
    insertOutbox(store, { kind: 'reply', to: 'feishu:chat:same-chat', state: 'sent', body: 'Legacy reply' }, when)
    insertOutbox(store, { kind: 'reply', to: 'feishu:chat:same-chat', triggerId: 'feishu-two', state: 'sent', body: 'Second message reply' }, when)
    const owner = registry.create({ kind: 'repo', workspace: 'Project', cwd: '/repos/Project' })
    const route = await router.routeToOwner({ ownerId: owner.id, message: 'Local task' })
    insertOutbox(store, { kind: 'reply', to: 'dsh:session:chief', ticketId: route.ticketId, state: 'sent', body: 'Internal report' }, when)
    const view = buildOverview({ store, registry, now: () => '2026-11-15T00:10:00.000Z' })
    const msg = id => view.recentTriggers.find(t => t.id === 'feishu-' + id)
    assert.equal(msg('one').reply, null)
    assert.equal(msg('one').injectedAt, at)
    assert.equal(msg('one').replyUnlinked, true)
    assert.equal(msg('one').unprocessed, true)
    assert.equal(msg('two').reply.text, 'Second message reply')
    assert.equal(msg('two').unprocessed, false)
    assert.equal(msg('old').reply, null)
    assert.equal(msg('old').replyUnlinked, true)
    assert.equal(msg('old').unprocessed, false)
    assert.equal(view.recentTriggers.find(t => t.ticketId === route.ticketId).reply, null)
  } finally { cleanup() }
})

test('combined run notifications stay out of the legacy chat reply fallback', () => {
  const { store, registry, cleanup } = fixture()
  try {
    const at = '2026-11-19T11:00:00.000Z'
    const insert = store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
    for (const chatId of ['batch-chat', 'legacy-chat']) {
      insert.run(chatId, JSON.stringify({ id: chatId, kind: 'feishu', message: 'Question', at, source: { chatId } }), at)
    }
    const sent = () => '2026-11-19T11:01:00.000Z'
    insertOutbox(store, { kind: 'reply', state: 'sent', to: 'feishu:chat:batch-chat', body: 'Runs summary',
      ticketId: null, triggerId: null, notificationWindowMs: 60000 }, sent)
    insertOutbox(store, { kind: 'reply', state: 'sent', to: 'feishu:chat:legacy-chat', body: 'Old reply' }, sent)

    const overview = buildOverview({ store, registry, now: () => '2026-11-19T12:00:00.000Z', compact: true })
    const batch = overview.recentTriggers.find(row => row.id === 'batch-chat')
    assert.equal(batch.replyUnlinked, false)
    assert.equal(batch.unprocessed, true)
    assert.equal(overview.recentTriggers.find(row => row.id === 'legacy-chat').replyUnlinked, true)
    assert.equal(readMessageDetail(store, 'batch-chat').replyUnlinked, false)
  } finally { cleanup() }
})

test('delivery health includes scheduled and channel retries and keeps history separate', () => {
  const { store, cleanup } = fixture()
  try {
    const at = Date.parse('2026-11-15T00:00:00Z')
    const put = (id, state, to, extra = {}) => insertOutbox(store, { id, state, to, kind: 'reply', body: id, attempts: 1, ...extra }, () => at)
    put('scheduled', 'queued', 'session:s', { lastError: 'first failure', nextRetryAt: at + 2000 })
    put('feishu-retry', 'recorded', 'feishu:chat:abc')
    put('github-retry', 'recorded', 'github:org/repo#7')
    put('waiting', 'recorded', 'feishu:chat:abc', { attempts: 0 })
    put('internal', 'recorded', 'dsh:session:chief')
    put('dead', 'failed', 'session:s', { lastError: 'final failure' })
    for (let i = 0; i < 6; i++) put('problem-' + i, 'recorded', 'chief', { kind: 'system-problem' })
    const health = buildOutboxHealth(store)
    assert.deepEqual(health.retrying.map(row => row.id), ['scheduled', 'feishu-retry', 'github-retry'])
    assert.equal(health.retrying[0].nextRetryAt, at + 2000)
    assert.equal(health.retrying[0].lastError, 'first failure')
    assert.equal(health.failed, health.failedList.length)
    assert.equal(health.failedList[0].lastError, 'final failure')
    assert.equal(health.systemProblems, 6)
    assert.deepEqual(health.recentProblems.map(row => row.id), ['problem-5', 'problem-4', 'problem-3', 'problem-2', 'problem-1'])
  } finally { cleanup() }
})

test('message details preserve full linked text without attributing replies by chat alone', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const at = '2026-11-15T00:00:00.000Z'
    const message = '开头\n' + '这是一段长消息。'.repeat(60) + '\n消息末尾'
    const reply = '回复开头\n' + '这是一段长回复。'.repeat(40) + '\n回复末尾'
    const put = store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
    for (const id of ['long', 'same-chat', 'cross-chat']) {
      const source = { chatId: id === 'cross-chat' ? 'other' : 'shared', messageId: 'om_' + id }
      const trigger = { id, kind: 'feishu', at, message, source, authorization: { actor: 'ou_test', source: 'feishu', at } }
      put.run(id, JSON.stringify(trigger), at)
    }
    const owner = registry.create({ kind: 'repo', workspace: 'Project', cwd: '/repos/Project' })
    const { ticketId } = await router.routeToOwner({ ownerId: owner.id, triggerRef: 'long', message: 'Handle the long message' })
    const sentAt = '2026-11-15T00:01:00.000Z'
    const when = () => sentAt
    insertOutbox(store, { kind: 'reply', state: 'sent', ticketId, to: 'feishu:chat:shared', body: reply, sentAt }, when)
    insertOutbox(store, { kind: 'reply', state: 'failed', triggerId: 'long', to: 'feishu:chat:other', body: 'Wrong chat' }, when)
    insertOutbox(store, { kind: 'reply', state: 'sent', to: 'feishu:chat:shared', body: 'No original message reference' }, when)
    insertOutbox(store, { kind: 'reply', state: 'sent', triggerId: 'long', to: 'dsh:session:chief', body: 'Internal report' }, when)
    const preview = buildOverview({ store, registry, now: when }).recentTriggers.find(row => row.id === 'long')
    assert.equal(preview.message, message.slice(0, 160) + '…')
    assert.equal(preview.reply.text, reply.slice(0, 120))
    const detail = readMessageDetail(store, 'long')
    assert.equal(detail.message, message)
    assert.equal(detail.reply.text, reply)
    assert.equal(detail.reply.sentAt, sentAt)
    assert.equal(readMessageDetail(store, 'same-chat').reply, null)
    assert.equal(readMessageDetail(store, 'same-chat').replyUnlinked, true)
    assert.equal(readMessageDetail(store, 'cross-chat').reply, null)
    assert.equal(readMessageDetail(store, 'missing'), null)
  } finally { cleanup() }
})

test('overview reply projection carries the reply text snippet (round 54)', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    const at = '2026-11-15T00:00:00.000Z'
    const trigger = { id: 'original', kind: 'feishu', at, message: '看一下状态', source: { chatId: 'oc_x' },
      authorization: { actor: 'ou_x', source: 'feishu', at } }
    store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(trigger.id, JSON.stringify(trigger), at)
    const receipt = await router.routeToOwner({ ownerId: owner.id, triggerRef: trigger.id, message: '检查当前队列' })
    insertOutbox(store, { ticketId: receipt.ticketId, kind: 'reply', to: 'feishu:chat:oc_x', body: '处理中', state: 'sent' }, () => at)
    insertOutbox(store, { triggerId: trigger.id, kind: 'reply', to: 'feishu:chat:oc_x', body: '队列空闲，三张票在跑', state: 'failed' }, () => at)
    const overview = buildOverview({ store, registry })
    const msg = overview.recentTriggers.find(t => t.message === '看一下状态')
    assert.equal(msg.reply?.state, 'failed')
    assert.equal(msg.reply?.text, '队列空闲，三张票在跑', '回复正文片段随投影下发（tooltip/复制用）')
  } finally {
    cleanup()
  }
})

test('overview skips directory listings for recycled owners (目录已删除)', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'scratch' })
    const r1 = await router.routeToOwner({ ownerId: owner.id, message: '做个试验' })
    router.tasks.report({ ticketId: r1.ticketId, summary: '做完了' })
    registry.markRecycled(owner.id)
    let called = 0
    const overview = buildOverview({ store, registry, listDir: () => { called += 1; return [] } })
    const ticket = overview.tickets.find(t => t.id === r1.ticketId)
    assert.equal(ticket.stage, 'person/review')
    assert.equal(ticket.dirListing, null)
    assert.equal(called, 0, 'recycled owner 的目录已删除，不读')
  } finally {
    cleanup()
  }
})

test('S02 regression: saving a new overlay replaces the settings file instead of rewriting the inode a reader holds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-settings-'))
  let fd = null
  try {
    // 设置写入必须是「整文件替换」(temp file + rename)：并发读取者手里已打开的句柄要一直看到完整的旧快照。
    const previous = { reporting: { auto: true, intervalMs: 60000 }, github: { enabled: false, loginAllowlist: ['ghost'] } }
    const next = { reporting: { auto: false, intervalMs: 90000 }, github: { enabled: true, loginAllowlist: ['ghost', 'hub-bot-app'] } }
    saveSettingsOverlay(dir, previous)
    fd = openSync(join(dir, SETTINGS_FILE), 'r')
    saveSettingsOverlay(dir, next)
    const heldText = readFileSync(fd, 'utf8')
    assert.doesNotThrow(() => JSON.parse(heldText), '已打开句柄读到的仍是完整 JSON — 保存不能原地截断同一个 inode')
    assert.deepEqual(JSON.parse(heldText), previous, '已打开句柄看到的是完整的上一版快照，不是新内容或截断内容')
    assert.deepEqual(loadSettingsOverlay(dir), next, '新路径加载到的是新设置')
    assert.equal(statSync(join(dir, SETTINGS_FILE)).mode & 0o777, 0o600, '替换后的新文件仍是 owner-only 0600')
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S02 regression: a failed settings write keeps the previous file and the in-memory config unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-settings-'))
  try {
    // 持久化失败必须是「整体回退」：上一份有效文件还在、内存里的 config 一点没变、临时文件不残留。
    // 失败注入走 saveSettingsOverlay 的 io 替身（同 workspaces.js 的 mkdir 替身约定），不 mock 模块。
    const previous = { reporting: { auto: true, intervalMs: 60000 }, github: { enabled: false, loginAllowlist: ['ghost'] } }
    const config = baseConfig()
    applySettingsOverlay(config, previous)
    saveSettingsOverlay(dir, previous)
    const snapshot = structuredClone(config)
    const failingIo = {
      renameSync: () => {
        const error = new Error('EACCES: simulated rename failure')
        error.code = 'EACCES'
        throw error
      },
    }
    assert.throws(
      () => applySettingsPatch(config, { reporting: { auto: false, intervalMs: 90000 } }, applied => {
        saveSettingsOverlay(dir, mergeSettingsOverlay(previous, applied), failingIo)
      }),
      /simulated rename failure/,
      '持久化失败必须抛给调用方，不能吞掉变成半成功',
    )
    assert.deepEqual(config, snapshot, '写入失败后内存里的配置保持原样（不能先改内存再写盘）')
    assert.deepEqual(loadSettingsOverlay(dir), previous, '下一次加载拿到的仍是最后一份有效设置')
    assert.deepEqual(readdirSync(dir), [SETTINGS_FILE], '失败路径不能留下临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S02 regression: an accepted settings change survives a reopen of the state dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-settings-'))
  try {
    // 正常路径：写盘 → 重新加载（等价于重启）→ 覆盖层原样重放，改动不会随进程消失。
    const config = baseConfig()
    const patch = { reporting: { auto: true, intervalMs: 120000 }, github: { loginAllowlist: ['ghost', 'hub-bot-app'] } }
    applySettingsPatch(config, patch, applied => {
      saveSettingsOverlay(dir, mergeSettingsOverlay(loadSettingsOverlay(dir), applied))
    })
    assert.equal(config.reporting.auto, true, '内存里立即生效')
    const reopened = baseConfig()
    applySettingsOverlay(reopened, loadSettingsOverlay(dir))
    assert.equal(reopened.reporting.auto, true, '重开后 reporting.auto 保持')
    assert.equal(reopened.reporting.intervalMs, 120000, '重开后 reporting.intervalMs 保持')
    assert.deepEqual(reopened.github.loginAllowlist, ['ghost', 'hub-bot-app'], '重开后 github.loginAllowlist 保持')
    assert.equal(statSync(join(dir, SETTINGS_FILE)).mode & 0o777, 0o600, '落盘文件仍是 owner-only 0600')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S06: overview projects both intake entries (飞书入口 + 负责人路由) read-only from stored facts', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    const put = store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
    const droppedAt = '2026-11-15T00:00:00.000Z'
    const keptAt = '2026-11-15T00:01:00.000Z'
    // 丢弃的群聊消息也落库（只记录不处理）——它不能被当成「最近一次受理」。
    put.run('feishu-om_drop', JSON.stringify({
      id: 'feishu-om_drop', kind: 'feishu', message: '没 @ 的消息', at: droppedAt, dropped: 'no-mention',
      source: { kind: 'feishu', chatId: 'oc_x', messageId: 'om_drop', openId: 'ou_a', addressing: 'none' },
    }), droppedAt)
    // 更早的一条已经注入过（injectedAt 有真实时间戳）；最新一条只落了 injectedAt: null（键在 = 还没注入）。
    put.run('feishu-om_old', JSON.stringify({
      id: 'feishu-om_old', kind: 'feishu', message: '昨天的消息', at: '2026-11-14T23:00:00.000Z', injectedAt: '2026-11-14T23:00:05.000Z',
      source: { kind: 'feishu', chatId: 'oc_x', messageId: 'om_old', openId: 'ou_a', addressing: 'mention' },
    }), '2026-11-14T23:00:00.000Z')
    put.run('feishu-om_keep', JSON.stringify({
      id: 'feishu-om_keep', kind: 'feishu', message: '看一下状态', at: keptAt, injectedAt: null,
      source: { kind: 'feishu', chatId: 'oc_x', messageId: 'om_keep', openId: 'ou_a', addressing: 'direct' },
      authorization: { actor: 'ou_a', source: 'feishu', addressing: 'direct', messageId: 'om_keep', at: keptAt },
    }), keptAt)
    const receipt = await router.routeToOwner({ ownerId: owner.id, message: '检查当前队列' })
    const routeTrigger = store.db.prepare('SELECT value FROM trigger').all()
      .map(raw => JSON.parse(String(raw.value)))
      .find(trigger => trigger.kind === 'route')
    assert.equal(routeTrigger.ownerId, owner.id, 'route 触发行由 router 落库（先存后做）')
    // 投递行在 routeToOwner 之后才落库：routeToOwner 内部会 tick 一次，早落库的 queued 行会被它投掉。
    insertOutbox(store, { triggerId: 'feishu-om_keep', kind: 'reply', to: 'feishu:chat:oc_x', body: '处理中', state: 'sent' }, () => keptAt)
    insertOutbox(store, {
      triggerId: 'feishu-om_keep', kind: 'reply', to: 'feishu:chat:oc_x', body: '还在排队', state: 'queued',
      attempts: 1, nextRetryAt: Date.parse(keptAt) + 4000, lastError: 'socket hang up',
    }, () => keptAt)

    const overview = buildOverview({ store, registry })
    assert.equal(overview.intake.generatedAt, overview.generatedAt, '同一次快照生成，时间戳一致')
    assert.deepEqual(overview.intake.sources.map(s => s.source), ['feishu', 'route'], '两个入口：飞书与负责人路由')
    const [feishu, route] = overview.intake.sources
    assert.equal(feishu.label, '飞书入口')
    assert.equal(route.label, '负责人路由')

    assert.equal(feishu.at, keptAt, '最近一次受理取最新的触发行（旧的丢弃记录不覆盖）')
    assert.equal(feishu.triggerId, 'feishu-om_keep')
    assert.equal(feishu.dedupKey, 'feishu-om_keep', '去重键就是触发行 id（feishu 侧 = feishu-<messageId>）')
    assert.equal(feishu.addressing, 'direct', '受理口径来自触发行自带的 addressing')
    assert.equal(feishu.dropped, null)
    assert.equal(feishu.injectedAt, null)
    assert.equal(feishu.ownerId, null)
    assert.equal(feishu.ticketId, null)
    assert.deepEqual(feishu.counts, { triggers: 3, dropped: 1, injected: 1 },
      '计数就是列表长度：丢弃也记账；注入只认真的注入过的行（injectedAt: null 的占位不算）')
    assert.equal(feishu.queue.state, 'queued', '最相关的投递行优先：失败 > 在途 > 已送达')
    assert.equal(feishu.queue.attempts, 1)
    assert.equal(feishu.queue.nextRetryAt, Date.parse(keptAt) + 4000)
    assert.equal(feishu.queue.lastError, 'socket hang up')
    assert.equal(feishu.queue.rows, 2, '链接到该触发的全部投递行')

    assert.equal(route.triggerId, routeTrigger.id)
    assert.equal(route.dedupKey, routeTrigger.id)
    assert.equal(route.at, routeTrigger.at)
    assert.equal(route.ownerId, owner.id)
    assert.equal(route.ticketId, receipt.ticketId)
    assert.equal(route.addressing, 'direct', '路由入口保留到达时的寻址方式')
    assert.equal(route.dropped, null)
    assert.equal(route.injectedAt, null)
    assert.deepEqual(route.counts, { triggers: 1, dropped: 0, injected: 1 },
      'routeToOwner 真的把注入投进宿主了（票面 lastDelivery.state === sent）→ 计数为已注入')
    assert.equal(route.queue.state, 'sent', 'routeToOwner 已投递的注入行是 sent')
    assert.equal(route.queue.rows, 1)
    assert.deepEqual(Object.keys(feishu).sort(), [
      'addressing', 'at', 'counts', 'dedupKey', 'disposition', 'dropped', 'injectedAt', 'label', 'ownerId', 'policy', 'queue', 'source', 'ticketId', 'triggerId',
    ], '只读投影的字段集合固定 —— 没有任何可写开关')
    assert.equal(feishu.disposition, 'pending', '已受理但 injectedAt 还是 null = 等注入（重启会重放，不是丢了）')
    assert.equal(route.disposition, 'injected', '票面 lastDelivery.state === sent 才算真的注入了')

    // 到达时的口径快照由 router 落库在触发行顶层 `policy` 上（s06-core 契约）；面板原样透传，
    // 没落库就是 null —— 不发明字段名、不补值。
    assert.equal(feishu.policy, null)
    assert.deepEqual(route.policy, routeTrigger.policy)
    const snapshot = { source: 'dsh', addressing: 'direct', admitted: true }
    store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?')
      .run(JSON.stringify({ ...routeTrigger, policy: snapshot }), routeTrigger.id)
    const projected = buildIntakePolicy(store, { now: () => '2026-11-15T00:02:00.000Z' })
    assert.equal(projected.generatedAt, '2026-11-15T00:02:00.000Z')
    assert.deepEqual(projected.sources[1].policy, snapshot, '口径快照原样透传，面板不重算')
    assert.equal(projected.sources[0].policy, null, '飞书触发行没有快照 → null')
    // 只认顶层 policy：别的键（曾经的猜测字段）不会被当成口径快照，投影不猜字段名。
    store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?')
      .run(JSON.stringify({ ...routeTrigger, policy: undefined, intake: { addressing: 'direct' }, policySnapshot: { allowed: true } }), routeTrigger.id)
    const guessed = buildIntakePolicy(store, { now: () => '2026-11-15T00:02:00.000Z' })
    assert.equal(guessed.sources[1].policy, null, 'intake/policySnapshot 不是契约字段，不能被当成快照')
  } finally {
    cleanup()
  }
})

test('S06: intake projection is read-only — empty entries stay null, no settings key or allowlist appears', () => {
  const { store, cleanup } = fixture()
  try {
    const empty = buildIntakePolicy(store, { now: () => '2026-11-15T00:00:00.000Z' })
    assert.deepEqual(empty.sources.map(s => s.source), ['feishu', 'route'])
    for (const source of empty.sources) {
      assert.equal(typeof source.label, 'string', '每个入口都带中文标签')
      assert.ok(source.label.length > 0)
      assert.equal(source.at, null, '没有触发行 → null（面板渲染 —），不编造受理时间')
      assert.equal(source.triggerId, null)
      assert.equal(source.dedupKey, null)
      assert.equal(source.addressing, null)
      assert.equal(source.dropped, null)
      assert.equal(source.injectedAt, null)
      assert.equal(source.ownerId, null)
      assert.equal(source.ticketId, null)
      assert.equal(source.policy, null)
      assert.equal(source.disposition, null, '没有触发行 → 处置是 null（面板渲染 —），不假装已注入/已丢弃')
      assert.deepEqual(source.counts, { triggers: 0, dropped: 0, injected: 0 })
      assert.deepEqual(source.queue, { state: null, attempts: 0, nextRetryAt: null, lastError: null, rows: 0 },
        '没有投递行时队列状态是 null —— 不假装 queued/sent')
    }
  } finally {
    cleanup()
  }
  // 只读投影不能顺带长出一个新的设置键/白名单：写层仍旧只认既有键。
  const config = baseConfig()
  assert.throws(() => applySettingsPatch(config, { feishu: { openIdAllowlist: ['ou_a'] } }), /does not know settings key/)
  assert.throws(() => applySettingsPatch(config, { feishu: { intakePolicy: { addressing: 'direct' } } }), /does not know settings key/,
    '投喂口径只读展示，不新增可写的 feishu.intakePolicy')
  assert.throws(() => applySettingsPatch(config, { intake: { enabled: true } }), /unknown settings section "intake"/)
  const view = buildSettingsView(config)
  assert.equal(view.feishu.openIdAllowlist, undefined, '面板视图里没有 openId 白名单')
  assert.equal(view.intake, undefined, '设置视图里没有投喂面开关')
  assert.deepEqual(Object.keys(view.feishu).sort(), ['enabled', 'status'])
})

test('settings view merges the effective config with live source status', () => {
  const config = baseConfig()
  const view = buildSettingsView(config, {
    feishuStatus: { enabled: true, credentialState: 'ok', connected: true },
    githubStatus: { enabled: true, intervalMs: 300000, loginAllowlist: ['ghost'], lastPollError: null, followed: [{ repo: 'o/r', ownerId: 'repo-w' }] },
  })
  assert.equal(view.concurrency.slotsPerOwner, 3, '默认值可见')
  assert.deepEqual(view.reporting, { auto: false, intervalMs: 60000 })
  assert.equal(view.feishu.enabled, true)
  assert.equal(view.feishu.openIdAllowlist, undefined, 'openIdAllowlist 不再进视图')
  assert.equal(view.feishu.status.credentialState, 'ok')
  assert.equal(view.github.enabled, true)
  assert.equal(view.github.intervalMs, 300000)
  assert.deepEqual(view.github.loginAllowlist, ['ghost'])
  assert.deepEqual(view.github.followed, [{ repo: 'o/r', ownerId: 'repo-w' }], '监听清单跟随注册表（只读）')
  assert.equal(view.github.status.lastPollError, null)
})

test('message detail distinguishes pending, failed, and admitted intake for the same event', () => {
  const { store, cleanup } = fixture()
  try {
    const trigger = { id: 'feishu-fixture-detail', kind: 'feishu', at: '2026-11-15T00:00:00.000Z', message: 'fixture', policy: { mode: 'queue' }, injectedAt: null }
    store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
    const intent = insertOutbox(store, { kind: 'inbox', to: 'owner:chief', state: 'queued', triggerId: trigger.id })
    assert.equal(readMessageDetail(store, trigger.id).intake.disposition, 'pending')
    const save = store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?')
    save.run(JSON.stringify({ ...intent, state: 'failed', lastError: 'fixture timeout' }), intent.id)
    assert.deepEqual(readMessageDetail(store, trigger.id).intake, { disposition: 'failed', queueState: 'failed', lastError: 'fixture timeout' })
    save.run(JSON.stringify({ ...intent, state: 'sent' }), intent.id)
    store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify({ ...trigger, injectedAt: trigger.at }), trigger.id)
    assert.equal(readMessageDetail(store, trigger.id).intake.disposition, 'injected')
  } finally { cleanup() }
})

test('message detail agrees with the overview after routing an owner request', async () => {
  const { router, registry, store, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'Details fixture', cwd: '/repos/details' })
    const triggerId = 'fixture-route-detail'
    await router.routeToOwner({ ownerId: owner.id, triggerRef: triggerId, message: 'fixture routing request' })
    const overview = buildOverview({ store, registry })
    assert.equal(overview.intake.sources.find(entry => entry.triggerId === triggerId)?.disposition, 'injected')
    assert.equal(readMessageDetail(store, triggerId)?.intake?.disposition, 'injected')
  } finally { cleanup() }
})
