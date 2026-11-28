import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { TaskBoard } from '../src/tasks.js'
import { DeferredRegistry } from '../src/deferred.js'
import { insertOutbox } from '../src/outbox.js'
import { recordReportFact } from '../src/reporting.js'
import { buildOwnerFacts, formatOwnerFacts, listOwnerFactIndex, readOwnerFactDetail } from '../src/owner-facts.js'

const NOW = '2026-11-28T12:00:00.000Z'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-owner-facts-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const now = () => NOW
  const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch'), now })
  const tasks = new TaskBoard({ store, now })
  const chief = registry.ensureChief({ workspace: 'Home', cwd: '/work' }).owner
  const owner = registry.create({ kind: 'repo', workspace: 'example', cwd: '/work/example' })
  registry.bindSession(owner.id, 'owner-before-loss')
  const authorization = { actor: 'human', source: 'feishu', at: NOW }
  function ticket(id, stage, fields = {}) {
    const row = { id, stage, owner: owner.id, mechanism: 'inject', authorization,
      triggerId: 'trg-' + id, requestId: 'req-' + id, createdAt: NOW, updatedAt: NOW, ...fields }
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(row.id, JSON.stringify(row))
    return row
  }
  const facts = options => buildOwnerFacts({ store, ownerId: owner.id, ...options })
  return { store, registry, tasks, chief, owner, authorization, ticket, facts }
}

test('facts retain stable identity and re-read the current owner and task stages', t => {
  const { registry, tasks, chief, owner, ticket, facts } = fixture(t)
  ticket('task-idle', 'idle')
  ticket('task-legacy-review', 'review')
  ticket('task-done', 'done')
  ticket('task-chief', 'working', { owner: chief.id })
  registry.markSessionMissing(owner.id)

  const missing = facts()
  assert.deepEqual(missing.owner, { id: 'repo-example', role: 'owner', kind: 'repo', workspace: 'example',
    cwd: '/work/example', sessionId: null, status: 'pending', transient: false })
  assert.deepEqual(missing.activeTasks.entries.map(({ id, stage }) => [id, stage]), [
    ['task-idle', 'idle'], ['task-legacy-review', 'person/review'],
  ])

  registry.bindSession(owner.id, 'owner-replacement')
  tasks.markDelivered('task-idle')
  tasks.fail({ ticketId: 'task-idle', reason: 'Hardware disconnected' })
  tasks.accept('task-legacy-review')
  const rebound = facts()
  assert.equal(rebound.owner.sessionId, 'owner-replacement')
  assert.deepEqual(rebound.activeTasks.entries.map(({ id, stage }) => [id, stage]), [['task-idle', 'failed']])
  assert.equal(rebound.activeTasks.byStage.failed, 1)
  assert.equal(facts({ ownerId: 'unknown' }), undefined)
})

test('pending facts carry the original deadline, receiver, target, source, and authority after a rebind', t => {
  const { store, owner, registry, tasks, authorization, ticket, facts } = fixture(t)
  const source = { kind: 'feishu', chatId: 'original-chat', triggerId: 'original-trigger' }
  const receiver = { kind: 'owner', ownerId: owner.id, sessionId: 'owner-before-loss' }
  const target = { ownerId: owner.id, sessionId: 'owner-before-loss' }
  const expiresAt = '2026-12-01T09:30:00+08:00'
  const book = new DeferredRegistry({ store, tasks, now: () => NOW })
  ticket('confirm-original', 'working', { targetSession: 'owner-before-loss' })
  const request = book.request({ ticketId: 'confirm-original', requestId: 'original-confirmation',
    ownerId: owner.id, requester: { actor: authorization.actor }, source, receiver, target, expiresAt,
    action: { type: 'dangerous-inject', entry: 'route', message: 'Original stored instructions' },
    question: 'Proceed with the original destination?' })

  ticket('legacy-confirm', 'working')
  tasks.askConfirm({ ticketId: 'legacy-confirm', question: 'Legacy approval',
    action: { type: 'fork', sessionId: 'legacy-original-worker' } })
  ticket('legacy-owner-confirm', 'working', { targetSession: 'earlier-owner-destination' })
  tasks.askConfirm({ ticketId: 'legacy-owner-confirm', question: 'Legacy action to the owner',
    action: { type: 'dangerous-inject', entry: 'follow-up', message: 'Original instructions' } })
  ticket('review-ready', 'working')
  tasks.report({ ticketId: 'review-ready', summary: 'Verification complete' })
  registry.bindSession(owner.id, 'owner-replacement')

  const pending = facts().pending
  assert.equal(pending.total, 4)
  const original = pending.entries.find(item => item.id === 'confirm-original')
  assert.equal(original.requestId, request.requestId)
  assert.equal(original.question, 'Proceed with the original destination?')
  assert.equal(original.expiresAt, expiresAt)
  assert.equal(original.status, 'pending')
  assert.deepEqual(original.target, target)
  assert.deepEqual(original.receiver, receiver)
  assert.deepEqual(original.source, source)
  assert.deepEqual(original.authorization, authorization)
  assert.equal(pending.entries.find(item => item.id === 'legacy-confirm').expiresAt, '2026-11-29T12:00:00.000Z')
  assert.deepEqual(pending.entries.find(item => item.id === 'legacy-confirm').target, { sessionId: 'legacy-original-worker' })
  assert.deepEqual(pending.entries.find(item => item.id === 'legacy-owner-confirm').target,
    { ownerId: owner.id, sessionId: 'earlier-owner-destination' })
  assert.equal(pending.entries.find(item => item.id === 'review-ready').expiresAt, null)

  tasks.cancel('confirm-original', { reason: 'Superseded by the user' })
  assert.equal(facts().pending.entries.some(item => item.id === 'confirm-original'), false)
  assert.equal(book.get(request.requestId).expiresAt, expiresAt)
  assert.deepEqual(tasks.getTicket('confirm-original').deferred.target, target)
})

