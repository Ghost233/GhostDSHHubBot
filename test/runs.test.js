import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { TaskBoard } from '../src/tasks.js'
import { deliverRecordedReplies, discardOutboxRows, insertOutbox, retryOutboxRows, updateOutboxRow } from '../src/outbox.js'
import { RunAudit } from '../src/runs.js'

const initialTime = '2026-11-28T12:00:00.000Z'
const githubRun = {
  ticketId: 'tsk-github', triggerRef: 'github:fixture/project:issue:7', ownerId: 'repo-fixture/project',
  source: { kind: 'github', repo: 'fixture/project', issueNumber: 7, event: 'issue' },
}

function fixture(t, seed) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-runs-'))
  let store = new Store(dir)
  seed?.(store)
  let at = initialTime
  const openAudit = () => new RunAudit({ store, now: () => at })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    store, runs: openAudit(),
    setTime(value) { at = value },
    reopen() {
      store.close()
      store = new Store(dir)
      return { store, runs: openAudit() }
    },
  }
}

test('one durable run keeps its ticket and original trigger through retries and reopen', t => {
  const { runs, setTime, reopen } = fixture(t)
  const first = runs.ensure(githubRun)
  setTime('2026-11-28T12:01:00.000Z')
  const repeated = runs.ensure(githubRun)
  assert.equal(first.id, 'run-tsk-github')
  assert.equal(repeated.id, first.id)
  assert.equal(first.status, 'in-progress')
  assert.throws(() => runs.ensure({ ...githubRun, ticketId: 'tsk-duplicate' }), /already belongs/)
  assert.throws(() => runs.ensure({ ...githubRun, source: { kind: 'feishu' } }), /background source/)

  const { runs: reopened } = reopen()
  const saved = reopened.get(first.id)
  assert.equal(saved.triggerRef, githubRun.triggerRef)
  assert.equal(saved.ticketId, 'tsk-github')
  assert.equal(saved.ownerId, 'repo-fixture/project')
  assert.equal(saved.createdAt, initialTime)
  assert.deepEqual(saved.source, { ...githubRun.source, url: 'https://github.com/fixture/project/issues/7' })
  assert.deepEqual(reopened.list().map(run => run.id), [first.id])
  assert.equal(reopened.get('run-tsk'), undefined)
})

test('an explicit silent run keeps a safe reason without creating delivery evidence', t => {
  const { runs, setTime, reopen } = fixture(t)
  const run = runs.ensure(githubRun)
  const secret = 'synthetic-secret-value-123'
  assert.throws(() => runs.recordSilent(run.ticketId, secret), error => {
    return /silence reason/.test(error.message) && !error.message.includes(secret)
  })
  assert.equal(runs.get(run.id).status, 'in-progress')
  setTime('2026-11-28T12:02:00.000Z')
  runs.recordSilent(run.ticketId, 'no-change')

  const { runs: reopened } = reopen()
  const saved = reopened.get(run.id)
  assert.equal(saved.status, 'silent')
  assert.equal(saved.reason, '本次检查没有变化。')
  assert.equal(saved.notification, null)
  assert.deepEqual(saved.decisions, [{ kind: 'silent', reasonCode: 'no-change', at: '2026-11-28T12:02:00.000Z' }])
})

