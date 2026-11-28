import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OwnerRegistry } from '../src/registry.js'
import { buildOwnerFacts, formatOwnerFacts } from '../src/owner-facts.js'
import { OwnerSwitch } from '../src/owner-switch.js'
import { Router } from '../src/router.js'
import { TimerService } from '../src/timers.js'
import { insertOutbox } from '../src/outbox.js'

const NOW = '2026-11-28T12:00:00.000Z'
const OLD_SESSION = 'session-owner-old'

function latch() {
  let open
  const promise = new Promise(resolve => { open = resolve })
  return { promise, open }
}

function fixture(t, buildFactsOverride, recordProgress) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-owner-switch-'))
  const now = () => NOW
  let sequence = 0
  const ids = { uuid: () => String(++sequence) }
  const changes = []
  const effects = []
  const hosts = new Map([[OLD_SESSION, { state: 'busy', agentPreset: 'hub-bot-owner' }]])
  const switchSvc = {}
  const ports = {
    status: async ({ sessionId }) => hosts.get(sessionId)?.state ?? 'missing',
    isArchived: sessionId => hosts.get(sessionId)?.archived === true,
    create: async ({ owner, sessionId }) => {
      const agentPreset = owner.role === 'chief' ? 'hub-bot-router' : 'hub-bot-owner'
      if (!hosts.has(sessionId)) {
        effects.push(['create', owner.id, sessionId])
        hosts.set(sessionId, { state: 'idle', agentPreset })
      }
      return { sessionId, agentPreset: hosts.get(sessionId).agentPreset }
    },
    prompt: async ({ sessionId, requestId, text }) => {
      const host = hosts.get(sessionId)
      assert.ok(host)
      host.prompts ??= new Map()
      if (!host.prompts.has(requestId)) {
        effects.push(['prompt', sessionId, requestId])
        host.prompts.set(requestId, text)
      }
      return { accepted: true }
    },
    cancel: async ({ sessionId }) => {
      effects.push(['stop', sessionId])
      return { accepted: true }
    },
    archive: async ({ sessionId }) => {
      const host = hosts.get(sessionId)
      assert.ok(host)
      if (!host.archived) effects.push(['archive', sessionId])
      host.archived = true
    },
  }
  function reopen(withAdmission) {
    switchSvc.store?.close()
    const store = new Store(dir)
    const registry = new OwnerRegistry(store, { scratchRoot: join(dir, 'scratch'), now })
    const book = new OwnerSwitch({ store, registry, sessions: ports, now, ids, withAdmission,
      buildFacts: buildFactsOverride ?? (({ ownerId }) => formatOwnerFacts(buildOwnerFacts({ store, ownerId }))),
      recordChange: row => {
        recordProgress?.(store, row)
        changes.push(row.status)
      },
    })
    Object.assign(switchSvc, { store, registry, book })
  }
  t.after(() => {
    switchSvc.store?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  reopen()
  const owner = switchSvc.registry.create({ kind: 'repo', workspace: 'example', cwd: '/work/example' })
  switchSvc.registry.bindSession(owner.id, OLD_SESSION)
  return { switchSvc, ownerId: owner.id, ports, hosts, effects, changes, reopen }
}

test('a switch queues while busy, commits the initialized owner, then archives the exact old session', async t => {
  const { switchSvc: { book, registry }, ownerId, hosts, effects, changes } = fixture(t)
  const operation = book.request({ ownerId, expectedSessionId: OLD_SESSION, requestId: 'feishu-switch-1' })
  const read = () => book.get({ ownerId, operationId: operation.operationId })
  assert.equal(read().status, 'waiting')
  assert.equal(book.phaseFor(ownerId), 'waiting')
  assert.equal(book.isHeld(ownerId), true)
  await book.tick()
  assert.equal(registry.get(ownerId).sessionId, OLD_SESSION)
  assert.deepEqual(effects, [])

  hosts.get(OLD_SESSION).state = 'idle'
  await book.tick()
  assert.equal(read().status, 'committed')
  assert.equal(registry.get(ownerId).sessionId, operation.newSessionId)
  assert.equal(registry.findByCurrentSession(OLD_SESSION), undefined)
  assert.equal(registry.isOwnerSession(OLD_SESSION), true)
  assert.equal(book.isHeld(ownerId), false)
  assert.deepEqual(effects, [
    ['create', ownerId, operation.newSessionId],
    ['prompt', operation.newSessionId, operation.initializationRequestId],
  ])
  const text = hosts.get(operation.newSessionId).prompts.get(operation.initializationRequestId)
  assert.match(text, /负责人事实/)
  assert.match(text, /repo-example/)
  assert.ok(text.includes('/work/example'))

  await book.tick()
  assert.equal(read().status, 'completed')
  assert.equal(registry.get(ownerId).sessionId, operation.newSessionId)
  assert.deepEqual(effects.at(-1), ['archive', OLD_SESSION])
  assert.deepEqual(changes, ['waiting', 'preparing', 'committed', 'completed'])
})

test('an explicit stop waits for observed idle and is issued once across a reopen', async t => {
  const { switchSvc, ownerId, hosts, effects, reopen } = fixture(t)
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION, mode: 'stop' })
  const read = () => switchSvc.book.get({ ownerId, operationId: operation.operationId })
  await switchSvc.book.tick()
  assert.equal(read().status, 'waiting')
  assert.equal(read().stopRequestedAt, NOW)
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.deepEqual(effects, [['stop', OLD_SESSION]])

  reopen()
  await switchSvc.book.tick()
  assert.equal(read().status, 'waiting')
  assert.deepEqual(effects, [['stop', OLD_SESSION]])

  hosts.get(OLD_SESSION).state = 'idle'
  await switchSvc.book.tick()
  assert.equal(read().status, 'committed')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
  assert.deepEqual(effects.map(([effect]) => effect), ['stop', 'create', 'prompt'])
})

