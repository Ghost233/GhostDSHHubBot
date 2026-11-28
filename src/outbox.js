/**
 * OutboxRunner — Stored work for every outward action (spec「可靠性」+ issue #66).
 *
 * 先存后做: enqueue() INSERTs the row (state 'queued', stable requestId) BEFORE any delivery attempt; the
 * deliverer always observes a stored row. Delivery is strictly ordered per ticket — the confirmation is
 * always sent before the result: a queued head blocks the tail until it is sent, or until it has failed 3
 * consecutive attempts, at which point the runner reports a system problem (outbox row + onSystemProblem)
 * and bypasses it. Retries use a 2s exponential backoff capped at 5 min for injections and 1 min for
 * replies. One transient failure never alarms anyone (一次性网络错误不惊动人）.
 *
 * The runner is a pure domain module: the clock and the deliverer are injected, so ordering, backoff and
 * crash recovery are unit-testable without a DSH runtime. Rows live in the store's outbox table — a fresh
 * runner over the same store resumes unfinished work (spec: 重启恢复）. Legacy 'recorded' rows (pre-#66
 * reply intents) are not delivery work and are left untouched.
 *
 * S07 同聊天合并 (issue #38): intake rows of the same owner AND the same stored Feishu chat are claimed as ONE
 * cohort — only the consecutive due, pending prefix of that inbox. Before delivery, one transaction freezes
 * the original rows in the head (mergedRows, in arrival order with the head first) and records the membership
 * on each trigger. A retry, postponement or restart reuses the frozen members and the original head requestId.
 * mergedCount includes the head. An accepted cohort settles its rows together. Only a merge adds mergedRows.
 */
import { randomUUID } from 'node:crypto'
import { archiveRunNotification } from './runs.js'

/** Backoff caps by row kind (spec: 回复上限 1 分钟、注入上限 5 分钟）. */
const CAP_MS = { inject: 5 * 60_000, inbox: 5 * 60_000, reply: 60_000 }
const BASE_MS = 2_000
const MAX_ATTEMPTS = 3

/**
 * THE one writer for outbox rows (双轴审查 P2: enqueue / recordReportFact / owner-tools.escalate /
 * system-problem used to hand-roll four slightly different rows — field drift on requestId/nextRetryAt/
 * createdAt). Every row gets: id, attempts 0, nextRetryAt null, createdAt; callers pass the specifics.
 */
export function insertOutbox(store, row, now = () => Date.now()) {
  // 双轴审查 P1-1（死信）: a row without a delivery state matches no scan — the runner scans 'queued', the
  // channels scan 'recorded' — so it can never be delivered. Refuse to write it.
  if (typeof row?.state !== 'string' || !row.state) {
    throw new Error('insertOutbox: state-required — every outbox row must declare its delivery state (queued/held/recorded)')
  }
  const createdAt = new Date(now()).toISOString()
  const full = { attempts: 0, nextRetryAt: null, ...row, id: row.id ?? 'out-' + randomUUID(), createdAt }
  store.db.prepare('INSERT INTO outbox (id, value, at) VALUES (?, ?, ?)').run(full.id, JSON.stringify(full), createdAt)
  return full
}

