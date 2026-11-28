/**
 * Panel domain (#73 面板三问与设置页): everything the web panel needs that is not HTTP.
 *
 * Two halves:
 *  1. Settings write-back — the panel patches a WHITELIST of settings (concurrency, reporting, feishu/github
 *     switches and allowlists). The patch mutates the live resolved config (every reader — Router slots,
 *     auto-report tick, Source policy — reads these same objects), and the validated patch is persisted as an
 *     overlay file under stateDir (0600, like the credentials file) by writing a same-directory temp file and
 *     renaming it over the target — an already-open reader keeps the complete previous snapshot instead of
 *     observing a truncated in-place rewrite. At boot the overlay replays onto the profile config, so panel
 *     changes survive restarts without the plugin ever editing the profile.
 *  2. The 三问 overview — assembled from ticket FACES (stageText 朗读, report facts, authorization) plus the
 *     owner registry; the panel never invents state the tickets do not carry (诚实状态: 计数 = 列表长度).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { STAGE_TEXT } from './tasks.js'
import { validateChiefModel } from './config.js'

/** The overlay file holding panel-written settings (stateDir, 0600). */
export const SETTINGS_FILE = 'hub-bot.settings.json'

/** An invalid settings patch/overlay; the message names the offending key and the rule it broke. */
export class SettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsError'
  }
}

/** 30s floor mirrors config.js — the GitHub authenticated rate budget is 5000 requests/hour. */
const MIN_GITHUB_INTERVAL_MS = 30 * 1000

/** The settings sections and keys the panel may write. Anything else is rejected so typos cannot pass silently. */
const SETTABLE = {
  concurrency: ['slotsPerOwner'],
  reporting: ['auto', 'intervalMs'],
  github: ['enabled', 'intervalMs', 'loginAllowlist'],
  feishu: ['enabled'],
  security: ['dangerousPatterns'],
  chief: ['model'],
  workspaces: ['enabled', 'chiefPath', 'chiefTitle', 'chiefWorkspaceId'],
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') throw new SettingsError(path + ' must be a boolean')
  return value
}

function requireStringList(value, path) {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim())) {
    throw new SettingsError(path + ' must be an array of non-empty strings')
  }
  return value.map(v => v.trim())
}

/**
 * Validates a patch and returns the storable overlay. The optional persistence callback runs before
 * updating the shared configuration sections, so validation and persistence failures leave them intact.
 */
export function applySettingsPatch(config, patch, beforeApply) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new SettingsError('settings patch must be an object keyed by section')
  }
  const overlay = {}
  const draft = {}
  for (const [section, body] of Object.entries(patch)) {
    const keys = SETTABLE[section]
    if (!keys) throw new SettingsError('hub-bot settings: unknown settings section "' + section + '"')
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new SettingsError('settings section "' + section + '" must be an object')
    }
    const applied = {}
    draft[section] = { ...config[section] }
    for (const [key, value] of Object.entries(body)) {
      if (!keys.includes(key)) {
        throw new SettingsError('hub-bot does not know settings key "' + section + '.' + key + '"')
      }
      applied[key] = applyOne(draft, section, key, value)
    }
    overlay[section] = applied
  }
  beforeApply?.(overlay)
  for (const [section, values] of Object.entries(overlay)) Object.assign(config[section], values)
  return overlay
}

/** Boot path: replay the persisted overlay onto the freshly resolved profile config. Same validation as the panel. */
export function applySettingsOverlay(config, overlay) {
  return applySettingsPatch(config, overlay ?? {})
}