test('waiting cancellation releases ordinary delivery and invalidates a late idle observation', async t => {
  const { switchSvc, ownerId, ports, effects, reopen } = fixture(t)
  const statusRequested = latch()
  const statusResult = latch()
  ports.status = () => {
    statusRequested.open()
    return statusResult.promise
  }
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
  const address = { ownerId, operationId: operation.operationId }
  const pending = switchSvc.book.tick()
  await statusRequested.promise
  assert.throws(() => switchSvc.book.cancel({ ...address, ownerId: 'chief' }), { code: 'owner-switch-not-found' })
  assert.equal(switchSvc.book.cancel(address).status, 'cancelled')
  assert.equal(switchSvc.book.cancel(address).status, 'cancelled')
  assert.equal(switchSvc.book.isHeld(ownerId), false)
  statusResult.open('idle')
  await pending

  reopen()
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.get(address).status, 'cancelled')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.deepEqual(effects, [])
})

test('the same explicit request replays across commit and reopen without switching another target', async t => {
  const { switchSvc, ownerId, hosts, effects, reopen } = fixture(t)
  const request = { ownerId, expectedSessionId: OLD_SESSION, requestId: 'feishu-explicit-1' }
  const first = switchSvc.book.request(request)
  assert.deepEqual(switchSvc.book.request(request), first)
  assert.equal(switchSvc.book.request({ ...request, requestId: 'feishu-explicit-2' }).operationId, first.operationId)
  assert.throws(() => switchSvc.book.request({ ...request, mode: 'stop' }), { code: 'owner-switch-request-conflict' })
  assert.throws(() => switchSvc.book.request({ ...request, requestId: 'another', mode: 'stop' }),
    { code: 'owner-switch-in-progress' })
  assert.throws(() => switchSvc.book.request({ ...request, expectedSessionId: 'worker-session' }),
    { code: 'owner-switch-request-conflict' })

  hosts.get(OLD_SESSION).state = 'idle'
  await switchSvc.book.tick()
  await switchSvc.book.tick()
  reopen()

  const completed = switchSvc.book.get({ ownerId, operationId: first.operationId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.requestId, 'feishu-explicit-1')
  assert.deepEqual(switchSvc.book.request(request), completed)
  assert.deepEqual(switchSvc.book.request({ ...request, requestId: 'feishu-explicit-2' }), completed)
  assert.throws(() => switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION }), { code: 'stale-owner-binding' })
  const next = switchSvc.book.request({ ownerId, expectedSessionId: first.newSessionId })
  assert.deepEqual(switchSvc.book.list({ ownerId }).map(row => row.operationId), [next.operationId, first.operationId])
  assert.equal(switchSvc.book.get({ ownerId: 'chief', operationId: first.operationId }), undefined)
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt', 'archive'])
})

