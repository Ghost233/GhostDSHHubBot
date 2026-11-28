import { DANGEROUS_INJECT_ACTION } from './security.js'
import { CONFIRM_TIMEOUT_MS, STAGES, STAGE_TEXT, normalizeStage, stageDetail } from './tasks.js'

const WAITING_STAGES = new Set(['person/answer', 'person/confirm', 'person/review'])
const BACKGROUND_REPORT_PREFIX = '[hub-bot 后台结果] '
const TICKET_WITH_TRIGGER = `
  SELECT t.value, trg.id AS triggerId, trg.at AS triggerAt,
    json_extract(trg.value, '$.kind') AS triggerKind, trg.value -> '$.source' AS source,
    json_extract(trg.value, '$.message') AS message
  FROM ticket t LEFT JOIN trigger trg ON trg.id = json_extract(t.value, '$.triggerId')
`
const REPORT_OWNER_FILTER = `(
  (json_extract(o.value, '$.kind') = 'digest' AND json_extract(o.value, '$.ownerId') = :ownerId)
  OR (json_extract(o.value, '$.kind') = 'background-report'
    AND json_extract(o.value, '$.to') = 'owner:' || :ownerId
    AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = json_extract(o.value, '$.ticketId')
      AND json_extract(t.value, '$.owner') = :ownerId))
)`

function registeredOwner(store, ownerId) {
  if (typeof ownerId !== 'string' || !ownerId || store.closed) return undefined
  const row = store.db.prepare('SELECT value FROM owner WHERE id = ?').get(ownerId)
  if (!row) return undefined
  const owner = JSON.parse(row.value)
  return owner.recycled === true ? undefined : owner
}

function normalizedTicket(value) {
  const ticket = JSON.parse(value)
  return { ...ticket, stage: normalizeStage(ticket.stage) }
}

function readReportRecordIndex(store, ownerId) {
  return store.db.prepare(`
    SELECT o.id, 'outbox' AS kind, o.at, json_extract(o.value, '$.kind') AS reportKind,
      json_extract(o.value, '$.state') AS state, json_extract(o.value, '$.ticketId') AS ticketId
    FROM outbox o WHERE ${REPORT_OWNER_FILTER}
    ORDER BY o.at DESC, o.id
  `).all({ ownerId }).map(row => ({ ...row }))
}

/** Looks up the exact ticket or a stored report snapshot by persisted ID within one owner. */
export function readOwnerFactDetail({ store, ownerId, kind, id }) {
  if (typeof id !== 'string' || !id || !registeredOwner(store, ownerId)) return undefined
  if (kind === 'ticket') {
    const row = store.db.prepare(`
      ${TICKET_WITH_TRIGGER} WHERE t.id = ? AND json_extract(t.value, '$.owner') = ?
    `).get(id, ownerId)
    if (!row) return undefined
    const ticket = normalizedTicket(row.value)
    if (row.triggerId) {
      ticket.trigger = { id: row.triggerId, kind: row.triggerKind, at: row.triggerAt,
        source: JSON.parse(row.source ?? 'null'), message: row.message }
    }
    return ticket
  }
  if (kind !== 'outbox') return undefined
  const row = store.db.prepare(`
    SELECT o.value FROM outbox o WHERE o.id = :id AND ${REPORT_OWNER_FILTER}
  `).get({ id, ownerId })
  if (!row) return undefined
  const report = JSON.parse(row.value)
  const summaries = report.kind === 'digest' && Array.isArray(report.bodyLines)
    ? report.bodyLines.filter(line => typeof line === 'string') : []
  if (report.kind === 'background-report' && typeof report.body === 'string' && report.body.startsWith(BACKGROUND_REPORT_PREFIX)) {
    summaries.push(report.body.slice(BACKGROUND_REPORT_PREFIX.length))
  }
  return { id, kind: report.kind, state: report.state, requestId: report.requestId ?? null,
    ticketId: report.ticketId ?? null, triggerId: report.triggerId ?? null, at: report.createdAt, summaries }
}

function byRecent(field) {
  return (a, b) => {
    const first = a[field] ?? ''
    const second = b[field] ?? ''
    if (first !== second) return first > second ? -1 : 1
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
  }
}

function indexed(entries) {
  return { entries, total: entries.length }
}

