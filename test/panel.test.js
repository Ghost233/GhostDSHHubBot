/**
 * Panel domain (#73 面板三问与设置页): settings patch/overlay validation + persistence, the 三问 overview
 * assembly (票面权威 — tickets carry their own facts, the panel never invents state), and the settings view
 * builder. Pure functions over Store/OwnerRegistry; HTTP wiring lives in src/index.js.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
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
  buildSettingsView, buildOverview, buildOutboxHealth, readMessageDetail,
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
