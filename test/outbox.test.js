/**
 * OutboxRunner tests (#66「可靠性 Stored work」): every outward action is STORED before it is attempted;
 * delivery is strictly ordered per ticket (the head blocks the tail until sent or failed 3 times, then it is
 * bypassed and a system problem is reported); failures retry after 2s with exponential backoff (reply cap
 * 1 min, inject cap 5 min); retries reuse the row's stable requestId; rows survive a runner restart. RED first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { OutboxRunner, retryOutboxRows, discardOutboxRows, insertOutbox } from '../src/outbox.js'

function fixture(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  let clock = 1_000_000
  const calls = []
  const plan = opts.plan ?? (() => true) // (row, attempt) => true=ok, false=throw
  const deliver = async (row) => {
    calls.push({ id: row.id, requestId: row.requestId, kind: row.kind, stored: store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id) !== undefined })
    if (!plan(row, calls.filter(c => c.id === row.id).length)) throw new Error('delivery failed (fake)')
  }
  const runner = new OutboxRunner({ store, deliver, now: () => clock })
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, runner, calls, cleanup, setClock: (ms) => { clock = ms }, getClock: () => clock }
}

test('store-before-act: the row is queued in the store before the deliverer runs', async () => {
  const { runner, calls, cleanup } = fixture()
  try {
    const row = runner.enqueue({ ticketId: 'tsk-1', kind: 'inject', to: 'session-x', body: 'hello', requestId: 'req-1' })
    assert.equal(row.state, 'queued')
    await runner.tick()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].stored, true, 'deliverer observed the stored row')
  } finally { cleanup() }
})



test('a deliverer may postpone a row without burning an attempt (wake coalescing waits for idle)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  let clock = 1_000_000
  let mode = 'postpone'
  const calls = []
  const deliver = async (row) => { calls.push(row.id); if (mode === 'postpone') return { postponeMs: 2000 } }
  const runner = new OutboxRunner({ store, deliver, now: () => clock })
  try {
    const row = runner.enqueue({ ticketId: null, kind: 'digest', to: 'dsh:session:chief', body: 'x', requestId: 'r' })
    await runner.tick()
    assert.equal(calls.length, 1)
    let stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.state, 'queued')
    assert.equal(stored.attempts, 0, 'postponement is not a failure')
    assert.equal(stored.nextRetryAt, clock + 2000)
    await runner.tick()
    assert.equal(calls.length, 1, 'not due yet')
    clock += 2000
    mode = 'ok'
    await runner.tick()
    assert.equal(calls.length, 2)
    stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.state, 'sent')
    assert.equal(stored.attempts, 0)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('success marks the row sent; retries reuse the stable requestId', async () => {
  const { store, runner, calls, setClock, getClock, cleanup } = fixture({ plan: (row, attempt) => attempt >= 2 })
  try {
    const row = runner.enqueue({ ticketId: 'tsk-1', kind: 'inject', to: 'session-x', body: 'hi', requestId: 'req-stable' })
    await runner.tick()
    assert.equal(calls.length, 1, 'first attempt failed')
    let stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.attempts, 1)
    assert.equal(stored.lastError, 'delivery failed (fake)')
    assert.equal(stored.state, 'queued')
    assert.equal(stored.nextRetryAt, getClock() + 2000, '2s first backoff')
    setClock(getClock() + 1999)
    await runner.tick()
    assert.equal(calls.length, 1, 'not due yet')
    setClock(getClock() + 1)
    await runner.tick()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].requestId, 'req-stable', 'retry reuses the stored requestId (幂等键稳定)')
    stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.state, 'sent')
    assert.ok(stored.sentAt)
  } finally { cleanup() }
})

test('backoff doubles and caps: inject 5 min, reply 1 min', async () => {
  const { store, runner, setClock, getClock, cleanup } = fixture({ plan: () => false })
  try {
    const injectRow = runner.enqueue({ ticketId: 'tsk-i', kind: 'inject', to: 's', body: 'x', requestId: 'r-i' })
    const replyRow = runner.enqueue({ ticketId: 'tsk-r', kind: 'reply', to: 'dsh', body: 'x', requestId: 'r-r' })
    await runner.tick() // attempt 1 both
    const read = (id) => JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(id).value))
    assert.equal(read(injectRow.id).nextRetryAt - getClock(), 2000)
    assert.equal(read(replyRow.id).nextRetryAt - getClock(), 2000)
    setClock(getClock() + 2000); await runner.tick() // attempt 2
    assert.equal(read(injectRow.id).nextRetryAt - getClock(), 4000)
    assert.equal(read(replyRow.id).nextRetryAt - getClock(), 4000)
    setClock(getClock() + 4000); await runner.tick() // attempt 3 → both fail permanently
    assert.equal(read(injectRow.id).state, 'failed')
    assert.equal(read(replyRow.id).state, 'failed')
    // Caps: a fresh pair failing deep into the schedule caps at 5min / 1min
    const capInject = runner.enqueue({ ticketId: 'tsk-ci', kind: 'inject', to: 's', body: 'x', requestId: 'r-ci' })
    const capReply = runner.enqueue({ ticketId: 'tsk-cr', kind: 'reply', to: 'dsh', body: 'x', requestId: 'r-cr' })
    for (let i = 0; i < 9; i++) { await runner.tick(); setClock(getClock() + 600000) }
    assert.ok(read(capInject.id).nextRetryAt - (getClock() - 600000) <= 300000, 'inject capped at 5 min')
    assert.ok(read(capReply.id).nextRetryAt - (getClock() - 600000) <= 60000, 'reply capped at 1 min')
  } finally { cleanup() }
})

test('three consecutive failures mark the row failed and report a system problem; the queue then bypasses it', async () => {
  let systemProblems = []
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  try {
    let clock = 1_000_000
    const runner = new OutboxRunner({
      store, now: () => clock,
      deliver: async (row) => { if (row.requestId === 'req-doomed') throw new Error('down') },
      onSystemProblem: (p) => systemProblems.push(p),
    })
    runner.enqueue({ ticketId: 'tsk-1', kind: 'inject', to: 's', body: 'first', requestId: 'req-doomed' })
    runner.enqueue({ ticketId: 'tsk-1', kind: 'inject', to: 's', body: 'second', requestId: 'req-ok' })
    await runner.tick(); clock += 2000
    await runner.tick(); clock += 4000
    assert.equal(systemProblems.length, 0, 'two failures do not escalate yet (一次性错误不惊动人)')
    await runner.tick() // third failure
    assert.equal(systemProblems.length, 1)
    assert.equal(systemProblems[0].ticketId, 'tsk-1')
    const rows = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value)))
    assert.equal(rows.find(r => r.requestId === 'req-doomed').state, 'failed')
    assert.equal(rows.find(r => r.requestId === 'req-doomed').lastError, 'down')
    assert.equal(rows.find(r => r.requestId === 'req-ok').state, 'sent', 'the tail row was bypassed to after the 3rd failure')
    assert.ok(rows.some(r => r.kind === 'system-problem'), 'system problem recorded in the outbox')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('strict per-ticket ordering: a pending head blocks the tail; other tickets run independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  try {
    let clock = 1_000_000
    const order = []
    const runner = new OutboxRunner({
      store, now: () => clock,
      deliver: async (row) => { order.push(row.requestId); if (row.requestId === 'a1' && order.filter(x => x === 'a1').length === 1) throw new Error('once') },
    })
    runner.enqueue({ ticketId: 'A', kind: 'inject', to: 's', body: '1', requestId: 'a1' })
    runner.enqueue({ ticketId: 'A', kind: 'inject', to: 's', body: '2', requestId: 'a2' })
    runner.enqueue({ ticketId: 'B', kind: 'inject', to: 's', body: '1', requestId: 'b1' })
    await runner.tick()
    assert.deepEqual(order, ['a1', 'b1'], 'a2 waited behind the failed a1; ticket B unaffected')
    clock += 2000
    await runner.tick()
    assert.deepEqual(order, ['a1', 'b1', 'a1', 'a2'], 'a1 retried first, then a2 (确认永远先于结果)')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('crash recovery: a fresh runner over the same store resumes queued rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  try {
    let clock = 1_000_000
    const down = async () => { throw new Error('crash before delivery') }
    const first = new OutboxRunner({ store, deliver: down, now: () => clock })
    const row = first.enqueue({ ticketId: 'tsk-1', kind: 'inject', to: 's', body: 'survive me', requestId: 'req-crash' })
    // process "crashes" before any tick
    const delivered = []
    const second = new OutboxRunner({ store, deliver: async (r) => { delivered.push(r.requestId) }, now: () => clock })
    await second.tick()
    assert.deepEqual(delivered, ['req-crash'], 'the stored row was delivered after the restart')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('legacy recorded rows (pre-#66) are left untouched by the runner', async () => {
  const { store, runner, calls, cleanup } = fixture()
  try {
    store.db.prepare('INSERT INTO outbox (id, value, at) VALUES (?, ?, ?)').run('out-legacy', JSON.stringify({ id: 'out-legacy', to: 'dsh', body: 'old', state: 'recorded', attempts: 0, at: 'x' }), 'x')
    await runner.tick()
    assert.equal(calls.length, 0)
    assert.equal(JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get('out-legacy').value)).state, 'recorded')
  } finally { cleanup() }
})

test('a permanent failure fails out immediately (no retries) and reports a system problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  try {
    const problems = []
    let calls = 0
    const runner = new OutboxRunner({
      store, now: () => 1_000_000, onSystemProblem: (p) => problems.push(p),
      deliver: async () => { calls++; const e = new Error('authorization missing'); e.permanent = true; throw e },
    })
    const row = runner.enqueue({ ticketId: 'tsk-p', kind: 'inject', to: 's', body: 'x', requestId: 'req-p' })
    await runner.tick()
    assert.equal(calls, 1, 'exactly one attempt — no retries for permanent failures')
    const stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.state, 'failed')
    assert.equal(problems.length, 1)
    assert.equal(problems[0].ticketId, 'tsk-p')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a deliverer may RECORD an undelivered intent (不假装发了飞书): terminal recorded, never retried, no problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  try {
    const runner = new OutboxRunner({ store, deliver: async () => ({ recorded: true }) })
    const row = runner.enqueue({ ticketId: null, kind: 'reply', to: 'feishu:om_9', body: 'x', requestId: 'r' })
    await runner.tick()
    const stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.state, 'recorded', 'honest: not sent')
    assert.equal(stored.attempts, 0)
    assert.ok(stored.recordedAt)
    await runner.tick()
    const again = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(again.state, 'recorded', 'recorded rows are not delivery work — a future channel scans them')
    const problems = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value))).filter(r => r.kind === 'system-problem')
    assert.equal(problems.length, 0, 'an honest record is not a failure')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('insertOutbox requires state: a row without delivery state is a dead letter (双轴审查 P1-1)', async () => {
  const { insertOutbox } = await import('../src/outbox.js')
  const { store, cleanup } = fixture()
  try {
    assert.throws(() => insertOutbox(store, { kind: 'reply', to: 'dsh', body: 'x' }), /state-required/, '缺 state 直接抛，堵住死信再现')
    const row = insertOutbox(store, { kind: 'reply', to: 'dsh:session:chief', body: 'x', state: 'queued' })
    assert.equal(row.state, 'queued')
  } finally { cleanup() }
})

/**
 * #74 P1-A: the 1s delivery tick does not await the previous pass, and a real channel send (gh api /
 * feishu im) routinely outlasts one second — an overlapping pass used to re-scan the same 'recorded' rows
 * and re-send them (live evidence: issue Ghost233/DSH-Workflow#76 received two identical ack comments one
 * second apart from a single outbox row). The pass must be non-reentrant per channel. RED first.
 */
