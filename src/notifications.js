import { randomUUID } from 'node:crypto'
import { REPLY_WORD_LIMIT, wordCount } from './discipline.js'
import { insertOutbox, updateOutboxRow } from './outbox.js'

export const DEFAULT_NOTIFICATION_WINDOW_MS = 60_000

const DETAILS_KEY = 'notification-details:'
const MAX_NOTIFICATION_BYTES = 4_096

function canonicalDestination(address) {
  if (typeof address === 'string' && address.startsWith('feishu:')) {
    const prefix = address.startsWith('feishu:chat:') ? 'feishu:chat:' : 'feishu:'
    const chatId = address.slice(prefix.length)
    if (chatId.trim()) return 'feishu:chat:' + chatId
  }
  const github = typeof address === 'string' && /^github:([a-z0-9_-]+\/[a-z0-9_.-]+):([^:]+)$/i.exec(address)
  if (github) {
    const issue = Number(github[2])
    if (Number.isSafeInteger(issue) && issue > 0) return 'github:' + github[1].toLowerCase() + ':' + issue
  }
  throw new TypeError('A Feishu chat or GitHub item destination is required.')
}

function indexSources(sources) {
  const tickets = new Map()
  for (const source of sources) {
    const { ticketId } = source
    if (!tickets.has(ticketId)) tickets.set(ticketId, { ticketId, runId: 'run-' + ticketId, sourceOutboxIds: [] })
    const ticket = tickets.get(ticketId)
    ticket.sourceOutboxIds.push(source.id)
    ticket.latest = source
  }
  return [...tickets.values()]
}

function fits(text) {
  return Buffer.byteLength(text) <= MAX_NOTIFICATION_BYTES && wordCount(text) <= REPLY_WORD_LIMIT
}

function formatBody(id, tickets) {
  const lines = tickets.map(({ ticketId, latest }) => latest.body.includes(ticketId) ? latest.body : ticketId + ' · ' + latest.body)
  // Preserve the immediate single-result format. Flushed batches carry an exact lookup ID.
  if (tickets[0].latest.id === id && fits(lines[0])) return lines[0]
  const heading = '后台任务结果（' + tickets.length + ' 项）'
  const reference = '在 Hub Bot 运行记录中按通知编号 ' + id + ' 查看完整任务索引与详情。'
  const summary = [heading, ...lines.map(line => '- ' + line), reference].join('\n')
  if (fits(summary)) return summary

  // Keep whole IDs in the compact preview. The durable index carries every task, including any overflow.
  let preview = heading
  for (const { ticketId } of tickets) {
    const next = preview + '\n- ' + ticketId
    if (!fits(next + '\n' + reference)) break
    preview = next
  }
  return preview + '\n' + reference
}

/** Durable admission and aggregation for ordinary background results. */
export class NotificationThrottle {
  #store
  #runs
  #now
  #windowMs

  constructor({ store, runs, now = Date.now, windowMs = DEFAULT_NOTIFICATION_WINDOW_MS }) {
    this.#store = store
    this.#runs = runs
    this.#now = now
    this.#windowMs = typeof windowMs === 'function' ? windowMs : () => windowMs
  }

