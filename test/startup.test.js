import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { Context as PackageContext } from '@deepseek-ai/cordis'
import { runtimeRequire } from '../scripts/test-runtime.mjs'
import * as plugin from '../src/index.js'

const contexts = [['package Cordis', PackageContext]]
if (process.env.DSH_TEST_RUNTIME_ROOT) {
  const { Context } = await import(runtimeRequire.resolve('@deepseek-ai/cordis'))
  contexts.push(['installed DSH Cordis', Context])
}

for (const [label, Context] of contexts) {
  for (const managementEnabled of [true, false]) {
    test(label + ': Hub Bot mounts and releases its services (management API ' + (managementEnabled ? 'on' : 'off') + ')', async t => {
      const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-startup-'))
      const root = new Context()
      let routeRegistered = false
      // S06 显式停止: record what the Sessions port forwards to sessionController.cancel.
      const cancelRequests = []
      root.provide('sessionController', {
        cancel: async request => { cancelRequests.push(request); return { sessionId: request.sessionId } },
      })
      root.provide('sessionPersistence', {})
      root.provide('webServer', {
        host: '127.0.0.1',
        port: 3199,
        register() {
          routeRegistered = true
          return () => { routeRegistered = false }
        },
      })

      const mounted = root.plugin(plugin, {
        homeRepo,
        stateDir: join(homeRepo, 'state'),
        workspaces: { enabled: false },
        ...(managementEnabled && { devApi: { token: 'startup-test-token' } }),
      })
      t.after(async () => {
        await mounted.dispose()
        await rm(homeRepo, { recursive: true, force: true })
      })

      await mounted
      const hub = root.reflect.get('hubBot', false)
      const settings = root.reflect.get('hubBotSettings', false)
      assert.equal(hub?.registry.get('chief')?.role, 'chief')
      assert.equal((await settings.overview()).owners[0]?.id, 'chief')
      assert.equal(routeRegistered, managementEnabled)
      // S06 显式停止: the Sessions port exposes cancel and forwards the installed DSH shape { sessionId }
      // unchanged (no invented fields, no widening — authorization stays in the router).
      assert.equal(typeof hub.sessions.cancel, 'function', 'the Sessions port carries cancel for explicit stops')
      await hub.sessions.cancel({ sessionId: 'session-s06-cancel' })
      assert.deepEqual(cancelRequests, [{ sessionId: 'session-s06-cancel' }], 'cancel 原样透传 { sessionId }，不发明字段')

      await mounted.dispose()
      assert.ok(!root.reflect.get('hubBot', false), 'the root service must be withdrawn')
      assert.equal(hub.store.closed, true)
      assert.equal(routeRegistered, false)
    })
  }
}

