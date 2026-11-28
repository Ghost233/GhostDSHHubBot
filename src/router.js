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
import { OutboxRunner, insertOutbox } from './outbox.js'
import { feishuPrompt, UNSUPPORTED_MESSAGE_TYPE } from './inbox.js'
import { truncateWords } from './discipline.js'
import { buildDigestText, buildAutoSummary } from './reporting.js'
import { confirmTicketFork } from './fork.js'
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

  constructor({ store, registry, sessions, tasks, runner, config, now, ids, onSystemProblem, placer }) {
    this.store = store
    this.registry = registry
    this.sessions = sessions
    this.config = config ?? { reporting: { auto: false, intervalMs: 60000 } }
    this.now = now ?? (() => new Date().toISOString())
    this.ids = ids ?? { uuid: () => randomUUID() }
    // The lifecycle guard lives in TaskBoard (#66); Router drives tickets through it, never around it.
    this.tasks = tasks ?? new TaskBoard({ store, now: this.now })
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
      onSystemProblem,
    })
  }

  #persistWork(write) {
    const db = this.store.db
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
    if (previous && (pending || previous.injectedAt !== null || previous.dropped || !previous.authorization || incoming.dropped)) {
      return { ...receipt, dropped: previous.dropped ?? null, outboxId: pending?.id ?? null }
    }

    const stop = !previous && !incoming.dropped && ['停', '停止'].includes(incoming.message)
    const sessionId = stop ? this.registry.get('chief')?.sessionId ?? null : null
    const skipStop = stop && (!sessionId ? 'no-current-session' : this.#currentStops.has(sessionId) ? 'interrupt-in-flight' : null)
    const trigger = {
      ...(previous ?? incoming),
      ownerId: 'chief',
      injectedAt: null,
      policy: previous?.policy ?? { ...incoming.policy, mode: incoming.dropped ? 'drop' : stop ? 'interrupt' : 'queue' },
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
          id: outboxId, ticketId: null, triggerId: id, kind: stop ? 'stop' : 'inbox', to: 'owner:chief',
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
    if (trigger.injectedAt) return
    const ensured = await this.#ensureChiefSession()
    const model = this.config.chief?.model
    if (model) {
      try { await this.sessions.selectModel?.({ sessionId: ensured.sessionId, ...model }) }
      catch { /* Keep the configured deployment model if selection is unavailable. */ }
    }
    await this.#promptOwner('chief', ensured, null, row.requestId, feishuPrompt(trigger))
    if (!this.store.closed) this.#updateTrigger({ ...this.getTrigger(trigger.id), injectedAt: this.now() })
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
    await this.runner.tick()
    await this.#sweepConfirmTimeouts()
    // #72 执行槽： a slot freed since the last pulse promotes the oldest queued ticket (FIFO); the second
    // runner pass delivers the released injection in the same pulse （提升即投递）.
    await this.#promoteQueued()
    await this.runner.tick()
  }

  /**
   * 确认超时清扫： a person/confirm request unanswered for CONFIRM_TIMEOUT_MS auto-cancels (person/confirm →
   * done, by 'system') and the cancellation is announced through the chief （统一出口）. The announce row is
   * stored-then-delivered by the runner like every outward message （先存后做）; a ticket cancelled once leaves
   * person/confirm, so the notice fires exactly once.
   */
  async #sweepConfirmTimeouts() {
    const nowMs = Date.parse(this.now())
    for (const ticket of this.queryTasks({ stage: 'person/confirm' })) {
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
  async #confirmPendingFork(owner, ticket, ticketId) {
    let result
    try {
      result = await confirmTicketFork({ tasks: this.tasks, sessions: this.sessions, ticketId })
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
    await this.runner.tick()
    return { ownerId: owner.id, sessionId: ensured.sessionId, ticketId, requestId: ticket.requestId, createdSession: ensured.created, rebuilt: false, deduped: false, confirmed: true, fork: { fromSessionId: result.fromSessionId, sessionId: result.sessionId }, stage: 'working' }
  }

  /**
   * resolution:'confirm' for a blacklist-held injection (#73 补足, spec「Policy」): the stored message is
   * injected exactly as it would have been — route/follow-up entries wake the OWNER session (with the
   * ticket's authorization record), owner-inject entries deliver the L2's stored text to the execution
   * session. The confirm transition lands first; the injection then persists through the outbox like
   * every other (先存后做, retryable).
   */
  async #confirmDangerousInject(owner, ticket, ticketId) {
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
      // 顺序说明: prompt 先于 confirm —— confirm 转移合法实际不抛, 窄窗重复风险已在案 (审查 P2 接受)。
      const requestId = 'hub-bot-owner-' + this.ids.uuid()
      await this.sessions.prompt({ requestId, sessionId: action.sessionId, mode: 'queue', content: [{ type: 'text', text: action.text }] })
      try { this.tasks.confirm({ ticketId, result: { injected: { entry: action.entry, sessionId: action.sessionId, requestId } }, by: 'user' }) } catch (error) { throw translateTaskError(error, (code, message) => new RouterError(code, message)) }
      return { ownerId: owner.id, sessionId: action.sessionId, ticketId, requestId, createdSession: false, rebuilt: false, deduped: false, confirmed: true, stage: 'working' }
    }
    const ensured = await this.#ensureSession(owner)
    const label = action.entry === 'follow-up' ? '[hub-bot 追问 ' + ticketId + '] ' : '[hub-bot 路由 ' + ticketId + '] '
    const text = label + action.message + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + ticketId
      + '\n\n（本条消息命中危险命令黑名单，已经用户确认放行）'
    const requestId = 'hub-bot-route-' + this.ids.uuid()
    try { this.tasks.confirm({ ticketId, result: { injected: { entry: action.entry, requestId } }, by: 'user' }) } catch (error) { throw translateTaskError(error, (code, message) => new RouterError(code, message)) }
    this.runner.enqueue({ ticketId, kind: 'inject', to: 'session:' + ensured.sessionId, sessionId: ensured.sessionId, body: text, requestId })
    await this.runner.tick()
    return { ownerId: owner.id, sessionId: ensured.sessionId, ticketId, requestId, createdSession: ensured.created, rebuilt: false, deduped: false, confirmed: true, stage: 'working' }
  }

  /** Restart recovery: end running assignments "host restarted" and arm the recovery note (spec: 重启恢复）. */
  /**
   * Restart recovery (spec「重启恢复」 + #72 AC1 自动恢复）: assignments running at the crash end "host
   * restarted", then every working ticket gets a FRESH recovery injection automatically — 最旧优先， through
   * the execution-slot gate: the per-owner overflow demotes to queued and its injection is stored HELD
   * (#promoteQueued admits it when a slot frees). The recovery note itself is prepended at delivery time
   * (carried exactly once). Idle/queued tickets already hold their stored rows — the runner redelivers them.
   */
  async markRestart() {
    this.tasks.markRestart()
    const pending = this.store.db.prepare('SELECT value FROM ticket').all()
      .map(raw => JSON.parse(String(raw.value)))
      .filter(ticket => ticket.recoveryPending === true && normalizeStage(ticket.stage) === 'working')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) // 最旧优先
    if (pending.length === 0) return { resumed: 0, queued: 0 }
    let resumed = 0
    let queued = 0
    const perOwner = new Map()
    for (const ticket of pending) {
      const owner = this.registry.get(ticket.owner)
      if (!owner || owner.recycled) continue // 负责人已回收：无处可恢复，票面保持原样
      const existing = this.listOutbox().find(row => row.ticketId === ticket.id && row.kind === 'inject'
        && (row.state === 'queued' || row.state === 'held') && row.body.startsWith('[hub-bot 恢复 ' + ticket.id + ']'))
      if (existing) continue // 幂等：恢复注入已存，不重复补投
      const count = perOwner.get(ticket.owner) ?? 0
      const atCapacity = count >= this.#slotsPerOwner() // 执行槽闸门：槽满则 queued 等位
      perOwner.set(ticket.owner, count + 1)
      if (atCapacity) {
        try { this.tasks.demote(ticket.id) } catch { continue } // 期间被别的路径改态 — 交给那条路径
        queued++
      } else {
        resumed++
      }
      const ensured = await this.#ensureSession(owner)
      const trigger = ticket.triggerId ? this.getTrigger(ticket.triggerId) : null
      const auth = ticket.authorization ?? { actor: 'user', source: 'dsh', at: ticket.createdAt }
      const original = ticket.routedMessage || trigger?.message || '（原始指令见会话历史）'
      const text = '[hub-bot 恢复 ' + ticket.id + '] 宿主重启，任务自动恢复（最旧优先）。原始任务：' + original
        + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + ticket.id
      this.runner.enqueue({
        ticketId: ticket.id, kind: 'inject', to: 'session:' + ensured.sessionId, sessionId: ensured.sessionId,
        body: text, requestId: 'hub-bot-resume-' + this.ids.uuid(), held: atCapacity,
      })
    }
    await this.runner.tick()
    return { resumed, queued }
  }

  /** The chief's own Session (L1 统一出口): digests and replies are admitted here. */
  #ensureChiefSession() {
    return this.#serialized('chief-session', async () => {
      const chief = this.registry.get('chief')
      if (!chief) throw new RouterError('chief-missing', 'the chief owner row is missing from the registry')
      return await this.#ensureSession(chief)
    })
  }

  /** Lazily binds an owner Session: create only when the registry names none. */
  async #ensureSession(owner) {
    if (owner.sessionId) {
      // 归档自愈 (round 51): 已绑定会话被归档 → DSH gate 拒跑（turn blocked 无报错）。发现即解，失败只告警。
      if (this.placer) await this.placer.ensureUnarchived(owner.sessionId, owner.id)
      return { owner, sessionId: owner.sessionId, created: false }
    }
    // GUI 工作区 (#52): 出生即归位——create({ workspaceId }) 是唯一让会话进工作区的路径（cwd 自动 =
    // 工作区 path：owner 仓库工作区 path 本就等于 owner.cwd；chief 专属工作区落在 homeRepo/.hub-bot/chief）。
    // placer 不可用或失败 → null → 回退 cwd 创建，主链路不受展示层影响。
    const ws = this.placer
      ? await (owner.role === 'chief' ? this.placer.chiefWorkspace() : this.placer.ownerWorkspace(owner))
      : null
    const preset = owner.role === 'chief' ? 'hub-bot-router' : 'hub-bot-owner'
    const created = await this.sessions.create(ws
      ? { workspaceId: ws.workspaceId, agentPreset: preset }
      : { cwd: owner.cwd, agentPreset: preset })
    const sessionId = created.sessionId ?? created.session?.id
    if (!sessionId) throw new RouterError('session-create-empty', 'owner Session creation returned no sessionId')
    const bound = this.registry.bindSession(owner.id, sessionId)
    return { owner: bound, sessionId, created: true }
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
    this.tasks.askConfirm({
      ticketId,
      question: dangerousConfirmText(pattern, message),
      action: { type: DANGEROUS_INJECT_ACTION, entry, message, ...extra },
    })
    return true
  }

  async routeToOwner({ ownerId, message, triggerRef, ticketId, resolution, authorization }) {
    if (typeof message !== 'string' || !message.trim()) throw new RouterError('message-required', 'route_to_owner: message must be a non-empty string')
    const route = () => this.#serialized('owner:' + ownerId, () =>
      this.#routeToOwnerLocked({ ownerId, message: message.trim(), triggerRef, ticketId, resolution, authorization }))
    return ticketId === undefined && triggerRef !== undefined
      ? this.#serialized('trigger:' + triggerRef, route)
      : route()
  }

  /** routeToOwner's body, run under the per-owner chain (see routeToOwner). */
  async #routeToOwnerLocked({ ownerId, message, triggerRef, ticketId, resolution, authorization }) {
    const owner = this.registry.get(ownerId)
    if (!owner) throw new RouterError('unknown-owner', 'route_to_owner: unknown owner "' + ownerId + '" — call list_owners first')
    // chief 不是路由目标——但仅约束「新建任务」；带 ticketId 的 resolution 裁决（面板 confirm/reject）
    // 是票面状态机推进，不给 chief 会话发消息，chief 票（如黑名单挂起的注入）必须能由此裁决。
    if (owner.role === 'chief' && ticketId === undefined) throw new RouterError('cannot-route-to-chief', 'route_to_owner: the chief is the router, not a route target')
    // #70: a recycled scratch owner's directory is gone (物理上无法恢复) — follow-ups to its finished task start
    // a NEW task instead (spec「已结束任务的跟进」例外); never route into a recycled row.
    if (owner.recycled) throw new RouterError('owner-recycled', 'route_to_owner: owner ' + ownerId + ' 已回收（临时目录已删）——请新建任务，不要复活旧负责人')
    if (ticketId !== undefined) return this.#followUp({ owner, message, ticketId, resolution, authorization })
    if (resolution !== undefined) throw new RouterError('resolution-needs-ticket', 'route_to_owner: resolution requires ticketId')
    const existing = triggerRef === undefined ? undefined : this.getTrigger(triggerRef)
    if (existing) {
      const ticket = this.#ticketByTrigger(triggerRef)
      if (ticket || !['feishu', 'route'].includes(existing.kind)) {
        const sessionId = ticket ? ticket.targetSession ?? this.registry.get(ticket.owner)?.sessionId : owner.sessionId
        return {
          ownerId: ticket?.owner ?? ownerId, ...(sessionId && { sessionId }),
          ...(ticket && { ticketId: ticket.id }), requestId: ticket?.requestId ?? null,
          createdSession: false, rebuilt: false, deduped: true, stage: ticket ? normalizeStage(ticket.stage) : null,
        }
      }
      if (existing.dropped || !existing.authorization || existing.policy?.mode === 'interrupt'
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
    const trigger = existing ?? {
      id: triggerRef ?? 'trg-' + this.ids.uuid(), kind: 'route', ownerId, message: instruction, authorization: auth, at,
      source: { kind: 'route', addressing },
      policy: { addressing, mode: 'queue', allowed: true, reason: null },
    }
    const requestId = 'hub-bot-route-' + this.ids.uuid()
    const freshTicketId = 'tsk-' + this.ids.uuid()
    const atCapacity = this.#workingCount(ownerId) >= this.#slotsPerOwner()
    // Write the source, ticket, and confirmation or delivery intent before creating a Session.
    const awaitingConfirmation = this.#persistWork(() => {
      if (!existing) this.#insertTrigger(trigger)
      this.#insertTicket({
        id: freshTicketId, triggerId: trigger.id, owner: ownerId, stage: atCapacity ? 'queued' : 'idle', mechanism: 'inject',
        targetSession: owner.sessionId, requestId, authorization: auth, createdAt: at, updatedAt: at,
        ...(existing?.kind === 'feishu' && { routedMessage: instruction }),
      })
      if (this.#holdDangerous(freshTicketId, instruction, 'route')) return true
      const text = '[hub-bot 路由 ' + freshTicketId + '] ' + instruction + '\n\n授权：' + auth.actor + ' 经 ' + auth.source + ' 于 ' + auth.at + '；任务 ' + freshTicketId
      this.runner.enqueue({
        ticketId: freshTicketId, triggerId: trigger.id, kind: 'inject',
        to: owner.sessionId ? 'session:' + owner.sessionId : 'owner:' + ownerId,
        sessionId: owner.sessionId, body: text, requestId, held: atCapacity,
      })
      return false
    })
    if (!awaitingConfirmation) await this.runner.tick()
    const stored = this.tasks.getTicket(freshTicketId)
    const sessionId = stored.targetSession ?? this.registry.get(ownerId)?.sessionId ?? null
    return {
      ownerId, ...(sessionId !== null && { sessionId }), ticketId: freshTicketId, requestId, createdSession: !owner.sessionId && sessionId !== null,
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
          if (working >= this.#slotsPerOwner()) break
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
    await this.runner.tick()
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
    if (row.kind === 'digest') return this.#deliverDigest(row)
    if (row.kind === 'reply') return this.#deliverReply(row)
    if (row.kind !== 'inject') return
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
    const ensured = await this.#ensureSession(owner)
    // S01： #ensureSession 是异步的（可能真的新建了一个 Session）。等它回来时票可能已经结案 —— 以库里
    // 当前的票面为准再判一次，结案就安静跳过：不注入、不抛错、不改票面。
    const latest = this.tasks.getTicket(ticket.id)
    if (latest === undefined) throw permanent('outbox ' + row.id + ': ticket ' + row.ticketId + ' is gone')
    if (this.#isTerminalTicket(latest)) return { recorded: true, skipped: 'ticket-terminal' }
    // 重启恢复 (same discipline as follow-ups): a row stored BEFORE a crash carries no recovery note in its
    // body — prepend it at redelivery time, and clear the flag only after the prompt actually lands (a
    // failed attempt keeps the flag so the next retry still carries the note — 恰好一次 = delivered once).
    const needsNote = latest.recoveryPending === true
    const body = needsNote ? RECOVERY_NOTE + '\n\n' + row.body : row.body
    const delivered = await this.#promptOwner(owner.id, ensured, ticket.id, row.requestId, body)
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

  /** Admit a prompt, retrying a missing binding only while the originating ticket is active. */
  async #promptOwner(ownerId, ensured, ticketId, requestId, text) {
    const sessionId = ensured.sessionId
    const ticketClosed = () => {
      if (ticketId === null) return false
      const latest = this.tasks.getTicket(ticketId)
      return !latest || this.#isTerminalTicket(latest)
    }
    try {
      await this.sessions.prompt({ sessionId, requestId, text })
      return { sessionId, rebuilt: false }
    } catch (error) {
      if (ticketClosed()) return null
      if (!isMissingSession(error)) throw error
    }
    const current = this.registry.get(ownerId)
    if (!current) throw new RouterError('unknown-owner', 'owner ' + ownerId + ' is no longer registered')
    if (current.sessionId === sessionId) this.registry.markSessionMissing(ownerId)
    const replacement = await (ownerId === 'chief' ? this.#ensureChiefSession() : this.#ensureSession(this.registry.get(ownerId)))
    if (ticketClosed()) return null
    try {
      await this.sessions.prompt({ sessionId: replacement.sessionId, requestId, text })
      return { sessionId: replacement.sessionId, rebuilt: replacement.sessionId !== sessionId }
    } catch (error) {
      if (ticketClosed()) return null
      throw error
    }
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
    const ensured = await this.#ensureChiefSession()
    await this.#promptOwner('chief', ensured, null, row.requestId, buildDigestText(row))
  }

  /**
   * Reply delivery (#67 统一出口): session-addressable rows are admitted to that Session (the chief for
   * 'dsh:session:chief'); external targets (feishu:…) remain recorded intents until their channel lands.
   */
  async #deliverReply(row) {
    if (row.to === 'dsh:session:chief') {
      const ensured = await this.#ensureChiefSession()
      await this.#promptOwner('chief', ensured, null, row.requestId, row.body)
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
    await this.runner.tick()
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