test('each preparation failure releases delivery and leaves the selected old owner bound', async t => {
  const failure = async () => { throw new Error('Host error with provider secret: synthetic-secret') }
  for (const [stage, reason] of [
    ['facts', '无法加载负责人事实清单。'],
    ['create', '无法创建新负责人会话。'],
    ['prompt', '无法向新负责人会话加载事实清单。'],
  ]) {
    await t.test(stage, async t => {
      const { switchSvc, ownerId, hosts, ports, effects, reopen } = fixture(t, stage === 'facts' ? failure : undefined)
      if (stage !== 'facts') ports[stage] = failure
      hosts.get(OLD_SESSION).state = 'idle'
      const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
      await switchSvc.book.tick()
      reopen()
      await switchSvc.book.tick()
      const result = switchSvc.book.get({ ownerId, operationId: operation.operationId })
      assert.equal(result.status, 'failed')
      assert.equal(result.errorCode, 'owner-switch-preparation-failed')
      assert.equal(result.reason, reason)
      assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
      assert.equal(switchSvc.registry.findByCurrentSession(operation.newSessionId), undefined)
      assert.equal(switchSvc.book.isHeld(ownerId), false)
      assert.deepEqual(effects.map(([effect]) => effect), stage === 'prompt' ? ['create'] : [])
    })
  }
})

test('archive failure keeps the new owner bound and retries only the captured old session', async t => {
  const { switchSvc, ownerId, ports, hosts, effects, reopen } = fixture(t)
  hosts.get(OLD_SESSION).state = 'idle'
  const archive = ports.archive
  const targets = []
  ports.archive = async request => {
    targets.push(request.sessionId)
    if (targets.length === 1) throw new Error('Archive backend credential: synthetic-secret')
    return archive(request)
  }
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
  const address = { ownerId, operationId: operation.operationId }
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.get(address).status, 'committed')
  assert.equal(switchSvc.book.isHeld(ownerId), false)
  reopen()
  await switchSvc.book.tick()
  const failed = switchSvc.book.get(address)
  assert.equal(failed.status, 'archive-failed')
  assert.equal(failed.errorCode, 'owner-switch-archive-failed')
  assert.equal(failed.reason, '无法归档原负责人会话。')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
  assert.equal(switchSvc.book.isHeld(ownerId), false)
  await switchSvc.book.tick()
  assert.deepEqual(targets, [OLD_SESSION])

  assert.throws(() => switchSvc.book.retryArchive({ ...address, ownerId: 'chief' }), { code: 'owner-switch-not-found' })
  assert.equal(switchSvc.book.retryArchive(address).status, 'committed')
  assert.equal(switchSvc.book.retryArchive(address).status, 'committed')
  reopen()
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.retryArchive(address).status, 'completed')
  assert.equal(switchSvc.book.get(address).reason, null)
  assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
  assert.deepEqual(targets, [OLD_SESSION, OLD_SESSION])
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt', 'archive'])
})

test('a loaded initialization survives another idle wait without rebuilding its facts', async t => {
  const snapshots = []
  const { switchSvc, ownerId, hosts, effects, reopen, ports } = fixture(t, args => {
    snapshots.push(args.ownerId)
    return 'Initial durable facts'
  })
  hosts.get(OLD_SESSION).state = 'idle'
  const originalPrompt = ports.prompt
  ports.prompt = async request => {
    const accepted = await originalPrompt(request)
    hosts.get(OLD_SESSION).state = 'busy'
    return accepted
  }
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
  const address = { ownerId, operationId: operation.operationId }
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.get(address).status, 'preparing')
  assert.equal(switchSvc.book.phaseFor(ownerId), 'preparing')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.throws(() => switchSvc.book.cancel(address), { code: 'owner-switch-not-waiting' })

  reopen()
  hosts.get(OLD_SESSION).state = 'idle'
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.get(address).status, 'committed')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
  assert.deepEqual(snapshots, [ownerId])
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt'])
})

test('a stale create response cannot initialize a session another owner acquired', async t => {
  const { switchSvc, ownerId, hosts, ports, effects } = fixture(t)
  hosts.get(OLD_SESSION).state = 'idle'
  const create = ports.create
  const created = latch()
  const release = latch()
  ports.create = async request => {
    const result = await create(request)
    created.open()
    await release.promise
    return result
  }
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
  const tick = switchSvc.book.tick()
  await created.promise
  switchSvc.registry.ensureChief({ cwd: '/work' })
  switchSvc.registry.bindSession('chief', operation.newSessionId)
  release.open()
  await tick

  const result = switchSvc.book.get({ ownerId, operationId: operation.operationId })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'owner-switch-id-conflict')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.equal(switchSvc.registry.get('chief').sessionId, operation.newSessionId)
  assert.deepEqual(effects.map(([effect]) => effect), ['create'])
})

