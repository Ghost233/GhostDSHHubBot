import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wordCount } from '../src/discipline.js'
import { NotificationThrottle } from '../src/notifications.js'
import { deliverRecordedReplies, discardOutboxRows, insertOutbox, retryOutboxRows } from '../src/outbox.js'
import { RunAudit } from '../src/runs.js'
import { Store } from '../src/store.js'

const START = Date.parse('2026-11-28T12:00:00.000Z')

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-notifications-'))
  let now = START
  let store, runs, notifications
  const sent = []
  const iso = () => new Date(now).toISOString()

  function open() {
    store = new Store(dir)
    runs = new RunAudit({ store, now: iso })
    notifications = new NotificationThrottle({ store, runs, now: () => now, ...options })
  }
  open()
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  return {
    sent,
    get store() { return store },
    get runs() { return runs },
    get notifications() { return notifications },
    at(ms) { now = START + ms },
    reopen() { store.close(); open() },
    result(ticketId, { ownerId = 'chief', to = 'feishu:chat:oc_a', body = ticketId, reportId = 'report-' + ticketId } = {}) {
      const triggerId = 'timer:occurrence:' + ticketId
      runs.ensure({ ticketId, triggerRef: triggerId, ownerId, source: { kind: 'timer', timerId: 'timer-' + ticketId } })
      runs.recordResult(ticketId, { kind: 'result', reportId })
      return notifications.record({ ticketId, triggerId, to, body })
    },
    run(ticketId) { return runs.get('run-' + ticketId) },
    async deliver({ channel = 'feishu', send, maxAttempts = 5 } = {}) {
      return deliverRecordedReplies({
        store, channel, prefix: channel + ':', maxAttempts, now: iso, logger: { warn() {} },
        parseTarget: to => to,
        send: async (to, body, row) => {
          await send?.(to, body, row)
          sent.push({ to, body, id: row.id, requestId: row.requestId })
        },
      })
    },
  }
}

test('the first ordinary result is sent immediately with its exact notification lookup ID', async t => {
  const f = fixture(t)
  const summary = '后台任务 tsk-first 有结果待验收。'
  const row = f.result('tsk-first', { body: summary })
  assert.equal(row.state, 'recorded')
  assert.equal(f.run('tsk-first').status, 'waiting')
  assert.equal(f.run('tsk-first').notification.channelAccepted, false)
  await f.deliver()
  assert.equal(f.sent.length, 1)
  const [{ to, body, id, requestId }] = f.sent
  assert.deepEqual({ to, id, requestId }, { to: 'feishu:chat:oc_a', id: row.id, requestId: row.requestId })
  const emittedId = /通知编号 (out-[a-f0-9-]+) 查看完整任务索引与详情。$/u.exec(body)?.[1]
  assert.equal(emittedId, id)
  assert.ok(body.startsWith(summary + '\n'))
  assert.ok(Buffer.byteLength(body) <= 4_096)
  assert.ok(wordCount(body) <= 100)

  f.reopen()
  assert.deepEqual(f.notifications.details(emittedId), {
    id: emittedId, tickets: [{ ticketId: 'tsk-first', runId: 'run-tsk-first', sourceOutboxIds: [id] }],
  })
  const { status, notification } = f.run('tsk-first')
  assert.equal(status, 'sent')
  assert.equal(notification.id, emittedId)
  assert.equal(notification.channelAccepted, true)
  assert.equal(notification.acceptedAt, '2026-11-28T12:00:00.000Z')
})

test('an initial result near either reply limit keeps its task and lookup ID', async t => {
  const f = fixture(t)
  const results = [
    f.result('tsk-words', { body: 'tsk-words ' + '字'.repeat(98) }),
    f.result('tsk-bytes', { to: 'feishu:chat:oc_b', body: 'tsk-bytes ' + '📄'.repeat(1_020) }),
  ]
  await f.deliver()
  assert.equal(f.sent.length, results.length)
  for (const [i, { body }] of f.sent.entries()) {
    const { id, ticketId } = results[i]
    assert.ok(body.includes(ticketId))
    assert.ok(body.includes(id))
    assert.ok(Buffer.byteLength(body) <= 4_096)
    assert.ok(wordCount(body) <= 100)
  }
})