function applyOne(config, section, key, value) {
  if (section === 'concurrency' && key === 'slotsPerOwner') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new SettingsError('concurrency.slotsPerOwner must be a positive integer (>= 1)')
    }
    config.concurrency.slotsPerOwner = value
    return value
  }
  if (section === 'reporting' && key === 'auto') {
    config.reporting.auto = requireBoolean(value, 'reporting.auto')
    return value
  }
  if (section === 'reporting' && key === 'intervalMs') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new SettingsError('reporting.intervalMs must be a positive number')
    }
    config.reporting.intervalMs = value
    return value
  }
  if ((section === 'github' || section === 'feishu') && key === 'enabled') {
    config[section].enabled = requireBoolean(value, section + '.enabled')
    return value
  }
  if (section === 'github' && key === 'intervalMs') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_GITHUB_INTERVAL_MS) {
      throw new SettingsError('github.intervalMs must be an integer >= ' + MIN_GITHUB_INTERVAL_MS + ' (30s) — 认证限额 5000 次/小时')
    }
    config.github.intervalMs = value
    return value
  }
  if (section === 'github' && key === 'loginAllowlist') {
    const list = requireStringList(value, 'github.loginAllowlist')
    config.github.loginAllowlist = list
    return list
  }
  if (section === 'security' && key === 'dangerousPatterns') {
    // 危险命令黑名单 (spec「Policy」): 整表替换; 空数组 = 显式关闭兜底 (用户自己的选择, 与授权白名单同理)。
    const list = requireStringList(value, 'security.dangerousPatterns')
    config.security.dangerousPatterns = list
    return list
  }
  if (section === 'workspaces' && key === 'enabled') {
    config.workspaces.enabled = requireBoolean(value, 'workspaces.enabled')
    return value
  }
  if (section === 'workspaces' && key === 'chiefPath') {
    // 公共工作区 (#52 后续): '' / null = 回落默认 homeRepo/.hub-bot/chief; 否则必须绝对路径。
    if (value === null || value === '') {
      config.workspaces.chiefPath = null
      return null
    }
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new SettingsError('workspaces.chiefPath must be an absolute path, or empty to use the default')
    }
    config.workspaces.chiefPath = value
    return value
  }
  if (section === 'workspaces' && key === 'chiefWorkspaceId') {
    // 关联式归位（turn 108）: 用户选中的 DSH 工作区 id；'' / null = 自动模式。
    if (value === null || value === '') {
      config.workspaces.chiefWorkspaceId = null
      return null
    }
    if (typeof value !== 'string' || !value.trim()) throw new SettingsError('workspaces.chiefWorkspaceId must be a non-empty string or null')
    config.workspaces.chiefWorkspaceId = value.trim()
    return config.workspaces.chiefWorkspaceId
  }
  if (section === 'workspaces' && key === 'chiefTitle') {
    if (typeof value !== 'string' || !value.trim()) throw new SettingsError('workspaces.chiefTitle must be a non-empty string')
    config.workspaces.chiefTitle = value.trim()
    return config.workspaces.chiefTitle
  }
  if (section === 'chief' && key === 'model') {
    // 总管模型 (面板「总管模型」): null = 跟随部署默认; 否则固定 {provider, model, reasoningEffort?}。
    const model = validateChiefModel(value, 'chief', SettingsError)
    config.chief.model = model
    return model
  }
  throw new SettingsError('hub-bot does not know settings key "' + section + '.' + key + '"')
}

/**
 * Merges one accepted patch into the accumulated overlay: sections merge key-wise, so successive panel
 * edits accumulate instead of clobbering each other.
 */
export function mergeSettingsOverlay(base, patch) {
  const next = { ...base }
  for (const [section, body] of Object.entries(patch)) {
    next[section] = { ...(next[section] ?? {}), ...body }
  }
  return next
}