function writeOutboxTransaction(store, write) {
  const { db } = store
  if (db.isTransaction) return write()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function failedOutboxGroups(store, ids) {
  const groups = new Map()
  for (const { value } of store.db.prepare('SELECT value FROM outbox').all()) {
    const row = JSON.parse(String(value))
    if (row.state !== 'failed') continue
    const headId = row.settledWith ?? row.id
    if (!groups.has(headId)) groups.set(headId, [])
    groups.get(headId).push(row)
  }
  return [...groups].filter(([, rows]) => ids === null || rows.some(row => ids.includes(row.id)))
}

/**
 * 死信重投（面板健康警告条的操作闭环）: failed 行回到原投递通道（originState），
 * attempts 清零、退避清空——下一轮 tick 重新尝试。返回重投的行数。
 * 旧死信（v0.4.1 前，无 originState）默认回 'queued'。同一批的死信以原队头和冻结成员表整批重投。
 */
export function retryOutboxRows(store, ids = null, now = () => new Date().toISOString()) {
  return writeOutboxTransaction(store, () => {
    let retried = 0
    for (const [headId, rows] of failedOutboxGroups(store, ids)) {
      // A partial cohort can be discarded, but replay requires the original head and every frozen member.
      const head = rows.find(row => row.id === headId)
      if (!head || head.retryable === false) continue
      const frozen = Array.isArray(head.mergedRows) ? head.mergedRows : [head]
      const memberIds = new Set(frozen.map(member => member?.id))
      if (frozen.length !== rows.length || rows.some(row => !memberIds.has(row.id))) continue
      for (const { originState, ...row } of rows) {
        const ordinary = Number.isSafeInteger(row.notificationWindowMs) && row.notificationWindowMs > 0
        updateOutboxRow(store, { ...row, state: ordinary ? 'held' : originState ?? 'queued',
          ...(ordinary && { notificationRetry: true, notificationRetryAt: now() }), attempts: 0, nextRetryAt: null, lastError: null })
      }
      retried += rows.length
    }
    return retried
  })
}

/**
 * 死信丢弃（round 41）：删除选中的 failed 行及其整批死信。返回删除的行数。
 */
export function discardOutboxRows(store, ids = null) {
  return writeOutboxTransaction(store, () => {
    const del = store.db.prepare('DELETE FROM outbox WHERE id = ?')
    const discardIntake = store.db.prepare("UPDATE trigger SET value = json_set(value, '$.intakeDiscarded', json('true')) WHERE id = ?")
    let discarded = 0
    for (const [, rows] of failedOutboxGroups(store, ids)) {
      for (const row of rows) {
        if (row.kind === 'inbox' && row.triggerId) discardIntake.run(row.triggerId)
        archiveRunNotification(store, row)
        del.run(row.id)
      }
      discarded += rows.length
    }
    return discarded
  })
}

/** THE one outbox row updater (双轴审查 P1-2: feishu/github/runner hand-rolled the same UPDATE three times). */
export function updateOutboxRow(store, row) {
  store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(JSON.stringify(row), row.id)
}

/**
 * The channel-agnostic recorded-reply driver (双轴审查 P1-2: feishu/github deliverReplies were ~25-line
 * isomorphic copies and had already drifted — feishu missed ORDER BY, counters were named per channel).
 * One scan (oldest first), one counter (`attempts`), one failure ladder: only a real delivery earns 'sent';
 * `maxAttempts` consecutive failures fail the row and report a system problem (OutboxRunner discipline).
 *
 * @param {{ store: import('./store.js').Store, logger: { warn: Function }, now: () => string,
 *   channel: string, prefix: string, maxAttempts: number,
 *   parseTarget: (to: string) => unknown,  // null = unparseable → the row fails immediately
 *   send: (target: unknown, body: string, row: object) => Promise<void | false>, // false leaves the row available for a later pass
 *   prepareBody?: (body: string) => string, canContinue?: () => boolean }} deps
 */
/**
 * #74 P1-A: one delivery pass per channel at a time. The 1s tick does not await the previous pass, and a
 * real channel send (gh api / feishu im) routinely outlasts one second — without this guard an overlapping
 * pass re-scanned the same 'recorded' rows mid-send and re-sent them (live evidence: issue
 * Ghost233/DSH-Workflow#76 received two identical ack comments one second apart from a single outbox row).
 * Process-local and crash-safe by construction: nothing is persisted, a crashed pass simply lets the next
 * tick retry the still-'recorded' rows. Keyed by channel so feishu and github never block each other.
 */
const channelPassInFlight = new Set()

export async function deliverRecordedReplies({ store, logger, now, channel, prefix, maxAttempts, parseTarget, send, prepareBody, canContinue }) {
  if (channelPassInFlight.has(channel)) return { delivered: 0, skipped: 'in-flight' }
  channelPassInFlight.add(channel)
  try {
    return await deliverRecordedRepliesPass({ store, logger, now, channel, prefix, maxAttempts, parseTarget, send, prepareBody, canContinue })
  } finally {
    channelPassInFlight.delete(channel)
  }
}

async function deliverRecordedRepliesPass({ store, logger, now, channel, prefix, maxAttempts, parseTarget, send, prepareBody, canContinue }) {
  const rows = store.db.prepare('SELECT value FROM outbox ORDER BY rowid').all()
    .map(raw => JSON.parse(String(raw.value)))
    .filter(row => row.state === 'recorded' && typeof row.to === 'string' && row.to.startsWith(prefix))
  if (rows.length === 0) return { delivered: 0 }
  let delivered = 0
  for (const row of rows) {
    if (canContinue?.() === false) break
    const target = parseTarget(row.to)
    if (!target) {
      updateOutboxRow(store, { ...row, state: 'failed', lastError: 'unparseable ' + channel + ' target' })
      continue
    }
    const body = prepareBody ? prepareBody(row.body) : row.body
    try {
      if (await send(target, body, row) === false) continue
      if (store.closed) break
      updateOutboxRow(store, { ...row, state: 'sent', sentAt: now() })
      delivered++
    } catch (error) {
      if (store.closed) break
      const attempts = (row.attempts ?? 0) + 1
      logger.warn('hub-bot %s: reply to %s failed (%s)', channel, row.to, error?.message ?? error)
      if (attempts >= maxAttempts) {
        // 死信（failed）: 记下原 state（originState）——面板「重投」时好回到正确的投递通道
        // （queued 走主循环 / recorded 走回投扫描），不用猜。
        updateOutboxRow(store, { ...row, state: 'failed', originState: row.state, attempts, lastError: String(error?.message ?? error) })
        insertOutbox(store, {
          ticketId: row.ticketId ?? null, kind: 'system-problem', to: 'chief',
          body: channel + ' reply ' + row.id + ' failed ' + attempts + ' times in a row (' + row.to + ')', state: 'recorded',
        })
      } else {
        updateOutboxRow(store, { ...row, attempts, lastError: String(error?.message ?? error) })
      }
    }
  }
  return { delivered }
}

export class OutboxRunner {
  /**
   * S01 单飞账本： per-ticket key（`row.ticketId ?? ''`）标记「这张票当前有一轮 drain 在途」。
   * 一行从 enqueue 到落 sent/recorded/failed 之间始终是 'queued'，而 1s 定时器并不 await 上一轮
   * tick（先存后做 = 行先入库，送达后才改状态）—— 慢投递（真实 gh/feishu/会话 prompt）常常超过一秒，
   * 没有这把锁，重叠的 tick 会把同一个 queued 行再投一次。进程内、不落盘：崩溃后下一轮 tick 照常重试
   * 仍是 'queued' 的行，语义不变。按票隔离，票与票之间永不互相阻塞。
   */
  #activeDrains = new Set()



  /**
   * @param {{ store: import('./store.js').Store,
   *           deliver: (row: object) => Promise<void>,
   *           now?: () => number,
   *           onFailure?: (row: object, reason: string) => boolean,
   *           onSystemProblem?: (problem: { ticketId: string|null, reason: string, rowId: string }) => void }} deps
   */
  constructor({ store, deliver, now, onFailure, onSystemProblem }) {
    this.store = store
    this.deliver = deliver
    this.onFailure = onFailure
    this.now = now ?? (() => Date.now())
    this.onSystemProblem = onSystemProblem ?? (() => {})
  }

  /**
   * Stores the action first （先存后做） and returns the queued row. #72 执行槽： `held: true` stores the row
   * in state 'held' — fully written (the durable intent exists from route time) but invisible to the delivery
   * scan until releaseHeld() flips it to 'queued' (slot admission). Per-ticket order survives: the held head
   * and any follow-up rows release together, oldest first.
   */
  enqueue({ id, ticketId, triggerId, kind, to, body, sessionId, requestId, held }) {
    return insertOutbox(this.store, {
      id, ticketId: ticketId ?? null, kind, to, body, sessionId: sessionId ?? null, requestId, state: held === true ? 'held' : 'queued',
      ...(triggerId !== undefined && { triggerId }),
    }, this.now)
  }

  /** #72: releases every held row of one ticket back into the delivery scan (slot granted). Idempotent. */
  releaseHeld({ ticketId }) {
    const rows = this.store.db.prepare('SELECT value FROM outbox ORDER BY at').all()
      .map(raw => JSON.parse(String(raw.value)))
      .filter(row => row.ticketId === ticketId && row.state === 'held' && row.kind !== 'notification-source' && !row.notificationRetry)
    for (const row of rows) this.#writeRow({ ...row, state: 'queued' })
    return rows.length
  }

  #readRow(id) {
    const raw = this.store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(id)
    return raw === undefined ? undefined : JSON.parse(String(raw.value))
  }

  #writeRow(row) {
    updateOutboxRow(this.store, row) // 双轴审查 P1-2: 三处逐字重复收敛到这一个写者
  }

  /** All queued delivery rows, oldest first, grouped by ticket or owner inbox. */
  #pendingByTicket({ kind, excludeKind }) {
    const rows = this.store.db.prepare('SELECT value FROM outbox ORDER BY at, rowid').all()
      .map(raw => JSON.parse(String(raw.value)))
      .filter(row => row.state === 'queued' && (kind === undefined || row.kind === kind)
        && (excludeKind === undefined || row.kind !== excludeKind))
    const groups = new Map()
    for (const row of rows) {
      const ownerLane = ['inbox', 'stop', 'deferred-decision', 'owner-switch-control'].includes(row.kind)
      const channelReply = row.kind === 'reply' && typeof row.to === 'string' && /^(feishu|github):/.test(row.to)
      const key = channelReply ? 'reply:' + row.to : row.ticketId ?? (ownerLane ? row.kind + ':' + row.to : '')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    return groups
  }

  #pendingChat(row) {
    if (typeof row.triggerId !== 'string' || !row.triggerId) return null
    const raw = this.store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(row.triggerId)
    if (!raw) return null
    const trigger = JSON.parse(String(raw.value))
    const chatId = trigger.source?.chatId
    if (!trigger.authorization || trigger.dropped || trigger.injectedAt || typeof chatId !== 'string' || !chatId) return null
    return JSON.stringify([chatId, trigger.ownerSwitchRef ?? null])
  }

  /**
   * S07 同聊天合并 (issue #38): claim the cohort the head row delivers for.
   *
   * Membership is the consecutive, due, still-'queued' `kind: 'inbox'` prefix of one owner inbox that was
   * admitted from the SAME stored chat. Every terminator is a hard stop: a different owner (`to`), a
   * different chat, a not-yet-due `nextRetryAt`, a non-inbox row (stop lane / inject / reply never merge),
   * a row already advanced by another path, and — because the snapshot is one ordered read — anything that
   * arrived after the claim. No debounce: the cohort is what is pending at this instant, nothing waits.
   *
   * Save chosen membership before invoking the transport, including an attempt with only its head.
   * Retries reuse the original request ID and members even if new rows have arrived.
   */
  #claimCohort(head, tail, nowMs) {
    if (head.kind !== 'inbox' || head.cohortClaimedAt) return head
    const members = [head]
    const chat = this.#pendingChat(head)
    if (chat) for (const pending of tail) {
      const candidate = this.#readRow(pending.id)
      if (!candidate || candidate.state !== 'queued' || candidate.kind !== 'inbox' || candidate.to !== head.to
        || (candidate.nextRetryAt !== null && candidate.nextRetryAt > nowMs)
        || candidate.cohortClaimedAt || candidate.settledWith != null || this.#pendingChat(candidate) !== chat) break
      members.push(candidate)
    }
    const frozen = {
      ...head, cohortClaimedAt: new Date(this.now()).toISOString(),
      ...(members.length > 1 && { mergedRows: members, mergedCount: members.length }),
    }
    if (!frozen.mergedRows) {
      this.#writeRow(frozen)
      return frozen
    }

    const triggerIds = members.map(row => row.triggerId)
    const audit = JSON.stringify({ requestId: frozen.requestId, triggerIds, mergedCount: frozen.mergedCount })
    return writeOutboxTransaction(this.store, () => {
      this.#writeRow(frozen)
      const stamp = this.store.db.prepare("UPDATE trigger SET value = json_set(value, '$.intakeCohort', json(?)) WHERE id = ?")
      for (const id of triggerIds) {
        if (stamp.run(audit, id).changes !== 1) throw new Error('Missing trigger during cohort claim: ' + id)
      }
      return frozen
    })
  }

  /**
   * S07: an accepted cohort settles together. The head is already written by #attempt; every other frozen
   * member that is still pending is advanced to the same terminal state (a member already moved or removed
   * by another path is left alone). Members record `settledWith` so the panel/audit can tell that this row
   * was carried by the head's wake-up instead of being delivered on its own.
   */
  #settleCohort(head, terminal) {
    if (this.store.closed) return
    writeOutboxTransaction(this.store, () => {
      this.#writeRow({ ...head, ...terminal, nextRetryAt: null })
      this.#settleMembers(head, terminal)
    })
  }

  #settleMembers(head, terminal) {
    const merged = Array.isArray(head.mergedRows) ? head.mergedRows : []
    for (const member of merged) {
      if (member?.id === undefined || member.id === head.id) continue
      const current = this.#readRow(member.id)
      if (current === undefined || current.state !== 'queued') continue
      this.#writeRow({ ...current, ...terminal, nextRetryAt: null, settledWith: head.id })
    }
  }

  /**
   * Delivers every due row, strictly ordered within each ticket.
   *
   * S01 可靠性（单飞 + 保序 + 幂等）：
   * 1) 单飞 — 一张票同时只允许一轮 drain。行在送达前一直是 'queued'，而 1s 定时器不 await 上一轮 tick，
   *    慢投递超过一秒就会让重叠的 tick 重入同一个 queued 行（重复送达）。本轮已持有该票的 key 时，
   *    整票跳过（只跳过这一张票，别的票照常推进），由在途那一轮的 finally 释放。
   * 2) 保序 — #pendingByTicket() 按落库顺序（ORDER BY at）给出每票的行；队头未到期则队尾等待（break）。
   * 3) 幂等 — 每次尝试之前重新读库里的当前行：别处（重投/丢弃/另一条路径）已经把它推进终态
   *    （sent/recorded/failed）或删掉时直接跳过，绝不凭旧快照再投一次；requestId 等字段一律沿用库里的当前值。
   */
  async tick({ kind, excludeKind } = {}) {
    const nowMs = this.now()
    const groups = this.#pendingByTicket({ kind, excludeKind })
    // Interrupts must not wait behind a blocked ordinary prompt.
    const ordered = [...groups].sort(([, a], [, b]) => Number(b[0].kind === 'stop') - Number(a[0].kind === 'stop'))
    for (const [key, rows] of ordered) {
      if (this.store.closed) return
      if (this.#activeDrains.has(key)) continue // 这张票已有一轮 drain 在途 → 本轮不重入
      this.#activeDrains.add(key)
      try {
        for (let index = 0; index < rows.length; index++) {
          if (this.store.closed) return
          const current = this.#readRow(rows[index].id)
          // A stale snapshot may still contain members that were just requeued with their head.
          if (current === undefined || current.state !== 'queued' || current.settledWith != null) continue
          if (current.nextRetryAt !== null && current.nextRetryAt > nowMs) break // 当前值未到期，队尾等待
          // S07: 只把「同 owner、同聊天、连续、到期」的待投递前缀合成一次唤醒；成员表在投递之前先冻结，
          // 已在途/已冻结的队头直接复用库里那份成员表，绝不重新推导。
          const head = this.#claimCohort(current, rows.slice(index + 1), nowMs)
          const done = await this.#attempt(head)
          if (!done) break // failed attempts keep the head in place until it is sent or declared failed
        }
      } finally {
        this.#activeDrains.delete(key)
      }
    }
  }

  /**
   * One delivery attempt. Returns true when the queue may advance past this row (sent, or failed out after
   * MAX_ATTEMPTS and bypassed with a system problem reported).
   */
  async #attempt(row) {
    try {
      // A deferred digest may stay queued without spending an attempt. A frozen cohort keeps its frozen
      // membership: postponing is still a retry, and re-deriving after it would let later arrivals in.
      const result = await this.deliver(row)
      if (this.store.closed) return true
      if (result && typeof result.postponeMs === 'number') {
        this.#writeRow({ ...row, nextRetryAt: this.now() + result.postponeMs })
        return false
      }
      // 不假装送达 (#64): the deliverer may declare the intent RECORDED but undelivered (e.g. a Feishu target
      // whose channel does not exist yet) — a terminal 'recorded' row, kept for a future channel to scan,
      // never a fake 'sent'. Only an actual delivery earns 'sent'.
      if (result && result.recorded === true) {
        this.#settleCohort(row, {
          state: 'recorded', recordedAt: new Date(this.now()).toISOString(),
          ...(typeof result.skipped === 'string' && { skipReason: result.skipped }),
        })
        return true
      }
      const sentAt = new Date(this.now()).toISOString()
      this.#settleCohort(row, { state: 'sent', sentAt })
      return true
    } catch (error) {
      if (this.store.closed) return true
      // A permanent failure (e.g. the ticket's authorization record is missing — 票面权威) must not be
      // retried: it fails out immediately and is reported as a system problem like any 3rd failure.
      // S07: 失败只推进队头的 attempts 阶梯，成员保持 queued 且成员表原样不动——下一次尝试（或重启后的
      // 新 runner）重放的就是这一份成员表，不会重新推导。
      const attempts = error?.permanent === true ? MAX_ATTEMPTS : row.attempts + 1
      const lastError = String(error?.message ?? error)
      if (attempts >= MAX_ATTEMPTS) {
        const failedAt = new Date(this.now()).toISOString()
        const problem = { ticketId: row.ticketId, reason: 'delivery failed ' + attempts + ' times in a row (' + row.kind + ' → ' + row.to + ')', rowId: row.id }
        writeOutboxTransaction(this.store, () => {
          const settled = this.onFailure?.(row, lastError) === true
          this.#settleCohort(row, { state: 'failed', failedAt, lastError, attempts, ...(settled && { retryable: false }) })
          insertOutbox(this.store, { ticketId: row.ticketId, kind: 'system-problem', to: 'chief', body: problem.reason, state: 'recorded' }, this.now)
        })
        this.onSystemProblem(problem)
        return true // bypass: the tail may proceed
      }
      const cap = CAP_MS[row.kind] ?? CAP_MS.reply
      const delay = Math.min(BASE_MS * 2 ** (attempts - 1), cap)
      this.#writeRow({ ...row, attempts, lastError, nextRetryAt: this.now() + delay })
      return false
    }
  }
}
