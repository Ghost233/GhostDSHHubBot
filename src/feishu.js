/**
 * FeishuSource — the Feishu entry (issue #68, spec「飞书接入」).
 *
 * 扫码一键建应用: register() drives @larksuiteoapi/node-sdk's lark.registerApp() (OAuth 2.0 Device
 * Authorization Grant, RFC 8628): the QR url surfaces via status()/devApi for the panel; once the user
 * confirms on the phone, the application binding is saved in DSH credentials before the long connection
 * starts. The event-subscription MODE (long-connection vs webhook) is a sensitive setting addons cannot
 * carry, so after credentials land the plugin calls the application-config patch OpenAPI once and reports the
 * truthful outcome as status().eventMode: 'configured' only when that API actually answers code 0; a denied
 * (nonzero) response or a thrown error surfaces 'manual' so the panel tells the user to set 长连接 in the
 * developer console once (the WSClient simply receives nothing until it is set by hand).
 *
 * 扫码状态诚实: status().registration is pending while a scan is outstanding, expired once the QR's own
 * expireIn has elapsed (the QR is then withheld — 过期二维码不再展示), and failed only for a real failure.
 * Registration attempts are scoped: a superseded/expired/cancelled attempt can never write its QR or its
 * credentials over the current attempt, and a failed rebind keeps the previous binding (凭据只在宿主记录
 * 确认写入之后才出现).
 *
 * 消息通道 (S06 单一入口): WSClient im.message.receive_v1 events normalize into ONE immutable Trigger
 * (id feishu-<messageId>, dedup on replay — 重启不重放) and, when the optional router port is present, hand it
 * to router.acceptFeishuTrigger(). On that path the Router is the SOLE trigger-row writer and the SOLE prompt
 * caller — this class never inserts a trigger row, never prompts a session and never stamps injectedAt (no
 * fake acceptance, no second write path, no duplicate trigger insert). Without the port (older mounts / unit
 * tests) the legacy path below still normalizes → records → injects the L1 chief Session with a plugin-owned
 * source mark ([hub-bot 飞书 <chatId>/<messageId>]) so channel input is distinguishable from hand-typed input
 * (task-1 遗留). Policy stays in code on both paths: the bot's own messages are dropped; 授权边界在飞书侧
 * （应用可用范围由开放平台管理后台配置），能与 bot 说话即已授权，插件不做二次过滤; group messages count
 * only when they @ THIS bot's configured real botOpenId — a mention we cannot verify (botOpenId missing)
 * is dropped with 'unknown-bot-id' instead of being admitted on `mentions.length > 0`; non-text gets the
 * recorded reply 暂不支持该消息类型. Every dropped event still lands as a recorded Trigger carrying the
 * truthful reason, so the record can say exactly what happened (只记录不处理).
 *
 * 回复回投: L1's reply_source to 'feishu:chat:<chatId>' rows sit recorded in the outbox (阶段 2 P1-2 的
 * 诚实意图); deliverReplies() — driven by the plugin's 1s tick — actually sends them via im.message.create
 * and only then marks them sent. Failures keep the row recorded with feishuAttempts++; five consecutive
 * failures fail the row and report a system problem (same discipline as the OutboxRunner).
 */
import { createHash } from 'node:crypto'
import { deliverRecordedReplies } from './outbox.js'
import { CredentialsError, MISSING, UNAVAILABLE, createFeishuCredentialsPort } from './feishu-credentials.js'

export { FEISHU_SOURCE_MARK, UNSUPPORTED_MESSAGE_TYPE } from './inbox.js'

/** The bot identity created by the one-scan registration (createOnly preset). */
export const BOT_PRESET = { name: 'DSH 中枢 Bot', desc: 'DSH 会话远程触发与状态查询' }

/**
 * The exact permissions the registration requests (一次性全部申请) — shown verbatim on the panel so the user
 * knows what they are granting BEFORE scanning (用户决策 2026-11-16: 权限申明要写明).
 */
