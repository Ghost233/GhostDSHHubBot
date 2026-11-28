/**
 * Plugin configuration: the state directory every persistent artifact lives under, plus the optional development
 * management API.
 *
 * hub-bot refuses to start without an explicit absolute stateDir — silently defaulting into a profile directory would
 * scatter Tasks, Triggers and the owner registry across reinstalls.
 *
 * The loopback management API (src/index.js) can inject prompts into any Session of the profile it runs in, so it is
 * OFF unless the configuration explicitly enables it with a token: `devApi: { token: "..." }`. Requests must carry
 * that token. Without `devApi` the plugin loads normally and registers no HTTP routes at all.
 */
import { isAbsolute } from 'node:path'
import { DEFAULT_DANGEROUS_PATTERNS, validateDangerousPatterns } from './security.js'
import { DEFAULT_FEISHU_CREDENTIAL_REF, isFeishuCredentialRef } from './feishu-credentials.js'

/** The configuration keys this plugin understands. Anything else is rejected so typos cannot pass silently. */
const KNOWN_KEYS = new Set(['stateDir', 'homeRepo', 'devApi', 'reporting', 'feishu', 'github', 'concurrency', 'security', 'deferred', 'chief', 'workspaces'])

/** The keys the scheduled auto-summary understands (#67 定时汇总自动汇报 — OFF by default). */
const KNOWN_REPORTING_KEYS = new Set(['auto', 'intervalMs'])

/** The keys the optional development management API understands. */
const KNOWN_DEV_API_KEYS = new Set(['token'])

/** The keys the Feishu entry (#68) understands. OFF unless enabled; the allowlist names authorized open_ids.
 *  `appId`/`appSecret` stay listed on purpose: they are the retired v1 plaintext credential channel, and naming them
 *  lets the validation below answer with a migration hint instead of a bare "unknown key" typo message. */
const KNOWN_FEISHU_KEYS = new Set(['enabled', 'appId', 'appSecret', 'botOpenId', 'credentialRef'])

/** The keys the GitHub loop (#71) understands. Watched repos FOLLOW the owner registry (repo owners' origins),
 *  so there is no config list — a stale `repos` key is rejected by strict validation below. */
const KNOWN_GITHUB_KEYS = new Set(['enabled', 'intervalMs', 'loginAllowlist', 'mentionHandle'])
const DEFAULT_GITHUB_INTERVAL_MS = 5 * 60 * 1000
const MIN_GITHUB_INTERVAL_MS = 30 * 1000

/** The keys the concurrency section (#72 执行槽) understands. Slots count working tickets per owner. */
const KNOWN_CONCURRENCY_KEYS = new Set(['slotsPerOwner'])
const DEFAULT_SLOTS_PER_OWNER = 3

/** The keys the security section (spec「Policy」危险命令黑名单) understands. */
const KNOWN_SECURITY_KEYS = new Set(['dangerousPatterns'])

/** The keys the workspaces section (#52 GUI 工作区归位) understands. */
const KNOWN_WORKSPACES_KEYS = new Set(['enabled', 'chiefPath', 'chiefTitle', 'chiefWorkspaceId'])
const DEFAULT_CHIEF_WORKSPACE_TITLE = 'Hub Bot 中枢'

/** The keys the chief section understands — the L1 总管's declared working model (面板「总管模型」). */
const KNOWN_CHIEF_KEYS = new Set(['model'])

/** Validates one chief.model value: null = follow the deployment default; otherwise {provider, model, reasoningEffort?}. */
export function validateChiefModel(value, path, ErrorCtor) {
  // cordis Config schema 会把缺省段回填为空对象——{} 视同 null（跟随部署默认）。
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new ErrorCtor(path + '.model must be null or an object {provider, model, reasoningEffort?}')
  const { provider, model, reasoningEffort } = value
  if (typeof provider !== 'string' || !provider.trim()) throw new ErrorCtor(path + '.model.provider must be a non-empty string')
  if (typeof model !== 'string' || !model.trim()) throw new ErrorCtor(path + '.model.model must be a non-empty string')
  if (reasoningEffort !== undefined && reasoningEffort !== null && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) {
    throw new ErrorCtor(path + '.model.reasoningEffort must be a non-empty string when present')
  }
  for (const key of Object.keys(value)) {
    if (!['provider', 'model', 'reasoningEffort'].includes(key)) throw new ErrorCtor(path + '.model does not know key "' + key + '"')
  }
  const out = { provider: provider.trim(), model: model.trim() }
  if (reasoningEffort !== undefined && reasoningEffort !== null) out.reasoningEffort = reasoningEffort.trim()
  return out
}