test('only the actual channel row can move a linked run from waiting to accepted or failed', async t => {
  const { store, runs } = fixture(t)
  const first = runs.ensure(githubRun)
  const second = runs.ensure({ ...githubRun, ticketId: 'tsk-second', triggerRef: 'github:fixture/project:issue:8' })
  const internal = insertOutbox(store, { ticketId: first.ticketId, kind: 'background-report', to: 'owner:fixture', state: 'sent' })
  assert.throws(() => runs.linkOutbox(first.ticketId, internal.id), /channel Outbox row/)
  assert.equal(runs.get(first.id).status, 'in-progress')

  const addReply = (ticketId, number) => insertOutbox(store, {
    ticketId, kind: 'reply', to: 'github:fixture/project:' + number, state: 'recorded', body: 'synthetic-private-body',
  }, () => Date.parse(initialTime))
  const success = addReply(first.ticketId, 7)
  const failure = addReply(second.ticketId, 8)
  runs.linkOutbox(first.ticketId, success.id)
  runs.linkOutbox(second.ticketId, failure.id)
  assert.equal(runs.get(first.id).status, 'waiting')
  assert.equal(runs.get(first.id).notification.channelAccepted, false)
  assert.equal(runs.get(second.id).status, 'waiting')

  const acceptanceTime = '2026-11-28T12:02:00.000Z'
  const attempts = []
  const deliver = () => deliverRecordedReplies({
    store, logger: { warn() {} }, now: () => acceptanceTime, channel: 'github', prefix: 'github:', maxAttempts: 2,
    parseTarget: target => target,
    send: async (target, _body, row) => {
      attempts.push(row.id)
      if (target.endsWith(':8')) throw new Error('synthetic-secret-from-transport')
    },
  })
  await deliver()
  const sent = runs.get(first.id)
  assert.equal(sent.status, 'sent')
  assert.equal(sent.notification.id, success.id)
  assert.equal(sent.notification.channel, 'github')
  assert.equal(sent.notification.channelAccepted, true)
  assert.equal(sent.notification.acceptedAt, acceptanceTime)
  assert.equal(Object.hasOwn(sent.notification, 'readAt'), false)
  assert.equal(runs.get(second.id).status, 'waiting', 'a transient error remains retryable')

  await deliver()
  const failed = runs.get(second.id)
  assert.deepEqual(attempts, [success.id, failure.id, failure.id])
  assert.equal(failed.status, 'failed')
  assert.equal(failed.notification.id, failure.id)
  assert.equal(failed.notification.channelAccepted, false)
  assert.equal(failed.notification.acceptedAt, null)
  assert.doesNotMatch(JSON.stringify([sent, failed]), /synthetic-private-body|synthetic-secret-from-transport/)
})

test('a timer run retains the exact ticket, worker and report references after reopen', t => {
  const { store, runs, setTime, reopen } = fixture(t)
  const source = {
    kind: 'timer', timerId: 'tmr-fixture', occurrenceId: 'occ-1', fireAt: initialTime, late: true,
    origin: { kind: 'feishu', triggerId: 'feishu:om-fixture', chatId: 'synthetic-secret-chat', actor: 'synthetic-secret-actor' },
  }
  const ticket = { id: 'tsk-timer', triggerId: 'timer:tmr-fixture:occ-1', owner: 'chief', stage: 'idle',
    background: { kind: 'timer', timerId: 'tmr-fixture' }, createdAt: initialTime }
  store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
  const run = runs.ensure({ ticketId: ticket.id, triggerRef: ticket.triggerId, ownerId: ticket.owner, source })
  const finishedAt = '2026-11-28T12:05:00.000Z'
  const tasks = new TaskBoard({ store, now: () => finishedAt })
  tasks.bindWorkerSession(ticket.id, { sessionId: 'worker-fixture', cwd: '/synthetic-secret-path' })
  tasks.markDelivered(ticket.id)
  tasks.report({ ticketId: ticket.id, summary: 'synthetic-secret-summary', evidence: 'synthetic-secret-evidence' })
  setTime(finishedAt)
  const report = insertOutbox(store, { ticketId: ticket.id, kind: 'background-report', to: 'owner:chief', state: 'queued' })
  runs.recordResult(ticket.id, { kind: 'result', reportId: report.id, at: finishedAt })
  runs.recordResult(ticket.id, { kind: 'result', reportId: report.id, at: finishedAt })

  const { runs: reopened } = reopen()
  const saved = reopened.get(run.id)
  assert.deepEqual(saved.source, { kind: 'timer', timerId: 'tmr-fixture', occurrenceId: 'occ-1', fireAt: initialTime, late: true,
    origin: { kind: 'feishu', triggerId: 'feishu:om-fixture' } })
  assert.equal(saved.stage, 'person/review')
  assert.deepEqual(saved.workerSession, { sessionId: 'worker-fixture', at: finishedAt })
  assert.deepEqual(saved.result, { ticketId: 'tsk-timer', kind: 'result', reportId: report.id, at: finishedAt })
  assert.deepEqual(saved.results, [saved.result])
  assert.equal(saved.notification, null)
  assert.equal(saved.status, 'in-progress')
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-secret/)
})