test('Feishu registration acknowledgement and asynchronous write failure are separately observable', { timeout: 3000 }, async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-registration-'))
  const controller = new PackageContext()
  const writing = Promise.withResolvers()
  const releaseWrite = Promise.withResolvers()
  const fixtureSecret = 'synthetic-only-s04-sdk-secret'
  const source = new URL('../src/feishu.js', import.meta.url).href
  const sdk = 'data:text/javascript,' + encodeURIComponent('export const registerApp = async () => (' + JSON.stringify({ client_id: 'fixture-bot', client_secret: fixtureSecret }) + ')')
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@larksuiteoapi/node-sdk' && context.parentURL === source) return { url: sdk, shortCircuit: true }
    return nextResolve(specifier, context)
  } })
  let route
  let installed
  t.after(async () => {
    releaseWrite.resolve()
    await installed?.dispose()
    hooks.deregister()
    await rm(homeRepo, { recursive: true, force: true })
  })
  controller.provide('sessionController', {})
  controller.provide('sessionPersistence', {})
  controller.provide('credentials', {
    async readRecord() { return undefined },
    async modifyRecord(key) {
      assert.equal(key, 'hub-bot/feishu')
      writing.resolve()
      await releaseWrite.promise
      throw new Error('mock provider rejected ' + fixtureSecret)
    },
  })
  controller.provide('webServer', { host: '127.0.0.1', port: 3199, register(entry) {
    route = entry.handler
    return () => { route = undefined }
  } })
  installed = controller.plugin(plugin, {
    homeRepo, stateDir: join(homeRepo, 'state'), workspaces: { enabled: false },
    feishu: { enabled: true }, devApi: { token: 'fixture-registration-token' },
  })
  await installed
  const settings = controller.reflect.get('hubBotSettings', false)
  async function request(path, method) {
    let code, body
    await route({ url: '/hub-bot/api/feishu/' + path, method, headers: { host: '127.0.0.1:3199', 'x-hub-bot-token': 'fixture-registration-token' } }, {
      writeHead(status) { code = status },
      end(value) { body = JSON.parse(value) },
    })
    return { code, body }
  }
  const acknowledgement = await request('register', 'POST')
  assert.equal(acknowledgement.code, 202)
  assert.equal(acknowledgement.body.registration, 'pending')
  await writing.promise
  const pending = (await request('status', 'GET')).body
  assert.equal(pending.registration, 'pending')
  assert.equal(pending.credentialState, 'missing')
  releaseWrite.resolve()
  await setImmediate()
  const failed = (await request('status', 'GET')).body
  assert.equal(failed.registration, 'failed')
  assert.equal(failed.credentialState, 'missing')
  assert.equal(failed.bot, undefined)
  assert.match(failed.registrationError, /无法保存宿主凭据记录/)
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(fixtureSecret))
  assert.deepEqual(JSON.parse(JSON.stringify((await settings.read()).feishu.status)), failed)
})

