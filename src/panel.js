/**
 * Panel domain (#73 面板三问与设置页): everything the web panel needs that is not HTTP.
 *
 * Two halves:
 *  1. Settings write-back — the panel patches a WHITELIST of settings (concurrency, reporting, feishu/github
 *     switches and allowlists). The patch mutates the live resolved config (every reader — Router slots,
 *     auto-report tick, Source policy — reads these same objects), and the validated patch is persisted as an
 *     overlay file under stateDir (0600, like the credentials file). At boot the overlay replays onto the
 *     profile config, so panel changes survive restarts without the plugin ever editing the profile.
 *  2. The 三问 overview — assembled from ticket FACES (stageText 朗读, report facts, authorization) plus the
 *     owner registry; the panel never invents state the tickets do not carry (诚实状态: 计数 = 列表长度).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
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
  feishu: [],
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
 * Validates one settings patch against the whitelist, applies it onto the live resolved config, and returns
 * the storable overlay (exactly the validated patch). Unknown sections/keys and invalid values reject with
 * SettingsError and mutate nothing before the offending entry.
 */
export function applySettingsPatch(config, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new SettingsError('settings patch must be an object keyed by section')
  }
  const overlay = {}
  for (const [section, body] of Object.entries(patch)) {
    const keys = SETTABLE[section]
    if (!keys) throw new SettingsError('hub-bot settings: unknown settings section "' + section + '"')
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new SettingsError('settings section "' + section + '" must be an object')
    }
    const applied = {}
    for (const [key, value] of Object.entries(body)) {
      if (!keys.includes(key)) {
        throw new SettingsError('hub-bot does not know settings key "' + section + '.' + key + '"')
      }
      applied[key] = applyOne(config, section, key, value)
    }
    overlay[section] = applied
  }
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
  if (section === 'github' && key === 'enabled') {
    config.github.enabled = requireBoolean(value, 'github.enabled')
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

/** Persists the settings overlay owner-only (0600) — it can carry allowlists, like the credentials file. */
export function saveSettingsOverlay(stateDir, overlay) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, SETTINGS_FILE), JSON.stringify(overlay, null, 2) + '\n', { mode: 0o600 })
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
  const triggers = new Map(readAll('trigger').map(t => [t.id, t]))
  const owners = registry.list().map(o => ({
    id: o.id, role: o.role, kind: o.kind, workspace: o.workspace ?? null, cwd: o.cwd,
    sessionId: o.sessionId ?? null, status: o.status, transient: o.transient === true, recycled: o.recycled === true,
    createdAt: o.createdAt ?? null, updatedAt: o.updatedAt ?? null,
  }))
  const ownerById = new Map(owners.map(o => [o.id, o]))
  const tickets = readAll('ticket').map(t => {
    const trigger = t.triggerId ? triggers.get(t.triggerId) : undefined
    const owner = ownerById.get(t.owner)
    const row = {
      id: t.id,
      owner: t.owner,
      ownerLabel: owner ? (owner.workspace ?? owner.id) : t.owner,
      stage: t.stage,
      stageText: STAGE_TEXT[t.stage] ?? t.stage,
      message: typeof trigger?.message === 'string' ? trigger.message : null,
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt ?? null,
      recoveryPending: t.recoveryPending === true,
      // 授权记录 (AC 11: 谁授权的、什么时候、基于哪条消息) 与任务历史都在票面上
      authorization: t.authorization ?? null,
      trigger: trigger ? { id: trigger.id, kind: trigger.kind ?? null, at: trigger.at ?? null, sourceRef: trigger.sourceRef ?? null } : null,
      assignments: t.assignments ?? [],
      question: t.question ?? null,
      pendingConfirm: t.pendingConfirm ?? null,
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
  // 最近消息流（GUI 面板「最近消息」区）: trigger 按时间倒序前 12 条，带上票面的 owner/阶段——
  // 让「刚才飞书那句话进来没有、派给谁了、现在什么状态」一眼可查，不用翻任务流。
  // 关联方向: ticket.triggerId → trigger（trigger 侧没有 ticketId——入站先记 trigger，票面后建）。
  const ticketByTriggerId = new Map(tickets.filter(t => t.trigger?.id).map(t => [t.trigger.id, t]))
  // 回复投递状态（消息闭环）: 每条入站消息关联的票 → outbox 行。多行取「最差」状态——
  // failed > held/queued > sent > recorded，让失败永远浮在最上面。
  const REPLY_PRIORITY = { failed: 0, held: 1, queued: 1, sent: 2, recorded: 3 }
  const outboxByTicket = new Map()
  // 直接回复（chief 未建票）outbox 行 ticketId 为空——按 feishu:chat:<chatId> 另建索引归位到 trigger (round 53)。
  const replyRowsByChat = new Map()
  for (const row of readAll('outbox')) {
    if (row.kind === 'reply' && row.to && String(row.to).startsWith('feishu:chat:')) {
      const chatList = replyRowsByChat.get(row.to) ?? []
      chatList.push(row)
      replyRowsByChat.set(row.to, chatList)
    }
    if (!row.ticketId) continue
    const list = outboxByTicket.get(row.ticketId) ?? []
    list.push(row)
    outboxByTicket.set(row.ticketId, list)
  }
  const directReplyFor = trigger => {
    if (trigger.kind !== 'feishu' || !trigger.source?.chatId) return null
    const rows = (replyRowsByChat.get('feishu:chat:' + trigger.source.chatId) ?? [])
      .filter(r => String(r.createdAt ?? '') >= String(trigger.at ?? ''))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return rows[0] ?? null
  }
  const replyStateForRow = row => ({ state: row.state ?? 'queued', id: row.id, attempts: row.attempts ?? 0, lastError: row.lastError ?? null })
  const replyStateFor = ticketId => {
    const rows = outboxByTicket.get(ticketId)
    if (!rows || rows.length === 0) return null
    const worst = [...rows].sort((a, b) => (REPLY_PRIORITY[a.state] ?? 9) - (REPLY_PRIORITY[b.state] ?? 9))[0]
    return { state: worst.state ?? 'queued', id: worst.id, attempts: worst.attempts ?? 0, lastError: worst.lastError ?? null }
  }
  const recentTriggers = [...triggers.values()]
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, 12)
    .map(t => {
      const tk = ticketByTriggerId.get(t.id)
      const direct = tk ? null : directReplyFor(t)
      return {
        id: t.id,
        kind: t.kind ?? null,
        at: t.at ?? null,
        message: typeof t.message === 'string' ? (t.message.length > 160 ? t.message.slice(0, 160) + '…' : t.message) : null,
        dropped: t.dropped ?? null,
        ticketId: tk?.id ?? null,
        ownerLabel: tk?.ownerLabel ?? null,
        stage: tk?.stage ?? null,
        stageText: tk?.stageText ?? null,
        reply: tk?.id ? replyStateFor(tk.id) : (direct ? replyStateForRow(direct) : null),
      }
    })
  return {
    generatedAt: (now ?? (() => new Date().toISOString()))(),
    owners,
    tickets,
    recentTriggers,
    health: health ?? {},
  }
}