export const DECLARED_PERMISSIONS = [
  { key: 'im:message:send_as_bot', label: '以 bot 身份发消息（回复你的请求）' },
  { key: 'im:message', label: '读取消息内容（理解你发来的请求）' },
  { key: 'im:chat:readonly', label: '读取会话基本信息（识别私聊/群聊与回投地址）' },
  { key: 'im.message.receive_v1', label: '订阅「收到消息」事件（长连接实时推送，无需轮询）' },
]

function feishuErrorText(error, ...secrets) {
  let text = String(error?.message ?? error)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
  return text
}

/** Consecutive feishu send failures before a recorded intent fails out and reports a system problem. */
const MAX_FEISHU_ATTEMPTS = 5

export class FeishuSource {
  /**
   * @param {{ store: import('./store.js').Store, router?: import('./router.js').Router, config: object,
   *   logger: { info: Function, warn: Function }, lark?: object, now?: () => string, credentials?: object }} deps
   */
  constructor({ store, router, config, logger, lark, now, credentials }) {
    this.store = store
    this.router = router
    this.config = config ?? {}
    this.logger = logger
    this.lark = lark ?? null
    this.now = now ?? (() => new Date().toISOString())
    this.lastQr = null
    this.credentialState = 'missing'
    this.wsState = 'off'
    // 连接质量指标（kv 持久化，重启不丢）: 重连计数 / 最近连接 / 最近错误——面板「连接质量」行的数据源。
    this.wsMetrics = this.store.get('feishu.wsMetrics') ?? { reconnects: 0, lastConnectedAt: null, lastErrorAt: null, lastError: null }
    this.client = null
    this.ws = null
    this.connectionAttempt = null
    this.registrationAttempt = null
    this.registrationError = null
    this.credentials = null
    this.credentialError = null
    this.credentialsPort = createFeishuCredentialsPort(credentials, this.config.credentialRef)
    this.credentialsReady = this.#loadCredentials()
  }

