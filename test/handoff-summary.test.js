import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffSummaryRegistry } from '../src/handoff-summary.js'
import { OwnerRegistry } from '../src/registry.js'
import { Store } from '../src/store.js'

const NOW = '2026-11-28T12:00:00.000Z'
const OLD_SESSION = 'session-owner-old'
const SOURCE = { sessionId: OLD_SESSION, throughSeq: 64, hasMore: true }
const EXCERPTS = '[64] User: Prefer option A for the prototype.'
const DRAFT_TEXT = 'The old discussion considered option A for the prototype.'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-handoff-summary-'))
  const state = { instant: NOW }
  const calls = []
  let sequence = 0
  const now = () => state.instant
  const ids = { uuid: () => String(++sequence) }
  const ports = {
    readTranscript: async request => {
      calls.push(['read', request])
      return { text: EXCERPTS, source: { ...SOURCE } }
    },
    summarize: async request => {
      calls.push(['summarize', request])
      return DRAFT_TEXT
    },
  }
  function reopen() {
    state.store?.close()
    const store = new Store(dir)
    const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch'), now })
    const book = new HandoffSummaryRegistry({ store, registry, now, ids,
      readTranscript: request => ports.readTranscript(request),
      summarize: request => ports.summarize(request),
    })
    Object.assign(state, { store, registry, book })
  }
  t.after(() => {
    state.store?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  reopen()
  const owner = state.registry.create({ kind: 'repo', workspace: 'example', cwd: '/work/example' })
  state.registry.bindSession(owner.id, OLD_SESSION)
  const address = { ownerId: owner.id, expectedSessionId: OLD_SESSION }
  return { state, ports, calls, address, reopen }
}

test('an explicit generation reads the bound source and reopens the draft with its provenance', async t => {
  const { state, calls, address, reopen } = fixture(t)
  const draft = await state.book.generate(address)
  assert.equal(draft.ownerId, address.ownerId)
  assert.equal(draft.sourceSessionId, OLD_SESSION)
  assert.equal(draft.sourceReadAt, NOW)
  assert.equal(draft.sourceThroughSeq, 64)
  assert.equal(draft.sourceHasMore, true)
  assert.equal(draft.text, DRAFT_TEXT)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.revision, 1)
  assert.equal(draft.expiresAt, '2026-11-29T12:00:00.000Z')
  assert.deepEqual(calls, [
    ['read', { ownerId: address.ownerId, sessionId: OLD_SESSION, maxBytes: 32 * 1024 }],
    ['summarize', { ownerId: address.ownerId, sessionId: OLD_SESSION, transcript: EXCERPTS, source: SOURCE, maxBytes: 8 * 1024 }],
  ])

  reopen()
  assert.deepEqual(state.book.get({ ...address, draftId: draft.draftId }), draft)
  assert.equal(calls.length, 2)
})

test('editing advances the current version while preserving source and rejecting stale edits', async t => {
  const { state, address, reopen } = fixture(t)
  const original = await state.book.generate(address)
  const selected = { ...address, draftId: original.draftId, revision: original.revision }
  state.instant = '2026-11-28T13:00:00.000Z'
  const edited = state.book.edit({ ...selected, text: 'Option A was only a proposal.' })
  assert.equal(edited.text, 'Option A was only a proposal.')
  assert.equal(edited.revision, 2)
  assert.equal(edited.sourceSessionId, original.sourceSessionId)
  assert.equal(edited.sourceReadAt, original.sourceReadAt)
  assert.equal(edited.sourceThroughSeq, original.sourceThroughSeq)
  assert.equal(edited.expiresAt, original.expiresAt)
  reopen()
  assert.throws(() => state.book.edit({ ...selected, text: 'Overwritten from an old preview.' }),
    { code: 'handoff-summary-revision-conflict' })
  assert.deepEqual(state.book.get(selected), edited)
})