test('only a complete own-session history can rule out an in-flight prompt receipt', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-prompt-receipts-'))
  const Context = contexts.at(-1)[1]
  const root = new Context()
  const sessionId = 'session-receipt-fixture'
  const release = Promise.withResolvers()
  const message = request => ({ source: { kind: 'user', rpcId: request } })
  const events = [
    { seq: 0, type: 'user/message', data: message('inherited') },
    { seq: 1, type: 'agent/inbox/spliced', data: { inserted: [message('admitted')] } },
    { seq: 2, type: 'user/message', data: { ...message('continued'), source: { kind: 'retry', rpcId: 'continued' } } },
  ]
  const reads = []
  let reportCount = events.length
  let closes = 0
  let flushError = false
  root.provide('sessionController', { async prompt() { return release.promise } })
  root.provide('sessionPersistence', {
    async flush() { if (flushError) throw new Error('Fixture persistence failure') },
    async stat() { return { eventCount: reportCount } },
    async open(id, access) {
      assert.equal(id, sessionId)
      assert.equal(access, 'read')
      return { id, inheritedEventCount: 1,
        async read(offset, count) { reads.push(offset); return { events: events.slice(offset, offset + count) } },
        async close() { closes++ },
      }
    },
  })
  root.provide('webServer', { host: '127.0.0.1', port: 3199 })
  const mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'), workspaces: { enabled: false } })
  t.after(async () => { release.resolve({ accepted: true }); await mounted.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  await mounted
  const hub = root.reflect.get('hubBot', false)
  const receipt = requestId => hub.sessions.hasPromptReceipt({ sessionId, requestId })
  assert.equal(await receipt('admitted'), true)
  assert.equal(await receipt('continued'), true)
  assert.equal(await receipt('inherited'), false)
  assert.deepEqual(reads, [1, 1, 1])
  assert.equal(closes, 3)
  reportCount += 100
  assert.equal(await receipt('incomplete'), undefined)
  reportCount = events.length
  const pending = hub.sessions.prompt({ sessionId, requestId: 'still-in-flight', text: 'fixture' })
  assert.equal(await receipt('still-in-flight'), undefined)
  assert.equal(reads.length, 4)
  release.resolve({ accepted: true })
  await pending
  assert.equal(await receipt('still-in-flight'), false)
  flushError = true
  assert.equal(await receipt('unflushed'), undefined)
  assert.equal(reads.length, 5)
})

test('an old mount can flush a Host answer accepted during reload', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-reload-prompt-'))
  const Context = contexts.at(-1)[1]
  const sessionId = 'session-reload-fixture'
  const requestId = 'hub-bot-answer-reload-fixture'
  const waiting = Promise.withResolvers()
  const visible = []
  const buffered = []
  const persistence = {
    async flush() { visible.push(...buffered.splice(0)) },
    async stat() { return { eventCount: visible.length } },
    async open(id, access) {
      assert.equal(access, 'read')
      return { id, inheritedEventCount: 0, async close() {},
        async read(offset, limit) { return { events: visible.slice(offset, offset + limit) } } }
    },
  }
  let mounted
  t.after(async () => { waiting.resolve(); await mounted?.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  async function boot() {
    const root = new Context()
    root.provide('sessionController', { async prompt() {
      await waiting.promise
      buffered.push({ seq: 0, type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user', rpcId: requestId } }] } })
      return { accepted: true }
    } })
    root.provide('sessionPersistence', persistence)
    root.provide('webServer', { host: '127.0.0.1', port: 3199 })
    mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'), workspaces: { enabled: false } })
    await mounted
    return root.reflect.get('hubBot', false)
  }
  const former = await boot()
  const input = { sessionId, requestId, text: 'fixture' }
  const prompt = former.sessions.prompt(input).catch(error => error)
  await mounted.dispose()
  const current = await boot()
  assert.equal(await current.sessions.hasPromptReceipt(input), undefined)
  waiting.resolve()
  assert.deepEqual(await prompt, { accepted: true })
  assert.equal(visible.length, 1)
  assert.equal(await current.sessions.hasPromptReceipt(input), true)
})

test('authenticated handoff summary previews the exact source and carries only the confirmed edit', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-handoff-summary-host-'))
  const Context = contexts.at(-1)[1]
  const root = new Context()
  const token = 'fixture-handoff-token'
  const oldSession = 'fixture-old-summary-owner'
  const creations = [], pages = [], prompts = []
  let handle
  root.provide('sessionController', {
    async state({ sessionId }) {
      if (sessionId === oldSession || creations.some(row => row.sessionId === sessionId)) return { running: false, queue: [], pendingInput: [] }
      throw Object.assign(Error('Fixture session unavailable'), { code: 'session/not-found' })
    },
    async page(request) {
      pages.push(request)
      return { hasMore: true, records: [
        { event: { type: 'user/message', seq: 33, data: { content: [{ type: 'text', text: '旧讨论：选择验收范围' }] } } },
        { event: { type: 'system/message', seq: 34, data: { message: { content: [{ type: 'text', text: '不应出现在草稿的系统文本' }] } } } },
        { event: { type: 'assistant/message', seq: 35, data: { message: { content: [{ type: 'text', text: '此前讨论了两个方案' }, { type: 'tool-call', arguments: '不应出现在草稿的工具参数' }] } } } },
      ] }
    },
    async create(request) { creations.push(request); return request },
    async prompt(input) { prompts.push(input); return { accepted: true } },
  })
  root.provide('sessionPersistence', { async flush() {} })
  root.provide('webServer', { host: '127.0.0.1', port: 3199, register(entry) {
    handle = entry.handler
    return () => { handle = undefined }
  } })
  const mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'), workspaces: { enabled: false }, devApi: { token } })
  t.after(async () => { await mounted.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  await mounted
  await setImmediate()
  const hub = root.reflect.get('hubBot', false)
  const settings = root.reflect.get('hubBotSettings', false)
  const owner = hub.registry.create({ kind: 'dir', cwd: homeRepo })
  hub.registry.bindSession(owner.id, oldSession)
  const source = { ownerId: owner.id, expectedSessionId: oldSession }
  async function request(path, body, authenticated = true) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: '/hub-bot/api/' + path, method: 'POST',
      headers: { host: '127.0.0.1:3199', ...(authenticated && { 'x-hub-bot-token': token }) } })
    let status, value
    await handle(req, { writeHead(code) { status = code }, end(payload) { value = JSON.parse(payload) } })
    return { status, value }
  }
  const generate = { ...source, action: 'generate' }
  assert.equal((await request('owners/handoff-summary', generate, false)).status, 401)
  assert.equal((await request('owners/handoff-summary', { ...generate, expectedSessionId: 'other-fixture' })).status, 400)
  assert.equal(pages.length, 0)
  const draft = (await request('owners/handoff-summary', generate)).value
  assert.equal(draft.status, 'draft')
  assert.equal(draft.sourceSessionId, oldSession)
  assert.equal(draft.sourceThroughSeq, 35)
  assert.match(draft.text, /#33.*选择验收范围/)
  assert.match(draft.text, /#35.*此前讨论了两个方案/)
  assert.doesNotMatch(draft.text, /系统文本|工具参数/)
  assert.deepEqual(pages, [{ address: { kind: 'session', sessionId: oldSession }, maxMessages: 16 }])
  const reference = value => ({ draftId: value.draftId, revision: value.revision })
  const replace = { action: 'request', mode: 'wait', ...source }
  assert.equal((await request('owners/switch', { ...replace, summary: reference(draft) })).status, 400)
  const text = '用户确认携带的编辑摘要'
  const edited = await settings.handoffSummaryAction({ ...source, ...reference(draft), action: 'edit', text })
  const confirmed = await settings.handoffSummaryAction({ ...source, ...reference(edited), action: 'confirm' })
  const accepted = await request('owners/switch', { ...replace, summary: reference(confirmed) })
  assert.equal(accepted.status, 200)
  await hub.router.ownerSwitch.tick()
  const bootstrap = prompts.find(row => row.requestId === accepted.value.initializationRequestId)
  assert.ok(bootstrap)
  assert.equal(bootstrap.sessionId, accepted.value.newSessionId)
  assert.match(bootstrap.content[0].text, /负责人事实/)
  assert.ok(bootstrap.content[0].text.includes(text))
  assert.doesNotMatch(bootstrap.content[0].text, /此前讨论了两个方案/)
  assert.equal(hub.registry.get(owner.id).sessionId, bootstrap.sessionId)
  assert.equal(pages.length, 1)
})

test('Feishu private-chat summary is idempotent, editable and usable only by its originating actor', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-feishu-handoff-'))
  const Context = contexts.at(-1)[1]
  const root = new Context()
  const token = 'fixture-feishu-handoff-token'
  const oldSession = 'session-feishu-handoff-old'
  const chatId = 'oc_original_summary_fixture'
  const actor = 'ou_original_summary_fixture'
  const calls = { read: [], prompts: [], creates: [], cancels: [] }
  let handler
  let oldBusy = true
  root.provide('sessionController', {
    async state({ sessionId }) {
      if (sessionId === oldSession || calls.creates.some(entry => entry.sessionId === sessionId)) {
        return { running: sessionId === oldSession && oldBusy, queue: [], pendingInput: [] }
      }
      throw Object.assign(Error('Fixture session missing'), { code: 'session/not-found' })
    },
    async create(request) { calls.creates.push(request); return request },
    async prompt(request) { calls.prompts.push(request); return { accepted: true } },
    async cancel(request) { calls.cancels.push(request); oldBusy = false; return { accepted: true } },
    async page(input) {
      calls.read.push(input.address.sessionId)
      return { hasMore: false, records: [{ event: { type: 'user/message', seq: 22,
        data: { content: [{ type: 'text', text: '原私聊摘要来源' + '续'.repeat(75) }] } } }] }
    },
  })
  root.provide('sessionPersistence', { async flush() {} })
  root.provide('webServer', { host: '127.0.0.1', port: 3199, register(entry) {
    handler = entry.handler
    return () => { handler = undefined }
  } })
  const mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'), workspaces: { enabled: false },
    devApi: { token }, feishu: { enabled: false }, github: { enabled: false } })
  t.after(async () => { await mounted.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  await mounted
  const hub = root.reflect.get('hubBot', false)
  const settings = root.reflect.get('hubBotSettings', false)
  const owner = hub.registry.create({ kind: 'dir', cwd: homeRepo })
  hub.registry.bindSession(owner.id, oldSession)
  async function post(path, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: '/hub-bot/api/' + path, method: 'POST', headers: { host: '127.0.0.1:3199', 'x-hub-bot-token': token } })
    let status, payload
    await handler(req, { writeHead(code) { status = code }, end(value) { payload = JSON.parse(value) } })
    assert.equal(status, 200, path)
    return payload
  }
  async function receive(messageId, text, { sender = actor, chat = chatId } = {}) {
    const result = await post('feishu/simulate', {
      sender: { sender_type: 'user', sender_id: { open_id: sender } },
      message: { message_id: messageId, chat_id: chat, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) },
    })
    await post('deliver', {})
    const receipt = hub.router.listOutbox().find(row => row.id === 'out-owner-switch-control-feishu-' + messageId)
    assert.equal(receipt?.to, 'feishu:chat:' + chat)
    assert.equal(receipt.state, 'recorded')
    return { result, body: receipt.body }
  }
  const generate = '/hub-switch summary ' + owner.id
  const initial = await receive('om_fixture_summary_generate', generate)
  const draftId = initial.body.match(/summary-[a-f0-9-]+/)?.[0]
  assert.ok(draftId && initial.body.includes('原私聊摘要来源') && initial.body.includes('1/2'))
  assert.match((await receive('om_fixture_summary_page', '/hub-switch preview ' + draftId + ' 2')).body, /2[/]2/)
  assert.equal((await receive('om_fixture_summary_generate', generate)).result.deduped, true)
  assert.deepEqual(calls.read, [oldSession])
  for (const [id, override] of [['actor', { sender: 'ou_other_fixture' }], ['chat', { chat: 'oc_other_fixture' }]]) {
    const denied = await receive('om_fixture_summary_wrong_' + id, '/hub-switch preview ' + draftId + ' 1', override)
    assert.match(denied.body, /摘要.*未受理/)
    assert.doesNotMatch(denied.body, /原私聊摘要来源/)
  }
  const draft = await settings.handoffSummaryAction({ action: 'get', ownerId: owner.id, expectedSessionId: oldSession, draftId })
  assert.ok(!Object.hasOwn(draft, 'origin'))
  const premature = await receive('om_fixture_summary_early', '/hub-switch wait-summary ' + draftId + ' 1')
  assert.match(premature.body, /摘要.*未受理/)
  assert.equal(hub.router.ownerSwitch.list({ ownerId: owner.id }).length, 0)
  const edited = await receive('om_fixture_summary_edit', '/hub-switch edit-summary ' + draftId + ' 1 已审阅的飞书背景')
  assert.match(edited.body, /v2.*待确认/)
  assert.match((await receive('om_fixture_summary_confirm', '/hub-switch confirm-summary ' + draftId + ' 2')).body, /v3/)
  const control = await receive('om_fixture_summary_switch', '/hub-switch stop-summary ' + draftId + ' 3')
  assert.match(control.body, /等待旧会话空闲/)
  await hub.router.ownerSwitch.tick()
  await hub.router.ownerSwitch.tick()
  const operation = hub.router.ownerSwitch.list({ ownerId: owner.id })[0]
  assert.deepEqual(operation.summary, { draftId, revision: 3 })
  assert.equal(operation.mode, 'stop')
  assert.deepEqual(calls.cancels, [{ sessionId: oldSession }])
  const initialized = calls.prompts.find(entry => entry.requestId === operation.initializationRequestId)
  assert.equal(initialized.sessionId, operation.newSessionId)
  assert.match(initialized.content[0].text, /已审阅的飞书背景/)
  assert.doesNotMatch(initialized.content[0].text, /原私聊摘要来源/)
  assert.deepEqual(calls.read, [oldSession])
  assert.ok(hub.router.listOutbox().some(row => row.id === 'out-owner-switch-' + operation.operationId + '-committed'
    && row.to === 'feishu:chat:' + chatId && row.state === 'recorded'))
})