/** Reads the persisted settings overlay; a missing or corrupt file reads as empty so boot never breaks. */
export function loadSettingsOverlay(stateDir) {
  let text
  try {
    text = readFileSync(join(stateDir, SETTINGS_FILE), 'utf8')
  } catch {
    return {}
  }
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** 原子替换时临时文件的序号：同进程内保证临时名唯一，并发写不会互相踩到同一个临时文件。 */
let settingsTempSeq = 0

/**
 * Persists the settings overlay owner-only (0600) — it can carry allowlists, like the credentials file.
 *
 * 写入是「整文件替换」：先把完整内容写进同目录的临时文件，再 rename 覆盖目标。rename 换的是目录项
 * （新 inode），已经打开旧文件的读者继续看到完整的上一版快照，绝不会读到被截断的一半内容。
 * 任何一步失败都会清掉临时文件并抛出：目标文件与内存里的配置都保持原样，不出现半成功。
 *
 * @param {string} stateDir - state 目录（不存在则创建）。
 * @param {object} overlay - 已通过 applySettingsPatch 校验的覆盖层。
 * @param {{ writeFileSync?: (path: string, text: string, options?: { mode?: number }) => void,
 *   chmodSync?: (path: string, mode: number) => void,
 *   renameSync?: (from: string, to: string) => void,
 *   unlinkSync?: (path: string) => void }} [io] 测试替身；缺省用 node:fs 的同名同步函数。
 */
export function saveSettingsOverlay(stateDir, overlay, io = {}) {
  const write = io.writeFileSync ?? writeFileSync
  const chmod = io.chmodSync ?? chmodSync
  const rename = io.renameSync ?? renameSync
  const unlink = io.unlinkSync ?? unlinkSync
  mkdirSync(stateDir, { recursive: true })
  const target = join(stateDir, SETTINGS_FILE)
  // 临时文件必须与目标同目录：跨文件系统的 rename 会退化成「拷贝 + 删除」，原子性就没了。
  settingsTempSeq += 1
  const tmp = join(stateDir, '.' + SETTINGS_FILE + '.' + process.pid + '.' + settingsTempSeq)
  try {
    write(tmp, JSON.stringify(overlay, null, 2) + '\n', { mode: 0o600 })
    // writeFileSync 的 mode 会被 umask 削掉，显式 chmod 才保证替换后的文件仍是 owner-only 0600。
    chmod(tmp, 0o600)
    rename(tmp, target)
  } catch (error) {
    try {
      unlink(tmp)
    } catch {
      // 临时文件可能根本没建起来；清理失败不能掩盖原始错误。
    }
    throw error
  }
}

/** A capped directory listing for the 结果在哪 view; null when the directory cannot be read. */
export function listDirCapped(cwd, cap = 50) {
  try {
    return readdirSync(cwd, { withFileTypes: true }).slice(0, cap).map(d => d.name + (d.isDirectory() ? '/' : ''))
  } catch {
    return null
  }
}

/**
 * The settings page view: effective config (profile ⊕ overlay) merged with live source status.
 * @param {object} config - the live resolved config.
 * @param {{ feishuStatus?: object, githubStatus?: object }} status - live Source status() snapshots.
 */
export function buildSettingsView(config, { feishuStatus, githubStatus } = {}) {
  return {
    concurrency: { slotsPerOwner: config.concurrency.slotsPerOwner },
    reporting: { auto: config.reporting.auto, intervalMs: config.reporting.intervalMs },
    security: { dangerousPatterns: [...(config.security?.dangerousPatterns ?? [])] },
    chief: { model: config.chief?.model ?? null },
    workspaces: {
      enabled: config.workspaces?.enabled ?? true,
      chiefPath: config.workspaces?.chiefPath ?? null,
      chiefTitle: config.workspaces?.chiefTitle ?? 'Hub Bot 中枢',
      chiefWorkspaceId: config.workspaces?.chiefWorkspaceId ?? null,
    },
    feishu: {
      enabled: config.feishu.enabled,
      status: feishuStatus ?? null,
    },
    github: {
      enabled: config.github.enabled,
      intervalMs: config.github.intervalMs,
      loginAllowlist: [...(config.github.loginAllowlist ?? [])],
      mentionHandle: config.github.mentionHandle ?? null,
      // 监听清单跟随 owner 注册表（只读展示）：githubStatus.followed 由 GitHubSource.status() 提供
      followed: githubStatus?.followed ?? [],
      resolveErrors: githubStatus?.resolveErrors ?? {},
      status: githubStatus ?? null,
    },
  }
}

export function feishuSelfTestMarker(messageId) {
  if (typeof messageId !== 'string' || !/^om_selftest-[0-9a-f]{32}$/.test(messageId)) return null
  return '[hub-bot-check:' + messageId + ']'
}


/** Snapshot the queue for both management entry points. Recorded channel replies retry on the source tick. */
export function buildOutboxHealth(store) {
  const rows = store.db.prepare('SELECT value FROM outbox ORDER BY rowid').all().map(row => JSON.parse(String(row.value)))
  const count = state => rows.filter(row => row.state === state).length
  const problems = rows.filter(row => row.kind === 'system-problem')
  const isRetrying = row => (row.attempts ?? 0) > 0 && (row.state === 'queued'
    || (row.state === 'recorded' && /^(feishu|github):/.test(row.to ?? '')))
  const delivery = row => ({
    id: row.id, ticketId: row.ticketId ?? null, to: row.to, state: row.state, attempts: row.attempts ?? 0,
    nextRetryAt: row.nextRetryAt ?? null, lastError: row.lastError ?? null, text: String(row.body ?? row.text ?? '').slice(0, 120),
  })
  return {
    queued: count('queued'), held: count('held'), recorded: count('recorded'), failed: count('failed'), sent: count('sent'),
    retrying: rows.filter(isRetrying).map(delivery),
    failedList: rows.filter(row => row.state === 'failed').map(delivery),
    systemProblems: problems.length,
    recentProblems: problems.slice(-5).reverse().map(row => ({
      id: row.id, ticketId: row.ticketId ?? null, body: String(row.body ?? '').slice(0, 200), at: row.createdAt ?? null,
    })),
  }
}

const REPLY_PRIORITY = { failed: 0, held: 1, queued: 1, recorded: 1, sent: 2 }
const FEISHU_TEST_MARKER = /\[hub-bot-check:om_selftest-[0-9a-f]{32}\]/

function storedMessage(trigger) {
  if (typeof trigger.message === 'string') return trigger.message
  return typeof trigger.title === 'string' ? trigger.title : null
}

function projectReply(row, limit) {
  const text = String(row.body ?? row.text ?? '')
  return {
    id: row.id, state: row.state ?? 'queued', attempts: row.attempts ?? 0,
    lastError: row.lastError ?? null, text: text.slice(0, limit),
  }
}

/** Shared attribution for the overview and the on-demand message detail. */
function indexMessageReplies(store, triggers, ticketTriggers) {
  const linked = new Map()
  const unlinkedByChat = new Map()
  const testsByMarker = new Map()
  function pick(index, key, row) {
    if (!key) return
    const previous = index.get(key)
    const order = (REPLY_PRIORITY[row.state] ?? 3) - (REPLY_PRIORITY[previous?.state] ?? 3)
    if (!previous || order < 0 || (order === 0 && (row.createdAt ?? '') >= (previous.createdAt ?? ''))) index.set(key, row)
  }
  const replies = store.db.prepare("SELECT value FROM outbox WHERE json_extract(value, '$.kind') = 'reply' ORDER BY rowid")
  for (const raw of replies.iterate()) {
    const row = JSON.parse(String(raw.value))
    if (typeof row.to !== 'string') continue
    const triggerId = row.triggerId ?? ticketTriggers.get(row.ticketId)
    const trigger = triggers.get(triggerId)
    if (row.to.startsWith('github:')) {
      if (trigger) pick(linked, triggerId, row)
      continue
    }
    if (!row.to.startsWith('feishu:')) continue
    const chatId = row.to.replace(/^feishu:(chat:)?/, '')
    const marker = String(row.body ?? row.text ?? '').match(FEISHU_TEST_MARKER)?.[0] ?? null
    if (trigger?.kind === 'feishu' && trigger.source?.chatId === chatId) {
      if (marker === feishuSelfTestMarker(trigger.source.messageId)) pick(linked, triggerId, row)
    } else if (!row.triggerId && !row.ticketId) {
      if (marker) pick(testsByMarker, chatId + ':' + marker, row)
      else if (!unlinkedByChat.has(chatId) || (row.createdAt ?? '') >= (unlinkedByChat.get(chatId).createdAt ?? '')) unlinkedByChat.set(chatId, row)
    }
  }
  return trigger => {
    const marker = feishuSelfTestMarker(trigger.source?.messageId)
    const chatId = trigger.source?.chatId
    const historicalRun = marker && chatId ? testsByMarker.get(chatId + ':' + marker) : null
    const row = linked.get(trigger.id)
      ?? (historicalRun && (historicalRun.createdAt ?? '') >= trigger.at ? historicalRun : null)
    const legacyReply = unlinkedByChat.get(chatId)
    const unlinked = trigger.kind === 'feishu' && !trigger.dropped && !marker && !row
      && Boolean(legacyReply && (legacyReply.createdAt ?? '') >= trigger.at)
    return { row, unlinked, marker }
  }
}

/** Read full stored text only when a user opens the message. */
export function readMessageDetail(store, triggerId) {
  const record = store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(triggerId)
  if (!record) return null
  const trigger = JSON.parse(String(record.value))
  const tickets = store.db.prepare("SELECT id, value FROM ticket WHERE json_extract(value, '$.triggerId') = ? ORDER BY rowid").all(triggerId)
  const ticketTriggers = new Map(tickets.map(ticket => [ticket.id, triggerId]))
  const ticket = tickets.length ? JSON.parse(String(tickets.at(-1).value)) : null
  const { row, unlinked } = indexMessageReplies(store, new Map([[triggerId, trigger]]), ticketTriggers)(trigger)
  const intakeRows = store.db.prepare(
    "SELECT value FROM outbox WHERE json_extract(value, '$.triggerId') = ? "
    + "AND json_extract(value, '$.kind') IN ('inbox', 'stop', 'inject')",
  ).all(triggerId).map(record => JSON.parse(String(record.value)))
  const delivery = pickQueueRow(intakeRows)
  return {
    id: triggerId, message: storedMessage(trigger), at: trigger.at ?? null,
    dropped: trigger.dropped ?? null, replyUnlinked: unlinked,
    intake: trigger.policy || delivery || trigger.intakeCohort ? {
      disposition: delivery?.state === 'failed' ? 'failed' : intakeDisposition(trigger, ticket),
      queueState: delivery?.state ?? null, lastError: delivery?.lastError ?? null,
      ...(trigger.intakeCohort && { cohort: {
        ...trigger.intakeCohort,
        messages: trigger.intakeCohort.triggerIds.map(id => {
          const linked = store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
          return { triggerId: id, message: linked ? storedMessage(JSON.parse(String(linked.value))) : null,
            ticketIds: store.db.prepare("SELECT id FROM ticket WHERE json_extract(value, '$.triggerId') = ?").all(id).map(ticket => ticket.id) }
        }),
      } }),
    } : null,
    reply: row ? { ...projectReply(row), sentAt: row.sentAt ?? null } : null,
  }
}

/**
 * S06 投喂面（只读投影）: the two intake entries — the Feishu source and the normal owner route — described
 * ONLY by what the router already persisted (trigger rows + outbox rows). Nothing here is computed from
 * settings, nothing here is writable, and a fact the router did not record stays null so the panel renders
 * 「—」 instead of inventing a value (诚实状态). The arrival-time policy snapshot is passed through verbatim
 * under whatever key the router chose; the panel never guesses or fills it in.
 */
const INTAKE_SOURCES = [
  ['feishu', '飞书入口'],
  ['route', '负责人路由'],
]

/** Most relevant delivery row first: failures, then in-flight, then delivered (mirrors REPLY_PRIORITY). */
const QUEUE_PRIORITY = { failed: 0, held: 1, queued: 1, recorded: 1, sent: 2 }

/**
 * The arrival-time policy snapshot, if the router persisted one on the trigger row (read-only pass-through).
 * 契约（s06-core 确认）: 快照是触发行上的顶层 `policy` 字段（{ addressing, chatType, msgType, allowed, reason }），
 * 没有 `intake`/`policySnapshot` 之类的外层包装。没落库就是 null —— 面板不补、不猜。
 */
function policySnapshot(trigger) {
  const value = trigger.policy
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function pickQueueRow(rows) {
  let best = null
  for (const row of rows) {
    const order = QUEUE_PRIORITY[row.state] ?? 3
    if (!best) { best = row; continue }
    const bestOrder = QUEUE_PRIORITY[best.state] ?? 3
    if (order < bestOrder || (order === bestOrder && String(row.createdAt ?? '') >= String(best.createdAt ?? ''))) best = row
  }
  return best
}

/**
 * 处置口径 — 只从已落库的事实里选一个词，两个入口共用同一套判断（面板与客户端不再各自猜）:
 *  - 'dropped'  触发行自带 dropped（router 当场丢弃并记账）
 *  - 'injected' 触发行有真实注入时间戳（飞书侧注入成功才回写）或票面 lastDelivery.state === 'sent'
 *               （router markDelivered 只在 prompt 真被宿主接纳后才写）
 *  - 'pending'  触发行已落库但上面两条都不成立 —— 已受理、等注入（重启会重放，不是丢失）
 *  - null       这个入口还没有任何触发行
 */
function intakeDisposition(trigger, ticket) {
  if (!trigger) return null
  if (trigger.dropped) return 'dropped'
  if (trigger.policy?.mode === 'interrupt') return trigger.interruptAt ? 'interrupt-requested' : 'interrupt'
  if (trigger.injectedAt != null) return 'injected'
  if (ticket?.lastDelivery?.state === 'sent') return 'injected'
  if (trigger.intakeDiscarded === true) return 'discarded'
  return 'pending'
}

function intakeProjection({ triggers, tickets, outbox, generatedAt }) {
  const ticketByTrigger = new Map()
  for (const ticket of tickets) if (ticket.triggerId) ticketByTrigger.set(ticket.triggerId, ticket)
  const rowsByTicket = new Map()
  const rowsByTrigger = new Map()
  const push = (map, key, row) => { const list = map.get(key); if (list) list.push(row); else map.set(key, [row]) }
  for (const row of outbox) {
    if (row.ticketId) push(rowsByTicket, row.ticketId, row)
    if (row.triggerId) push(rowsByTrigger, row.triggerId, row)
  }
  const emptyQueue = { state: null, attempts: 0, nextRetryAt: null, lastError: null, rows: 0 }
  const sources = INTAKE_SOURCES.map(([source, label]) => {
    const mine = triggers.filter(trigger => (trigger.kind ?? null) === source)
    // 计数就是列表长度，口径与「处置」列一致：飞书侧注入成功才回写 injectedAt；route 侧由票面
    // lastDelivery.state === 'sent' 判定（router markDelivered 只在 prompt 真被宿主接纳后才写）。
    const counts = {
      triggers: mine.length,
      dropped: mine.filter(trigger => Boolean(trigger.dropped)).length,
      injected: mine.filter(trigger => intakeDisposition(trigger, ticketByTrigger.get(trigger.id) ?? null) === 'injected').length,
    }
    const last = mine.reduce((best, trigger) => (!best || String(trigger.at ?? '') >= String(best.at ?? '') ? trigger : best), null)
    if (!last) {
      return { source, label, at: null, triggerId: null, addressing: null, dropped: null, injectedAt: null,
        ownerId: null, ticketId: null, policy: null, dedupKey: null, disposition: null, queue: { ...emptyQueue }, counts }
    }
    const ticket = ticketByTrigger.get(last.id) ?? null
    const linked = new Map()
    for (const row of rowsByTrigger.get(last.id) ?? []) linked.set(row.id, row)
    for (const row of ticket ? rowsByTicket.get(ticket.id) ?? [] : []) linked.set(row.id, row)
    const queueRow = pickQueueRow([...linked.values()])
    return {
      source,
      label,
      at: last.at ?? null,
      triggerId: last.id,
      // 到达时的受理口径: 触发行自带的 addressing（feishu 源归一化产物 / 授权记录），没有就是 null。
      addressing: last.source?.addressing ?? last.authorization?.addressing ?? null,
      dropped: last.dropped ?? null,
      injectedAt: last.injectedAt ?? null,
      // 归属人：触发行自己写了就用它，否则用这张票面上的 owner（都是已落库的事实，不推断）。
      ownerId: last.ownerId ?? ticket?.owner ?? null,
      ticketId: ticket?.id ?? null,
      policy: policySnapshot(last),
      // 去重键 = 触发行 id（feishu 侧是 feishu-<messageId>；route 侧是 router 生成/回填的引用）。
      dedupKey: last.id,
      disposition: intakeDisposition(last, ticket),
      queue: {
        state: queueRow?.state ?? null,
        attempts: queueRow?.attempts ?? 0,
        nextRetryAt: queueRow?.nextRetryAt ?? null,
        lastError: queueRow?.lastError ?? null,
        rows: linked.size,
      },
      counts,
    }
  })
  return { generatedAt, sources }
}

/** Standalone entry point for callers that hold only a Store (tests, dev API). */
export function buildIntakePolicy(store, { now } = {}) {
  const readAll = table => store.db.prepare('SELECT value FROM ' + table).all().map(r => JSON.parse(String(r.value)))
  return intakeProjection({
    triggers: readAll('trigger'),
    tickets: readAll('ticket'),
    outbox: readAll('outbox'),
    generatedAt: (now ?? (() => new Date().toISOString()))(),
  })
}

/**
 * The 三问 overview (spec「观测性：独立 web 面板」):
 *  1. 什么状态 — every ticket with its stage + stageText 朗读, grouped client-side (计数 = 列表长度);
 *  2. 在干什么 — the ticket face facts (report 四段, pendingConfirm, question, assignments);
 *  3. 结果在哪 — 等验收票 additionally carry the owner directory listing (产物在哪).
 * @param {{ store: import('./store.js').Store, registry: import('./registry.js').OwnerRegistry,
 *   health?: object, now?: () => string, listDir?: (cwd: string) => string[] | null }} args
 */
export function buildOverview({ store, registry, health, now, listDir }) {
  const readAll = table => store.db.prepare('SELECT value FROM ' + table).all().map(r => JSON.parse(String(r.value)))
  const triggerRows = readAll('trigger')
  const triggers = new Map(triggerRows.map(t => [t.id, t]))
  const owners = registry.list().map(o => ({
    id: o.id, role: o.role, kind: o.kind, workspace: o.workspace ?? null, cwd: o.cwd,
    sessionId: o.sessionId ?? null, status: o.status, transient: o.transient === true, recycled: o.recycled === true,
    createdAt: o.createdAt ?? null, updatedAt: o.updatedAt ?? null,
  }))
  const ownerById = new Map(owners.map(o => [o.id, o]))
  const ticketRows = readAll('ticket')
  const outboxRows = readAll('outbox')
  const answersById = new Map(outboxRows.filter(row => row.kind === 'deferred-answer').map(row => [row.id, row]))
  const tickets = ticketRows.map(t => {
    let answerDelivery = t.deferred?.outcome?.delivery ?? null
    if (answerDelivery?.state === 'queued') {
      const row = answersById.get('out-answer-' + t.deferred.requestId)
      if (!row) answerDelivery = { state: 'discarded' }
      else if (row.state === 'failed') answerDelivery = { state: 'failed', reason: row.lastError ?? null }
    }
    const trigger = t.triggerId ? triggers.get(t.triggerId) : undefined
    const owner = ownerById.get(t.owner)
    const row = {
      id: t.id,
      owner: t.owner,
      ownerLabel: owner ? (owner.workspace ?? owner.id) : t.owner,
      stage: t.stage,
      stageText: STAGE_TEXT[t.stage] ?? t.stage,
      message: t.routedMessage ?? (typeof trigger?.message === 'string' ? trigger.message : null),
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt ?? null,
      recoveryPending: t.recoveryPending === true,
      // 授权记录 (AC 11: 谁授权的、什么时候、基于哪条消息) 与任务历史都在票面上
      authorization: t.authorization ?? null,
      trigger: trigger ? { id: trigger.id, kind: trigger.kind ?? null, at: trigger.at ?? null, sourceRef: trigger.sourceRef ?? null } : null,
      assignments: t.assignments ?? [],
      workerSession: t.workerSession ?? null,
      lastDelivery: t.lastDelivery ? { state: t.lastDelivery.state ?? null } : null,
      background: t.background ? { kind: t.background.kind, timerId: t.background.timerId ?? null } : null,
      question: t.question ?? null,
      pendingConfirm: t.pendingConfirm ?? null,
      deferred: t.deferred ? { requestId: t.deferred.requestId, type: t.deferred.type,
        status: t.deferred.status, expiresAt: t.deferred.expiresAt,
        target: t.deferred.target ?? null,
        delivery: answerDelivery, reason: t.deferred.outcome?.reason ?? null } : null,
      report: t.report ?? null,
      dirListing: null,
    }
    // 结果在哪: list artifacts for review/working tickets whose owner directory still exists (recycled 已删).
    // review 行内展示，working 收进详情折叠——干活干到一半也能瞄一眼产物。
    if ((t.stage === 'person/review' || t.stage === 'working') && owner && !owner.recycled) {
      row.dirListing = (listDir ?? listDirCapped)(owner.cwd)
    }
    return row
  })
  const ticketTriggers = new Map(tickets.map(ticket => [ticket.id, ticket.trigger?.id]))
  const ticketByTriggerId = new Map(tickets.filter(ticket => ticket.trigger?.id).map(ticket => [ticket.trigger.id, ticket]))
  const replyFor = indexMessageReplies(store, triggers, ticketTriggers)
  const generatedAt = (now ?? (() => new Date().toISOString()))()
  const nowMs = Date.parse(generatedAt) || Date.now()
  function projectTrigger(trigger) {
    const ticket = ticketByTriggerId.get(trigger.id)
    const { row, unlinked, marker } = replyFor(trigger)
    const message = storedMessage(trigger)
    const age = nowMs - Date.parse(trigger.at ?? '')
    return {
      id: trigger.id, at: trigger.at ?? null,
      kind: trigger.kind === 'github-dropped' || trigger.authorization?.source === 'github' ? 'github' : trigger.kind ?? null,
      message: message?.length > 160 ? message.slice(0, 160) + '…' : message,
      dropped: trigger.dropped ?? null,
      injectedAt: trigger.injectedAt ?? null,
      ticketId: ticket?.id ?? null, ownerLabel: ticket?.ownerLabel ?? null,
      stage: ticket?.stage ?? null, stageText: ticket?.stageText ?? null,
      reply: row ? projectReply(row, 120) : null,
      replyUnlinked: unlinked,
      unprocessed: !trigger.dropped && !marker && !ticket && !row && age > 5 * 60_000
        && (!unlinked || Object.hasOwn(trigger, 'injectedAt')),
    }
  }
  const projected = [...triggers.values()].map(projectTrigger)
  const recentTriggers = [...projected].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 12)
  const selfTests = projected
    .filter(row => row.kind === 'feishu' && feishuSelfTestMarker(triggers.get(row.id)?.source?.messageId) && nowMs - Date.parse(row.at) <= 120_000)
    .map(({ id, dropped, reply }) => ({ id, dropped, reply }))
  const unprocessedTriggers = projected.filter(row => row.unprocessed).length
  // S06: 投喂面口径只读投影 — 完全由上面已读出的 trigger/ticket/outbox 行推导，不读设置、不写任何东西。
  const intake = intakeProjection({ triggers: triggerRows, tickets: ticketRows, outbox: outboxRows, generatedAt })
  return {
    generatedAt,
    owners,
    tickets,
    recentTriggers,
    selfTests,
    unprocessedTriggers,
    intake,
    health: health ?? {},
  }
}