test('execution links require a bound L3 and retain the latest active timer binding', t => {
  const { facts, store, registry, owner, chief, tasks, ticket } = fixture(t)
  const retired = registry.create({ kind: 'scratch' })
  registry.bindSession(retired.id, 'recycled-owner-session')
  registry.markRecycled(retired.id)
  registry.bindSession(owner.id, 'current-owner-session')
  registry.bindSession(chief.id, 'previous-chief-session')
  registry.bindSession(chief.id, 'current-chief-session')

  const bind = (id, stage, sessionId, fields) => {
    ticket(id, stage, fields)
    tasks.bindWorkerSession(id, { sessionId, cwd: owner.cwd })
  }
  bind('a-current-work', 'working', 'current-worker-session')
  bind('archived', 'working', 'archived-worker-session')
  bind('current-owner', 'working', 'current-owner-session')
  bind('previous-owner', 'working', 'owner-before-loss')
  bind('previous-chief', 'working', 'previous-chief-session')
  bind('recycled-owner', 'working', 'recycled-owner-session')
  bind('chief-work', 'working', 'unrelated-chief-worker', { owner: chief.id })
  bind('missing-authority', 'working', 'unauthorized-worker-session', { authorization: null })
  ticket('proposed-worker', 'idle', { targetSession: 'unbound-target',
    background: { kind: 'github', proposedSessionId: 'proposed-worker-session' } })

  const timer = (id, status) => {
    const row = { id, status, ownerId: owner.id, kind: 'timer', fireAt: NOW, schedule: { frequency: 'daily',
      time: '12:00', timeZone: 'Asia/Shanghai' } }
    store.db.prepare('INSERT INTO timer (id, value, at, owner) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(row), NOW, owner.id)
    return { background: { kind: 'timer', timerId: id } }
  }
  const recurring = timer('daily-reminder', 'pending')
  const cancelled = timer('ended-reminder', 'cancelled')
  bind('b-active-occurrence', 'person/answer', 'finishing-timer-worker', cancelled)
  bind('superseded-occurrence', 'done', 'previous-timer-worker', recurring)
  bind('c-latest-bound-occurrence', 'done', 'current-timer-worker', recurring)
  ticket('next-queued-occurrence', 'queued', recurring)
  bind('finished-occurrence', 'done', 'finished-timer-worker', cancelled)

  const snapshot = facts({ isArchived: sessionId => sessionId === 'archived-worker-session' })
  assert.deepEqual(snapshot.workers.entries.map(({ id, sessionId, timerId }) => [id, sessionId, timerId]), [
    ['a-current-work', 'current-worker-session', null],
    ['b-active-occurrence', 'finishing-timer-worker', 'ended-reminder'],
    ['c-latest-bound-occurrence', 'current-timer-worker', 'daily-reminder'],
  ])
  assert.equal(snapshot.workers.total, 3)
  const workerPage = listOwnerFactIndex({ store, ownerId: owner.id, section: 'workers', offset: 2, limit: 1,
    isArchived: sessionId => sessionId === 'archived-worker-session' })
  assert.equal(workerPage.entries[0].sessionId, 'current-timer-worker')
  assert.equal(workerPage.total, 3)
  assert.equal(workerPage.nextOffset, null)
  assert.equal(facts({ ownerId: retired.id }), undefined)
})

test('stored answers stay on the original execution receiver until a delivery receipt', async t => {
  const { store, registry, owner, authorization, tasks, ticket, facts } = fixture(t)
  const book = new DeferredRegistry({ store, tasks, now: () => NOW })
  ticket('worker-question', 'working')
  tasks.bindWorkerSession('worker-question', { sessionId: 'original-worker', cwd: owner.cwd })
  const receiver = { kind: 'worker', sessionId: 'original-worker' }
  const request = book.request({ ticketId: 'worker-question', requestId: 'answer-request', ownerId: owner.id,
    type: 'answer', action: { type: 'ask-user' }, question: 'Which result should I use?', receiver,
    requester: { actor: authorization.actor }, source: { kind: 'feishu', chatId: 'original-chat' },
    expiresAt: '2026-11-28T15:00:00.000Z' })
  registry.markSessionMissing(owner.id)
  assert.deepEqual(facts().pending.entries[0].receiver, receiver)
  await book.resolve({ requestId: request.requestId, decision: 'answer', text: 'Use the first result',
    actor: { actor: authorization.actor } })

  const delivery = facts().pending.entries[0]
  assert.equal(delivery.status, 'fulfilled')
  assert.equal(delivery.stage, 'working')
  assert.equal(delivery.deliveryState, 'queued')
  assert.equal(delivery.expiresAt, request.expiresAt)
  assert.equal(delivery.question, 'Which result should I use?')
  assert.deepEqual(delivery.receiver, receiver)
  const pendingPage = listOwnerFactIndex({ store, ownerId: owner.id, section: 'pending', limit: 1 })
  assert.equal(pendingPage.entries[0].deliveryState, 'queued')
  book.recordAnswerDelivery(request.requestId, { state: 'sent' })
  assert.equal(facts().pending.total, 0)
})

test('report indexes find recent and historical stored details under the same owner', t => {
  const { store, owner, chief, tasks, ticket, facts } = fixture(t)
  const original = { id: 'trg-complete-result', kind: 'route', at: NOW,
    message: 'Full original request with enough detail to resume work', source: { kind: 'route' } }
  store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(original.id, JSON.stringify(original), NOW)
  ticket('complete-result', 'working')
  const result = tasks.report({ ticketId: 'complete-result', summary: 'Fresh persisted report',
    evidence: 'proof without truncation', sections: { result: 'ready', changes: 'module', verification: 'passed', risks: 'low' } })
  const digest = recordReportFact(store, owner.id, result)
  tasks.accept(result.id)
  ticket('old-result', 'done', { report: { summary: 'Older persisted report', at: '2026-11-26T18:00:00.000Z' } })
  ticket('secret-other-owner', 'working', { owner: chief.id })
  const otherResult = tasks.report({ ticketId: 'secret-other-owner', summary: 'Other owner output' })
  const foreign = recordReportFact(store, chief.id, otherResult)
  const background = insertOutbox(store, { id: 'background-record', kind: 'background-report', state: 'sent',
    ticketId: 'complete-result', to: 'owner:' + owner.id,
    body: '[hub-bot 后台结果] - complete-result｜失败｜Previous attempt failed' }, () => Date.parse(NOW))
  insertOutbox(store, { id: 'unrelated-delivery', kind: 'inject', state: 'sent', ticketId: 'complete-result',
    to: 'owner:' + owner.id, body: 'Unrelated payload' }, () => Date.parse(NOW))

  const snapshot = facts()
  assert.deepEqual(snapshot.reports.entries.map(({ id, summary }) => [id, summary]), [
    ['complete-result', 'Fresh persisted report'], ['old-result', 'Older persisted report'],
  ])
  assert.deepEqual(new Set(snapshot.reportRecords.entries.map(item => item.id)), new Set([digest.id, background.id]))
  const reportPage = listOwnerFactIndex({ store, ownerId: owner.id, section: 'reportRecords', limit: 1 })
  assert.equal(reportPage.total, 2)
  assert.equal(reportPage.nextOffset, 1)
  const nextReportPage = listOwnerFactIndex({ store, ownerId: owner.id, section: 'reportRecords', offset: reportPage.nextOffset })
  assert.deepEqual(new Set([reportPage.entries[0].id, nextReportPage.entries[0].id]), new Set([digest.id, background.id]))
  assert.equal(nextReportPage.nextOffset, null)
  const detail = (kind, id) => readOwnerFactDetail({ store, ownerId: owner.id, kind, id })
  assert.deepEqual(detail('ticket', 'complete-result').report, result.report)
  assert.equal(detail('ticket', 'complete-result').stage, 'done')
  assert.deepEqual(detail('ticket', 'complete-result').trigger, original)
  assert.deepEqual(detail('outbox', digest.id).summaries,
    ['- complete-result｜等您验收｜结果：ready；变更：module；验证：passed；风险：low'])
  assert.deepEqual(detail('outbox', background.id).summaries, ['- complete-result｜失败｜Previous attempt failed'])
  assert.equal(detail('outbox', 'unrelated-delivery'), undefined)
  assert.equal(detail('outbox', foreign.id), undefined)
  assert.equal(detail('ticket', 'secret-other-owner'), undefined)
})

test('large histories produce bounded previews and complete deterministic paged indexes', t => {
  const { store, owner, ticket, facts } = fixture(t)
  const longText = 'SUMMARY_DETAIL '.repeat(2_000) + 'UNABRIDGED END'
  for (let i = 154; i >= 0; i--) {
    const id = 'bulk-' + String(i).padStart(3, '0')
    ticket(id, 'person/review', { routedMessage: longText,
      report: { summary: longText, at: NOW }, workerSession: { sessionId: 'worker-' + id, cwd: owner.cwd, at: NOW } })
  }
  store.db.exec('PRAGMA query_only = ON')
  const snapshot = facts()
  const first = formatOwnerFacts(snapshot)
  assert.equal(first, formatOwnerFacts(facts()))
  assert.ok(first.length < 6_000, 'the cold-start prompt must remain under 6,000 characters')
  assert.match(first, /待处理事项 155/)
  assert.match(first, /等您验收 155/)
  assert.match(first, /bulk-000/)
  assert.match(first, /read_owner_fact/)
  assert.doesNotMatch(first, /bulk-154|UNABRIDGED END/)

  const page = (section, offset = 0, limit = 20) => listOwnerFactIndex({ store, ownerId: owner.id, section, offset, limit,
    isArchived: () => assert.fail('only the workers index checks worker archives') })
  const start = page('pending', 0, 200)
  assert.equal(start.total, 155)
  assert.equal(start.nextOffset, 50)
  assert.equal(start.entries[0].id, 'bulk-000')
  assert.equal(start.entries.at(-1).id, 'bulk-049')
  assert.doesNotMatch(JSON.stringify(start), /SUMMARY_DETAIL/)
  const final = page('reports', 150)
  assert.deepEqual(final.entries.map(item => item.id), ['bulk-150', 'bulk-151', 'bulk-152', 'bulk-153', 'bulk-154'])
  assert.equal(final.nextOffset, null)
  assert.equal(page('not-a-section'), undefined)
  assert.equal(readOwnerFactDetail({ store, ownerId: owner.id, kind: 'ticket', id: final.entries.at(-1).id }).report.summary, longText)
  assert.equal(formatOwnerFacts(undefined), '')
})

test('a one-ticket page keeps owner scope and never checks worker archives', t => {
  const { store, owner, chief, ticket } = fixture(t)
  ticket('last-id', 'working', { workerSession: { sessionId: 'worker-1', cwd: owner.cwd, at: NOW } })
  ticket('first-id', 'review', { workerSession: { sessionId: 'worker-2', cwd: owner.cwd, at: NOW } })
  ticket('old-id', 'done', { updatedAt: null, createdAt: '2026-11-27T12:00:00.000Z' })
  ticket('other-owner', 'working', { owner: chief.id, updatedAt: '2026-11-29T12:00:00.000Z' })
  const page = (offset, section = 'tickets') => listOwnerFactIndex({ store, ownerId: owner.id, section, offset, limit: 1,
    isArchived: () => assert.fail('a ticket page has no worker liveness dependency') })

  const first = page(0)
  assert.deepEqual(first, { entries: [{ kind: 'ticket', id: 'first-id', stage: 'person/review',
    requestId: 'req-first-id', triggerId: 'trg-first-id', updatedAt: NOW }], total: 3, nextOffset: 1 })
  assert.equal(page(first.nextOffset).entries[0].id, 'last-id')
  const last = page(2)
  assert.equal(last.entries[0].updatedAt, '2026-11-27T12:00:00.000Z')
  assert.equal(last.nextOffset, null)
  assert.deepEqual(page(3), { entries: [], total: 3, nextOffset: null })
  assert.deepEqual(page(0, 'activeTasks'), { entries: first.entries, total: 2, nextOffset: 1 })
})