test('Feishu explicit switch and the management panel share a durable owner operation', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-owner-switch-host-'))
  const Context = contexts.at(-1)[1]
  const root = new Context()
  const token = 'fixture-switch-token'
  const oldSession = 'fixture-original-owner'
  const activity = { running: true, queue: [], pendingInput: [] }
  const prompts = [], creations = [], archived = [], cancellations = []
  let handle, hub, owner
  root.provide('sessionController', {
    async state({ sessionId }) {
      if (sessionId === oldSession) return activity
      if (!creations.some(row => row.sessionId === sessionId)) throw Object.assign(new Error('Fixture session unavailable'), { code: 'session/not-found' })
      return { running: false, queue: [], pendingInput: [] }
    },
    async create(request) { creations.push(request); return request },
    async prompt(input) {
      prompts.push(input)
      if (input.requestId.startsWith('hub-bot-switch-')) assert.equal(hub.registry.get(owner.id).sessionId, oldSession)
      return { accepted: true }
    },
    async cancel({ sessionId }) { cancellations.push(sessionId); return { accepted: true } },
  })
  root.provide('sessionPersistence', { async flush() {} })
  root.provide('workspaceController', {
    async archiveSession(request) { archived.push(request); return { archivedSessionIds: [request.sessionId] } },
  })
  root.provide('webServer', { host: '127.0.0.1', port: 3199, register(entry) {
    handle = entry.handler
    return () => { handle = undefined }
  } })
  const mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'),
    workspaces: { enabled: false }, devApi: { token } })
  t.after(async () => { await mounted.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  await mounted
  await setImmediate()
  hub = root.reflect.get('hubBot', false)
  owner = hub.registry.create({ kind: 'repo', workspace: 'Switch fixture 仓库', cwd: homeRepo })
  hub.registry.bindSession(owner.id, oldSession)

  async function request(path, data, authenticated = true) {
    const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))])
    Object.assign(req, { url: '/hub-bot/api/' + path, method: data === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:3199', ...(authenticated && { 'x-hub-bot-token': token }) } })
    let status, body
    await handle(req, { writeHead(code) { status = code }, end(value) { body = value && JSON.parse(value) } })
    return { status, body }
  }

  const input = { action: 'request', ownerId: owner.id, expectedSessionId: oldSession }
  assert.equal((await request('owners/switch', input, false)).status, 401)
  assert.equal((await request('owners/switch', { ...input, expectedSessionId: 'unrelated-session' })).status, 400)
  const simulate = (command, messageId = 'om_fixture_switch_wait', actor = 'fixture-feishu-actor') => request('feishu/simulate', {
    sender: { sender_type: 'user', sender_id: { open_id: actor } },
    message: { message_id: messageId, chat_id: 'oc_fixture_switch', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: command }) },
  })
  assert.equal((await simulate('/hub-switch wait ' + owner.id)).status, 200)
  await request('deliver', {})
  assert.equal((await simulate('/hub-switch wait ' + owner.id)).body.deduped, true)
  await hub.router.ownerSwitch.tick()
  const current = (await request('overview')).body.ownerSwitches.find(row => row.ownerId === owner.id)
  assert.equal(current.status, 'waiting')
  assert.equal(creations.length, 0)
  assert.ok(hub.router.listOutbox().some(row => row.to === 'feishu:chat:oc_fixture_switch' && row.body.includes(current.operationId)))
  await simulate('/hub-switch cancel ' + current.operationId + ' ' + owner.id, 'om_fixture_switch_denied', 'fixture-other-actor')
  await request('deliver', {})
  assert.equal(hub.router.ownerSwitch.get({ ownerId: owner.id, operationId: current.operationId }).status, 'waiting')
  assert.ok(hub.router.listOutbox().some(row => row.triggerId === 'feishu-om_fixture_switch_denied' && row.body.includes('请从发起更换的飞书账号')))
  activity.running = false
  activity.queue.push({ id: 'fixture-context', placement: 'context', content: [] })
  await hub.router.ownerSwitch.tick()
  const accepted = hub.registry.get(owner.id).sessionId
  assert.notEqual(accepted, oldSession)
  assert.equal(creations[0].agentPreset, 'hub-bot-owner')
  assert.equal(creations[0].sessionId, accepted)
  assert.match(prompts[0].content[0].text, /负责人事实/)
  assert.equal(archived.length, 0)
  await hub.router.ownerSwitch.tick()
  assert.deepEqual(archived, [{ sessionId: oldSession, stopActivity: false }])
  const settings = root.reflect.get('hubBotSettings', false)
  const final = await settings.ownerSwitchAction({ action: 'status', ownerId: owner.id, operationId: current.operationId })
  assert.equal(final.status, 'completed')
  assert.equal(final.newSessionId, accepted)
  assert.equal(cancellations.length, 0)
})