test('aliases and owner changes share a fixed window while every source remains in the audit', async t => {
  const f = fixture(t)
  f.result('tsk-first')
  await f.deliver()

  f.at(1_000)
  const early = f.result('tsk-work', { ownerId: 'owner-two', to: 'feishu:oc_a', body: 'tsk-work: earlier result' })
  assert.equal(early.state, 'held')
  assert.equal(f.run('tsk-work').status, 'waiting')
  f.at(59_999)
  const latest = f.result('tsk-work', { ownerId: 'owner-two', body: 'tsk-work: latest result', reportId: 'report-update' })
  const other = f.result('tsk-other', { body: 'tsk-other: ready' })
  assert.equal(f.result('tsk-another-chat', { to: 'feishu:chat:oc_b' }).state, 'recorded')
  assert.deepEqual(f.notifications.flush(), [])
  await f.deliver()
  assert.deepEqual(f.sent.map(row => row.to), ['feishu:chat:oc_a', 'feishu:chat:oc_b'])

  f.at(60_000)
  const [digest] = f.notifications.flush()
  assert.deepEqual(f.notifications.flush(), [])
  assert.equal(f.run('tsk-other').status, 'waiting')
  await f.deliver()
  assert.equal(f.sent.length, 3)
  assert.match(f.sent[2].body, /tsk-work: latest result/)
  assert.match(f.sent[2].body, /tsk-other: ready/)
  assert.doesNotMatch(f.sent[2].body, /earlier result/)
  assert.equal(f.sent[2].id, digest.id)
  const work = f.run('tsk-work')
  assert.equal(work.status, 'sent')
  assert.deepEqual(work.results.map(result => result.reportId), ['report-tsk-work', 'report-update'])
  assert.deepEqual(work.notifications.map(row => [row.linkedId, row.id]), [[early.id, digest.id], [latest.id, digest.id]])
  assert.equal(f.run('tsk-other').notification.linkedId, other.id)
  assert.equal(f.run('tsk-other').notification.id, digest.id)
})

test('a long immediate GitHub result has a bounded lookup and leaves the ordinary deadline intact', async t => {
  const f = fixture(t)
  const to = 'github:fixture/project:7'
  const first = f.result('tsk-first', { to })
  assert.equal(first.state, 'recorded')
  f.at(1_000)
  const held = f.result('tsk-held', { to })
  assert.equal(held.state, 'held')

  const ticketId = 'tsk-github-comment'
  const triggerId = 'github:fixture/project:comment:1234'
  const run = f.runs.ensure({
    ticketId, triggerRef: triggerId, ownerId: 'github-owner',
    source: { kind: 'github', repo: 'fixture/project', issueNumber: 7, event: 'comment', commentId: 1234 },
  })
  f.runs.recordResult(ticketId, { kind: 'result', reportId: 'report-comment' })
  const urgent = f.notifications.recordImmediate({ ticketId, triggerId, to, body: '改'.repeat(180) })
  assert.equal(urgent.state, 'recorded')
  assert.equal(Object.hasOwn(urgent, 'notificationWindowMs'), false)
  assert.equal(f.runs.get(run.id).status, 'waiting')
  await f.deliver({ channel: 'github', send: (_to, _body, row) => {
    if (row.id === urgent.id) f.at(20_000)
  } })
  assert.deepEqual(f.sent.map(({ id }) => id), [first.id, urgent.id])
  const { body } = f.sent[1]
  assert.ok(body.includes(ticketId))
  assert.ok(Buffer.byteLength(body) <= 4_096)
  assert.ok(wordCount(body) <= 100)
  const emittedId = /通知编号 (out-[a-f0-9-]+) 查看完整任务索引与详情。$/u.exec(body)?.[1]
  assert.equal(emittedId, urgent.id)

  f.reopen()
  assert.deepEqual(f.notifications.details(emittedId), {
    id: urgent.id, tickets: [{ ticketId, runId: run.id, sourceOutboxIds: [urgent.id] }],
  })
  const history = f.runs.get(run.id)
  assert.equal(history.result.reportId, 'report-comment')
  assert.equal(history.notification.acceptedAt, '2026-11-28T12:00:20.000Z')
  assert.equal(history.notification.id, emittedId)

  f.at(60_999)
  assert.deepEqual(f.notifications.flush(), [])
  assert.equal(f.run('tsk-held').status, 'waiting')
  f.at(61_000)
  const [digest] = f.notifications.flush()
  await f.deliver({ channel: 'github' })
  assert.equal(f.sent.at(-1).id, digest.id)
  assert.equal(f.run('tsk-held').notification.linkedId, held.id)
  assert.equal(f.run('tsk-held').notification.acceptedAt, '2026-11-28T12:01:01.000Z')
})