test('timeline scope and status filters apply before pagination', t => {
  const { runs } = fixture(t)
  const first = runs.ensure({ ...githubRun, at: '2026-11-28T12:01:00.000Z' })
  const second = runs.ensure({ ...githubRun, ticketId: 'tsk-second', triggerRef: 'github:fixture/project:issue:8',
    at: '2026-11-28T12:02:00.000Z' })
  const third = runs.ensure({ ...githubRun, ticketId: 'tsk-third', triggerRef: 'github:fixture/project:issue:9',
    ownerId: 'repo-other/project', at: '2026-11-28T12:03:00.000Z' })
  const timer = runs.ensure({ ticketId: 'tsk-timer-list', triggerRef: 'timer:tmr-list:1', ownerId: githubRun.ownerId,
    source: { kind: 'timer', timerId: 'tmr-list' }, at: '2026-11-28T12:04:00.000Z' })
  runs.recordSilent(first.ticketId, 'no-change')
  runs.recordSilent(third.ticketId, 'already-reported')
  runs.recordSilent(timer.ticketId, 'progress-only')

  const pick = filter => runs.list(filter).map(row => row.id)
  assert.deepEqual(pick({ limit: 2, offset: 1 }), [third.id, second.id])
  assert.deepEqual(pick({ ownerId: githubRun.ownerId, source: 'github', status: 'silent', limit: 1 }), [first.id])
  assert.deepEqual(pick({ status: 'silent', offset: 1, limit: 1 }), [third.id])
  assert.deepEqual(pick({ ticketId: second.ticketId }), [second.id])
  assert.deepEqual(pick({ ticketId: second.ticketId, source: 'timer' }), [])
  assert.deepEqual(pick({ triggerRef: timer.triggerRef }), [timer.id])
  assert.deepEqual(pick({ ownerId: 'chief' }), [])
  assert.throws(() => runs.list({ status: 'something-else' }), /status filter/)
  assert.throws(() => runs.list({ limit: 0 }), /limit/)
})

test('a shared final row controls notification history and retains failure after discard and reopen', t => {
  const { store, runs, reopen } = fixture(t)
  const first = runs.ensure(githubRun)
  const second = runs.ensure({ ...githubRun, ticketId: 'tsk-second', triggerRef: 'github:fixture/project:issue:8' })
  const reply = { ticketId: null, kind: 'reply', to: 'github:fixture/project:7', state: 'recorded' }
  const member = insertOutbox(store, reply)
  runs.linkOutbox(first.ticketId, member.id)
  runs.linkOutbox(second.ticketId, member.id)
  const group = insertOutbox(store, reply)
  const grouped = { ...member, settledWith: group.id }
  updateOutboxRow(store, grouped)
  assert.equal(runs.get(first.id).notification.id, group.id)
  assert.equal(runs.get(first.id).notification.linkedId, member.id)
  assert.equal(runs.get(second.id).status, 'waiting')

  const failed = { ...group, state: 'failed', originState: 'recorded', attempts: 2, lastError: 'synthetic-secret-archive' }
  updateOutboxRow(store, failed)
  assert.deepEqual(runs.list({ status: 'failed' }).map(run => run.id).sort(), [first.id, second.id].sort())
  assert.equal(retryOutboxRows(store, [group.id]), 1)
  assert.equal(runs.get(first.id).status, 'waiting')
  updateOutboxRow(store, failed)

  assert.equal(discardOutboxRows(store, [group.id]), 1)

  const { runs: reopened } = reopen()
  const saved = reopened.get(first.id)
  assert.equal(saved.status, 'failed')
  assert.equal(saved.notification.discarded, true)
  assert.equal(saved.notification.id, group.id)
  assert.equal(saved.notification.linkedId, member.id)
  assert.equal(reopened.get(second.id).status, 'failed')
  const listed = reopened.list({ status: 'failed' })
  assert.deepEqual(listed.map(run => run.id).sort(), [first.id, second.id].sort())
  assert.deepEqual(listed.find(run => run.id === first.id).notification, saved.notification)
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-secret-archive/)
})

