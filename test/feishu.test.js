/**
 * FeishuSource (issue #68 飞书入口): normalization of im.message.receive_v1 events, plugin-owned source marks,
 * the mention policy (授权边界在飞书侧, 插件不做二次过滤), the recorded-outbox reply channel (P1-2 honest intents actually sent), and
 * credential persistence (0600). Tested with an injected fake lark SDK — no network.
 *
 * S06 (飞书入口 = 纯来源适配器): the tests after `S06 单一入口` drive the PRODUCTION dispatch seam — a real Router
 * over a temporary Store, the fake Lark SDK and a fake credentials port — and assert the source hands over ONE
 * immutable trigger and asserts no acceptance of its own. The tests above them keep constructing the source
 * WITHOUT the router port: that is the legacy mount and it must keep working unchanged (backward compatible).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { Router } from '../src/router.js'
import { FeishuSource } from '../src/feishu.js'
import { CredentialsError, DEFAULT_FEISHU_CREDENTIAL_REF, MALFORMED, MISSING, UNAVAILABLE } from '../src/feishu-credentials.js'
import { insertOutbox } from '../src/outbox.js'
import { resolveConfig } from '../src/config.js'

/** Router and Feishu adapter over one SQLite store and fake host ports. */
function fixture({ botOpenId = 'ou_bot', larkOverrides = {}, chiefConfig, credentials = fakeCredentialsPort(), config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-feishu-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
  let nowMs = Date.parse('2026-11-15T00:00:00.000Z')
  const calls = { create: [], prompt: [], selectModel: [], cancel: [] }
  const sessions = {
    create: async request => { calls.create.push(request); return { sessionId: 'session-chief-' + calls.create.length } },
    prompt: async request => { calls.prompt.push(request); return { accepted: true } },
    selectModel: async request => { calls.selectModel.push(request); return { selected: request } },
    cancel: async request => { calls.cancel.push(request); return { cancelled: true } },
  }
  const router = new Router({ store, registry, sessions, config: { chief: chiefConfig }, now: () => new Date(nowMs).toISOString() })
  const sent = []
  const fakeLark = {
    client: {
      im: { message: { create: async req => { sent.push(req); return { code: 0 } } } },
      request: async req => ({ code: 0, data: {} }),
    },
    registerApp: async () => ({ client_id: 'cli_new', client_secret: 'secret_new' }),
    ...larkOverrides,
  }
  const source = new FeishuSource({
    store, router,
    config: config ?? { enabled: true, botOpenId },
    logger: { info() {}, warn() {} },
    lark: fakeLark,
    now: () => new Date(nowMs).toISOString(),
    credentials,
  })
  return {
    source, router, registry, store, calls, sent, fakeLark, dir, sessions,
    advance: ms => { nowMs += ms },
    /** Read one trigger row back as JSON (the Router is the only writer on the intake path). */
    trigger: id => {
      const row = store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
      return row ? JSON.parse(String(row.value)) : null
    },
    outbox: () => store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value))),
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** Fake the asynchronous, namespaced DSH credential record service. */
function fakeCredentialsPort({ record, readError, beforeWrite } = {}) {
  const records = new Map()
  if (record !== undefined) records.set(DEFAULT_FEISHU_CREDENTIAL_REF, record)
  const writeKeys = []
  return {
    records, writeKeys,
    async readRecord(key) {
      if (readError) throw readError
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      writeKeys.push(key)
      await beforeWrite?.()
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
  }
}

/** One im.message.receive_v1 event. */
function event({ messageId = 'om_1', chatId = 'oc_1', openId = 'ou_me', chatType = 'p2p', msgType = 'text', text = '继续 DSH-Workflow 的工单', mentions = [], senderType = 'user' } = {}) {
  return {
    sender: { sender_id: { open_id: openId }, sender_type: senderType },
    message: {
      message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: msgType,
      content: msgType === 'text' ? JSON.stringify({ text }) : JSON.stringify({}),
      mentions,
    },
  }
}

test('config: the feishu section is validated (keys) and defaults disabled; openIdAllowlist 已移除 (授权边界在飞书侧)', () => {
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', feishu: 'x' }), /config\.feishu must be an object/)
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', feishu: { nope: 1 } }), /does not know config\.feishu key/)
  // 旧键 openIdAllowlist 现在被严格键校验拒绝（配置里的旧值会在启动时报错指引删除）
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', feishu: { openIdAllowlist: ['ou_me'] } }), /does not know config\.feishu key/)
  const resolved = resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y' })
  assert.deepEqual(resolved.feishu, { enabled: false })
  const on = resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', feishu: { enabled: true } })
  assert.equal(on.feishu.enabled, true)
})

test('a p2p text message is normalized, recorded as a Trigger, and injected into L1 with a plugin-owned source mark', async () => {
  const { source, registry, router, calls, cleanup } = fixture()
  try {
    await source.handleEvent(event())
    await router.tick()
    assert.equal(calls.prompt.length, 1)
    const injected = calls.prompt[0]
    assert.ok(injected.text.startsWith('[hub-bot 飞书 oc_1/om_1]'), 'source mark heads the injection (task-1 遗留: distinguishable from hand-typed input)')
    assert.ok(injected.text.includes('继续 DSH-Workflow 的工单'))
    assert.ok(injected.text.includes("reply_source to='feishu:chat:oc_1'"), 'the reply channel address travels with the message')
    const chief = registry.get('chief')
    assert.equal(injected.sessionId, chief.sessionId, 'injected into the chief (L1) session')
    const trigger = JSON.parse(String(source.store.db.prepare('SELECT value FROM trigger WHERE id = ?').get('feishu-om_1').value))
    assert.equal(trigger.kind, 'feishu')
    assert.equal(trigger.source.kind, 'feishu')
    assert.equal(trigger.source.addressing, 'direct')
    assert.deepEqual(trigger.authorization, { actor: 'ou_me', source: 'feishu', addressing: 'direct', messageId: 'om_1', at: trigger.authorization.at })
  } finally { cleanup() }
})

test('Feishu replies and dispatches use the original message and its authorization', async () => {
  const { source, router, registry, calls, sent, cleanup } = fixture()
  try {
    const [first, second] = await Promise.all([
      source.handleEvent(event({ messageId: 'om_first', text: '原始请求' })),
      source.handleEvent(event({ messageId: 'om_second', text: '另一条请求' })),
    ])
    await router.tick()
    assert.equal(calls.prompt.length, 2)
    assert.equal(calls.prompt[0].sessionId, calls.prompt[1].sessionId)
    assert.equal(calls.create.length, 1)
    assert.ok(calls.prompt.some(prompt => /triggerRef='feishu-om_first'/.test(prompt.text)))
    assert.ok(router.getTrigger(first.triggerId).injectedAt)
    await assert.rejects(router.replySource({ text: '不发送', triggerRef: second.triggerId, to: 'feishu:chat:oc_other' }),
      { code: 'reply-target-mismatch' })
    await assert.rejects(router.replySource({ text: '不发送', triggerRef: 'missing' }), { code: 'invalid-reply-trigger' })
    const owner = registry.create({ kind: 'repo', workspace: 'A', cwd: '/repos/A' })
    const other = registry.create({ kind: 'repo', workspace: 'B', cwd: '/repos/B' })
    const route = await Promise.all([owner, other].map(row => router.routeToOwner({
      ownerId: row.id, triggerRef: first.triggerId, message: '转交给负责人处理',
    })))
    assert.ok(route[0].ticketId)
    assert.equal(route[1].ticketId, route[0].ticketId)
    assert.equal(route[1].ownerId, owner.id)
    assert.equal(registry.get(other.id).sessionId, null)
    assert.deepEqual(router.getTicket(route[0].ticketId).authorization, router.getTrigger(first.triggerId).authorization)
    assert.equal(router.getTrigger(first.triggerId).message, '原始请求')
    assert.match(calls.prompt.at(-1).text, /转交给负责人处理/)
    const reply = await router.replySource({ text: '收到第二条', triggerRef: second.triggerId })
    assert.equal(router.listOutbox().find(row => row.id === reply.outboxId).triggerId, second.triggerId)
    await source.deliverReplies()
    assert.deepEqual(sent.map(request => [request.data.receive_id, JSON.parse(request.data.content).text]), [['oc_1', '收到第二条']])
  } finally { cleanup() }
})

test('chief model: config validated; injection aligns the chief session model when configured', async () => {
  // 配置校验：非法形状拒绝；null 与合法对象通过
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', chief: { model: { provider: 'p' } } }), /model.model must be a non-empty string/)
  assert.throws(() => resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', chief: { nope: 1 } }), /does not know config.chief key/)
  assert.equal(resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y' }).chief.model, null)
  const withModel = resolveConfig({ stateDir: '/tmp/x', homeRepo: '/tmp/y', chief: { model: { provider: 'magpie', model: 'zhipu/glm-4.5', reasoningEffort: 'high' } } })
  assert.deepEqual(withModel.chief.model, { provider: 'magpie', model: 'zhipu/glm-4.5', reasoningEffort: 'high' })
  // 注入对齐：chiefConfig.model 存在时每次注入前 selectModel；为 null 时不打扰
  const aligned = fixture({ chiefConfig: { model: { provider: 'magpie', model: 'zhipu/glm-4.5' } } })
  try {
    await aligned.source.handleEvent(event())
    await aligned.router.tick()
    assert.equal(aligned.calls.selectModel.length, 1)
    assert.deepEqual(aligned.calls.selectModel[0], { sessionId: 'session-chief-1', provider: 'magpie', model: 'zhipu/glm-4.5' })
  } finally { aligned.cleanup() }
  const plain = fixture({ chiefConfig: { model: null } })
  try {
    await plain.source.handleEvent(event())
    await plain.router.tick()
    assert.equal(plain.calls.selectModel.length, 0)
  } finally { plain.cleanup() }
})

test('bot-own messages are dropped (spec: 丢弃 bot 自己的消息)', async () => {
  const { source, calls, cleanup } = fixture()
  try {
    await source.handleEvent(event({ senderType: 'app' }))
    assert.equal(calls.prompt.length, 0)
  } finally { cleanup() }
})

test('group chat: only messages mentioning the bot become requests (spec: 群聊 @bot)', async () => {
  const { source, router, calls, cleanup } = fixture()
  try {
    await source.handleEvent(event({ messageId: 'om_3', chatType: 'group', text: '随便聊聊' }))
    assert.equal(calls.prompt.length, 0)
    const droppedRow = source.store.db.prepare('SELECT value FROM trigger WHERE id = ?').get('feishu-om_3')
    assert.equal(JSON.parse(String(droppedRow.value)).dropped, 'no-mention')
    await source.handleEvent(event({
      messageId: 'om_4', chatType: 'group', text: '@_user_1 查一下工单',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'hub-bot' }],
    }))
    await router.tick()
    assert.equal(calls.prompt.length, 1)
    assert.ok(calls.prompt[0].text.includes('查一下工单'), 'the mention placeholder is stripped')
    assert.ok(calls.prompt[0].text.includes('群聊 @bot'), 'addressing surfaces as mention in the source mark')
    const mentionTrigger = JSON.parse(String(source.store.db.prepare('SELECT value FROM trigger WHERE id = ?').get('feishu-om_4').value))
    assert.equal(mentionTrigger.source.addressing, 'mention')
  } finally { cleanup() }
})

test('non-text messages get the recorded-reply 暂不支持该消息类型', async () => {
  const { source, calls, store, cleanup } = fixture()
  try {
    await source.handleEvent(event({ messageId: 'om_5', msgType: 'image' }))
    assert.equal(calls.prompt.length, 0, 'nothing injected into a session')
    const rows = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value)))
    const reply = rows.find(r => r.kind === 'reply' && r.to === 'feishu:chat:oc_1')
    assert.ok(reply, 'a reply intent was stored first (先存后做)')
    assert.equal(reply.state, 'recorded')
    assert.equal(reply.body, '暂不支持该消息类型')
    assert.equal(reply.triggerId, 'feishu-om_5')
  } finally { cleanup() }
})

