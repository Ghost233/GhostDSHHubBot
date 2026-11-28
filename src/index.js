/**
 * hub-bot plugin entry: opens the versioned state store, bootstraps the chief owner row (lazy — registered
 * 'pending', its Session is created on first use), installs the process-wide hub singleton for the preset-subtree
 * tool plugins (src/router-tools.js), and — only when config.devApi explicitly enables it with a token — serves
 * the loopback development management API.
 *
 * The management API (/hub-bot/api/, loopback + x-hub-bot-token):
 *   GET  state                                   store + schema health
 *   GET  owners                                  owner registry rows (spec「数据模型」)
 *   POST sessions    {cwd?, agentPreset?}        create a Session; with {owner} also binds the registry row
 *   POST route       {ownerId, message, triggerRef?}  route one message (same core as the L1 tool)
 *   POST owners/invalidate-session {ownerId}     point a row at a dangling Session id (deleted-Session proof aid)
 *   POST inject      {sessionId, text, mode?, requestId?}  queue/steer a message (sessionController.prompt)
 *   POST decorate    {sessionId}                 register the hub_bot_ping tool on the Session's Agent
 *   POST wait        {sessionId, timeoutMs?}     wait for the Session to go idle (sessionController.wait)
 *   GET  transcript  ?sessionId=&maxMessages=    durable transcript records (sessionController.page)
 *   POST deliver                              drive one outbox delivery pass (deterministic retry proof aid)
 *
 * Reliability (#66): at startup the plugin ends every running assignment "host restarted" (markRestart — the
 * next injection carries the recovery note) and resumes queued outbox deliveries; a 1s timer keeps driving
 * the runner so backed-off retries fire without any new traffic (spec「可靠性」重启恢复).
 */
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveConfig } from './config.js'

/** 面板头部栏展示用（round 36）：read() 视图带上插件版本。 */
const PKG_VERSION = createRequire(import.meta.url)('../package.json').version
import {
  SETTINGS_FILE, applySettingsOverlay, applySettingsPatch, loadSettingsOverlay, mergeSettingsOverlay,
  saveSettingsOverlay, buildOverview, buildOutboxHealth, buildSettingsView, feishuSelfTestMarker, readMessageDetail, readTicketDetail,
} from './panel.js'
import { discardOutboxRows, retryOutboxRows } from './outbox.js'
import { Store, SCHEMA_VERSION } from './store.js'
import { Hub, setHub } from './hub.js'
import { FeishuSource } from './feishu.js'
import { GitHubSource } from './github.js'
import { Recycler } from './recycle.js'
import { WorkspacePlacer } from './workspaces.js'
import { HubBotSettingsService } from './settings-service.js'
import { TimerService } from './timers.js'
import { buildOwnerFacts, formatOwnerFacts, listOwnerFactIndex, readOwnerFactDetail } from './owner-facts.js'
import { DeferredRegistry } from './deferred.js'
import { SILENCE_REASONS } from './runs.js'
import { OwnerSwitch } from './owner-switch.js'
import { HandoffSummaryRegistry } from './handoff-summary.js'
import { NotificationThrottle } from './notifications.js'

export const name = 'hub-bot'
export const inject = ['sessionController', 'sessionPersistence', 'webServer']

/**
 * cordis 配置 schema——DSH 插件管理界面据它渲染配置表单（没有这个导出，设置界面什么都不显示）。
 * 刻意的「声明式镜像」：schema 只负责 GUI 表单与形状校验，真正的校验/默认值真源仍是
 * src/config.js 的 resolveConfig（严格拒绝未知键）。两边必须同步演进。
 * 所有键不带 default —— 避免 cordis 把默认值回填进 patch 配置，改变 resolveConfig 的语义。
 */
export const Config = z.object({
  stateDir: z.string().description('插件状态目录（绝对路径）——任务票/触发器/负责人注册表的落盘位置。'),
  homeRepo: z.string().description('Home Repo 绝对路径——L1 总负责人的管辖根。'),
  workspaces: z.object({
    enabled: z.boolean().description('GUI 工作区归位总开关（关闭后负责人会话回落未分组）。'),
    chiefPath: z.string().description('L1 公共工作区目录（绝对路径；留空 = 默认 <homeRepo>/.hub-bot/chief）。警告：指定到 homeRepo 树外会让 chief 会话失去仓库 AGENTS.md 上下文。'),
    chiefTitle: z.string().description('L1 工作区标题（默认「Hub Bot 中枢」；你手动改过的名字不会被覆盖）。'),
  }).description('GUI 工作区归位 (#52)：负责人会话出生即落进工作区。'),
  feishu: z.object({
    enabled: z.boolean().description('飞书入口开关。'),
    // Accept the retired keys at the schema boundary so resolveConfig can report how to migrate.
    appId: z.string().hidden(),
    appSecret: z.string().hidden(),
    botOpenId: z.string().description('机器人自身 open_id（群聊定向使用）。'),
    credentialRef: z.string().description('DSH 凭据记录引用，默认 hub-bot/feishu。保存后重新加载插件。'),
  }).description('飞书渠道（设备流绑定见面板；配置只留引用，不落明文凭据）。'),
  github: z.object({
    enabled: z.boolean().description('GitHub 监听开关（新 Issue/@mention → 自动建票）。'),
    intervalMs: z.number().description('轮询间隔毫秒，最小 30000（30s）。'),
    mentionHandle: z.string().description('响应的 @handle，如 @hub-bot。'),
    loginAllowlist: z.array(z.string()).description('GitHub 登录名白名单（默认空 = 启动时解析为本人）。'),
  }).description('GitHub 渠道（监听范围跟随负责人注册表）。'),
  chief: z.object({
    model: z.object({
      provider: z.string().description('模型供应商 id。'),
      model: z.string().description('模型 id。'),
      reasoningEffort: z.string().description('推理档位（可选）。'),
    }).description('总管固定模型；整个 chief 段省略 = 跟随部署默认。'),
  }).description('L1 总管设置（模型也可在面板热改）。'),
  concurrency: z.object({
    slotsPerOwner: z.number().description('同 owner 并发 working 任务上限（默认 3）。'),
  }).description('执行槽 (#72)。'),
  deferred: z.object({
    ttlMs: z.number().description('确认和问答的默认期限（毫秒，缺省 24 小时）。'),
    ttlByAction: z.object({
      fork: z.number().description('Fork 确认的期限。'),
      'dangerous-inject': z.number().description('高风险注入确认的期限。'),
      'ask-user': z.number().description('用户问题的期限。'),
    }),
  }),
  notifications: z.object({
    windowMs: z.number().description('同一接收位置的普通结果通知间隔（毫秒，默认 60000）。'),
  }).description('普通后台结果汇总。'),
  reporting: z.object({
    auto: z.boolean().description('定时汇总自动汇报开关（默认关）。'),
    intervalMs: z.number().description('汇总间隔毫秒（默认 60000）。'),
  }).description('定时汇总 (#67)。'),
  security: z.object({
    dangerousPatterns: z.array(z.string()).description('危险命令黑名单整表（显式配置 = 整表替换默认清单）。'),
  }).description('注入安全 (#73)。'),
  devApi: z.object({
    token: z.string().description('管理 API token——开启 /hub-bot/api 与面板；为空则整个 API 不注册。'),
  }).description('管理 API 与面板（loopback + token）。'),
})

/** The decoration-probe tool registered on a Session by the /decorate route. */
export const PING_TOOL = {
  name: 'hub_bot_ping',
  description: 'Reply with a pong. hub-bot registers this tool to verify Session tool decoration works.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Optional text to echo back after "pong".' } },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', properties: { pong: { type: 'string' } }, required: ['pong'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: String(value.pong) }],
  },
  execute: async args => ({ pong: args?.text ? 'pong: ' + args.text : 'pong' }),
}

/** One JSON HTTP response. */
function json(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Reads a JSON request body, rejecting payloads over maxBytes. */
async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { throw new HttpError(400, 'Request body must be JSON') }
}

/** An HTTP-visible failure with a status code. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** A required non-empty string field of a request body. */
function requireString(body, key) {
  const value = body?.[key]
  if (typeof value !== 'string' || !value) throw new HttpError(400, key + ' must be a non-empty string')
  return value
}

/** An optional non-empty string field of a request body: undefined stays absent, anything else must be a string. */
function optionalString(body, key) {
  return body?.[key] === undefined ? undefined : requireString(body, key)
}