function recordedReplyFixture(send) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-replies-'))
  const store = new Store(dir)
  let clock = 1_000_000
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }) }
  return { store, cleanup, getClock: () => clock, send }
}

test('#74 P1-A: overlapping deliverRecordedReplies passes never double-send one recorded row', async () => {
  const { insertOutbox, deliverRecordedReplies } = await import('../src/outbox.js')
  let sends = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fx = recordedReplyFixture(async () => { sends++; await gate })
  try {
    insertOutbox(fx.store, { ticketId: null, kind: 'reply', to: 'github:Ghost233/DSH-Workflow:76', body: 'ack', state: 'recorded' }, fx.getClock)
    const args = {
      store: fx.store, logger: { warn() {} }, now: fx.getClock,
      channel: 'github', prefix: 'github:', maxAttempts: 5,
      parseTarget: () => ({ repo: 'Ghost233/DSH-Workflow', number: 76 }),
      send: fx.send,
    }
    const p1 = deliverRecordedReplies(args)
    await new Promise(resolve => setImmediate(resolve)) // let pass 1 reach the in-send wait
    const p2 = deliverRecordedReplies(args) // the next 1s tick, while pass 1 is still sending
    release()
    const [first, second] = await Promise.all([p1, p2])
    assert.equal(second.delivered, 0)
    assert.equal(second.skipped, 'in-flight', 'overlapping pass is refused instead of re-sending')
    assert.equal(first.delivered, 1)
    assert.equal(sends, 1, 'one recorded row is sent exactly once across overlapping ticks')
    const stored = JSON.parse(String(fx.store.db.prepare('SELECT value FROM outbox').all()[0].value))
    assert.equal(stored.state, 'sent')
  } finally { fx.cleanup() }
})

