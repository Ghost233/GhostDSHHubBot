/** Durable history for GitHub and timer work. Delivery is a projection of channel Outbox evidence. */
import { STAGES, TaskBoard } from './tasks.js'

const RUN_KEY = 'run-audit:run-'
const RUN_KEY_END = 'run-audit:run.' // Exclusive upper bound for the SQLite primary-key prefix scan.
const TRIGGER_KEY = 'run-audit:trigger:'
const OUTBOX_KEY = 'run-audit:outbox:'
const BACKFILL_KEY = 'run-audit:backfilled'
const SOURCES = ['github', 'timer']
const RESULT_KINDS = ['result', 'failure', 'blocked']
const WAITING_STATES = ['held', 'queued', 'recorded']
const OUTBOX_STATES = [...WAITING_STATES, 'sent', 'failed']
const RUN_STATUSES = ['in-progress', 'silent', 'waiting', 'sent', 'failed']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const SILENCE_REASONS = Object.freeze({
  'no-change': '本次检查没有变化。',
  'no-new-information': '本次没有新增信息。',
  'already-reported': '结果已在此前汇报。',
  'progress-only': '普通进展留在面板供查询。',
})

function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const at = new Date(value)
  return Number.isFinite(at.getTime()) ? at.toISOString() : null
}

function identifier(value) {
  return typeof value === 'string' && /^[a-z0-9_:@./+-]{1,512}$/i.test(value) ? value : null
}