test('only the exact confirmed revision can be read for a switch', async t => {
  const { state, address, reopen } = fixture(t)
  const draft = await state.book.generate(address)
  const selected = { ...address, draftId: draft.draftId, revision: draft.revision }
  assert.throws(() => state.book.confirmedSnapshot(selected), { code: 'handoff-summary-not-confirmed' })
  const confirmed = state.book.confirm(selected)
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.revision, 2)
  const current = { ...selected, revision: confirmed.revision }
  assert.deepEqual(state.book.confirm(current), confirmed)
  reopen()
  assert.throws(() => state.book.confirmedSnapshot(selected), { code: 'handoff-summary-revision-conflict' })
  assert.equal(state.book.confirmedSnapshot(current).text, DRAFT_TEXT)
  assert.equal(state.book.confirmedSnapshot(current).sourceSessionId, OLD_SESSION)

  const edited = state.book.edit({ ...current, text: 'A new edit requiring review.' })
  assert.equal(edited.status, 'draft')
  assert.throws(() => state.book.confirm(current), { code: 'handoff-summary-revision-conflict' })
  assert.throws(() => state.book.confirmedSnapshot({ ...current, revision: edited.revision }),
    { code: 'handoff-summary-not-confirmed' })
  assert.deepEqual(state.book.get(current), edited)
})

test('discard survives reopen and a draft list contains only active metadata', async t => {
  const { state, address, reopen } = fixture(t)
  const original = await state.book.generate(address)
  const selected = { ...address, draftId: original.draftId, revision: original.revision }
  const { text, ...metadata } = original
  assert.deepEqual(state.book.list(address), [metadata])
  const discarded = state.book.discard(selected)
  assert.equal(discarded.status, 'discarded')
  assert.equal(discarded.revision, 2)
  assert.equal(discarded.text, null)

  reopen()
  assert.deepEqual(state.book.list(address), [])
  const current = { ...selected, revision: discarded.revision }
  assert.deepEqual(state.book.discard(current), discarded)
  assert.deepEqual(state.book.get(current), discarded)
  assert.throws(() => state.book.confirm(current), { code: 'handoff-summary-discarded' })
  assert.throws(() => state.book.edit({ ...current, text: 'Do not restore.' }), { code: 'handoff-summary-discarded' })
  assert.throws(() => state.book.confirmedSnapshot(current), { code: 'handoff-summary-discarded' })
})

test('a draft cannot be previewed or used across stable owners or owner bindings', async t => {
  const { state, calls, address } = fixture(t)
  state.registry.ensureChief({ cwd: '/work' })
  state.registry.bindSession('chief', 'session-chief')
  const foreignAddress = { ownerId: 'chief', expectedSessionId: 'session-chief' }
  await assert.rejects(state.book.generate({ ...address, expectedSessionId: 'session-chief' }), { code: 'stale-owner-binding' })
  assert.deepEqual(calls, [])

  const draft = await state.book.generate(address)
  const selected = { draftId: draft.draftId, revision: draft.revision }
  assert.deepEqual(state.book.list(foreignAddress), [])
  assert.throws(() => state.book.get({ ...foreignAddress, ...selected }), { code: 'handoff-summary-not-found' })
  assert.throws(() => state.book.confirm({ ...foreignAddress, ...selected }), { code: 'handoff-summary-not-found' })

  state.registry.bindSession(address.ownerId, 'session-owner-replacement')
  assert.throws(() => state.book.confirm({ ...address, ...selected }), { code: 'stale-owner-binding' })
  assert.throws(() => state.book.get({ ...address, expectedSessionId: 'session-owner-replacement', ...selected }),
    { code: 'handoff-summary-not-found' })
  state.registry.bindSession(address.ownerId, OLD_SESSION)
  assert.throws(() => state.book.confirm({ ...address, ...selected }), { code: 'stale-owner-binding' })
  assert.deepEqual(state.book.list(address), [])
  assert.equal(calls.length, 2)
})