test('both authenticated run timeline endpoints expose the same exact persisted result', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-run-host-'))
  const Context = contexts.at(-1)[1]
  const root = new Context()
  let handle
  const prompts = []
  root.provide('sessionController', {
    async create({ sessionId }) { return { sessionId } },
    async prompt(request) { prompts.push(request); return { accepted: true } },
  })
  root.provide('sessionPersistence', { async flush() {} })
  root.provide('webServer', { host: '127.0.0.1', port: 3199, register(entry) {
    handle = entry.handler
    return () => { handle = undefined }
  } })
  const token = 'fixture-run-host-token'
  const mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'),
    workspaces: { enabled: false }, devApi: { token } })
  t.after(async () => { await mounted.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  await mounted
  await setImmediate()
  const hub = root.reflect.get('hubBot', false)
  const manager = hub.registry.create({ kind: 'repo', workspace: 'Run fixture 仓库', cwd: homeRepo })
  hub.registry.bindSession(manager.id, 'owner-run-fixture')
  const settings = root.reflect.get('hubBotSettings', false)
  const source = { kind: 'github', repo: 'fixture/example', issueNumber: 16, event: 'issue' }
  const authorization = { actor: 'fixture', source: 'github', at: hub.router.now() }
  const launch = await hub.router.routeBackground({ ownerId: manager.id, message: 'inspect test data', triggerRef: 'github:fixture/example:issue:16', source, authorization })
  await hub.router.reportBackground({ ticketId: launch.ticketId, sessionId: launch.workerSession.sessionId, summary: 'Fixture run finished.' })
  const id = 'run-' + launch.ticketId
  async function request(route, authenticated = true) {
    const req = Readable.from([])
    Object.assign(req, { url: '/hub-bot/api/' + route, method: 'GET',
      headers: { host: '127.0.0.1:3199', ...(authenticated && { 'x-hub-bot-token': token }) } })
    let status, body
    await handle(req, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } })
    return { status, body }
  }
  assert.equal((await request('runs', false)).status, 401)
  assert.equal((await request('runs/detail?id=' + id, false)).status, 401)
  assert.equal((await request('runs?status=bogus')).status, 400)
  await assert.rejects(settings.listRuns({ status: 'bogus' }), error => error.code === 'runs/invalid')
  assert.equal((await request('runs/detail?id=run-no-fixture')).status, 404)
  const list = await request('runs?status=waiting&source=github&limit=1')
  assert.equal(list.status, 200)
  assert.equal(list.body.nextOffset, null)
  assert.deepEqual(list.body.runs.map(run => run.id), [id])
  const detail = await request('runs/detail?id=' + id)
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.body, await settings.runDetail({ id }))
  assert.equal(detail.body.workerSession.sessionId, launch.workerSession.sessionId)
  assert.equal(detail.body.result.kind, 'result')
  assert.equal(detail.body.notification.channelAccepted, false)
  assert.equal(detail.body.source.url, 'https://github.com/fixture/example/issues/16')
})

