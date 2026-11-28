/**
 * OwnerRegistry: the owner registry of the hub-bot spec's data model (docs/specs/hub-bot-plugin.md「数据模型」).
 * Rows are JSON documents in the store's owner table; the registry owns validation, the chief bootstrap, the
 * created/pending lifecycle, and stable per-identity ids.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry, RegistryError } from '../src/registry.js'

/** A registry over a fresh store in a temp dir. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-registry-'))
  const store = new Store(dir)
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch') })
  return { registry, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('chief bootstrap creates the chief row once, pending, without touching it on restart', () => {
  const { registry, cleanup } = fixture()
  try {
    const first = registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
    assert.equal(first.created, true)
    assert.equal(first.owner.id, 'chief')
    assert.equal(first.owner.role, 'chief')
    assert.equal(first.owner.kind, 'repo')
    assert.equal(first.owner.cwd, '/Volumes/home')
    assert.equal(first.owner.sessionId, null)
    assert.equal(first.owner.status, 'pending')
    registry.bindSession('chief', 'session-abc')
    const again = registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
    assert.equal(again.created, false)
    assert.equal(again.owner.sessionId, 'session-abc')
    assert.equal(again.owner.status, 'created')
  } finally { cleanup() }
})

test('create validates per kind: repo needs workspace+cwd, dir needs cwd, scratch allocates its own', () => {
  const { registry, cleanup } = fixture()
  try {
    assert.throws(() => registry.create({ kind: 'repo', cwd: '/x' }), RegistryError)
    assert.throws(() => registry.create({ kind: 'repo', workspace: 'W' }), RegistryError)
    assert.throws(() => registry.create({ kind: 'dir' }), RegistryError)
    assert.throws(() => registry.create({ kind: 'nope', cwd: '/x' }), RegistryError)
    const repo = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    assert.equal(repo.id, 'repo-DSH-Workflow')
    assert.equal(repo.status, 'pending')
    assert.equal(repo.sessionId, null)
    const dir = registry.create({ kind: 'dir', cwd: '/Users/ghost/notes' })
    assert.ok(dir.id.startsWith('dir-'))
    const scratch = registry.create({ kind: 'scratch' })
    assert.equal(scratch.kind, 'scratch')
    assert.equal(scratch.transient, true)
    assert.equal(scratch.recycled, false)
    assert.ok(scratch.cwd.includes('scratch'), 'scratch cwd allocated under scratchRoot: ' + scratch.cwd)
  } finally { cleanup() }
})

test('create is idempotent per identity: creating the same repo twice returns the existing row', () => {
  const { registry, cleanup } = fixture()
  try {
    const a = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    registry.bindSession(a.id, 'session-1')
    const b = registry.create({ kind: 'repo', workspace: 'DSH-Workflow', cwd: '/repos/DSH-Workflow' })
    assert.equal(b.id, a.id)
    assert.equal(b.sessionId, 'session-1')
    assert.equal(registry.list().filter(o => o.id === a.id).length, 1)
  } finally { cleanup() }
})

test('dir identity is its cwd: same path maps to the same row', () => {
  const { registry, cleanup } = fixture()
  try {
    const a = registry.create({ kind: 'dir', cwd: '/Users/ghost/notes' })
    const b = registry.create({ kind: 'dir', cwd: '/Users/ghost/notes' })
    assert.equal(a.id, b.id)
    const c = registry.create({ kind: 'dir', cwd: '/Users/ghost/other' })
    assert.notEqual(c.id, a.id)
  } finally { cleanup() }
})

test('bindSession marks created; markSessionMissing resets to pending with a null session', () => {
  const { registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    registry.bindSession(owner.id, 'session-9')
    assert.equal(registry.get(owner.id).status, 'created')
    registry.markSessionMissing(owner.id)
    const row = registry.get(owner.id)
    assert.equal(row.status, 'pending')
    assert.equal(row.sessionId, null)
  } finally { cleanup() }
})

test('invalidateSessionForTest points the row at a dangling session id without touching status', () => {
  const { registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    registry.bindSession(owner.id, 'session-live')
    registry.invalidateSessionForTest(owner.id, 'session-dangling')
    const row = registry.get(owner.id)
    assert.equal(row.sessionId, 'session-dangling')
    assert.equal(row.status, 'created')
  } finally { cleanup() }
})

test('unknown ids throw RegistryError; list sorts chief first', () => {
  const { registry, cleanup } = fixture()
  try {
    assert.equal(registry.get('nope'), undefined)
    assert.throws(() => registry.bindSession('nope', 's'), RegistryError)
    registry.ensureChief({ cwd: '/Volumes/home', workspace: 'Ghost233HomeRepo' })
    registry.create({ kind: 'repo', workspace: 'AAA', cwd: '/a' })
    const list = registry.list()
    assert.equal(list[0].id, 'chief')
    assert.ok(list.some(o => o.workspace === 'AAA'))
  } finally { cleanup() }
})

/**
 * S03 回归（issue #34）：负责人身份必须能从「当前绑定」这一条唯一权威记录核验出来。
 * 重建负责人会留下旧会话仍然活着 —— 旧会话必须落进历史（previousSessionIds），不能继续冒充当前绑定，
 * 否则一个已被顶掉的孤儿会话仍能以负责人身份行动。
 *
 * S03 regression (issue #34): rebinding displaces the old Session into history. The CURRENT binding stays the one
 * authoritative identity; the displaced id is remembered so it can be classified as an owner session and refused,
 * but it must never resolve as the current binding again.
 */