test('#74 P1-A: the guard is per channel — another channel proceeds while one is mid-send', async () => {
  const { insertOutbox, deliverRecordedReplies } = await import('../src/outbox.js')
  let sends = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fx = recordedReplyFixture(async () => { sends++; await gate })
  try {
    insertOutbox(fx.store, { ticketId: null, kind: 'reply', to: 'github:Ghost233/DSH-Workflow:76', body: 'ack', state: 'recorded' }, fx.getClock)
    const base = {
      store: fx.store, logger: { warn() {} }, now: fx.getClock,
      channel: 'github', prefix: 'github:', maxAttempts: 5,
      parseTarget: () => ({ repo: 'Ghost233/DSH-Workflow', number: 76 }),
      send: fx.send,
    }
    const p1 = deliverRecordedReplies(base)
    await new Promise(resolve => setImmediate(resolve))
    const pOther = deliverRecordedReplies({ ...base, channel: 'feishu', prefix: 'feishu:', parseTarget: () => null, send: async () => {} })
    release()
    const [, other] = await Promise.all([p1, pOther])
    assert.notEqual(other.skipped, 'in-flight', 'a different channel is not blocked')
    assert.equal(sends, 1)
  } finally { fx.cleanup() }
})


test('retryOutboxRows: failed rows return to their origin channel with attempts cleared (turn 110)', async () => {
  const { store, cleanup } = fixture()
  try {
    insertOutbox(store, { ticketId: 't1', kind: 'reply', to: 'feishu:chat:x', body: 'a', state: 'queued' })
    insertOutbox(store, { ticketId: 't1', kind: 'reply', to: 'feishu:chat:x', body: 'b', state: 'recorded' })
    const rows = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value)))
    // 手工推成 failed（模拟 maxAttempts 耗尽）
    for (const row of rows) {
      store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(
        JSON.stringify({ ...row, state: 'failed', originState: row.state, attempts: 3, lastError: 'boom', nextRetryAt: 999 }), row.id)
    }
    const retried = retryOutboxRows(store, null)
    assert.equal(retried, 2)
    const after = store.db.prepare('SELECT value FROM outbox').all().map(r => JSON.parse(String(r.value)))
    assert.deepEqual(after.map(r => r.state).sort(), ['queued', 'recorded'], '各回原通道')
    for (const row of after) {
      assert.equal(row.attempts, 0)
      assert.equal(row.nextRetryAt, null)
      assert.equal(row.lastError, null)
      assert.equal(row.originState, undefined, 'originState 用完即弃')
    }
  } finally { cleanup() }
})