function currentWaitingRequest(ticket) {
  const request = ticket.deferred
  if (!request || !['pending', 'accepted'].includes(request.status)) return undefined
  const stage = request.type === 'confirm' ? 'person/confirm' : 'person/answer'
  const question = request.type === 'confirm' ? ticket.pendingConfirm : ticket.question
  if (ticket.stage !== stage || !question) return undefined
  const transitions = ticket.transitions ?? []
  if (request.waitRevision !== undefined) {
    return transitions.length === request.waitRevision ? request : undefined
  }
  // Older waits recorded an instant without a transition revision.
  const leftWait = transitions.some(event => event.from === stage && Date.parse(event.at) >= Date.parse(request.openedAt))
  return leftWait ? undefined : request
}

function queuedAnswer(ticket) {
  const request = ticket.deferred
  if (ticket.stage !== 'working' || request?.status !== 'fulfilled'
    || request.outcome?.decision !== 'answer' || request.outcome.delivery?.state !== 'queued') return undefined
  if (request.waitRevision !== undefined && (ticket.transitions?.length ?? 0) !== request.waitRevision + 1) return undefined
  return request
}

function legacyConfirmationTarget(ticket) {
  const action = ticket.pendingConfirm?.action
  if (action?.sessionId) return { sessionId: action.sessionId }
  if (action?.type !== DANGEROUS_INJECT_ACTION || !['route', 'follow-up'].includes(action.entry)) return null
  return { ownerId: ticket.owner, ...(ticket.targetSession && { sessionId: ticket.targetSession }) }
}

function pendingFact(ticket, source) {
  const answer = queuedAnswer(ticket)
  if (!answer && !WAITING_STAGES.has(ticket.stage)) return undefined
  const request = answer ?? currentWaitingRequest(ticket)
  const confirming = ticket.stage === 'person/confirm'
  const stale = !request && ticket.deferred && ticket.stage !== 'person/review'
  const origin = source?.kind === 'timer' ? source.origin ?? source : source
  const openedAt = request?.openedAt ?? (confirming ? ticket.pendingConfirm?.at
    : ticket.stage === 'person/answer' ? ticket.question?.at : ticket.report?.at) ?? null
  const legacyDeadline = confirming && !ticket.deferred && Number.isFinite(Date.parse(openedAt))
    ? new Date(Date.parse(openedAt) + CONFIRM_TIMEOUT_MS).toISOString() : null
  return {
    kind: 'ticket', id: ticket.id, stage: ticket.stage, requestId: request?.requestId ?? null,
    status: request?.status ?? (stale ? 'stale' : 'waiting'), question: (answer ? ticket.question?.text : stageDetail(ticket)) ?? null,
    openedAt, expiresAt: request?.expiresAt ?? legacyDeadline,
    receiver: request ? request.receiver : { kind: 'owner', ownerId: ticket.owner },
    target: request ? request.target : confirming && !ticket.deferred ? legacyConfirmationTarget(ticket) : null,
    source: request ? request.source : origin,
    requester: request?.requester ?? null,
    authorization: ticket.authorization ?? null,
    deliveryState: answer?.outcome.delivery.state ?? null,
  }
}

function workerFacts(store, ownerId, tickets, isArchived) {
  const knownOwnerSessions = new Set()
  for (const { value } of store.db.prepare('SELECT value FROM owner').iterate()) {
    const owner = JSON.parse(value)
    knownOwnerSessions.add(owner.sessionId)
    if (Array.isArray(owner.previousSessionIds)) {
      for (const sessionId of owner.previousSessionIds) knownOwnerSessions.add(sessionId)
    }
  }
  const recurring = new Set(store.db.prepare(`
    SELECT id FROM timer WHERE owner = ?
      AND json_extract(value, '$.schedule.frequency') IN ('daily', 'weekly')
      AND json_extract(value, '$.status') IN ('pending', 'paused', 'firing')
  `).all(ownerId).map(timer => timer.id))
  const entries = []
  for (const ticket of tickets) {
    const worker = ticket.workerSession
    const sessionId = worker?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) continue
    const timerId = ticket.background?.kind === 'timer' ? ticket.background.timerId ?? null : null
    // Tickets arrive newest first, matching the Router's choice of the last bound timer occurrence.
    const retainedForTimer = recurring.delete(timerId)
    if (!retainedForTimer && ['done', 'failed'].includes(ticket.stage)) continue
    if (!ticket.authorization || knownOwnerSessions.has(sessionId) || isArchived(sessionId)) continue
    entries.push({ kind: 'ticket', id: ticket.id, stage: ticket.stage, sessionId, cwd: worker.cwd ?? null,
      timerId, retainedForTimer, updatedAt: worker.at ?? ticket.updatedAt ?? null })
  }
  return entries.sort(byRecent('updatedAt'))
}