test('overflow uses a bounded index with a durable exact entry for every task', async t => {
  const f = fixture(t)
  const first = f.result('tsk-first')
  await f.deliver()
  f.at(10)
  const info = '很长的结果'.repeat(300)
  const tickets = Array.from({ length: 110 }, (_, i) => 'tsk-repository-task-' + String(i).padStart(3, '0'))
  const sources = tickets.map(ticketId => f.result(ticketId, { body: info }))
  const update = f.result(tickets[0], { body: 'updated', reportId: 'report-revised' })

  f.at(60_000)
  const [digest] = f.notifications.flush()
  await f.deliver()
  const notice = f.sent.at(-1)
  assert.ok(Buffer.byteLength(notice.body) <= 4_096)
  assert.ok(notice.body.includes(digest.id), 'the channel message carries the exact index lookup ID')
  assert.match(notice.body, /110 项/)
  assert.match(notice.body, /tsk-repository-task-000/)
  assert.doesNotMatch(notice.body, /很长的结果/)

  f.reopen()
  assert.deepEqual(f.notifications.details(first.id), {
    id: first.id, tickets: [{ ticketId: 'tsk-first', runId: 'run-tsk-first', sourceOutboxIds: [first.id] }],
  })
  const index = f.notifications.details(digest.id)
  assert.deepEqual(index.tickets.map(ticket => ticket.ticketId), tickets)
  assert.deepEqual(index.tickets[0].sourceOutboxIds, [sources[0].id, update.id])
  for (const [i, task] of index.tickets.entries()) {
    assert.equal(f.runs.get(task.runId).notification.id, digest.id)
    assert.equal(task.sourceOutboxIds[0], sources[i].id)
    assert.equal(Object.hasOwn(task, 'body'), false)
  }
  assert.equal(f.notifications.details('missing'), undefined)
})

test('a requested dead-letter replay waits its turn and reuses the entire original publication', async t => {
  const f = fixture(t)
  f.result('tsk-first')
  await f.deliver()
  f.at(1)
  const a = f.result('tsk-failed-a')
  const b = f.result('tsk-failed-b', { ownerId: 'owner-b' })
  f.at(60_000)
  const [failed] = f.notifications.flush()
  await f.deliver({ maxAttempts: 1, send() { throw new Error('channel declined') } })
  assert.equal(f.run('tsk-failed-a').status, 'failed')
  assert.equal(f.run('tsk-failed-b').status, 'failed')
  assert.equal(f.run('tsk-failed-b').notification.acceptedAt, null)

  f.at(60_001)
  assert.equal(f.result('tsk-next').state, 'recorded', 'a failed publication consumes no send window')
  await f.deliver()
  f.at(60_002)
  f.result('tsk-waiting-before-retry')
  f.at(60_003)
  assert.equal(retryOutboxRows(f.store, [failed.id], () => '2026-11-28T12:01:00.003Z'), 1)
  assert.equal(f.run('tsk-failed-a').status, 'waiting')
  f.at(60_004)
  f.result('tsk-waiting-after-retry')
  await f.deliver()
  assert.equal(f.sent.length, 2, 'retry stays out of the channel until re-admitted')
  f.reopen()

  f.at(120_000)
  assert.deepEqual(f.notifications.flush(), [])
  f.at(120_001)
  const [before] = f.notifications.flush()
  assert.notEqual(before.id, failed.id)
  await f.deliver()
  assert.match(f.sent.at(-1).body, /tsk-waiting-before-retry/)
  assert.match(f.sent.at(-1).body, /tsk-waiting-after-retry/)

  f.at(120_002)
  f.result('tsk-waiting-behind-retry')
  f.at(180_001)
  const [retry] = f.notifications.flush()
  assert.equal(retry.id, failed.id)
  await f.deliver()
  assert.equal(f.sent.at(-1).requestId, failed.requestId)
  assert.equal(f.sent.at(-1).body, failed.body)
  assert.deepEqual(f.run('tsk-failed-a').notification, {
    id: failed.id, linkedId: a.id, channel: 'feishu', state: 'sent', channelAccepted: true,
    createdAt: '2026-11-28T12:01:00.000Z', acceptedAt: '2026-11-28T12:03:00.001Z', attempts: 0,
  })
  assert.equal(f.run('tsk-failed-b').notification.linkedId, b.id)
  assert.equal(f.run('tsk-waiting-behind-retry').status, 'waiting')
})