test('retryOutboxRows: targeted retry only touches the named row; legacy failed rows fall back to queued', async () => {
  const { store, cleanup } = fixture()
  try {
    insertOutbox(store, { ticketId: 't1', kind: 'reply', to: 'a', body: '1', state: 'queued' })
    insertOutbox(store, { ticketId: 't1', kind: 'reply', to: 'b', body: '2', state: 'queued' })
    const rows = store.db.prepare('SELECT id, value FROM outbox').all().map(r => ({ id: r.id, ...JSON.parse(String(r.value)) }))
    for (const row of rows) {
      // 旧格式死信: 无 originState
      store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(
        JSON.stringify({ ...row, state: 'failed', attempts: 3, lastError: 'x' }), row.id)
    }
    const retried = retryOutboxRows(store, [rows[0].id])
    assert.equal(retried, 1)
    const after = store.db.prepare('SELECT id, value FROM outbox').all().map(r => ({ id: r.id, ...JSON.parse(String(r.value)) }))
    const first = after.find(r => r.id === rows[0].id)
    const second = after.find(r => r.id === rows[1].id)
    assert.equal(first.state, 'queued', '旧死信回落 queued')
    assert.equal(second.state, 'failed', '未点名的不动')
  } finally { cleanup() }
})

test('discardOutboxRows removes only failed rows and returns the count (round 41)', () => {
  const { store, cleanup } = fixture()
  try {
    const rows = [
      insertOutbox(store, { state: 'queued', kind: 'reply', to: 'a', text: 'x' }),
      insertOutbox(store, { state: 'recorded', kind: 'reply', to: 'a', text: 'y' }),
      insertOutbox(store, { state: 'queued', kind: 'reply', to: 'b', text: 'z' }),
    ]
    for (const row of [rows[0], rows[1]]) {
      store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(
        JSON.stringify({ ...row, state: 'failed', attempts: 3, lastError: 'x' }), row.id)
    }
    // 单条：点名哪条删哪条，另一条死信与活行都保留
    assert.equal(discardOutboxRows(store, [rows[0].id]), 1)
    let after = store.db.prepare('SELECT id, value FROM outbox').all().map(r => ({ id: r.id, ...JSON.parse(String(r.value)) }))
    assert.deepEqual(after.map(r => r.id).sort(), [rows[1].id, rows[2].id].sort())
    assert.equal(after.find(r => r.id === rows[2].id).state, 'queued', '活行绝不被误删')
    // 全部：剩余死信清空
    assert.equal(discardOutboxRows(store, null), 1)
    after = store.db.prepare('SELECT id FROM outbox').all()
    assert.deepEqual(after.map(r => r.id), [rows[2].id])
    // 不存在/非 failed 的 id → 0
    assert.equal(discardOutboxRows(store, ['out-missing', rows[2].id]), 0)
  } finally { cleanup() }
})

/**
 * S01 (#32 stage01-reliability) 重叠 tick 不得重复投递同一行 / an overlapping tick must not re-enter the
 * deliverer for the same row: the 1s OutboxRunner tick is not awaited by its caller, and a real delivery
 * (gh api / feishu im / a DSH inject) routinely outlasts one tick. While that first delivery is still in
 * flight the row is still state 'queued' in the store — the row only flips to 'sent' after the deliverer
 * returns — so the next overlapping tick re-scans it and enters the deliverer a SECOND time for the same
 * row. One queued row must be delivered exactly once across overlapping ticks. Deferred promise only:
 * no timers, and the gate is released BEFORE any assertion so a red run fails on the count, never hangs.
 */