test('a replayed message id is deduped by its Trigger id (重启不重放事件)', async () => {
  const { source, router, calls, cleanup } = fixture()
  try {
    await source.handleEvent(event())
    await source.handleEvent(event())
    await router.tick()
    assert.equal(calls.prompt.length, 1)
  } finally { cleanup() }
})

test('deliverReplies sends recorded feishu intents and marks them sent only on real delivery', async () => {
  const { source, store, sent, cleanup } = fixture()
  try {
    insertOutbox(store, { ticketId: null, kind: 'reply', to: 'feishu:chat:oc_9', body: '工单已验收', state: 'recorded', requestId: 'hub-bot-reply-x' })
    await source.deliverReplies()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].params.receive_id_type, 'chat_id')
    assert.equal(sent[0].data.receive_id, 'oc_9')
    assert.equal(sent[0].data.msg_type, 'text')
    assert.deepEqual(JSON.parse(sent[0].data.content), { text: '工单已验收' })
    const stored = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value)))[0]
    assert.equal(stored.state, 'sent')
    assert.ok(stored.sentAt)
  } finally { cleanup() }
})

test('deliverReplies leaves failures recorded with an attempt counter; five failures fail the row and report a system problem', async () => {
  const { source, store, cleanup } = fixture({
    larkOverrides: { client: { im: { message: { create: async () => { throw new Error('HTTP 429') } } }, request: async () => ({ code: 0 }) } },
  })
  try {
    const row = insertOutbox(store, { ticketId: null, kind: 'reply', to: 'feishu:chat:oc_9', body: 'x', state: 'recorded', requestId: 'r1' })
    for (let i = 0; i < 4; i++) await source.deliverReplies()
    let stored = store.db.prepare('SELECT value FROM outbox WHERE id = ?').all(row.id).map(r => JSON.parse(String(r.value)))[0]
    assert.equal(stored.state, 'recorded')
    assert.equal(stored.attempts, 4, '统一计数器命名（收敛后不再有 per-channel 字段）')
    await source.deliverReplies()
    stored = store.db.prepare('SELECT value FROM outbox WHERE id = ?').all(row.id).map(r => JSON.parse(String(r.value)))[0]
    assert.equal(stored.state, 'failed')
    const problems = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value))).filter(r => r.kind === 'system-problem')
    assert.equal(problems.length, 1)
  } finally { cleanup() }
})

