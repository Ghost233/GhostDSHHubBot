/**
 * The routing core behind the L1 tools (spec「工具契约」route_to_owner / query_tasks / reply_source).
 *
 * Everything routes through a narrow Sessions port so the policy — lazy owner creation, deleted-Session
 * rebuild, trigger idempotency — is unit-testable without a DSH runtime; src/index.js wires the real
 * sessionController into the same port.
 *
 * 先存后做 (spec「可靠性」+ #66): routeToOwner writes the Trigger, the Ticket (stage idle 待触发） and the
 * Outbox row BEFORE any prompt is admitted; the OutboxRunner then delivers, retrying with backoff and keeping
 * per-ticket order. A crash after any step leaves the store able to say exactly what happened, and a restart
 * resumes unfinished deliveries.
 *
 * 票面权威 (#66): a follow-up never binds a new Trigger and never re-binds authorization — passing
 * authorization on a follow-up is rejected; the Ticket's stored authorization record is the only one the
 * injection carries, whatever the conversation narrative claims. A ticket whose authorization record is
 * missing is failed permanently （缺上下文升级不编造）, never executed on a guess.
 */
import { randomUUID } from 'node:crypto'
import { TaskBoard, STAGE_TEXT, normalizeStage, translateTaskError, CONFIRM_TIMEOUT_MS } from './tasks.js'
import { OutboxRunner, insertOutbox, updateOutboxRow } from './outbox.js'
import { feishuPrompt, UNSUPPORTED_MESSAGE_TYPE } from './inbox.js'
import { truncateWords } from './discipline.js'
import { buildDigestText, buildAutoSummary, factLine } from './reporting.js'
import { isWithinCwd } from './paths.js'
import { confirmTicketFork } from './fork.js'
import { buildOwnerFacts, formatOwnerFacts } from './owner-facts.js'
import { RunAudit, SILENCE_REASONS } from './runs.js'
import { DANGEROUS_INJECT_ACTION, DEFAULT_DANGEROUS_PATTERNS, findDangerousPattern, dangerousConfirmText } from './security.js'

/** A routing failure with a machine-readable code for tool/API surfaces. */
export class RouterError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RouterError'
    this.code = code
  }
}

/** The recovery note carried exactly once into the first injection after a host restart (spec: 重启恢复）. */
export const RECOVERY_NOTE = '（重启恢复：先检查目录与 git 状态，再重复任何对外动作）'

/** True when a prompt failure means the Session record is gone (deleted), not a transient/provider failure. */
function isMissingSession(error) {
  if (error?.name === 'ApiSessionNotFound') return true
  const message = String(error?.message ?? error)
  // Observed live: the runtime rejects with Error('session "<id>" not found') — quoted id, plain Error name.
  return /session\b[^\n]*\bnot found/i.test(message) || /absent from persistence|unknown session/i.test(message)
}

export class Router {
  /**
   * @param {{ store: import('./store.js').Store, registry: import('./registry.js').OwnerRegistry,
   *   sessions: { create: (request: any) => Promise<any>, prompt: (request: any) => Promise<any>, isRunning?: (sessionId: string) => Promise<boolean> },
   *   tasks?: import('./tasks.js').TaskBoard, runner?: import('./outbox.js').OutboxRunner,
   *   config?: { reporting?: { auto: boolean, intervalMs: number } },
   *   now?: () => string, ids?: { uuid: () => string },
   *   onSystemProblem?: (problem: object) => void }} deps
   */
  #lastAutoReportAt = null
  #lastAutoReportText = null
  // Owner queues protect execution slots. Trigger queues prevent duplicate tickets across owners.
  #queues = new Map()
  #currentStops = new Map()
  #applyingPanelDecisions = new Map()

  constructor({ store, registry, sessions, tasks, runner, config, now, ids, onSystemProblem, placer }) {
    this.store = store
    this.registry = registry
    this.sessions = sessions
    this.config = config ?? { reporting: { auto: false, intervalMs: 60000 } }
    this.now = now ?? (() => new Date().toISOString())
    this.ids = ids ?? { uuid: () => randomUUID() }
    // The lifecycle guard lives in TaskBoard (#66); Router drives tickets through it, never around it.
    this.tasks = tasks ?? new TaskBoard({ store, now: this.now })
    this.runs = new RunAudit({ store, now: this.now })
    // 回收触发段 (#70): optional terminal-ticket callback (Recycler.maybeRecycleForTicket). Assigned by the
    // plugin root after construction; invoked after every router-initiated done/failed transition. Terminal
    // transitions that bypass the Router (owner-tools report-failure, channel 终止) are the Recycler sweep's job.
    this.onTicketTerminal = null
    // GUI 工作区归位 (#52): optional WorkspacePlacer; new owner/chief Sessions get registered into their
    // workspace right after creation. null (旧版 DSH 无该服务) 时静默跳过——展示层增强，不阻塞路由。
    this.placer = placer ?? null
    // #72 并发安全: per-owner promise chains serialize every routeToOwner (all entries — L1 tool, devApi,
    // 飞书, GitHub) and every promotion pass for that owner, so read-check-write sequences (slot counting)
    // never interleave. SQLite writes themselves are synchronous (node:sqlite) — the single-writer
    // discipline holds per statement; the chain guards the multi-statement admission decision.
    // Stored work lives in the OutboxRunner; its clock derives from this Router's clock so tests stay
    // deterministic. The deliverer is Router-internal: only it knows how to (re)bind owner Sessions.
    this.runner = runner ?? new OutboxRunner({
      store,
      now: () => Date.parse(this.now()),
      deliver: row => this.#deliverRow(row),
      onFailure: (row, reason) => this.#settleDeliveryFailure(row, reason),
      onSystemProblem,
    })
  }

  #persistWork(write) {
    const db = this.store.db
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