test('S01 regression: an overlapping tick never re-enters the deliverer for the same queued row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  try {
    const entries = []
    let releaseDelivery
    const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve })
    const deliver = async (row) => {
      entries.push(row.id)
      await deliveryGate // 第一次投递一直挂着——模拟真实发送慢于一个 tick 间隔
    }
    const runner = new OutboxRunner({ store, deliver, now: () => 1_000_000 })
    const row = runner.enqueue({ ticketId: 'tsk-s01', kind: 'inject', to: 'session-x', body: 'once only', requestId: 'req-s01' })
    const firstTick = runner.tick() // 不 await：第一轮投递还在飞
    await Promise.resolve() // 一个微任务冲刷，确保第一轮已进入投递器
    assert.equal(entries.length, 1, '第一轮 tick 已经进入投递器（前置条件）')
    const secondTick = runner.tick() // 重叠 tick：此时该行在 store 里仍是 state 'queued'
    releaseDelivery() // 先放行再断言：红灯只会挂在计数上，绝不会卡死
    await Promise.all([firstTick, secondTick])
    assert.equal(entries.length, 1, '同一 queued 行在重叠 tick 下只投递一次（不得重复送达）')
    const stored = JSON.parse(String(store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(row.id).value))
    assert.equal(stored.state, 'sent', '投递成功后该行落为 sent')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

/* ----------------------------------------------------------------------------------------------------------
 * S07 同聊天合并 (issue #38) — 认领时只合并「同一 owner、同一聊天、连续、到期、仍待投递」的 inbox 前缀。
 * 不同聊天、stop 车道、独立后台工作、未到期的行、以及认领之后才到达的行一律不并入；成员表在调用传输层
 * 之前用一次 outbox 写冻结在队头上，之后的重试 / 推迟 / 重启都逐字重放那一份，绝不重新推导。
 * 这里的聊天身份来自「原始来源事实」（trigger.value.source.chatId）——就是 router 准入时写下的那条授权，
 * 不另抄一份到 outbox 行上（抄一份就会和它描述的那条授权各自漂移）。
 * ------------------------------------------------------------------------------------------------------- */

/** The ORIGINAL source fact: the runner reads chat identity from here, never from a duplicated row field. */
function seedFeishuTrigger(store, { triggerId, chatId, messageId, at }) {
  const trigger = {
    id: triggerId,
    source: { chatId, messageId, addressing: 'direct' },
    message: 'm-' + messageId,
    authorization: { actor: 'ou_fixture', at },
  }
  store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(triggerId, JSON.stringify(trigger), at)
  return trigger
}

/** One Feishu intake row using the router's own id/requestId convention (acceptFeishuTrigger). */
function enqueueFeishuIntake(runner, store, { chatId, messageId, at }) {
  const triggerId = 'trg-' + messageId
  seedFeishuTrigger(store, { triggerId, chatId, messageId, at })
  return runner.enqueue({
    id: 'out-inbox-' + triggerId, ticketId: null, triggerId, kind: 'inbox', to: 'owner:chief',
    body: 'msg ' + messageId, requestId: 'hub-bot-feishu-' + messageId,
  })
}

function readOutbox(store) {
  return store.db.prepare('SELECT value FROM outbox ORDER BY at, rowid').all().map(raw => JSON.parse(String(raw.value)))
}