test('timer creation is bound to current owners and the panel only manages existing reminders', async t => {
  const homeRepo = await mkdtemp(join(tmpdir(), 'hub-bot-timer-host-'))
  const root = new PackageContext()
  const registered = new Map()
  let handle
  root.provide('tools', { register(tool, options) {
    registered.set(tool.name, { tool, options })
    return () => registered.delete(tool.name)
  } })
  root.provide('sessionController', {})
  root.provide('sessionPersistence', {})
  root.provide('webServer', { host: '127.0.0.1', port: 3199, register(entry) {
    handle = entry.handler
    return () => { handle = undefined }
  } })
  const mounted = root.plugin(plugin, { homeRepo, stateDir: join(homeRepo, 'state'),
    workspaces: { enabled: false }, devApi: { token: 'fixture-timer-token' } })
  t.after(async () => { await mounted.dispose(); await rm(homeRepo, { recursive: true, force: true }) })
  await mounted
  await setImmediate()
  const hub = root.reflect.get('hubBot', false)
  const settings = root.reflect.get('hubBotSettings', false)
  hub.registry.bindSession('chief', 'fixture-timer-chief')
  const repo = hub.registry.create({ kind: 'dir', cwd: homeRepo })
  hub.registry.bindSession(repo.id, 'fixture-timer-owner')
  const creator = registered.get('timer_create')
  assert.ok(creator)
  assert.equal(creator.options.when({ agent: { id: 'fixture-timer-chief' } }), true)
  assert.equal(creator.options.when({ agent: { id: 'fixture-mismatched-worker' } }), false)
  const input = { ownerId: repo.id, message: 'fixture follow-up', fireAt: new Date(Date.now() + 600_000).toISOString() }
  await assert.rejects(creator.tool.execute(input, { agent: { id: 'fixture-mismatched-worker' } }), /cannot manage/)
  const { timer } = await creator.tool.execute(input, { agent: { id: 'fixture-timer-chief' } })
  assert.equal(timer.ownerId, repo.id)
  assert.equal(timer.createdBy, 'fixture-timer-chief')
  assert.equal((await settings.overview()).timers[0].id, timer.id)
  assert.equal(creator.tool.parameters.properties.schedule?.type, 'object')
  const schedule = { frequency: 'weekly', time: '09:30', weekday: 2 }
  const { timer: recurring } = await creator.tool.execute({ ownerId: repo.id, message: 'fixture schedule', schedule }, { agent: { id: 'fixture-timer-owner' } })
  assert.deepEqual(recurring.schedule, { ...schedule, timeZone: 'Asia/Shanghai' })
  assert.equal(recurring.fireAt.slice(11, 16), '01:30')
  assert.ok(Date.parse(recurring.fireAt) > Date.now())
  assert.deepEqual((await settings.overview()).timers.find(row => row.id === recurring.id).schedule, recurring.schedule)
  await assert.rejects(creator.tool.execute({ ...input, schedule }, { agent: { id: 'fixture-timer-chief' } }))
  const pause = await settings.timerAction({ id: timer.id, action: 'pause' })
  assert.equal(pause.timer.status, 'paused')
  assert.equal((await settings.timerAction({ id: timer.id, action: 'resume' })).timer.status, 'pending')
  await assert.rejects(settings.timerAction({ id: timer.id, action: 'create' }), error => error.code === 'timer/invalid')
  let status
  await handle({ url: '/hub-bot/api/overview', method: 'GET', headers: { host: '127.0.0.1:3199' } },
    { writeHead(code) { status = code }, end() {} })
  assert.equal(status, 401)
  hub.registry.bindSession(repo.id, 'fixture-rebound-owner')
  assert.equal(creator.options.when({ agent: { id: 'fixture-timer-owner' } }), false)
  const facts = registered.get('read_owner_fact')
  assert.equal(facts.options.when({ agent: { id: 'fixture-rebound-owner' } }), true)
  assert.equal(facts.options.when({ agent: { id: 'fixture-timer-owner' } }), false)
  await assert.rejects(facts.tool.execute({}, { agent: { id: 'fixture-timer-owner' } }), /current owner/)
  assert.match((await facts.tool.execute({}, { agent: { id: 'fixture-rebound-owner' } })).text, new RegExp(repo.id))
  const empty = await facts.tool.execute({ section: 'tickets', offset: 0 }, { agent: { id: 'fixture-rebound-owner' } })
  assert.deepEqual(JSON.parse(empty.text), { entries: [], total: 0, nextOffset: null })
  assert.equal((await settings.timerAction({ id: timer.id, action: 'cancel' })).timer.status, 'cancelled')
})