test('previously stored background tickets remain discoverable by their exact trigger on upgrade', t => {
  const ownerId = 'repo-另 一个仓库'
  const source = { ...githubRun.source, url: 'https://fake.invalid/project?token=synthetic-secret-url' }
  const { runs, reopen } = fixture(t, store => {
    const sourceEvent = { id: githubRun.triggerRef, kind: 'github', ownerId, source, at: initialTime }
    const ticket = { id: githubRun.ticketId, triggerId: githubRun.triggerRef, owner: ownerId, stage: 'person/review',
      background: { kind: 'github' }, createdAt: initialTime, report: { summary: 'synthetic-secret-legacy', at: initialTime } }
    store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(sourceEvent.id, JSON.stringify(sourceEvent), initialTime)
    const insert = store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)')
    insert.run(ticket.id, JSON.stringify(ticket))
    insert.run('tsk-no-trigger', JSON.stringify({ ...ticket, id: 'tsk-no-trigger', triggerId: 'no-trigger' }))
    insertOutbox(store, { ticketId: ticket.id, triggerId: ticket.triggerId, kind: 'reply', to: 'github:fixture/project:7', state: 'sent' })
  })

  const [previous] = runs.list({ ownerId, triggerRef: githubRun.triggerRef })
  assert.equal(previous.ticketId, 'tsk-github')
  assert.equal(previous.stage, 'person/review')
  assert.equal(previous.status, 'in-progress')
  assert.equal(previous.notification, null, 'a legacy generic reply is not evidence of a results notification')
  assert.equal(previous.result.kind, 'result')
  assert.equal(previous.source.url, 'https://github.com/fixture/project/issues/7')
  assert.doesNotMatch(JSON.stringify(previous), /synthetic-secret/)
  assert.equal(runs.get('run-tsk-no-trigger'), undefined)

  const newer = runs.ensure({ ...githubRun, ownerId, ticketId: 'tsk-unicode', triggerRef: 'github:fixture/project:issue:9' })
  assert.equal(newer.ownerId, ownerId)
  const { runs: reopened } = reopen()
  assert.deepEqual(reopened.list({ ownerId }).map(run => run.ticketId).sort(), ['tsk-github', 'tsk-unicode'])
})

test('legacy timer history links each exact Feishu question and excludes unrelated replies', t => {
  const ticketId = 'tsk-legacy-timer'
  const triggerRef = 'timer:tmr-legacy:1'
  const origin = { kind: 'feishu', triggerId: 'feishu:om-legacy', chatId: 'oc-legacy' }
  const source = { kind: 'timer', timerId: 'tmr-legacy', origin }
  const firstSentAt = '2026-11-28T12:02:00.000Z'
  const lastSentAt = '2026-11-28T12:05:00.000Z'
  const request = (requestId, fields) => ({ requestId, ticketId, type: 'answer', source: origin, ...fields })
  const earlier = request('dfr-earlier', { status: 'fulfilled' })
  const current = request('dfr-current', { status: 'pending' })
  const registryOnly = request('dfr-registry-only', { ownerId: 'chief', status: 'answered' })

  const { runs, reopen } = fixture(t, store => {
    // A prior version already imported the run, but did not link deferred question notifications.
    store.set('run-audit:backfilled', true)
    const existing = { id: 'run-' + ticketId, ticketId, triggerRef, ownerId: 'chief', source, createdAt: initialTime }
    store.set('run-audit:run-' + ticketId, { ...existing, source: { ...source, origin: { kind: 'feishu', triggerId: origin.triggerId } } })
    store.set('run-audit:trigger:' + triggerRef, ticketId)
    store.set('deferred/req/' + registryOnly.requestId, registryOnly)
    store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(triggerRef, JSON.stringify({
      id: triggerRef, kind: 'timer', ownerId: 'chief', source, at: initialTime,
    }), initialTime)
    const ticket = {
      id: ticketId, triggerId: triggerRef, owner: 'chief', stage: 'person/answer', createdAt: initialTime,
      background: { kind: 'timer', timerId: source.timerId }, deferred: current,
      deferredHistory: [earlier, request('dfr-other-chat'), request('dfr-other-trigger'), request('dfr-other-ticket'),
        request('dfr-other-kind'), request('dfr-other-request'), request('dfr-wrong-origin', { source: { ...origin, chatId: 'oc-wrong' } })],
    }
    store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticketId, JSON.stringify(ticket))
    const reply = (requestId, at, patch) => insertOutbox(store, {
      id: 'out-question-' + requestId, ticketId, triggerId: origin.triggerId, kind: 'reply',
      requestId: 'hub-bot-question-' + requestId, to: 'feishu:chat:' + origin.chatId, state: 'sent', sentAt: at,
      body: 'synthetic-secret-question', ...patch,
    }, () => Date.parse(at))
    reply(earlier.requestId, firstSentAt)
    reply(registryOnly.requestId, '2026-11-28T12:03:00.000Z')
    reply(current.requestId, lastSentAt)
    reply('dfr-other-chat', lastSentAt, { to: 'feishu:chat:oc-other' })
    reply('dfr-other-trigger', lastSentAt, { triggerId: 'feishu:om-other' })
    reply('dfr-other-ticket', lastSentAt, { ticketId: 'tsk-other' })
    reply('dfr-other-kind', lastSentAt, { kind: 'inject' })
    reply('dfr-other-request', lastSentAt, { requestId: 'hub-bot-question-unrelated' })
    reply('dfr-wrong-origin', lastSentAt)
    reply('dfr-unrelated', lastSentAt)
    reply('ack', lastSentAt, { id: 'out-ack-fixture' })
  })

  const saved = runs.get('run-' + ticketId)
  assert.equal(saved.stage, 'person/answer')
  assert.equal(saved.status, 'sent')
  assert.equal(saved.notification.acceptedAt, lastSentAt)
  assert.deepEqual(saved.notifications.map(row => row.id), ['out-question-dfr-earlier', 'out-question-dfr-registry-only', 'out-question-dfr-current'])
  assert.equal(saved.decisions[0].at, firstSentAt)
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-secret-question|oc-legacy/)
  assert.deepEqual(reopen().runs.get(saved.id), saved)
})