test('the binding stays on the old owner if the initialized replacement becomes unavailable', async t => {
  const { switchSvc, ownerId, hosts, ports, effects } = fixture(t)
  hosts.get(OLD_SESSION).state = 'idle'
  const prompt = ports.prompt
  ports.prompt = async request => {
    const accepted = await prompt(request)
    hosts.delete(request.sessionId)
    return accepted
  }
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
  await switchSvc.book.tick()
  const result = switchSvc.book.get({ ownerId, operationId: operation.operationId })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'new-session-unavailable')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.equal(switchSvc.book.isHeld(ownerId), false)
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt'])
})

test('reopen reuses exact host IDs after a side effect lands before its SQLite checkpoint', async t => {
  for (const phase of ['create', 'prompt', 'archive']) {
    await t.test(phase, async t => {
      const { switchSvc, ownerId, hosts, ports, effects, reopen } = fixture(t)
      hosts.get(OLD_SESSION).state = 'idle'
      const base = ports[phase]
      const firstEffect = latch()
      const lateResult = latch()
      const calls = []
      ports[phase] = async request => {
        const result = await base(request)
        calls.push(request)
        if (calls.length === 1) {
          firstEffect.open()
          await lateResult.promise
        }
        return result
      }
      const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION, requestId: 'reopen-' + phase })
      const address = { ownerId, operationId: operation.operationId }
      if (phase === 'archive') await switchSvc.book.tick()
      const interrupted = switchSvc.book.tick()
      await firstEffect.promise
      try {
        assert.equal(switchSvc.book.get(address).status, phase === 'archive' ? 'committed' : 'preparing')
        assert.equal(switchSvc.registry.get(ownerId).sessionId, phase === 'archive' ? operation.newSessionId : OLD_SESSION)
        reopen()
        await switchSvc.book.tick()
        await switchSvc.book.tick()
      } finally {
        lateResult.open()
        await interrupted
      }
      assert.equal(switchSvc.book.get(address).status, 'completed')
      assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[1], calls[0])
      assert.deepEqual(effects, [
        ['create', ownerId, operation.newSessionId],
        ['prompt', operation.newSessionId, operation.initializationRequestId],
        ['archive', OLD_SESSION],
      ])
    })
  }
})

test('held owner input follows the new binding while recurring timer work keeps its live L3', async t => {
  const { switchSvc, ownerId, hosts, ports, effects, reopen } = fixture(t)
  let router
  reopen((id, work) => router.withOwnerAdmission(id, work))
  const { book, store, registry } = switchSvc
  let now = Date.parse(NOW)
  const clock = () => new Date(now).toISOString()
  router = new Router({ store, registry, now: clock, sessions: {
    create: async ({ sessionId }) => {
      effects.push(['create-worker', sessionId])
      const agentPreset = 'fixture-worker'
      hosts.set(sessionId, { state: 'busy', agentPreset })
      return { sessionId, agentPreset }
    },
    prompt: ports.prompt,
    isArchived: sessionId => hosts.get(sessionId)?.archived === true,
    isRunning: async sessionId => hosts.get(sessionId)?.state === 'busy',
  } })
  router.ownerSwitch = book
  const timers = new TimerService({ store, now: clock,
    getOwner: id => registry.get(id), getTicket: id => router.getTicket(id),
    routeBackground: request => router.routeBackground(request),
  })
  router.timerDeliveryState = (timerId, request) => timers.deliveryState(timerId, request)
  const timer = timers.create({ ownerId, createdBy: 'human', message: 'Check the result',
    schedule: { frequency: 'daily', time: '20:01' },
  })
  now = Date.parse(timer.fireAt)
  await timers.tick()
  const first = timers.get(timer.id).delivery
  assert.equal(first.state, 'sent')
  const worker = first.workerSession.sessionId
  const ticket = router.getTicket(first.ticketId)
  assert.notEqual(worker, OLD_SESSION)
  assert.equal(ticket.owner, ownerId)
  assert.equal(hosts.get(worker).state, 'busy')

  const operation = book.request({ ownerId, expectedSessionId: OLD_SESSION, mode: 'stop' })
  const queued = await router.routeToOwner({ ownerId, message: 'Deliver after handover' })
  await book.tick()
  assert.deepEqual(effects.filter(([effect]) => effect === 'stop'), [['stop', OLD_SESSION]])
  assert.equal(effects.some(([effect, , id]) => effect === 'prompt' && id === queued.requestId), false)
  hosts.get(OLD_SESSION).state = 'idle'
  await book.tick()
  now += 1000
  await router.tick()
  assert.ok(hosts.get(operation.newSessionId).prompts.get(queued.requestId).includes('Deliver after handover'))
  await book.tick()
  assert.deepEqual(effects.filter(([effect]) => effect === 'archive'), [['archive', OLD_SESSION]])
  assert.equal(hosts.get(worker).state, 'busy')
  assert.equal(router.getTicket(first.ticketId).workerSession.sessionId, worker)
  assert.deepEqual(router.getTicket(first.ticketId).authorization, ticket.authorization)

  await router.reportBackground({ ticketId: first.ticketId, sessionId: worker, silenceReason: 'no-change' })
  now = Date.parse(timers.get(timer.id).fireAt)
  await timers.tick()
  const second = timers.get(timer.id).delivery
  assert.equal(second.state, 'sent')
  assert.equal(second.workerSession.sessionId, worker)
  assert.equal(router.getTicket(second.ticketId).owner, ownerId)
  assert.equal(effects.filter(([effect]) => effect === 'create-worker').length, 1)
})

