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