test('S07: the consecutive same-chat intake prefix is delivered as ONE cohort (head + mergedRows)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  const clock = 1_000_000
  const at = new Date(clock).toISOString()
  try {
    const calls = []
    const runner = new OutboxRunner({ store, deliver: async (row) => { calls.push(row) }, now: () => clock })
    for (const messageId of ['om_1', 'om_2', 'om_3']) enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId, at })
    await runner.tick()
    assert.equal(calls.length, 1, '一次唤醒：同一聊天同时准入的三条只进入投递器一次')
    const head = calls[0]
    assert.equal(head.id, 'out-inbox-trg-om_1', '队头就是最早那条')
    assert.equal(head.requestId, 'hub-bot-feishu-om_1', '整批复用队头的 requestId（一次唤醒一个幂等键）')
    assert.ok(Array.isArray(head.mergedRows), '成员表随队头一起交给投递器')
    assert.equal(head.mergedRows.length, 3)
    assert.equal(head.mergedCount, 2, 'mergedCount 是并入的条数，不含队头本身')
    assert.deepEqual(head.mergedRows.map(r => r.id), ['out-inbox-trg-om_1', 'out-inbox-trg-om_2', 'out-inbox-trg-om_3'],
      'index 0 = 队头，其余按到达顺序')
    assert.deepEqual(head.mergedRows.map(r => r.requestId), ['hub-bot-feishu-om_1', 'hub-bot-feishu-om_2', 'hub-bot-feishu-om_3'],
      '每条保留自己的 requestId')
    for (const member of head.mergedRows) {
      assert.equal(member.kind, 'inbox')
      assert.equal(member.to, 'owner:chief')
      assert.equal(member.state, 'queued', '交给投递器时每条仍是待投递的原始行')
      assert.ok(member.triggerId && member.body, '每条保留自己的来源事实与正文')
    }
    const rows = readOutbox(store)
    assert.equal(rows.length, 3, '没有凭空多出记录')
    for (const row of rows) {
      assert.equal(row.state, 'sent', row.id + ' 随队头一起结清')
      assert.equal(row.settledWith ?? row.id, 'out-inbox-trg-om_1', '成员记录被哪一次唤醒带走')
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('S07: a different chat is never merged — it stops the prefix and wakes the owner on its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  const clock = 1_000_000
  const at = new Date(clock).toISOString()
  try {
    const calls = []
    const runner = new OutboxRunner({ store, deliver: async (row) => { calls.push(row) }, now: () => clock })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_1', at })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_2', at })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-b', messageId: 'om_3', at })
    await runner.tick()
    assert.equal(calls.length, 2, '两个聊天 → 两次唤醒')
    assert.deepEqual(calls[0].mergedRows.map(r => r.requestId), ['hub-bot-feishu-om_1', 'hub-bot-feishu-om_2'],
      '同聊天前缀合并')
    assert.equal(calls[1].id, 'out-inbox-trg-om_3')
    assert.equal(calls[1].requestId, 'hub-bot-feishu-om_3', '另一个聊天保留自己的幂等键')
    assert.equal(calls[1].mergedRows, undefined, '单独一行不写成员表（普通的一参数契约）')
    assert.deepEqual(readOutbox(store).map(r => r.state), ['sent', 'sent', 'sent'])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('S07: a row admitted after the claim never joins the in-flight cohort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  const clock = 1_000_000
  const at = new Date(clock).toISOString()
  try {
    const calls = []
    let late = null
    const runner = new OutboxRunner({
      store, now: () => clock,
      deliver: async (row) => {
        calls.push(row)
        // 投递在途时同一聊天又来了一条——它绝不能挤进这次唤醒
        if (late === null) late = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_late', at })
      },
    })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_1', at })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_2', at })
    await runner.tick()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].mergedRows.map(r => r.requestId), ['hub-bot-feishu-om_1', 'hub-bot-feishu-om_2'],
      '成员表在投递之前就已冻结，后到的行不在其中')
    assert.equal(readOutbox(store).find(r => r.id === late.id).state, 'queued', '后到的行原样待投：不丢、不并')
    await runner.tick()
    assert.equal(calls.length, 2, '后到的行下一次 tick 自己唤醒一次')
    assert.equal(calls[1].id, late.id)
    assert.equal(calls[1].mergedRows, undefined)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('S07: an overlapping tick never re-delivers a claimed cohort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  const clock = 1_000_000
  const at = new Date(clock).toISOString()
  try {
    const entries = []
    let releaseDelivery
    const gate = new Promise((resolve) => { releaseDelivery = resolve })
    const runner = new OutboxRunner({ store, deliver: async (row) => { entries.push(row); await gate }, now: () => clock })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_1', at })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_2', at })
    const firstTick = runner.tick() // 不 await：整批还在飞
    await Promise.resolve()
    assert.equal(entries.length, 1, '第一轮已进入投递器（前置条件）')
    const secondTick = runner.tick() // 重叠 tick：成员行在库里仍是 'queued'
    releaseDelivery() // 先放行再断言：红灯只挂在计数上，绝不卡死
    await Promise.all([firstTick, secondTick])
    assert.equal(entries.length, 1, '同一批成员在重叠 tick 下只投递一次')
    assert.equal(entries[0].mergedRows.length, 2)
    assert.deepEqual(readOutbox(store).map(r => r.state), ['sent', 'sent'], '整批结清')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('S07: a restart after a failed delivery replays the frozen cohort instead of re-deriving it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  let clock = 1_000_000
  const at = new Date(clock).toISOString()
  try {
    const attempts = []
    const failing = new OutboxRunner({
      store, now: () => clock,
      deliver: async (row) => { attempts.push(row); throw new Error('channel down (fake)') },
    })
    enqueueFeishuIntake(failing, store, { chatId: 'chat-a', messageId: 'om_1', at })
    enqueueFeishuIntake(failing, store, { chatId: 'chat-a', messageId: 'om_2', at })
    await failing.tick()
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].mergedRows.length, 2, '第一次尝试就已经冻结了成员表')
    let rows = readOutbox(store)
    const head = rows.find(r => r.id === 'out-inbox-trg-om_1')
    assert.equal(head.state, 'queued')
    assert.equal(head.attempts, 1, '失败只推进队头的 attempts 阶梯')
    assert.equal(head.nextRetryAt, clock + 2000)
    assert.deepEqual(head.mergedRows.map(r => r.requestId), ['hub-bot-feishu-om_1', 'hub-bot-feishu-om_2'],
      '成员表随失败一起落库')
    const member = rows.find(r => r.id === 'out-inbox-trg-om_2')
    assert.equal(member.state, 'queued', '成员保持待投，不各自单飞')
    assert.equal(member.attempts, 0, '成员不背队头的失败计数')

    // 进程换代，期间同一聊天又来了第三条：重试只认库里冻结的那一份
    clock += 2000
    enqueueFeishuIntake(failing, store, { chatId: 'chat-a', messageId: 'om_3', at: new Date(clock).toISOString() })
    const retried = []
    const fresh = new OutboxRunner({ store, now: () => clock, deliver: async (row) => { retried.push(row) } })
    await fresh.tick()
    assert.equal(retried.length, 2, '重放冻结的整批，再单独唤醒后到的那条')
    assert.deepEqual(retried[0].mergedRows.map(r => r.requestId), ['hub-bot-feishu-om_1', 'hub-bot-feishu-om_2'],
      '成员表逐字复用——失败后绝不重新推导（否则后到的消息会悄悄挤进同一次唤醒）')
    assert.equal(retried[1].requestId, 'hub-bot-feishu-om_3')
    assert.equal(retried[1].mergedRows, undefined)
    assert.deepEqual(readOutbox(store).map(r => r.state), ['sent', 'sent', 'sent'])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('S07: the stop lane never joins a cohort and keeps its own ordering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(dir)
  const clock = 1_000_000
  const at = new Date(clock).toISOString()
  try {
    const calls = []
    const runner = new OutboxRunner({ store, deliver: async (row) => { calls.push(row) }, now: () => clock })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_1', at })
    enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_2', at })
    seedFeishuTrigger(store, { triggerId: 'trg-stop', chatId: 'chat-a', messageId: 'om_stop', at })
    runner.enqueue({
      id: 'out-inbox-trg-stop', ticketId: null, triggerId: 'trg-stop', kind: 'stop', to: 'owner:chief',
      body: '停', sessionId: 'sess-1', requestId: 'hub-bot-feishu-om_stop',
    })
    await runner.tick({ kind: 'stop' })
    assert.equal(calls.length, 1, 'stop 先走：打断不排在普通唤醒后面')
    assert.equal(calls[0].kind, 'stop')
    assert.equal(calls[0].mergedRows, undefined, 'stop 行永不合并')
    await runner.tick()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].mergedRows.map(r => r.requestId), ['hub-bot-feishu-om_1', 'hub-bot-feishu-om_2'],
      'stop 落地后，后面的同聊天 inbox 前缀照常合并')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('an already claimed single message cannot absorb a later same-chat retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(directory)
  let clock = 1_000_000
  const calls = []
  const runner = new OutboxRunner({ store, now: () => clock, deliver: async row => {
    calls.push(row)
    if (calls.length === 1) throw new Error('fixture temporary outage')
  } })
  try {
    const head = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_first', at: new Date(clock).toISOString() })
    await runner.tick()
    clock += 2000
    const later = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_later', at: new Date(clock).toISOString() })
    await runner.tick()
    assert.deepEqual(calls.map(row => row.requestId), [head.requestId, head.requestId, later.requestId])
    assert.ok(calls.every(row => row.mergedRows === undefined))
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('a stored admitted message does not become the head of a new cohort', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-bot-outbox-'))
  const store = new Store(directory)
  const calls = []
  const at = new Date(1_000_000).toISOString()
  const runner = new OutboxRunner({ store, now: () => Date.parse(at), deliver: async row => { calls.push(row) } })
  try {
    const head = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_admitted', at })
    const later = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_pending', at })
    const saved = JSON.parse(store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(head.triggerId).value)
    store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify({ ...saved, injectedAt: at }), head.triggerId)
    await runner.tick()
    assert.deepEqual(calls.map(row => row.requestId), [head.requestId, later.requestId])
    assert.ok(calls.every(row => row.mergedRows === undefined))
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('retrying one failed member replays its full cohort with the original request ID', async () => {
  const attempts = []
  const { store, runner, setClock, getClock, cleanup } = fixture({
    plan: row => { attempts.push(row); return false },
  })
  try {
    const cohort = ['om_head', 'om_member', 'om_last'].map(messageId =>
      enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId, at: new Date(getClock()).toISOString() }))
    await runner.tick()
    setClock(getClock() + 2_000)
    await runner.tick()
    setClock(getClock() + 4_000)
    await runner.tick()

    const later = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_later', at: new Date(getClock()).toISOString() })
    const retried = retryOutboxRows(store, [cohort[1].id])
    const delivered = []
    const fresh = new OutboxRunner({ store, now: getClock, deliver: async row => { delivered.push(row) } })
    await fresh.tick()

    assert.deepEqual(delivered.map(row => row.requestId), [cohort[0].requestId, later.requestId])
    assert.deepEqual(delivered[0].mergedRows, attempts[0].mergedRows)
    assert.equal(delivered[0].attempts, 0)
    assert.equal(retried, cohort.length)
  } finally { cleanup() }
})

test('a cohort retried during failure reporting cannot deliver a member on its own', async () => {
  const { store, getClock, cleanup } = fixture()
  const calls = []
  try {
    const runner = new OutboxRunner({
      store, now: getClock,
      onSystemProblem: () => retryOutboxRows(store, [member.id]),
      deliver: async row => {
        calls.push(row)
        if (calls.length === 1) throw Object.assign(new Error('fake outage'), { permanent: true })
      },
    })
    const at = new Date(getClock()).toISOString()
    const head = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_head', at })
    const member = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_member', at })
    await runner.tick()
    await runner.tick()

    assert.deepEqual(calls.map(row => row.requestId), [head.requestId, head.requestId])
    assert.deepEqual(calls[1].mergedRows, calls[0].mergedRows)
  } finally { cleanup() }
})

test('discarding one failed member removes its whole cohort', async () => {
  const { store, getClock, cleanup } = fixture()
  const calls = []
  const runner = new OutboxRunner({
    store, now: getClock,
    deliver: async row => {
      calls.push(row.requestId)
      if (row.requestId === 'hub-bot-feishu-om_head') throw Object.assign(new Error('fake outage'), { permanent: true })
    },
  })
  try {
    const at = new Date(getClock()).toISOString()
    const head = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_head', at })
    const member = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_member', at })
    await runner.tick()

    const unrelated = insertOutbox(store, { kind: 'reply', state: 'failed', to: 'dsh:session:chief' })
    const later = enqueueFeishuIntake(runner, store, { chatId: 'chat-a', messageId: 'om_later', at })
    assert.equal(discardOutboxRows(store, [member.id]), 2)
    assert.equal(discardOutboxRows(store, [head.id, member.id]), 0)
    assert.equal(discardOutboxRows(store, [unrelated.id]), 1)
    await runner.tick()
    assert.deepEqual(calls, [head.requestId, later.requestId])
  } finally { cleanup() }
})

test('a failed member whose original head is missing can still be discarded', () => {
  const { store, cleanup } = fixture()
  try {
    const orphan = insertOutbox(store, {
      kind: 'inbox', state: 'failed', to: 'owner:chief', requestId: 'member-request', settledWith: 'deleted-head',
    })
    assert.equal(retryOutboxRows(store, [orphan.id]), 0)
    assert.equal(discardOutboxRows(store, [orphan.id]), 1)
  } finally { cleanup() }
})

test('an outbox pass can exclude deferred decisions while targeted and default passes still deliver them', async () => {
  const { runner, calls, cleanup } = fixture()
  try {
    const decision = runner.enqueue({ kind: 'deferred-decision', to: 'owner:chief', requestId: 'decision' })
    const reply = runner.enqueue({ kind: 'reply', to: 'dsh:session:chief', requestId: 'reply' })
    await runner.tick({ excludeKind: 'deferred-decision' })
    assert.deepEqual(calls.map(row => row.id), [reply.id])

    const laterReply = runner.enqueue({ kind: 'reply', to: 'dsh:session:chief', requestId: 'later-reply' })
    await runner.tick({ kind: 'deferred-decision' })
    assert.deepEqual(calls.map(row => row.id), [reply.id, decision.id])

    const laterDecision = runner.enqueue({ kind: 'deferred-decision', to: 'owner:chief', requestId: 'later-decision' })
    await runner.tick()
    assert.deepEqual(calls.map(row => row.id), [reply.id, decision.id, laterReply.id, laterDecision.id])
  } finally { cleanup() }
})

test('a deferred decision in backoff only blocks decisions for the same destination', async () => {
  const { runner, calls, cleanup } = fixture({ plan: row => row.requestId !== 'first-chief-decision' })
  try {
    runner.enqueue({ kind: 'deferred-decision', to: 'owner:chief', requestId: 'first-chief-decision' })
    runner.enqueue({ kind: 'deferred-decision', to: 'owner:chief', requestId: 'second-chief-decision' })
    runner.enqueue({ kind: 'deferred-decision', to: 'owner:secondary', requestId: 'other-decision' })
    runner.enqueue({ kind: 'reply', to: 'dsh:session:chief', requestId: 'reply' })
    await runner.tick()
    assert.deepEqual(calls.map(row => row.requestId), ['first-chief-decision', 'other-decision', 'reply'])
  } finally { cleanup() }
})