test('a late transcript or summary result is refused once the source binding changes', async t => {
  for (const pendingPort of ['readTranscript', 'summarize']) {
    await t.test(pendingPort, async t => {
      const { state, ports, calls, address, reopen } = fixture(t)
      const reachedPort = Promise.withResolvers()
      const resumePort = Promise.withResolvers()
      const original = ports[pendingPort]
      ports[pendingPort] = async request => {
        const result = await original(request)
        reachedPort.resolve()
        await resumePort.promise
        return result
      }
      const pending = state.book.generate(address)
      await reachedPort.promise
      const replacement = { ...address, expectedSessionId: 'session-owner-replacement' }
      state.registry.bindSession(address.ownerId, replacement.expectedSessionId)
      resumePort.resolve()
      await assert.rejects(pending, { code: 'stale-owner-binding' })
      if (pendingPort === 'readTranscript') assert.deepEqual(calls.map(([step]) => step), ['read'])
      reopen()
      assert.deepEqual(state.book.list(replacement), [])
    })
  }
})

test('a fixed deadline expires a confirmed revision and stale callbacks at the same instant', async t => {
  const { state, address, reopen } = fixture(t)
  const draft = await state.book.generate(address)
  state.instant = '2026-11-29T11:59:59.999Z'
  const selected = { ...address, draftId: draft.draftId }
  const confirmed = state.book.confirm({ ...selected, revision: draft.revision })
  assert.equal(confirmed.expiresAt, '2026-11-29T12:00:00.000Z')
  const current = { ...selected, revision: confirmed.revision }
  assert.equal(state.book.confirmedSnapshot(current).sourceSessionId, OLD_SESSION)

  state.instant = '2026-11-29T12:00:00.000Z'
  reopen()
  assert.deepEqual(state.book.list(address), [])
  assert.throws(() => state.book.get(current), { code: 'handoff-summary-expired' })
  assert.throws(() => state.book.confirmedSnapshot(current), { code: 'handoff-summary-expired' })
  assert.throws(() => state.book.edit({ ...current, text: 'Attempt to reopen the expired draft.' }),
    { code: 'handoff-summary-expired' })
  assert.throws(() => state.book.confirm(current), { code: 'handoff-summary-expired' })
  assert.throws(() => state.book.discard(current), { code: 'handoff-summary-expired' })
})

test('invalid transcript provenance and generation failures leave no preview and expose a safe error', async t => {
  const { state, ports, calls, address, reopen } = fixture(t)
  const read = ports.readTranscript
  const summarize = ports.summarize
  ports.readTranscript = async () => ({ text: EXCERPTS, source: { ...SOURCE, sessionId: 'foreign-session' } })
  await assert.rejects(state.book.generate(address), { code: 'handoff-summary-generation-failed' })
  assert.deepEqual(calls, [])

  ports.readTranscript = async () => { throw new Error('old session provider details') }
  await assert.rejects(state.book.generate(address), {
    code: 'handoff-summary-generation-failed', message: 'Could not generate a handoff summary from the selected session.',
  })
  ports.readTranscript = read
  ports.summarize = async () => { throw new Error('summarizer provider details') }
  await assert.rejects(state.book.generate(address), {
    code: 'handoff-summary-generation-failed', message: 'Could not generate a handoff summary from the selected session.',
  })

  reopen()
  assert.deepEqual(state.book.list(address), [])
  ports.summarize = summarize
  assert.equal((await state.book.generate(address)).text, DRAFT_TEXT)
})

test('generation and editing enforce a byte limit for multibyte text', async t => {
  const { state, ports, address } = fixture(t)
  const atLimit = '界'.repeat(2730) + 'ab'
  const tooLarge = '界'.repeat(2731)
  ports.summarize = async () => tooLarge
  await assert.rejects(state.book.generate(address), { code: 'handoff-summary-generation-failed' })
  assert.deepEqual(state.book.list(address), [])

  ports.summarize = async () => atLimit
  const draft = await state.book.generate(address)
  assert.equal(draft.text, atLimit)
  const selected = { ...address, draftId: draft.draftId, revision: draft.revision }
  assert.throws(() => state.book.edit({ ...selected, text: tooLarge }), { code: 'invalid-handoff-summary' })
  assert.deepEqual(state.book.get(selected), draft)
  assert.equal(state.book.edit({ ...selected, text: 'cd' + '界'.repeat(2730) }).revision, 2)
})
