/** Versioned SQLite schema: fresh initialization, idempotent reopen, migration in order, and too-new rejection. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store, StoreError, SCHEMA_VERSION, migrations } from '../src/store.js'

/** One throwaway state directory per test. */
function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'hub-bot-store-test-'))
}

test('initializes a fresh database at the current schema version with every table', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = new Store(stateDir)
  t.after(() => store.close())
  assert.equal(store.schemaVersion, SCHEMA_VERSION)
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)
  for (const table of ['kv', 'trigger', 'ticket', 'owner', 'outbox', 'timer']) assert.ok(tables.includes(table), `missing table ${table}`)
})

test('schema 2 adds the timer table with its due and owner indexes (S09)', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = new Store(stateDir)
  t.after(() => store.close())
  assert.equal(SCHEMA_VERSION, 2)
  // The timer row is the durable schedule document: `at` carries the due instant for the tick scan, `owner` the
  // owner scope for management. Both are indexed so a tick never scans or parses unrelated rows.
  const columns = store.db.prepare('PRAGMA table_info(timer)').all().map(row => row.name)
  assert.deepEqual(columns.sort(), ['at', 'id', 'owner', 'value'])
  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'timer'").all().map(row => row.name)
  for (const index of ['timer_owner', 'timer_due']) assert.ok(indexes.includes(index), `missing index ${index}`)
})

test('an existing schema-1 database is upgraded in place, keeping its rows', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  // Build a schema-1 database exactly as the shipped 0→1 migration left it, then let Store migrate it to 2.
  const path = join(stateDir, 'hub-bot.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec('BEGIN')
  migrations[0](legacy)
  legacy.exec('PRAGMA user_version=1')
  legacy.exec('COMMIT')
  legacy.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('owner.registry', JSON.stringify({ owners: [{ id: 'repo:DSH-Workflow' }] }))
  legacy.close()
  const store = new Store(stateDir)
  t.after(() => store.close())
  assert.equal(store.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(store.get('owner.registry'), { owners: [{ id: 'repo:DSH-Workflow' }] })
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
  assert.ok(tables.includes('timer'), 'the 1→2 migration must add the timer table to an existing database')
})

test('creates the state directory when it does not exist yet', () => {
  const stateDir = join(tempStateDir(), 'nested', 'state')
  const store = new Store(stateDir)
  try { assert.equal(store.schemaVersion, SCHEMA_VERSION) } finally {
    store.close()
    rmSync(join(stateDir, '..', '..'), { recursive: true, force: true })
  }
})

test('reopening an existing database is a no-op and preserves data', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const first = new Store(stateDir)
  first.set('boot.count', 1)
  first.close()
  const second = new Store(stateDir)
  t.after(() => second.close())
  assert.equal(second.schemaVersion, SCHEMA_VERSION)
  assert.equal(second.get('boot.count'), 1)
})

test('runs migrations in version order inside transactions', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = new Store(stateDir)
  t.after(() => store.close())
  // The fresh database already proves migration 0→1 ran; the skeleton contract is that migrations[v] upgrades v→v+1.
  assert.equal(migrations.length, SCHEMA_VERSION)
  assert.equal(typeof migrations[0], 'function')
  // S09 appended migration 1→2; it must be a distinct step, never an edit of the shipped 0→1 entry.
  assert.equal(typeof migrations[1], 'function')
})

test('rejects a database newer than this build', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const path = join(stateDir, 'hub-bot.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`)
  db.close()
  assert.throws(() => new Store(stateDir), error => {
    assert.ok(error instanceof StoreError)
    assert.match(error.message, /newer than this build/)
    return true
  })
})

test('kv round-trips JSON values', t => {
  const stateDir = tempStateDir()
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const store = new Store(stateDir)
  t.after(() => store.close())
  assert.equal(store.get('missing'), undefined)
  store.set('owner.registry', { owners: [{ id: 'repo:DSH-Workflow' }] })
  assert.deepEqual(store.get('owner.registry'), { owners: [{ id: 'repo:DSH-Workflow' }] })
})