/** An invalid plugin configuration; the message names the offending key and the rule it broke. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Validates the raw cordis configuration object and returns the resolved configuration.
 * @param {unknown} config - raw configuration from the profile patch layer.
 * @returns {{ stateDir: string, homeRepo: string, devApi?: { token: string }, concurrency: { slotsPerOwner: number } }}
 *   resolved config; devApi absent = API disabled; concurrency always present (#72 执行槽, 默认 3).
 * @throws {ConfigError} when stateDir/homeRepo is missing or not absolute, unknown keys are present, or devApi lacks a token.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('hub-bot configuration must be an object')
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new ConfigError(`hub-bot does not know configuration key "${key}"`)
  }
  const { stateDir } = raw
  if (stateDir === undefined || stateDir === null || stateDir === '') {
    throw new ConfigError('hub-bot requires config.stateDir: an absolute path to its state directory')
  }
  if (typeof stateDir !== 'string') throw new ConfigError('hub-bot config.stateDir must be a string')
  if (!isAbsolute(stateDir)) throw new ConfigError(`hub-bot config.stateDir must be absolute, got "${stateDir}"`)
  // The chief owner (L1) is anchored at the Home Repo — the hub has no meaning without it (spec「L1 总负责人的落点」).
  const { homeRepo } = raw
  if (homeRepo === undefined || homeRepo === null || homeRepo === '') {
    throw new ConfigError('hub-bot requires config.homeRepo: an absolute path to the Home Repo (the chief owner cwd)')
  }
  if (typeof homeRepo !== 'string') throw new ConfigError('hub-bot config.homeRepo must be a string')
  if (!isAbsolute(homeRepo)) throw new ConfigError(`hub-bot config.homeRepo must be absolute, got "${homeRepo}"`)
  const resolved = { stateDir, homeRepo }

  if (raw.deferred !== undefined) {
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const config = raw.deferred
    if (!isObject(config) || Object.keys(config).some(key => !['ttlMs', 'ttlByAction'].includes(key))) {
      throw new ConfigError('hub-bot config.deferred must contain only ttlMs and ttlByAction')
    }
    const validDuration = value => Number.isSafeInteger(value) && value > 0
    if (config.ttlMs !== undefined && !validDuration(config.ttlMs)) {
      throw new ConfigError('hub-bot config.deferred.ttlMs must be a positive integer')
    }
    const byAction = config.ttlByAction
    if (byAction !== undefined && (!isObject(byAction) || Object.entries(byAction).some(
      ([type, ttl]) => !['fork', 'dangerous-inject', 'ask-user'].includes(type) || !validDuration(ttl),
    ))) {
      throw new ConfigError('hub-bot config.deferred.ttlByAction expects positive durations for fork, dangerous-inject, or ask-user')
    }
    resolved.deferred = config
  }
  // devApi 空对象 = 未配置（cordis Config schema 会把缺省段回填为 {}——视为没写，API 不启用）。
  if (raw.devApi !== undefined && !(typeof raw.devApi === 'object' && raw.devApi !== null && !Array.isArray(raw.devApi) && Object.keys(raw.devApi).length === 0)) {
    const devApi = raw.devApi
    if (typeof devApi !== 'object' || devApi === null || Array.isArray(devApi)) {
      throw new ConfigError('hub-bot config.devApi must be an object with a token')
    }
    for (const key of Object.keys(devApi)) {
      if (!KNOWN_DEV_API_KEYS.has(key)) throw new ConfigError(`hub-bot does not know config.devApi key "${key}"`)
    }
    // Enabling the management API without a token would let any local process inject into any Session — refuse.
    if (typeof devApi.token !== 'string' || !devApi.token) {
      throw new ConfigError('hub-bot config.devApi.token is required when devApi is configured: the management API can inject into any Session and must not run unauthenticated')
    }
    resolved.devApi = { token: devApi.token }
  }
  // 定时汇总自动汇报 (#67): OFF unless explicitly enabled; intervalMs only paces the tick.
  const reporting = { auto: false, intervalMs: 60000 }
  if (raw.reporting !== undefined) {
    const rawReporting = raw.reporting
    if (typeof rawReporting !== 'object' || rawReporting === null || Array.isArray(rawReporting)) {
      throw new ConfigError('hub-bot config.reporting must be an object { auto?: boolean, intervalMs?: number }')
    }
    for (const key of Object.keys(rawReporting)) {
      if (!KNOWN_REPORTING_KEYS.has(key)) throw new ConfigError("hub-bot does not know config.reporting key [\"" + key + "\"]")
    }
    if (rawReporting.auto !== undefined) {
      if (typeof rawReporting.auto !== 'boolean') throw new ConfigError('hub-bot config.reporting.auto must be a boolean')
      reporting.auto = rawReporting.auto
    }
    if (rawReporting.intervalMs !== undefined) {
      if (typeof rawReporting.intervalMs !== 'number' || !Number.isFinite(rawReporting.intervalMs) || rawReporting.intervalMs <= 0) {
        throw new ConfigError('hub-bot config.reporting.intervalMs must be a positive number')
      }
      reporting.intervalMs = rawReporting.intervalMs
    }
  }
  resolved.reporting = reporting
  // 飞书入口 (#68): OFF unless explicitly enabled; the allowlist is the ONLY authorization boundary (spec「安全」).
  const feishu = { enabled: false }
  if (raw.feishu !== undefined) {
    const rawFeishu = raw.feishu
    if (typeof rawFeishu !== 'object' || rawFeishu === null || Array.isArray(rawFeishu)) {
      throw new ConfigError('hub-bot config.feishu must be an object { enabled?, botOpenId?, credentialRef? }')
    }
    for (const key of Object.keys(rawFeishu)) {
      if (!KNOWN_FEISHU_KEYS.has(key)) throw new ConfigError('hub-bot does not know config.feishu key ["' + key + '"]')
    }
    if (rawFeishu.enabled !== undefined) {
      if (typeof rawFeishu.enabled !== 'boolean') throw new ConfigError('hub-bot config.feishu.enabled must be a boolean')
      feishu.enabled = rawFeishu.enabled
    }
    const legacyCredentialKeys = ['appId', 'appSecret'].filter(key => Object.hasOwn(rawFeishu, key))
    if (legacyCredentialKeys.length > 0) {
      throw new ConfigError(
        'hub-bot feishu 凭据迁移：请删掉 config.feishu.' + legacyCredentialKeys.join(' / config.feishu.') +
        '，将现有应用绑定存入宿主 credentials 的 grant，并用 config.feishu.credentialRef 指向它（默认 ' + DEFAULT_FEISHU_CREDENTIAL_REF + '）。',
      )
    }
    if (rawFeishu.credentialRef !== undefined) {
      if (!isFeishuCredentialRef(rawFeishu.credentialRef)) {
        throw new ConfigError('hub-bot config.feishu.credentialRef must be a hub-bot/<lowercase-id> credential record reference')
      }
      feishu.credentialRef = rawFeishu.credentialRef
    }
    if (rawFeishu.botOpenId !== undefined) {
      if (typeof rawFeishu.botOpenId !== 'string' || !rawFeishu.botOpenId) throw new ConfigError('hub-bot config.feishu.botOpenId must be a non-empty string')
      feishu.botOpenId = rawFeishu.botOpenId
    }
  }
  resolved.feishu = feishu
  // GitHub 自动处理闭环 (#71): OFF unless explicitly enabled; loginAllowlist 是唯一授权边界（默认空 = 启动时
  // 经 gh api user 解析为本人；解析失败则全部只记录）。repos 逐仓库开关默认全开（spec「逐仓库开关」）。
  const github = { enabled: false, intervalMs: DEFAULT_GITHUB_INTERVAL_MS, loginAllowlist: [] }
  if (raw.github !== undefined) {
    const rawGithub = raw.github
    if (typeof rawGithub !== 'object' || rawGithub === null || Array.isArray(rawGithub)) {
      throw new ConfigError('hub-bot config.github must be an object { enabled?, intervalMs?, loginAllowlist?, mentionHandle?, repos? }')
    }
    for (const key of Object.keys(rawGithub)) {
      if (!KNOWN_GITHUB_KEYS.has(key)) throw new ConfigError('hub-bot does not know config.github key ["' + key + '"]')
    }
    if (rawGithub.enabled !== undefined) {
      if (typeof rawGithub.enabled !== 'boolean') throw new ConfigError('hub-bot config.github.enabled must be a boolean')
      github.enabled = rawGithub.enabled
    }
    if (rawGithub.intervalMs !== undefined) {
      if (typeof rawGithub.intervalMs !== 'number' || !Number.isInteger(rawGithub.intervalMs) || rawGithub.intervalMs < MIN_GITHUB_INTERVAL_MS) {
        throw new ConfigError('hub-bot config.github.intervalMs must be an integer >= ' + MIN_GITHUB_INTERVAL_MS + ' (30s) — 认证限额 5000 次/小时')
      }
      github.intervalMs = rawGithub.intervalMs
    }
    if (rawGithub.loginAllowlist !== undefined) {
      if (!Array.isArray(rawGithub.loginAllowlist) || !rawGithub.loginAllowlist.every(v => typeof v === 'string' && v)) {
        throw new ConfigError('hub-bot config.github.loginAllowlist must be an array of non-empty login strings')
      }
      github.loginAllowlist = [...rawGithub.loginAllowlist]
    }
    if (rawGithub.mentionHandle !== undefined) {
      if (typeof rawGithub.mentionHandle !== 'string' || !rawGithub.mentionHandle.startsWith('@')) {
        throw new ConfigError('hub-bot config.github.mentionHandle must be an @handle string')
      }
      github.mentionHandle = rawGithub.mentionHandle
    }
  }
  resolved.github = github
  // 执行槽 (#72 并发语义): 同 owner 并发 working 任务上限（默认 3，规格「并发与人的优先」）；槽满新票进
  // queued 排队，人的跟进消息走专用槽不受新工作排队阻塞。执行槽只对 working 计数——交还给人（person/*）
  // 立即释放。
  const concurrency = { slotsPerOwner: DEFAULT_SLOTS_PER_OWNER }
  if (raw.concurrency !== undefined) {
    const rawConcurrency = raw.concurrency
    if (typeof rawConcurrency !== 'object' || rawConcurrency === null || Array.isArray(rawConcurrency)) {
      throw new ConfigError('hub-bot config.concurrency must be an object { slotsPerOwner?: number }')
    }
    for (const key of Object.keys(rawConcurrency)) {
      if (!KNOWN_CONCURRENCY_KEYS.has(key)) throw new ConfigError('hub-bot does not know config.concurrency key ["' + key + '"]')
    }
    if (rawConcurrency.slotsPerOwner !== undefined) {
      if (typeof rawConcurrency.slotsPerOwner !== 'number' || !Number.isSafeInteger(rawConcurrency.slotsPerOwner) || rawConcurrency.slotsPerOwner < 1) {
        throw new ConfigError('hub-bot config.concurrency.slotsPerOwner must be a positive integer (>= 1)')
      }
      concurrency.slotsPerOwner = rawConcurrency.slotsPerOwner
    }
  }
  resolved.concurrency = concurrency

  // 危险命令黑名单 (spec「Policy」L260 + #73 设置页): 默认清单在 src/security.js; 显式配置整表替换。
  const security = { dangerousPatterns: [...DEFAULT_DANGEROUS_PATTERNS] }
  if (raw.security !== undefined) {
    const rawSecurity = raw.security
    if (typeof rawSecurity !== 'object' || rawSecurity === null || Array.isArray(rawSecurity)) {
      throw new ConfigError('hub-bot config.security must be an object { dangerousPatterns?: string[] }')
    }
    for (const key of Object.keys(rawSecurity)) {
      if (!KNOWN_SECURITY_KEYS.has(key)) throw new ConfigError('hub-bot does not know config.security key ["' + key + '"]')
    }
    // 空数组 = cordis Config schema 的缺省回填，视同未配置（保留默认黑名单）——绝不允许 schema 把
    // 危险命令黑名单静默清空。显式配置非空表才是「整表替换」。
    if (rawSecurity.dangerousPatterns !== undefined && rawSecurity.dangerousPatterns.length > 0) {
      security.dangerousPatterns = validateDangerousPatterns(rawSecurity.dangerousPatterns, 'hub-bot config.security', ConfigError)
    }
  }
  resolved.security = security
  // chief 段 (#75 面板总管模型): L1 总管的干活模型; null = 跟随部署默认 (agent-default-model)。
  const chief = { model: null }
  const rawChief = raw.chief
  if (rawChief !== undefined) {
    if (typeof rawChief !== 'object' || rawChief === null || Array.isArray(rawChief)) throw new ConfigError('hub-bot config.chief must be an object')
    for (const key of Object.keys(rawChief)) {
      if (!KNOWN_CHIEF_KEYS.has(key)) throw new ConfigError('hub-bot does not know config.chief key ["' + key + '"]')
    }
    if (rawChief.model !== undefined) chief.model = validateChiefModel(rawChief.model, 'hub-bot config.chief', ConfigError)
  }
  resolved.chief = chief
  // 工作区归位 (#52): chief 专属工作区的落点。chiefPath 为空 → 默认 homeRepo/.hub-bot/chief；
  // 用户可指定任意绝对路径作「公共工作区」。警告：路径在 homeRepo 树外时 AGENTS.md 向上查找失效，
  // chief 会话将失去仓库指令上下文（设置界面需注明）。
  const workspaces = { enabled: true, chiefPath: null, chiefTitle: DEFAULT_CHIEF_WORKSPACE_TITLE, chiefWorkspaceId: null }
  if (raw.workspaces !== undefined) {
    const rawWs = raw.workspaces
    if (typeof rawWs !== 'object' || rawWs === null || Array.isArray(rawWs)) {
      throw new ConfigError('hub-bot config.workspaces must be an object { enabled?, chiefPath?, chiefTitle? }')
    }
    for (const key of Object.keys(rawWs)) {
      if (!KNOWN_WORKSPACES_KEYS.has(key)) throw new ConfigError('hub-bot does not know config.workspaces key ["' + key + '"]')
    }
    if (rawWs.enabled !== undefined) {
      if (typeof rawWs.enabled !== 'boolean') throw new ConfigError('hub-bot config.workspaces.enabled must be a boolean')
      workspaces.enabled = rawWs.enabled
    }
    if (rawWs.chiefPath !== undefined && rawWs.chiefPath !== null && rawWs.chiefPath !== '') {
      if (typeof rawWs.chiefPath !== 'string') throw new ConfigError('hub-bot config.workspaces.chiefPath must be a string')
      if (!isAbsolute(rawWs.chiefPath)) throw new ConfigError('hub-bot config.workspaces.chiefPath must be absolute, got "' + rawWs.chiefPath + '"')
      workspaces.chiefPath = rawWs.chiefPath
    }
    // 关联式归位（turn 108）: 用户在 DSH 里自己建好公共工作区，hub-bot 按 id 关联——不再手填路径。
    // chiefWorkspaceId 优先于 chiefPath；两者皆空 → 自动创建 homeRepo/.hub-bot/chief。
    if (rawWs.chiefWorkspaceId !== undefined && rawWs.chiefWorkspaceId !== null && rawWs.chiefWorkspaceId !== '') {
      if (typeof rawWs.chiefWorkspaceId !== 'string') throw new ConfigError('hub-bot config.workspaces.chiefWorkspaceId must be a string')
      workspaces.chiefWorkspaceId = rawWs.chiefWorkspaceId.trim()
    }
    if (rawWs.chiefTitle !== undefined) {
      if (typeof rawWs.chiefTitle !== 'string' || !rawWs.chiefTitle.trim()) throw new ConfigError('hub-bot config.workspaces.chiefTitle must be a non-empty string')
      workspaces.chiefTitle = rawWs.chiefTitle.trim()
    }
  }
  resolved.workspaces = workspaces
  return resolved
}
