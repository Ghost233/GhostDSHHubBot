/**
 * hub-bot 设置的 Remote 服务：DSH GUI 的 client 半侧（client/）通过 ctx.remote.hubBotSettings
 * 读写运行时设置。read/update 直接委托 index.js 的 settingsView/applySettings 闭包——
 * 与面板的 HTTP API 是同一条路径（同一份 overlay、同一套校验、同一批 live 副作用），
 * 两个入口永远一致。
 *
 * 纯 JS 没有装饰器语法：Remote 方法用 markRemote 手动标记——等价于官方 TS 包的 @Remote()，
 * 走同一个 addMarkerInitializer → prototype 标记通路，Gateway 的 source-mode 发现照常工作。
 */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Manually applies the @Remote marker to one prototype method (decorator-desugared form for plain JS).
 * The decorator's initializer marks the method on the instance's prototype; we run that initializer
 * against a throwaway object whose prototype is cls.prototype — no construction of the real service.
 */
function markRemote(cls, methodName, options) {
  const context = {
    kind: 'method',
    name: methodName,
    static: false,
    private: false,
    addInitializer(fn) { fn.call(Object.create(cls.prototype)) },
  }
  // 无选项时走 Remote 的裸调用形式（等价于无参 @Remote）；带选项才用装饰器柯里化形式——
  // Remote({}) 空对象会被 markerOptions 拒绝（至少要有 name/mode/resources 之一）。
  if (options && Object.keys(options).length > 0) Remote(options)(null, context)
  else Remote(undefined, context)
}

export class HubBotSettingsService extends TypertRemoteService {
  /**
   * @param {import('cordis').Context} ctx
   * @param {{ settingsView: () => Promise<object>, applySettings: (patch: object) => Promise<object>, listOwners: () => object[] | Promise<object[]>, modelCatalog: () => Promise<object>, overview: () => Promise<object>, resolveTicket: (req: { ticketId: string, resolution: string, message?: string }) => Promise<object> }} deps
   */
  constructor(ctx, deps) {
    super(ctx, 'hubBotSettings')
    this.deps = deps
  }

  /** Current settings view: effective config (profile ⊕ overlay) plus live source status. */
  async read() {
    return await this.deps.settingsView()
  }

  /** Applies one settings patch; validation failures reject (message carries the offending key). */
  async update(patch) {
    try {
      return await this.deps.applySettings(patch)
    } catch (error) {
      if (error?.name === 'SettingsError' || error?.statusCode === 400) {
        throw new RemoteError('settings/invalid', error.message ?? 'invalid settings patch')
      }
      throw error
    }
  }

  /** Owner registry rows projected for the GUI panel (read-only, plain JSON). */
  async listOwners() {
    const rows = await this.deps.listOwners()
    // 会话工作区反查（turn 109）: owner.sessionId ∈ ws.sessionIds → 该会话落在哪个 DSH 工作区——
    // 面板「工作区」列让「这个负责人的会话在哪」一眼可查。registry 缺席（老 DSH）→ 列留空。
    let sessionToWorkspace = new Map()
    try {
      const wsList = (await this.deps.listWorkspaces?.()) ?? []
      for (const ws of wsList) {
        for (const sid of ws.sessionIds ?? []) {
          if (!sessionToWorkspace.has(sid)) sessionToWorkspace.set(sid, { workspaceId: ws.workspaceId ?? null, title: ws.title ?? null })
        }
      }
    } catch { /* 反查失败不阻塞列表 */ }
    return rows.map(row => ({
      id: row.id,
      role: row.role ?? null,
      kind: row.kind ?? null,
      workspace: row.workspace ?? null,
      cwd: row.cwd ?? null,
      sessionId: row.sessionId ?? null,
      status: row.status ?? null,
      createdAt: row.createdAt ?? null,
      dshWorkspace: (row.sessionId && sessionToWorkspace.get(row.sessionId)) ?? null,
    }))
  }

  /** Model catalog passthrough for the chief-model picker (read-only). Plain-JSON'd: the catalog carries
   *  DSH internal shapes (class instances etc.) that the typert wire encoder can choke on after a hot reload —
   *  surfacing as an opaque gateway/internal on the client while the same object serves fine over HTTP (#53). */
  /** DSH 工作区枚举（关联式归位的选择器数据）: 只读投影，列不出时给空数组（选择器降级为「自动」）。 */
  async listWorkspaces() {
    const rows = await this.deps.listWorkspaces()
    return (rows ?? []).map(w => ({ workspaceId: w.workspaceId ?? null, title: w.title ?? null, path: w.path ?? null }))
  }

  async modelCatalog() {
    const value = await this.deps.modelCatalog()
    return value === undefined ? null : JSON.parse(JSON.stringify(value))
  }

  /** Ticket board overview (three-questions view) — same builder as the HTTP panel API. */
  async overview() {
    return await this.deps.overview()
  }

  /** Start the feishu scan-to-bind device flow (idempotent: a pending registration is not restarted). */
  async startFeishuRegister() {
    try {
      return await this.deps.startFeishuRegister()
    } catch (error) {
      if (error?.name === 'SettingsError' || error?.statusCode === 400) {
        throw new RemoteError('feishu/unavailable', error.message ?? 'feishu register unavailable')
      }
      throw error
    }
  }

  /** One-click confirm/reject on a person/confirm ticket — same state-machine path as route_to_owner. */
  async resolveTicket(request) {
    try {
      return await this.deps.resolveTicket(request ?? {})
    } catch (error) {
      if (error?.name === 'SettingsError' || error?.statusCode === 400 || error?.statusCode === 404 || error?.name === 'RouterError') {
        throw new RemoteError('ticket/invalid', error.message ?? 'invalid ticket resolution')
      }
      throw error
    }
  }
}

markRemote(HubBotSettingsService, 'read', {})
markRemote(HubBotSettingsService, 'update', {})
markRemote(HubBotSettingsService, 'listOwners', {})
markRemote(HubBotSettingsService, 'modelCatalog', {})
markRemote(HubBotSettingsService, 'listWorkspaces', {})
markRemote(HubBotSettingsService, 'overview', {})
markRemote(HubBotSettingsService, 'resolveTicket', {})
markRemote(HubBotSettingsService, 'startFeishuRegister', {})