  /** Lazily loads the real SDK so the plugin starts (and unit-tests) without the dependency installed. */
  async #sdk() {
    if (this.lark) return this.lark
    this.lark = await import('@larksuiteoapi/node-sdk')
    return this.lark
  }

  async #loadCredentials() {
    try {
      this.credentials = (await this.credentialsPort.read()) ?? null
      this.credentialState = this.credentials ? 'ok' : 'missing'
    } catch (error) {
      this.credentialState = 'invalid'
      this.credentialError = error instanceof CredentialsError ? error.reason : UNAVAILABLE
    }
  }

  /** Expose a new binding only after the host confirms its persistent record. */
  async saveCredentials({ appId, appSecret }, signal) {
    await this.credentialsReady
    const saved = await this.credentialsPort.write({ appId, appSecret, boundAt: this.now() }, signal)
    this.credentials = saved
    this.credentialState = 'ok'
    this.credentialError = null
    this.client = null
  }

  #saveWsMetrics() {
    try { this.store.set('feishu.wsMetrics', this.wsMetrics) } catch { /* 指标丢了不致命 */ }
  }

  /**
   * The panel-facing bot-management view: one bot only (唯一总 bot). credentialState drives the three states —
   * missing (预告将创建的 bot + 权限清单 + 二维码), ok (bot 名片 + 连接, 二维码收起), invalid (提示重新扫码).
   */
  status() {
    const bound = this.credentialState === 'ok' && this.credentials
    const appId = bound ? this.credentials.appId : null
    const enabled = this.config.enabled === true
    const registering = this.registering
    const wsState = enabled ? this.ws?.getConnectionStatus?.().state ?? this.wsState : 'off'
    return {
      enabled,
      credentialState: this.credentialState,
      // 「记录坏了」与「还没有记录」要能分开说清（前者提示重新扫码，后者提示去绑定）——只给稳定标签，
      // 不带任何密钥，也不带端口抛出的原始报错文本。
      credentialReason: this.credentialState === 'ok'
        ? undefined
        : this.credentialState === 'invalid' ? this.credentialError ?? UNAVAILABLE : MISSING,
      wsState,
      registration: enabled ? (registering ? 'pending' : this.registrationExpired ? 'expired' : this.registrationError ? 'failed' : undefined) : undefined,
      registrationError: enabled ? this.registrationError ?? undefined : undefined,
      qr: enabled && registering ? this.lastQr ?? undefined : undefined,
      eventMode: enabled ? this.eventMode : undefined,
      preset: BOT_PRESET,
      permissions: DECLARED_PERMISSIONS,
      bot: bound ? {
        name: BOT_PRESET.name,
        appIdMasked: typeof appId === 'string' && appId.length > 10 ? appId.slice(0, 7) + '…' + appId.slice(-4) : appId,
        boundAt: this.credentials.boundAt ?? null,
        connected: wsState === 'connected',
      } : undefined,
      botOpenId: this.config.botOpenId ?? undefined,
      metrics: { ...this.wsMetrics },
    }
  }

  /**
   * The scan-to-create flow (spec: registerApp 一键创建). Resolves once the user confirms; the QR link is
   * visible via status().qr while pending. Permission addon principle: 一次性全部申请 (im:message:send_as_bot,
   * im:message, im:chat:readonly + im.message.receive_v1).
   */
  get registering() {
    this.#expireRegistration(this.registrationAttempt)
    return this.registrationAttempt !== null
  }

  #clearRegistrationQr(registration) {
    clearTimeout(registration.expiryTimer)
    registration.expiresAt = undefined
    this.lastQr = null
  }

  #expireRegistration(registration) {
    if (!registration || this.registrationAttempt !== registration || registration.expiresAt === undefined
      || Date.parse(this.now()) < registration.expiresAt) return
    registration.expired = true
    this.registrationExpired = true
    this.registrationAttempt = null
    this.#clearRegistrationQr(registration)
    registration.abort()
  }

  async register() {
    if (this.config.enabled !== true) throw new Error('Enable Feishu before registering a bot')
    if (this.registering) return { started: false, registration: 'pending' }
    const registration = new AbortController()
    const { signal } = registration
    this.registrationAttempt = registration
    this.registrationError = null
    this.registrationExpired = false
    let previousSecret
    let issuedSecret
    let awaitingGrant = true
    try {
      this.credentialsPort.requireService()
      await this.credentialsReady
      signal.throwIfAborted()
      previousSecret = this.credentials?.appSecret
      const lark = await this.#sdk()
      signal.throwIfAborted()
      const result = await lark.registerApp({
        signal,
        createOnly: true,
        appPreset: { name: BOT_PRESET.name, desc: BOT_PRESET.desc },
        addons: {
          preset: true,
          scopes: { tenant: ['im:message:send_as_bot', 'im:message', 'im:chat:readonly'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
        },
        onQRCodeReady: ({ url, expireIn }) => {
          this.#expireRegistration(registration)
          if (!awaitingGrant || this.registrationAttempt !== registration || signal.aborted) return
          clearTimeout(registration.expiryTimer)
          const lifetime = Number.isFinite(expireIn) && expireIn > 0 ? Math.min(expireIn, 2_147_483) : 3600
          registration.expiresAt = Date.parse(this.now()) + lifetime * 1000
          this.lastQr = { url, expireIn: lifetime }
          registration.expiryTimer = setTimeout(() => this.#expireRegistration(registration), lifetime * 1000)
          registration.expiryTimer.unref()
        },
      })
      this.#expireRegistration(registration)
      signal.throwIfAborted()
      awaitingGrant = false
      this.#clearRegistrationQr(registration)
      issuedSecret = result.client_secret
      await this.saveCredentials({ appId: result.client_id, appSecret: issuedSecret }, signal)
      signal.throwIfAborted()
      // A transport failure after persistence must leave the saved binding visible.
      this.eventMode = undefined
      this.#closeSocket()
      const eventMode = await this.#configureEventMode()
      signal.throwIfAborted()
      this.eventMode = eventMode
      try { await this.connect() } catch { /* connect() records the transport failure */ }
      signal.throwIfAborted()
      return { appId: result.client_id }
    } catch (error) {
      if (registration.expired) return { expired: true }
      if (signal.aborted) return { cancelled: true }
      this.registrationError = feishuErrorText(error, previousSecret, issuedSecret).slice(0, 300)
      if (error instanceof CredentialsError) throw error
      throw new Error(this.registrationError)
    } finally {
      if (this.registrationAttempt === registration) {
        this.registrationAttempt = null
        this.#clearRegistrationQr(registration)
      }
    }

  }

  async #configureEventMode() {
    try {
      const client = await this.#client()
      const result = await client.request({
        method: 'PATCH',
        url: 'https://open.feishu.cn/open-apis/application/v7/application-config',
        data: { event_subscription: { mode: 'long_connection' } },
      })
      if (result?.code === 0) {
        this.logger.info('hub-bot feishu: event-subscription mode set to long_connection')
        return 'configured'
      }
    } catch { /* Some Feishu tenants require manual configuration. */ }
    this.logger.warn('hub-bot feishu: configure long-connection event subscription in the Feishu developer console')
    return 'manual'
  }

  /** The authenticated REST client (created once credentials exist). */
  async #client() {
    await this.credentialsReady
    if (this.client) return this.client
    const lark = await this.#sdk()
    // A pre-built client wins (tests, or a caller that already constructed one) — no credentials needed then.
    const prebuilt = this.config.client ?? lark.client ?? null
    if (prebuilt) { this.client = prebuilt; return this.client }
    if (!this.credentials) throw new Error('hub-bot feishu: no credentials — run register() first')
    try {
      this.client = new lark.Client({ appId: this.credentials.appId, appSecret: this.credentials.appSecret })
    } catch (error) {
      throw new Error(feishuErrorText(error, this.credentials.appSecret))
    }
    return this.client
  }

  #recordWsError(error) {
    const message = feishuErrorText(error, this.credentials?.appSecret)
    this.wsState = 'failed'
    this.wsMetrics.lastErrorAt = this.now()
    this.wsMetrics.lastError = message.slice(0, 200)
    this.#saveWsMetrics()
    if (/401|99991663|99991664|invalid.*credential|app.*ticket/i.test(message)) this.credentialState = 'invalid'
    this.logger.warn('hub-bot feishu: ws error: %s', message)
    return message
  }

  /** Starts one long connection. The SDK reports actual readiness through its callbacks. */
  async connect() {
    if (this.config.enabled !== true) return { started: false, reason: 'disabled' }
    if (this.connectionAttempt) return { started: false, reason: 'already-connected' }
    const attempt = {}
    this.connectionAttempt = attempt
    this.wsState = 'connecting'
    const current = () => this.connectionAttempt === attempt && this.config.enabled === true
    try {
      await this.credentialsReady
      if (!current()) return { started: false, reason: 'superseded' }
      if (!this.credentials) throw new Error('hub-bot feishu: no credentials — check the DSH credential reference')
      const { WSClient, EventDispatcher } = await this.#sdk()
      if (!current()) return { started: false, reason: 'superseded' }
      if (typeof WSClient !== 'function' || typeof EventDispatcher !== 'function') {
        throw new Error('hub-bot feishu: the SDK does not provide a long connection client')
      }
      const ready = reconnect => {
        if (!current()) return
        this.wsState = 'connected'
        this.wsMetrics.lastConnectedAt = this.now()
        if (reconnect) this.wsMetrics.reconnects += 1
        this.#saveWsMetrics()
      }
      const socket = new WSClient({
        appId: this.credentials.appId, appSecret: this.credentials.appSecret,
        onReady: () => ready(false),
        onReconnecting: () => { if (current()) this.wsState = 'reconnecting' },
        onReconnected: () => ready(true),
        onError: error => { if (current()) this.#recordWsError(error) },
      })
      this.ws = socket
      const dispatcher = new EventDispatcher({}).register({
        'im.message.receive_v1': async data => {
          if (!current()) return
          this.logger.info('hub-bot feishu: event received message_id=%s chat_type=%s', data?.message?.message_id, data?.message?.chat_type)
          try {
            await this.handleEvent(data)
          } catch (error) {
            const detail = error?.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode)
              ? ` (SQLite ${error.errcode})`
              : ''
            const message = 'hub-bot feishu: event handling failed' + detail
            this.logger.warn(message)
            // The SDK logs this error and sends a failure ACK when the handler rejects.
            throw new Error(message)
          }
        },
      })
      await socket.start({ eventDispatcher: dispatcher })
      return current() ? { started: true } : { started: false, reason: 'superseded' }
    } catch (error) {
      if (!current()) return { started: false, reason: 'superseded' }
      this.#closeSocket()
      throw new Error(this.#recordWsError(error))
    }
  }

  #closeSocket() {
    this.connectionAttempt = null
    const socket = this.ws
    this.ws = null
    this.wsState = 'off'
    try { socket?.close?.({ force: true }) } catch { this.logger.warn('hub-bot feishu: could not close socket') }
  }

  /** Pausing preserves saved credentials and cancels outstanding registration and socket work. */
  disconnect() {
    const registration = this.registrationAttempt
    this.registrationAttempt = null
    if (registration) {
      this.#clearRegistrationQr(registration)
      registration.abort()
    }
    this.registrationExpired = false
    this.registrationError = null
    this.#closeSocket()
  }

  /**
   * One normalized inbound message:
   * { messageId, chatId, chatType, openId, msgType, text, addressing, mentionReason }.
   * addressing: 'direct' (p2p) | 'mention' (group @ THIS bot) | null (not addressed to us).
   * mentionReason: null when addressed, else the truthful drop reason — 'unknown-bot-id' when the group
   * message @s someone but we cannot verify it is this bot (botOpenId missing / no mention matches it),
   * 'no-mention' when there is no mention at all.
   *
   * 群聊 @bot 判定只认配置里那个真实的 botOpenId: 旧实现 (mentions.length > 0) 会把「@了别人」当成 @bot，
   * 等于让任何人都能凭一次任意 @ 触发 chief。认不出来的 @ 一律不认领，并留下明确原因。
   */
  normalize(raw) {
    const message = raw?.message ?? {}
    const sender = raw?.sender ?? {}
    const openId = sender.sender_id?.open_id
    const chatType = message.chat_type === 'group' ? 'group' : 'p2p'
    const mentions = Array.isArray(message.mentions) ? message.mentions : []
    let text = null
    if (message.message_type === 'text') {
      try {
        const parsed = JSON.parse(message.content ?? '{}')
        text = typeof parsed.text === 'string' ? parsed.text : ''
        // Mention placeholders (@_user_1) are stripped — the reading is the plain instruction text.
        for (const m of mentions) if (m?.key) text = text.split(m.key).join('')
        text = text.trim()
      } catch { text = null }
    }
    const botOpenId = this.config.botOpenId
    const knownBotId = typeof botOpenId === 'string' && botOpenId.length > 0
    // 认领条件：mention 的 open_id 与配置的真实 botOpenId 逐字相等。没有配置就当「认不出来」，绝不猜。
    const mentioned = knownBotId && mentions.some(m => m?.id?.open_id === botOpenId)
    const addressing = chatType === 'p2p' ? 'direct' : (mentioned ? 'mention' : null)
    // 无 mention → 谁也没 @；有 mention 却认不出是哪个 bot（botOpenId 未配置或都不匹配）→ 'unknown-bot-id'。
    const mentionReason = addressing !== null ? null : (mentions.length > 0 ? 'unknown-bot-id' : 'no-mention')
    return {
      messageId: message.message_id, chatId: message.chat_id, chatType, privateChat: message.chat_type === 'p2p',
      openId, senderType: sender.sender_type, msgType: message.message_type, text, addressing, mentionReason,
    }
  }

  /** The Trigger row id doubles as the dedup key: feishu-<messageId>. */
  #triggerId(messageId) {
    return 'feishu-' + messageId
  }

  /** Normalize the verified channel input before passing it to the durable router. */
  async handleEvent(raw) {
    const msg = this.normalize(raw)
    if (typeof msg.messageId !== 'string' || !msg.messageId || typeof msg.chatId !== 'string' || !msg.chatId) {
      return { dropped: 'malformed' }
    }
    return this.#acceptViaRouter(msg)
  }

  /**
   * S06 单一入口 (router port present): build the ORIGINAL immutable trigger and hand it over. The Router is
   * the only trigger-row writer, the only session prompter and the only injectedAt stamper on this path —
   * this class asserts no acceptance of its own (no fake injected:true, no second write path).
   */
  async #acceptViaRouter(msg) {
    const at = this.now()
    const triggerId = this.#triggerId(msg.messageId)
    // 策略在代码里: bot 自己 / 群聊没 @ 到本 bot（含认不出的 @）/ 非文本 —— 记下来，但不成为任务。
    let dropReason = null
    if (msg.senderType !== 'user') dropReason = 'bot-self'
    else if (msg.addressing === null) dropReason = msg.mentionReason ?? 'no-mention'
    else if (msg.msgType !== 'text' || !msg.text) dropReason = 'unsupported-type'
    const trigger = {
      id: triggerId, kind: 'feishu', message: msg.text ?? '(non-text ' + msg.msgType + ')', at,
      source: { kind: 'feishu', chatId: msg.chatId, messageId: msg.messageId, openId: msg.openId, addressing: msg.addressing ?? 'none' },
      policy: { addressing: msg.addressing ?? 'none', chatType: msg.chatType, privateChat: msg.privateChat, msgType: msg.msgType, allowed: dropReason === null, reason: dropReason },
    }
    if (dropReason === null) {
      trigger.authorization = { actor: msg.openId, source: 'feishu', addressing: msg.addressing, messageId: msg.messageId, at }
    } else {
      trigger.dropped = dropReason
      if (dropReason === 'unsupported-type') trigger.msgType = msg.msgType
    }
    const result = await this.router.acceptFeishuTrigger(trigger)
    return {
      injected: result?.admitted === true,
      triggerId: result?.triggerId ?? triggerId,
      requestId: result?.requestId ?? ('hub-bot-feishu-' + msg.messageId),
      deduped: result?.deduped === true,
      queued: result?.queued === true,
      dropped: result?.dropped ?? dropReason,
      outboxId: result?.outboxId ?? null,
    }
  }



  /**
   * The recorded-reply channel (阶段 2 P1-2 留的通道): scans outbox rows with state 'recorded' addressed at
   * 'feishu:…' and actually sends them; only a real delivery earns state 'sent'. Five consecutive failures
   * fail the row and report a system problem (OutboxRunner discipline).
   */
  async deliverReplies() {
    // 双轴审查 P1-2: 通道无关驱动在 outbox.js（顺序扫描/统一 attempts/失败阶梯一处维护）；这里只留通道差异。
    await this.credentialsReady
    if (this.config.enabled !== true || this.store.closed) return { delivered: 0 }
    const credentials = this.credentials
    const client = await this.#client()
    return deliverRecordedReplies({
      store: this.store, logger: this.logger, now: this.now,
      channel: 'feishu', prefix: 'feishu:', maxAttempts: MAX_FEISHU_ATTEMPTS,
      canContinue: () => !this.store.closed && this.config.enabled === true && this.credentials === credentials,
      parseTarget: to => to.startsWith('feishu:chat:') ? to.slice('feishu:chat:'.length) : to.slice('feishu:'.length),
      send: async (chatId, body, row) => {
        try {
          // Use the persisted row ID across remounts. Feishu controls the deduplication window.
          const uuid = createHash('sha256').update('hub-bot:feishu:' + row.id).digest('hex').slice(0, 50)
          const resp = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: body }), uuid },
          })
          if (resp && typeof resp.code === 'number' && resp.code !== 0) throw new Error('feishu api code ' + resp.code + ': ' + (resp.msg ?? ''))
        } catch (error) {
          throw new Error(feishuErrorText(error, credentials?.appSecret))
        }
      },
    })
  }
}