test('a pre-existing execution session cannot be claimed as the replacement', async t => {
  const { switchSvc, ownerId, hosts, ports, effects } = fixture(t)
  hosts.get(OLD_SESSION).state = 'idle'
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION })
  hosts.set(operation.newSessionId, { state: 'idle', agentPreset: 'fixture-worker' })
  const create = ports.create
  ports.create = request => {
    // The installed host may replace the preset when it reuses a blank requested session.
    hosts.get(request.sessionId).agentPreset = 'hub-bot-owner'
    return create(request)
  }
  await switchSvc.book.tick()
  const result = switchSvc.book.get({ ownerId, operationId: operation.operationId })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'owner-switch-id-conflict')
  assert.equal(hosts.get(operation.newSessionId).agentPreset, 'fixture-worker')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.deepEqual(effects, [])
})

function recordSwitchProgress(store, operation) {
  const id = 'out-' + operation.operationId + '-' + operation.status
  insertOutbox(store, { id, requestId: id, kind: 'reply', state: 'recorded', to: 'feishu:chat:fixture',
    body: operation.status,
  }, () => Date.parse(NOW))
}

function rejectProgressInsert(store, phase) {
  store.db.exec(`
    CREATE TEMP TRIGGER reject_switch_progress BEFORE INSERT ON outbox
    WHEN json_extract(NEW.value, '$.body') = '${phase}'
    BEGIN SELECT RAISE(ABORT, 'fixture outbox insertion failed'); END;
  `)
}

test('request and progress rows roll back together if the outbox insert fails', t => {
  const { switchSvc: { book, registry, store }, ownerId } = fixture(t, undefined, recordSwitchProgress)
  const request = { ownerId, expectedSessionId: OLD_SESSION, requestId: 'feishu-record-request' }
  rejectProgressInsert(store, 'waiting')
  // Feishu invokes the switch from its own transaction. The caller can keep its unrelated writes.
  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.set('fixture-intake-received', true)
    assert.throws(() => book.request(request), /record owner switch progress/i)
    assert.equal(book.isHeld(ownerId), false)
    assert.deepEqual(book.list({ ownerId }), [])
    store.db.exec('COMMIT')
  } finally {
    if (store.db.isTransaction) store.db.exec('ROLLBACK')
  }
  assert.equal(registry.get(ownerId).sessionId, OLD_SESSION)
  assert.equal(store.get('fixture-intake-received'), true)
  store.db.exec('DROP TRIGGER reject_switch_progress')
  const operation = book.request(request)
  assert.deepEqual(book.request(request), operation)
  assert.equal(operation.status, 'waiting')
  const router = new Router({ store, registry })
  assert.deepEqual(router.listOutbox().map(row => row.body), ['waiting'])
})