test('ws metrics persist in kv and surface in status (连接质量)', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.source.status().metrics, { reconnects: 0, lastConnectedAt: null, lastErrorAt: null, lastError: null }, '初始零值')
    // 钩子记账路径在私有 connect 流程里（真实 ws 才能触发），这里验证持久化 + 投影契约：
    // kv 里预置指标 → 重建的源（模拟重启）必须在 status() 里原样浮现
    f.store.set('feishu.wsMetrics', { reconnects: 3, lastConnectedAt: '2026-11-15T01:00:00.000Z', lastErrorAt: '2026-11-15T00:30:00.000Z', lastError: 'ws closed' })
    const reloaded = new FeishuSource({
      store: f.store, registry: f.registry, sessions: {},
      config: {}, logger: { info() {}, warn() {} }, lark: f.fakeLark,
      now: () => '2026-11-15T02:00:00.000Z',
    })
    const st = reloaded.status()
    assert.equal(st.metrics.reconnects, 3, '重启后重连计数还在')
    assert.equal(st.metrics.lastConnectedAt, '2026-11-15T01:00:00.000Z')
    assert.equal(st.metrics.lastError, 'ws closed')
  } finally { f.cleanup() }
})

test('S04 regression: a scoped persistent grant supplies the binding after remount', async () => {
  const credentials = fakeCredentialsPort()
  const config = { enabled: true, credentialRef: 'hub-bot/existing-feishu' }
  const f = fixture({ credentials, config })
  try {
    await f.source.credentialsReady
    assert.equal(f.source.status().credentialReason, MISSING)
    await f.source.saveCredentials({ appId: 'fixture-app-0001', appSecret: 'fixture-record-first' })
    await f.source.saveCredentials({ appId: 'fixture-app-0002', appSecret: 'fixture-record-rebind' })
    assert.deepEqual(credentials.writeKeys, [config.credentialRef, config.credentialRef])
    assert.deepEqual(credentials.records.get(config.credentialRef), {
      kind: 'grant', payload: { appId: 'fixture-app-0002', appSecret: 'fixture-record-rebind', boundAt: '2026-11-15T00:00:00.000Z' },
    })
    assert.equal(f.source.status().bot.name, 'DSH 中枢 Bot')
    assert.equal(f.source.status().permissions.length, 4)
    const restarted = fixture({ credentials, config })
    try {
      await restarted.source.credentialsReady
      assert.equal(restarted.source.status().credentialState, 'ok')
      assert.deepEqual(restarted.source.status().bot, f.source.status().bot)
      assert.doesNotMatch(JSON.stringify(restarted.source.status()), /fixture-record-rebind/)
    } finally { restarted.cleanup() }
  } finally { f.cleanup() }
})

