/**
 * WorkspacePlacer (#52): 「出生即归位」的 workspaceId 供给层。
 * 铁律：任何失败返回 null（调用方回退 cwd 创建），绝不抛出、绝不阻塞注入主链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspacePlacer, CHIEF_WORKSPACE_DIR } from '../src/workspaces.js'

const CHIEF_WORKSPACE_TITLE = 'Hub Bot 中枢' // config.js 默认值的镜像

const silent = { warn: () => {} }
const memoryStore = () => {
  const map = new Map()
  return { get: k => map.get(k), set: (k, v) => map.set(k, v), map }
}

const fakeController = (overrides = {}) => {
  const calls = []
  const workspaces = new Map()
  let seq = 0
  return {
    calls,
    create: async ({ path }) => {
      calls.push(['create', path])
      if (overrides.createThrows) throw new Error('boom')
      const existing = workspaces.get(path)
      if (existing) return { workspace: existing, created: false }
      const view = { workspaceId: 'ws-' + (++seq), path, title: path.replace(/\/+$/, '').split('/').pop(), sessionIds: [] } // 与 DSH 一致：默认标题 = basename
      workspaces.set(path, view)
      return { workspace: view, created: true }
    },
    rename: async ({ workspaceId, title }) => {
      calls.push(['rename', workspaceId, title])
      if (overrides.renameThrows) throw new Error('name-conflict')
    },
    workspaces,
  }
}

test('service unavailable → null (caller falls back to cwd creation)', async () => {
  const p = new WorkspacePlacer({ workspaceController: undefined, homeRepo: '/repo', logger: silent })
  assert.equal(p.available, false)
  assert.equal(await p.chiefWorkspace(), null)
  assert.equal(await p.ownerWorkspace({ id: 'o', cwd: '/repo/x' }), null)
})

test('chiefWorkspace: dedicated dir inside homeRepo, titled on creation', async () => {
  const ctrl = fakeController()
  const mkdirs = []
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: m => mkdirs.push(m) })
  const result = await p.chiefWorkspace()
  assert.deepEqual(mkdirs, ['/repo/' + CHIEF_WORKSPACE_DIR])
  assert.deepEqual(ctrl.calls.map(c => c[0]), ['create', 'rename'])
  assert.equal(ctrl.calls[0][1], '/repo/' + CHIEF_WORKSPACE_DIR) // 必须在 homeRepo 树内（AGENTS.md 向上查找）
  assert.equal(ctrl.calls[1][2], CHIEF_WORKSPACE_TITLE)
  assert.equal(result.workspaceId, 'ws-1')
  assert.equal(result.path, '/repo/' + CHIEF_WORKSPACE_DIR)
})

test('chiefWorkspace on an existing user-named workspace does NOT rename (user title preserved)', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  const { workspace } = await ctrl.create({ path: '/repo/' + CHIEF_WORKSPACE_DIR })
  workspace.title = '我的中枢' // 用户自定义标题
  ctrl.calls.length = 0
  const result = await p.chiefWorkspace()
  assert.deepEqual(ctrl.calls.map(c => c[0]), ['create']) // 幂等复用，无 rename
  assert.ok(result.workspaceId)
})

test('mkdir failure → null + warn, never throws', async () => {
  const warns = []
  const p = new WorkspacePlacer({
    workspaceController: fakeController(), homeRepo: '/repo',
    logger: { warn: (...a) => warns.push(a.join(' ')) },
    mkdir: () => { throw new Error('EACCES') },
  })
  assert.equal(await p.chiefWorkspace(), null)
  assert.equal(warns.length, 1)
})

test('create failure → null + warn, never throws', async () => {
  const warns = []
  const p = new WorkspacePlacer({
    workspaceController: fakeController({ createThrows: true }), homeRepo: '/repo',
    logger: { warn: (...a) => warns.push(a.join(' ')) }, mkdir: () => {},
  })
  assert.equal(await p.chiefWorkspace(), null)
  assert.equal(warns.length, 1)
})

test('rename conflict still returns workspaceId (title is nice-to-have)', async () => {
  const ctrl = fakeController({ renameThrows: true })
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  const result = await p.chiefWorkspace()
  assert.equal(result.workspaceId, 'ws-1')
})

test('ownerWorkspace: repo workspace at owner cwd, titled with workspace name', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  // workspace 名与 basename 不同 → 应 rename；相同时幂等跳过（下一条用例覆盖）
  const result = await p.ownerWorkspace({ id: 'repo-GhostNexus', cwd: '/repo/GhostNexus', workspace: 'GhostNexus 仓库', kind: 'repo' })
  assert.deepEqual(ctrl.calls.map(c => c[0]), ['create', 'rename'])
  assert.equal(ctrl.calls[0][1], '/repo/GhostNexus')
  assert.equal(ctrl.calls[1][2], 'GhostNexus 仓库')
  assert.ok(result.workspaceId)
})

test('ownerWorkspace: workspace name matching the basename skips rename (idempotent)', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  await p.ownerWorkspace({ id: 'repo-GhostNexus', cwd: '/repo/GhostNexus', workspace: 'GhostNexus', kind: 'repo' })
  assert.deepEqual(ctrl.calls.map(c => c[0]), ['create']) // 默认标题已是 GhostNexus
})

test('transient / scratch owners → null (temp sessions must not create workspaces)', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  assert.equal(await p.ownerWorkspace({ id: 't', cwd: '/tmp/x', transient: true }), null)
  assert.equal(await p.ownerWorkspace({ id: 't2', cwd: '/tmp/y', kind: 'scratch' }), null)
  assert.equal(ctrl.calls.length, 0)
})

test('owner without cwd → null', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  assert.equal(await p.ownerWorkspace({ id: 'o' }), null)
  assert.equal(ctrl.calls.length, 0)
})

test('repeat calls stay correct without caching (create is a cheap idempotent resolve)', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  await p.chiefWorkspace()
  const again = await p.chiefWorkspace()
  assert.equal(again.workspaceId, 'ws-1') // 同 path 复用同工作区
})

test('existing workspace still carrying the default basename gets titled (recover from one-off rename failure)', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  const { workspace } = await ctrl.create({ path: '/repo/' + CHIEF_WORKSPACE_DIR }) // title 默认 = basename 'chief'
  ctrl.calls.length = 0
  await p.chiefWorkspace()
  assert.deepEqual(ctrl.calls.map(c => c[0]), ['create', 'rename']) // 补命名
})

test('user-renamed workspace (title != basename) is never re-titled', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({ workspaceController: ctrl, homeRepo: '/repo', logger: silent, mkdir: () => {} })
  const { workspace } = await ctrl.create({ path: '/repo/' + CHIEF_WORKSPACE_DIR })
  workspace.title = '我的中枢' // 用户自定义
  ctrl.calls.length = 0
  await p.chiefWorkspace()
  assert.deepEqual(ctrl.calls.map(c => c[0]), ['create']) // 无 rename
})


test('chiefWorkspace: configured chiefWorkspaceId links the user-created workspace as-is (turn 108)', async () => {
  const ctrl = fakeController()
  const mkdirs = []
  const warns = []
  const p = new WorkspacePlacer({
    workspaceController: ctrl, homeRepo: '/repo',
    workspaces: { enabled: true, chiefWorkspaceId: 'ws-user-1' },
    logger: { warn: (...a) => warns.push(a.join(' ')) },
    mkdir: m => mkdirs.push(m),
    registryList: () => [{ id: 'ws-user-1', path: '/pub/中枢', title: '我的中枢' }],
  })
  const result = await p.chiefWorkspace()
  assert.deepEqual(result, { workspaceId: 'ws-user-1', path: '/pub/中枢', title: '我的中枢' })
  assert.equal(mkdirs.length, 0, '关联模式不 mkdir——那是用户自己的地盘')
  assert.equal(ctrl.calls.length, 0, '关联模式不 create / rename')
  assert.equal(warns.length, 0)
})

test('chiefWorkspace: configured chiefWorkspaceId missing → warn + fall back to auto', async () => {
  const ctrl = fakeController()
  const warns = []
  const p = new WorkspacePlacer({
    workspaceController: ctrl, homeRepo: '/repo',
    workspaces: { enabled: true, chiefWorkspaceId: 'ws-gone' },
    logger: { warn: (...a) => warns.push(a.join(' ')) },
    mkdir: () => {},
    registryList: () => [{ id: 'ws-other', path: '/x', title: 'x' }],
  })
  const result = await p.chiefWorkspace()
  assert.equal(result.workspaceId, 'ws-1', '回落到自动模式（create 出来的 ws-1）')
  assert.ok(warns.some(w => w.includes('ws-gone')), 'warn 记录失效的关联')
})

test('chiefWorkspace: configured chiefWorkspaceId without registryList → falls back to auto', async () => {
  const ctrl = fakeController()
  const p = new WorkspacePlacer({
    workspaceController: ctrl, homeRepo: '/repo',
    workspaces: { enabled: true, chiefWorkspaceId: 'ws-x' },
    logger: silent,
    mkdir: () => {},
  })
  const result = await p.chiefWorkspace()
  assert.equal(result.workspaceId, 'ws-1', 'registryList 缺省（老 DSH）时关联不可用 → 自动模式')
})