test('S03 regression: rebinding keeps the displaced Session as history, never as the current binding', () => {
  const { registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    registry.bindSession(owner.id, 'session-old')
    const rebound = registry.bindSession(owner.id, 'session-new')
    assert.equal(rebound.sessionId, 'session-new', '当前绑定是最新会话')
    assert.deepEqual(rebound.previousSessionIds, ['session-old'], '被顶掉的旧会话进入历史（最新在前）')
    assert.equal(registry.findByCurrentSession('session-new')?.id, owner.id, '当前绑定可解析回负责人行')
    assert.equal(registry.findByCurrentSession('session-old'), undefined, '历史绑定不再解析为当前负责人——过期绑定不得授权')
    assert.equal(registry.isOwnerSession('session-old'), true, '历史绑定仍被识别为负责人会话（不得当作 L3 执行目标）')
    assert.equal(registry.isOwnerSession('session-new'), true, '当前绑定是负责人会话')
    assert.equal(registry.isOwnerSession('session-worker'), false, '普通执行会话不是负责人会话')
  } finally { cleanup() }
})

/**
 * S03 回归（issue #34）：会话丢失（markSessionMissing）后旧 id 只能算历史。
 * 此时没有任何「当前绑定」，findByCurrentSession 必须一律返回 undefined —— 没有活绑定就没有负责人身份。
 *
 * S03 regression (issue #34): once the binding is dropped, no Session resolves as the current binding. The old id
 * is history: it is still classified as an owner session, but it authorizes nothing.
 */
test('S03 regression: a dropped binding leaves no current binding, only history', () => {
  const { registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    registry.bindSession(owner.id, 'session-gone')
    registry.markSessionMissing(owner.id)
    const row = registry.get(owner.id)
    assert.equal(row.sessionId, null, '会话丢失后没有当前绑定')
    assert.deepEqual(row.previousSessionIds, ['session-gone'], '旧会话落进历史')
    assert.equal(registry.findByCurrentSession('session-gone'), undefined, '历史会话不得作为当前绑定授权')
    assert.equal(registry.isOwnerSession('session-gone'), true, '历史会话仍是负责人会话，不得当作 L3 目标')
    assert.ok(registry.knownSessionIds().has('session-gone'), 'knownSessionIds 覆盖历史绑定')
  } finally { cleanup() }
})

/**
 * S03 回归（issue #34）：被回收（recycle）的临时负责人保留 sessionId 供查证，但它不再是活绑定。
 * 活绑定 = 有 sessionId 且 status==='created' 且未回收；findByCurrentSession 必须只认活绑定。
 *
 * S03 regression (issue #34): a recycled owner keeps its Session id for the audit trail, but it is no longer a
 * live binding — the current-binding lookup must refuse it, while classification still marks it as an owner session.
 */
test('S03 regression: a recycled owner keeps its Session but is never a live current binding', () => {
  const { registry, cleanup } = fixture()
  try {
    const scratch = registry.create({ kind: 'scratch' })
    registry.bindSession(scratch.id, 'session-scratch')
    registry.markRecycled(scratch.id)
    const row = registry.get(scratch.id)
    assert.equal(row.sessionId, 'session-scratch', '回收后保留 sessionId 供查证')
    assert.equal(row.recycled, true)
    assert.equal(registry.findByCurrentSession('session-scratch'), undefined, '已回收负责人的会话不是活绑定')
    assert.equal(registry.isOwnerSession('session-scratch'), true, '已回收负责人的会话仍不得当作 L3 目标')
    assert.ok(registry.knownSessionIds().has('session-scratch'))
  } finally { cleanup() }
})

/**
 * S03 回归（issue #34）：knownSessionIds 是「所有曾绑定过的会话」的并集（当前 + 历史），
 * 空/非字符串输入必须安全返回空结果 —— 这是分类的输入面，不能因为脏输入就抛错。
 *
 * S03 regression (issue #34): knownSessionIds unions current and historical ids, and both lookups tolerate
 * empty/non-string input without throwing.
 */
test('S03 regression: knownSessionIds unions current and history ids and tolerates empty input', () => {
  const { registry, cleanup } = fixture()
  try {
    const owner = registry.create({ kind: 'repo', workspace: 'W', cwd: '/w' })
    registry.bindSession(owner.id, 'session-a')
    registry.bindSession(owner.id, 'session-b')
    const ids = registry.knownSessionIds()
    assert.ok(ids.has('session-a'), '历史 id 在集合内')
    assert.ok(ids.has('session-b'), '当前 id 在集合内')
    assert.equal(registry.findByCurrentSession(''), undefined)
    assert.equal(registry.findByCurrentSession(undefined), undefined)
    assert.equal(registry.isOwnerSession(''), false)
    assert.equal(registry.isOwnerSession(null), false)
  } finally { cleanup() }
})