test('register() surfaces the QR and waits for the DSH grant before connecting', async () => {
  const calls = { patch: [] }
  const qr = Promise.withResolvers()
  const complete = Promise.withResolvers()
  const writing = Promise.withResolvers()
  const persisted = Promise.withResolvers()
  const credentials = fakeCredentialsPort({ beforeWrite() { writing.resolve(); return persisted.promise } })
  const { source, cleanup } = fixture({
    credentials,
    larkOverrides: {
      registerApp: async options => {
        options.onQRCodeReady({ url: 'https://accounts.feishu.cn/scan?x=1', expireIn: 300 })
        qr.resolve()
        return complete.promise
      },
      client: {
        im: { message: { create: async () => ({ code: 0 }) } },
        request: async req => { calls.patch.push(req); return { code: 0, data: {} } },
      },
      WSClient: class { async start() {} close() {} },
      EventDispatcher: class { register() { return this } },
    },
  })
  try {
    const flow = source.register()
    await qr.promise
    assert.equal(source.status().qr.url, 'https://accounts.feishu.cn/scan?x=1')
    complete.resolve({ client_id: 'cli_new', client_secret: 'secret_new' })
    await writing.promise
    assert.equal(source.status().credentialState, 'missing')
    assert.equal(calls.patch.length, 0)
    persisted.resolve()
    const result = await flow
    assert.equal(result.appId, 'cli_new')
    assert.equal(source.status().qr, undefined)
    assert.equal(credentials.records.get(DEFAULT_FEISHU_CREDENTIAL_REF)?.kind, 'grant')
    assert.equal(calls.patch.length, 1, 'event-subscription mode auto-config attempted once')
    assert.ok(String(calls.patch[0].url).includes('application'), 'application-config patch')
  } finally { cleanup() }
})

test('pausing Feishu closes the active socket and ignores stale callbacks', async () => {
  const sockets = []
  const f = fixture({ larkOverrides: {
    WSClient: class {
      constructor(options) { this.options = options; sockets.push(this) }
      async start({ eventDispatcher }) { this.events = eventDispatcher.handlers }
      close(options) { this.closed = options }
    },
    EventDispatcher: class { register(handlers) { this.handlers = handlers; return this } },
  } })
  try {
    await f.source.saveCredentials({ appId: 'fixture-app', appSecret: 'fixture-secret' })
    const connect = f.source.connect()
    assert.equal((await f.source.connect()).started, false)
    await connect
    const first = sockets[0]
    assert.equal(f.source.status().wsState, 'connecting')
    first.options.onReady()
    assert.equal(f.source.status().bot.connected, true)
    f.source.config.enabled = false
    f.source.disconnect()
    assert.deepEqual(first.closed, { force: true })
    f.source.config.enabled = true
    await f.source.connect()
    first.options.onError(new Error('401 invalid credentials'))
    first.options.onReconnected()
    await first.events['im.message.receive_v1'](event())
    assert.equal(f.calls.prompt.length, 0)
    assert.equal(f.source.status().credentialState, 'ok')
    assert.equal(f.source.status().wsState, 'connecting')
    assert.equal(f.source.status().metrics.reconnects, 0)
    sockets[1].options.onReady()
    assert.equal(f.source.status().bot.connected, true)
  } finally { f.source.disconnect(); f.cleanup() }
})