  installDeferred(book) {
    this.deferred = book
    book.setHandler('fork', input => this.#fulfillDeferred(input.request))
    book.setHandler(DANGEROUS_INJECT_ACTION, input => this.#fulfillDeferred(input.request))
    book.setCloseHandler(request => this.#enqueueDeferredOutcome(request))
  }

  #settleDeliveryFailure(row, reason) {
    if (row.kind === 'deferred-answer') {
      const requestId = row.id.slice('out-answer-'.length)
      if (this.deferred?.get(requestId)?.outcome?.decision === 'answer') this.deferred.recordAnswerDelivery(requestId, { state: 'failed', reason })
      return true
    }
    if (!row.ticketId) return false
    const ticket = this.tasks.getTicket(row.ticketId)
    if (row.kind === 'approved-owner-inject') {
      const requestId = row.requestId.slice('hub-bot-approved-'.length)
      if (this.#currentDeferredWork(row.ticketId, requestId)) this.tasks.fail({ ticketId: ticket.id, reason })
      return true
    }
    if (row.kind === 'background-recovery') {
      if (ticket?.stage === 'working' && ticket.recoveryPending) {
        const blocked = this.tasks.escalate({ ticketId: ticket.id, reason, by: 'system' })
        this.#enqueueBackgroundReport(blocked)
      }
      return true
    }
    if (row.kind !== 'inject' || !ticket?.background || row.requestId !== ticket.requestId) return false
    if (['idle', 'working'].includes(ticket.stage) && ticket.lastDelivery?.state !== 'sent') {
      this.#enqueueBackgroundReport(this.tasks.fail({ ticketId: ticket.id, reason }))
    }
    return true
  }

  #requireCurrentApproval(requestId) {
    const ticket = this.deferred.acceptedTicket(requestId)
    const owner = ticket && this.registry.get(ticket.owner)
    if (!owner || owner.recycled || !ticket.authorization) {
      throw new RouterError('stale-deferred', 'This confirmation and its original authority must still be present.')
    }
    const target = ticket.deferred.target
    if (target?.ownerId && target.sessionId && (owner.sessionId !== target.sessionId || this.sessions.isArchived?.(target.sessionId))) {
      throw new RouterError('deferred-target-invalid', 'The original owner session is unavailable. Request a new confirmation for the current session.')
    }
    return { ticket, owner }
  }

  async #fulfillDeferred(request) {
    const { ticket, owner } = this.#requireCurrentApproval(request.requestId)
    const target = request.target?.sessionId
    if (target && !request.target.ownerId) {
      const worker = await this.sessions.workerInfo?.(target)
      const current = this.#requireCurrentApproval(request.requestId)
      if (!worker || this.registry.isOwnerSession(target) || this.sessions.isArchived?.(target)
        || ['hub-bot-owner', 'hub-bot-router'].includes(worker.agentPreset) || !worker.cwd || !isWithinCwd(current.owner.cwd, worker.cwd)) {
        throw new RouterError('deferred-target-invalid', 'The original execution session is unavailable. Request a new confirmation for a different target.')
      }
    }
    if (request.action.type === 'fork') return this.#confirmPendingFork(owner, ticket, ticket.id, request.requestId)
    if (ticket.background && request.action.entry === 'route') {
      return this.#persistWork(() => {
        this.tasks.confirm({ ticketId: ticket.id, result: { deferred: request.requestId }, by: 'user' })
        const held = this.#workingCount(owner.id) > this.#slotsPerOwner()
        if (held) this.tasks.demote(ticket.id)
        this.runner.enqueue({
          ticketId: ticket.id, triggerId: ticket.triggerId, kind: 'inject', to: 'owner:' + owner.id,
          body: '[后台任务 ' + ticket.id + '] ' + request.action.message
            + '\n\n原请求授权：' + ticket.authorization.actor + ' 经 ' + ticket.authorization.source + ' 于 ' + ticket.authorization.at
            + '\n确认编号：' + request.requestId, requestId: ticket.requestId, held,
        })
        return { ticketId: ticket.id, stage: held ? 'queued' : 'working' }
      })
    }
    return this.#confirmDangerousInject(owner, ticket, ticket.id, request.requestId)
  }

  askWorker({ ticketId, sessionId, question }) {
    const ticket = this.tasks.getTicket(ticketId)
    if (!this.#canAskWorker(ticket, sessionId)) {
      throw new RouterError('worker-mismatch', 'Only the bound worker may ask a question for this active task')
    }
    return this.#persistWork(() => {
      this.tasks.markDelivered(ticketId)
      const result = this.openQuestion({ ticketId, question, workerSessionId: sessionId })
      return { ticketId, stage: result.stage }
    })
  }

  openQuestion({ ticketId, question, action, workerSessionId }) {
    return this.#persistWork(() => {
      const ticket = action ? this.tasks.askConfirm({ ticketId, question, action }) : this.tasks.ask({ ticketId, question })
      if (!this.deferred || !ticket.authorization?.actor) return ticket
      const origin = this.getTrigger(ticket.triggerId)?.source
      const returnTo = origin?.kind === 'timer' ? origin.origin ?? origin : origin
      const source = { ...returnTo, kind: returnTo?.kind ?? ticket.authorization.source, triggerId: returnTo?.triggerId ?? ticket.triggerId ?? null }
      const independentLaunch = ticket.background && action?.entry === 'route'
      const ownerSessionId = action && !action.sessionId && !independentLaunch ? this.registry.get(ticket.owner)?.sessionId : null
      const request = this.deferred.request({
        action: action ?? { type: 'ask-user' }, type: action ? 'confirm' : 'answer', ticketId, ownerId: ticket.owner, question,
        requester: { actor: returnTo?.actor ?? ticket.authorization.actor }, source,
        target: action?.sessionId ? { sessionId: action.sessionId } : action
          ? { ownerId: ticket.owner, ...(ownerSessionId && { sessionId: ownerSessionId }) } : null,
        receiver: workerSessionId ? { kind: 'worker', sessionId: workerSessionId } : { kind: 'owner', ownerId: ticket.owner },
      })
      if (source.kind === 'feishu' && source.chatId) {
        const command = '/hub-answer ' + request.requestId
        const commands = action ? '通过 ' + command + ' approve\n拒绝 ' + command + ' reject' : command + ' answer <回复>'
        const details = ['截止 ' + request.expiresAt, request.target?.sessionId && '目标会话 ' + request.target.sessionId].filter(Boolean)
        const notification = insertOutbox(this.store, {
          id: 'out-question-' + request.requestId, ticketId, triggerId: source.triggerId, kind: 'reply', state: 'recorded',
          to: 'feishu:chat:' + source.chatId, requestId: 'hub-bot-question-' + request.requestId,
          body: [question, ...details, commands].join('\n'),
        }, () => Date.parse(this.now()))
        if (this.#ensureRun(ticket)) this.runs.linkOutbox(ticket.id, notification.id)
      }
      return this.tasks.getTicket(ticketId)
    })
  }

  #isOriginalFeishuSender(request, actor, chatId) {
    return request.source.kind === 'feishu' && request.source.chatId === chatId && request.requester.actor === actor
  }

  async resolveDeferred({ requestId, ticketId, decision, text, channel, actor, chatId, receivedAt }) {
    const receipt = channel === 'panel' ? this.now() : receivedAt
    const request = this.deferred?.get(requestId)
    if (!request || (ticketId !== undefined && ticketId !== request.ticketId)) {
      throw new RouterError('unknown-deferred', 'The decision does not identify this request.')
    }
    if (channel !== 'panel' && !(channel === 'feishu' && this.#isOriginalFeishuSender(request, actor, chatId))) {
      throw new RouterError('deferred-actor-mismatch', 'The original sender must answer in the original Feishu chat, or use the authenticated panel.')
    }
    if (channel === 'panel' && this.#isTimelyDecision(request, decision, text, receipt, Date.parse(receipt))) {
      const row = insertOutbox(this.store, {
        kind: 'deferred-decision', state: 'queued', to: 'owner:' + request.ownerId,
        requestId: 'hub-bot-panel-decision-' + this.ids.uuid(),
        panelDecision: { requestId, ticketId: request.ticketId, decision, text: text ?? null, receivedAt: receipt },
      }, () => Date.parse(receipt))
      return this.#applyPanelDecision(row)
    }
    return this.#applyDeferredDecision(request, { decision, text, receivedAt: receipt })
  }

  #applyDeferredDecision(request, { decision, text, receivedAt }) {
    return this.#serialized('owner:' + request.ownerId, async () => {
      if (this.store.closed) throw new Error('Hub Bot stopped while processing this decision.')
      const { requestId } = request
      const ticket = this.tasks.getTicket(request.ticketId)
      if (!ticket?.authorization || ticket.deferred?.requestId !== requestId) {
        throw new RouterError('stale-deferred', 'This request is no longer the active decision for its task.')
      }
      const workerUnavailable = decision === 'answer' && this.deferred.get(requestId)?.status === 'pending' && request.receiver.kind === 'worker'
        && !await this.#canReceiveWorkerAnswer(ticket, request.receiver.sessionId)
      if (this.store.closed) throw new Error('Hub Bot stopped while processing this decision.')
      const result = await this.deferred.resolve({ requestId, decision, text, actor: { actor: request.requester.actor }, workerUnavailable, receivedAt })
      return { ticketId: ticket.id, requestId, stage: this.tasks.getTicket(ticket.id).stage, outcome: result.status, duplicate: result.duplicate }
    })
  }

  #applyPanelDecision(row) {
    const active = this.#applyingPanelDecisions.get(row.id)
    if (active) return active
    const recorded = reason => {
      if (this.store.closed) return
      const current = this.#outboxRow(row.id)
      if (current?.state === 'queued') updateOutboxRow(this.store, { ...current, state: 'recorded', recordedAt: this.now(),
        nextRetryAt: null, ...(reason && { skipReason: reason }) })
    }
    const running = (async () => {
      try {
        const input = row.panelDecision
        const request = this.deferred?.get(input.requestId)
        if (!request || request.ticketId !== input.ticketId) throw new RouterError('unknown-deferred', 'This decision has no matching request.')
        const result = await this.#applyDeferredDecision(request, input)
        recorded()
        return result
      } catch (error) {
        if (['TaskError', 'RouterError', 'DeferredError'].includes(error?.name)) recorded(error.code)
        throw error
      }
    })().finally(() => this.#applyingPanelDecisions.delete(row.id))
    this.#applyingPanelDecisions.set(row.id, running)
    return running
  }

  #enqueueDeferredOutcome(request) {
    if (request.status === 'answered' && request.outcome.decision === 'answer') {
      this.runner.enqueue({
        id: 'out-answer-' + request.requestId, kind: 'deferred-answer', ticketId: request.ticketId, triggerId: request.source.triggerId,
        to: 'owner:' + request.ownerId, requestId: 'hub-bot-answer-' + request.requestId,
        body: '[您的答复 ' + request.ticketId + '] ' + request.outcome.text,
      })
    } else if (request.status === 'expired') {
      const feishu = request.source.kind === 'feishu' && request.source.chatId
      insertOutbox(this.store, {
        id: 'out-expiry-' + request.requestId, kind: 'reply', ticketId: request.ticketId, triggerId: request.source.triggerId,
        to: feishu ? 'feishu:chat:' + request.source.chatId : 'dsh:session:chief',
        state: feishu ? 'recorded' : 'queued', requestId: 'hub-bot-expiry-' + request.requestId,
        body: '请求 ' + request.requestId + ' 已过期。',
      }, () => Date.parse(this.now()))
    }
  }

  async #canReceiveWorkerAnswer(ticket, sessionId) {
    if (!this.#isBoundWorker(ticket, sessionId)) return false
    if (!this.sessions.workerInfo) return true
    const worker = await this.sessions.workerInfo(sessionId)
    const live = this.tasks.getTicket(ticket.id)
    const owner = live && this.registry.get(live.owner)
    return Boolean(owner && !owner.recycled && this.#isBoundWorker(live, sessionId) && worker?.cwd
      && !['hub-bot-owner', 'hub-bot-router'].includes(worker.agentPreset) && isWithinCwd(owner.cwd, worker.cwd))
  }

  #currentDeferredWork(ticketId, requestId) {
    const ticket = this.tasks.getTicket(ticketId)
    if (!requestId || ticket?.stage !== 'working' || ticket.deferred?.requestId !== requestId || !ticket.authorization) return undefined
    const revision = ticket.deferred.waitRevision
    if (typeof revision === 'number' && ticket.transitions?.length !== revision + 1) return undefined
    return ticket
  }

  async #deliverDeferredAnswer(row) {
    const requestId = row.id.slice('out-answer-'.length)
    const request = this.deferred?.get(requestId)
    const current = () => request && this.#currentDeferredWork(request.ticketId, requestId)
    const inactive = { recorded: true, skipped: 'deferred-no-longer-active' }
    const ticket = current()
    const deliveryState = request?.outcome?.delivery?.state
    if (deliveryState === 'sent') return
    if (deliveryState === 'failed') return inactive
    const skipped = () => {
      if (request?.outcome?.decision === 'answer') this.deferred.recordAnswerDelivery(requestId, {
        state: 'failed', reason: 'The task moved on before the answer could be delivered.',
      })
      return inactive
    }
    if (!ticket) return skipped()
    const permanent = reason => Object.assign(new Error(reason), { permanent: true })
    const text = () => (current()?.recoveryPending ? RECOVERY_NOTE + '\n\n' : '') + row.body
    if (request.receiver.kind === 'worker') {
      const sessionId = request.receiver.sessionId
      const available = await this.#canReceiveWorkerAnswer(ticket, sessionId)
      if (!current()) return skipped()
      const unavailable = 'The original execution session is no longer available.'
      if (!available) throw permanent(unavailable)
      try {
        await this.sessions.prompt({ sessionId, requestId: row.requestId, text: text() })
      } catch (error) {
        if (isMissingSession(error) || error?.code === 'session/not-found') throw permanent(unavailable)
        throw error
      }
    } else {
      const owner = this.registry.get(request.ownerId)
      if (!owner || owner.recycled) throw permanent('The original owner is no longer available.')
      const delivered = await this.#promptOwner(owner.id, ticket.id, row.requestId, text(), current)
      if (!delivered) return skipped()
    }
    if (this.store.closed) return
    this.#persistWork(() => {
      this.deferred.recordAnswerDelivery(requestId, { state: 'sent' })
      if (current()?.recoveryPending) this.tasks.noteRecoveryCarried(ticket.id)
    })
  }

  #insertTrigger(row) {
    this.store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(row.id, JSON.stringify(row), row.at)
    return row
  }

  #insertTicket(row) {
    this.store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(row.id, JSON.stringify(row))
    return row
  }

  #updateTicket(row) {
    this.store.db.prepare('UPDATE ticket SET value = ? WHERE id = ?').run(JSON.stringify(row), row.id)
    return row
  }

  /** One Trigger row by id, or undefined. */
  getTrigger(id) {
    const raw = this.store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
    return raw === undefined ? undefined : JSON.parse(String(raw.value))
  }

  /** Save a Feishu receipt and its delivery intent together, before acknowledging the transport. */
  async acceptFeishuTrigger(incoming) {
    const { id } = incoming
    const { messageId } = incoming.source
    const requestId = 'hub-bot-feishu-' + messageId
    const outboxId = 'out-inbox-' + id
    const previous = this.getTrigger(id)
    const pending = this.#outboxRow(outboxId)
    const receipt = { triggerId: id, requestId, deduped: Boolean(previous), admitted: false, queued: false }
    if (previous && (pending || previous.intakeDiscarded || previous.intakeCohort || previous.injectedAt !== null || previous.dropped || !previous.authorization || incoming.dropped)) {
      return { ...receipt, dropped: previous.dropped ?? null, outboxId: pending?.id ?? null }
    }

    const command = !previous && !incoming.dropped && this.deferred
      ? /^[/]hub-answer +([a-z0-9-]+) +(approve|reject|answer)(?: +([\s\S]+))?$/.exec(incoming.message) : null,
      stop = !previous && !incoming.dropped && ['停', '停止'].includes(incoming.message)
    const sessionId = stop ? this.registry.get('chief')?.sessionId ?? null : null
    const skipStop = stop && (!sessionId ? 'no-current-session' : this.#currentStops.has(sessionId) ? 'interrupt-in-flight' : null)
    const trigger = {
      ...(previous ?? incoming),
      ownerId: 'chief',
      injectedAt: null,
      policy: previous?.policy ?? { ...incoming.policy, mode: incoming.dropped ? 'drop' : stop ? 'interrupt' : command ? 'decision' : 'queue' },
      ...(command && { decision: { requestId: command[1], decision: command[2], text: command[3] ?? '' } }),
    }
    this.#persistWork(() => {
      if (previous) this.#updateTrigger(trigger)
      else this.#insertTrigger(trigger)
      if (trigger.dropped === 'unsupported-type') {
        insertOutbox(this.store, {
          id: outboxId, ticketId: null, triggerId: id, kind: 'reply', to: 'feishu:chat:' + trigger.source.chatId,
          body: UNSUPPORTED_MESSAGE_TYPE, state: 'recorded', requestId: 'hub-bot-feishu-unsupported-' + messageId,
        }, () => Date.parse(trigger.at))
      } else if (skipStop) {
        insertOutbox(this.store, {
          id: outboxId, ticketId: null, triggerId: id, kind: 'stop', to: 'owner:chief',
          body: trigger.message, sessionId, requestId, state: 'recorded', recordedAt: this.now(), skipReason: skipStop,
        }, () => Date.parse(trigger.at))
      } else if (!trigger.dropped) {
        this.runner.enqueue({
          id: outboxId, ticketId: null, triggerId: id, kind: stop ? 'stop' : command ? 'deferred-decision' : 'inbox', to: 'owner:chief',
          body: trigger.message, sessionId, requestId,
        })
      }
    })
    if (stop && !skipStop) {
      this.#currentStops.set(sessionId, outboxId)
      try {
        await this.runner.tick({ kind: 'stop' })
      } finally {
        this.#currentStops.delete(sessionId)
      }
    }
    const row = this.#outboxRow(outboxId)
    return { ...receipt, deduped: false, dropped: trigger.dropped ?? null, outboxId: row?.id ?? null, queued: row?.state === 'queued' }
  }

  #updateTrigger(row) {
    this.store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(row), row.id)
  }

  async #deliverIntake(row) {
    const trigger = this.getTrigger(row.triggerId)
    if (!trigger || trigger.dropped || !trigger.authorization) {
      throw Object.assign(new Error('The original intake authorization is unavailable'), { permanent: true })
    }
    if (row.kind === 'stop') {
      // A stop applies to the turn active when it was requested. A restart never replays it.
      if (this.#currentStops.get(row.sessionId) !== row.id) return { recorded: true, skipped: 'interrupt-stale' }
      if (!row.sessionId || row.sessionId !== this.registry.get('chief')?.sessionId) return { recorded: true, skipped: 'no-current-session' }
      try {
        await this.sessions.cancel({ sessionId: row.sessionId })
      } catch (error) {
        if (isMissingSession(error) || error?.code === 'session/not-found') return { recorded: true, skipped: 'no-current-session' }
        throw Object.assign(new Error('Unable to interrupt the current session', { cause: error }), { permanent: true })
      }
      if (!this.store.closed) this.#updateTrigger({ ...trigger, interruptAt: this.now() })
      return
    }
    const cohort = Array.isArray(row.mergedRows) ? row.mergedRows : [row]
    const sources = cohort.map(item => this.getTrigger(item.triggerId))
    if (sources.some(entry => !entry?.authorization || entry.dropped || entry.kind !== 'feishu' || entry.source?.chatId !== trigger.source?.chatId)) {
      throw Object.assign(new Error('The original intake cohort is invalid'), { permanent: true })
    }
    if (sources.every(entry => entry.injectedAt)) return
    const ensured = await this.#ensureChiefSession()
    const model = this.config.chief?.model
    if (model) {
      try { await this.sessions.selectModel?.({ sessionId: ensured.sessionId, ...model }) }
      catch { /* Keep the configured deployment model if selection is unavailable. */ }
    }
    const text = sources.map(feishuPrompt).join('\n\n')
    await this.#promptOwner('chief', null, row.requestId, text)
    if (this.store.closed) return
    this.#persistWork(() => {
      const at = this.now()
      for (const { id } of sources) {
        const latest = this.getTrigger(id)
        if (latest && !latest.injectedAt) this.#updateTrigger({ ...latest, injectedAt: at })
      }
    })
  }

  /** One Ticket row by id (stage normalized), or undefined. */
  getTicket(id) {
    return this.tasks.getTicket(id)
  }

  /**
   * Drives due outbox deliveries (the dev harness and the plugin timer both call this).
   * #69: the same pulse sweeps person/confirm tickets past the 24h confirmation timeout
   * (spec「错误场景」: 待确认路由 24 小时未确认自动取消，回复"已取消").
   */
  async tick() {
    await this.runner.tick({ kind: 'deferred-decision' })
    await this.runner.tick({ excludeKind: 'deferred-decision' })
    await this.#sweepConfirmTimeouts()
    // #72 执行槽： a slot freed since the last pulse promotes the oldest queued ticket (FIFO); the second
    // runner pass delivers the released injection in the same pulse （提升即投递）.
    await this.#promoteQueued()
    await this.runner.tick({ excludeKind: 'deferred-decision' })
  }

  /**
   * 确认超时清扫： a person/confirm request unanswered for CONFIRM_TIMEOUT_MS auto-cancels (person/confirm →
   * done, by 'system') and the cancellation is announced through the chief （统一出口）. The announce row is
   * stored-then-delivered by the runner like every outward message （先存后做）; a ticket cancelled once leaves
   * person/confirm, so the notice fires exactly once.
   */
  #isTimelyDecision(request, decision, text, at, nowMs) {
    if (request.status !== 'pending') return false
    const received = Date.parse(at)
    if (!(received <= nowMs && received >= Date.parse(request.openedAt) && received < Date.parse(request.expiresAt))) return false
    const ticket = this.tasks.getTicket(request.ticketId)
    if (!ticket?.authorization || ticket.deferred?.requestId !== request.requestId) return false
    if (request.type === 'answer') return ticket.stage === 'person/answer' && (decision === 'cancel'
      || (decision === 'answer' && typeof text === 'string' && Boolean(text.trim())))
    return ticket.stage === 'person/confirm' && ['approve', 'reject', 'cancel'].includes(decision)
  }

  #receivedDecisions() {
    const ids = new Set()
    const nowMs = Date.parse(this.now())
    const rows = this.store.db.prepare(`
      SELECT value FROM outbox
      WHERE json_extract(value, '$.kind') = 'deferred-decision' AND json_extract(value, '$.state') = 'queued'
    `).all()
    for (const { value } of rows) {
      const row = JSON.parse(String(value))
      if (row.panelDecision) {
        const { requestId, ticketId, decision, text, receivedAt } = row.panelDecision
        const request = this.deferred.get(requestId)
        if (request?.ticketId === ticketId && this.#isTimelyDecision(request, decision, text, receivedAt, nowMs)) ids.add(requestId)
        continue
      }
      const trigger = this.getTrigger(row.triggerId)
      const choice = trigger?.decision
      if (!choice || !trigger.authorization || trigger.dropped) continue
      const request = this.deferred.get(choice.requestId)
      if (!request || !this.#isOriginalFeishuSender(request, trigger.authorization.actor, trigger.source?.chatId)) continue
      if (this.#isTimelyDecision(request, choice.decision, choice.text, trigger.at, nowMs)) ids.add(request.requestId)
    }
    return ids
  }

  async #sweepConfirmTimeouts() {
    this.deferred?.sweep({ skipRequestIds: this.#receivedDecisions() })
    const nowMs = Date.parse(this.now())
    for (const ticket of this.queryTasks({ stage: 'person/confirm' })) {
      if (ticket.deferred) continue
      const at = ticket.pendingConfirm?.at
      if (!at) continue
      if (nowMs - Date.parse(at) <= CONFIRM_TIMEOUT_MS) continue
      try {
        this.tasks.cancel(ticket.id, { by: 'system', reason: '确认超过 24 小时未回应，自动取消', kind: 'timeout' })
        this.#notifyTerminal(ticket.id)
      } catch { continue } // another path resolved it meanwhile — nothing to announce
      await this.replySource({ text: '已取消：任务 ' + ticket.id + ' 的确认请求超过 24 小时未回应（' + ticket.pendingConfirm.text + '）', to: 'dsh:session:chief' })
    }
  }

  /**
   * resolution:'confirm' (#69): executes the stored fork action (code-driven via the Sessions port), rebinds
   * the task at the forked Session and wakes the owner to inject the continuation there. The wake carries the
   * ticket's stored authorization （票面权威） like every owner-bound injection. A fork failure throws and
   * leaves the ticket at person/confirm — the user may retry, reject or cancel.
   */
  async #confirmPendingFork(owner, ticket, ticketId, approvalId) {
    const checkConfirmation = approvalId ? () => this.#requireCurrentApproval(approvalId) : undefined
    let result
    try {
      result = await confirmTicketFork({ tasks: this.tasks, sessions: this.sessions, ticketId, checkConfirmation })
    } catch (error) {
      throw translateTaskError(error, (code, message) => new RouterError(code, message))
    }
    // 缺上下文升级不编造： the fork executed, but without an authorization record the continuation must not run.
    if (!ticket.authorization) {
      try { this.tasks.escalate({ ticketId, reason: '授权记录缺失（票面权威），fork 已执行但拒绝凭会话叙事续作' }) } catch { /* stage may not allow it */ }
      throw new RouterError('authorization-missing', 'route_to_owner: ticket ' + ticketId + ' has no authorization record — refusing to act on a guess')
    }
    const auth = ticket.authorization
    const ensured = await this.#ensureSession(owner)
    const text = '[hub-bot 确认 ' + ticketId + '] 用户已确认 fork：原会话 ' + result.fromSessionId + ' → 新会话 ' + result.sessionId + '（cwd=' + result.cwd + '）。'
      + '任务已绑到新会话并回到进行中；请用 inject_session（带 ticketId）把续作指令注入新会话继续任务。原会话保留可查，勿再注入。'
      + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + ticketId
    this.runner.enqueue({ ticketId, kind: 'inject', to: 'session:' + ensured.sessionId, sessionId: ensured.sessionId, body: text, requestId: 'hub-bot-route-' + this.ids.uuid() })
    await this.runner.tick({ excludeKind: 'deferred-decision' })
    return { ownerId: owner.id, sessionId: ensured.sessionId, ticketId, requestId: ticket.requestId, createdSession: ensured.created, rebuilt: false, deduped: false, confirmed: true, fork: { fromSessionId: result.fromSessionId, sessionId: result.sessionId }, stage: 'working' }
  }

  /**
   * resolution:'confirm' for a blacklist-held injection (#73 补足, spec「Policy」): the stored message is
   * injected exactly as it would have been — route/follow-up entries wake the OWNER session (with the
   * ticket's authorization record), owner-inject entries deliver the L2's stored text to the execution
   * session. The confirm transition lands first; the injection then persists through the outbox like
   * every other (先存后做, retryable).
   */
  async #confirmDangerousInject(owner, ticket, ticketId, approvalId) {
    const action = ticket.pendingConfirm?.action
    if (!action || action.type !== DANGEROUS_INJECT_ACTION) {
      throw new RouterError('no-pending-inject', 'route_to_owner: ticket ' + ticketId + ' has no held dangerous injection to confirm')
    }
    // 缺上下文升级不编造： same discipline as the fork path — no authorization record, no execution.
    if (!ticket.authorization) {
      try { this.tasks.escalate({ ticketId, reason: '授权记录缺失（票面权威），危险注入确认拒绝凭会话叙事执行' }) } catch { /* stage may not allow it */ }
      throw new RouterError('authorization-missing', 'route_to_owner: ticket ' + ticketId + ' has no authorization record — refusing to act on a guess')
    }
    const auth = ticket.authorization
    if (action.entry === 'owner-inject') {
      // L2 发起、被挂起的执行会话注入: 确认后按票面存储的完整文本原样直投 (文本构建时已携授权记录)。
      // 不经 outbox 的理由: runner 的 inject 行恒投 owner 会话 (#deliverRow 先 ensureSession), 而这里的目标是票面
      // 存储的执行会话; 执行会话归 L2 管理、失败由 L2 感知, 一次性放行不需要路由注入的重建/重投语义。
      // The stored approval prevents replay if the host accepted the prompt before returning a result.
      const requestId = approvalId ? 'hub-bot-approved-' + approvalId : 'hub-bot-owner-' + this.ids.uuid()
      await this.sessions.prompt({ requestId, sessionId: action.sessionId, mode: 'queue', content: [{ type: 'text', text: action.text }] })
      if (approvalId) this.#requireCurrentApproval(approvalId)
      try { this.tasks.confirm({ ticketId, result: { injected: { entry: action.entry, sessionId: action.sessionId, requestId } }, by: 'user' }) } catch (error) { throw translateTaskError(error, (code, message) => new RouterError(code, message)) }
      return { ownerId: owner.id, sessionId: action.sessionId, ticketId, requestId, createdSession: false, rebuilt: false, deduped: false, confirmed: true, stage: 'working' }
    }
    const fixedSessionId = approvalId ? ticket.deferred.target?.sessionId : undefined
    const ensured = fixedSessionId ? { sessionId: fixedSessionId, created: false }
      : await (owner.role === 'chief' ? this.#ensureChiefSession() : this.#ensureSession(owner))
    if (approvalId) this.#requireCurrentApproval(approvalId)
    const sessionId = fixedSessionId ?? this.registry.get(owner.id)?.sessionId ?? ensured.sessionId
    const label = action.entry === 'follow-up' ? '[hub-bot 追问 ' + ticketId + '] ' : '[hub-bot 路由 ' + ticketId + '] '
    const text = label + action.message + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + ticketId
      + '\n\n（本条消息命中危险命令黑名单，已经用户确认放行）'
    const requestId = approvalId ? 'hub-bot-approved-' + approvalId : 'hub-bot-route-' + this.ids.uuid()
    this.#persistWork(() => {
      try { this.tasks.confirm({ ticketId, result: { injected: { entry: action.entry, requestId } }, by: 'user' }) } catch (error) { throw translateTaskError(error, (code, message) => new RouterError(code, message)) }
      this.runner.enqueue({ ticketId, triggerId: ticket.triggerId,
        kind: approvalId ? 'approved-owner-inject' : 'inject', to: 'session:' + sessionId, sessionId, body: text, requestId })
    })
    if (!approvalId) await this.runner.tick({ excludeKind: 'deferred-decision' })
    return { ownerId: owner.id, sessionId, ticketId, requestId, createdSession: ensured.created, rebuilt: false, deduped: false, confirmed: true, stage: 'working' }
  }

  /** Persists restart recovery in arrival order, using the same owner slots as new work. */
  async markRestart() {
    const result = this.#persistWork(() => {
      this.tasks.markRestart()
      const pending = this.store.db.prepare('SELECT value FROM ticket ORDER BY rowid').all()
        .map(raw => JSON.parse(String(raw.value)))
        .filter(ticket => ticket.recoveryPending === true && normalizeStage(ticket.stage) === 'working')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      const queuedRecoveries = new Set(this.listOutbox()
        .filter(row => ['queued', 'held'].includes(row.state) && (['background-recovery', 'deferred-answer', 'approved-owner-inject'].includes(row.kind)
          || (row.kind === 'inject' && row.body.startsWith('[hub-bot 恢复 ' + row.ticketId + ']'))))
        .map(row => row.ticketId))
      const perOwner = new Map()
      let resumed = 0
      let queued = 0
      for (const ticket of pending) {
        const owner = this.registry.get(ticket.owner)
        if (!owner || owner.recycled) continue
        const count = perOwner.get(ticket.owner) ?? 0
        perOwner.set(ticket.owner, count + 1)
        if (queuedRecoveries.has(ticket.id) || (ticket.background && ticket.lastDelivery?.state !== 'sent')) continue
        const held = count >= this.#slotsPerOwner()
        if (held) {
          this.tasks.demote(ticket.id)
          queued++
        } else {
          resumed++
        }
        const trigger = ticket.triggerId ? this.getTrigger(ticket.triggerId) : undefined
        const auth = ticket.authorization
        const original = ticket.routedMessage || trigger?.message || '（原始指令见会话历史）'
        const body = '[hub-bot 恢复 ' + ticket.id + '] 宿主重启，任务自动恢复（最旧优先）。原始任务：' + original
          + (auth ? '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + ticket.id : '')
        this.runner.enqueue({
          ticketId: ticket.id, triggerId: ticket.triggerId, kind: ticket.background ? 'background-recovery' : 'inject',
          to: 'owner:' + ticket.owner, body, requestId: 'hub-bot-resume-' + this.ids.uuid(), held,
        })
      }
      return { resumed, queued }
    })
    if (result.resumed || result.queued) await this.runner.tick({ excludeKind: 'deferred-decision' })
    return result
  }

  /** The chief's own Session (L1 统一出口): digests and replies are admitted here. */
  #ensureChiefSession() {
    const chief = this.registry.get('chief')
    if (!chief) throw new RouterError('chief-missing', 'the chief owner row is missing from the registry')
    return this.#ensureSession(chief)
  }

  /** Lazily binds an owner Session: create only when the registry names none. */
  #ensureSession(owner) {
    return this.#serialized('owner-binding:' + owner.id, async () => {
      const current = () => {
        const latest = this.registry.get(owner.id)
        if (!latest || latest.recycled) throw new RouterError('owner-unavailable', 'The registered owner is unavailable.')
        return latest
      }
      const boundSession = async latest => {
        await this.placer?.ensureUnarchived(latest.sessionId, latest.id)
        return { owner: latest, sessionId: latest.sessionId, created: false }
      }
      let latest = current()
      if (latest.sessionId) return boundSession(latest)
      const ws = await (latest.role === 'chief' ? this.placer?.chiefWorkspace() : this.placer?.ownerWorkspace(latest))
      latest = current()
      if (latest.sessionId) return boundSession(latest)
      const agentPreset = latest.role === 'chief' ? 'hub-bot-router' : 'hub-bot-owner'
      const key = 'owner-bootstrap/' + latest.id
      const plan = this.store.get(key)
      const created = await this.sessions.create({
        ...(ws ? { workspaceId: ws.workspaceId } : { cwd: latest.cwd }), agentPreset,
        ...(plan && { sessionId: plan.sessionId }),
      })
      latest = current()
      if (latest.sessionId) return boundSession(latest)
      const sessionId = created.sessionId ?? created.session?.id
      if (!sessionId) throw new RouterError('session-create-empty', 'owner Session creation returned no sessionId')
      if (plan && created.agentPreset && created.agentPreset !== agentPreset) {
        throw new RouterError('owner-preset-invalid', 'The replacement must use the registered owner role.')
      }
      const bound = this.#persistWork(() => {
        const next = this.registry.bindSession(latest.id, sessionId)
        if (plan) this.store.set(key, { ...plan, sessionId })
        return next
      })
      return { owner: bound, sessionId, created: true }
    })
  }

  /**
   * Routes one message to an L2 owner (spec: prompt 注入指定 L2 会话，含授权记录）.
   *
   * Idempotency: a triggerRef that already produced a Ticket returns that Ticket without re-injecting — one
   * Trigger accepted twice produces one task (spec「领域模型」). A missing owner Session (deleted by hand) is
   * detected from the prompt failure, rebuilt once, and the registry updated (spec: 被删自动重建）.
   *
   * With `ticketId` the message is a follow-up on an existing task: a ticket waiting on a person (review /
   * answer / confirm) or stopped (blocked / failed) is RELEASED back to working by the human's message
   * (spec: 人的消息直接释放）; a working ticket just takes the injection; a done ticket rejects.
   * `resolution: 'accept'` is the user-acceptance gate (person/review → done); `resolution: 'cancel'`
   * cancels a pending confirmation (person/confirm → done); `resolution: 'confirm'` executes the pending
   * fork and wakes the owner (#69); `resolution: 'reject'` refuses it (person/confirm → blocked, 保持原会话）.
   * accept/cancel/reject inject nothing; confirm injects the owner wake.
   *
   * @returns deduped receipt { ownerId, sessionId, ticketId, requestId, createdSession, rebuilt, deduped,
   *   stage }, plus resumed/accepted/cancelled/confirmed/rejected on the follow-up paths
   */
  /** 危险命令黑名单 (spec「Policy」): the configured list, falling back to the built-in defaults. */
  #dangerousPatterns() {
    return this.config?.security?.dangerousPatterns ?? DEFAULT_DANGEROUS_PATTERNS
  }

  /**
   * 命中黑名单的消息不直接注入: 票转 person/confirm, 原文与命中模式存票面 action（先存后做）;
   * 用户确认后由 #confirmDangerousInject 执行存储的注入。返回 true 表示已挂起。
   */
  #holdDangerous(ticketId, message, entry, extra = {}) {
    const pattern = findDangerousPattern(message, this.#dangerousPatterns())
    if (!pattern) return false
    this.openQuestion({
      ticketId,
      question: dangerousConfirmText(pattern, message),
      action: { type: DANGEROUS_INJECT_ACTION, entry, message, ...extra },
    })
    return true
  }

  async routeToOwner({ ownerId, message, triggerRef, ticketId, resolution, authorization }) {
    return this.#routeMessage({ ownerId, message, triggerRef, ticketId, resolution, authorization })
  }

  /** Authorized source adapters assign work without waking a management session. */
  async routeBackground({ ownerId, message, triggerRef, authorization, source }) {
    if (!['github', 'timer'].includes(source?.kind) || typeof triggerRef !== 'string' || !triggerRef.trim()
      || typeof authorization?.actor !== 'string' || !authorization.actor.trim()
      || (authorization.source !== source.kind && !this.#hasOriginalTimerAuthorization(source, authorization))
      || (source.kind === 'timer' && (typeof source.timerId !== 'string' || !source.timerId))) {
      throw new RouterError('invalid-background-source', 'background work requires an authorized source and a stable trigger identity')
    }
    return this.#routeMessage({ ownerId, message, triggerRef, authorization, source })
  }

  #hasOriginalTimerAuthorization(source, authorization) {
    const origin = source.origin
    if (source.kind !== 'timer' || origin?.kind !== 'feishu' || authorization.source !== 'feishu'
      || typeof origin.triggerId !== 'string' || !origin.triggerId) return false
    const trigger = this.getTrigger(origin.triggerId)
    return trigger?.kind === 'feishu' && !trigger.dropped && trigger.source?.chatId === origin.chatId
      && trigger.source?.openId === origin.actor && origin.actor === authorization.actor
      && JSON.stringify(trigger.authorization) === JSON.stringify(authorization)
  }

  #routeMessage({ ownerId, message, triggerRef, ticketId, resolution, authorization, source }) {
    if (typeof message !== 'string' || !message.trim()) throw new RouterError('message-required', 'route_to_owner: message must be a non-empty string')
    const route = () => this.#serialized('owner:' + ownerId, () =>
      this.#routeToOwnerLocked({ ownerId, message: message.trim(), triggerRef, ticketId, resolution, authorization, source }))
    return ticketId === undefined && triggerRef !== undefined
      ? this.#serialized('trigger:' + triggerRef, route)
      : route()
  }

  /** routeToOwner's body, run under the per-owner chain (see routeToOwner). */
  async #routeToOwnerLocked({ ownerId, message, triggerRef, ticketId, resolution, authorization, source }) {
    const owner = this.registry.get(ownerId)
    if (!owner) throw new RouterError('unknown-owner', 'route_to_owner: unknown owner "' + ownerId + '" — call list_owners first')
    // chief 不是路由目标——但仅约束「新建任务」；带 ticketId 的 resolution 裁决（面板 confirm/reject）
    // 是票面状态机推进，不给 chief 会话发消息，chief 票（如黑名单挂起的注入）必须能由此裁决。
    if (owner.role === 'chief' && ticketId === undefined && !source) throw new RouterError('cannot-route-to-chief', 'route_to_owner: the chief is the router, not a route target')
    // #70: a recycled scratch owner's directory is gone (物理上无法恢复) — follow-ups to its finished task start
    // a NEW task instead (spec「已结束任务的跟进」例外); never route into a recycled row.
    if (owner.recycled) throw new RouterError('owner-recycled', 'route_to_owner: owner ' + ownerId + ' 已回收（临时目录已删）——请新建任务，不要复活旧负责人')
    if (ticketId !== undefined) return this.#followUp({ owner, message, ticketId, resolution, authorization })
    if (resolution !== undefined) throw new RouterError('resolution-needs-ticket', 'route_to_owner: resolution requires ticketId')
    if (source && owner.transient) throw new RouterError('background-owner-transient', 'background work requires a persistent owner')
    const existing = triggerRef === undefined ? undefined : this.getTrigger(triggerRef)
    if (existing) {
      const ticket = this.#ticketByTrigger(triggerRef)
      if (ticket || !['feishu', 'route'].includes(existing.kind)) {
        const sessionId = ticket?.background ? ticket.workerSession?.sessionId
          : ticket ? ticket.targetSession ?? this.registry.get(ticket.owner)?.sessionId : owner.sessionId
        return {
          ownerId: ticket?.owner ?? ownerId, ...(sessionId && { sessionId }),
          ...(ticket && { ticketId: ticket.id }), requestId: ticket?.requestId ?? null,
          ...(ticket?.workerSession && { workerSession: ticket.workerSession }),
          ...(ticket?.background && { admitted: ticket.lastDelivery?.state === 'sent' }),
          createdSession: false, rebuilt: false, deduped: true, stage: ticket ? normalizeStage(ticket.stage) : null,
        }
      }
      if (existing.dropped || !existing.authorization || ['interrupt', 'decision'].includes(existing.policy?.mode)
        || String(existing.source?.messageId ?? '').startsWith('om_selftest-')) {
        throw new RouterError('invalid-route-trigger', 'route_to_owner: this event is not eligible for dispatch')
      }
      if (existing.kind === 'route' && existing.ownerId !== ownerId) {
        throw new RouterError('route-owner-mismatch', 'route_to_owner: this event already belongs to another owner')
      }
    }
    const at = this.now()
    const auth = existing?.authorization ?? authorization ?? { actor: 'user', source: 'dsh', at }
    const addressing = auth.addressing ?? 'direct'
    const instruction = existing?.kind === 'route' ? existing.message : message
    const background = source && { kind: source.kind, ...(source.timerId && { timerId: source.timerId }) }
    const trigger = existing ?? {
      id: triggerRef ?? 'trg-' + this.ids.uuid(), kind: source?.kind ?? 'route', ownerId, message: instruction, authorization: auth, at,
      source: source ?? { kind: 'route', addressing },
      policy: { addressing, mode: source?.kind === 'github' ? 'independent' : source ? 'reuse' : 'queue', allowed: true, reason: null },
    }
    const requestId = 'hub-bot-route-' + this.ids.uuid()
    const freshTicketId = 'tsk-' + this.ids.uuid()
    const atCapacity = this.#workingCount(ownerId) >= this.#slotsPerOwner()
    // Write the source, ticket, and confirmation or delivery intent before creating a Session.
    const awaitingConfirmation = this.#persistWork(() => {
      if (!existing) this.#insertTrigger(trigger)
      this.#insertTicket({
        id: freshTicketId, triggerId: trigger.id, owner: ownerId, stage: atCapacity ? 'queued' : 'idle', mechanism: 'inject',
        targetSession: background ? null : owner.sessionId, requestId, authorization: auth, createdAt: at, updatedAt: at,
        ...(background && { background }),
        ...(existing?.kind === 'feishu' && { routedMessage: instruction }),
      })
      if (background) this.#ensureRun(this.tasks.getTicket(freshTicketId), trigger)
      if (this.#holdDangerous(freshTicketId, instruction, 'route')) return true
      const text = '[hub-bot 路由 ' + freshTicketId + '] ' + instruction + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + freshTicketId
      this.runner.enqueue({
        ticketId: freshTicketId, triggerId: trigger.id, kind: 'inject',
        to: background || !owner.sessionId ? 'owner:' + ownerId : 'session:' + owner.sessionId,
        sessionId: background ? null : owner.sessionId, body: text, requestId, held: atCapacity,
      })
      return false
    })
    if (!awaitingConfirmation) await this.runner.tick({ excludeKind: 'deferred-decision' })
    const stored = this.tasks.getTicket(freshTicketId)
    const sessionId = background ? stored.workerSession?.sessionId : stored.targetSession ?? this.registry.get(ownerId)?.sessionId
    return {
      ownerId, ...(sessionId && { sessionId }), ticketId: freshTicketId, requestId,
      createdSession: background ? stored.lastDelivery?.created === true : !owner.sessionId && Boolean(sessionId),
      ...(stored.workerSession && { workerSession: stored.workerSession }),
      ...(background && { admitted: stored.lastDelivery?.state === 'sent' }),
      rebuilt: stored.lastDelivery?.rebuilt ?? false, deduped: false, stage: stored.stage,
    }
  }

  #serialized(key, fn) {
    const run = (this.#queues.get(key) ?? Promise.resolve()).then(fn)
    const settled = run.catch(() => {})
    this.#queues.set(key, settled)
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key)
    })
    return run
  }

  /** #72: the per-owner execution-slot cap (config.concurrency.slotsPerOwner; spec default 3). */
  #slotsPerOwner() {
    const value = this.config?.concurrency?.slotsPerOwner
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 3
  }

  /** #72: one owner's working-stage ticket count — the slot ledger (person/* stages hold no slot). */
  #workingCount(ownerId) {
    return this.store.db.prepare('SELECT value FROM ticket').all()
      .map(raw => JSON.parse(String(raw.value)))
      .filter(ticket => ticket.owner === ownerId && normalizeStage(ticket.stage) === 'working')
      .length
  }

  /**
   * #72 执行槽提升： per owner, first repair crash-torn promotions (a working ticket whose injection rows
   * are still held — the promotion transition ran but the release did not), then admit the oldest queued
   * tickets while slots are free (FIFO by createdAt). Promotion transitions BEFORE the row release so a
   * crash between them is the repairable case above, never an over-admission. All reads/writes inside the
   * per-owner chain are synchronous — the admission decision is atomic.
   */
  async #promoteQueued() {
    const ownerIds = [...new Set(this.store.db.prepare('SELECT value FROM ticket').all()
      .map(raw => JSON.parse(String(raw.value)).owner))]
    for (const ownerId of ownerIds) {
      await this.#serialized('owner:' + ownerId, () => {
        const mine = this.store.db.prepare('SELECT value FROM ticket').all()
          .map(raw => JSON.parse(String(raw.value)))
          .map(ticket => ({ ...ticket, stage: normalizeStage(ticket.stage) }))
          .filter(ticket => ticket.owner === ownerId)
        for (const ticket of mine.filter(t => t.stage === 'working')) this.runner.releaseHeld({ ticketId: ticket.id })
        let working = mine.filter(t => t.stage === 'working').length
        const queued = mine
          .filter(t => t.stage === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        for (const ticket of queued) {
          if (!ticket.lastDelivery && ticket.background?.kind === 'timer') {
            const state = this.#timerState(ticket)
            if (state === 'paused') continue
            if (state === 'closed') {
              this.#skipTimerDelivery(ticket)
              this.runner.releaseHeld({ ticketId: ticket.id })
              continue
            }
          }
          if (working >= this.#slotsPerOwner()) continue
          try {
            this.tasks.promote(ticket.id)
          } catch { continue } // the ticket raced to another stage meanwhile — leave it to that path
          this.runner.releaseHeld({ ticketId: ticket.id })
          working++
        }
      })
    }
  }

  /** The follow-up/acceptance path: same task, same owner Session, NO new Trigger and NO new authorization. */
  async #followUp({ owner, message, ticketId, resolution, authorization }) {
    const ticket = this.tasks.getTicket(ticketId)
    if (!ticket) throw new RouterError('unknown-ticket', 'route_to_owner: unknown ticket "' + ticketId + '" — call query_tasks first')
    if (ticket.owner !== owner.id) {
      throw new RouterError('ticket-owner-mismatch', 'route_to_owner: ticket ' + ticketId + ' belongs to ' + ticket.owner + ', not ' + owner.id)
    }
    // 票面权威： a follow-up cannot re-bind the trigger or the authorization record.
    if (authorization !== undefined) {
      throw new RouterError('authorization-immutable', 'route_to_owner: a follow-up cannot re-bind authorization — the ticket record is authoritative')
    }
    if (ticket.deferred && ['person/answer', 'person/confirm'].includes(ticket.stage)) {
      throw new RouterError('exact-request-required', 'Reply through the original deferred request ID.')
    }
    if (resolution !== undefined) {
      if (resolution === 'accept') {
        try {
          this.tasks.accept(ticketId)
        } catch (error) {
          throw translateTaskError(error, (code, message) => new RouterError(code, message))
        }
        this.#notifyTerminal(ticketId) // #70 验收通过即回收判定
        return { ownerId: owner.id, sessionId: owner.sessionId, ticketId, requestId: ticket.requestId, createdSession: false, rebuilt: false, deduped: false, accepted: true, stage: 'done' }
      }
      if (resolution === 'cancel') {
        try {
          this.tasks.cancel(ticketId)
        } catch (error) {
          throw translateTaskError(error, (code, message) => new RouterError(code, message))
        }
        this.#notifyTerminal(ticketId) // #70 取消即回收判定
        return { ownerId: owner.id, sessionId: owner.sessionId, ticketId, requestId: ticket.requestId, createdSession: false, rebuilt: false, deduped: false, cancelled: true, stage: 'done' }
      }
      // #69: the user approved the pending fork — execute it (code-driven, never model-discretion),
      // rebind the task to the forked Session and wake the owner to continue the task there.
      // 危险命令黑名单挂起的注入走 #confirmDangerousInject — 同一条「确认才执行票面存储动作」的纪律。
      if (resolution === 'confirm') {
        if (ticket.pendingConfirm?.action?.type === DANGEROUS_INJECT_ACTION) return this.#confirmDangerousInject(owner, ticket, ticketId)
        return this.#confirmPendingFork(owner, ticket, ticketId)
      }
      // #69: the user rejected the proposal — no fork; the ticket keeps its original Session
      // （保持原会话） and waits 被卡住 for the human's next message to release it.
      if (resolution === 'reject') {
        try {
          this.tasks.rejectConfirm({ ticketId, reason: message, by: 'user' })
        } catch (error) {
          throw translateTaskError(error, (code, message) => new RouterError(code, message))
        }
        return { ownerId: owner.id, sessionId: owner.sessionId, ticketId, requestId: ticket.requestId, createdSession: false, rebuilt: false, deduped: false, rejected: true, stage: 'blocked' }
      }
      throw new RouterError('unknown-resolution', 'route_to_owner: resolution must be "accept", "cancel", "confirm" or "reject" when given')
    }
    let resumed = false
    if (ticket.stage === 'done') {
      throw new RouterError('illegal-transition', 'route_to_owner: ticket ' + ticketId + ' is done — create a new task instead of reviving it')
    }
    if (ticket.stage === 'queued') {
      // 人的专用槽 (#72): a human message on a QUEUED task admits it immediately — queued new work never
      // blocks the human from continuing an existing task (spec「并发与人的优先」). The held injections
      // release in per-ticket order (original first, this follow-up enqueued behind it).
      try {
        this.tasks.promote(ticketId, { by: 'route' })
      } catch (error) {
        throw translateTaskError(error, (code, message) => new RouterError(code, message))
      }
      this.runner.releaseHeld({ ticketId })
    }
    if (['person/review', 'person/answer', 'person/confirm', 'blocked', 'failed'].includes(ticket.stage)) {
      // 人的消息直接释放： waiting/stopped tasks resume to working (spec「状态模型」).
      try {
        this.tasks.resume(ticketId, { by: 'route' })
      } catch (error) {
        throw translateTaskError(error, (code, message) => new RouterError(code, message))
      }
      resumed = true
    }
    // 票面权威： the injection carries the ticket's stored authorization, never a narrative claim.
    const auth = ticket.authorization
    if (!auth) {
      try { this.tasks.escalate({ ticketId, reason: '授权记录缺失（票面权威），拒绝凭会话叙事执行' }) } catch { /* stage may not allow it */ }
      throw new RouterError('authorization-missing', 'route_to_owner: ticket ' + ticketId + ' has no authorization record — refusing to act on a guess')
    }
    // 危险命令黑名单: 追问同样挂起转确认 (askConfirm 转移忠实记录)。检查在 recovery-note 消费之前——
    // 挂起期间票保持 recoveryPending, 确认放行后的注入才携带重启注记 (恰好一次语义不破)。
    if (this.#holdDangerous(ticketId, message, 'follow-up')) {
      const heldTicket = this.tasks.getTicket(ticketId)
      return { ownerId: owner.id, sessionId: heldTicket.targetSession, ticketId, requestId: heldTicket.requestId, createdSession: false, rebuilt: false, deduped: false, resumed, stage: heldTicket.stage }
    }
    let text = '[hub-bot 追问 ' + ticketId + '] ' + message + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + ticketId
    text += resumed ? '（票已恢复进行中，改完请再次 report 转入等验收）' : '（同一任务追加指令，完成后 report 转入等验收）'
    // 重启恢复： the first injection after a host restart repeats the recovery note, exactly once.
    if (ticket.recoveryPending) {
      text = RECOVERY_NOTE + '\n\n' + text
      this.tasks.noteRecoveryCarried(ticketId)
    }
    const requestId = 'hub-bot-route-' + this.ids.uuid()
    const ensured = await this.#ensureSession(owner)
    this.runner.enqueue({ ticketId, kind: 'inject', to: 'session:' + ensured.sessionId, sessionId: ensured.sessionId, body: text, requestId })
    await this.runner.tick({ excludeKind: 'deferred-decision' })
    const stored = this.tasks.getTicket(ticketId)
    return { ownerId: owner.id, sessionId: stored.targetSession, ticketId, requestId, createdSession: ensured.created, rebuilt: stored.lastDelivery?.rebuilt ?? false, deduped: false, resumed, stage: stored.stage }
  }

  /**
   * #70 回收触发段: notify the terminal-ticket listener (Recycler) without ever letting recycling block the
   * transition itself — a listener failure is swallowed here and retried by the Recycler's sweep.
   */
  #notifyTerminal(ticketId) {
    try { this.onTicketTerminal?.(ticketId) } catch { /* 回收失败不阻断任务完成 — sweep 兜底 */ }
  }

  /** S01 结案判定：票已走到终态（done/failed）—— 终态票绝不再注入，也不再被旧快照改写。 */
  #isTerminalTicket(ticket) {
    return ticket !== undefined && (ticket.stage === 'done' || ticket.stage === 'failed')
  }

  /**
   * S01 元数据合并（快照竞态的唯一安全写法）：先读库里最新的票面，再把 patch 合上去写回。
   * 绝不拿 await 之前的旧快照整行覆盖 —— 旧快照会把已经结案（done/failed）的票「复活」成 working，
   * 也会抹掉等待期间新增的审计历史（transitions / lastDelivery / confirmOutcome / failed / targetSession）。
   * 票已不存在时返回 undefined（不凭空新建行）。
   */
  #mergeTicket(ticketId, patch) {
    const latest = this.tasks.getTicket(ticketId)
    if (latest === undefined) return undefined
    return this.#updateTicket({ ...latest, ...patch, updatedAt: this.now() })
  }

  /**
   * The runner's deliverer. kind 'inject' prompts the owner Session (rebuilding it once when the registry's
   * pointer dangles) and flips idle → working (待触发 → 进行中）. Reply/escalation rows are recorded durable
   * intents until a real channel deliverer (Feishu) lands — storing them already satisfies 先存后做.
   *
   * S01 取消/失败竞态： 行是「先存后做」入库的，投递前它可能在库里已经等了一段时间。票面在每一个 await
   * 边界都重新读一次权威值：已结案（done/failed，取消也走 done）就安静跳过 —— 不注入、不抛错（这不是
   * 投递故障，不需要重试或系统告警），行由 runner 记成终态，票面与审计历史原样保留。
   */
  async #deliverRow(row) {
    if (row.kind === 'inbox' || row.kind === 'stop') return this.#deliverIntake(row)
    if (row.kind === 'background-report') return this.#deliverBackgroundReport(row)
    if (row.kind === 'deferred-answer') return this.#deliverDeferredAnswer(row)
    if (row.kind === 'approved-owner-inject') return this.#deliverApprovedOwner(row)
    if (row.kind === 'deferred-decision') {
      if (row.panelDecision) {
        try {
          await this.#applyPanelDecision(row)
          return { recorded: true }
        } catch (error) {
          if (!['TaskError', 'RouterError', 'DeferredError'].includes(error?.name)) throw error
          return { recorded: true, skipped: error.code }
        }
      }
      const trigger = this.getTrigger(row.triggerId)
      if (!trigger?.authorization || !trigger.decision) return { recorded: true, skipped: 'invalid-decision' }
      let message
      try {
        const result = await this.resolveDeferred({ ...trigger.decision, actor: trigger.authorization.actor,
          channel: 'feishu', chatId: trigger.source.chatId, receivedAt: trigger.at })
        message = '已记录答复 ' + result.requestId + ' · ' + result.stage
      } catch (error) {
        if (!['DeferredError', 'RouterError', 'TaskError'].includes(error?.name)) throw error
        message = '答复未受理：' + error.message
      }
      const id = 'out-decision-reply-' + trigger.id
      if (!this.store.closed && !this.#outboxRow(id)) insertOutbox(this.store, {
        id, triggerId: trigger.id, kind: 'reply', state: 'recorded', to: 'feishu:chat:' + trigger.source.chatId,
        requestId: 'hub-bot-decision-reply-' + trigger.id, body: message,
      }, () => Date.parse(this.now()))
      return { recorded: true }
    }
    if (row.kind === 'digest') return this.#deliverDigest(row)
    if (row.kind === 'reply') return this.#deliverReply(row)
    if (row.kind !== 'inject' && row.kind !== 'background-recovery') return
    const ticket = this.tasks.getTicket(row.ticketId)
    const permanent = (message) => { const error = new Error(message); error.permanent = true; return error }
    if (!ticket) throw permanent('outbox ' + row.id + ': ticket ' + row.ticketId + ' is gone')
    // S01：入队之后票可能已被取消/失败/关闭 —— 结案的票一次都不许注入（也不算投递成功，记 recorded）。
    if (this.#isTerminalTicket(ticket)) return { recorded: true, skipped: 'ticket-terminal' }
    // 缺上下文升级不编造： no authorization record → fail the ticket, never execute on a guess.
    if (!ticket.authorization) {
      try {
        this.tasks.fail({ ticketId: ticket.id, reason: '授权记录缺失（票面权威），拒绝执行' })
        this.#notifyTerminal(ticket.id) // #70 回收判定
      } catch { /* stage may not allow it */ }
      throw permanent('ticket ' + ticket.id + ' has no authorization record')
    }
    const owner = this.registry.get(ticket.owner)
    if (!owner) throw permanent('ticket ' + ticket.id + ': owner ' + ticket.owner + ' is gone from the registry')
    if (ticket.background && (row.kind === 'background-recovery' || row.requestId === ticket.requestId)) {
      return this.#serialized('background-admission:' + owner.id, () => this.#deliverBackground(row, owner))
    }
    // 重启恢复 (same discipline as follow-ups): a row stored BEFORE a crash carries no recovery note in its
    // body — prepend it at redelivery time, and clear the flag only after the prompt actually lands (a
    // failed attempt keeps the flag so the next retry still carries the note — 恰好一次 = delivered once).
    const needsNote = ticket.recoveryPending === true
    const body = needsNote ? RECOVERY_NOTE + '\n\n' + row.body : row.body
    const delivered = await this.#promptOwner(owner.id, ticket.id, row.requestId, body)
    if (!delivered) return { recorded: true, skipped: 'ticket-terminal' }
    // The host admitted the prompt even if the ticket closed while admission was pending.
    const settled = this.tasks.getTicket(ticket.id)
    if (!settled || this.#isTerminalTicket(settled)) return
    if (needsNote) this.tasks.noteRecoveryCarried(ticket.id)
    this.tasks.markDelivered(ticket.id)
    this.#mergeTicket(ticket.id, {
      targetSession: delivered.sessionId,
      lastDelivery: { state: 'sent', rebuilt: delivered.rebuilt, at: this.now() },
    })
  }

  async #deliverApprovedOwner(row) {
    const requestId = row.requestId.slice('hub-bot-approved-'.length)
    const current = () => this.#currentDeferredWork(row.ticketId, requestId)
    const ticket = current()
    if (!ticket) return { recorded: true, skipped: 'deferred-no-longer-active' }
    const target = this.registry.get(ticket.owner)
    const unavailable = () => {
      const reason = 'The original owner session is unavailable. Request a new confirmation for the current session.'
      return Object.assign(new Error(reason), { permanent: true })
    }
    if (!target || target.sessionId !== row.sessionId || target.recycled || this.sessions.isArchived?.(row.sessionId)) throw unavailable()
    const text = ticket.recoveryPending ? RECOVERY_NOTE + '\n\n' + row.body : row.body
    try {
      await this.sessions.prompt({ sessionId: row.sessionId, requestId: row.requestId, text })
    } catch (error) {
      if (isMissingSession(error) || error?.code === 'session/not-found') throw unavailable()
      throw error
    }
    if (this.store.closed || !current()) return
    this.tasks.noteRecoveryCarried(ticket.id)
    this.#mergeTicket(ticket.id, { targetSession: row.sessionId, lastDelivery: { state: 'sent', at: this.now(), rebuilt: false } })
  }

  #timerWorker(ticket) {
    if (ticket.background.kind !== 'timer') return undefined
    const prior = this.store.db.prepare(`
      SELECT value FROM ticket
      WHERE id != ? AND json_extract(value, '$.owner') = ?
        AND json_extract(value, '$.background.timerId') = ?
        AND json_extract(value, '$.workerSession.sessionId') IS NOT NULL
      ORDER BY rowid DESC LIMIT 1
    `).get(ticket.id, ticket.owner, ticket.background.timerId)
    return prior && JSON.parse(String(prior.value)).workerSession
  }

  async #bindBackgroundWorker(ticket, owner, existing, recovering) {
    let sessionId = existing?.sessionId
    if (!sessionId) {
      const proposed = ticket.background.proposedSessionId ?? 'session-' + this.ids.uuid()
      this.#mergeTicket(ticket.id, { background: { ...ticket.background, proposedSessionId: proposed } })
      const result = await this.sessions.create({ cwd: owner.cwd, sessionId: proposed })
      sessionId = result.sessionId ?? result.session?.id
      if (!sessionId || ['hub-bot-owner', 'hub-bot-router'].includes(result.agentPreset)) {
        throw new RouterError('background-preset-invalid', 'The host must provide a normal execution session for background work')
      }
    }
    if (this.registry.isOwnerSession(sessionId)) {
      throw new RouterError('background-worker-is-owner', 'A management session cannot receive background work')
    }
    const latest = this.#backgroundDeliveryTicket(ticket.id, recovering)
    if (!latest || latest.workerSession?.sessionId !== ticket.workerSession?.sessionId) return null
    const alreadyRunning = latest.assignments?.some(assignment => assignment.sessionId === sessionId && assignment.state === 'running')
    if (latest.workerSession?.sessionId !== sessionId || (latest.recoveryPending && !alreadyRunning)) {
      this.tasks.bindWorkerSession(ticket.id, { sessionId, cwd: owner.cwd })
    }
    return sessionId
  }

  #timerState(ticket) {
    return this.timerDeliveryState?.(ticket.background.timerId, ticket.triggerId)
  }

  #deferTimerDelivery(ticket, recovering) {
    if (recovering || ticket.background.kind !== 'timer') return null
    const state = this.#timerState(ticket)
    if (state === 'paused') {
      if (ticket.stage === 'working') this.tasks.demote(ticket.id)
      return { postponeMs: 1000 }
    }
    return state === 'closed' ? this.#skipTimerDelivery(ticket) : null
  }

  #skipTimerDelivery(ticket) {
    const current = this.tasks.getTicket(ticket.id)
    if (current && !this.#isTerminalTicket(current) && !current.lastDelivery) {
      if (['idle', 'queued'].includes(current.stage)) this.tasks.cancel(current.id, { by: 'system', reason: '提醒已取消，未唤醒执行会话' })
      else if (current.stage === 'working') this.tasks.fail({ ticketId: current.id, reason: '提醒已取消，未唤醒执行会话' })
    }
    return { recorded: true, skipped: 'timer-ineligible' }
  }

  #backgroundDeliveryTicket(ticketId, recovering) {
    const ticket = this.tasks.getTicket(ticketId)
    if (!ticket?.authorization) return undefined
    if (ticket.stage === 'queued' && !recovering && ticket.background?.kind === 'timer' && !ticket.lastDelivery) return ticket
    if (!['idle', 'working'].includes(ticket.stage)) return undefined
    if (recovering && (ticket.stage !== 'working' || !ticket.recoveryPending)) return undefined
    return ticket
  }

  async #deliverBackground(row, owner) {
    const recovering = row.kind === 'background-recovery'
    const currentTicket = () => this.#backgroundDeliveryTicket(row.ticketId, recovering)
    const inactive = { recorded: true, skipped: 'background-no-longer-active' }
    let ticket = currentTicket()
    if (!ticket) return inactive
    if (!recovering && ticket.lastDelivery?.state === 'sent') return
    let deferred = this.#deferTimerDelivery(ticket, recovering)
    if (deferred) return deferred
    if (ticket.stage === 'queued' || (ticket.stage === 'idle' && this.#workingCount(owner.id) >= this.#slotsPerOwner())) {
      return { postponeMs: 1000 }
    }
    const timer = ticket.background.kind === 'timer'
    let worker = ticket.workerSession ?? (recovering ? undefined : this.#timerWorker(ticket))
    if (worker && this.sessions.isArchived?.(worker.sessionId)) {
      if (recovering || !timer) throw Object.assign(new Error('原后台执行会话已归档'), { permanent: true })
      const { proposedSessionId, ...background } = ticket.background
      ticket = { ...ticket, background }
      worker = undefined
    }
    if (recovering && !worker) throw Object.assign(new Error('原后台执行会话已失效'), { permanent: true })
    const alreadyRunning = recovering && await this.sessions.isRunning?.(worker.sessionId)
    const live = currentTicket()
    if (!live || live.workerSession?.sessionId !== ticket.workerSession?.sessionId) return inactive
    if (alreadyRunning) return { postponeMs: 1000 }
    let sessionId = await this.#bindBackgroundWorker(ticket, owner, worker, recovering)
    const bound = currentTicket()
    if (!sessionId || !bound || bound.workerSession?.sessionId !== sessionId) return inactive
    deferred = this.#deferTimerDelivery(bound, recovering)
    if (deferred) return deferred
    const source = this.getTrigger(ticket.triggerId)?.source
    const timing = timer ? '[跟进提醒] ' + source?.fireAt + (source?.late === true ? ' · 已迟到' : '') + '\n' : ''
    const recovery = bound.recoveryPending ? RECOVERY_NOTE + '\n\n' : ''
    const text = recovery + timing + row.body + '\n完成后调用 report_background，传入 ticketId=' + ticket.id + ' 及结果摘要或失败原因。没有新信息时可以用 silenceReason="no-change" 静默结束。需要用户输入时调用 ask_user，传入同一个 ticketId。'
    let rebuilt = false
    try {
      await this.sessions.prompt({ sessionId, requestId: row.requestId, text })
    } catch (error) {
      if (!isMissingSession(error) && error?.code !== 'session/not-found') throw error
      const latest = currentTicket()
      if (!latest) return inactive
      if (recovering || !timer) throw Object.assign(error, { permanent: true })
      deferred = this.#deferTimerDelivery(latest, recovering)
      if (deferred) return deferred
      const { proposedSessionId, ...background } = latest.background
      sessionId = await this.#bindBackgroundWorker({ ...latest, background }, owner, undefined, recovering)
      const rebound = currentTicket()
      if (!sessionId || !rebound || rebound.workerSession?.sessionId !== sessionId) return inactive
      deferred = this.#deferTimerDelivery(rebound, recovering)
      if (deferred) return deferred
      await this.sessions.prompt({ sessionId, requestId: row.requestId, text })
      rebuilt = true
    }
    const latest = this.tasks.getTicket(ticket.id)
    if (!latest) return
    if (!this.#isTerminalTicket(latest)) {
      this.tasks.markDelivered(ticket.id)
      if (latest.recoveryPending) this.tasks.noteRecoveryCarried(ticket.id)
    }
    if (!recovering) this.#mergeTicket(ticket.id, {
      lastDelivery: { state: 'sent', created: !worker, rebuilt, at: this.now() },
    })
  }

  #isBoundWorker(ticket, sessionId) {
    return Boolean(sessionId && ticket?.authorization && ticket.workerSession?.sessionId === sessionId
      && !this.registry.isOwnerSession(sessionId) && !this.sessions.isArchived?.(sessionId))
  }

  #canAskWorker(ticket, sessionId) {
    return this.#isBoundWorker(ticket, sessionId)
      && (ticket.stage === 'working' || (ticket.background && ticket.stage === 'idle'))
  }

  #workerHasActiveTask(sessionId, check) {
    if (!sessionId || this.store.closed) return false
    const rows = this.store.db.prepare(
      "SELECT value FROM ticket WHERE json_extract(value, '$.workerSession.sessionId') = ?",
    ).all(sessionId)
    return rows.some(row => check(JSON.parse(String(row.value)), sessionId))
  }

  isManagedWorker(sessionId) {
    return this.#workerHasActiveTask(sessionId, (ticket, id) => this.#canAskWorker(ticket, id))
  }

  #canReportBackground(ticket, sessionId) {
    return Boolean(ticket?.background && this.#canAskWorker(ticket, sessionId))
  }

  isBackgroundWorker(sessionId) {
    return this.#workerHasActiveTask(sessionId, (ticket, id) => this.#canReportBackground(ticket, id))
  }

  #ensureRun(ticket, trigger = ticket?.background ? this.getTrigger(ticket.triggerId) : undefined) {
    if (ticket?.background && trigger?.source?.kind === ticket.background.kind) {
      return this.runs.ensure({
        ticketId: ticket.id, triggerRef: trigger.id, ownerId: ticket.owner, source: trigger.source, at: ticket.createdAt,
      })
    }
    return undefined
  }

  async reportBackground({ ticketId, sessionId, summary, failure, evidence, silenceReason }) {
    const ticket = this.tasks.getTicket(ticketId)
    if (!this.#canReportBackground(ticket, sessionId)) {
      throw new RouterError('background-worker-mismatch', 'Only the bound worker may report for this active task')
    }
    const count = [summary, failure, silenceReason].filter(value => value !== undefined).length
    const invalidReason = silenceReason !== undefined && (typeof silenceReason !== 'string' || !Object.hasOwn(SILENCE_REASONS, silenceReason))
    if (count !== 1 || invalidReason) {
      throw new RouterError('background-report-invalid', 'Provide one summary, failure, or recognized silence reason')
    }
    return this.#persistWork(() => {
      this.tasks.markDelivered(ticketId)
      if (silenceReason !== undefined) {
        if (!this.#ensureRun(ticket)) throw new RouterError('background-source-missing', 'The original background source is unavailable.')
        const saved = this.tasks.finishBackgroundCheck(ticketId)
        this.runs.recordSilent(ticketId, silenceReason)
        return { ticketId, stage: saved.stage }
      }
      const saved = failure === undefined ? this.tasks.report({ ticketId, summary, evidence }) : this.tasks.fail({ ticketId, reason: failure })
      this.#enqueueBackgroundReport(saved)
      return { ticketId, stage: saved.stage }
    })
  }

  #enqueueBackgroundReport(ticket) {
    const report = this.runner.enqueue({
      kind: 'background-report', ticketId: ticket.id, triggerId: ticket.triggerId, to: 'owner:' + ticket.owner,
      body: '[hub-bot 后台结果] ' + factLine(ticket), requestId: 'hub-bot-background-result-' + ticket.id + '-' + this.ids.uuid(),
    })
    const trigger = this.getTrigger(ticket.triggerId)
    if (!this.#ensureRun(ticket, trigger)) return
    const kind = ticket.stage === 'failed' ? 'failure' : ticket.stage === 'blocked' ? 'blocked' : 'result'
    this.runs.recordResult(ticket.id, { kind, reportId: report.id })
    this.#queueBackgroundNotification(ticket, trigger, kind)
  }

  #queueBackgroundNotification(ticket, trigger, kind) {
    const source = trigger.source
    let to, triggerId = trigger.id
    if (source.kind === 'github' && typeof source.repo === 'string' && /^[a-z0-9_-]+[/][a-z0-9_.-]+$/i.test(source.repo)
      && Number.isSafeInteger(source.issueNumber) && source.issueNumber > 0) {
      to = 'github:' + source.repo + ':' + source.issueNumber
    } else if (source.kind === 'timer' && this.#hasOriginalTimerAuthorization(source, ticket.authorization)) {
      to = 'feishu:chat:' + source.origin.chatId
      triggerId = source.origin.triggerId
    }
    if (!to) return
    const status = { result: '有结果待验收', failure: '执行失败', blocked: '需要介入' }[kind]
    const row = insertOutbox(this.store, {
      ticketId: ticket.id, triggerId, kind: 'reply', state: 'recorded', to,
      body: '后台任务 ' + ticket.id + ' ' + status + '。在 Hub Bot 运行记录中可查看详情。',
      requestId: 'hub-bot-run-notice-' + this.ids.uuid(),
    }, () => Date.parse(this.now()))
    this.runs.linkOutbox(ticket.id, row.id)
  }

  async #deliverBackgroundReport(row) {
    const ticket = this.tasks.getTicket(row.ticketId)
    const owner = ticket && this.registry.get(ticket.owner)
    if (!owner || owner.recycled) return { recorded: true, skipped: 'owner-unavailable' }
    await this.#promptOwner(owner.id, null, row.requestId, row.body)
  }

  /** Admit a prompt, retrying a missing binding only while the originating ticket is active. */
  #promptOwner(ownerId, ticketId, requestId, text, isCurrent) {
    return this.#serialized('owner-prompt:' + ownerId, async () => {
      const ticketClosed = () => {
        if (this.store.closed || (isCurrent && !isCurrent())) return true
        if (ticketId === null) return false
        const latest = this.tasks.getTicket(ticketId)
        return !latest || this.#isTerminalTicket(latest)
      }
      const send = async sessionId => {
        const key = 'owner-bootstrap/' + ownerId
        const plan = this.store.get(key)
        const initializing = plan?.sessionId === sessionId
        const facts = initializing ? formatOwnerFacts(buildOwnerFacts({
          store: this.store, ownerId, isArchived: id => this.sessions.isArchived?.(id) === true,
        })) : ''
        const message = facts ? facts + '\n\n' + text : text
        const result = await this.sessions.prompt({ sessionId, requestId, text: message })
        if (result?.accepted === false) throw new RouterError('owner-not-admitted', 'The owner Session did not accept the prompt.')
        if (initializing && !this.store.closed && this.store.get(key)?.sessionId === sessionId) {
          this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
        }
        return { sessionId, rebuilt: initializing }
      }
      if (ticketClosed()) return null
      let owner = this.registry.get(ownerId)
      if (!owner || owner.recycled) throw new RouterError('owner-unavailable', 'The registered owner is unavailable.')
      const ensured = await this.#ensureSession(owner)
      const sessionId = this.registry.get(ownerId)?.sessionId ?? ensured.sessionId
      if (ticketClosed()) return null
      try {
        return await send(sessionId)
      } catch (error) {
        if (ticketClosed()) return null
        if (!isMissingSession(error) && error?.code !== 'session/not-found') throw error
      }
      owner = this.#persistWork(() => {
        const current = this.registry.get(ownerId)
        if (!current || current.recycled) throw new RouterError('owner-unavailable', 'The registered owner is unavailable.')
        if (current.sessionId !== sessionId) return current
        this.store.set('owner-bootstrap/' + ownerId, { sessionId: 'session-' + this.ids.uuid(), missingSessionId: sessionId })
        return this.registry.markSessionMissing(ownerId)
      })
      const replacement = await this.#ensureSession(owner)
      if (ticketClosed()) return null
      try {
        const receipt = await send(replacement.sessionId)
        return { ...receipt, rebuilt: replacement.sessionId !== sessionId }
      } catch (error) {
        if (ticketClosed()) return null
        throw error
      }
    })
  }

  /**
   * Digest delivery (#67): the wake ends when the owner's Session goes idle — until then the row postpones
   * itself WITHOUT burning attempts, so every report of one wake lands as ONE merged message on the chief
   * (每次唤醒至多一条对外汇报). The text renders stored face facts only (汇报以票面为准).
   */
  async #deliverDigest(row) {
    const owner = this.registry.get(row.ownerId)
    if (!owner) {
      const error = new Error('digest ' + row.id + ': owner ' + row.ownerId + ' is gone from the registry')
      error.permanent = true
      throw error
    }
    const sessionId = owner.sessionId
    if (sessionId && this.sessions.isRunning && await this.sessions.isRunning(sessionId)) {
      return { postponeMs: 2000 } // the wake is still running — keep coalescing
    }
    await this.#promptOwner('chief', null, row.requestId, buildDigestText(row))
  }

  /**
   * Reply delivery (#67 统一出口): session-addressable rows are admitted to that Session (the chief for
   * 'dsh:session:chief'); external targets (feishu:…) remain recorded intents until their channel lands.
   */
  async #deliverReply(row) {
    if (row.to === 'dsh:session:chief') {
      await this.#promptOwner('chief', null, row.requestId, row.body)
      return
    }
    if (typeof row.to === 'string' && row.to.startsWith('session:')) {
      await this.sessions.prompt({ sessionId: row.to.slice('session:'.length), requestId: row.requestId, text: row.body })
      return
    }
    // #64 不假装发了飞书: undeliverable targets (default 'dsh' without a channel, feishu:…) are RECORDED
    // persistent intents — a future channel scans state:'recorded' rows; only real delivery earns 'sent'.
    return { recorded: true }
  }

  /**
   * Scheduled auto-summary (#67 定时汇总自动汇报, OFF by default): one truncated status summary to the
   * unified outlet, listing only active stages (结果可用或需要行动). The dev API forces a tick for proofs.
   */
  async autoReportTick({ force } = {}) {
    const reporting = this.config?.reporting ?? { auto: false, intervalMs: 60000 }
    if (!reporting.auto) return { skipped: 'disabled' }
    const nowMs = Date.parse(this.now())
    if (!force && this.#lastAutoReportAt !== null && nowMs - this.#lastAutoReportAt < reporting.intervalMs) {
      return { skipped: 'interval' }
    }
    const text = buildAutoSummary(this.queryTasks({}))
    if (!text) return { skipped: 'empty' }
    // 消息纪律: an unchanged status is not news — never repeat the same summary (只在结果可用或需要行动时说话).
    if (text === this.#lastAutoReportText) return { skipped: 'unchanged' }
    const receipt = await this.replySource({ text, to: 'dsh:session:chief' })
    this.#lastAutoReportAt = nowMs
    this.#lastAutoReportText = text
    return { outboxId: receipt.outboxId, truncated: receipt.truncated }
  }

  #ticketByTrigger(triggerId) {
    const rows = this.store.db.prepare('SELECT value FROM ticket').all()
    for (const raw of rows) {
      const ticket = JSON.parse(String(raw.value))
      if (ticket.triggerId === triggerId) return ticket
    }
    return undefined
  }

  /**
   * Task store query (spec: query_tasks) — filter by owner and/or stage; newest first. Each row carries
   * stageText, the VERBATIM reading of the stage (spec: 状态摘要是对状态的朗读，不是 LLM 的即兴总结）.
   */
  queryTasks({ owner, stage } = {}) {
    const rows = this.store.db.prepare('SELECT value FROM ticket').all()
      .map(raw => JSON.parse(String(raw.value)))
      .map(ticket => ({ ...ticket, stage: normalizeStage(ticket.stage) }))
      .filter(ticket => (owner === undefined || ticket.owner === owner) && (stage === undefined || ticket.stage === stage))
      .map(ticket => ({ ...ticket, stageText: STAGE_TEXT[ticket.stage], detail: this.tasks.summarize(ticket.id).detail ?? null }))
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Queue a durable reply. A Feishu trigger reference binds the destination and the receipt to one message.
   */
  async replySource({ text, to, triggerRef }) {
    if (typeof text !== 'string' || !text.trim()) throw new RouterError('text-required', 'reply_source: text must be a non-empty string')
    let target = to ?? 'dsh'
    if (triggerRef !== undefined) {
      const trigger = typeof triggerRef === 'string' ? this.getTrigger(triggerRef) : null
      const chatId = trigger?.source?.chatId
      if (trigger?.kind !== 'feishu' || trigger.dropped || !chatId) {
        throw new RouterError('invalid-reply-trigger', 'reply_source: use the triggerRef of the original Feishu message')
      }
      target = 'feishu:chat:' + chatId
      if (to !== undefined && to !== target && to !== 'feishu:' + chatId) {
        throw new RouterError('reply-target-mismatch', 'reply_source: the supplied address does not match the Feishu message')
      }
    }
    const { text: body, truncated } = truncateWords(text.trim())
    const row = this.runner.enqueue({
      ticketId: null, kind: 'reply', to: target, body, requestId: 'hub-bot-reply-' + this.ids.uuid(),
      ...(triggerRef !== undefined && { triggerId: triggerRef }),
    })
    await this.runner.tick({ excludeKind: 'deferred-decision' })
    return { outboxId: row.id, state: this.#outboxRow(row.id).state, truncated }
  }

  #outboxRow(id) {
    const raw = this.store.db.prepare('SELECT value FROM outbox WHERE id = ?').get(id)
    return raw === undefined ? undefined : JSON.parse(String(raw.value))
  }

  /** Outbox rows, oldest first. */
  listOutbox() {
    return this.store.db.prepare('SELECT value FROM outbox ORDER BY at').all().map(raw => JSON.parse(String(raw.value)))
  }
}