  /** Store one ordinary source and link its run in the same transaction. */
  record({ ticketId, triggerId, to: address, body }) {
    const to = canonicalDestination(address)
    if (typeof body !== 'string' || !body.trim()) throw new TypeError('A notification body is required.')
    return this.#write(() => {
      const now = this.#now()
      const blocked = this.#reservedDestinations(now, to).has(to)
      const waiting = blocked ? [] : this.#held(to)
      // Publish already-due work before admitting a result for the next window.
      if (waiting.length) this.#publishWaiting(to, waiting, now)
      const source = { id: 'out-' + randomUUID(), ticketId, triggerId, to, body, requestId: 'hub-bot-run-notice-' + randomUUID() }
      const row = blocked || waiting.length
        ? insertOutbox(this.#store, { ...source, kind: 'notification-source', state: 'held' }, () => now)
        : this.#publish(source, [source], now)
      this.#runs.linkOutbox(ticketId, row.id)
      return row
    })
  }

  /** Look up the exact index behind a channel notification, including discarded dead letters. */
  details(outboxId) {
    return typeof outboxId === 'string' && outboxId ? this.#store.get(DETAILS_KEY + outboxId) : undefined
  }

  /** Publish one due batch per destination for the existing external channel passes. */
  flush() {
    return this.#write(() => {
      const waiting = this.#held()
      if (!waiting.length) return []
      const now = this.#now()
      const blocked = this.#reservedDestinations(now)
      const byDestination = new Map()
      for (const row of waiting) {
        if (blocked.has(row.to)) continue
        if (!byDestination.has(row.to)) byDestination.set(row.to, [])
        byDestination.get(row.to).push(row)
      }
      return [...byDestination].map(([to, rows]) => this.#publishWaiting(to, rows, now))
    })
  }

  #held(to = null) {
    return this.#store.db.prepare(`SELECT value FROM outbox
      WHERE json_extract(value, '$.state') = 'held'
        AND (json_extract(value, '$.kind') = 'notification-source' OR json_extract(value, '$.notificationRetry') = 1)
        AND (? IS NULL OR json_extract(value, '$.to') = ?)
      ORDER BY coalesce(json_extract(value, '$.notificationRetryAt'), at), rowid`).all(to, to).map(row => JSON.parse(row.value))
  }

  #reservedDestinations(now, to = null) {
    // Recorded replies reserve the destination through delivery attempts. Only a channel acceptance
    // starts the cooldown. The window length belongs to the publication and survives config changes.
    const rows = this.#store.db.prepare(`SELECT DISTINCT json_extract(value, '$.to') AS destination FROM outbox
      WHERE json_type(value, '$.notificationWindowMs') = 'integer'
        AND (? IS NULL OR json_extract(value, '$.to') = ?)
        AND (json_extract(value, '$.state') = 'recorded'
          OR (json_extract(value, '$.state') = 'sent'
            AND round(unixepoch(json_extract(value, '$.sentAt'), 'subsec') * 1000)
              + json_extract(value, '$.notificationWindowMs') > ?))`).all(to, to, now)
    return new Set(rows.map(row => row.destination))
  }

  #publish({ to, id = 'out-' + randomUUID(), requestId = 'hub-bot-run-notice-' + randomUUID() }, sources, now) {
    const notificationWindowMs = this.#windowMs() ?? DEFAULT_NOTIFICATION_WINDOW_MS
    if (!Number.isSafeInteger(notificationWindowMs) || notificationWindowMs <= 0) {
      throw new TypeError('The notification window must be a positive integer in milliseconds.')
    }
    const tickets = indexSources(sources)
    const single = tickets.length === 1 ? tickets[0].latest : null
    const row = insertOutbox(this.#store, {
      id, requestId, to, ticketId: single?.ticketId ?? null, triggerId: single?.triggerId ?? null,
      body: formatBody(id, tickets), kind: 'reply', state: 'recorded', notificationWindowMs,
    }, () => now)
    this.#store.set(DETAILS_KEY + id, { id, tickets: tickets.map(({ ticketId, runId, sourceOutboxIds }) => ({ ticketId, runId, sourceOutboxIds })) })
    return row
  }

  #publishWaiting(to, waiting, now) {
    const head = waiting[0]
    if (head.notificationRetry) {
      // The channel may already know this request ID. Preserve its body, identity and source index.
      const { notificationRetry, notificationRetryAt, ...row } = head
      const retry = { ...row, state: 'recorded' }
      updateOutboxRow(this.#store, retry)
      return retry
    }
    const sources = waiting.filter(row => row.kind === 'notification-source')
    const final = this.#publish({ to }, sources, now)
    for (const source of sources) {
      updateOutboxRow(this.#store, { ...source, state: 'aggregated', settledWith: final.id })
    }
    return final
  }

  #write(write) {
    const { db } = this.#store
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
}
