import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
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