test('pausing Feishu aborts a scan and discards its late credentials', async () => {
  const qr = Promise.withResolvers()
  const late = Promise.withResolvers()
  const f = fixture({ larkOverrides: {
    registerApp: async options => {
      options.onQRCodeReady({ url: 'https://example.invalid/scan', expireIn: 300 })
      qr.resolve(options)
      return late.promise
    },
  } })
  try {
    const registration = f.source.register()
    const options = await qr.promise
    assert.equal(f.source.status().registration, 'pending')
    f.source.config.enabled = false
    f.source.disconnect()
    assert.equal(options.signal.aborted, true)
    options.onQRCodeReady({ url: 'https://example.invalid/stale', expireIn: 1 })
    late.resolve({ client_id: 'stale', client_secret: 'stale' })
    assert.deepEqual(await registration, { cancelled: true })
    assert.equal(f.source.status().credentialState, 'missing')
    assert.equal(f.source.status().registration, undefined)
    assert.equal(f.source.status().qr, undefined)
  } finally { f.cleanup() }
})

test('pausing during a Feishu reply pass retains the remaining replies for resume', async () => {
  const firstSend = Promise.withResolvers()
  const release = Promise.withResolvers()
  const sent = []
  const f = fixture({ larkOverrides: { client: { im: { message: { create: async request => {
    sent.push(JSON.parse(request.data.content).text)
    if (sent.length === 1) { firstSend.resolve(); await release.promise }
    return { code: 0 }
  } } } } } })
  try {
    for (const body of ['first', 'second']) {
      insertOutbox(f.store, { kind: 'reply', to: 'feishu:chat:fixture', body, state: 'recorded' })
    }
    const pass = f.source.deliverReplies()
    await firstSend.promise
    f.source.config.enabled = false
    f.source.disconnect()
    release.resolve()
    assert.deepEqual(await pass, { delivered: 1 })
    assert.deepEqual(sent, ['first'])
    assert.deepEqual(await f.source.deliverReplies(), { delivered: 0 })
    f.source.config.enabled = true
    assert.deepEqual(await f.source.deliverReplies(), { delivered: 1 })
    assert.deepEqual(sent, ['first', 'second'])
  } finally { f.cleanup() }
})

test('deliverReplies sends recorded rows oldest-first (ORDER BY rowid — 收敛修漂移)', async () => {
  const sent = []
  const { source, store, cleanup } = fixture({
    larkOverrides: { client: { im: { message: { create: async req => { sent.push(JSON.parse(req.data.content).text); return { code: 0 } } } }, request: async () => ({ code: 0 }) } },
  })
  try {
    insertOutbox(store, { ticketId: null, kind: 'reply', to: 'feishu:chat:oc_9', body: '第一条', state: 'recorded', requestId: 'ord-1' })
    insertOutbox(store, { ticketId: null, kind: 'reply', to: 'feishu:chat:oc_9', body: '第二条', state: 'recorded', requestId: 'ord-2' })
    await source.deliverReplies()
    assert.deepEqual(sent, ['第一条', '第二条'], '按入队顺序实投')
  } finally { cleanup() }
})

// 凭据设施 fail-closed 的回归（issue #35 v2 阶段 1）：写入没成功就绝不允许出现「已绑定」的假状态——
// 面板状态只反映凭据设施里真实存在的那条记录。
test('S04 regression: asynchronous credential write failure leaves a new binding unconfirmed', async () => {
  const writing = Promise.withResolvers()
  const persisted = Promise.withResolvers()
  const credentials = fakeCredentialsPort({ beforeWrite() { writing.resolve(); return persisted.promise } })
  const f = fixture({ credentials })
  try {
    const registering = f.source.register()
    const failure = assert.rejects(registering, error => {
      assert.ok(error instanceof CredentialsError)
      assert.equal(error.reason, UNAVAILABLE)
      assert.doesNotMatch(error.message, /secret_new/)
      return true
    })
    await writing.promise
    assert.equal(f.source.status().credentialState, 'missing')
    assert.equal(f.source.status().bot, undefined)
    persisted.reject(new Error('provider write failed: secret_new'))
    await failure
    assert.equal(f.source.status().credentialState, 'missing')
    assert.equal(f.source.status().bot, undefined)
    assert.equal(f.source.status().wsState, 'off')
    assert.match(f.source.status().registrationError, /无法保存宿主凭据记录/)
    assert.doesNotMatch(JSON.stringify(f.source.status()), /secret_new/)
    assert.equal(credentials.records.size, 0)
  } finally { persisted.resolve(); f.source.disconnect(); f.cleanup() }
})

test('S04 regression: an unconfirmed write preserves the previous binding', async () => {
  const record = { kind: 'grant', payload: { appId: 'fixture-app-0001', appSecret: 'previous-secret' } }
  const credentials = fakeCredentialsPort({ record })
  credentials.modifyRecord = async () => undefined
  const f = fixture({ credentials })
  try {
    await f.source.credentialsReady
    const original = f.source.status().bot
    await assert.rejects(f.source.saveCredentials({ appId: 'fixture-app-0002', appSecret: 'unsaved-secret' }), { reason: UNAVAILABLE })
    assert.deepEqual(f.source.status().bot, original)
    assert.deepEqual(credentials.records.get(DEFAULT_FEISHU_CREDENTIAL_REF), record)
  } finally { f.cleanup() }
})