/** One AbortSignal that fires after ms. */
const deadline = ms => AbortSignal.timeout(ms)

// A previous plugin mount may still be waiting for the Host to admit a prompt.
const PROMPT_ADMISSIONS = Symbol.for('dsh-hub-bot:prompt-admissions')
const promptAdmissions = globalThis[PROMPT_ADMISSIONS] ??= new Map()

/** Constant-time token comparison; both sides are hashed first so length never leaks. */
function tokenMatches(presented, expected) {
  const hash = value => createHash('sha256').update(String(value)).digest()
  return timingSafeEqual(hash(presented ?? ''), hash(expected))
}

/** The preset one owner role runs. */
const presetForRole = role => role === 'chief' ? 'hub-bot-router' : 'hub-bot-owner'

/** Dynamic service probe (#52): missing on older DSH → undefined (插件照常加载)，throw 同样吞掉。 */
const safeGetService = (ctx, serviceName) => {
  try { return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined } catch { return undefined }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context with the injected DSH services.
 * @param {unknown} rawConfig - plugin configuration; stateDir and homeRepo are required absolute paths.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // 设置写回 (#73): the persisted overlay replays onto the profile config so panel changes survive
  // restarts; the plugin never edits the profile itself. Unknown keys reject at boot (same validation as POST).
  applySettingsOverlay(config, loadSettingsOverlay(config.stateDir))
  const store = new Store(config.stateDir)

  // #53: capture the service reference while this fiber's context is ACTIVE. A hot reload rebuilds the
  // fiber but the rebuilt context can end up inactive (cordis loader lifecycle) — lazy sessionController
  // access then throws "cannot get required service in inactive context" on every call. The captured service
  // object itself stays alive and usable regardless of the context state marker.
  const sessionController = ctx.sessionController
  const promptKey = (sessionId, requestId) => JSON.stringify([store.stateDir, sessionId, requestId])

  // The Sessions port of src/router.js over the real sessionController. prompt uses queue mode: an owner Session
  // is event-driven — an injected message wakes it exactly like a person typing (spec「核心原则」2).
  const sessions = {
    create: async request => {
      const value = await sessionController.create(request, deadline(30_000))
      return { sessionId: value.sessionId ?? value.session?.id, agentPreset: value.agentPreset }
    },
    isArchived: sessionId => (safeGetService(ctx, 'workspaceRegistry')?.archivedSessionIds ?? []).includes(sessionId),
    workerInfo: async sessionId => {
      const listed = await sessionController.list({}, deadline(10_000))
      const item = (listed.items ?? []).find(entry => entry.sessionId === sessionId)
      if (!item) return undefined
      const stored = await ctx.sessionPersistence.stat(sessionId, { signal: deadline(10_000) })
      return { cwd: item.cwd, agentPreset: stored?.header?.agentPreset ?? item.projections?.values?.agentPreset }
    },
    async hasPromptReceipt({ sessionId, requestId }) {
      const persistence = ctx.sessionPersistence
      const key = promptKey(sessionId, requestId)
      if (promptAdmissions.has(key) || typeof persistence.open !== 'function') return undefined
      const signal = deadline(7000)
      let reader
      try {
        const snapshot = await persistence.stat?.(sessionId, { signal })
        reader = await persistence.open(sessionId, 'read', { signal })
        const firstOwn = reader.inheritedEventCount
        if (reader.id !== sessionId || !Number.isSafeInteger(firstOwn) || firstOwn < 0) return undefined
        const budget = 8192
        const size = 256
        const start = Math.max(firstOwn, Number.isSafeInteger(snapshot?.eventCount) ? snapshot.eventCount - budget : firstOwn)
        for (let offset = start; offset < start + budget; offset += size) {
          const { events } = await reader.read(offset, size, { signal })
          for (const event of events) {
            const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
              : event.type === 'user/message' ? [event.data.message ?? event.data] : []
            if (messages.some(message => {
              const { source } = message
              return (source?.kind === 'user' || source?.kind === 'retry') && source.rpcId === requestId
            })) return true
          }
          if (events.length < size) {
            const complete = start === firstOwn && !(snapshot?.eventCount > offset + events.length)
            return complete && !promptAdmissions.has(key) ? false : undefined
          }
        }
        return undefined
      } catch {
        return undefined
      } finally {
        await reader?.close().catch(() => {})
      }
    },
    prompt: async ({ sessionId, requestId, text, content }) => {
      const key = promptKey(sessionId, requestId)
      promptAdmissions.set(key, (promptAdmissions.get(key) ?? 0) + 1)
      try {
        const value = await sessionController.prompt({
          requestId, sessionId, mode: 'queue', content: content ?? [{ type: 'text', text }],
        }, deadline(30_000))
        await ctx.sessionPersistence.flush()
        return value
      } finally {
        const remaining = promptAdmissions.get(key) - 1
        if (remaining > 0) promptAdmissions.set(key, remaining)
        else promptAdmissions.delete(key)
      }
    },
    // Wake coalescing (#67): digests flush once the owner Session goes idle, so one wake = one outward message.
    isRunning: async sessionId => {
      const listed = await sessionController.list({}, deadline(10_000))
      const item = (listed.items ?? []).find(s => s.sessionId === sessionId)
      return Boolean(item?.running)
    },
    // 总管模型 (面板「总管模型」): sessionController.selectModel —— 配置变更后下一条消息即生效。
    selectModel: async ({ sessionId, provider, model, reasoningEffort }) =>
      sessionController.selectModel({ sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }, deadline(30_000)),
    // 面板「总管模型」的数据源：部署内全部可路由模型（provider 分组 + 默认选择 + 隔离故障）。
    modelCatalog: () => sessionController.modelCatalog(deadline(30_000)),
    // #69 fork 路径（Lead 授权仅此 4 行）: the user-confirmed fork execution over sessionController.
    fork: async request => {
      const value = await sessionController.fork(request, deadline(30_000))
      await ctx.sessionPersistence.flush()
      return { sessionId: value.sessionId ?? value.session?.id }
    },
    // S06 显式停止（停 / 停止）: the router stops exactly ONE session through this port — the installed DSH
    // SessionCancelRequest shape is { sessionId } (no invented fields). Authorization stays with the caller:
    // the router only reaches here after the existing owner/actor check, so this never widens scope.
    cancel: request => sessionController.cancel({ sessionId: request.sessionId }, deadline(30_000)),
  }
  // GUI 工作区 (#52): ctx.get 动态探测（不放 inject 声明——旧版 DSH 无该服务时插件仍须可加载）。
  // 会话只能「出生即归位」（create({ workspaceId })）——已创建会话无任何归位 API（cwd 严格校验）。
  const placer = new WorkspacePlacer({ workspaceController: safeGetService(ctx, 'workspaceController'), homeRepo: config.homeRepo, workspaces: config.workspaces, logger: ctx.logger, registryList: () => safeGetService(ctx, 'workspaceRegistry')?.list?.() ?? [], archivedList: () => { try { return safeGetService(ctx, 'workspaceRegistry')?.archivedSessionIds ?? [] } catch { return [] } } })
  const hub = new Hub({ store, config, sessions, onSystemProblem: p => ctx.logger.warn('hub-bot system problem: %s (ticket %s, row %s)', p.reason, p.ticketId, p.rowId), placer })
  const chief = hub.registry.ensureChief({ cwd: config.homeRepo, workspace: basename(config.homeRepo) })
  const handoffSummaries = new HandoffSummaryRegistry({
    store, registry: hub.registry, now: hub.router.now,
    async readTranscript({ sessionId, maxBytes }) {
      const page = await sessionController.page({ address: { kind: 'session', sessionId }, maxMessages: 16 }, deadline(10000))
      const excerpts = []
      let throughSeq = null
      for (const record of page.records ?? []) {
        const event = record.event ?? record
        if (Number.isSafeInteger(event.seq) && event.seq >= 0) throughSeq = Math.max(throughSeq ?? 0, event.seq)
        if (!['user/message', 'assistant/message'].includes(event.type)) continue
        const message = event.data?.message
        const parts = Array.isArray(message?.content) ? message.content : []
        const text = parts.filter(part => part?.type === 'text' && typeof part.text === 'string')
          .slice(0, 3).map(part => part.text.slice(0, 320)).join(' ').replace(/\s+/gu, ' ').trim()
        if (!text) continue
        const role = event.type === 'user/message' ? '用户' : '助手'
        const seq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? '#' + event.seq + ' ' : ''
        const excerpt = Array.from(text).slice(0, 200).join('')
        excerpts.push(seq + role + '：' + excerpt + (excerpt === text ? '' : '…'))
      }
      const selected = excerpts.slice(-8)
      while (selected.length && Buffer.byteLength(selected.join('\n')) > maxBytes) selected.shift()
      return { text: selected.join('\n'), source: { sessionId, throughSeq, hasMore: page.hasMore === true } }
    },
    async summarize({ transcript, maxBytes }) {
      const lines = transcript.split('\n')
      const heading = '旧会话近期讨论摘记'
      while (lines.length && Buffer.byteLength([heading, ...lines].join('\n')) > maxBytes) lines.shift()
      return lines.length && lines.some(Boolean) ? [heading, ...lines].join('\n') : ''
    },
  })
  const handoffSummaryAction = async request => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new HttpError(400, 'A handoff summary request is required.')
    const { action, ownerId, expectedSessionId, draftId, revision, text } = request
    if (!['list', 'get', 'generate', 'edit', 'confirm', 'discard'].includes(action)) throw new HttpError(400, 'Unknown handoff summary operation.')
    const result = await handoffSummaries[action]({ ownerId, expectedSessionId, draftId, revision, text })
    return result ?? null
  }
  const ownerSwitch = new OwnerSwitch({
    store, registry: hub.registry, now: hub.router.now, handoffSummaries,
    withAdmission: (ownerId, work) => hub.router.withOwnerAdmission(ownerId, work),
    buildFacts: ({ ownerId }) => formatOwnerFacts(buildOwnerFacts({ store, ownerId, isArchived: id => sessions.isArchived(id) })),
    sessions: {
      async status({ sessionId }) {
        try {
          const state = await sessionController.state({ sessionId }, deadline(5000))
          const queued = state.queue?.some(entry => entry.placement === 'queued' || entry.placement === 'steering')
          return state.running || queued || state.pendingInput?.length ? 'busy' : 'idle'
        } catch (error) {
          if (error?.code === 'session/not-found' || error?.name === 'ApiSessionNotFound') return 'missing'
          throw error
        }
      },
      async create({ owner, sessionId }) {
        const ws = await (owner.role === 'chief' ? placer.chiefWorkspace() : placer.ownerWorkspace(owner))
        const agentPreset = owner.role === 'chief' ? 'hub-bot-router' : 'hub-bot-owner'
        const existing = await ctx.sessionPersistence.stat?.(sessionId, { signal: deadline(5000) })
        if (existing) {
          if (existing.header?.agentPreset !== agentPreset || existing.header?.cwd !== (ws?.path ?? owner.cwd)) {
            throw new Error('Proposed owner session does not match its stored preset and workspace.')
          }
          return { sessionId, agentPreset }
        }
        return sessions.create({ ...(ws ? { workspaceId: ws.workspaceId } : { cwd: owner.cwd }), sessionId, agentPreset })
      },
      prompt: sessions.prompt,
      cancel: sessions.cancel,
      isArchived: sessions.isArchived,
      async archive({ sessionId }) {
        const controller = safeGetService(ctx, 'workspaceController')
        if (!controller?.archiveSession) throw new Error('此 DSH 实例暂时无法归档会话。')
        const result = await controller.archiveSession({ sessionId, stopActivity: false })
        if (!result?.archivedSessionIds?.includes(sessionId)) throw new Error('宿主未确认旧会话已归档。')
      },
    },
    recordChange: operation => hub.router.publishOwnerSwitchProgress(operation),
  })
  hub.router.ownerSwitch = ownerSwitch
  const ownerSwitchAction = request => {
    if (request != null && (typeof request !== 'object' || Array.isArray(request))) {
      throw new HttpError(400, 'An owner switch request must be an object.')
    }
    const { action, ownerId, expectedSessionId, operationId, mode, summary } = request ?? {}
    return hub.router.ownerSwitchAction({ action, ownerId, expectedSessionId, operationId, mode, summary })
  }
  const notificationThrottle = new NotificationThrottle({ store, runs: hub.router.runs,
    now: () => Date.parse(hub.router.now()), windowMs: config.notifications?.windowMs })
  hub.router.notifications = notificationThrottle
  hub.router.installDeferred(new DeferredRegistry({
    store, tasks: hub.tasks, now: hub.router.now, ...config.deferred,
    owners: {
      currentBinding: ownerId => hub.registry.get(ownerId),
      isOwnerSession: sessionId => hub.registry.isOwnerSession(sessionId),
    },
  }))
  // Owner preset subtrees resolve the Hub through the Host root context.
  const unprovide = ctx[Context.root].reflect.provide('hubBot', hub)
  setHub(hub)
  const timers = new TimerService({ store, getOwner: id => hub.registry.get(id), getTicket: id => hub.router.getTicket(id),
    routeBackground: request => hub.router.routeBackground(request) })
  hub.router.timerDeliveryState = (id, ref) => timers.deliveryState(id, ref)
  const timerAction = ({ id, action } = {}) => {
    if (!['pause', 'resume', 'cancel'].includes(action) || typeof id !== 'string' || !id) {
      throw new HttpError(400, 'A timer ID and pause, resume, or cancel are required.')
    }
    try {
      return timers[action](id)
    } catch (error) {
      if (error?.name === 'TimerError') throw new HttpError(error.code === 'timer-not-found' ? 404 : 400, error.message)
      throw error
    }
  }
  const listRuns = (filters = {}) => {
    let { limit = 30, offset = 0 } = filters
    if (typeof limit === 'string' && /^[0-9]+$/.test(limit)) limit = Number(limit)
    if (typeof offset === 'string' && /^[0-9]+$/.test(offset)) offset = Number(offset)
    try {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Run list limit must be a positive integer.')
      limit = Math.min(limit, 100)
      const rows = hub.router.runs.list({ ...filters, limit: limit + 1, offset })
      return { runs: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null }
    } catch (error) {
      if (error instanceof TypeError) throw new HttpError(400, error.message)
      throw error
    }
  }

  const overview = async () => ({
    ...buildOverview({ store, registry: hub.registry, health: await buildHealth(), compact: true }),
    timers: timers.list(),
    ownerSwitches: [...ownerSwitch.list().reduce((latest, operation) => {
      if (!latest.has(operation.ownerId)) latest.set(operation.ownerId, operation)
      return latest
    }, new Map()).values()],
  })
  ctx.inject(['tools'], scope => {
    scope.tools.register({
      name: 'report_background',
      description: '记录后台任务的结果、失败或静默原因。progress-only 仅记录进展，任务保持进行中。',
      parameters: {
        type: 'object', required: ['ticketId'], additionalProperties: false,
        properties: {
          ticketId: { type: 'string' }, summary: { type: 'string' }, failure: { type: 'string' }, evidence: { type: 'string' },
          silenceReason: { type: 'string', enum: Object.keys(SILENCE_REASONS) },
        },
      },
      output: {
        schema: { type: 'object', required: ['ticketId', 'stage'], additionalProperties: false,
          properties: { ticketId: { type: 'string' }, stage: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: '后台任务 ' + value.ticketId + ' 的结果已记录。' }],
      },
      execute: (args, exec) => hub.router.reportBackground({ ...args, sessionId: exec.agent?.id }),
    }, { when: ({ agent }) => hub.router.isBackgroundWorker(agent.id) })
    scope.tools.register({
      name: 'ask_user', description: '就当前绑定的任务向用户提问。随后等待这条请求的明确答复。',
      parameters: { type: 'object', properties: { ticketId: { type: 'string' }, question: { type: 'string' } },
        required: ['ticketId', 'question'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { ticketId: { type: 'string' }, stage: { type: 'string' } },
        required: ['ticketId', 'stage'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: '任务 ' + value.ticketId + ' 正等待用户回复。' }] },
      execute: async (args, exec) => hub.router.askWorker({ ...args, sessionId: exec.agent?.id }),
    }, { when: ({ agent }) => hub.router.isManagedWorker(agent.id) })
    const getBoundOwner = sessionId => store.closed ? undefined : hub.registry.findByCurrentSession(sessionId)
    const getManager = sessionId => {
      const owner = getBoundOwner(sessionId)
      return owner && !owner.transient ? owner : undefined
    }
    const managerFor = (exec, ownerId) => {
      const manager = getManager(exec.agent?.id)
      if (!manager || (ownerId && manager.role !== 'chief' && ownerId !== manager.id)) {
        throw new Error('This session cannot manage timers for that owner.')
      }
      return manager
    }
    const managerTool = { when: ({ agent }) => Boolean(getManager(agent.id)) }
    const textProperty = { type: 'string' }
    const timerResult = {
      schema: { type: 'object', properties: { timer: { type: 'object' }, changed: { type: 'boolean' } },
        required: ['timer'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.timer.id + ' · ' + value.timer.status + ' · ' + value.timer.fireAt }],
    }
    scope.tools.register({
      name: 'read_owner_fact', description: '查看当前负责人的冷启动事实。按 section 分页读索引，再用 kind 和 id 查看单条工单或汇报记录。',
      parameters: {
        type: 'object', additionalProperties: false, properties: {
          section: { type: 'string', enum: ['tickets', 'activeTasks', 'workers', 'pending', 'reports', 'reportRecords'] },
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
          kind: { type: 'string', enum: ['ticket', 'outbox'] }, id: textProperty,
        },
      },
      output: {
        schema: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: textProperty } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute({ section, offset, limit, kind, id }, exec) {
        const owner = getBoundOwner(exec.agent?.id)
        if (!owner) throw new Error('Only the current owner session can read these facts.')
        const input = { store, ownerId: owner.id, isArchived: sid => sessions.isArchived(sid) }
        if (kind !== undefined || id !== undefined) {
          if (!['ticket', 'outbox'].includes(kind) || typeof id !== 'string' || !id.trim() || section !== undefined || offset !== undefined || limit !== undefined) {
            throw new Error('Provide kind and id to read one record.')
          }
          const detail = readOwnerFactDetail({ ...input, kind, id })
          if (!detail) throw new Error('No matching record for this owner.')
          return { text: JSON.stringify(detail) }
        }
        if (section !== undefined || offset !== undefined || limit !== undefined) {
          const page = listOwnerFactIndex({ ...input, section, offset, limit })
          if (!page) throw new Error('Invalid owner fact section or page.')
          return { text: JSON.stringify(page) }
        }
        return { text: formatOwnerFacts(buildOwnerFacts(input)) }
      },
    }, { when: ({ agent }) => Boolean(getBoundOwner(agent.id)) })
    scope.tools.register({
      name: 'timer_create',
      description: '安排后台跟进。一次性使用带时区的 fireAt，每日或每周使用上海时间 schedule。飞书交代的提醒可带原消息 triggerRef，以便后续问答回原处。',
      parameters: {
        type: 'object', required: ['message'], additionalProperties: false,
        oneOf: [{ required: ['fireAt'] }, { required: ['schedule'] }],
        properties: {
          ownerId: textProperty, fireAt: textProperty, message: textProperty, triggerRef: textProperty,
          notifyAtFire: { type: 'boolean', description: '用户明确要求到点发提醒时设为 true。有原飞书来源时立即发到原聊天。' },
          schedule: {
            type: 'object', required: ['frequency', 'time'], additionalProperties: false,
            properties: {
              frequency: { type: 'string', enum: ['daily', 'weekly'] },
              time: { type: 'string', description: '上海时间，24 小时制 HH:mm' },
              weekday: { type: 'integer', minimum: 1, maximum: 7, description: '每周使用，周一为 1，缺省为创建时的上海星期' },
            },
          },
        },
      },
      output: timerResult,
      async execute({ ownerId, fireAt, schedule, message, triggerRef, notifyAtFire }, exec) {
        const manager = managerFor(exec, ownerId)
        let origin, authorization
        if (triggerRef) {
          const trigger = hub.router.getTrigger(triggerRef)
          authorization = trigger?.authorization
          const sender = authorization?.actor
          const isFeishu = trigger?.kind === 'feishu' && !trigger.dropped && trigger.source?.chatId && sender
            && trigger.source.openId === sender && trigger.authorization.source === 'feishu'
          const withinOwner = manager.role === 'chief' || hub.router.queryTasks({ owner: manager.id }).some(ticket => ticket.triggerId === triggerRef)
          if (!isFeishu || !withinOwner) throw new Error('The Feishu source for this reminder cannot be verified.')
          origin = { kind: 'feishu', triggerId: trigger.id, chatId: trigger.source.chatId, actor: sender }
        }
        return { timer: timers.create({ ownerId: ownerId ?? manager.id, createdBy: exec.agent.id, fireAt, schedule, message, origin, authorization, notifyAtFire }) }
      },
    }, managerTool)
    scope.tools.register({
      name: 'timer_list', description: '查看提醒的到期时间、状态和关联任务。',
      parameters: { type: 'object', properties: { ownerId: textProperty }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { timers: { type: 'array' } }, required: ['timers'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.timers) }] },
      async execute({ ownerId }, exec) {
        const manager = managerFor(exec, ownerId)
        return { timers: timers.list({ ownerId: ownerId ?? (manager.role === 'chief' ? undefined : manager.id) }) }
      },
    }, managerTool)
    scope.tools.register({
      name: 'timer_manage', description: '暂停、恢复或取消提醒。取消不会停止已经开始的执行会话。',
      parameters: { type: 'object', properties: { id: textProperty, action: { type: 'string', enum: ['pause', 'resume', 'cancel'] } },
        required: ['id', 'action'], additionalProperties: false },
      output: timerResult,
      async execute(args, exec) {
        const timer = timers.get(args.id)
        if (!timer) throw new Error('Unknown timer.')
        managerFor(exec, timer.ownerId)
        return timerAction(args)
      },
    }, managerTool)
  })
  // 飞书入口 (#68): OFF unless config.feishu.enabled. With credentials present the WSClient long connection
  // starts at boot; the same source scans recorded feishu reply intents on the 1s tick (阶段 2 留的通道).
  const feishu = new FeishuSource({
    store, config: config.feishu, logger: ctx.logger,
    credentials: safeGetService(ctx, 'credentials'),
    // S06 单一入口: with the router port present the source is a pure adapter — it hands the ORIGINAL event to
    // router.acceptFeishuTrigger() and never prompts a session itself (same port pattern as GitHubSource below).
    router: hub.router,
  })
  const updateFeishuConnection = () => {
    if (!config.feishu.enabled) { feishu.disconnect(); return }
    void feishu.credentialsReady.then(() => {
      if (config.feishu.enabled && !store.closed && feishu.credentialState === 'ok') return feishu.connect()
    }).catch(error => ctx.logger.warn('hub-bot feishu connect failed: %s', error?.message ?? error))
  }
  updateFeishuConnection()
  // GitHub 自动处理闭环 (#71): OFF unless config.github.enabled. loginAllowlist 空时经 gh api user 解析为本人；
  // 每 intervalMs（默认 5min）一轮轮询，首轮只记水位线；recorded github 回复意图随 1s tick 实投。
  const github = new GitHubSource({ store, registry: hub.registry, router: hub.router, sessions, config: config.github, logger: ctx.logger })

  // 重启恢复（#66）: end running assignments "host restarted", then resume any queued stored work — and keep
  // driving the runner every second so backoff retries fire even when no new traffic arrives.
  // scratch 回收 (#70): router 回收触发段负责终态即时判定; sweep 挂 1s tick 兜底不经 Router 的终止
  // (owner-tools report-failure、github 源头终止)。回收失败不阻断任何任务(记 warn, 下轮重试)。
  const recycler = new Recycler({ store, registry: hub.registry, logger: ctx.logger })
  hub.router.onTicketTerminal = ticketId => recycler.maybeRecycleForTicket(ticketId)
  // #72 AC1 自动恢复：working 票最旧优先自动补投恢复注入（过执行槽闸门），无人干预即可继续干活
  void hub.router.markRestart().catch(error => ctx.logger.warn('hub-bot restart recovery failed: %s', error?.message ?? error))
  // 工作区预热 (#52): 确保 chief 专属工作区与已注册 owner 的仓库工作区存在（幂等）。
  // 已绑定的存量会话无法 retro-fit（无归位 API），等自然重建时自动归位。
  void (async () => {
    await placer.chiefWorkspace()
    for (const owner of hub.registry.list()) {
      if (owner.role !== 'chief') await placer.ownerWorkspace(owner)
      // 归档自愈 (round 51): 已绑定的负责人会话若被归档，启动时解开——归档 = DSH gate 拒跑 = bot 被静音。
      if (owner.sessionId) await placer.ensureUnarchived(owner.sessionId, owner.id)
    }
  })().catch(error => ctx.logger.warn('hub-bot workspace warmup failed (non-fatal): %s', error?.message ?? error))
  void hub.router.tick().catch(error => ctx.logger.warn('hub-bot delivery resume failed: %s', error?.message ?? error))
  const tickOwnerSwitches = () => {
    void ownerSwitch.tick().catch(error => ctx.logger.warn('hub-bot owner switch tick failed: %s', error?.message ?? error))
  }
  tickOwnerSwitches()
  const deliveryTimer = setInterval(() => {
    void timers.tick().catch(error => ctx.logger.warn('hub-bot timer tick failed: %s', error?.message ?? error))
    void hub.router.tick().catch(error => ctx.logger.warn('hub-bot delivery tick failed: %s', error?.message ?? error))
    void hub.router.autoReportTick().catch(error => ctx.logger.warn('hub-bot auto-report tick failed: %s', error?.message ?? error))
    tickOwnerSwitches()
    try { notificationThrottle.flush() } catch (error) {
      ctx.logger.warn('hub-bot notification flush failed: %s', error?.message ?? error)
    }
    if (config.feishu.enabled && feishu.credentialState === 'ok') {
      void feishu.deliverReplies().catch(error => ctx.logger.warn('hub-bot feishu reply tick failed: %s', error?.message ?? error))
    }
    if (config.github.enabled) {
      void github.deliverReplies().catch(error => ctx.logger.warn('hub-bot github reply tick failed: %s', error?.message ?? error))
    }
    try { recycler.sweep() } catch (error) { ctx.logger.warn('hub-bot recycle sweep failed: %s', error?.message ?? error) }
  }, 1000)
  deliveryTimer.unref?.()

  let githubPollTimer = null
  let githubPollTask = null
  const pollGithub = () => {
    if (!config.github.enabled || githubPollTask) return
    githubPollTask = github.pollAll()
      .catch(error => ctx.logger.warn('hub-bot github poll tick failed: %s', error?.message ?? error))
      .finally(() => { githubPollTask = null })
  }
  const restartGithubPolling = ({ immediate = false } = {}) => {
    clearInterval(githubPollTimer)
    githubPollTimer = null
    if (!config.github.enabled) return
    githubPollTimer = setInterval(pollGithub, config.github.intervalMs)
    githubPollTimer.unref?.()
    if (immediate) pollGithub()
  }
  restartGithubPolling({ immediate: true })

  let unregisterManagement
  // Dispose the root service and store even when the management API is disabled. Stop new work before closing them.
  ctx.effect(() => async () => {
    clearInterval(deliveryTimer)
    clearInterval(githubPollTimer)
    const steps = [
      ['unregister management routes', () => unregisterManagement?.()],
      ['disconnect feishu', () => feishu.disconnect()],
      ['unprovide hub service', unprovide],
      ['release hub reference', () => setHub(null)],
      ['close store', () => store.close()],
    ]
    for (const [label, step] of steps) {
      try { await step() } catch (error) { ctx.logger.warn('hub-bot dispose step "%s" failed: %s', label, error?.message ?? error) }
    }
  })
  let staleReported = false
  ctx.logger.info('hub-bot ready: state %s (schema %s); chief owner %s (%s)%s',
    store.stateDir, store.schemaVersion, chief.owner.cwd, chief.created ? 'registered pending' : 'already registered',
    config.devApi ? '' : '; management API disabled (no config.devApi)')

  /** Reads the effective settings view (config ⊕ overlay + live Source status). */
  // QR 码在 host 侧生成 SVG（复用面板的 vendor 库，CJS），client 半侧零依赖渲染。
  let qrcodeLib = null
  const qrSvgFor = url => {
    try {
      if (!qrcodeLib) qrcodeLib = createRequire(import.meta.url)('../panel/vendor/qrcode.cjs')
      const qr = qrcodeLib(0, 'M')
      qr.addData(url)
      qr.make()
      return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })
    } catch (error) {
      ctx.logger.warn('hub-bot qr svg render failed: %s', error?.message ?? error)
      return null
    }
  }
  const settingsView = async () => {
    const view = buildSettingsView(config, { feishuStatus: feishu.status(), githubStatus: await github.status() })
    const qr = view.feishu?.status?.qr
    if (qr?.url) {
      const svg = qrSvgFor(qr.url)
      if (svg) view.feishu.status.qr = { ...qr, svg }
    }
    view.version = PKG_VERSION
    return view
  }

  /** The accumulated settings overlay (boot value), merged with every accepted patch and persisted. */
  let settingsOverlay = loadSettingsOverlay(config.stateDir)

  /**
   * Settings write core, shared by the HTTP panel route and the GUI Remote service: validate → mutate the
   * live config → persist the merged overlay → live side effects (GitHub polling cadence, chief model).
   */
  const applySettingsCore = async patch => {
    const { enabled: githubWasEnabled, intervalMs: oldGithubInterval } = config.github
    const feishuWasEnabled = config.feishu.enabled
    applySettingsPatch(config, patch, applied => {
      const next = mergeSettingsOverlay(settingsOverlay, applied)
      saveSettingsOverlay(config.stateDir, next)
      settingsOverlay = next
    })
    if (feishuWasEnabled !== config.feishu.enabled) updateFeishuConnection()
    if (githubWasEnabled !== config.github.enabled || oldGithubInterval !== config.github.intervalMs) {
      restartGithubPolling({ immediate: !githubWasEnabled && config.github.enabled })
    }
    if (patch.chief?.model !== undefined) {
      // 总管模型即时生效：对已绑定的 L1 会话直接 selectModel；失败只告警（会话可能在跑，下条消息还会对齐）。
      const chiefRow = hub.registry.get('chief')
      if (chiefRow?.sessionId && config.chief.model) {
        try {
          await sessions.selectModel({ sessionId: chiefRow.sessionId, ...config.chief.model })
          ctx.logger.info('hub-bot chief model applied live: %s/%s', config.chief.model.provider, config.chief.model.model)
        } catch (error) {
          ctx.logger.warn('hub-bot chief model live-apply failed (will align on next injection): %s', error instanceof Error ? error.message : error)
        }
      }
    }
    ctx.logger.info('hub-bot settings updated: %s', Object.keys(patch).join(', '))
    return await settingsView()
  }

  // GUI 设置面板的数据通路（client/ 半侧）：与 HTTP 面板共用同一条 settingsView/applySettingsCore。
  // 独立于 devApi——管理 API 关掉时 GUI 设置页照常工作。
  // #53 转发 deps：cordis service 注册全局唯一，热重载时旧 service 实例可能残留（dispose 不保证注销）——
  // 它的 deps 若捕获旧 fiber 闭包，重载后调用会撞上 inactive context。转发层让任何残留实例都落到最新实现。
  /**
   * 面板「自检」 (round 53): 构造一条模拟 im.message.receive_v1 事件，走真实 normalize → 策略 → trigger →
   * chief 注入链路；chief 经 reply_source 回投 outbox，由投递循环真实发到用户飞书。
   * The reply target comes from the most recent accepted Feishu direct message.
   */
  const selfTest = async () => {
    if (!config.feishu.enabled || !feishu.status().bot?.connected) throw new HttpError(400, 'Connect the Feishu bot before running a self-test')
    const rows = store.db.prepare('SELECT value FROM trigger ORDER BY at DESC').iterate()
    let source
    for (const row of rows) {
      let trigger
      try { trigger = JSON.parse(String(row.value)) } catch { continue }
      const candidate = trigger?.source
      if (trigger?.kind !== 'feishu' || trigger.dropped || candidate?.addressing !== 'direct' || !candidate.chatId) continue
      if (typeof candidate.messageId !== 'string' || !candidate.messageId || candidate.messageId.startsWith('om_selftest-')) continue
      source = candidate
      break
    }
    if (!source) throw new HttpError(400, '请先在飞书私聊给 Bot 发一条消息。')
    const { chatId, openId } = source
    const messageId = 'om_selftest-' + randomUUID().replaceAll('-', '')
    const marker = feishuSelfTestMarker(messageId)
    const event = {
      sender: { sender_type: 'user', sender_id: { open_id: openId ?? 'ou_selftest' } },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'Hub Bot 连通性自检。请调用 reply_source，回复内容只写 ' + marker }),
      },
    }
    const result = await feishu.handleEvent(event)
    return { ...result, chatId, at: new Date().toISOString() }
  }

  const startFeishuRegister = () => {
    if (!config.feishu.enabled) throw new HttpError(400, '请先启用飞书，再扫码绑定。')
    if (feishu.registering) return { started: false, registration: 'pending', qr: feishu.lastQr }
    void feishu.register().catch(error => ctx.logger.warn('hub-bot feishu register failed: %s', error?.message ?? error))
    const status = feishu.status()
    if (status.registration === 'failed') throw new HttpError(400, status.registrationError)
    return { started: true, registration: 'pending' }
  }

  const serviceDeps = {}
  const forwardDep = name => (...args) => serviceDeps[name](...args)
  new HubBotSettingsService(ctx, {
    settingsView: forwardDep('settingsView'),
    applySettings: forwardDep('applySettings'),
    listOwners: forwardDep('listOwners'),
    modelCatalog: forwardDep('modelCatalog'),
    overview: forwardDep('overview'),
    messageDetail: forwardDep('messageDetail'),
    ticketDetail: forwardDep('ticketDetail'),
    notificationDetail: forwardDep('notificationDetail'),
    ownerSwitchAction: forwardDep('ownerSwitchAction'),
    handoffSummaryAction: forwardDep('handoffSummaryAction'),
    listRuns: forwardDep('listRuns'),
    runDetail: forwardDep('runDetail'),
    timerAction,
    resolveTicket: forwardDep('resolveTicket'),
    startFeishuRegister: forwardDep('startFeishuRegister'),
    listWorkspaces: forwardDep('listWorkspaces'),
    readSessionTitles: forwardDep('readSessionTitles'),
    retryOutbox: forwardDep('retryOutbox'),
    discardOutbox: forwardDep('discardOutbox'),
    selfTest: forwardDep('selfTest'),
  })
  // The settings service also works when the optional HTTP management routes are disabled.
  Object.assign(serviceDeps, {
    settingsView,
    applySettings: applySettingsCore,
    listOwners: () => hub.registry.list(),
    modelCatalog: () => sessions.modelCatalog(),
    // 关联式归位选择器（turn 108）: DSH 工作区枚举。registry 服务缺席（老 DSH）→ 空数组，选择器降级为「自动」。
    retryOutbox: body => retryOutbox(body),
    discardOutbox: body => discardOutbox(body),
    selfTest,
    listWorkspaces: () => (safeGetService(ctx, 'workspaceRegistry')?.list?.() ?? []).map(w => ({ workspaceId: String(w.id), title: w.title ?? null, path: w.path ?? null, sessionIds: Array.isArray(w.sessionIds) ? [...w.sessionIds] : [] })),
    // 会话标题投影（round 27）: 负责人卡片显示绑定会话的标题，不再只是 8 位 id。
    // 标题不在 sessionController.list 条目里——正确来源是 sessionQuery.readTitleSnapshots
    // （dsh-session-query 的 title 折叠）。服务缺席/失败 → 空表，卡片退化为短 id，不阻塞。
    readSessionTitles: async sessionIds => {
      try {
        const query = safeGetService(ctx, 'sessionQuery')
        if (!query?.readTitleSnapshots || !Array.isArray(sessionIds) || sessionIds.length === 0) return {}
        const settled = await query.readTitleSnapshots(sessionIds)
        const out = {}
        for (const r of settled ?? []) {
          const v = r?.value ?? r
          // title 快照是对象（{title: 文本, messageSeqs, source, eventSeq, updatedAt}），字符串兜底兼容。
          const raw = v?.title
          const text = typeof raw === 'string' ? raw : (raw && typeof raw.title === 'string' ? raw.title : null)
          if (v?.session?.id && text) out[v.session.id] = text
        }
        return out
      } catch { return {} }
    },
    overview,
    messageDetail: triggerId => readMessageDetail(store, triggerId),
    ticketDetail: ticketId => readTicketDetail({ store, registry: hub.registry, ticketId }),
    notificationDetail: id => notificationThrottle.details(id),
    ownerSwitchAction,
    handoffSummaryAction,
    listRuns,
    runDetail: id => hub.router.runs.get(id),
    resolveTicket: request => resolveTicket(request),
    startFeishuRegister,
  })

  const token = config.devApi?.token

  /** Management calls are loopback-only and must carry the configured token. */
  // #53: capture the port NOW — after a hot-reload dispose the ctx.webServer proxy is dead, and a stale
  // handler surviving in the route table must still be able to authenticate and answer 503 (not bare 400).
  const webServerPort = ctx.webServer.port
  const admitted = req => {
    const host = req.headers.host ?? ''
    const loopback = host === '127.0.0.1:' + webServerPort || host === 'localhost:' + webServerPort || host === '[::1]:' + webServerPort
    return loopback && tokenMatches(req.headers['x-hub-bot-token'], token)
  }

  /**
   * Creates one Session. With { owner: <id> } the registry row supplies cwd and the role's preset, and the new
   * Session is bound into the registry — the management-side of lazy creation (L1 bootstrap in dev profiles).
   */
  const createSession = async body => {
    const ownerId = optionalString(body, 'owner')
    if (ownerId !== undefined) {
      const owner = hub.registry.get(ownerId)
      if (!owner) throw new HttpError(404, 'unknown owner "' + ownerId + '"')
      // 出生即归位 (#52)：有 workspaceId 则出生就在工作区；placer 不可用回退 cwd 创建。
      const ws = owner.role === 'chief' ? await placer.chiefWorkspace() : await placer.ownerWorkspace(owner)
      const value = await sessions.create(ws
        ? { workspaceId: ws.workspaceId, agentPreset: presetForRole(owner.role) }
        : { cwd: owner.cwd, agentPreset: presetForRole(owner.role) })
      hub.registry.bindSession(owner.id, value.sessionId)
      return { ...value, ownerId: owner.id }
    }
    const request = {}
    const cwd = optionalString(body, 'cwd')
    if (cwd !== undefined) request.cwd = cwd
    const agentPreset = optionalString(body, 'agentPreset')
    if (agentPreset !== undefined) request.agentPreset = agentPreset
    return await sessions.create(request)
  }

  /** Injects one user message into an existing Session; an explicit requestId makes redelivery idempotent. */
  const injectPrompt = async body => {
    const sessionId = requireString(body, 'sessionId')
    const text = requireString(body, 'text')
    const mode = body.mode ?? 'queue'
    if (mode !== 'queue' && mode !== 'steer') throw new HttpError(400, 'mode must be "queue" or "steer"')
    const requestId = optionalString(body, 'requestId') ?? 'hub-bot-' + randomUUID()
    const value = await sessionController.prompt({
      requestId, sessionId, mode, content: [{ type: 'text', text }],
    }, deadline(30_000))
    await ctx.sessionPersistence.flush()
    return { ...value, requestId }
  }


  /** Tool registrations made by /decorate, keyed by Session so they release when the Session's Agent is disposed. */
  const decorations = new Map()
  // { global: true }: without it this listener only hears events emitted down this plugin's own ctx branch, and the
  // agent-lifecycle event arrives from the Session's branch — every agent/disposed listener in the runtime passes it.
  // The map keys are SessionIds while the event carries the Agent: dsh-agent-loop keeps agent.id === session.id for
  // ordinary Sessions, so the lookup holds.
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = decorations.get(agent.id)
    if (dispose) { decorations.delete(agent.id); dispose() }
  }, { global: true })

  /** Registers the ping tool on one live Session's Agent. */
  const decorate = async body => {
    const sessionId = requireString(body, 'sessionId')
    // resolveAgent resolves/resumes the Session and reports failures as a value, not a throw.
    const found = await sessionController.resolveAgent(sessionId)
    const agent = found && typeof found === 'object' && 'error' in found ? null : (found?.agent ?? found)
    if (!agent?.ctx) throw new HttpError(404, 'Session ' + sessionId + ' could not be resolved to a live Agent')
    decorations.get(sessionId)?.()
    const dispose = agent.ctx.tools.register(PING_TOOL)
    decorations.set(sessionId, dispose)
    ctx.on('dispose', dispose)
    return { decorated: true, tool: PING_TOOL.name, sessionId }
  }

  /** Waits for one Session to go idle and returns its latest assistant output. */
  const waitIdle = async body => {
    const sessionId = requireString(body, 'sessionId')
    const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 600_000) : 120_000
    return await sessionController.wait({ sessionId, timeoutMs }, deadline(timeoutMs + 10_000))
  }

  /** Reads the durable transcript of one Session (what the DSH Web transcript view renders). */
  const transcript = async query => {
    const sessionId = requireString(query, 'sessionId')
    const maxMessages = Number.isInteger(Number(query.maxMessages)) && Number(query.maxMessages) > 0 ? Number(query.maxMessages) : 200
    return await sessionController.page({ address: { kind: 'session', sessionId }, maxMessages }, deadline(30_000))
  }

  // ---- 面板 (#73 面板三问与设置页) -------------------------------------------------------

  /** The panel static shell lives next to the plugin source: HTML/JS/CSS only, no data, no build chain. */
  const PANEL_DIR = fileURLToPath(new URL('../panel/', import.meta.url))
  const PANEL_FILES = new Map([
    ['/hub-bot/panel', ['index.html', 'text/html; charset=utf-8']],
    ['/hub-bot/panel/', ['index.html', 'text/html; charset=utf-8']],
    ['/hub-bot/panel/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/hub-bot/panel/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/hub-bot/panel/vendor/qrcode.cjs', ['vendor/qrcode.cjs', 'text/javascript; charset=utf-8']],
  ])

  /** Serves one allowlisted panel asset, loopback-only; the token guards DATA (/hub-bot/api/*), not the shell. */
  const servePanel = (pathname, req, res) => {
    const host = req.headers.host ?? ''
    const loopback = host === '127.0.0.1:' + ctx.webServer.port || host === 'localhost:' + ctx.webServer.port || host === '[::1]:' + ctx.webServer.port
    const entry = PANEL_FILES.get(pathname)
    if (!loopback || !entry) { res.writeHead(404); res.end(); return }
    let body
    try { body = readFileSync(join(PANEL_DIR, entry[0])) } catch { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' })
    res.end(body)
  }

  const buildHealth = async () => ({
    feishu: feishu.status(),
    github: await github.status(),
    outbox: buildOutboxHealth(store),
  })


  /** HTTP 面板路由的薄包装：readBody → 共享核心；SettingsError → 400。 */
  const applySettings = async req => {
    const patch = await readBody(req)
    try {
      return await applySettingsCore(patch)
    } catch (error) {
      if (error?.name === 'SettingsError') throw new HttpError(400, error.message)
      throw error
    }
  }

  /** 确认裁决: person/confirm 票的一键 confirm/reject — 与 route_to_owner resolution 同一条状态机路径. */
  const resolveTicket = async body => {
    const ticketId = requireString(body, 'ticketId')
    const resolution = requireString(body, 'resolution')
    if (!['confirm', 'reject', 'answer', 'accept', 'retry', 'cancel'].includes(resolution)) throw new HttpError(400, 'Invalid ticket resolution.')
    const requestId = optionalString(body, 'requestId')
    if (requestId) {
      const decision = ({ confirm: 'approve', reject: 'reject', answer: 'answer', cancel: 'cancel' })[resolution]
      if (!decision) throw new HttpError(400, 'This operation is not a deferred decision.')
      try {
        return await hub.router.resolveDeferred({ requestId, ticketId, decision,
          channel: 'panel', text: optionalString(body, 'message') })
      } catch (error) {
        if (['TaskError', 'RouterError', 'DeferredError'].includes(error?.name)) throw new HttpError(400, error.message)
        throw error
      }
    }
    // 取消（round 43）: idle/queued 票还没开始执行，允许直接关闭（done）。已开始的一律走 reject/失败路径。
    if (resolution === 'cancel') {
      const ticket0 = hub.router.getTicket(ticketId)
      if (!ticket0) throw new HttpError(404, 'unknown ticket "' + ticketId + '"')
      if (ticket0.stage !== 'idle' && ticket0.stage !== 'queued') {
        throw new HttpError(400, 'cancel applies only to idle or queued tickets (current stage: ' + ticket0.stage + ')')
      }
      try {
        hub.router.tasks.cancel(ticketId, { by: 'user', reason: optionalString(body, 'message') ?? '面板取消' })
      } catch (error) {
        throw new HttpError(400, error?.message ?? 'cancel failed')
      }
      return { ticketId, stage: 'done' }
    }
    // 重试（round 42）: blocked/failed 票走与 answer 同一条「无 resolution 追问」路径——
    // 状态机自己把票恢复成 working 并注入重试说明。仅限这两个终态，其他阶段不许越权复活。
    if (resolution === 'retry') {
      const ticket0 = hub.router.getTicket(ticketId)
      if (!ticket0) throw new HttpError(404, 'unknown ticket "' + ticketId + '"')
      if (ticket0.stage !== 'blocked' && ticket0.stage !== 'failed') {
        throw new HttpError(400, 'retry applies only to blocked or failed tickets (current stage: ' + ticket0.stage + ')')
      }
      return await hub.router.routeToOwner({ ownerId: ticket0.owner, ticketId, message: optionalString(body, 'message') ?? '面板要求重试' })
    }
    if (resolution === 'answer') {
      const text = requireString(body, 'message')
      const ticket0 = hub.router.getTicket(ticketId)
      if (!ticket0) throw new HttpError(404, 'unknown ticket "' + ticketId + '"')
      // 回答 = 不带 resolution 的追问: 状态机自己把 person/answer 恢复成 working 并注入回复。
      return await hub.router.routeToOwner({ ownerId: ticket0.owner, ticketId, message: text })
    }
    const ticket = hub.router.getTicket(ticketId)
    if (!ticket) throw new HttpError(404, 'unknown ticket "' + ticketId + '"')
    return await hub.router.routeToOwner({
      ownerId: ticket.owner, ticketId, resolution,
      message: optionalString(body, 'message') ?? (resolution === 'confirm' ? '面板确认' : '面板拒绝'),
    })
  }

  // 死信重投（健康警告条的操作闭环 turn 110）: {id} 单条 / {all:true} 全部。
  const retryOutbox = body => {
    if (body?.all === true) return { retried: retryOutboxRows(store, null, hub.router.now) }
    const id = requireString(body, 'id')
    const retried = retryOutboxRows(store, [id], hub.router.now)
    if (retried === 0) throw new HttpError(404, 'no failed outbox row "' + id + '"')
    return { retried }
  }

  // 死信丢弃（round 41）: {id} 单条 / {all:true} 全部；确认不在乎的失败回执直接删除。
  const discardOutbox = body => {
    if (body?.all === true) return { discarded: discardOutboxRows(store, null) }
    const id = requireString(body, 'id')
    const discarded = discardOutboxRows(store, [id])
    if (discarded === 0) throw new HttpError(404, 'no failed outbox row "' + id + '"')
    return { discarded }
  }

  if (!config.devApi) return
  if (ctx.webServer.host !== '127.0.0.1' && ctx.webServer.host !== 'localhost' && ctx.webServer.host !== '::1') {
    throw new Error('hub-bot management requires a loopback Web server')
  }

  unregisterManagement = ctx.webServer.register({
    kind: 'prefix',
    path: '/hub-bot',
    handler: async (req, res) => {
      try {
        // #53 半失效自检: a hot reload disposes this fiber's store but the old route can survive — answer
        // a diagnosable 503 (JSON) instead of crashing into the webServer's bare 400. The GUI 面板经
        // Remote 通道独立存活，会继续工作；HTTP 管理面等重启后恢复。
        if (store.closed) {
          if (!staleReported) {
            staleReported = true
            ctx.logger.warn('hub-bot stale management handler still serving after reload — answering 503 until instance restart')
          }
          json(res, 503, { error: 'hub-bot management API is reloading — restart the DSH instance if this persists', code: 'reloading' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        // 面板静态壳 (#73): served without the token — it carries no data; every fetch inside goes through
        // the token-guarded API below. Loopback-only like the API itself.
        if (url.pathname === '/hub-bot/panel' || url.pathname.startsWith('/hub-bot/panel/')) { servePanel(url.pathname, req, res); return }
        if (!url.pathname.startsWith('/hub-bot/api/')) { res.writeHead(404); res.end(); return }
        if (!admitted(req)) { json(res, 401, { error: 'Missing or wrong x-hub-bot-token' }); return }
        try {
        const route = url.pathname.slice('/hub-bot/api/'.length)
        const method = req.method ?? 'GET'
        if (route === 'state' && method === 'GET') {
          json(res, 200, { ok: true, name, stateDir: store.stateDir, database: store.path, schemaVersion: store.schemaVersion, declaredSchemaVersion: SCHEMA_VERSION })
        } else if (route === 'owners' && method === 'POST') {
          // Dev proof aid (#70): register a dynamic owner (dir needs cwd; scratch allocates its temp dir).
          const body = await readBody(req)
          json(res, 200, hub.registry.create({ kind: requireString(body, 'kind'), cwd: optionalString(body, 'cwd'), workspace: optionalString(body, 'workspace') }))
        } else if (route === 'owners' && method === 'GET') {
          json(res, 200, { owners: hub.registry.list() })
        } else if (route === 'sessions' && method === 'POST') {
          json(res, 200, await createSession(await readBody(req)))
        } else if (route === 'route' && method === 'POST') {
          const body = await readBody(req)
          json(res, 200, await hub.router.routeToOwner({
            ownerId: requireString(body, 'ownerId'),
            message: requireString(body, 'message'),
            triggerRef: optionalString(body, 'triggerRef'),
            ticketId: optionalString(body, 'ticketId'),
            resolution: optionalString(body, 'resolution'),
          }))
        } else if (route === 'owners/invalidate-session' && method === 'POST') {
          const body = await readBody(req)
          const ownerId = requireString(body, 'ownerId')
          json(res, 200, hub.registry.invalidateSessionForTest(ownerId, 'session-dangling-' + randomUUID()))
        } else if (route === 'inject' && method === 'POST') {
          json(res, 200, await injectPrompt(await readBody(req)))
        } else if (route === 'decorate' && method === 'POST') {
          json(res, 200, await decorate(await readBody(req)))
        } else if (route === 'wait' && method === 'POST') {
          json(res, 200, await waitIdle(await readBody(req)))
        } else if (route === 'deliver' && method === 'POST') {
          await hub.router.tick()
          notificationThrottle.flush()
          const autoReport = await hub.router.autoReportTick({ force: true })
          json(res, 200, { delivered: true, autoReport })
        } else if (route === 'transcript' && method === 'GET') {
          json(res, 200, await transcript(Object.fromEntries(url.searchParams)))
        } else if (route === 'feishu/status' && method === 'GET') {
          // 面板健康视图: credentialState 'invalid'/'missing' = 提示重新扫码.
          json(res, 200, feishu.status())
        } else if (route === 'feishu/register' && method === 'POST') {
          // Acknowledges the scan request. Poll feishu/status for the QR and the binding outcome.
          const reply = startFeishuRegister()
          json(res, reply.started ? 202 : 200, reply)
        } else if (route === 'feishu/simulate' && method === 'POST') {
          // Dev proof aid: inject one mock im.message.receive_v1 event through the real normalization/policy path.
          const body = await readBody(req)
          json(res, 200, await feishu.handleEvent(body.event ?? body))
        } else if (route === 'self-test' && method === 'POST') {
          // 面板「自检」(round 53): 模拟一条飞书消息走完整链路（真实回复会发到用户飞书）。
          json(res, 200, await selfTest())
        } else if (route === 'github/status' && method === 'GET') {
          // 面板健康视图: 逐仓库开关、水位线与最近一次轮询错误。
          json(res, 200, await github.status())
        } else if (route === 'github/poll' && method === 'POST') {
          // Forces one polling cycle NOW (dev proof without waiting 5min); body {repo?} narrows to one repo.
          const body = await readBody(req)
          if (body.repo) {
            const repo = requireString(body, 'repo')
            const result = await github.pollWatchedRepo(repo)
            if (result === null) throw new HttpError(404, 'Unknown watched repository ' + repo)
            json(res, 200, result)
          } else {
            json(res, 200, await github.pollAll())
          }
        } else if (route === 'github/simulate' && method === 'POST') {
          // Dev proof aid: one mock issue/PR/comment through the real normalization/policy/route path.
          // { kind: 'issue'|'pr'|'comment', repo: 'owner/name', item|comment: {...} }
          const body = await readBody(req)
          const cfg = { repo: body.repo, workspace: body.workspace ?? basename(config.homeRepo), cwd: config.homeRepo, enabled: true }
          if (body.kind === 'comment') json(res, 200, await github.handleCommentEvent(body.item ?? body.comment, cfg))
          else json(res, 200, await github.handleIssueEvent(body.item, cfg))
        } else if (route === 'runs' && method === 'GET') {
          json(res, 200, listRuns(Object.fromEntries(url.searchParams)))
        } else if (route === 'runs/detail' && method === 'GET') {
          const id = requireString({ id: url.searchParams.get('id') }, 'id')
          const run = hub.router.runs.get(id)
          if (!run) throw new HttpError(404, 'This background run is no longer available.')
          json(res, 200, run)
        } else if (route === 'overview' && method === 'GET') {
          // 三问视图数据 (#73): 票面 + 注册表 + 健康快照, 一次取齐
          json(res, 200, await overview())
        } else if (route === 'owners/handoff-summary' && method === 'POST') {
          try { json(res, 200, await handoffSummaryAction(await readBody(req))) } catch (error) {
            if (error?.name !== 'HandoffSummaryError') throw error
            throw new HttpError(400, error.message)
          }
        } else if (route === 'owners/switch' && method === 'POST') {
          try { json(res, 200, ownerSwitchAction(await readBody(req))) } catch (error) {
            if (!['OwnerSwitchError', 'HandoffSummaryError', 'RouterError'].includes(error?.name)) throw error
            throw new HttpError(error.code === 'owner-switch-not-found' ? 404 : 400, error.message)
          }
        } else if (route === 'tickets/detail' && method === 'GET') {
          const ticketId = requireString(Object.fromEntries(url.searchParams), 'ticketId')
          const detail = readTicketDetail({ store, registry: hub.registry, ticketId })
          if (!detail) throw new HttpError(404, 'Unknown ticket.')
          json(res, 200, detail)
        } else if (route === 'notifications/detail' && method === 'GET') {
          const id = requireString(Object.fromEntries(url.searchParams), 'id')
          const detail = notificationThrottle.details(id)
          if (!detail) throw new HttpError(404, 'Unknown notification.')
          json(res, 200, detail)
        } else if (route === 'timers/manage' && method === 'POST') {
          json(res, 200, timerAction(await readBody(req)))
        } else if (route === 'settings' && method === 'GET') {
          json(res, 200, await settingsView())
        } else if (route === 'models/catalog' && method === 'GET') {
          // 面板「总管模型」：目录 + 当前配置（配置即时生效后的下一次注入使用）。
          json(res, 200, { catalog: await sessions.modelCatalog(), chief: config.chief?.model ?? null })
        } else if (route === 'triggers/detail' && method === 'GET') {
          const detail = readMessageDetail(store, requireString(Object.fromEntries(url.searchParams), 'triggerId'))
          if (!detail) throw new HttpError(404, 'Unknown trigger.')
          json(res, 200, detail)
        } else if (route === 'triggers' && method === 'GET') {
          // 面板「最近触发」：trigger 表直读，最新在前。
          const limitRaw = url.searchParams.get('limit')
          const limit = limitRaw === null ? 20 : Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20))
          const rows = store.db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ?').all(limit)
          json(res, 200, { triggers: rows.map(r => JSON.parse(String(r.value))) })
        } else if (route === 'settings' && method === 'POST') {
          json(res, 200, await applySettings(req))
        } else if (route === 'tickets/resolve' && method === 'POST') {
          json(res, 200, await resolveTicket(await readBody(req)))
        } else if (route === 'outbox/retry' && method === 'POST') {
          json(res, 200, retryOutbox(await readBody(req)))
        } else if (route === 'outbox/discard' && method === 'POST') {
          json(res, 200, discardOutbox(await readBody(req)))
        } else {
          throw new HttpError(404, 'Unknown operation: ' + method + ' ' + route)
        }
      } catch (error) {
        if (error instanceof HttpError) { json(res, error.status, { error: error.message }); return }
        const message = error instanceof Error ? error.message : String(error)
        if (error?.name === 'ApiSessionNotFound') { json(res, 404, { error: message }); return }
        if (error?.name === 'RouterError') { json(res, 400, { error: message, code: error.code }); return }
        ctx.logger.warn('hub-bot management call failed: %s', message)
        json(res, 500, { error: message })
        }
      } catch (error) {
        // #53 外层兜底: anything above the route dispatch (URL parse, servePanel, admitted) must never
        // escape into the webServer's bare 400 — always answer JSON.
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('hub-bot management handler failed outside dispatch: %s', message)
        try { json(res, 500, { error: message, code: 'handler-outer' }) } catch { /* response already ended */ }
      }
    },
  })

}
