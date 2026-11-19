/**
 * HubBotSettingsService: DSH GUI 设置页的 Remote 数据通路。
 * 验证三件事：Remote 标记被 Gateway 发现（read/update 在 remoteMethods 里）、
 * read/update 忠实委托给 index.js 注入的闭包、校验错误以 settings/invalid 编码抛出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { HubBotSettingsService } from '../src/settings-service.js'

const makeService = (overrides = {}) => {
  const calls = []
  const deps = {
    settingsView: async () => ({ workspaces: { enabled: true } }),
    applySettings: async patch => { calls.push(patch); return { applied: patch } },
    listOwners: () => [],
    modelCatalog: async () => ({ groups: [] }),
    overview: async () => ({ tickets: [], owners: [], health: {} }),
    resolveTicket: async req => ({ resolved: req }),
    listWorkspaces: async () => [],
    startFeishuRegister: async () => ({ started: true }),
    retryOutbox: async req => ({ retried: req.all === true ? 3 : 1 }),
    ...overrides,
  }
  const ctx = new Context()
  const service = new HubBotSettingsService(ctx, deps)
  return { ctx, service, deps, calls }
}

test('exposes read and update as discoverable Remote methods', () => {
  const { service } = makeService()
  const names = remoteMethods(service).map(m => m.method)
  assert.ok(names.includes('read'), 'read must be Remote-marked')
  assert.ok(names.includes('update'), 'update must be Remote-marked')
  assert.ok(names.includes('listOwners'), 'listOwners must be Remote-marked')
  assert.ok(names.includes('modelCatalog'), 'modelCatalog must be Remote-marked')
  assert.ok(names.includes('overview'), 'overview must be Remote-marked')
  assert.ok(names.includes('resolveTicket'), 'resolveTicket must be Remote-marked')
})

test('registers itself under the hubBotSettings service key', async () => {
  const { ctx } = makeService()
  // cordis 的 reflect 用 Proxy 提供访问，引用不恒等——验证拿到的是可调用的同一个服务。
  assert.equal(typeof ctx.hubBotSettings.read, 'function')
  assert.deepEqual(await ctx.hubBotSettings.read(), { workspaces: { enabled: true } })
})

test('read delegates to the injected settingsView', async () => {
  const view = { chief: { model: null } }
  const { service } = makeService({ settingsView: async () => view })
  assert.deepEqual(await service.read(), view)
})

test('update delegates to the injected applySettings and returns its view', async () => {
  const { service, calls } = makeService()
  const result = await service.update({ workspaces: { enabled: false } })
  assert.deepEqual(calls, [{ workspaces: { enabled: false } }])
  assert.deepEqual(result, { applied: { workspaces: { enabled: false } } })
})

test('validation failures surface as RemoteError settings/invalid', async () => {
  const failing = async () => {
    const error = new Error('workspaces.chiefPath must be an absolute path')
    error.name = 'SettingsError'
    throw error
  }
  const { service } = makeService({ applySettings: failing })
  await assert.rejects(() => service.update({ workspaces: { chiefPath: 'relative' } }), error => {
    assert.ok(error instanceof RemoteError)
    assert.equal(error.code, 'settings/invalid')
    assert.match(error.message, /chiefPath/)
    return true
  })
})

test('HTTP-shaped 400 errors are also treated as validation failures', async () => {
  const failing = async () => {
    const error = new Error('bad patch')
    error.statusCode = 400
    throw error
  }
  const { service } = makeService({ applySettings: failing })
  await assert.rejects(() => service.update({}), error => error instanceof RemoteError && error.code === 'settings/invalid')
})

test('unexpected errors propagate unchanged', async () => {
  const boom = new Error('disk on fire')
  const { service } = makeService({ applySettings: async () => { throw boom } })
  await assert.rejects(() => service.update({}), error => error === boom)
})

test('listOwners projects registry rows to plain JSON', async () => {
  const rows = [{
    id: 'chief', role: 'chief', kind: 'repo', workspace: 'Ghost233HomeRepo',
    cwd: '/Volumes/x/Ghost233HomeRepo', sessionId: 'session-1', status: 'bound',
    createdAt: '2026-11-18T00:00:00.000Z', extra: 'not-projected',
  }]
  const { service } = makeService({ listOwners: () => rows })
  assert.deepEqual(await service.listOwners(), [{
    id: 'chief', role: 'chief', kind: 'repo', workspace: 'Ghost233HomeRepo',
    cwd: '/Volumes/x/Ghost233HomeRepo', sessionId: 'session-1', status: 'bound',
    createdAt: '2026-11-18T00:00:00.000Z', dshWorkspace: null, sessionTitle: null,
  }])
})

test('listOwners reverse-maps sessions to their DSH workspace (turn 109)', async () => {
  const rows = [
    { id: 'chief', role: 'chief', kind: 'repo', sessionId: 'session-1', status: 'bound' },
    { id: 'repo-x', role: 'owner', kind: 'repo', sessionId: 'session-9', status: 'bound' },
    { id: 'repo-y', role: 'owner', kind: 'repo', sessionId: null, status: 'created' },
  ]
  const { service } = makeService({
    listOwners: () => rows,
    listWorkspaces: async () => [
      { workspaceId: 'ws-chief', title: '我的中枢', path: '/pub/中枢', sessionIds: ['session-1'] },
      { workspaceId: 'ws-x', title: 'Repo X', path: '/x', sessionIds: ['session-9', 'session-other'] },
    ],
  })
  const result = await service.listOwners()
  assert.deepEqual(result[0].dshWorkspace, { workspaceId: 'ws-chief', title: '我的中枢' })
  assert.deepEqual(result[1].dshWorkspace, { workspaceId: 'ws-x', title: 'Repo X' })
  assert.equal(result[2].dshWorkspace, null, '无会话 → null')
})

test('listOwners decorates rows with the bound session title (round 27)', async () => {
  const rows = [
    { id: 'chief', role: 'chief', sessionId: 'session-1', status: 'bound' },
    { id: 'repo-x', role: 'owner', sessionId: 'session-9', status: 'bound' },
    { id: 'repo-y', role: 'owner', sessionId: null, status: 'created' },
  ]
  const { service } = makeService({
    listOwners: () => rows,
    // 真实部署里 readTitleSnapshots 的 title 是快照对象；index.js 的 dep 已归一化为纯文本，
    // 这里按 dep 的契约（sessionId → 文本）mock。
    readSessionTitles: async ids => {
      const map = { 'session-1': '查看当前状态', 'session-9': '排查 GhostNexus' }
      const out = {}
      for (const id of ids) if (map[id]) out[id] = map[id]
      return out
    },
  })
  const result = await service.listOwners()
  assert.equal(result[0].sessionTitle, '查看当前状态')
  assert.equal(result[1].sessionTitle, '排查 GhostNexus')
  assert.equal(result[2].sessionTitle, null, '无会话 → null')
})

test('listOwners tolerates a missing or failing listSessions dep', async () => {
  const rows = [{ id: 'chief', role: 'chief', sessionId: 'session-1', status: 'bound' }]
  const a = makeService({ listOwners: () => rows })
  assert.equal((await a.service.listOwners())[0].sessionTitle, null, 'dep 缺席 → null')
  const b = makeService({ listOwners: () => rows, readSessionTitles: async () => { throw new Error('boom') } })
  assert.equal((await b.service.listOwners())[0].sessionTitle, null, 'dep 抛错 → null 不阻塞')
})

test('modelCatalog passes the catalog through untouched', async () => {
  const catalog = { default: null, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }] }] }
  const { service } = makeService({ modelCatalog: async () => catalog })
  assert.deepEqual(await service.modelCatalog(), catalog)
})

test('overview delegates to the injected builder', async () => {
  const board = { tickets: [{ id: 'tsk-1', stage: 'working' }], owners: [], health: {} }
  const { service } = makeService({ overview: async () => board })
  assert.deepEqual(await service.overview(), board)
})

test('resolveTicket delegates and maps validation failures to ticket/invalid', async () => {
  const ok = await makeService().service.resolveTicket({ ticketId: 'tsk-1', resolution: 'confirm' })
  assert.deepEqual(ok, { resolved: { ticketId: 'tsk-1', resolution: 'confirm' } })
  const bad = makeService({
    resolveTicket: async () => { const e = new Error('resolution must be \"confirm\" or \"reject\"'); e.statusCode = 400; throw e },
  })
  await assert.rejects(() => bad.service.resolveTicket({ ticketId: 'tsk-1', resolution: 'x' }), error => {
    assert.ok(error instanceof RemoteError)
    assert.equal(error.code, 'ticket/invalid')
    return true
  })
})


test('listWorkspaces is discoverable and projects rows to plain JSON', async () => {
  const { service } = makeService({
    listWorkspaces: async () => [
      { workspaceId: 'ws-1', title: '中枢', path: '/Volumes/home/.hub-bot/chief' },
      { workspaceId: 'ws-2', title: null, path: '/tmp/x' },
    ],
  })
  const methods = remoteMethods(service).map(m => m.method)
  assert.ok(methods.includes('listWorkspaces'), 'listWorkspaces discoverable')
  const rows = await service.listWorkspaces()
  assert.deepEqual(rows, [
    { workspaceId: 'ws-1', title: '中枢', path: '/Volumes/home/.hub-bot/chief' },
    { workspaceId: 'ws-2', title: null, path: '/tmp/x' },
  ])
})

test('listWorkspaces returns empty array when deps give nothing', async () => {
  const { service } = makeService({ listWorkspaces: async () => undefined })
  assert.deepEqual(await service.listWorkspaces(), [])
})

test('startFeishuRegister is discoverable and delegates', async () => {
  let called = 0
  const { service } = makeService({ startFeishuRegister: async () => { called += 1; return { started: true } } })
  const methods = remoteMethods(service).map(m => m.method)
  assert.ok(methods.includes('startFeishuRegister'), 'startFeishuRegister discoverable')
  const result = await service.startFeishuRegister()
  assert.deepEqual(result, { started: true })
  assert.equal(called, 1)
})


test('retryOutbox is discoverable and delegates (turn 110)', async () => {
  const { service } = makeService()
  const methods = remoteMethods(service).map(m => m.method)
  assert.ok(methods.includes('retryOutbox'), 'retryOutbox discoverable')
  assert.deepEqual(await service.retryOutbox({ all: true }), { retried: 3 })
  assert.deepEqual(await service.retryOutbox({ id: 'out-1' }), { retried: 1 })
})

test('retryOutbox maps a missing dead letter to RemoteError outbox/invalid', async () => {
  const failing = async () => { const e = new Error('no failed outbox row "out-x"'); e.statusCode = 404; throw e }
  const { service } = makeService({ retryOutbox: failing })
  await assert.rejects(() => service.retryOutbox({ id: 'out-x' }), err => {
    assert.equal(err.code, 'outbox/invalid')
    return true
  })
})