test('S04 regression: missing, malformed, and unavailable host records are distinguishable', async () => {
  for (const [credentials, reason] of [
    [fakeCredentialsPort(), MISSING],
    [fakeCredentialsPort({ record: { kind: 'grant', payload: { appId: 'fixture-app' } } }), MALFORMED],
    [fakeCredentialsPort({ readError: new Error('fixture secret must not leave the provider') }), UNAVAILABLE],
    [null, UNAVAILABLE],
  ]) {
    const f = fixture({ credentials })
    try {
      await f.source.credentialsReady
      const status = f.source.status()
      assert.equal(status.credentialState, reason === MISSING ? 'missing' : 'invalid')
      assert.equal(status.credentialReason, reason)
      assert.equal(status.bot, undefined)
      assert.doesNotMatch(JSON.stringify(status), /fixture secret/)
      await assert.rejects(f.source.connect(), /no credentials/)
    } finally { f.cleanup() }
  }
})

test('S04 regression: an old local Feishu credential file is not used as a fallback', async () => {
  const f = fixture({ credentials: null })
  try {
    writeFileSync(join(f.store.stateDir, 'feishu-credentials.json'), JSON.stringify({ appId: 'fixture-old', appSecret: 'old-secret' }), { mode: 0o600 })
    const source = new FeishuSource({ store: f.store, logger: { info() {}, warn() {} }, config: { enabled: true } })
    await source.credentialsReady
    assert.equal(source.status().credentialReason, UNAVAILABLE)
    assert.equal(source.status().bot, undefined)
    await assert.rejects(source.register(), /宿主凭据服务不可用/)
    assert.doesNotMatch(JSON.stringify(source.status()), /old-secret/)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------------------------------------
// S06 单一入口: 飞书 = 纯来源适配器.
// The same production admission path is exercised through fake host ports.

test('S06 单一入口: a duplicate message while the chief is busy is deduped — the same message never becomes two jobs', async () => {
  const f = fixture()
  try {
    const [first, second, replay] = await Promise.all([
      f.source.handleEvent(event({ messageId: 'om_a', text: '第一条请求' })),
      f.source.handleEvent(event({ messageId: 'om_b', text: '第二条请求' })),
      f.source.handleEvent(event({ messageId: 'om_a', text: '第一条请求' })),
    ])
    assert.equal(first.triggerId, 'feishu-om_a')
    assert.equal(second.triggerId, 'feishu-om_b')
    assert.equal(replay.triggerId, 'feishu-om_a', 'the dedup key is the message id, reused on replay')
    // 同一条消息被投递两次: 恰好一次是 dedup，且 dedup 那次不声称注入、不新存东西
    const deduped = [first, replay].filter(result => result.deduped === true)
    assert.equal(deduped.length, 1, 'exactly one delivery of om_a is the dedup')
    assert.equal(deduped[0].injected, false, 'a deduped delivery claims no injection of its own')
    assert.equal(deduped[0].queued, false, 'a deduped delivery stores nothing new')
    for (const result of [first, second]) {
      assert.equal(result.dropped, null, 'a real text message is not dropped')
      assert.ok(result.injected === true || result.queued === true, 'a real message becomes work (admitted or queued)')
    }
    // 触发器行由 Router 写，且每个 message id 只有一行
    const ids = f.store.db.prepare('SELECT id FROM trigger').all().map(row => String(row.id)).sort()
    assert.deepEqual(ids, ['feishu-om_a', 'feishu-om_b'], 'one trigger row per message id, no duplicate insert')
    assert.ok(f.router.getTrigger('feishu-om_a').authorization, 'the Router is the trigger-row writer')
    assert.equal(f.router.getTrigger('feishu-om_a').message, '第一条请求', 'the original text is preserved verbatim')
  } finally { f.cleanup() }
})

test('S06: a pending trigger is admitted once after restart even if Feishu redelivers it', async () => {
  const f = fixture()
  try {
    const accepted = await f.source.handleEvent(event({ messageId: 'om_pending', text: '重启前的请求' }))
    assert.equal(accepted.dropped, null)
    const stored = f.trigger('feishu-om_pending')
    assert.ok(stored, 'the trigger row is persisted before anything is acted on (先存后做)')
    assert.equal(stored.message, '重启前的请求')
    assert.equal(stored.kind, 'feishu')
    assert.deepEqual(stored.authorization, {
      actor: 'ou_me', source: 'feishu', addressing: 'direct', messageId: 'om_pending', at: stored.at,
    })
    // 重启: 新的 Router + 新的 source 共用同一个 Store（宿主重启后重新挂载）
    const restartedCalls = { create: [], prompt: [], selectModel: [], cancel: [] }
    const restartedSessions = Object.fromEntries(Object.keys(restartedCalls).map(key => [key, async request => {
      restartedCalls[key].push(request)
      return key === 'create' ? { sessionId: 'session-restarted-chief' } : { accepted: true }
    }]))
    const restartedRouter = new Router({
      store: f.store, registry: f.registry, sessions: restartedSessions,
      now: () => '2026-11-15T06:00:00.000Z',
    })
    const restarted = new FeishuSource({
      store: f.store, registry: f.registry, router: restartedRouter, sessions: restartedSessions,
      config: { enabled: true, botOpenId: 'ou_bot' }, logger: { info() {}, warn() {} },
      now: () => '2026-11-15T06:00:00.000Z',
    })
    // 重启后同一条消息再投递一次: 只认已存在的那一行，不再工作一次
    const replay = await restarted.handleEvent(event({ messageId: 'om_pending', text: '重启前的请求' }))
    assert.equal(replay.triggerId, 'feishu-om_pending')
    assert.equal(replay.deduped, true, 'a replayed message after restart is deduped by its trigger id')
    assert.equal(replay.injected, false)
    assert.equal(replay.queued, false)
    assert.equal(restartedCalls.prompt.length, 0)
    await restartedRouter.tick()
    await restartedRouter.tick()
    assert.equal(restartedCalls.prompt.length, 1, 'resume the original saved intent exactly once')
    assert.equal(restartedCalls.prompt[0].requestId, accepted.requestId)
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM trigger WHERE id = ?').get('feishu-om_pending').n, 1)
    const recovered = restartedRouter.getTrigger('feishu-om_pending')
    assert.equal(recovered.message, '重启前的请求')
    assert.ok(recovered.injectedAt)
  } finally { f.cleanup() }
})

test('S06 单一入口: a group message @ the configured botOpenId is accepted as a mention', async () => {
  const f = fixture({ botOpenId: 'ou_real_bot' })
  try {
    const result = await f.source.handleEvent(event({
      messageId: 'om_mention', chatId: 'oc_group', chatType: 'group', text: '@_user_1 查一下工单',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_real_bot' }, name: 'hub-bot' }],
    }))
    assert.equal(result.dropped, null, 'a verified @ this bot is addressed to us')
    assert.ok(result.injected === true || result.queued === true, 'the message becomes work')
    const row = f.trigger('feishu-om_mention')
    assert.equal(row.source.addressing, 'mention')
    assert.equal(row.source.chatId, 'oc_group')
    assert.equal(row.authorization.addressing, 'mention')
    assert.equal(row.authorization.actor, 'ou_me')
    assert.equal(row.dropped, undefined, 'an accepted trigger carries no dropped reason')
  } finally { f.cleanup() }
})

test('S06 单一入口: a group @ we cannot verify (botOpenId missing) is dropped as unknown-bot-id, never accepted', async () => {
  // 没有配置真实 botOpenId: 认不出这个 @ 是谁 —— 绝不猜，也绝不用 mentions.length > 0 兜底
  const f = fixture({ config: { enabled: true } })
  try {
    const result = await f.source.handleEvent(event({
      messageId: 'om_unknown', chatType: 'group', text: '@_user_1 帮我改代码',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_whoever' }, name: 'someone' }],
    }))
    assert.equal(result.dropped, 'unknown-bot-id', 'the truthful reason is explicit, not a silent swallow')
    assert.equal(result.injected, false)
    assert.equal(result.queued, false)
    const row = f.trigger('feishu-om_unknown')
    assert.ok(row, 'a dropped event still lands as a recorded trigger (只记录不处理)')
    assert.equal(row.dropped, 'unknown-bot-id')
    assert.equal(row.authorization, undefined, 'a dropped trigger grants no authorization')
    assert.equal(row.source.addressing, 'none')
  } finally { f.cleanup() }
})

test('S06 单一入口: a group message @ somebody else is dropped even when botOpenId is configured', async () => {
  const f = fixture({ botOpenId: 'ou_real_bot' })
  try {
    const result = await f.source.handleEvent(event({
      messageId: 'om_other', chatType: 'group', text: '@_user_1 你们看下',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_colleague' }, name: '同事' }],
    }))
    assert.equal(result.dropped, 'unknown-bot-id', '@ someone else must not be mistaken for @ this bot')
    assert.equal(result.injected, false)
    assert.equal(f.trigger('feishu-om_other').dropped, 'unknown-bot-id')
    // 对照组: 同一条消息 @ 本 bot 才是工作
    const addressed = await f.source.handleEvent(event({
      messageId: 'om_other_ok', chatType: 'group', text: '@_user_1 你们看下',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_real_bot' }, name: 'hub-bot' }],
    }))
    assert.equal(addressed.dropped, null)
  } finally { f.cleanup() }
})

test('S06 单一入口: 停/停止 travels as the original text and the Router is the one that cancels', async () => {
  const f = fixture()
  try {
    f.registry.bindSession('chief', 'running-chief')
    const stop = await f.source.handleEvent(event({ messageId: 'om_stop', text: '停' }))
    const stopFull = await f.source.handleEvent(event({ messageId: 'om_stop_full', text: '停止' }))
    assert.equal(stop.triggerId, 'feishu-om_stop')
    assert.equal(stopFull.triggerId, 'feishu-om_stop_full')
    // 原文逐字交给 Router —— 停止语义在 Router 的 acceptFeishuTrigger 里判，适配器不改写、不自己取消
    assert.equal(f.trigger('feishu-om_stop').message, '停', 'the stop text is handed over unaltered')
    assert.equal(f.trigger('feishu-om_stop_full').message, '停止', 'the stop text is handed over unaltered')
    assert.equal(f.calls.cancel.length, 2, 'the Router cancels once per explicit stop message')
  } finally { f.cleanup() }
})

test('S06 单一入口: a non-text message still records the 暂不支持 reply intent, exactly once', async () => {
  const f = fixture()
  try {
    const result = await f.source.handleEvent(event({ messageId: 'om_image', msgType: 'image' }))
    assert.equal(result.dropped, 'unsupported-type')
    assert.equal(result.injected, false)
    const replies = () => f.outbox().filter(row => row.kind === 'reply' && row.triggerId === 'feishu-om_image')
    const [reply] = replies()
    assert.ok(reply, 'the reply intent is stored before anything else (先存后做)')
    assert.equal(reply.state, 'recorded', 'recorded, never faked as sent')
    assert.equal(reply.to, 'feishu:chat:oc_1')
    assert.equal(reply.body, '暂不支持该消息类型')
    assert.equal(reply.requestId, 'hub-bot-feishu-unsupported-om_image')
    assert.equal(f.trigger('feishu-om_image').dropped, 'unsupported-type')
    assert.equal(f.trigger('feishu-om_image').msgType, 'image')
    // 重放同一条消息不产生第二条回复意图
    await f.source.handleEvent(event({ messageId: 'om_image', msgType: 'image' }))
    assert.equal(replies().length, 1, 'a replay must not duplicate the recorded reply intent')
  } finally { f.cleanup() }
})

test('expired Feishu attempts release the scan and ignore their stale grant during retry', { timeout: 3000 }, async () => {
  const original = { kind: 'grant', payload: { appId: 'fixture-old-bot', appSecret: 'older-fixture-secret' } }
  const credentials = fakeCredentialsPort({ record: original })
  const entered = [Promise.withResolvers(), Promise.withResolvers()]
  const grants = [Promise.withResolvers(), Promise.withResolvers()]
  let attempt = 0
  const f = fixture({ credentials, larkOverrides: {
    registerApp: async options => {
      const index = attempt++
      options.onQRCodeReady({ url: 'https://example.invalid/scan-' + index, expireIn: 2 })
      entered[index].resolve(options)
      return grants[index].promise
    },
    client: { request: async () => ({ code: 99991672 }) },
    WSClient: class {
      constructor(options) { this.options = options }
      async start() { this.options.onReady() }
      close() {}
    },
    EventDispatcher: class { register() { return this } },
  } })
  try {
    await f.source.connect()
    const first = f.source.register()
    const firstOptions = await entered[0].promise
    assert.equal(f.source.status().registration, 'pending')
    assert.ok(f.source.status().qr)
    f.advance(2100)
    const expired = f.source.status()
    assert.equal(expired.registration, 'expired')
    assert.equal(expired.qr, undefined)
    assert.equal(expired.bot.connected, true)
    assert.equal(firstOptions.signal.aborted, true)
    const retry = f.source.register()
    await entered[1].promise
    firstOptions.onQRCodeReady({ url: 'https://example.invalid/stale', expireIn: 60 })
    grants[0].resolve({ client_id: 'fixture-stale', client_secret: 'stale-fixture-secret' })
    assert.deepEqual(await first, { expired: true })
    assert.equal(f.source.status().qr.url, 'https://example.invalid/scan-1')
    assert.deepEqual(credentials.records.get(DEFAULT_FEISHU_CREDENTIAL_REF), original)
    grants[1].resolve({ client_id: 'fixture-new-bot', client_secret: 'newer-fixture-secret' })
    assert.deepEqual(await retry, { appId: 'fixture-new-bot' })
    assert.equal(f.source.status().eventMode, 'manual')
    assert.equal(f.source.status().wsState, 'connected')
    assert.equal(f.source.status().qr, undefined)
  } finally {
    for (const grant of grants) grant.resolve({ client_id: 'cleanup', client_secret: 'cleanup' })
    f.source.disconnect()
    f.cleanup()
  }
})

test('a saved registration and a failed long connection are distinct outcomes', async () => {
  const f = fixture({ larkOverrides: {
    WSClient: class {
      async start() { throw new Error('fixture connection unavailable') }
      close() {}
    },
    EventDispatcher: class { register() { return this } },
  } })
  try {
    assert.deepEqual(await f.source.register(), { appId: 'cli_new' })
    const status = f.source.status()
    assert.equal(status.credentialState, 'ok')
    assert.equal(status.eventMode, 'configured')
    assert.equal(status.wsState, 'failed')
    assert.equal(status.registrationError, undefined)
    assert.equal(status.bot.connected, false)
  } finally { f.source.disconnect(); f.cleanup() }
})
