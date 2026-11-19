// hub-bot 的 client 半侧：在插件管理器里给「dsh-hub-bot → hub-bot 行」的配置按钮提供表单页。
// 数据通路：ctx.remote.hubBotSettings.read()/update(patch)（host 侧 Remote 服务，与 HTTP 面板同核心）。
// 手写 __ModuleLoader__ 格式（与官方 client 包的构建产物同构）；只用 react + zod（共享模块），保持零构建。
//
// Remote 接入（v0.1.6 修正）：
// - exports.inject 是 cordis 服务 key（['slots','locale','remote']），不是包名——包级加载拓扑在 package.json 的 dsh.client.inject 声明。
//   （v0.1.4 把包名写进 exports.inject，fiber 永远等不到同名服务，插件永久 pending 的教训。）
// - 自有 Remote namespace 必须客户端 $mount：dsh-api-remotes 只预挂载官方静态清单，
//   插件自己的命名空间要靠 ctx.remote.$mount(contribution)（dsh-cua 的模式）。
//   contribution 是 RemoteInfo（下方内联类与官方 codegen 产物同构，来自 dsh-cua client.js）。
window.__ModuleLoader__.load({
  id: 'dsh-hub-bot',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var zodLib = require('zod');
    var h = React.createElement;

    // === typert RemoteInfo（内联自 @deepseek-ai/dsh-cua 的 codegen 产物，自包含） ===
function createTypertRemoteInfo(spec,zod){return new RemoteInfo(spec,zod)}var RemoteInfo=class{spec;zod;index;constructor(spec,zod){this.spec=spec;this.zod=zod}get package(){return this.spec.package}get descriptors(){return this.resolve().descriptors}get methods(){return this.resolve().methods}resolve(){if(this.index!==void 0)return this.index;const zod=this.zod;const descriptors=[];const methods=Object.create(null);for(const[endpoint,definition]of Object.entries(this.spec.methods)){const separator=endpoint.indexOf(`/`);const namespace=endpoint.slice(0,separator);const method=endpoint.slice(separator+1);const parameters=definition.parameters.map(parameter=>({...parameter,wire:parameter.wire??parameter.name}));const descriptor={...definition,id:`${this.spec.package}#${endpoint}`,namespace,method,parameters,result:definition.result.description===void 0?definition.result:new ResultValue(definition.result)};if(definition.invocation.kind===`direct`){const inputs=[];methods[endpoint]=Object.assign(descriptor,{input(options){const strict=options?.strict===true;return inputs[strict?1:0]??=new NamedInput(parameters,strict,zod)},invoke(remote,input,signal){const named=input;const values=parameters.map(parameter=>named[parameter.wire]);if(definition.cancellation!==void 0)values.push(signal);const receiver=Reflect.get(remote,namespace);return Reflect.get(receiver,method).apply(receiver,values)}})}descriptors.push(descriptor)}return this.index={descriptors,methods}}};function optional(parameter){return parameter.source===`json`&&parameter.acceptsUndefined===true}var NamedInput=class{parameters;strict;zod;schema;projection;constructor(parameters,strict,zod){this.parameters=parameters;this.strict=strict;this.zod=zod}codec(parameter){return this.strict?parameter.strictCodec:parameter.codec}create=()=>this.schema??=this.zod.strictObject(Object.fromEntries(this.parameters.map(parameter=>{const value=this.codec(parameter).create();return[parameter.wire,optional(parameter)?value.optional():value.nonoptional()]})));get jsonSchema(){return this.project().jsonSchema}get jsonSchemaError(){return this.project().jsonSchemaError}project(){if(this.projection!==void 0)return this.projection;const unavailable=this.parameters.find(parameter=>this.codec(parameter).jsonSchema===void 0);if(unavailable!==void 0)return this.projection={jsonSchemaError:this.codec(unavailable).jsonSchemaError??`No JSON Schema for parameter ${unavailable.wire}`};return this.projection={jsonSchema:{type:`object`,properties:Object.fromEntries(this.parameters.map(parameter=>[parameter.wire,{...this.codec(parameter).jsonSchema,...parameter.description===void 0?{}:{description:parameter.description}}])),required:this.parameters.filter(parameter=>!optional(parameter)).map(parameter=>parameter.wire),additionalProperties:false}}}};var ResultValue=class{spec;projection;constructor(spec){this.spec=spec}get mode(){return this.spec.mode}get typeSymbol(){return this.spec.typeSymbol}get create(){return this.spec.create}get decode(){return this.spec.decode}get encode(){return this.spec.encode}get description(){return this.spec.description}get jsonSchemaError(){return this.spec.jsonSchemaError}get jsonSchema(){if(this.projection===void 0){const schema=this.spec.jsonSchema;this.projection={value:schema===void 0?void 0:{...schema,description:this.spec.description}}}return this.projection.value}};

    // === hub-bot 自有 Remote namespace 的 contribution ===
    // codec 三道硬校验：$mount 的 requireStrictCodec 要 mode 'strict'；registry 的 validateCodec 要
    // 非空 typeSymbol 与 create() 工厂；视图/补丁都是自由 JSON，用 z.any() 直通（v0.1.6 曾漏 typeSymbol）。
    var anyCodec = function (typeSymbol) {
      return { mode: 'strict', typeSymbol: typeSymbol, create: function () { return zodLib.z.any(); } };
    };
    var contribution = createTypertRemoteInfo({
      package: 'dsh-hub-bot',
      methods: {
        'hubBotSettings/read': {
          service: 'hubBotSettings',
          description: 'Read the hub-bot settings view.',
          invocation: { kind: 'direct' },
          parameters: [],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/update': {
          service: 'hubBotSettings',
          description: 'Apply a settings patch and return the fresh view.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'patch',
            source: 'json',
            description: 'Settings patch (same shape as the panel HTTP API).',
            codec: anyCodec('dsh-hub-bot#json-patch'),
            strictCodec: anyCodec('dsh-hub-bot#json-patch'),
          }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/listOwners': {
          service: 'hubBotSettings',
          description: 'List owner registry rows (GUI panel projection).',
          invocation: { kind: 'direct' },
          parameters: [],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/listWorkspaces': {
          service: 'hubBotSettings',
          description: 'List DSH workspaces for the L1 workspace pick-list (read-only projection).',
          invocation: { kind: 'direct' },
          parameters: [],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/retryOutbox': {
          service: 'hubBotSettings',
          description: 'Retry failed (dead-letter) outbox deliveries: {id} for one row, {all:true} for all.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request',
            source: 'json',
            description: '{ id } for one row or { all: true } for every dead letter.',
            codec: anyCodec('dsh-hub-bot#json-request'),
            strictCodec: anyCodec('dsh-hub-bot#json-request'),
          }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/discardOutbox': {
          service: 'hubBotSettings',
          description: 'Discard dead-letter outbox rows: {id} for one row, {all:true} for all.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request',
            source: 'json',
            description: '{ id } for one row or { all: true } for every dead letter.',
            codec: anyCodec('dsh-hub-bot#json-request'),
            strictCodec: anyCodec('dsh-hub-bot#json-request'),
          }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/modelCatalog': {
          service: 'hubBotSettings',
          description: 'Model catalog for the chief-model picker.',
          invocation: { kind: 'direct' },
          parameters: [],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/overview': {
          service: 'hubBotSettings',
          description: 'Ticket board overview (three-questions view).',
          invocation: { kind: 'direct' },
          parameters: [],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/startFeishuRegister': {
          service: 'hubBotSettings',
          description: 'Start the feishu scan-to-bind device flow (idempotent).',
          invocation: { kind: 'direct' },
          parameters: [],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/resolveTicket': {
          service: 'hubBotSettings',
          description: 'Confirm or reject a person/confirm ticket.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request',
            source: 'json',
            description: '{ ticketId, resolution: "confirm"|"reject", message? }',
            codec: anyCodec('dsh-hub-bot#json-request'),
            strictCodec: anyCodec('dsh-hub-bot#json-request'),
          }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
      },
    }, zodLib.z);

    var zh = {
      title: 'Hub Bot 中枢',
      panel: 'Hub Bot',
      workspaceSection: '会话工作区归位',
      enabled: '负责人会话出生即落进工作区',
      chiefPath: 'L1 公共工作区目录（绝对路径；留空 = 默认 <homeRepo>/.hub-bot/chief）',
      chiefWorkspace: 'L1 公共工作区',
      chiefWorkspaceAuto: '自动（hub-bot 自建「Hub Bot 中枢」）',
      chiefWorkspaceHint: '在左侧「工作区」区新建一个工作区，然后在这里选中它；chief 会话会出生在那里。选中的工作区由你全权管理，hub-bot 不会改名、不会动它。',
      chiefWorkspaceMissing: '⚠ 当前关联的工作区已不存在——保存后将回落到自动模式。',
      chiefPathWarn: '注意：指定到 homeRepo 树外时，chief 会话将失去仓库 AGENTS.md 指令上下文。',
      chiefTitle: 'L1 工作区标题（你手动改过的名字不会被覆盖）',
      modelSection: '总管模型',
      modelFollow: '跟随部署默认',
      modelHint: '模型的修改在 Hub Bot 面板（总管模型卡片）里进行。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败',
      loading: '正在读取…',
      loadFailed: '读取失败',
      retry: '重试',
      statusSection: '状态',
      feishuCard: '飞书',
      githubCard: 'GitHub 监听',
      githubSection: 'GitHub 监听',
      githubDisabled: 'GitHub 监听未启用（配置里 github.enabled 未开）',
      githubEnableHowto: '启用后，Hub Bot 定时轮询各负责人仓库，新 issue/PR 或 @提到会进入任务流。',
      githubEnableStep1: '编辑 DSH profile 的 cordis.patch.yml，把 hub-bot 配置的 github.enabled 改为 true',
      githubEnableStep2: '重启 DSH 实例（配置改动需要重启生效）',
      githubInterval: '轮询间隔',
      githubIntervalValue: '{n} 分钟',
      githubHandle: 'Mention 句柄',
      githubAllowlist: '允许触发者',
      githubAllowlistEmpty: '未配置（默认仅 gh 登录用户）',
      githubFollowedTitle: '监听清单（跟随负责人注册表自动推导）',
      githubNoRepos: '暂无监听仓库',
      githubWatermark: '水位',
      githubOwnerCol: '负责人',
      githubNotInited: '未初始化',
      githubResolveError: '负责人解析失败：',
      runtimeSection: '运行参数',
      slotsLabel: '每负责人并发槽',
      slotsHint: '同一负责人最多并行处理的票据数（默认 3）。改大提速但会话更杂，改小更稳。',
      reportAutoLabel: '例行自动汇报',
      reportEveryLabel: '分钟一次',
      reportHint: '开启后，chief 按间隔汇总各负责人状态并回投到飞书。',
      patternsLabel: '危险命令黑名单',
      patternsHint: '命中以下正则的注入会挂起等待你确认。每行一条正则。',
      patternsEmptyWarn: '⚠ 黑名单为空——危险命令将不再被拦截确认。',
      slotsInvalid: '并发槽必须是 ≥ 1 的整数',
      reportMinInvalid: '汇报间隔必须是 ≥ 1 的整数分钟',
      updatedAt: '数据更新于',
      refreshBtn: '刷新',
      refreshHint: '重新拉取状态、票据与设置',
      autoRefreshHint: '每 15s 自动刷新',
      recoveringHint: '实例重启后，系统正在自动恢复这条票据的执行现场',
      copyReportBtn: '复制',
      copyReportHint: '复制报告全文',
      copyPathHint: '点击复制完整路径',
      copySessionHint: '点击复制完整会话 id',
      unsaved: '未保存',
      ownersCard: '负责人',
      needsCard: '待我处理',
      connected: '已连接',
      notConnected: '未连接',
      disabled: '未启用',
      watching: '监听 {count} 个仓库',
      ownersSection: '负责人',
      colRole: '角色',
      colKind: '类型',
      colDir: '目录',
      colSession: '会话',
      colWorkspace: '工作区',
      activeSessions: '{count} 个会话活跃',
      titleManagedByYou: '关联模式下标题由你在工作区里直接改，这里不再覆盖。',
      roleChief: '总管',
      roleOwner: '负责人',
      kindRepo: '仓库',
      kindTemp: '临时',
      sessionBound: '已绑定',
      sessionNone: '未创建',
      modelApply: '应用',
      modelApplying: '应用中…',
      modelApplied: '模型已生效',
      modelFailed: '模型设置失败',
      catalogUnavailable: '模型目录不可用',
      refresh: '刷新',
      modelPickerHint: '修改立即生效；「跟随部署默认」使用当前 DSH 配置的默认模型。',
      modelDefaultNow: '当前默认：{n}',
      needsMe: '需要我处理',
      quiet: '没有 — 一切安静。',
      quietHint: '没有待确认、待回答或待验收的事。新消息进来时会出现在这里。',
      ticketsSection: '任务流',
      confirmBtn: '确认',
      rejectBtn: '拒绝',
      pendingConfirmLabel: '待确认：',
      questionLabel: '等您回复：',
      reportLabel: '交付报告：',
      recovering: '恢复中',
      emptyTickets: '还没有任务',
      relJustNow: '刚刚',
      relMinutes: '{n} 分钟前',
      relHours: '{n} 小时前',
      relDays: '{n} 天前',
      healthFeishuCred: '飞书凭据异常 — 需要重新扫码绑定',
      healthFeishuWs: '飞书长连接未建立',
      healthGithubPoll: 'GitHub 轮询最近失败',
      healthOutboxFailed: '{n} 条投递失败',
      resolveFailed: '操作失败',
      detailToggle: '详情',
      feishuSection: '飞书 Bot',
      feishuBound: '已绑定',
      feishuBoundAt: '绑定于',
      feishuWsOk: '长连接正常',
      feishuWsDown: '长连接未建立',
      feishuNotBound: '尚未绑定飞书 Bot',
      feishuInvalid: '凭据失效 — 请重新扫码绑定',
      feishuBindStart: '开始扫码绑定',
      feishuBinding: '正在等待二维码…',
      feishuScanHint: '用飞书手机 App 扫码完成授权；二维码有时效，过期请重新发起。',
      feishuPermsTitle: '权限申明（授权时将申请）',
      feishuBindFailed: '发起绑定失败',
      feishuDisabled: '飞书未启用（配置里 feishu.enabled 未开）',
      feishuEnableHowto: '启用后，你可以在飞书里给 Hub Bot 发消息、远程收状态汇报。',
      feishuEnableStep1: '编辑 DSH profile 的 cordis.patch.yml，把 hub-bot 配置的 feishu.enabled 改为 true',
      feishuEnableStep2: '重启 DSH 实例（配置改动需要重启生效），回到这里扫码绑定',
      recentSection: '最近消息',
      emptyRecent: '还没有消息进来',
      kindFeishu: '飞书',
      kindGithub: 'GitHub',
      kindRoute: '直派',
      droppedLabel: '未受理',
      healthDetailRetry: '重试中',
      healthDetailDead: '投递失败（死信）',
      retryOne: '重投',
      retryAll: '全部重投',
      discardOne: '丢弃',
      discardAll: '清空死信',
      discardOneHint: '确认不再投递，删除这条死信',
      discardAllHint: '确认全部不再投递，删除所有死信',
      discardAllConfirm: '确定清空全部死信？这些回执将不再投递。',
      discardedNotice: '已清空 {count} 条死信',
      filterPlaceholder: '筛选消息 / 负责人 / 工单号…',
      filterAllStages: '全部阶段',
      filterNoMatch: '没有匹配的票据',
      answerPlaceholder: '回复负责人的问题…（Enter 发送）',
      answerBtn: '回复',
      recentLocateHint: '点击在任务流中定位这张票',
      acceptBtn: '验收通过',
      retryTicketBtn: '重新尝试',
      cancelTicketBtn: '取消任务',
      cancelDone: '已取消，任务关闭',
      retryDone: '已要求重试，任务恢复执行',
      reworkBtn: '打回重做',
      reworkPlaceholder: '打回意见…（Enter 发送，票回进行中）',
      cardJumpHint: '点击跳到对应区域',
      verdictCount: '{count} 待裁决',
      activeTicketsLabel: '{count} 活跃票据',
      ownerFilterHint: '点击只看这位负责人的票据',
      replySent: '已回复',
      replyRecorded: '已注入会话',
      replyPending: '投递中',
      replyFailed: '回复投递失败',
      artifactsLabel: '产物目录（负责人工作区）',
      confirmActionInject: '确认后：原样投递挂起的注入（会话无人值守执行）',
      confirmActionFork: '确认后：fork 当前会话并在副本上续作（原会话保留）',
      confirmFullText: '查看完整挂起内容',
      forkDetail: 'fork 提案明细',
      forkColSession: '会话',
      forkColCwd: '工作目录',
      forkColAtSeq: '切点',
      forkColReason: '理由',
      forkAtSeqValue: '从事件 {count}（含）处',
      lastActivity: '最近活动',
      filterAllKinds: '全部',
      filterDroppedOnly: '仅看未受理',
      healthPillRetrying: '重试中',
      healthPillDead: '死信',
      filterAllOwners: '全部负责人',
      copyIdBtn: '复制',
      copiedBtn: '已复制',
      copyIdHint: '复制工单号',
      settingsDivider: '设置',
      selectAll: '全选',
      selectNone: '全不选',
      batchConfirm: '确认所选 · {count}',
      batchReject: '拒绝所选 · {count}',
      batchRunning: '执行中…',
      batchFailed: '{count} 条批量操作失败',
      droppedCardHint: '最近未受理',
      retriedNotice: '已重投 {count} 条，回到投递队列',
      confirmDone: '已确认，继续执行',
      rejectDone: '已拒绝，任务转被卡住',
      acceptDone: '已验收通过',
      batchConfirmed: '已批量确认 {count} 条',
      batchRejected: '已批量拒绝 {count} 条',
      answerDone: '已回复，任务继续',
      feishuMetricsTitle: '连接质量：',
      feishuMetricsReconnects: '重连 {count} 次',
      feishuMetricsLastConnected: '最近连接',
      feishuMetricsLastError: '最近错误',
      emptyOwners: '还没有负责人——飞书或 GitHub 来消息后会自动创建',
      tlCreated: '创建',
      tlAssign: '分派会话',
      tlAssignEnd: '分派结束',
      tlQuestion: '提问',
      tlConfirm: '挂起确认',
      tlReport: '交付报告',
      healthDetailNext: '下次重试',
      healthDetailLast: '最近错误',
      detailAuth: '授权',
      detailReport: '报告',
    };
    var en = {
      title: 'Hub Bot',
      panel: 'Hub Bot',
      workspaceSection: 'Workspace placement',
      enabled: 'Owner sessions are born inside their workspace',
      chiefPath: 'L1 shared workspace directory (absolute path; empty = default <homeRepo>/.hub-bot/chief)',
      chiefWorkspace: 'L1 shared workspace',
      chiefWorkspaceAuto: 'Automatic (hub-bot creates "Hub Bot 中枢")',
      chiefWorkspaceHint: 'Create a workspace in the sidebar first, then pick it here — chief sessions are born there. The picked workspace stays fully yours: hub-bot never renames or manages it.',
      chiefWorkspaceMissing: '⚠ The linked workspace no longer exists — saving falls back to automatic mode.',
      chiefPathWarn: 'Note: outside the homeRepo tree the chief session loses the repo AGENTS.md context.',
      chiefTitle: 'L1 workspace title (a name you set yourself is never overwritten)',
      modelSection: 'Chief model',
      modelFollow: 'Follows the deployment default',
      modelDefaultNow: 'Current default: {n}',
      modelHint: 'Change the model in the Hub Bot panel (chief model card).',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed',
      loading: 'Loading…',
      loadFailed: 'Load failed',
      retry: 'Retry',
      statusSection: 'Status',
      feishuCard: 'Feishu',
      githubCard: 'GitHub watch',
      githubSection: 'GitHub watch',
      githubDisabled: 'GitHub watch disabled (github.enabled is off in config)',
      githubEnableHowto: 'Once enabled, Hub Bot polls owner repos on an interval; new issues/PRs or @mentions enter the ticket stream.',
      githubEnableStep1: 'Edit cordis.patch.yml of the DSH profile: set github.enabled to true in the hub-bot config',
      githubEnableStep2: 'Restart the DSH instance (config changes require a restart)',
      githubInterval: 'Poll interval',
      githubIntervalValue: '{n} min',
      githubHandle: 'Mention handle',
      githubAllowlist: 'Allowed authors',
      githubAllowlistEmpty: 'not set (defaults to the gh login)',
      githubFollowedTitle: 'Watched repos (derived from the owner registry)',
      githubNoRepos: 'No watched repos yet',
      githubWatermark: 'watermark',
      githubOwnerCol: 'owner',
      githubNotInited: 'not initialized',
      githubResolveError: 'Owner resolution failed:',
      runtimeSection: 'Runtime',
      slotsLabel: 'Concurrency slots per owner',
      slotsHint: 'How many tickets one owner may process in parallel (default 3). Higher is faster but busier.',
      reportAutoLabel: 'Periodic auto report',
      reportEveryLabel: 'minutes',
      reportHint: 'When on, the chief summarizes owner states and posts back to Feishu on this interval.',
      patternsLabel: 'Dangerous command blacklist',
      patternsHint: 'Injected commands matching these regexes are held for your confirmation. One per line.',
      patternsEmptyWarn: '⚠ Empty blacklist — dangerous commands will no longer be held for confirmation.',
      slotsInvalid: 'Slots must be an integer ≥ 1',
      reportMinInvalid: 'Report interval must be an integer ≥ 1 minute',
      updatedAt: 'updated',
      refreshBtn: 'Refresh',
      refreshHint: 'Reload status, tickets and settings',
      autoRefreshHint: 'auto-refresh every 15s',
      recoveringHint: 'The instance restarted; the system is re-establishing this ticket’s execution',
      copyReportBtn: 'Copy',
      copyReportHint: 'Copy the full report',
      copyPathHint: 'Click to copy the full path',
      copySessionHint: 'Click to copy the full session id',
      unsaved: 'Unsaved',
      ownersCard: 'Owners',
      needsCard: 'Needs me',
      connected: 'Connected',
      notConnected: 'Not connected',
      disabled: 'Disabled',
      watching: 'Watching {count} repos',
      ownersSection: 'Owners',
      colRole: 'Role',
      colKind: 'Kind',
      colDir: 'Directory',
      colSession: 'Session',
      colWorkspace: 'Workspace',
      activeSessions: '{count} active session(s)',
      titleManagedByYou: 'With a linked workspace, its title is yours to edit in the sidebar — hub-bot will not overwrite it.',
      roleChief: 'Chief',
      roleOwner: 'Owner',
      kindRepo: 'Repo',
      kindTemp: 'Temp',
      sessionBound: 'Bound',
      sessionNone: 'Not created',
      modelApply: 'Apply',
      modelApplying: 'Applying…',
      modelApplied: 'Model applied',
      modelFailed: 'Failed to apply model',
      catalogUnavailable: 'Model catalog unavailable',
      refresh: 'Refresh',
      modelPickerHint: 'Takes effect immediately; "Follows the deployment default" uses the DSH default model.',
      needsMe: 'Needs me',
      quiet: 'Nothing — all quiet.',
      quietHint: 'No confirmations, answers, or reviews waiting. New items land here as they arrive.',
      ticketsSection: 'Ticket stream',
      confirmBtn: 'Confirm',
      rejectBtn: 'Reject',
      pendingConfirmLabel: 'Pending confirm: ',
      questionLabel: 'Waiting for your reply: ',
      reportLabel: 'Report: ',
      recovering: 'Recovering',
      emptyTickets: 'No tickets yet',
      relJustNow: 'just now',
      relMinutes: '{n} min ago',
      relHours: '{n} h ago',
      relDays: '{n} d ago',
      healthFeishuCred: 'Feishu credentials broken — re-bind by scanning',
      healthFeishuWs: 'Feishu long connection not established',
      healthGithubPoll: 'GitHub polling failed recently',
      healthOutboxFailed: '{n} deliveries failed',
      resolveFailed: 'Action failed',
      detailToggle: 'Details',
      feishuSection: 'Feishu Bot',
      feishuBound: 'Bound',
      feishuBoundAt: 'bound',
      feishuWsOk: 'Long connection OK',
      feishuWsDown: 'Long connection down',
      feishuNotBound: 'No feishu bot bound yet',
      feishuInvalid: 'Credentials invalid — scan to re-bind',
      feishuBindStart: 'Start scan-to-bind',
      feishuBinding: 'Waiting for the QR code…',
      feishuScanHint: 'Scan with the Feishu mobile app to authorize; the QR code expires — restart if it does.',
      feishuPermsTitle: 'Permissions (requested at authorization)',
      feishuBindFailed: 'Failed to start binding',
      feishuDisabled: 'Feishu disabled (feishu.enabled is off in config)',
      feishuEnableHowto: 'Once enabled, you can message Hub Bot in Feishu and receive status reports remotely.',
      feishuEnableStep1: 'Edit cordis.patch.yml of the DSH profile: set feishu.enabled to true in the hub-bot config',
      feishuEnableStep2: 'Restart the DSH instance (config changes require a restart), then scan the QR code here to bind',
      recentSection: 'Recent messages',
      emptyRecent: 'No inbound messages yet',
      kindFeishu: 'Feishu',
      kindGitHub: 'GitHub',
      kindRoute: 'Direct',
      droppedLabel: 'dropped',
      healthDetailRetry: 'retrying',
      healthDetailDead: 'failed deliveries (dead letters)',
      retryOne: 'Retry',
      retryAll: 'Retry all',
      discardOne: 'Discard',
      discardAll: 'Discard all',
      discardOneHint: 'Never deliver again; delete this dead letter',
      discardAllHint: 'Never deliver again; delete every dead letter',
      discardAllConfirm: 'Discard every dead letter? These replies will never be delivered.',
      discardedNotice: 'Discarded {count} dead letter(s)',
      filterPlaceholder: 'Filter message / owner / ticket id…',
      filterAllStages: 'All stages',
      filterNoMatch: 'No tickets match',
      answerPlaceholder: 'Reply to the owner… (Enter to send)',
      answerBtn: 'Reply',
      recentLocateHint: 'Click to locate this ticket in the stream',
      acceptBtn: 'Accept',
      retryTicketBtn: 'Retry',
      cancelTicketBtn: 'Cancel task',
      cancelDone: 'Cancelled — the task is closed',
      retryDone: 'Retry requested — the ticket is running again',
      reworkBtn: 'Rework',
      reworkPlaceholder: 'Rework note… (Enter sends, ticket resumes)',
      cardJumpHint: 'Click to jump to the section',
      verdictCount: '{count} to review',
      activeTicketsLabel: '{count} active tickets',
      ownerFilterHint: 'Click to show only this owner’s tickets',
      replySent: 'replied',
      replyRecorded: 'injected',
      replyPending: 'delivering',
      replyFailed: 'reply delivery failed',
      artifactsLabel: 'Artifacts (owner workspace)',
      confirmActionInject: 'On confirm: deliver the held injection verbatim (unattended)',
      confirmActionFork: 'On confirm: fork the session and continue on the copy (original kept)',
      confirmFullText: 'View the full held content',
      forkDetail: 'Fork proposal detail',
      forkColSession: 'Session',
      forkColCwd: 'Directory',
      forkColAtSeq: 'Cut at',
      forkColReason: 'Reason',
      forkAtSeqValue: 'from event {count} (inclusive)',
      lastActivity: 'active',
      filterAllKinds: 'All',
      filterDroppedOnly: 'Dropped only',
      healthPillRetrying: 'retrying',
      healthPillDead: 'dead',
      filterAllOwners: 'All owners',
      copyIdBtn: 'Copy',
      copiedBtn: 'Copied',
      copyIdHint: 'Copy ticket id',
      settingsDivider: 'Settings',
      selectAll: 'Select all',
      selectNone: 'Select none',
      batchConfirm: 'Confirm selected · {count}',
      batchReject: 'Reject selected · {count}',
      batchRunning: 'Running…',
      batchFailed: '{count} batch operations failed',
      droppedCardHint: 'Last dropped',
      retriedNotice: 'Requeued {count} row(s) to the delivery queue',
      confirmDone: 'Confirmed, resuming',
      rejectDone: 'Rejected, ticket blocked',
      acceptDone: 'Accepted',
      batchConfirmed: 'Confirmed {count} ticket(s)',
      batchRejected: 'Rejected {count} ticket(s)',
      answerDone: 'Replied, ticket resumed',
      feishuMetricsTitle: 'Connection:',
      feishuMetricsReconnects: '{count} reconnects',
      feishuMetricsLastConnected: 'last connected',
      feishuMetricsLastError: 'last error',
      emptyOwners: 'No owners yet — one is created automatically when a feishu or GitHub message arrives',
      tlCreated: 'Created',
      tlAssign: 'Assigned',
      tlAssignEnd: 'Assignment ended',
      tlQuestion: 'Question',
      tlConfirm: 'Pending confirm',
      tlReport: 'Report',
      healthDetailNext: 'next retry',
      healthDetailLast: 'last error',
      detailAuth: 'Authorized',
      detailReport: 'Report',
    };
    var NS = 'dsh-hub-bot.settings';

    // 防御性拆包：remote 结果可能带 {ok:true,value} envelope（官方 stub 在生成代码里拆，
    // 我们的手写 contribution 没有那层），裸对象则原样通过。
    // typert 失败结果也 resolve（{ok:false,error} 信封）——unwrap 遇到错误信封直接抛，让调用方 catch 兜底；
    // 数组结果再兜一层 Array.isArray（v0.4.1 教训: 错误信封漏进 setState 导致渲染崩溃）。
    function unwrap(x) {
      if (x && typeof x === 'object' && x.ok === false && x.error) {
        var err = new Error((x.error && (x.error.message || x.error.code)) || 'remote call failed');
        err.remoteError = x.error;
        throw err;
      }
      return x && typeof x === 'object' && x.ok === true && 'value' in x ? x.value : x;
    }

    var fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' };
    var labelStyle = { fontSize: '12px', opacity: 0.75 };
    var inputStyle = {
      font: 'inherit', padding: '6px 8px', borderRadius: '6px',
      border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
      background: 'var(--dsh-surface, transparent)', color: 'inherit', width: '100%', boxSizing: 'border-box',
    };
    var sectionStyle = { marginBottom: '20px' };
    var sectionTitleStyle = { fontSize: '13px', fontWeight: 600, marginBottom: '10px' };
    function sectionDivider(label, id) {
      return h('div', { id: id, style: { display: 'flex', alignItems: 'center', gap: '12px', margin: '26px 0 14px' } },
        h('div', { style: { flex: '0 0 auto', fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.5 } }, label),
        h('div', { style: { flex: '1 1 auto', height: '1px', background: 'var(--dsh-border, rgba(127,127,127,0.25))' } }));
    }
    var warnStyle = { fontSize: '12px', opacity: 0.65, marginTop: '4px' };

    function HubBotRowConfig(props) {
      var ctx = props.hubBotCtx;
      var hideModel = props.hideModel === true;
      var t = ctx.locale.bind(NS);
      var st = React.useState(null);
      var view = st[0]; var setView = st[1];
      var errState = React.useState(null);
      var error = errState[0]; var setError = errState[1];
      var busyState = React.useState(false);
      var busy = busyState[0]; var setBusy = busyState[1];
      var savedState = React.useState(false);
      var saved = savedState[0]; var setSaved = savedState[1];
      var formState = React.useState({ enabled: true, chiefWorkspaceId: '', chiefTitle: '' });
      var form = formState[0]; var setForm = formState[1];
      var wsListState = React.useState(null);
      var wsList = wsListState[0]; var setWsList = wsListState[1];

      var load = function () {
        setError(null);
        ctx.remote.hubBotSettings.read().then(function (raw) {
          var v = unwrap(raw);
          setView(v);
          setForm({
            enabled: v.workspaces ? v.workspaces.enabled !== false : true,
            chiefWorkspaceId: (v.workspaces && v.workspaces.chiefWorkspaceId) || '',
            chiefTitle: (v.workspaces && v.workspaces.chiefTitle) || 'Hub Bot 中枢',
          });
        }).catch(function (e) { setError(e && e.message ? e.message : String(e)); });
        // 关联式归位（turn 108）: 工作区选择器数据——你在 DSH 里建好的工作区在这里挑。
        if (ctx.remote.hubBotSettings.listWorkspaces) {
          ctx.remote.hubBotSettings.listWorkspaces().then(function (raw) {
            var list = unwrap(raw);
            setWsList(Array.isArray(list) ? list : []);
          }).catch(function () { setWsList([]); });
        } else { setWsList([]); }
      };
      React.useEffect(load, []);

      if (error && !view) {
        return h('div', null,
          h('p', null, t('loadFailed') + ': ' + error),
          h('button', { onClick: load, style: inputStyle }, t('retry')));
      }
      if (!view) return h('p', null, t('loading'));

      var save = function () {
        setBusy(true); setSaved(false); setError(null);
        ctx.remote.hubBotSettings.update({
          workspaces: {
            enabled: form.enabled,
            chiefWorkspaceId: form.chiefWorkspaceId || null,
            chiefTitle: form.chiefTitle.trim() || 'Hub Bot 中枢',
          },
        }).then(function (v) { setView(unwrap(v)); setSaved(true); })
          .catch(function (e) { setError(e && e.message ? e.message : String(e)); })
          .finally(function () { setBusy(false); });
      };

      // 未保存标记（round 40）：表单值与已存值不一致时给出琥珀提示，「已保存」不再误驻留。
      var ws = view.workspaces || {};
      var wsDirty = form.enabled !== (ws.enabled !== false)
        || form.chiefWorkspaceId !== (ws.chiefWorkspaceId || '')
        || form.chiefTitle !== (ws.chiefTitle || 'Hub Bot 中枢');
      var model = view.chief && view.chief.model;
      return h('div', { style: { maxWidth: '560px' } },
        h('div', { style: sectionStyle },
          h('div', { style: sectionTitleStyle }, t('workspaceSection')),
          h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
            h('input', {
              type: 'checkbox', checked: form.enabled,
              onChange: function (ev) { setForm(Object.assign({}, form, { enabled: ev.target.checked })); },
            }),
            h('span', null, t('enabled'))),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle }, t('chiefWorkspace')),
            h('select', {
              style: inputStyle, value: form.chiefWorkspaceId,
              onChange: function (ev) { setForm(Object.assign({}, form, { chiefWorkspaceId: ev.target.value })); },
            },
              h('option', { value: '' }, t('chiefWorkspaceAuto')),
              (wsList || []).map(function (w) {
                return h('option', { key: w.workspaceId, value: w.workspaceId },
                  (w.title || w.workspaceId) + (w.path ? ' — ' + w.path : ''));
              })),
            // 选中的工作区被删了 → 显示一个占位项，让当前值可见（保存时仍写回，后端会 warn 回落自动）
            form.chiefWorkspaceId && (wsList || []).every(function (w) { return w.workspaceId !== form.chiefWorkspaceId; })
              ? h('div', { style: warnStyle }, t('chiefWorkspaceMissing'))
              : null,
            h('div', { style: warnStyle }, t('chiefWorkspaceHint'))),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle }, t('chiefTitle')),
            h('input', {
              style: Object.assign({}, inputStyle, form.chiefWorkspaceId ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
              value: form.chiefTitle,
              disabled: !!form.chiefWorkspaceId,
              onChange: function (ev) { setForm(Object.assign({}, form, { chiefTitle: ev.target.value })); },
            }),
            form.chiefWorkspaceId ? h('div', { style: warnStyle }, t('titleManagedByYou')) : null)),
        hideModel ? null : h('div', { style: sectionStyle },
          h('div', { style: sectionTitleStyle }, t('modelSection')),
          h('div', { style: { fontSize: '13px' } }, model ? model.provider + ' / ' + model.model : t('modelFollow')),
          h('div', { style: warnStyle }, t('modelHint'))),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          h('button', {
            onClick: save, disabled: busy,
            style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 16px' }),
          }, busy ? t('saving') : t('save')),
          saved && !wsDirty ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('saved')) : null,
          wsDirty ? h('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: 'rgba(230,160,40,0.14)', color: '#eba938', border: '1px solid rgba(230,160,40,0.4)', whiteSpace: 'nowrap' } }, t('unsaved')) : null,
          error ? h('span', { style: { fontSize: '12px', color: 'var(--dsh-danger, #d66)' } }, t('failed') + ': ' + error) : null));
    }

    // cordis 服务 key（不是包名）：fiber.inject 的键按服务名等待；包级依赖在 package.json 的 dsh.client.inject 声明。
    // 本插件用到 ctx.slots / ctx.locale / ctx.remote（v0.1.4 误写成包名导致永久 pending 的教训）。
    var inject = ['slots', 'locale', 'remote'];
    function apply(ctx) {
      // 第一段：挂载自有 Remote namespace（dsh-cua 模式）。$mount 内部以 owner ctx 注册 effect，随插件卸载自动清理。
      ctx.plugin(function (owner) {
        return owner.remote.$mount(contribution).catch(function (error) {
          console.error('[hub-bot] remote mount failed', error);
          throw error;
        });
      });
      // 第二段：namespace 就绪后（服务 key remote.hubBotSettings 出现）再注册字典与配置表单。
      ctx.inject(['remote.hubBotSettings', 'slots', 'locale'], function (scoped) {
        scoped.effect(function () {
          return scoped.locale.register(NS, { zh: zh, en: en });
        }, 'hub-bot: dictionaries');
        scoped.effect(function () {
          return scoped.slots.inject('plugins.row.config', function () {
            return scoped.slots.register({
              name: 'plugins.row.config',
              key: 'dsh-hub-bot#hub-bot',
              order: 0,
              label: function () { return scoped.locale.bind(NS)('title'); },
              locale: NS,
            }, function (ownerProps) { return h(HubBotRowConfig, { hubBotCtx: scoped }); });
          });
        }, 'hub-bot: row config');
        // 顶级侧边栏面板：入口图标（sidebar.panellist）+ 页面（main）。
        // 面板页直接复用设置表单——hub-bot 是日常中枢，不该埋进插件管理器三层。
        function HubBotPanelIcon(props) {
          var size = (props && props.size) || 20;
          return h('svg', {
            width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
          },
            h('circle', { cx: 12, cy: 12, r: 3.1 }),
            h('circle', { cx: 12, cy: 3.7, r: 2 }),
            h('circle', { cx: 4.7, cy: 18.1, r: 2 }),
            h('circle', { cx: 19.3, cy: 18.1, r: 2 }),
            h('line', { x1: 12, y1: 5.8, x2: 12, y2: 8.9 }),
            h('line', { x1: 9.9, y1: 14.3, x2: 6.5, y2: 16.5 }),
            h('line', { x1: 14.1, y1: 14.3, x2: 17.5, y2: 16.5 }));
        }
        // 面板整页：状态卡片 + 健康警告 + 需要我处理 + 任务流 + 模型选择 + owners 表 + 设置表单。
        var cardRowStyle = { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '22px' };
        var cardStyle = {
          flex: '1 1 0', minWidth: '140px', padding: '14px 16px', borderRadius: '10px',
          border: '1px solid var(--dsh-border, rgba(127,127,127,0.25))',
          background: 'var(--dsh-surface-raised, rgba(127,127,127,0.06))',
          overflow: 'hidden',
        };
        var cardTitleStyle = { fontSize: '12px', opacity: 0.65, marginBottom: '8px' };
        var cardValueStyle = { fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center' };
        var tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '13px' };
        var thStyle = { textAlign: 'left', padding: '6px 8px', opacity: 0.65, fontSize: '12px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,0.3))' };
        var tdStyle = { padding: '7px 8px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,0.15))', verticalAlign: 'top' };
        var NEEDS_ME = ['person/confirm', 'person/answer', 'person/review', 'blocked', 'failed'];
        var STAGE_ORDER = ['person/confirm', 'person/answer', 'person/review', 'blocked', 'failed', 'working', 'queued', 'idle', 'done', 'canceled'];
        var STAGE_TONE = {
          'person/confirm': 'amber', 'person/answer': 'amber', 'person/review': 'amber',
          working: 'blue', queued: 'gray', blocked: 'red', failed: 'red',
          done: 'green', idle: 'muted', canceled: 'muted',
        };
        var TONES = {
          amber: { bg: 'rgba(230,160,40,0.14)', fg: '#eba938', border: 'rgba(230,160,40,0.4)' },
          blue: { bg: 'rgba(80,140,255,0.13)', fg: '#6b97ff', border: 'rgba(80,140,255,0.4)' },
          red: { bg: 'rgba(220,80,80,0.13)', fg: '#e06060', border: 'rgba(220,80,80,0.4)' },
          green: { bg: 'rgba(60,180,100,0.13)', fg: '#46bb6d', border: 'rgba(60,180,100,0.4)' },
          gray: { bg: 'rgba(127,127,127,0.12)', fg: 'rgba(170,170,170,0.9)', border: 'rgba(127,127,127,0.35)' },
          muted: { bg: 'rgba(127,127,127,0.07)', fg: 'rgba(140,140,140,0.75)', border: 'rgba(127,127,127,0.22)' },
        };
        function stagePill(stage, text) {
          var tone = TONES[STAGE_TONE[stage] || 'gray'];
          return h('span', { style: {
            display: 'inline-block', padding: '2px 10px', borderRadius: '999px', fontSize: '12px',
            background: tone.bg, color: tone.fg, border: '1px solid ' + tone.border, whiteSpace: 'nowrap',
          } }, text);
        }
        function dot(color) {
          return h('span', { style: {
            display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
            background: color, boxShadow: '0 0 6px ' + color, marginRight: '8px', flexShrink: 0,
          } });
        }
        function shortPath(p) {
          if (!p) return '—';
          var parts = String(p).split('/');
          return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
        }
        function fill(template, n) {
          return String(template).replace('{n}', String(n)).replace('{count}', String(n));
        }
        function hhmm(iso) {
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '—';
            var p = function (n) { return String(n).padStart(2, '0'); };
            return p(d.getHours()) + ':' + p(d.getMinutes());
        }
        function relTime(t, iso) {
          if (!iso) return '';
          var diff = Date.now() - new Date(iso).getTime();
          var m = Math.floor(diff / 60000);
          if (m < 1) return t('relJustNow');
          if (m < 60) return fill(t('relMinutes'), m);
          var hr = Math.floor(m / 60);
          if (hr < 24) return fill(t('relHours'), hr);
          return fill(t('relDays'), Math.floor(hr / 24));
        }
        function healthProblems(health, t) {
          var items = [];
          var feishu = health.feishu || {};
          if (feishu.enabled && feishu.credentialState && feishu.credentialState !== 'ok') items.push(t('healthFeishuCred'));
          if (feishu.enabled && feishu.credentialState === 'ok' && feishu.connected === false) items.push(t('healthFeishuWs'));
          var gh = health.github || {};
          if (gh.enabled && gh.lastPollError) items.push(t('healthGithubPoll') + '：' + gh.lastPollError);
          var ob = health.outbox || {};
          if (ob.failed > 0) items.push(fill(t('healthOutboxFailed'), ob.failed));
          return items;
        }

        // 飞书 bot 管理块（唯一总 bot）：已绑定名片+权限 / 未绑定预告+扫码 / 失效重扫，三态同一区块。
        function FeishuSection(props) {
          var t = scoped.locale.bind(NS);
          var view = props.view;
          var onRefresh = props.onRefresh;
          var fs = (view.feishu && view.feishu.status) || {};
          var enabled = !!(view.feishu && view.feishu.enabled);
          var bound = fs.credentialState === 'ok' && !!fs.bot;
          var invalid = enabled && fs.credentialState && fs.credentialState !== 'ok' && !fs.registration;
          var pending = fs.registration === 'pending';
          var bs = React.useState(false); var busy = bs[0]; var setBusy = bs[1];
          var es = React.useState(null); var err = es[0]; var setErr = es[1];
          var ts = React.useState(0); var tick = ts[0]; var setTick = ts[1];
          // 注册流 pending 时轮询 read()，直到扫码完成（credentialState 转 ok）或二维码过期
          React.useEffect(function () {
            if (!pending) return undefined;
            var timer = setInterval(function () { onRefresh(); setTick(function (n) { return n + 1; }); }, 2500);
            return function () { clearInterval(timer); };
          }, [pending]);
          var start = function () {
            setBusy(true); setErr(null);
            scoped.remote.hubBotSettings.startFeishuRegister()
              .then(function () { onRefresh(); })
              .catch(function (e) { setErr(t('feishuBindFailed') + ': ' + (e && e.message ? e.message : String(e))); })
              .finally(function () { setBusy(false); });
          };
          var perms = fs.permissions || [];
          var rows = [];
          if (!enabled) {
            // 未启用不只是状态——给一条可以照做的启用路径（配置改动需重启实例生效）。
            rows.push(h('div', { key: 'off', style: { display: 'flex', gap: '12px', padding: '13px 15px', borderRadius: '10px', background: 'rgba(230,160,40,0.06)', border: '1px solid rgba(230,160,40,0.25)' } },
              h('span', { style: { fontSize: '16px', width: '28px', height: '28px', lineHeight: '27px', textAlign: 'center', borderRadius: '50%', background: TONES.amber.bg, border: '1px solid ' + TONES.amber.border, color: TONES.amber.fg, flexShrink: 0 } }, '!'),
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('feishuDisabled')),
                h('div', { style: { fontSize: '12px', opacity: 0.7, marginTop: '3px', lineHeight: 1.6 } }, t('feishuEnableHowto')),
                h('ol', { style: { fontSize: '12px', opacity: 0.75, margin: '6px 0 0', paddingLeft: '18px', lineHeight: 1.7 } },
                  h('li', null, t('feishuEnableStep1')),
                  h('li', null, t('feishuEnableStep2'))))));
          } else if (bound) {
            rows.push(h('div', { key: 'card', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
              dot(fs.bot.connected ? '#46bb6d' : '#e06060'),
              h('span', { style: { fontWeight: 600 } }, fs.bot.name || 'bot'),
              h('span', { style: { fontSize: '12px', opacity: 0.65 } }, 'App ID：' + (fs.bot.appIdMasked || '—')),
              fs.bot.boundAt ? h('span', { style: { fontSize: '12px', opacity: 0.65 } }, t('feishuBoundAt') + ' ' + relTime(t, fs.bot.boundAt)) : null,
              stagePill(fs.bot.connected ? 'done' : 'failed', fs.bot.connected ? t('feishuWsOk') : t('feishuWsDown'))));
            // 连接质量（host 侧持久化的 ws 生命周期记账）: 有记录才渲染
            var mt = fs.metrics || {};
            var mtParts = [];
            if (mt.reconnects > 0) mtParts.push(fill(t('feishuMetricsReconnects'), mt.reconnects));
            if (mt.lastConnectedAt) mtParts.push(t('feishuMetricsLastConnected') + ' ' + relTime(t, mt.lastConnectedAt));
            if (mt.lastErrorAt) mtParts.push(t('feishuMetricsLastError') + ' ' + relTime(t, mt.lastErrorAt));
            if (mtParts.length > 0) {
              rows.push(h('div', { key: 'mt', style: { marginTop: '6px', fontSize: '12px', opacity: 0.65, display: 'flex', gap: '12px', flexWrap: 'wrap' }, title: mt.lastError || '' },
                h('span', { style: { fontWeight: 600 } }, t('feishuMetricsTitle')),
                mtParts.map(function (part, i) { return h('span', { key: i }, part); })));
            }
          } else {
            if (invalid) rows.push(h('p', { key: 'inv', style: { fontSize: '13px', color: TONES.red.fg, margin: '0 0 4px' } }, t('feishuInvalid')));
            else rows.push(h('p', { key: 'nb', style: { fontSize: '13px', opacity: 0.75, margin: '0 0 4px' } }, t('feishuNotBound')));
            if (!pending) {
              rows.push(h('button', { key: 'start', onClick: start, disabled: busy,
                style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 18px', marginTop: '6px' }),
              }, busy ? t('feishuBinding') : t('feishuBindStart')));
            }
          }
          if (pending && fs.qr && fs.qr.svg) {
            rows.push(h('div', { key: 'qr', style: { marginTop: '12px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
              h('img', {
                src: 'data:image/svg+xml;utf8,' + encodeURIComponent(fs.qr.svg),
                alt: 'feishu qr', style: { width: '168px', height: '168px', borderRadius: '8px', background: '#fff', padding: '6px' },
              }),
              h('div', { style: { fontSize: '13px', opacity: 0.8, maxWidth: '320px' } }, t('feishuScanHint'))));
          } else if (pending) {
            rows.push(h('p', { key: 'wait', style: { fontSize: '13px', opacity: 0.7 } }, t('feishuBinding')));
          }
          if (enabled && perms.length) {
            rows.push(h('div', { key: 'perms', style: { marginTop: '12px' } },
              h('div', { style: { fontSize: '12px', opacity: 0.65, marginBottom: '6px' } }, t('feishuPermsTitle')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, perms.map(function (p) {
                return h('div', { key: p.key, style: { fontSize: '12px', opacity: 0.85 } }, '· ' + (p.label || p.key));
              }))));
          }
          if (err) rows.push(h('div', { key: 'err', style: { fontSize: '12px', color: TONES.red.fg, marginTop: '6px' } }, err));
          return h('div', { style: sectionStyle }, h('div', { style: sectionTitleStyle }, t('feishuSection')), rows);
        }

        // GitHub 监听管理块（round 34）：面板此前完全没有 GitHub 区块——状态卡不可点、看不到监听清单。
        // read() 已带全量 github 状态（每仓库水位/错误），纯客户端渲染即可。
        function GithubSection(props) {
          var t = scoped.locale.bind(NS);
          var gh = (props.view && props.view.github) || {};
          var enabled = !!gh.enabled;
          var st = gh.status || {};
          var repos = st.repos || {};
          var names = Object.keys(repos);
          var resolveErrors = gh.resolveErrors || {};
          var rows = [];
          if (!enabled) {
            rows.push(h('div', { key: 'off', style: { display: 'flex', gap: '12px', padding: '13px 15px', borderRadius: '10px', background: 'rgba(230,160,40,0.06)', border: '1px solid rgba(230,160,40,0.25)' } },
              h('span', { style: { fontSize: '16px', width: '28px', height: '28px', lineHeight: '27px', textAlign: 'center', borderRadius: '50%', background: TONES.amber.bg, border: '1px solid ' + TONES.amber.border, color: TONES.amber.fg, flexShrink: 0 } }, '!'),
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('githubDisabled')),
                h('div', { style: { fontSize: '12px', opacity: 0.7, marginTop: '3px', lineHeight: 1.6 } }, t('githubEnableHowto')),
                h('ol', { style: { fontSize: '12px', opacity: 0.75, margin: '6px 0 0', paddingLeft: '18px', lineHeight: 1.7 } },
                  h('li', null, t('githubEnableStep1')),
                  h('li', null, t('githubEnableStep2'))))));
          } else {
            var mins = Math.round((gh.intervalMs || 300000) / 60000);
            var chips = [
              t('githubInterval') + '：' + fill(t('githubIntervalValue'), mins),
              t('githubHandle') + '：' + (gh.mentionHandle || '—'),
              t('githubAllowlist') + '：' + ((gh.loginAllowlist || []).length > 0 ? (gh.loginAllowlist || []).join(', ') : t('githubAllowlistEmpty')),
            ];
            rows.push(h('div', { key: 'info', style: { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.75 } },
              chips.map(function (c, i) { return h('span', { key: i }, c); })));
            Object.keys(resolveErrors).forEach(function (ownerKey) {
              rows.push(h('div', { key: 're-' + ownerKey, style: { marginTop: '6px', fontSize: '12px', color: TONES.red.fg } },
                t('githubResolveError') + ' ' + ownerKey.replace(/^owner:/, '') + ' — ' + String(resolveErrors[ownerKey]).slice(0, 140)));
            });
            rows.push(h('div', { key: 'lt', style: { marginTop: '10px', fontSize: '12px', fontWeight: 600, opacity: 0.65 } }, t('githubFollowedTitle')));
            if (names.length === 0) {
              rows.push(h('p', { key: 'empty', style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('githubNoRepos')));
            } else {
              names.forEach(function (name) {
                var info = repos[name] || {};
                rows.push(h('div', { key: name, style: { marginTop: '6px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,0.06)', border: '1px solid rgba(127,127,127,0.16)', borderLeft: '3px solid ' + (info.lastError ? TONES.red.border : TONES.blue.border) } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                    h('span', { style: { fontFamily: 'monospace', fontSize: '12px', fontWeight: 600 } }, name),
                    info.workspace ? h('span', { style: { fontSize: '11px', opacity: 0.6 } }, t('githubOwnerCol') + ' ' + info.workspace) : null,
                    h('span', { style: { fontSize: '11px', opacity: 0.55, marginLeft: 'auto', fontFamily: 'monospace' } },
                      t('githubWatermark') + ' #' + (info.maxNumber || 0) + (info.initialized ? '' : ' · ' + t('githubNotInited')))),
                  info.lastError ? h('div', { style: { marginTop: '4px', fontSize: '11px', color: TONES.red.fg, wordBreak: 'break-all' } }, String(info.lastError).slice(0, 160)) : null));
              });
            }
          }
          return h('div', { id: 'hub-bot-github', style: sectionStyle }, h('div', { style: sectionTitleStyle }, t('githubSection')), rows);
        }

        // 运行参数（round 35）：白名单里可写但面板没有 UI 的三组——并发槽、例行汇报、危险命令黑名单。
        function RuntimeSection(props) {
          var t = scoped.locale.bind(NS);
          var fieldSt = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' };
          var labelSt = { fontSize: '12px', opacity: 0.75 };
          var warnSt = { fontSize: '12px', opacity: 0.65, marginTop: '4px' };
          var fs = React.useState({ slots: '3', reportAuto: false, reportMin: '60', patterns: '' });
          var form = fs[0]; var setForm = fs[1];
          var bs = React.useState(false); var busy = bs[0]; var setBusy = bs[1];
          var ss = React.useState(false); var saved = ss[0]; var setSaved = ss[1];
          var es = React.useState(null); var err = es[0]; var setErr = es[1];
          React.useEffect(function () {
            var v = props.view;
            if (!v) return;
            setForm({
              slots: String((v.concurrency && v.concurrency.slotsPerOwner) || 3),
              reportAuto: !!(v.reporting && v.reporting.auto),
              reportMin: String(Math.round(((v.reporting && v.reporting.intervalMs) || 3600000) / 60000)),
              patterns: ((v.security && v.security.dangerousPatterns) || []).join('\n'),
            });
          }, [props.view]);
          var save = function () {
            var slots = parseInt(form.slots, 10);
            var mins = parseInt(form.reportMin, 10);
            if (!Number.isSafeInteger(slots) || slots < 1) { setErr(t('slotsInvalid')); return; }
            if (!Number.isSafeInteger(mins) || mins < 1) { setErr(t('reportMinInvalid')); return; }
            var patterns = form.patterns.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
            setBusy(true); setSaved(false); setErr(null);
            scoped.remote.hubBotSettings.update({
              concurrency: { slotsPerOwner: slots },
              reporting: { auto: form.reportAuto, intervalMs: mins * 60000 },
              security: { dangerousPatterns: patterns },
            }).then(function (raw) {
              setSaved(true);
              if (props.onSaved) props.onSaved();
            }).catch(function (e) { setErr(e && e.message ? e.message : String(e)); })
              .finally(function () { setBusy(false); });
          };
          var edit = function (patch) { setForm(Object.assign({}, form, patch)); setSaved(false); };
          var v2 = props.view || {};
          var curSlots = String((v2.concurrency && v2.concurrency.slotsPerOwner) || 3);
          var curAuto = !!(v2.reporting && v2.reporting.auto);
          var curMin = String(Math.round(((v2.reporting && v2.reporting.intervalMs) || 3600000) / 60000));
          var curPatterns = ((v2.security && v2.security.dangerousPatterns) || []).join('\n');
          var rtDirty = form.slots !== curSlots || form.reportAuto !== curAuto || form.reportMin !== curMin || form.patterns !== curPatterns;
          return h('div', { style: Object.assign({}, sectionStyle, { marginTop: '22px' }) },
            h('div', { style: sectionTitleStyle }, t('runtimeSection')),
            h('div', { style: fieldSt },
              h('label', { style: labelSt }, t('slotsLabel')),
              h('input', { type: 'number', min: 1, step: 1, value: form.slots, onChange: function (ev) { edit({ slots: ev.target.value }); }, style: Object.assign({}, inputStyle, { width: '120px' }) }),
              h('div', { style: warnSt }, t('slotsHint'))),
            h('div', { style: fieldSt },
              h('label', { style: Object.assign({}, labelSt, { display: 'flex', gap: '8px', alignItems: 'center' }) },
                h('input', { type: 'checkbox', checked: form.reportAuto, onChange: function (ev) { edit({ reportAuto: ev.target.checked }); } }),
                h('span', null, t('reportAutoLabel'))),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('input', { type: 'number', min: 1, step: 1, value: form.reportMin, disabled: !form.reportAuto, onChange: function (ev) { edit({ reportMin: ev.target.value }); }, style: Object.assign({}, inputStyle, { width: '120px' }, form.reportAuto ? {} : { opacity: 0.5 }) }),
                h('span', { style: { fontSize: '12px', opacity: 0.65 } }, t('reportEveryLabel'))),
              h('div', { style: warnSt }, t('reportHint'))),
            h('div', { style: fieldSt },
              h('label', { style: labelSt }, t('patternsLabel')),
              h('textarea', { rows: 5, value: form.patterns, onChange: function (ev) { edit({ patterns: ev.target.value }); }, placeholder: '^\s*rm\s+-rf\s+/', style: Object.assign({}, inputStyle, { fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }) }),
              h('div', { style: warnSt }, t('patternsHint')),
              form.patterns.trim() === '' ? h('div', { style: { fontSize: '12px', color: TONES.amber.fg, marginTop: '4px' } }, t('patternsEmptyWarn')) : null),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
              h('button', { onClick: save, disabled: busy, style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 16px' }) }, busy ? t('saving') : t('save')),
              saved && !rtDirty ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('saved')) : null,
              rtDirty ? h('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: 'rgba(230,160,40,0.14)', color: '#eba938', border: '1px solid rgba(230,160,40,0.4)', whiteSpace: 'nowrap' } }, t('unsaved')) : null,
              err ? h('span', { style: { fontSize: '12px', color: 'var(--dsh-danger, #d66)' } }, t('failed') + ': ' + err) : null));
        }

        function HubBotPanelPage() {
          var t = scoped.locale.bind(NS);
          var vs = React.useState(null); var view = vs[0]; var setView = vs[1];
          var os = React.useState(null); var owners = os[0]; var setOwners = os[1];
          var cs = React.useState(null); var catalog = cs[0]; var setCatalog = cs[1];
          var os2 = React.useState(null); var overview = os2[0]; var setOverview = os2[1];
          var es = React.useState(null); var error = es[0]; var setError = es[1];
          var nts = React.useState(''); var notice = nts[0]; var setNotice = nts[1];
          var noticeSeq = React.useRef(0);
          var lls = React.useState(null); var lastLoadedAt = lls[0]; var setLastLoadedAt = lls[1];
          var ms = React.useState(''); var modelChoice = ms[0]; var setModelChoice = ms[1];
          var bs = React.useState(false); var modelBusy = bs[0]; var setModelBusy = bs[1];
          var ds = React.useState(false); var modelDone = ds[0]; var setModelDone = ds[1];
          var rs = React.useState(null); var resolving = rs[0]; var setResolving = rs[1];
          var fts = React.useState(''); var filterText = fts[0]; var setFilterText = fts[1];
          var fss = React.useState(''); var filterStage = fss[0]; var setFilterStage = fss[1];
          var fos = React.useState(''); var filterOwner = fos[0]; var setFilterOwner = fos[1];
          var rks = React.useState(''); var recentKind = rks[0]; var setRecentKind = rks[1];
          var cps = React.useState(''); var copiedId = cps[0]; var setCopiedId = cps[1];
          var rds = React.useState(false); var recentDroppedOnly = rds[0]; var setRecentDroppedOnly = rds[1];

          var load = function () {
            setError(null);
            Promise.all([
              scoped.remote.hubBotSettings.read(),
              scoped.remote.hubBotSettings.listOwners(),
              scoped.remote.hubBotSettings.modelCatalog(),
              scoped.remote.hubBotSettings.overview(),
            ]).then(function (r) {
              var v = unwrap(r[0]); var ow = unwrap(r[1]); var cat = unwrap(r[2]); var board = unwrap(r[3]);
              setView(v); setOwners(Array.isArray(ow) ? ow : []); setCatalog(cat); setOverview(board);
              setLastLoadedAt(new Date().toISOString());
              var m = v.chief && v.chief.model;
              setModelChoice(m ? m.provider + '/' + m.model : '');
            }).catch(function (e) { setError(e && e.message ? e.message : String(e)); });
          };
          React.useEffect(load, []);
          // 成功提示条（round 28）: 动作成功也要看得见——3.5s 自动消，序号防旧定时器清掉新提示。
          var flashNotice = function (text) {
            var seq = ++noticeSeq.current;
            setNotice(text);
            setTimeout(function () { if (noticeSeq.current === seq) setNotice(''); }, 3500);
          };
          // 自动刷新（round 7）: 每 15s 拉一次 overview——新消息/票据状态变化不用手动刷新页面。
          // 只刷 overview 不刷 view: RowConfig 的表单正在编辑时不能被远端值覆盖。
          // 页面藏进后台（document.hidden）时暂停，失败静默——下一轮自然会再试。
          React.useEffect(function () {
            var timer = setInterval(function () {
              if (typeof document !== 'undefined' && document.hidden) return;
              scoped.remote.hubBotSettings.overview()
                .then(function (raw) { setOverview(unwrap(raw)); })
                .catch(function () {});
            }, 15000);
            return function () { clearInterval(timer); };
          }, []);
          // 死信重投（健康警告条操作闭环）: 单条或全部，成功后整体刷新（overview 在 load 里）。
          var retryOutbox = function (idOrNull) {
            var req = idOrNull === null ? { all: true } : { id: idOrNull };
            scoped.remote.hubBotSettings.retryOutbox(req)
              .then(function (raw) {
                if (raw && raw.ok === false) { setError((raw.error && raw.error.message) || 'retry failed'); return; }
                var res = unwrap(raw);
                flashNotice(fill(t('retriedNotice'), (res && res.retried) || 0));
                load();
              })
              .catch(function (e) { setError(e && e.message ? e.message : String(e)); });
          };
          var discardOutbox = function (idOrNull) {
            var req = idOrNull === null ? { all: true } : { id: idOrNull };
            scoped.remote.hubBotSettings.discardOutbox(req)
              .then(function (raw) {
                if (raw && raw.ok === false) { setError((raw.error && raw.error.message) || 'discard failed'); return; }
                var res = unwrap(raw);
                flashNotice(fill(t('discardedNotice'), (res && res.discarded) || 0));
                load();
              })
              .catch(function (e) { setError(e && e.message ? e.message : String(e)); });
          };
          var retryBtnStyle = {
            font: 'inherit', fontSize: '11px', padding: '2px 8px', borderRadius: '5px', cursor: 'pointer',
            border: '1px solid rgba(230,160,40,0.5)', background: 'transparent', color: 'inherit', opacity: 0.9,
          };
          var refreshView = function () {
            scoped.remote.hubBotSettings.read()
              .then(function (raw) { setView(unwrap(raw)); })
              .catch(function () { /* 轮询失败静默——下一次再试 */ });
          };

          var saveModel = function () {
            setModelBusy(true); setModelDone(false); setError(null);
            var patch;
            if (modelChoice === '') patch = { chief: { model: null } };
            else {
              var i = modelChoice.indexOf('/');
              patch = { chief: { model: { provider: modelChoice.slice(0, i), model: modelChoice.slice(i + 1) } } };
            }
            scoped.remote.hubBotSettings.update(patch)
              .then(function (v) { setView(unwrap(v)); setModelDone(true); })
              .catch(function (e) { setError(t('modelFailed') + ': ' + (e && e.message ? e.message : String(e))); })
              .finally(function () { setModelBusy(false); });
          };

          var as2 = React.useState({}); var answers = as2[0]; var setAnswers = as2[1];
          var sls = React.useState({}); var selected = sls[0]; var setSelected = sls[1];
          var bbs = React.useState(false); var batchBusy = bbs[0]; var setBatchBusy = bbs[1];
          var hvs = React.useState(null); var hoverTicket = hvs[0]; var setHoverTicket = hvs[1];
          var resolve = function (tk, resolution) {
            var label = resolution === 'confirm' ? t('confirmBtn') : resolution === 'accept' ? t('acceptBtn') : resolution === 'retry' ? t('retryTicketBtn') : resolution === 'cancel' ? t('cancelTicketBtn') : t('rejectBtn');
            if (!window.confirm(label + ' — ' + (tk.pendingConfirm && tk.pendingConfirm.text ? tk.pendingConfirm.text : tk.id))) return;
            setResolving(tk.id + ':' + resolution); setError(null);
            scoped.remote.hubBotSettings.resolveTicket({ ticketId: tk.id, resolution: resolution })
              .then(function (raw) {
                // 错误信封（round 42）：网关把 RemoteError 解析成 {ok:false,error} 而非 reject——不检查就会误报成功。
                if (raw && raw.ok === false) { setError(t('resolveFailed') + ': ' + (raw.error && raw.error.message ? raw.error.message : 'unknown')); return; }
                var doneKey = resolution === 'confirm' ? 'confirmDone' : resolution === 'accept' ? 'acceptDone' : resolution === 'retry' ? 'retryDone' : resolution === 'cancel' ? 'cancelDone' : 'rejectDone';
                flashNotice(t(doneKey));
                load();
              })
              .catch(function (e) { setError(t('resolveFailed') + ': ' + (e && e.message ? e.message : String(e))); })
              .finally(function () { setResolving(null); });
          };

          // 批量裁决（round 24）: 危险命令挂起一多，逐个点确认很费手。
          // 只对 person/confirm 可勾选；确认/拒绝串行执行，失败计数兜底，结束统一刷新。
          var batchResolve = function (resolution) {
            if (batchBusy) return;
            var ids = needs.filter(function (tk) { return tk.stage === 'person/confirm' && selected[tk.id]; }).map(function (tk) { return tk.id; });
            if (ids.length === 0) return;
            var label = resolution === 'confirm' ? t('confirmBtn') : t('rejectBtn');
            if (!window.confirm(label + ' × ' + ids.length)) return;
            setBatchBusy(true); setError(null);
            var failed = 0;
            var chain = Promise.resolve();
            ids.forEach(function (id) {
              chain = chain.then(function () {
                return scoped.remote.hubBotSettings.resolveTicket({ ticketId: id, resolution: resolution })
                  .catch(function () { failed++; });
              });
            });
            chain.then(function () {
              setSelected({}); setBatchBusy(false);
              if (failed > 0) setError(fill(t('batchFailed'), failed));
              else flashNotice(fill(t(resolution === 'confirm' ? 'batchConfirmed' : 'batchRejected'), ids.length));
              load();
            });
          };

          // 回答问题（round 8）: person/answer 不再是只读——面板直接回复，票回 working。
          var answerTicket = function (tk) {
            var text = String(answers[tk.id] || '').trim();
            if (!text) return;
            setResolving(tk.id + ':answer'); setError(null);
            scoped.remote.hubBotSettings.resolveTicket({ ticketId: tk.id, resolution: 'answer', message: text })
              .then(function (raw) {
                if (raw && raw.ok === false) { setError((raw.error && raw.error.message) || 'answer failed'); return; }
                var next = Object.assign({}, answers); delete next[tk.id]; setAnswers(next);
                flashNotice(t('answerDone'));
                load();
              })
              .catch(function (e) { setError(t('resolveFailed') + ': ' + (e && e.message ? e.message : String(e))); })
              .finally(function () { setResolving(null); });
          };

          if (error && !view) {
            return h('div', { style: { padding: '20px 24px' } },
              h('p', null, t('loadFailed') + ': ' + error),
              h('button', { onClick: load, style: Object.assign({}, inputStyle, { width: 'auto', padding: '6px 16px' }) }, t('retry')));
          }
          if (!view || !owners || !overview) return h('p', { style: { padding: '20px 24px' } }, t('loading'));

          var feishu = view.feishu || {};
          var fs = feishu.status || {};
          var feishuOn = feishu.enabled && (fs.wsState === 'connected' || fs.wsState === 'ready');
          var feishuText = !feishu.enabled ? t('disabled')
            : feishuOn ? t('connected') : (fs.wsState || t('notConnected'));
          var feishuColor = !feishu.enabled ? 'rgba(140,140,140,0.6)' : feishuOn ? '#46bb6d' : '#e06060';
          var github = view.github || {};
          var followed = github.followed || [];
          var githubText = !github.enabled ? t('disabled') : fill(t('watching'), followed.length);
          var githubColor = !github.enabled ? 'rgba(140,140,140,0.6)' : '#6b97ff';
          // 副标（turn 109 信息密度）: 飞书卡显示 bot 名；负责人卡显示活跃会话数。
          var feishuSub = feishuOn && fs.bot && fs.bot.name ? fs.bot.name : null;
          // 未受理消息可见性（round 26）: 状态卡直接提示最近一条 dropped，省得翻到最近消息区才发现。
          var lastDropped = (overview.recentTriggers || []).filter(function (tr) { return tr.dropped; })[0] || null;
          var activeSessions = owners.filter(function (o) { return !!o.sessionId; }).length;
          var ownersSub = fill(t('activeSessions'), activeSessions);
          var cardSubStyle = { fontSize: '11px', opacity: 0.6, marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

          var tickets = overview.tickets || [];
          var needs = tickets.filter(function (tk) { return NEEDS_ME.indexOf(tk.stage) >= 0; });
          var confirmable = needs.filter(function (tk) { return tk.stage === 'person/confirm'; });
          // 状态卡第四张（round 32）: 待办计数 + 阶段分解副标。
          var needsStages = [];
          needs.forEach(function (tk) {
            var found = null;
            for (var i = 0; i < needsStages.length; i++) if (needsStages[i].stage === tk.stage) found = needsStages[i];
            if (!found) { found = { stage: tk.stage, label: tk.stageText || tk.stage, count: 0 }; needsStages.push(found); }
            found.count++;
          });
          var needsCardSub = needs.length === 0 ? t('quiet') : needsStages.map(function (s) { return s.label + ' ' + s.count; }).join(' · ');
          var selectedCount = confirmable.filter(function (tk) { return selected[tk.id]; }).length;
          var allSelected = confirmable.length > 0 && selectedCount === confirmable.length;
          // 任务流过滤器（round 7）: 文本（消息/负责人/工单号）+ 阶段。只作用于任务流区，
          // 「需要我处理」永远完整呈现——裁决入口不能被过滤器藏起来。
          var filtered = tickets.filter(function (tk) {
            if (filterStage && tk.stage !== filterStage) return false;
            if (filterOwner && (tk.ownerLabel || tk.owner) !== filterOwner) return false;
            if (!filterText) return true;
            var q = filterText.toLowerCase();
            return (tk.message || '').toLowerCase().indexOf(q) >= 0
              || (tk.ownerLabel || tk.owner || '').toLowerCase().indexOf(q) >= 0
              || (tk.id || '').toLowerCase().indexOf(q) >= 0;
          });
          var presentStages = STAGE_ORDER.filter(function (st) { return tickets.some(function (tk) { return tk.stage === st; }); });
          var presentOwners = [...new Set(tickets.map(function (tk) { return tk.ownerLabel || tk.owner; }).filter(Boolean))].sort();
          var healthItems = healthProblems(overview.health || {}, t);
          var recent = overview.recentTriggers || [];
          var recentFiltered = recent.filter(function (tr) {
            if (recentKind && tr.kind !== recentKind) return false;
            if (recentDroppedOnly && !tr.dropped) return false;
            return true;
          });
          var recentFilterActive = recentKind !== '' || recentDroppedOnly;
          var kindLabel = function (k) { return k === 'feishu' ? t('kindFeishu') : k === 'github' ? t('kindGitHub') : t('kindRoute'); };
          // 消息 → 票据定位（round 8）: 点一条最近消息 = 按工单号过滤任务流并滚过去。
          var locateTicket = function (ticketId) {
            setFilterText(ticketId); setFilterStage('');
            var el = document.getElementById('hub-bot-stream');
            if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
          // 通用复制（round 37）：报告全文/负责人路径/票据 id 共用一套翻转反馈，key 区分来源。
          var copyText = function (text, key) {
            var done = function () { setCopiedId(key); setTimeout(function () { setCopiedId(''); }, 1200); };
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
                return;
              }
            } catch (e) { /* fall through */ }
            legacyCopy(text); done();
          };
          var copyTicketId = function (id) { copyText(id, id); };
          var legacyCopy = function (text) {
            try {
              var ta = document.createElement('textarea');
              ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select(); document.execCommand('copy');
              document.body.removeChild(ta);
            } catch (e) { /* 剪贴板不可达就算了 */ }
          };
          var filterActive = !!filterText || !!filterStage || !!filterOwner;
          var scrollToSection = function (id) {
            var el = document.getElementById(id);
            if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
          var clickableCard = function (targetId) {
            return targetId ? { cursor: 'pointer' } : {};
          };

          var ticketRowItem = function (tk, withActions) {
            var rows = [];
            rows.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
              stagePill(tk.stage, tk.stageText || tk.stage),
              h('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, tk.ownerLabel || tk.owner),
              h('span', { style: { flex: 1, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: tk.message || '' }, tk.message || '（无原文）'),
              tk.recoveryPending ? h('span', { title: t('recoveringHint') }, stagePill('queued', t('recovering'))) : null,
              h('span', { style: { fontSize: '12px', opacity: 0.55, whiteSpace: 'nowrap' } }, relTime(t, tk.updatedAt))));
            if (tk.pendingConfirm) rows.push(h('div', { key: 'pc', style: { marginTop: '6px', fontSize: '13px', color: TONES.amber.fg } }, t('pendingConfirmLabel') + tk.pendingConfirm.text));
            // 确认语义透明化： 危险注入挂起 → 确认=原样投递；fork 提案（无 action）→ 确认=fork 副本续作。
            if (tk.pendingConfirm && tk.stage === 'person/confirm') {
              var pcAction = tk.pendingConfirm.action;
              var isDanger = pcAction && pcAction.type === 'dangerous-inject';
              rows.push(h('div', { key: 'pca', style: { marginTop: '3px', fontSize: '12px', opacity: 0.7 } },
                isDanger ? t('confirmActionInject') : t('confirmActionFork')));
              // fork 提案： action 携带结构化字段（sessionId/cwd/atSeq/reason），拆成明细行免读长文。
              if (!isDanger && pcAction && pcAction.type === 'fork') {
                var forkRows = [
                  [t('forkColSession'), pcAction.sessionId || '—'],
                  [t('forkColCwd'), pcAction.cwd || '—'],
                ];
                if (pcAction.atSeq !== undefined && pcAction.atSeq !== null) forkRows.push([t('forkColAtSeq'), fill(t('forkAtSeqValue'), pcAction.atSeq)]);
                forkRows.push([t('forkColReason'), pcAction.reason || '—']);
                rows.push(h('div', { key: 'pfd', style: { marginTop: '6px', padding: '8px 10px', borderRadius: '6px', background: 'rgba(127,127,127,0.06)', border: '1px solid rgba(127,127,127,0.14)' } },
                  h('div', { style: { fontSize: '11px', opacity: 0.55, marginBottom: '4px' } }, t('forkDetail')),
                  forkRows.map(function (pair, i) {
                    return h('div', { key: i, style: { display: 'flex', gap: '10px', fontSize: '12px', lineHeight: '1.8' } },
                      h('span', { style: { minWidth: '58px', opacity: 0.55, flexShrink: 0 } }, pair[0]),
                      h('span', { style: { fontFamily: i === forkRows.length - 1 ? 'inherit' : 'monospace', wordBreak: 'break-all' } }, pair[1]));
                  })));
              }
              // 文案只摘录 200 字——完整挂起内容折叠可查（确认对象的全文不该靠猜）。
              if (isDanger && typeof pcAction.message === 'string' && pcAction.message.length > 0) {
                rows.push(h('details', { key: 'pcf', style: { marginTop: '4px', fontSize: '12px' } },
                  h('summary', { style: { cursor: 'pointer', opacity: 0.65 } }, t('confirmFullText')),
                  h('pre', { style: { margin: '6px 0 0', padding: '8px 10px', borderRadius: '6px', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.16)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: '11px', maxHeight: '160px', overflowY: 'auto' } }, pcAction.message)));
              }
            }
            if (tk.question && tk.stage === 'person/answer') rows.push(h('div', { key: 'q', style: { marginTop: '6px', fontSize: '13px', color: TONES.amber.fg } }, t('questionLabel') + tk.question.text));
            // 等验收时报告就是要审的内容——直接摆出来，不藏进「详情」。
            if (tk.stage === 'person/review' && tk.report && (tk.report.summary || tk.report.text)) {
              rows.push(h('div', { key: 'rp', style: { marginTop: '6px', fontSize: '13px', color: TONES.blue.fg, whiteSpace: 'pre-wrap', display: 'flex', alignItems: 'flex-start', gap: '8px' } },
                h('span', { style: { flex: 1, minWidth: 0 } }, t('reportLabel') + (tk.report.summary || tk.report.text)),
                h('button', { onClick: function (ev) { ev.preventDefault(); copyText(tk.report.summary || tk.report.text, 'rp:' + tk.id); }, title: t('copyReportHint'), style: { fontSize: '10px', padding: '0 7px', borderRadius: '5px', cursor: 'pointer', flexShrink: 0, background: copiedId === 'rp:' + tk.id ? 'rgba(70,180,100,0.14)' : 'rgba(127,127,127,0.1)', color: copiedId === 'rp:' + tk.id ? TONES.green.fg : 'inherit', border: '1px solid ' + (copiedId === 'rp:' + tk.id ? TONES.green.border : 'rgba(127,127,127,0.25)'), opacity: copiedId === 'rp:' + tk.id ? 1 : 0.6 } }, copiedId === 'rp:' + tk.id ? t('copiedBtn') : t('copyReportBtn'))));
            }
            // 结果在哪（三问之一）: 等验收票的产物目录——投影层早已产出 dirListing，这里补上渲染。
            if (tk.stage === 'person/review' && Array.isArray(tk.dirListing) && tk.dirListing.length > 0) {
              rows.push(h('div', { key: 'art', style: { marginTop: '8px' } },
                h('div', { style: { fontSize: '11px', opacity: 0.55, marginBottom: '4px' } }, t('artifactsLabel')),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: '88px', overflowY: 'auto' } },
                  tk.dirListing.map(function (name, i) {
                    var isDir = name.endsWith('/');
                    return h('span', { key: i, style: {
                      fontFamily: 'monospace', fontSize: '11px', padding: '1px 7px', borderRadius: '5px',
                      background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.16)',
                      color: isDir ? TONES.blue.fg : 'inherit', opacity: isDir ? 1 : 0.8,
                    } }, name);
                  }))));
            }
            if (withActions && tk.stage === 'person/confirm') {
              rows.push(h('div', { key: 'act', style: { marginTop: '8px', display: 'flex', gap: '8px' } },
                h('button', {
                  onClick: function () { resolve(tk, 'confirm'); }, disabled: resolving !== null,
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(60,180,100,0.15)', border: '1px solid ' + TONES.green.border, color: TONES.green.fg }),
                }, resolving === tk.id + ':confirm' ? '…' : t('confirmBtn')),
                h('button', {
                  onClick: function () { resolve(tk, 'reject'); }, disabled: resolving !== null,
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(220,80,80,0.12)', border: '1px solid ' + TONES.red.border, color: TONES.red.fg }),
                }, resolving === tk.id + ':reject' ? '…' : t('rejectBtn'))));
            }
            // 取消（round 43）: idle/queued 票还没开始执行，可以直接关闭——任务流（只读区）里也放行。
            if (tk.stage === 'idle' || tk.stage === 'queued') {
              rows.push(h('div', { key: 'cancel', style: { marginTop: '8px', display: 'flex', gap: '8px' } },
                h('button', {
                  onClick: function () { resolve(tk, 'cancel'); }, disabled: resolving !== null,
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(220,80,80,0.12)', border: '1px solid ' + TONES.red.border, color: TONES.red.fg }),
                }, resolving === tk.id + ':cancel' ? '…' : t('cancelTicketBtn'))));
            }
            // 重新尝试（round 42）: blocked/failed 票一键回到 working（状态机注入重试说明）。
            if (withActions && (tk.stage === 'blocked' || tk.stage === 'failed')) {
              rows.push(h('div', { key: 'retry', style: { marginTop: '8px', display: 'flex', gap: '8px' } },
                h('button', {
                  onClick: function () { resolve(tk, 'retry'); }, disabled: resolving !== null,
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(80,140,255,0.15)', border: '1px solid ' + TONES.blue.border, color: TONES.blue.fg }),
                }, resolving === tk.id + ':retry' ? '…' : t('retryTicketBtn'))));
            }
            if (withActions && tk.stage === 'person/answer') {
              rows.push(h('div', { key: 'ans', style: { marginTop: '8px', display: 'flex', gap: '8px' } },
                h('input', {
                  style: Object.assign({}, inputStyle, { flex: 1, padding: '5px 12px', fontSize: '13px' }),
                  value: answers[tk.id] || '', placeholder: t('answerPlaceholder'),
                  onChange: function (ev) { setAnswers(Object.assign({}, answers, (function () { var m = {}; m[tk.id] = ev.target.value; return m; })())); },
                  onKeyDown: function (ev) { if (ev.key === 'Enter') answerTicket(tk); },
                }),
                h('button', {
                  onClick: function () { answerTicket(tk); },
                  disabled: resolving !== null || !String(answers[tk.id] || '').trim(),
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(80,140,255,0.15)', border: '1px solid ' + TONES.blue.border, color: TONES.blue.fg }),
                }, resolving === tk.id + ':answer' ? '…' : t('answerBtn'))));
            }
            if (withActions && tk.stage === 'person/review') {
              rows.push(h('div', { key: 'rev', style: { marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                  onClick: function () { resolve(tk, 'accept'); }, disabled: resolving !== null,
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(60,180,100,0.15)', border: '1px solid ' + TONES.green.border, color: TONES.green.fg }),
                }, resolving === tk.id + ':accept' ? '…' : t('acceptBtn')),
                h('input', {
                  style: Object.assign({}, inputStyle, { flex: '1 1 220px', padding: '5px 12px', fontSize: '13px' }),
                  value: answers[tk.id] || '', placeholder: t('reworkPlaceholder'),
                  onChange: function (ev) { setAnswers(Object.assign({}, answers, (function () { var m = {}; m[tk.id] = ev.target.value; return m; })())); },
                  onKeyDown: function (ev) { if (ev.key === 'Enter') answerTicket(tk); },
                }),
                h('button', {
                  onClick: function () { answerTicket(tk); },
                  disabled: resolving !== null || !String(answers[tk.id] || '').trim(),
                  style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 18px', cursor: 'pointer', background: 'rgba(230,160,40,0.13)', border: '1px solid ' + TONES.amber.border, color: TONES.amber.fg }),
                }, resolving === tk.id + ':answer' ? '…' : t('reworkBtn'))));
            }
            // 时间线（round 11）: 创建→分派→提问→确认→报告→当前，按时间排序。
            // 字段以 tasks.js 为准： report.summary / pendingConfirm.text / assignment.endReason。
            var evs = [];
            if (tk.createdAt) evs.push({ at: tk.createdAt, tone: 'muted', label: t('tlCreated'), detail: tk.authorization ? tk.authorization.actor + ' · ' + tk.authorization.source : null });
            (tk.assignments || []).forEach(function (a) {
              if (a.at) evs.push({ at: a.at, tone: 'blue', label: t('tlAssign'), detail: a.sessionId ? String(a.sessionId).replace(/^session-/, '').slice(0, 8) : null, copy: a.sessionId || null });
              if (a.endedAt) evs.push({ at: a.endedAt, tone: 'muted', label: t('tlAssignEnd'), detail: a.endReason || null });
            });
            if (tk.question && tk.question.at) evs.push({ at: tk.question.at, tone: 'amber', label: t('tlQuestion'), detail: tk.question.text });
            if (tk.pendingConfirm && tk.pendingConfirm.at) evs.push({ at: tk.pendingConfirm.at, tone: 'amber', label: t('tlConfirm'), detail: tk.pendingConfirm.text });
            if (tk.report && tk.report.at) evs.push({ at: tk.report.at, tone: 'blue', label: t('tlReport'), detail: tk.report.summary || '' });
            evs.push({ at: tk.updatedAt || tk.createdAt, tone: STAGE_TONE[tk.stage] || 'gray', label: tk.stageText || tk.stage, detail: null, current: true });
            evs.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
            rows.push(h('details', { key: 'd', style: { marginTop: '6px', fontSize: '12px', opacity: 0.85 } },
              h('summary', { style: { cursor: 'pointer' } }, t('detailToggle')),
              h('div', { style: { marginTop: '6px', paddingLeft: '4px', display: 'flex', flexDirection: 'column' } },
                evs.map(function (ev, i) {
                  var tone = TONES[ev.tone] || TONES.gray;
                  return h('div', { key: i, style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '2px 0' } },
                    h('span', { style: { flexShrink: 0, width: '8px', height: '8px', borderRadius: '999px', background: ev.current ? tone.border : 'transparent', border: '2px solid ' + tone.border, alignSelf: 'center' } }),
                    h('span', { style: { flexShrink: 0, opacity: 0.5, fontFamily: 'monospace', fontSize: '11px', minWidth: '42px' }, title: ev.at || '' }, ev.at ? hhmm(ev.at) : '—'),
                    h('span', { style: { flexShrink: 0, color: tone.fg, fontWeight: ev.current ? 600 : 400 } }, ev.label),
                    ev.detail ? h('span', {
                      style: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: ev.copy ? 'pointer' : 'default', color: ev.copy && copiedId === 'tl:' + ev.copy ? TONES.green.fg : undefined },
                      title: ev.copy ? ev.copy + String.fromCharCode(10) + t('copySessionHint') : undefined,
                      onClick: ev.copy ? function (e2) { e2.preventDefault(); copyText(ev.copy, 'tl:' + ev.copy); } : undefined,
                    }, ev.detail) : null);
                })),
               h('div', { style: { marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px' } },
                 h('span', { style: { opacity: 0.5, fontFamily: 'monospace', fontSize: '11px' } }, tk.id),
                 h('button', {
                   onClick: function (ev) { ev.preventDefault(); copyTicketId(tk.id); },
                   title: t('copyIdHint'),
                   style: { fontSize: '10px', padding: '0 7px', borderRadius: '5px', cursor: 'pointer',
                     background: copiedId === tk.id ? 'rgba(70,180,100,0.14)' : 'rgba(127,127,127,0.1)',
                     color: copiedId === tk.id ? TONES.green.fg : 'inherit',
                     border: '1px solid ' + (copiedId === tk.id ? TONES.green.border : 'rgba(127,127,127,0.25)'),
                     opacity: copiedId === tk.id ? 1 : 0.6 },
                 }, copiedId === tk.id ? t('copiedBtn') : t('copyIdBtn')))));
            var stageTone = TONES[STAGE_TONE[tk.stage] || 'gray'];
            var isHover = hoverTicket === tk.id;
            return h('div', {
              key: tk.id,
              onMouseEnter: function () { setHoverTicket(tk.id); },
              onMouseLeave: function () { setHoverTicket(null); },
              style: {
              padding: '10px 12px', borderRadius: '8px', marginBottom: '8px',
              border: '1px solid var(--dsh-border, rgba(127,127,127,0.2))',
              borderLeft: '3px solid ' + stageTone.border,
              background: 'var(--dsh-surface-raised, rgba(127,127,127,0.04))',
              boxShadow: isHover ? '0 0 0 1.5px rgba(120,170,255,0.55)' : 'none',
              transition: 'box-shadow 120ms ease',
            } }, rows);
          };

          var savedChoice = view && view.chief && view.chief.model ? view.chief.model.provider + '/' + view.chief.model.model : '';
          var modelDirty = modelChoice !== savedChoice;
          var modelOptions = [h('option', { key: '', value: '' }, t('modelFollow'))];
          if (catalog && catalog.groups) {
            catalog.groups.forEach(function (g) {
              modelOptions.push(h('optgroup', { key: g.id, label: g.name || g.id },
                (g.models || []).map(function (m) {
                  var val = g.id + '/' + m.id;
                  var label = (m.name || m.id) + (m.reasoning ? ' · reasoning' : '') + (m.badge ? ' · ' + m.badge : '');
                  return h('option', { key: val, value: val }, label);
                })));
            });
          }
          // 默认透明化（round 38）：「跟随部署默认」要看得见默认到底是谁。
          var defaultModelLabel = null;
          if (catalog && catalog.groups && catalog.default && catalog.default.provider) {
            var dg = null;
            catalog.groups.forEach(function (g) { if (g.id === catalog.default.provider) dg = g; });
            var dm = dg ? (dg.models || []).find(function (m) { return m.id === catalog.default.model; }) : null;
            defaultModelLabel = (dg ? (dg.name || dg.id) : catalog.default.provider) + ' · ' + (dm ? (dm.name || dm.id) : (catalog.default.model || '?'));
          }

          return h('div', { style: { padding: '20px 24px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
            h('h2', { style: { fontSize: '17px', fontWeight: 600, margin: '0 0 18px' } }, t('title')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
              h('span', { style: { fontSize: '16px', fontWeight: 700 } }, 'Hub Bot'),
              view && view.version ? h('span', { style: { fontSize: '11px', fontFamily: 'monospace', padding: '1px 8px', borderRadius: '999px', background: 'rgba(127,127,127,0.1)', border: '1px solid rgba(127,127,127,0.2)', opacity: 0.75 } }, 'v' + view.version) : null,
              lastLoadedAt ? h('span', { style: { fontSize: '11px', opacity: 0.55 } }, t('updatedAt') + ' ' + relTime(t, lastLoadedAt)) : null,
              h('span', { style: { fontSize: '11px', opacity: 0.4 } }, t('autoRefreshHint')),
              h('button', { onClick: function () { load(); }, title: t('refreshHint'), style: { marginLeft: 'auto', fontSize: '11px', padding: '3px 12px', borderRadius: '6px', cursor: 'pointer', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.22)', opacity: 0.85 } }, '\u21bb ' + t('refreshBtn'))),
            h('div', { style: cardRowStyle },
              h('div', { style: Object.assign({}, cardStyle, clickableCard('hub-bot-feishu')), onClick: function () { scrollToSection('hub-bot-feishu'); }, title: t('cardJumpHint') }, h('div', { style: cardTitleStyle }, t('feishuCard')), h('div', { style: cardValueStyle }, dot(feishuColor), feishuText), feishuSub ? h('div', { style: cardSubStyle }, feishuSub) : null,
                lastDropped ? h('div', { style: Object.assign({}, cardSubStyle, { color: TONES.amber.fg, opacity: 0.85 }), title: lastDropped.message || '' },
                  t('droppedCardHint') + ' ' + relTime(t, lastDropped.at) + ' · ' + String(lastDropped.dropped).slice(0, 24)) : null),
              h('div', { style: Object.assign({}, cardStyle, clickableCard('hub-bot-github')), onClick: function () { scrollToSection('hub-bot-github'); }, title: t('cardJumpHint') }, h('div', { style: cardTitleStyle }, t('githubCard')), h('div', { style: cardValueStyle }, dot(githubColor), githubText)),
              h('div', { style: Object.assign({}, cardStyle, clickableCard('hub-bot-owners')), onClick: function () { scrollToSection('hub-bot-owners'); }, title: t('cardJumpHint') }, h('div', { style: cardTitleStyle }, t('ownersCard')), h('div', { style: cardValueStyle }, String(owners.length)), h('div', { style: cardSubStyle }, ownersSub)),
              h('div', { style: Object.assign({}, cardStyle, clickableCard('hub-bot-needs')), onClick: function () { scrollToSection('hub-bot-needs'); }, title: t('cardJumpHint') }, h('div', { style: cardTitleStyle }, t('needsCard')), h('div', { style: cardValueStyle }, dot(needs.length > 0 ? TONES.amber.fg : '#46bb6d'), String(needs.length)), h('div', { style: cardSubStyle }, needsCardSub))),
            healthItems.length ? h('div', { style: {
              padding: '10px 14px', borderRadius: '8px', marginBottom: '18px', fontSize: '13px',
              background: 'rgba(230,160,40,0.1)', border: '1px solid rgba(230,160,40,0.35)', color: TONES.amber.fg,
              display: 'flex', flexDirection: 'column', gap: '4px',
            } }, healthItems.map(function (item, i) { return h('div', { key: i }, '⚠ ' + item); }),
              // outbox 重试详情（重试中的投递逐条列出——哪张票、发给谁、第几次、下次什么时候、为什么失败）
              (overview.health && overview.health.outbox && (overview.health.outbox.retrying || []).length > 0)
                ? h('details', { style: { marginTop: '4px' } },
                    h('summary', { style: { cursor: 'pointer', opacity: 0.85 } }, t('healthDetailRetry') + ' · ' + overview.health.outbox.retrying.length),
                    overview.health.outbox.retrying.map(function (r0) {
                      return h('div', { key: r0.id, style: { marginTop: '6px', padding: '6px 8px', background: 'rgba(0,0,0,0.18)', borderRadius: '6px', fontSize: '12px', borderLeft: '2px solid ' + TONES.amber.border } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                          h('span', { style: { fontSize: '10px', padding: '0 6px', borderRadius: '999px', background: TONES.amber.bg, color: TONES.amber.fg, border: '1px solid ' + TONES.amber.border, flexShrink: 0 } }, t('healthPillRetrying')),
                          h('span', null, (r0.to || '') + ' — ' + (r0.ticketId || '—'))),
                        h('div', { style: { opacity: 0.75, marginTop: '2px' } }, t('healthDetailNext') + ': ' + (r0.nextRetryAt ? relTime(t, r0.nextRetryAt) : '—')),
                        r0.lastError ? h('div', { style: { opacity: 0.75, marginTop: '2px', wordBreak: 'break-all' } }, t('healthDetailLast') + ': ' + String(r0.lastError).slice(0, 140)) : null);
                    })) : null,
              // 死信详情（failed 行——重试耗尽后的最终失败，逐条可查）
              (overview.health && overview.health.outbox && (overview.health.outbox.failedList || []).length > 0)
                ? h('details', { style: { marginTop: '4px' } },
                    h('summary', { style: { cursor: 'pointer', color: TONES.red.fg, opacity: 0.9 } }, t('healthDetailDead') + ' · ' + overview.health.outbox.failedList.length),
                    h('div', { style: { marginTop: '4px' } },
                      h('button', { style: retryBtnStyle, onClick: function (ev) { ev.preventDefault(); retryOutbox(null); } }, t('retryAll')),
                      h('button', { style: Object.assign({}, retryBtnStyle, { color: TONES.red.fg, borderColor: TONES.red.border }), title: t('discardAllHint'), onClick: function (ev) { ev.preventDefault(); if (window.confirm(t('discardAllConfirm'))) discardOutbox(null); } }, t('discardAll'))),
                    overview.health.outbox.failedList.map(function (r0) {
                      return h('div', { key: r0.id, style: { marginTop: '6px', padding: '6px 8px', background: 'rgba(0,0,0,0.18)', borderRadius: '6px', fontSize: '12px', borderLeft: '2px solid ' + TONES.red.border } },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
                          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
                            h('span', { style: { fontSize: '10px', padding: '0 6px', borderRadius: '999px', background: TONES.red.bg, color: TONES.red.fg, border: '1px solid ' + TONES.red.border, flexShrink: 0 } }, t('healthPillDead')),
                            h('span', null, (r0.to || '') + ' — ' + (r0.ticketId || '—') + ' · ' + r0.attempts + ' 次尝试')),
                          h('button', { style: retryBtnStyle, onClick: function () { retryOutbox(r0.id); } }, t('retryOne')),
                          h('button', { style: Object.assign({}, retryBtnStyle, { color: TONES.red.fg, borderColor: TONES.red.border }), title: t('discardOneHint'), onClick: function () { discardOutbox(r0.id); } }, t('discardOne'))),
                        r0.lastError ? h('div', { style: { opacity: 0.75, marginTop: '2px', wordBreak: 'break-all' } }, t('healthDetailLast') + ': ' + String(r0.lastError).slice(0, 140)) : null);
                    })) : null) : null,
             h('div', { id: 'hub-bot-needs', style: Object.assign({}, sectionStyle, needs.length > 0 ? { borderLeft: '3px solid ' + TONES.amber.border, paddingLeft: '14px' } : {}) },
               h('div', { style: Object.assign({}, sectionTitleStyle, { display: 'flex', alignItems: 'center', gap: '8px' }) },
                 h('span', null, t('needsMe'),
                   needs.length > 0 ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, color: TONES.amber.fg } }, '· ' + needs.length) : null),
                 confirmable.length >= 2
                   ? h('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: '6px', alignItems: 'center', fontWeight: 400 } },
                       h('button', {
                         style: { fontSize: '11px', padding: '2px 10px', borderRadius: '6px', cursor: 'pointer', background: 'rgba(127,127,127,0.1)', border: '1px solid rgba(127,127,127,0.3)', color: 'inherit' },
                         onClick: function () {
                           if (allSelected) { setSelected({}); return; }
                           var next = {}; confirmable.forEach(function (tk) { next[tk.id] = true; }); setSelected(next);
                         },
                       }, allSelected ? t('selectNone') : t('selectAll')),
                       selectedCount > 0
                         ? h('button', {
                             style: { fontSize: '11px', padding: '2px 10px', borderRadius: '6px', cursor: batchBusy ? 'default' : 'pointer', background: 'rgba(70,180,100,0.16)', border: '1px solid ' + TONES.green.border, color: TONES.green.fg },
                             disabled: batchBusy,
                             onClick: function () { batchResolve('confirm'); },
                           }, batchBusy ? t('batchRunning') : fill(t('batchConfirm'), selectedCount))
                         : null,
                       selectedCount > 0
                         ? h('button', {
                             style: { fontSize: '11px', padding: '2px 10px', borderRadius: '6px', cursor: batchBusy ? 'default' : 'pointer', background: 'rgba(220,80,80,0.14)', border: '1px solid ' + TONES.red.border, color: TONES.red.fg },
                             disabled: batchBusy,
                             onClick: function () { batchResolve('reject'); },
                           }, batchBusy ? t('batchRunning') : fill(t('batchReject'), selectedCount))
                         : null)
                   : null),
               needs.length === 0
                 ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 15px', borderRadius: '10px', background: 'rgba(70,180,100,0.07)', border: '1px solid rgba(70,180,100,0.22)' } },
                      h('span', { style: { fontSize: '16px', width: '28px', height: '28px', lineHeight: '27px', textAlign: 'center', borderRadius: '50%', background: TONES.green.bg, border: '1px solid ' + TONES.green.border, color: TONES.green.fg, flexShrink: 0 } }, '✓'),
                      h('div', null,
                        h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('quiet')),
                        h('div', { style: { fontSize: '12px', opacity: 0.65, marginTop: '2px' } }, t('quietHint'))))
                 : needs.map(function (tk) {
                     var card = ticketRowItem(tk, true);
                     if (confirmable.length < 2 || tk.stage !== 'person/confirm') return card;
                     var on = !!selected[tk.id];
                     return h('div', { key: 'sel-' + tk.id, style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
                       h('input', {
                         type: 'checkbox', checked: on,
                         style: { marginTop: '14px', cursor: 'pointer', flexShrink: 0 },
                         onChange: function () {
                           var next = Object.assign({}, selected);
                           if (on) delete next[tk.id]; else next[tk.id] = true;
                           setSelected(next);
                         },
                       }),
                       h('div', { style: { flex: 1, minWidth: 0 } }, card));
                   })),
            h('div', { style: sectionStyle, id: 'hub-bot-stream' },
              h('div', { style: sectionTitleStyle }, t('ticketsSection'),
                tickets.length > 0 ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, opacity: 0.55 } }, '· ' + filtered.length + (filtered.length !== tickets.length ? ' / ' + tickets.length : '')) : null),
              tickets.length === 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('emptyTickets'))
                : h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
                    h('input', {
                      style: Object.assign({}, inputStyle, { flex: '1 1 200px', width: 'auto', padding: '4px 10px', fontSize: '12px' }),
                      value: filterText, placeholder: t('filterPlaceholder'),
                      onChange: function (ev) { setFilterText(ev.target.value); },
                    }),
                    h('select', {
                      style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 10px', fontSize: '12px' }),
                      value: filterStage, onChange: function (ev) { setFilterStage(ev.target.value); },
                    }, [h('option', { key: '', value: '' }, t('filterAllStages'))].concat(
                      presentStages.map(function (st) {
                        var sample = tickets.find(function (tk) { return tk.stage === st; });
                        return h('option', { key: st, value: st }, (sample && sample.stageText) || st);
                      }))),
                    presentOwners.length > 1
                      ? h('select', {
                          style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 10px', fontSize: '12px' }),
                          value: filterOwner, onChange: function (ev) { setFilterOwner(ev.target.value); },
                        }, [h('option', { key: '', value: '' }, t('filterAllOwners'))].concat(
                          presentOwners.map(function (label) { return h('option', { key: label, value: label }, label); })))
                      : null),
              filtered.length === 0 && tickets.length > 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 10px' } }, t('filterNoMatch'))
                : STAGE_ORDER.map(function (stage) {
                    var list = filtered.filter(function (tk) { return tk.stage === stage; });
                    if (!list.length) return null;
                    var isPerson = NEEDS_ME.indexOf(stage) >= 0;
                    return h('details', { key: stage, open: isPerson || filterActive, style: { marginBottom: '6px' } },
                      h('summary', { style: { cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '8px' } },
                        stagePill(stage, (list[0].stageText || stage) + ' · ' + list.length)),
                      h('div', { style: { marginTop: '8px' } }, list.map(function (tk) { return ticketRowItem(tk, false); })));
                  })),
            h('div', { style: sectionStyle },
              h('div', { style: Object.assign({}, sectionTitleStyle, { display: 'flex', alignItems: 'center', gap: '8px' }) },
                t('recentSection'),
                recentFilterActive ? h('span', { style: { fontSize: '12px', fontWeight: 400, opacity: 0.55 } }, '· ' + recentFiltered.length + '/' + recent.length) : null,
                h('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: '6px', flexWrap: 'wrap' } },
                  ['', 'feishu', 'github', 'route'].map(function (k) {
                    var on = recentKind === k;
                    return h('button', {
                      key: k || 'all',
                      onClick: function () { setRecentKind(k); },
                      style: { fontSize: '11px', fontWeight: 400, padding: '1px 10px', borderRadius: '999px', cursor: 'pointer',
                        background: on ? 'rgba(70,150,255,0.16)' : 'rgba(127,127,127,0.08)',
                        color: on ? '#7db8ff' : 'inherit',
                        border: '1px solid ' + (on ? 'rgba(70,150,255,0.4)' : 'rgba(127,127,127,0.2)'),
                        opacity: on ? 1 : 0.7 },
                    }, k === '' ? t('filterAllKinds') : kindLabel(k));
                  }),
                  recent.some(function (tr) { return tr.dropped; })
                    ? h('button', {
                        onClick: function () { setRecentDroppedOnly(!recentDroppedOnly); },
                        style: { fontSize: '11px', fontWeight: 400, padding: '1px 10px', borderRadius: '999px', cursor: 'pointer',
                          background: recentDroppedOnly ? 'rgba(230,160,40,0.16)' : 'rgba(127,127,127,0.08)',
                          color: recentDroppedOnly ? TONES.amber.fg : 'inherit',
                          border: '1px solid ' + (recentDroppedOnly ? TONES.amber.border : 'rgba(127,127,127,0.2)'),
                          opacity: recentDroppedOnly ? 1 : 0.7 },
                      }, t('filterDroppedOnly') + ' · ',
                         h('span', { style: { fontWeight: 600 } }, String(recent.filter(function (tr) { return tr.dropped; }).length)))
                    : null)),
              recent.length === 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('emptyRecent'))
                : recentFiltered.length === 0
                  ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('filterNoMatch'))
                  : recentFiltered.map(function (tr) {
                    return h('div', { key: tr.id,
                      onClick: tr.ticketId ? function () { locateTicket(tr.ticketId); } : undefined,
                      title: tr.ticketId ? t('recentLocateHint') : undefined,
                      style: {
                      display: 'flex', alignItems: 'baseline', gap: '10px', padding: '7px 10px',
                      borderRadius: '8px', marginBottom: '4px', background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)', fontSize: '13px',
                      cursor: tr.ticketId ? 'pointer' : 'default',
                    } },
                      h('span', { style: { flexShrink: 0, fontSize: '11px', padding: '1px 7px', borderRadius: '999px', background: tr.kind === 'feishu' ? 'rgba(70,150,255,0.14)' : 'rgba(150,150,150,0.14)', color: tr.kind === 'feishu' ? '#7db8ff' : 'rgba(200,200,200,0.8)', border: '1px solid ' + (tr.kind === 'feishu' ? 'rgba(70,150,255,0.3)' : 'rgba(150,150,150,0.25)') } }, kindLabel(tr.kind)),
                      h('span', { style: { flexShrink: 0, fontSize: '12px', opacity: 0.55, minWidth: '64px' } }, tr.at ? relTime(t, tr.at) : '—'),
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tr.message || '—'),
                      // 回复投递闭环指示： 已回复(绿) / 已注入(灰) / 投递中(琥珀) / 投递失败(红+行内重投)
                      tr.reply && tr.reply.state === 'sent'
                        ? h('span', { style: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', fontSize: '11px', color: TONES.green.fg } }, dot('#46bb6d'), t('replySent'))
                        : null,
                      tr.reply && tr.reply.state === 'recorded'
                        ? h('span', { style: { flexShrink: 0, fontSize: '11px', opacity: 0.5 } }, t('replyRecorded'))
                        : null,
                      tr.reply && (tr.reply.state === 'queued' || tr.reply.state === 'held')
                        ? h('span', { style: { flexShrink: 0, fontSize: '11px', color: TONES.amber.fg } }, t('replyPending'))
                        : null,
                      tr.reply && tr.reply.state === 'failed'
                        ? h('span', { style: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                            h('span', { style: { fontSize: '11px', color: TONES.red.fg }, title: tr.reply.lastError || '' }, t('replyFailed')),
                            h('button', {
                              onClick: function (ev) { ev.stopPropagation(); retryOutbox(tr.reply.id); },
                              style: { fontSize: '11px', padding: '1px 8px', borderRadius: '6px', cursor: 'pointer', background: 'rgba(230,160,40,0.13)', border: '1px solid ' + TONES.amber.border, color: TONES.amber.fg },
                            }, t('retryOne')))
                        : null,
                      tr.dropped
                        ? h('span', { style: { flexShrink: 0, fontSize: '11px', opacity: 0.55, fontStyle: 'italic' } }, t('droppedLabel') + ': ' + tr.dropped)
                        : (tr.stageText ? stagePill(tr.stage || '', tr.stageText) : null),
                      tr.ownerLabel ? h('span', { style: { flexShrink: 0, fontSize: '12px', opacity: 0.6 } }, tr.ownerLabel) : null);
                  })),
            h('div', { style: sectionStyle, id: 'hub-bot-owners' },
              h('div', { style: sectionTitleStyle }, t('ownersSection'),
                owners.length > 0 ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, opacity: 0.55 } }, '· ' + owners.length) : null),
              owners.length === 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('emptyOwners'))
                : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' } },
                    owners.map(function (o) {
                      var dir = o.cwd || o.workspace || '';
                      var mine = tickets.filter(function (tk) { return tk.owner === o.id; });
                      var active = mine.filter(function (tk) { return tk.stage !== 'done'; }).length;
                      var verdict = mine.filter(function (tk) { return NEEDS_ME.indexOf(tk.stage) >= 0; }).length;
                      var roleTone = o.role === 'chief' ? TONES.amber : o.kind === 'temp' ? TONES.gray : TONES.blue;
                      var label = o.dshWorkspace && o.dshWorkspace.title ? o.dshWorkspace.title : (o.workspace || o.id);
                      return h('div', {
                        key: o.id,
                        onClick: function () { setFilterText(o.workspace || o.id); setFilterStage(''); scrollToSection('hub-bot-stream'); },
                        title: t('ownerFilterHint'),
                        style: {
                          padding: '12px 14px', borderRadius: '10px', cursor: 'pointer',
                          border: '1px solid var(--dsh-border, rgba(127,127,127,0.2))',
                          borderLeft: '3px solid ' + roleTone.border,
                          background: 'var(--dsh-surface-raised, rgba(127,127,127,0.04))',
                        },
                      },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                          h('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: roleTone.bg, color: roleTone.fg, border: '1px solid ' + roleTone.border, flexShrink: 0 } },
                            o.role === 'chief' ? t('roleChief') : o.kind === 'temp' ? t('kindTemp') : t('roleOwner')),
                          h('span', { style: { fontWeight: 600, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
                          verdict > 0
                            ? h('span', { style: { marginLeft: 'auto', fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: TONES.amber.bg, color: TONES.amber.fg, border: '1px solid ' + TONES.amber.border, flexShrink: 0 } },
                                fill(t('verdictCount'), verdict))
                            : null),
                        h('div', { onClick: function (ev) { ev.stopPropagation(); if (dir) copyText(dir, 'cwd:' + o.id); }, style: { fontSize: '12px', opacity: 0.6, marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: dir ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: '6px' }, title: dir ? dir + String.fromCharCode(10) + t('copyPathHint') : '' },
                          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, shortPath(dir)),
                          copiedId === 'cwd:' + o.id ? h('span', { style: { color: TONES.green.fg, flexShrink: 0 } }, t('copiedBtn')) : null),
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px' } },
                          h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 }, title: (o.sessionTitle ? o.sessionTitle + ' — ' : '') + (o.sessionId || '') || undefined },
                            o.sessionId ? dot('#46bb6d') : dot('rgba(140,140,140,0.6)'),
                            h('span', { style: { opacity: 0.7, fontFamily: o.sessionTitle ? 'inherit' : 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '130px' } },
                              o.sessionTitle || (o.sessionId ? String(o.sessionId).replace(/^session-/, '').slice(0, 8) : t('sessionNone')))),
                          h('span', { style: { opacity: 0.7 } }, fill(t('activeTicketsLabel'), active)),
                          (function () {
                            var lastAt = null;
                            mine.forEach(function (tk) {
                              var at = tk.updatedAt || tk.createdAt;
                              if (at && (lastAt === null || String(at) > String(lastAt))) lastAt = at;
                            });
                            return lastAt
                              ? h('span', { style: { marginLeft: 'auto', opacity: 0.55, fontSize: '11px' }, title: lastAt }, t('lastActivity') + ' ' + relTime(t, lastAt))
                              : null;
                          })()));
                    }))),
            sectionDivider(t('settingsDivider'), 'hub-bot-settings'),
            h('div', { style: sectionStyle },
              h('div', { style: sectionTitleStyle }, t('modelSection')),
              catalog && catalog.groups
                ? h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', maxWidth: '560px', flexWrap: 'wrap' } },
                    h('select', {
                      style: Object.assign({}, inputStyle, { flex: '1 1 260px' }), value: modelChoice, disabled: modelBusy,
                      onChange: function (ev) { setModelChoice(ev.target.value); setModelDone(false); },
                    }, modelOptions),
                    h('button', {
                      onClick: saveModel, disabled: modelBusy,
                      style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 16px', whiteSpace: 'nowrap' }),
                    }, modelBusy ? t('modelApplying') : t('modelApply')),
                    modelDone && !modelDirty ? h('span', { style: { fontSize: '12px', color: TONES.green.fg, whiteSpace: 'nowrap' } }, t('modelApplied')) : null,
                    modelDirty ? h('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: 'rgba(230,160,40,0.14)', color: '#eba938', border: '1px solid rgba(230,160,40,0.4)', whiteSpace: 'nowrap' } }, t('unsaved')) : null)
                : h('div', { style: warnStyle }, t('catalogUnavailable')),
              modelChoice === '' && defaultModelLabel ? h('div', { style: Object.assign({}, warnStyle, { color: TONES.blue.fg, opacity: 0.85 }) }, fill(t('modelDefaultNow'), defaultModelLabel)) : null,
              h('div', { style: warnStyle }, t('modelPickerHint'))),
            h('div', { id: 'hub-bot-feishu' },
              h(FeishuSection, { view: view, onRefresh: refreshView }),
              h(GithubSection, { view: view })),
            h(HubBotRowConfig, { hubBotCtx: scoped, hideModel: true }),
            h(RuntimeSection, { view: view, onSaved: refreshView }),
            error ? h('div', { style: { fontSize: '12px', color: TONES.red.fg, marginTop: '8px' } }, error) : null,
            notice ? h('div', { style: { fontSize: '12px', color: TONES.green.fg, marginTop: '8px' } }, notice) : null);
        }
        scoped.effect(function () {
          return scoped.slots.inject('sidebar.panellist', function () {
            return scoped.slots.register({
              name: 'sidebar.panellist',
              id: 'hub-bot',
              order: 100,
              label: function () { return scoped.locale.bind(NS)('panel'); },
              locale: NS,
            }, HubBotPanelIcon);
          });
        }, 'hub-bot: sidebar panel');
        scoped.effect(function () {
          return scoped.slots.inject('main', function () {
            return scoped.slots.register({
              name: 'main',
              key: 'hub-bot',
              locale: NS,
            }, HubBotPanelPage);
          });
        }, 'hub-bot: main panel');
      });
    }
    exports.name = 'hub-bot-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
