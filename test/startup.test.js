import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      root.provide('sessionController', {})
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

      await mounted.dispose()
      assert.ok(!root.reflect.get('hubBot', false), 'the root service must be withdrawn')
      assert.equal(hub.store.closed, true)
      assert.equal(routeRegistered, false)
    })
  }
}