function validOwnerId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\p{Cc}]/u.test(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function projectSource(source) {
  if (source.kind === 'github') {
    const repo = typeof source.repo === 'string' && /^[a-z0-9_-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/i.test(source.repo) ? source.repo : null
    const issueNumber = positiveInteger(source.issueNumber) ? source.issueNumber : null
    const commentId = positiveInteger(source.commentId) ? source.commentId : null
    const event = ['issue', 'pr', 'comment'].includes(source.event) ? source.event : null
    // Construct the canonical source link from identifiers. Incoming URLs may embed credentials or query strings.
    const url = repo && issueNumber && 'https://github.com/' + repo + (event === 'pr' ? '/pull/' : '/issues/') + issueNumber
      + (commentId ? '#issuecomment-' + commentId : '')
    return { kind: 'github', ...(repo && { repo }), ...(issueNumber && { issueNumber }), ...(event && { event }),
      ...(commentId && { commentId }), ...(url && { url }) }
  }
  const timerId = identifier(source.timerId)
  const occurrenceId = identifier(source.occurrenceId)
  const fireAt = timestamp(source.fireAt)
  const originTriggerId = source.origin?.kind === 'feishu' && identifier(source.origin.triggerId)
  return { kind: 'timer', ...(timerId && { timerId }), ...(occurrenceId && { occurrenceId }), ...(fireAt && { fireAt }),
    ...(typeof source.late === 'boolean' && { late: source.late }),
    ...(originTriggerId && { origin: { kind: 'feishu', triggerId: originTriggerId } }) }
}

function channelEvidence(row) {
  const channel = typeof row?.to === 'string' ? /^(github|feishu):/.exec(row.to)?.[1] : null
  if (!channel || !identifier(row.id)) return undefined
  const state = OUTBOX_STATES.includes(row.state) ? row.state : 'unknown'
  const settledWith = identifier(row.settledWith)
  return {
    id: row.id, channel, state,
    channelAccepted: state === 'sent',
    acceptedAt: state === 'sent' ? timestamp(row.sentAt) : null,
    createdAt: timestamp(row.createdAt),
    attempts: positiveInteger(row.attempts) ? row.attempts : 0,
    ...(settledWith && settledWith !== row.id && { settledWith }),
  }
}

function readChannelEvidence(store, id) {
  const row = store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(id)
  if (row) return channelEvidence(JSON.parse(row.value))
  const archived = store.get(OUTBOX_KEY + id)
  return archived?.discarded ? archived : undefined
}

function markLinkedOutbox(store, id) {
  if (id && !store.get(OUTBOX_KEY + id)) store.set(OUTBOX_KEY + id, true)
}

/** Keep a linked channel outcome when a dead letter is discarded in the caller's transaction. */
export function archiveRunNotification(store, row) {
  const evidence = channelEvidence(row)
  if (!evidence) return false
  const key = OUTBOX_KEY + evidence.id
  // A final aggregate can be assigned after its member was linked to a run.
  const linked = store.get(key) || store.db.prepare(`SELECT 1 FROM outbox AS member
    JOIN kv AS link ON link.key = ? || member.id
    WHERE json_extract(member.value, '$.settledWith') = ? LIMIT 1`).get(OUTBOX_KEY, evidence.id)
  if (!linked) return false
  markLinkedOutbox(store, evidence.settledWith)
  store.set(key, { ...evidence, discarded: true })
  return true
}

function notificationStatus(notification) {
  if (notification?.state === 'sent' || notification?.state === 'failed') return notification.state
  return WAITING_STATES.includes(notification?.state) ? 'waiting' : 'in-progress'
}

function transaction(store, write) {
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

export class RunAudit {
  #store
  #now
  #tasks

  constructor({ store, now = () => new Date().toISOString() }) {
    this.#store = store
    this.#now = now
    this.#tasks = new TaskBoard({ store, now })
    this.#backfill()
  }

  #backfill() {
    if (this.#store.get(BACKFILL_KEY)) return
    transaction(this.#store, () => {
      if (this.#store.get(BACKFILL_KEY)) return
      const legacy = this.#store.db.prepare(`SELECT ticket.value AS ticket, trigger.value AS trigger
        FROM ticket JOIN trigger ON trigger.id = json_extract(ticket.value, '$.triggerId')
        WHERE json_extract(ticket.value, '$.background.kind') IN ('github', 'timer') ORDER BY ticket.rowid`).all()
      for (const row of legacy) {
        const ticket = JSON.parse(row.ticket)
        const trigger = JSON.parse(row.trigger)
        const { id: ticketId, triggerId: triggerRef, owner: ownerId, background } = ticket
        const at = timestamp(ticket.createdAt) ?? timestamp(trigger.at)
        if (!at || !identifier(ticketId) || !identifier(triggerRef) || !validOwnerId(ownerId)) continue
        if (trigger.dropped || trigger.id !== triggerRef || trigger.kind !== background.kind || trigger.source?.kind !== trigger.kind
          || (trigger.ownerId && trigger.ownerId !== ownerId)) continue
        if (this.#store.get(RUN_KEY + ticketId) || this.#store.get(TRIGGER_KEY + triggerRef)) continue
        this.ensure({ ticketId, triggerRef, ownerId, source: trigger.source, at })
        const results = [
          { kind: 'result', at: timestamp(ticket.report?.at) },
          { kind: 'failure', at: timestamp(ticket.failed?.at) },
          { kind: 'blocked', at: timestamp(ticket.escalated?.at) },
        ].filter(result => result.at).sort((a, b) => a.at.localeCompare(b.at))
        for (const result of results) this.recordResult(ticketId, result)
      }
      this.#store.set(BACKFILL_KEY, true)
    })
  }

  /** Store a single run alongside its background ticket, participating in the caller's transaction. */
  ensure({ ticketId, triggerRef, ownerId, source, at } = {}) {
    if (!SOURCES.includes(source?.kind)) throw new TypeError('A GitHub or timer background source is required.')
    if (!identifier(ticketId) || !identifier(triggerRef) || !validOwnerId(ownerId)) throw new TypeError('Run identity fields are required.')
    const createdAt = this.#time(at)
    const key = RUN_KEY + ticketId
    const triggerKey = TRIGGER_KEY + triggerRef
    return transaction(this.#store, () => {
      const triggerTicket = this.#store.get(triggerKey)
      if (triggerTicket !== undefined && triggerTicket !== ticketId) {
        throw new Error('This background trigger already belongs to another ticket.')
      }
      const existing = this.#store.get(key)
      if (existing) {
        if (existing.triggerRef !== triggerRef || existing.ownerId !== ownerId || existing.source.kind !== source.kind) {
          throw new Error('This run already belongs to another trigger or owner.')
        }
        return this.#project(existing)
      }
      const run = { id: 'run-' + ticketId, ticketId, triggerRef, ownerId, source: projectSource(source), createdAt }
      this.#store.set(key, run)
      this.#store.set(triggerKey, ticketId)
      return this.#project(run)
    })
  }

  /** Record the worker's explicit decision to end without a notification. */
  recordSilent(ticketId, reasonCode) {
    if (typeof reasonCode !== 'string' || !Object.hasOwn(SILENCE_REASONS, reasonCode)) {
      throw new TypeError('A recognized silence reason is required.')
    }
    return this.#change(ticketId, run => {
      const decisions = run.decisions ?? []
      const previous = decisions.at(-1)
      if (previous?.kind === 'silent' && previous.reasonCode === reasonCode) return run
      return { ...run, decisions: [...decisions, { kind: 'silent', reasonCode, at: this.#time() }] }
    })
  }

  /** Record the exact result reference. Report text stays in the authenticated task/report view. */
  recordResult(ticketId, { kind, reportId = null, at } = {}) {
    if (!RESULT_KINDS.includes(kind)) throw new TypeError('A recognized background result kind is required.')
    if (reportId !== null && !identifier(reportId)) throw new TypeError('A valid report ID is required.')
    const result = { ticketId, kind, reportId, at: this.#time(at) }
    return this.#change(ticketId, run => {
      const results = run.results ?? []
      const recorded = results.some(fact => fact.kind === kind && fact.reportId === reportId
        && (reportId !== null || fact.at === result.at))
      return recorded ? run : { ...run, results: [...results, result] }
    })
  }

  /** Link a channel notification once its Outbox row has been persisted. */
  linkOutbox(ticketId, outboxId) {
    if (!identifier(outboxId)) throw new TypeError('A channel Outbox row ID is required.')
    return this.#change(ticketId, run => {
      const decisions = run.decisions ?? []
      if (decisions.some(decision => decision.outboxId === outboxId)) return run
      const row = readChannelEvidence(this.#store, outboxId)
      if (!row) throw new Error('A stored channel Outbox row is required.')
      const decision = { kind: 'notification', outboxId, at: this.#time() }
      markLinkedOutbox(this.#store, outboxId)
      markLinkedOutbox(this.#store, row.settledWith)
      return { ...run, decisions: [...decisions, decision] }
    })
  }

  /** Get one exact run ID. */
  get(runId) {
    if (typeof runId !== 'string' || !runId.startsWith('run-') || !identifier(runId.slice(4))) return undefined
    const run = this.#store.get(RUN_KEY + runId.slice(4))
    return run && this.#project(run)
  }

  /** List newest runs in the requested scope. Pagination applies after delivery status filtering. */
  list({ ownerId, ticketId, triggerRef, source, status, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    if (!positiveInteger(limit)) throw new TypeError('Run list limit must be a positive integer.')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Run list offset must be a non-negative integer.')
    if (source !== undefined && !SOURCES.includes(source)) throw new TypeError('A recognized run source filter is required.')
    if (status !== undefined && !RUN_STATUSES.includes(status)) throw new TypeError('A recognized run status filter is required.')
    if ((ownerId !== undefined && !validOwnerId(ownerId)) || (ticketId !== undefined && !identifier(ticketId))
      || (triggerRef !== undefined && !identifier(triggerRef))) throw new TypeError('A valid run scope identifier is required.')

    if (triggerRef !== undefined) {
      const match = this.#store.get(TRIGGER_KEY + triggerRef)
      if (!match || (ticketId !== undefined && ticketId !== match)) return []
      ticketId = match
    }
    const selected = []
    const pageSize = Math.min(limit, MAX_LIMIT)
    const conditions = ticketId ? ['key = ?'] : ['key >= ?', 'key < ?']
    const params = ticketId ? [RUN_KEY + ticketId] : [RUN_KEY, RUN_KEY_END]
    if (ownerId !== undefined) {
      conditions.push("json_extract(value, '$.ownerId') = ?")
      params.push(ownerId)
    }
    if (source !== undefined) {
      conditions.push("json_extract(value, '$.source.kind') = ?")
      params.push(source)
    }
    const rows = this.#store.db.prepare(`SELECT value FROM kv WHERE ${conditions.join(' AND ')}
      ORDER BY json_extract(value, '$.createdAt') DESC, key DESC`).iterate(...params)
    for (const { value } of rows) {
      const run = this.#project(JSON.parse(value), false)
      if (status !== undefined && run.status !== status) continue
      if (offset > 0) {
        offset--
        continue
      }
      selected.push(run)
      if (selected.length >= pageSize) break
    }
    return selected
  }

  #time(value = this.#now()) {
    const at = timestamp(value)
    if (!at) throw new TypeError('A valid run timestamp is required.')
    return at
  }

  #change(ticketId, change) {
    if (!identifier(ticketId)) throw new TypeError('A background ticket ID is required.')
    const key = RUN_KEY + ticketId
    return transaction(this.#store, () => {
      const previous = this.#store.get(key)
      if (!previous) throw new Error('Background run not found.')
      const next = change(previous)
      if (next !== previous) this.#store.set(key, next)
      return this.#project(next)
    })
  }

  #notification(id) {
    const linked = readChannelEvidence(this.#store, id)
    if (linked?.settledWith) {
      const final = readChannelEvidence(this.#store, linked.settledWith)
      if (final?.channel === linked.channel) return { ...final, linkedId: id }
      return { id: linked.settledWith, linkedId: id, channel: linked.channel, state: 'missing', channelAccepted: false, acceptedAt: null }
    }
    return linked ?? { id, channel: null, state: 'missing', channelAccepted: false, acceptedAt: null }
  }

  #project({ decisions = [], results = [], ...run }, detail = true) {
    const current = decisions.at(-1)
    const notification = current?.kind === 'notification' ? this.#notification(current.outboxId) : null
    const reason = current?.kind === 'silent' ? SILENCE_REASONS[current.reasonCode] : null
    const ticket = this.#tasks.getTicket(run.ticketId)
    const stage = STAGES.includes(ticket?.stage) ? ticket.stage : null
    const sessionId = identifier(ticket?.workerSession?.sessionId)
    const workerSession = sessionId ? { sessionId, at: timestamp(ticket.workerSession.at) } : null
    const summary = {
      ...run, stage, workerSession, result: results.at(-1) ?? null, reason, notification,
      status: reason ? 'silent' : notificationStatus(notification),
    }
    if (!detail) return summary
    const notifications = decisions.filter(decision => decision.kind === 'notification')
      .map(decision => decision === current ? notification : this.#notification(decision.outboxId))
    return { ...summary, results, decisions, notifications }
  }
}