test('local timer outcomes explain silence and progress only updates the last timestamp', t => {
  const { runs, setTime, reopen } = fixture(t)
  const local = runs.ensure({ ticketId: 'tsk-local', triggerRef: 'timer:tmr-local:1', ownerId: 'chief',
    source: { kind: 'timer', timerId: 'tmr-local' } })
  assert.throws(() => runs.recordSilent(local.ticketId, 'local-panel'), /silence reason/)
  setTime('2026-11-28T12:03:00.000Z')
  runs.recordProgress(local.ticketId)
  assert.equal(runs.get(local.id).status, 'in-progress')
  assert.equal(runs.get(local.id).result, null)
  runs.recordResult(local.ticketId, { kind: 'result', reportId: 'out-local-report' })
  runs.recordNotNotified(local.ticketId, 'local-panel')
  const latest = '2026-11-28T12:06:00.000Z'
  setTime(latest)
  runs.recordProgress(local.ticketId)

  const { runs: reopened } = reopen()
  const saved = reopened.get(local.id)
  assert.equal(saved.status, 'silent')
  assert.equal(saved.reason, '结果已记录在本机面板。')
  assert.equal(saved.result.reportId, 'out-local-report')
  assert.equal(saved.notification, null)
  assert.equal(saved.lastProgressAt, latest)
  assert.equal(saved.decisions.length, 1)
  assert.equal(saved.decisions[0].reasonCode, 'local-panel')
  assert.deepEqual(reopened.list({ status: 'silent' }).map(row => row.id), [local.id])
})

test('a sparse timeline filter uses bounded SQLite statements across a long history', t => {
  const { store, runs } = fixture(t)
  store.db.exec('BEGIN IMMEDIATE')
  for (let number = 1; number <= 1_001; number++) {
    runs.ensure({ ...githubRun, ticketId: 'tsk-bulk-' + number, triggerRef: 'github:fixture/project:issue:' + number,
      source: { ...githubRun.source, issueNumber: number } })
  }
  store.db.exec('COMMIT')

  const prepare = store.db.prepare
  let prepares = 0
  store.db.prepare = function (sql) {
    prepares++
    return prepare.call(this, sql)
  }
  try {
    assert.deepEqual(runs.list({ status: 'failed', limit: 1 }), [])
    assert.ok(prepares <= 2, `prepared ${prepares} SQLite statements for an empty page`)
    t.diagnostic(`Empty failed page across 1,001 runs: ${prepares} SQLite prepare call(s).`)

    const reply = insertOutbox(store, { kind: 'reply', to: 'github:fixture/project:1', state: 'failed' })
    runs.linkOutbox('tsk-bulk-1', reply.id)
    prepares = 0
    assert.deepEqual(runs.list({ status: 'failed', limit: 1 }).map(row => row.ticketId), ['tsk-bulk-1'])
    assert.ok(prepares <= 3, `prepared ${prepares} SQLite statements for a one-row page`)
    t.diagnostic(`One matching failed run across 1,001 runs: ${prepares} SQLite prepare call(s).`)
  } finally {
    store.db.prepare = prepare
  }
})