test('progress insert failure preserves the prepared or committed phase for restart', async t => {
  const { switchSvc, ownerId, hosts, ports, effects, reopen } = fixture(t, undefined, recordSwitchProgress)
  const progress = () => new Router({ store: switchSvc.store, registry: switchSvc.registry, sessions: ports })
    .listOutbox().map(row => row.body)
  hosts.get(OLD_SESSION).state = 'idle'
  const operation = switchSvc.book.request({ ownerId, expectedSessionId: OLD_SESSION, requestId: 'feishu-record-progress' })
  const address = { ownerId, operationId: operation.operationId }
  rejectProgressInsert(switchSvc.store, 'committed')
  await assert.rejects(switchSvc.book.tick(), /record owner switch progress/i)
  assert.equal(switchSvc.book.get(address).status, 'preparing')
  assert.equal(switchSvc.book.isHeld(ownerId), true)
  assert.equal(switchSvc.registry.get(ownerId).sessionId, OLD_SESSION)
  assert.deepEqual(progress(), ['waiting', 'preparing'])

  reopen()
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.get(address).status, 'committed')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
  rejectProgressInsert(switchSvc.store, 'completed')
  await assert.rejects(switchSvc.book.tick(), /record owner switch progress/i)
  assert.equal(switchSvc.book.get(address).status, 'committed')
  assert.equal(switchSvc.registry.get(ownerId).sessionId, operation.newSessionId)
  assert.equal(hosts.get(OLD_SESSION).archived, true)
  assert.deepEqual(progress(), ['waiting', 'preparing', 'committed'])

  reopen()
  await switchSvc.book.tick()
  assert.equal(switchSvc.book.get(address).status, 'completed')
  assert.deepEqual(progress(), ['waiting', 'preparing', 'committed', 'completed'])
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt', 'archive'])
})

test('a replacement archived during the final idle check never becomes current', async t => {
  const { switchSvc: { book, registry }, ownerId, ports, hosts, effects } = fixture(t)
  hosts.get(OLD_SESSION).state = 'idle'
  const operation = book.request({ ownerId, expectedSessionId: OLD_SESSION })
  const readingOld = latch()
  const allowOldRead = latch()
  const status = ports.status
  ports.status = async request => {
    const result = await status(request)
    if (request.sessionId === OLD_SESSION && hosts.get(operation.newSessionId)?.prompts?.size) {
      readingOld.open()
      await allowOldRead.promise
    }
    return result
  }
  const switched = book.tick()
  await readingOld.promise
  hosts.get(operation.newSessionId).archived = true
  allowOldRead.open()
  await switched

  const result = book.get({ ownerId, operationId: operation.operationId })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'new-session-archived')
  assert.equal(registry.get(ownerId).sessionId, OLD_SESSION)
  assert.equal(book.isHeld(ownerId), false)
  await book.tick()
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt'])
})

test('accepted facts keep ordinary work held until the replacement finishes initializing', async t => {
  const { switchSvc, ownerId, hosts, ports, effects, reopen } = fixture(t)
  let router
  reopen((id, work) => router.withOwnerAdmission(id, work))
  const { book, store, registry } = switchSvc
  let now = Date.parse(NOW)
  router = new Router({ store, registry, now: () => new Date(now).toISOString(), sessions: { prompt: ports.prompt } })
  router.ownerSwitch = book
  hosts.get(OLD_SESSION).state = 'idle'
  const operation = book.request({ ownerId, expectedSessionId: OLD_SESSION })
  const address = { ownerId, operationId: operation.operationId }
  const admit = ports.prompt
  ports.prompt = async request => {
    const result = await admit(request)
    hosts.get(request.sessionId).state = 'busy'
    return result
  }
  const queued = await router.routeToOwner({ ownerId, message: 'Work after initialization' })
  await book.tick()
  assert.equal(book.get(address).status, 'preparing')
  assert.equal(book.isHeld(ownerId), true)
  assert.equal(registry.get(ownerId).sessionId, OLD_SESSION)
  assert.ok(hosts.get(operation.newSessionId).prompts.has(operation.initializationRequestId))
  now += 1000
  await router.tick()
  await book.tick()
  assert.equal(book.get(address).status, 'preparing')
  assert.deepEqual(effects.map(([effect]) => effect), ['create', 'prompt'])

  hosts.get(operation.newSessionId).state = 'idle'
  await book.tick()
  assert.equal(book.get(address).status, 'committed')
  assert.equal(book.isHeld(ownerId), false)
  assert.equal(registry.get(ownerId).sessionId, operation.newSessionId)
  now += 1000
  await router.tick()
  assert.ok(hosts.get(operation.newSessionId).prompts.get(queued.requestId).includes('Work after initialization'))
  await book.tick()
  assert.equal(book.get(address).status, 'completed')
  assert.deepEqual(effects.at(-1), ['archive', OLD_SESSION])
})