/** Sync snapshot of durable owner facts. Supply the host's synchronous archive check when available. */
export function buildOwnerFacts({ store, ownerId, isArchived = () => false }) {
  const owner = registeredOwner(store, ownerId)
  if (!owner) return undefined
  const { id, role, kind, workspace, cwd, sessionId, status, transient } = owner
  const rows = store.db.prepare(`
    ${TICKET_WITH_TRIGGER} WHERE json_extract(t.value, '$.owner') = ?
    ORDER BY t.rowid DESC
  `).all(ownerId)
  const tickets = rows.map(({ value }) => normalizedTicket(value))
  const entries = tickets.map((ticket, index) => ({
    kind: 'ticket', id: ticket.id, stage: ticket.stage, triggerId: ticket.triggerId ?? null,
    requestId: ticket.requestId ?? null, updatedAt: ticket.updatedAt ?? ticket.createdAt ?? null,
    title: ticket.routedMessage ?? rows[index].message ?? null, detail: stageDetail(ticket) ?? null,
  })).sort(byRecent('updatedAt'))
  const byStage = Object.fromEntries(STAGES.filter(stage => stage !== 'done').map(stage => [stage, 0]))
  const active = entries.filter(ticket => Object.hasOwn(byStage, ticket.stage))
  const pending = tickets.map((ticket, index) => pendingFact(ticket, JSON.parse(rows[index].source ?? 'null')))
    .filter(Boolean).sort(byRecent('openedAt'))
  const reports = tickets.filter(ticket => typeof ticket.report?.summary === 'string').map(ticket => ({
    kind: 'ticket', id: ticket.id, stage: ticket.stage, at: ticket.report.at ?? null, summary: ticket.report.summary,
  })).sort(byRecent('at'))
  for (const { stage } of active) byStage[stage]++
  return {
    owner: { id, role, kind, workspace: workspace ?? null, cwd, sessionId: sessionId ?? null, status, transient: transient === true },
    tickets: indexed(entries),
    activeTasks: { ...indexed(active), byStage },
    pending: indexed(pending),
    reports: indexed(reports),
    reportRecords: indexed(readReportRecordIndex(store, ownerId)),
    workers: indexed(workerFacts(store, ownerId, tickets, isArchived)),
  }
}

const INDEX_FIELDS = new Map([
  ['tickets', ['stage', 'requestId', 'triggerId', 'updatedAt']],
  ['activeTasks', ['stage', 'requestId', 'triggerId', 'updatedAt']],
  ['workers', ['stage', 'sessionId', 'timerId', 'retainedForTimer', 'updatedAt']],
  ['pending', ['stage', 'requestId', 'status', 'openedAt', 'expiresAt', 'deliveryState']],
  ['reports', ['stage', 'at']],
  ['reportRecords', ['reportKind', 'ticketId', 'state', 'at']],
])