test('a configurable window starts at transport acceptance and survives restart and exempt replies', async t => {
  let windowMs = 500
  const f = fixture(t, { windowMs: () => windowMs })
  const first = f.result('tsk-delayed', { to: 'github:Fixture/Project:07' })
  f.reopen()
  const acceptance = Promise.withResolvers()
  const started = Promise.withResolvers()
  const delivery = f.deliver({ channel: 'github', send: () => { started.resolve(); return acceptance.promise } })
  await started.promise

  try {
    f.at(75_000)
    const next = f.result('tsk-after-delayed', { to: 'github:fixture/project:7' })
    assert.equal(next.state, 'held')
    assert.deepEqual(f.notifications.flush(), [])
    assert.equal(f.run('tsk-delayed').status, 'waiting')
  } finally {
    acceptance.resolve()
    await delivery
  }
  assert.equal(f.sent[0].to, 'github:fixture/project:7')
  assert.equal(f.sent[0].id, first.id)
  assert.equal(f.run('tsk-delayed').notification.acceptedAt, '2026-11-28T12:01:15.000Z')

  f.reopen()
  windowMs = 2_500
  f.at(75_499)
  const urgent = insertOutbox(f.store, {
    kind: 'reply', state: 'recorded', to: 'github:fixture/project:7', body: 'Immediate user reply',
  }, () => START + 75_499)
  assert.deepEqual(f.notifications.flush(), [])
  await f.deliver({ channel: 'github' })
  assert.equal(f.sent.at(-1).id, urgent.id)
  assert.equal(f.run('tsk-after-delayed').status, 'waiting')
  f.at(75_500)
  const [next] = f.notifications.flush()
  await f.deliver({ channel: 'github' })
  assert.equal(f.sent.at(-1).id, next.id)
  assert.equal(f.run('tsk-after-delayed').notification.acceptedAt, '2026-11-28T12:01:15.500Z')

  f.at(75_501)
  f.result('tsk-next-window', { to: 'github:fixture/project:7' })
  f.at(77_999)
  assert.deepEqual(f.notifications.flush(), [])
  f.at(78_000)
  assert.equal(f.notifications.flush().length, 1, 'the new setting applies to the next window')
})

test('a digest with one distinct task carries its latest result, task ID and exact detail reference', async t => {
  const f = fixture(t)
  f.result('tsk-first')
  await f.deliver()
  f.at(10)
  f.result('tsk-updated', { body: 'first summary' })
  f.result('tsk-updated', { body: 'revised summary', reportId: 'report-revised' })
  f.at(60_000)
  const [digest] = f.notifications.flush()
  await f.deliver()
  const { body } = f.sent.at(-1)
  assert.ok(body.includes(digest.id))
  assert.match(body, /tsk-updated/)
  assert.match(body, /revised summary/)
  assert.doesNotMatch(body, /first summary/)
})

test('discarding a rejected publication leaves its exact index and every linked failure visible', async t => {
  const f = fixture(t)
  f.result('tsk-first')
  await f.deliver()
  f.at(1)
  const a = f.result('tsk-rejected-a')
  const b = f.result('tsk-rejected-b')
  f.at(60_000)
  const [digest] = f.notifications.flush()
  await f.deliver({ maxAttempts: 1, send() { throw new Error('channel declined') } })
  assert.equal(discardOutboxRows(f.store, [digest.id]), 1)
  f.reopen()
  assert.deepEqual(f.notifications.details(digest.id), { id: digest.id, tickets: [
    { ticketId: 'tsk-rejected-a', runId: 'run-tsk-rejected-a', sourceOutboxIds: [a.id] },
    { ticketId: 'tsk-rejected-b', runId: 'run-tsk-rejected-b', sourceOutboxIds: [b.id] },
  ] })
  const failures = f.runs.list({ status: 'failed' })
  assert.deepEqual(new Set(failures.map(run => run.ticketId)), new Set(['tsk-rejected-a', 'tsk-rejected-b']))
  for (const run of failures) {
    assert.equal(run.notification.id, digest.id)
    assert.equal(run.notification.channelAccepted, false)
    assert.equal(run.notification.discarded, true)
  }
})