/** A deterministic page of lookup references for the current owner facts. Use nextOffset for the next page. */
export function listOwnerFactIndex({ store, ownerId, section = 'tickets', offset = 0, limit = 20, isArchived }) {
  const fields = INDEX_FIELDS.get(section)
  if (!fields || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return undefined
  const facts = buildOwnerFacts({ store, ownerId, isArchived })
  if (!facts) return undefined
  const { entries, total } = facts[section]
  const end = Math.min(offset + Math.min(limit, 50), total)
  const keys = ['kind', 'id', ...fields]
  return {
    entries: entries.slice(offset, end).map(entry => Object.fromEntries(keys.map(key => [key, entry[key]]))),
    total, nextOffset: end < total ? end : null,
  }
}

function excerpt(value, maxLength) {
  if (typeof value !== 'string') return ''
  const line = value.replace(/\s+/gu, ' ').trim()
  if (line.length <= maxLength) return line
  return line.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + '…'
}

function stageLabel(stage) {
  return Object.hasOwn(STAGE_TEXT, stage) ? STAGE_TEXT[stage] : excerpt(stage, 30)
}

function destination(value) {
  return [excerpt(value?.kind, 16), excerpt(value?.ownerId, 64), excerpt(value?.sessionId, 80)].filter(Boolean).join('/')
}

function pendingLine(item) {
  const receiver = destination(item.receiver)
  const target = destination(item.target)
  const source = [excerpt(item.source?.kind, 16), excerpt(item.source?.chatId, 80)].filter(Boolean).join('/')
  return [excerpt(item.id, 92), stageLabel(item.stage),
    item.requestId && '原请求 ' + excerpt(item.requestId, 92),
    item.deliveryState === 'queued' ? '答复已保存，待投递' : '状态 ' + excerpt(item.status, 18),
    item.expiresAt && '原截止 ' + excerpt(item.expiresAt, 48),
    receiver && '接收方 ' + receiver, target && '动作目标 ' + target, source && '原来源 ' + source,
    excerpt(item.question, 100),
  ].filter(Boolean).join(' · ')
}

function preview(label, section, facts, render, maxRows, budget) {
  const { entries, total } = facts[section]
  const lines = [label + ' ' + total]
  let used = 0
  for (const entry of entries.slice(0, maxRows)) {
    const line = '- ' + render(entry)
    if (used + line.length + 1 > budget) break
    used += line.length + 1
    lines.push(line)
  }
  const remaining = total - (lines.length - 1)
  if (remaining > 0) lines.push('其余 ' + remaining + ' 条见索引 ' + section)
  return lines.join('\n')
}

/** Bounded, model-readable cold-start context. Exact contents stay accessible through the index. */
export function formatOwnerFacts(facts) {
  if (!facts) return ''
  const { owner, activeTasks } = facts
  const chief = owner.role === 'chief'
  const counts = STAGES.filter(stage => activeTasks.byStage[stage] > 0)
    .map(stage => stageLabel(stage) + ' ' + activeTasks.byStage[stage]).join('，')
  return [
    '[hub-bot 负责人事实]',
    [chief ? 'L1 总负责人' : 'L2 负责人', excerpt(owner.id, 120), excerpt(owner.kind, 20),
      owner.workspace && '工作区 ' + excerpt(owner.workspace, 120), '目录 ' + excerpt(owner.cwd, 220),
      owner.sessionId ? '当前会话 ' + excerpt(owner.sessionId, 92) : '当前未绑定',
    ].filter(Boolean).join(' · '),
    chief ? '职责 路由到注册负责人，按票面归类和汇总。' : '职责 管理绑定目录内的任务，协调 L3 并汇报票面结果。',
    '负责人使用只读工具，执行交由 L3。项目约定查阅绑定目录内的文档。',
    '阶段与授权以持久票面为准。回答按原请求和期限接续，负责人接收方跟随稳定身份，执行会话接收方与动作目标按原记录。已保存的答复由投递流程接续。',
    preview('待处理事项', 'pending', facts, pendingLine, 5, 1350),
    counts && '未完成阶段 ' + counts,
    preview('未完成任务', 'activeTasks', facts, item => [excerpt(item.id, 92), stageLabel(item.stage),
      excerpt(item.title ?? item.detail, 128)].filter(Boolean).join(' · '), 5, 900),
    preview('L3 执行入口', 'workers', facts, item => [excerpt(item.id, 92), excerpt(item.sessionId, 92),
      item.timerId && 'timer ' + excerpt(item.timerId, 72), item.retainedForTimer && '保留供后续点火'].filter(Boolean).join(' · '), 4, 650),
    preview('近期报告', 'reports', facts, item => [excerpt(item.id, 92), excerpt(item.at, 48), excerpt(item.summary, 128)]
      .filter(Boolean).join(' · '), 4, 640),
    preview('已存汇报记录', 'reportRecords', facts, item => [excerpt(item.id, 92), excerpt(item.reportKind, 30), excerpt(item.at, 48)]
      .filter(Boolean).join(' · '), 3, 550),
    '完整任务索引共 ' + facts.tickets.total + ' 条。用 read_owner_fact({ section: "tickets", offset: 0 }) 或指定上方索引，按 nextOffset 翻页。',
    '用条目的 kind 与 id 调用 read_owner_fact({ kind, id }) 查阅原始票面、授权记录或已存汇报。',
  ].filter(Boolean).join('\n')
}
