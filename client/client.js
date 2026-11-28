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
        'hubBotSettings/selfTest': {
          service: 'hubBotSettings',
          description: 'Panel self-test: simulate one Feishu message through the real pipeline (a real reply is delivered).',
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
        'hubBotSettings/ownerWorkspace': {
          service: 'hubBotSettings', description: 'Read the workspace for one stable owner ID.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: '{ ownerId }',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/ticketDetail': {
          service: 'hubBotSettings', description: 'Read the complete report and facts for one ticket.', invocation: { kind: 'direct' },
          parameters: [{ name: 'ticketId', source: 'json', description: 'Ticket ID',
            codec: { mode: 'strict', typeSymbol: 'dsh-hub-bot#ticket-id', create: () => zodLib.z.string() },
            strictCodec: { mode: 'strict', typeSymbol: 'dsh-hub-bot#ticket-id', create: () => zodLib.z.string() } }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/timerAction': {
          service: 'hubBotSettings', description: 'Pause, resume, or cancel a timer.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: '{ id, action }',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/listRuns': {
          service: 'hubBotSettings', description: 'List background runs by source and notification state.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: 'Run filters and page offset',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/runDetail': {
          service: 'hubBotSettings', description: 'Read one background run and its delivery evidence.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: '{ id }',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/handoffSummaryAction': {
          service: 'hubBotSettings', description: 'Preview, edit or confirm an owner handoff summary.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: 'Handoff summary operation',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/ownerSwitchAction': {
          service: 'hubBotSettings', description: 'Request, read or manage an owner switch.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: 'Owner switch operation',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/notificationDetail': {
          service: 'hubBotSettings', description: 'Read the complete ticket index for a notification.', invocation: { kind: 'direct' },
          parameters: [{ name: 'request', source: 'json', description: '{ id }',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request') }],
          result: anyCodec('dsh-hub-bot#json-result'),
        },
        'hubBotSettings/messageDetail': {
          service: 'hubBotSettings',
          description: 'Read original text and the reply attributed to one message.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request', source: 'json', description: '{ triggerId }',
            codec: anyCodec('dsh-hub-bot#json-request'), strictCodec: anyCodec('dsh-hub-bot#json-request'),
          }],
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
      refreshWorkspaces: '刷新工作区',
      chiefWorkspaceHint: '在 DSH 新建工作区后，点「刷新工作区」即可选它。以后新建的总管会话会归入该工作区。',
      chiefWorkspaceMissing: '已关联的工作区不存在。请选择其他工作区，或切回自动。',
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
      statusSection: '总览',
      connectionsSection: '连接',
      outcomesSection: '结果',
      openReport: '查看报告与详情',
      noResults: '暂无结果。',
      nextWake: '下次唤醒',
      noWake: '暂无计划中的提醒。',
      ticketUnavailable: '工单已不可用。',
      boardNavigation: 'Hub Bot 页内导航',
      feishuCard: '飞书',
      githubCard: 'GitHub 监听',
      githubSection: 'GitHub 监听',
      githubDisabled: 'GitHub 监听已暂停。',
      githubEnableSwitch: '启用 GitHub 监听',
      githubEnableHowto: '保存后立即生效。启用时监听已登记的负责人仓库。',
      githubInterval: '轮询间隔',
      githubIntervalValue: '{n} 分钟',
      githubHandle: 'Mention 句柄',
      githubAllowlist: '允许触发者',
      githubAllowlistEmpty: '未配置（默认仅 gh 登录用户）',
      githubSettingsTitle: '监听参数',
      githubMinLabel: '轮询间隔（分钟）',
      githubMinHint: '最短间隔为 30 秒。间隔越短，GitHub API 调用越频繁。',
      githubAllowlistLabel: '允许触发的 GitHub 账号（每行一个；留空 = 仅 gh 登录用户）',
      githubMinInvalid: '轮询间隔必须至少为 0.5 分钟。',
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
      reportIntervalLabel: '汇报间隔（分钟）',
      reportHint: '开启后，chief 按间隔汇总各负责人状态并回投到飞书。',
      patternsLabel: '危险命令黑名单',
      patternsHint: '命中以下正则的注入会挂起等待你确认。每行一条正则。',
      patternsEmptyWarn: '⚠ 黑名单为空——危险命令将不再被拦截确认。',
      slotsInvalid: '并发槽必须是 ≥ 1 的整数',
      reportMinInvalid: '汇报间隔必须大于 0 分钟。',
      updatedAt: '上次更新',
      refreshBtn: '刷新',
      refreshHint: '重新拉取状态、票据与设置',
      monitorCurrent: '已同步',
      monitorCached: '显示上次数据',
      monitorReconnecting: '正在重新连接 DSH…',
      monitorDisconnected: '与 DSH 的连接已断开。',
      monitorRefreshing: '刷新中…',
      monitorWaiting: '正在等待新的状态数据。',
      monitorReadFailed: '状态刷新失败',
      monitorSettingsFailed: '设置刷新失败',
      recoveringHint: '实例重启后，系统正在自动恢复这条票据的执行现场',
      copyReportBtn: '复制',
      copyReportHint: '复制报告全文',

      copySessionHint: '点击复制完整会话 id',
      unsaved: '未保存',
      selfTestBtn: '飞书自检',
      selfTestHint: '模拟飞书来信并验证这次回复的投递结果',
      selfTestConfirm: '自检会向最近联系 Bot 的飞书私聊发送一条回复。确认继续？',
      selfTestNeedsConnection: '连接飞书 Bot 后可运行自检',
      selfTestStarting: '正在启动自检…',
      selfTestInjected: '总负责人已收到自检消息，正在等待回复投递…',
      selfTestPassed: '自检通过，回复已送达飞书',
      selfTestDropped: '自检消息未受理',
      selfTestFailed: '自检启动失败',
      selfTestDeliveryFailed: '自检回复投递失败',
      selfTestTimeout: '本次自检超时，尚未确认回复已送达',
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
      sessionNone: '尚未绑定',
      ownerRecycled: '已回收', switchEarlierArchives: '之前更换的归档失败',
      openSessionButton: '打开会话',
      copySessionButton: '复制 ID',
      openOwnerSession: '打开「{n}」的会话',
      copyOwnerSession: '复制「{n}」的会话 ID',
      copyOwnerPath: '复制「{n}」的工作目录',
      openSessionFailed: '无法打开会话',
      ownerSessionUnavailable: '工作区导航暂不可用。',
      ownerTicketsButton: '查看工单',
      openOwnerStage: '查看「{n}」的{stage}工单，共 {count} 条',
      modelApply: '应用',
      modelApplying: '应用中…',
      modelApplied: '模型设置已保存',
      modelSelectionLabel: '模型供应商与模型',
      catalogUnavailable: '模型目录不可用',
      refresh: '刷新',
      modelPickerHint: '「跟随部署默认」使用 DSH 配置的默认模型。',
      modelDefaultNow: '当前默认：{n}',
      needsMe: '需要我处理',
      quiet: '没有 — 一切安静。',
      quietHint: '没有待确认、待回答或待验收的事。新消息进来时会出现在这里。',
      ticketsSection: '任务流',
      confirmBtn: '确认',
      rejectBtn: '拒绝',
      pendingConfirmLabel: '待确认：',
      questionLabel: '等您回复：',
      reportLabel: '交付报告',
      reportResult: '结果',
      reportChanges: '变更',
      reportVerification: '验证',
      reportRisks: '风险',
      reportEvidence: '验收证据',
      recovering: '恢复中',
      emptyTickets: '还没有任务',
      relJustNow: '刚刚',
      relMinutes: '{n} 分钟前',
      relHours: '{n} 小时前',
      relDays: '{n} 天前',
      healthFeishuCred: '飞书凭据异常 — 需要重新扫码绑定',
      healthFeishuWs: '飞书长连接未建立',
      healthGithubPoll: 'GitHub 监听有 {count} 项异常',
      githubWatchProblems: '{count} 项监听异常',

      resolveFailed: '操作失败',
      detailToggle: '详情',
      detailActionsToggle: '详情与操作',
      doneExpandHint: '点开查看完整卡片',
      feishuSection: '飞书 Bot',
      feishuBound: '已绑定',
      feishuBoundAt: '绑定于',
      feishuWsOk: '长连接正常',
      feishuWsDown: '长连接未建立',
      feishuNotBound: '尚未绑定飞书 Bot',
      feishuSetupHint: '扫码绑定后，在飞书给 Bot 发一条消息即可运行自检。',
      feishuWaitingBind: '待绑定',
      feishuBindingStatus: '绑定中',
      feishuConnecting: '连接中',
      feishuReconnecting: '正在重连',
      feishuCredentialsInvalid: '凭据失效',
      feishuInvalid: '凭据失效，请检查现有 Bot 的凭据记录。',
      feishuCredentialsUnavailable: '宿主凭据服务不可用。请检查 DSH 的凭据服务和存储状态。',
      feishuCredentialsMalformed: '凭据记录格式无效。请检查现有 Bot 的引用和绑定。',
      feishuBindStart: '开始扫码绑定',
      feishuReplaceBound: '更换绑定的 Bot',
      feishuReplacingBound: '正在更换绑定：等待扫码授权，现有 Bot 继续工作、绑定未变更。',
      feishuReplaceConfirm: '更换会创建新应用并覆盖现有凭据，当前绑定随即失效。现有 Bot 本身无需更换——确定继续？',
      feishuBinding: '正在等待二维码…',
      feishuScanHint: '用飞书手机 App 扫码完成授权；二维码有时效，过期请重新发起。',
      feishuPermsTitle: '权限申明（授权时将申请）',
      feishuBindFailed: '绑定失败',
      feishuRegistrationExpired: '二维码已过期',
      feishuRegistrationExpiredHint: '二维码已过期，绑定未完成——现有绑定（如有）不受影响，可重新生成二维码。',
      feishuRegistrationExpiredBound: '这次重新扫码的二维码已过期，绑定未变更；现有 Bot 照常工作，无需更换。',
      feishuRetryRegister: '重新生成二维码',
      feishuReplaceFailedBound: '这次更换绑定失败（绑定未变更，现有 Bot 照常工作）',
      feishuQrExpiry: '二维码有效期约 {n} 分钟，过期需重新生成。',
      feishuEventModeManual: '长连接事件订阅需手工设置一次：open.feishu.cn/app → 应用 → 事件与回调 → 订阅方式 → 使用长连接接收事件/回调。',
      healthFeishuRegistration: '飞书绑定未完成（二维码已过期）',
      feishuDisabled: '飞书入口已暂停。',
      feishuEnableSwitch: '启用飞书入口',
      feishuPausedBound: '飞书入口已暂停，现有绑定已保留。',
      feishuEnableHowto: '保存后立即生效。已绑定的机器人会重新连接，首次启用后可扫码绑定。',
      recentSection: '最近消息',
      emptyRecent: '还没有消息进来',
      kindFeishu: '飞书',
      kindGithub: 'GitHub',
      kindRoute: '直派',
      intakeSection: '投喂口径（只读）',
      intakeHint: '两个入口各自生效的受理口径、去重键与队列状态，全部取自已落库的触发行与投递行；未记录的事实显示为 —。',
      intakeEmpty: '还没有投喂记录',
      intakeSource: '入口',
      intakeLastAt: '最近受理',
      intakePolicy: '受理口径',
      intakeDisposition: '处置',
      intakeQueue: '队列',
      intakeCounts: '累计',
      intakeDedup: '去重键',
      intakeDropped: '已丢弃',
      intakeInjected: '已注入',
      intakePending: '待注入',
      intakeFailed: '投递失败',
      intakeDiscarded: '已丢弃投递',
      timersSection: '提醒',
      ownerWorkspace: '负责人工作区',
      ownerWorkspaceOpen: '打开工作区',
      ownerWorkspaceOpenFor: '打开「{n}」的工作区',
      ownerWorkspaceChoose: '选择负责人',
      ownerWorkspaceLoading: '正在读取负责人工作区…',
      ownerWorkspaceUnavailable: '该负责人工作区不可用。',
      ownerWorkspaceProgress: '进行中与排队',
      ownerWorkspaceNoProgress: '暂无进行中或排队的任务。',
      ownerWorkspaceNoTicket: '此任务不在当前负责人工作区。',
      ownerWorkspaceCurrent: '当前会话',
      ownerWorkspacePrevious: '原会话',
      ownerWorkspaceReplacement: '替换会话',
      switchOpenNew: '打开新会话',
      handoffSummary: '交接摘要', handoffGenerate: '生成草稿', handoffConfirm: '确认这版摘要', handoffConfirmed: '摘要已确认。',
      handoffCarry: '携摘要更换', handoffCarryStop: '停止后携摘要更换', handoffDiscard: '放弃摘要', handoffClose: '关闭', handoffDraft: '交接摘要正文',
      handoffSource: '来源会话', handoffEvent: '截至事件', handoffExpires: '有效至',
      handoffHint: '请预览并编辑草稿。摘要补充讨论背景，任务状态和授权以当前记录为准。',
      decisionQueued: '决定已保存，等待处理。', batchDecisionQueued: '{count} 条已保存，等待处理。',
      switchWait: '空闲后更换', switchStop: '停止后更换', switchStopConfirm: '确认停止原负责人会话当前处理，等它空闲后更换？',
      switchCancel: '取消等待', switchRetryArchive: '重试归档', switchOpenPrevious: '打开原会话',
      switchWaiting: '等待原会话空闲', switchPreparing: '正在准备新会话', switchCommitted: '新会话已接管，等待归档',
      switchArchiveFailed: '旧会话归档失败', switchCompleted: '更换完成', switchFailed: '更换失败', switchCancelled: '已取消更换',
      notificationId: '通知编号', notificationLookup: '查找通知', notificationLoading: '正在读取通知索引…',
      notificationOpen: '查看通知详情', notificationEmpty: '暂无关联任务。',
      runSection: '后台运行记录', runStateFilter: '通知状态', runSourceFilter: '运行来源', runAll: '全部',
      runSilent: '未通知', runWaiting: '待发送或汇总', runSent: '通道已接受', runFailed: '发送失败', runUnsent: '无发送记录',
      runTimer: '提醒', runResult: '有结果', runExecutionFailed: '执行失败', runBlocked: '需要介入', runTask: '查看关联任务',
      runSourceLink: '打开来源', runEmpty: '暂无符合条件的运行。', runRefresh: '刷新运行记录', runPrevious: '上一页', runNext: '下一页',
      runLoading: '正在读取运行记录…', runOpenWorker: '打开原执行会话', runLastProgress: '上次记录进展',
      timersEmpty: '暂无提醒。',
      timerPause: '暂停',
      timerResume: '恢复',
      timerCancel: '取消提醒',
      timerLate: '已迟到',
      timerRun: '查看任务',
      timerDaily: '每日 {time}（上海时间）', timerWeekly: '每周{weekday} {time}（上海时间）', timerNext: '下次计划 {time}',
      timerWeekday1: '一', timerWeekday2: '二', timerWeekday3: '三', timerWeekday4: '四', timerWeekday5: '五', timerWeekday6: '六', timerWeekday7: '日',
      timerPending: '待触发', timerPaused: '已暂停', timerFiring: '正在提交', timerFired: '已建任务',
      timerCancelled: '已取消', timerFailed: '失败',
      timerWorker: '打开执行会话', timerDeliverySent: '已接管', timerDeliveryQueued: '待投递', timerDeliveryFailed: '投递失败',
      intakeCohort: '合并来信',
      deferredExpires: '答复截止', deferredTarget: '目标会话', deferredAnswer: '用户答复',
      answerQueued: '答复待接管', answerSent: '答复已接管', answerFailed: '答复投递失败', answerDiscarded: '已丢弃答复投递',
      intakeInterrupt: '停止请求',
      intakeInterruptRequested: '已请求停止',
      intakeTriggers: '触发',
      intakeQueueAttempt: '第 {n} 次',
      queueQueued: '排队中',
      queueHeld: '暂缓',
      queueRecorded: '待发送',
      queueSent: '已送达',
      queueFailed: '失败',
      droppedLabel: '未受理',
      healthDetailRetry: '重试中',
      healthDetailDead: '投递失败（死信）',
      deliveryHealthTitle: '渠道与投递状态',
      deliveryHistory: '系统问题记录',
      deliveryHistoryLimit: '显示最近 {count} 条记录',
      deliveryChannelPaused: '渠道已暂停，投递将在启用后继续。',
      deliveryNextPass: '等待下一次投递',
      deliveryUpdating: '正在更新投递队列…',
      deliveryResultMissing: '未能确认受影响的投递数量。',
      deliveryRefreshFailed: '队列状态刷新失败',
      discardOneConfirm: '确定丢弃这条投递记录？',
      healthUnprocessed: '{n} 条消息已超过 5 分钟，尚无工单或对应回复',
      healthUnprocessedJump: '去最近消息看看',
      unprocessedLabel: '未处理',
      unprocessedHint: '收到这条消息已超过 5 分钟，仍没有关联的工单或回复。',

      healthOk: '当前没有投递告警',

      retryOne: '重投',
      retryAll: '全部重投',
      discardOne: '丢弃',
      discardAll: '清空死信',


      discardAllConfirm: '确定清空全部死信？这些回执将不再投递。',
      discardedNotice: '已清空 {count} 条死信',
      filterPlaceholder: '筛选消息 / 负责人 / 工单号…',
      filterAllStages: '全部阶段',
      filterNoMatch: '没有匹配的票据',
      answerPlaceholder: '回复负责人的问题…',
      replyShortcut: 'Enter 提交，Shift+Enter 换行',
      answerBtn: '回复',

      retryTicketBtn: '重新尝试',
      cancelTicketBtn: '取消任务',
      cancelDone: '已取消，任务关闭',
      retryDone: '已要求重试，任务恢复执行',
      reworkBtn: '打回重做',
      reworkPlaceholder: '填写返工意见…',
      cardJumpHint: '点击跳到对应区域',
      verdictCount: '待处理 {count} 条',
      activeTicketsLabel: '{count} 活跃票据',
      replySent: '已回复',
      messageDetailLabel: '查看消息详情 · {n}',
      messageOriginal: '消息原文',
      messageReply: '关联回复',
      messageNoText: '无可显示的正文',
      messageNoMatch: '没有符合条件的消息。',
      messageUnavailable: '无法读取这条消息的详情。',
      messageOpenTicket: '打开工单',
      copyMessageText: '复制完整消息原文',
      copyReplyText: '复制完整回复',
      messageAttempts: '尝试投递 {count} 次',
      messageRetrying: '正在重投…',
      messageDroppedMention: '群消息未提及机器人。',
      messageDroppedType: '消息类型暂不受支持。',
      messageDroppedIgnore: 'Issue 或 PR 标记了 bot:ignore。',
      messageDroppedAllowlist: 'GitHub 作者不在允许名单内。',
      messageDroppedStop: '没有可以停止的关联工单。',
      messageDroppedComment: '这条评论没有关联工单。',
      messageDroppedOther: '原因代码',
      waitingLabel: '已等待',
      expandAll: '全部展开',
      collapseAll: '全部收起',
      expandAllHint: '展开或收起任务流的全部阶段分组',

      runningLabel: '已运行',
      runningHint: '进入执行阶段的时长（按最近一次状态变化起算）',
      showMoreInGroup: '展开剩余 {count} 条',
      barFilterHint: '点击筛选该阶段',
      copyDigestBtn: '复制待办摘要',
      copyDigestHint: '把待办列表复制成纯文本（可贴到飞书/笔记）',
      revertBtn: '还原',
      revertHint: '放弃修改，回到已保存的值',
      copyMsgHint: '点击复制原文',
      clearFilters: '清除筛选',
      clearFiltersHint: '清空本区的全部筛选条件',
      waitingHint: '从进入当前阶段起算；灰 <30 分钟，琥珀 <2 小时，红色更久',
      durNow: '刚刚',
      durMin: '{n} 分钟',
      durHour: '{n} 小时',
      durDay: '{n} 天',
      originHint: '这条任务的来源渠道',
      replyInjected: '已交给总负责人',
      replyUnlinked: '回复未关联',
      replyUnlinkedHint: '这个飞书会话有回复记录。缺少原消息编号，无法确认它对应哪条消息。',
      replyPending: '投递中',
      replyFailed: '回复投递失败',
      artifactsLabel: '产物目录（负责人工作区）',
      artifactsWorkingLabel: '工作区产物（进行中）',
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
      filterUnprocessedOnly: '仅看未处理',


      filterAllOwners: '全部负责人',
      filterOwnerLabel: '按负责人筛选',
      filterStageLabel: '按阶段筛选',
      openTicketLabel: '打开工单 {n}',
      openOwnerTasks: '查看「{n}」的任务',
      copyIdBtn: '复制',
      copiedBtn: '已复制',
      copyIdHint: '复制工单号',
      settingsDivider: '设置',
      selectAll: '全选',
      selectNone: '全不选',
      batchConfirm: '确认所选 · {count}',
      batchReject: '拒绝所选 · {count}',
      batchRunning: '执行中…',
      batchOutcome: '成功 {count} 条，失败 {failed} 条',
      selectTicket: '选择工单 {n}',
      ticketRunning: '正在处理工单…',
      ticketResultMissing: '服务未返回这条工单的处理结果。',
      ticketRefreshFailed: '未能更新工单列表',
      ticketActionHeld: '已提交，工单正在等待确认',
      dismissTicketFeedback: '关闭提示',
      droppedCardHint: '最近未受理',
      retriedNotice: '已重投 {count} 条，回到投递队列',
      confirmDone: '已记录确认',
      rejectDone: '已拒绝，任务转被卡住',
      batchConfirmed: '已批量确认 {count} 条',
      batchRejected: '已批量拒绝 {count} 条',
      answerDone: '已提交回复',
      reworkDone: '已提交返工意见',
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
      refreshWorkspaces: 'Refresh workspaces',
      chiefWorkspaceHint: 'Create a workspace in DSH, then refresh the list and select it here. New chief sessions will open in that workspace.',
      chiefWorkspaceMissing: 'The linked workspace is missing. Select another workspace or choose Automatic.',
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
      statusSection: 'Overview',
      connectionsSection: 'Connections',
      outcomesSection: 'Results',
      openReport: 'View report and details',
      noResults: 'No results yet.',
      nextWake: 'Next wake-up',
      noWake: 'No follow-ups scheduled.',
      ticketUnavailable: 'This ticket is unavailable.',
      boardNavigation: 'Hub Bot section navigation',
      feishuCard: 'Feishu',
      githubCard: 'GitHub watch',
      githubSection: 'GitHub watch',
      githubDisabled: 'GitHub watch is paused.',
      githubEnableSwitch: 'Enable GitHub watch',
      githubEnableHowto: 'Saving applies the change immediately. The watcher follows registered owner repositories.',
      githubInterval: 'Poll interval',
      githubIntervalValue: '{n} min',
      githubHandle: 'Mention handle',
      githubAllowlist: 'Allowed authors',
      githubAllowlistEmpty: 'not set (defaults to the gh login)',
      githubSettingsTitle: 'Poll settings',
      githubMinLabel: 'Poll interval (minutes)',
      githubMinHint: 'The minimum interval is 30 seconds. Shorter intervals make more GitHub API calls.',
      githubAllowlistLabel: 'GitHub logins allowed to trigger (one per line; empty = the gh login only)',
      githubMinInvalid: 'Enter a poll interval of at least 0.5 minutes.',
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
      reportIntervalLabel: 'Report interval (minutes)',
      reportHint: 'When on, the chief summarizes owner states and posts back to Feishu on this interval.',
      patternsLabel: 'Dangerous command blacklist',
      patternsHint: 'Injected commands matching these regexes are held for your confirmation. One per line.',
      patternsEmptyWarn: '⚠ Empty blacklist — dangerous commands will no longer be held for confirmation.',
      slotsInvalid: 'Slots must be an integer ≥ 1',
      reportMinInvalid: 'Enter a report interval greater than 0 minutes.',
      updatedAt: 'Last updated',
      refreshBtn: 'Refresh',
      refreshHint: 'Reload status, tickets and settings',
      monitorCurrent: 'Synced',
      monitorCached: 'Showing last known data',
      monitorReconnecting: 'Reconnecting to DSH…',
      monitorDisconnected: 'Disconnected from DSH.',
      monitorRefreshing: 'Refreshing…',
      monitorWaiting: 'Waiting for updated status.',
      monitorReadFailed: 'Status refresh failed',
      monitorSettingsFailed: 'Settings refresh failed',
      recoveringHint: 'The instance restarted; the system is re-establishing this ticket’s execution',
      copyReportBtn: 'Copy',
      copyReportHint: 'Copy the full report',

      copySessionHint: 'Click to copy the full session id',
      unsaved: 'Unsaved',
      selfTestBtn: 'Test Feishu',
      selfTestHint: 'Simulate a Feishu message and verify that its reply is delivered',
      selfTestConfirm: 'This test sends a reply to the last Feishu direct chat that messaged the bot. Continue?',
      selfTestNeedsConnection: 'Connect the Feishu bot to run a test',
      selfTestStarting: 'Starting the test…',
      selfTestInjected: 'The chief received the test message. Waiting for reply delivery…',
      selfTestPassed: 'Test passed. The reply reached Feishu.',
      selfTestDropped: 'The test message was dropped',
      selfTestFailed: 'The test could not start',
      selfTestDeliveryFailed: 'The test reply could not be delivered',
      selfTestTimeout: 'The test timed out waiting for reply delivery',
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
      sessionNone: 'Unbound',
      ownerRecycled: 'Recycled', switchEarlierArchives: 'Earlier archive failures',
      openSessionButton: 'Open session',
      copySessionButton: 'Copy ID',
      openOwnerSession: 'Open the session for {n}',
      copyOwnerSession: 'Copy the session ID for {n}',
      copyOwnerPath: 'Copy the working directory for {n}',
      openSessionFailed: 'Could not open session',
      ownerSessionUnavailable: 'Workspace navigation is unavailable.',
      ownerTicketsButton: 'View tickets',
      openOwnerStage: 'View {count} {stage} tickets for {n}',
      modelApply: 'Apply',
      modelApplying: 'Applying…',
      modelApplied: 'Model setting saved',
      modelSelectionLabel: 'Model provider and model',
      catalogUnavailable: 'Model catalog unavailable',
      refresh: 'Refresh',
      modelPickerHint: 'The deployment default uses the model configured in DSH.',
      needsMe: 'Needs me',
      quiet: 'Nothing — all quiet.',
      quietHint: 'No confirmations, answers, or reviews waiting. New items land here as they arrive.',
      ticketsSection: 'Ticket stream',
      confirmBtn: 'Confirm',
      rejectBtn: 'Reject',
      pendingConfirmLabel: 'Pending confirm: ',
      questionLabel: 'Waiting for your reply: ',
      reportLabel: 'Delivery report',
      reportResult: 'Result',
      reportChanges: 'Changes',
      reportVerification: 'Verification',
      reportRisks: 'Risks',
      reportEvidence: 'Evidence',
      recovering: 'Recovering',
      emptyTickets: 'No tickets yet',
      relJustNow: 'just now',
      relMinutes: '{n} min ago',
      relHours: '{n} h ago',
      relDays: '{n} d ago',
      healthFeishuCred: 'Feishu credentials broken — re-bind by scanning',
      healthFeishuWs: 'Feishu long connection not established',
      healthGithubPoll: '{count} GitHub watch errors',
      githubWatchProblems: '{count} watch errors',

      resolveFailed: 'Action failed',
      detailToggle: 'Details',
      detailActionsToggle: 'Details and actions',
      doneExpandHint: 'Click to expand the full card',
      feishuSection: 'Feishu Bot',
      feishuBound: 'Bound',
      feishuBoundAt: 'bound',
      feishuWsOk: 'Long connection OK',
      feishuWsDown: 'Long connection down',
      feishuNotBound: 'No Feishu bot bound yet',
      feishuSetupHint: 'Scan to bind the bot, then send it a message in Feishu before running a test.',
      feishuWaitingBind: 'Needs binding',
      feishuBindingStatus: 'Binding',
      feishuConnecting: 'Connecting',
      feishuReconnecting: 'Reconnecting',
      feishuCredentialsInvalid: 'Credentials invalid',
      feishuInvalid: 'Credentials are invalid. Check the existing bot’s credential record.',
      feishuCredentialsUnavailable: 'The host credential service is unavailable. Check the DSH credential service and store.',
      feishuCredentialsMalformed: 'The credential record is malformed. Check the existing bot’s binding and reference.',
      feishuBindStart: 'Start scan-to-bind',
      feishuReplaceBound: 'Replace the bound bot',
      feishuReplacingBound: 'Replacing the binding: waiting for scan authorization. The existing bot keeps working and the binding is unchanged.',
      feishuReplaceConfirm: 'Replacing creates a new app and overwrites the saved credentials, so the current binding stops working. The existing bot does not need replacing — continue?',
      feishuBinding: 'Waiting for the QR code…',
      feishuScanHint: 'Scan with the Feishu mobile app to authorize; the QR code expires — restart if it does.',
      feishuPermsTitle: 'Permissions (requested at authorization)',
      feishuBindFailed: 'Binding failed',
      feishuRegistrationExpired: 'QR code expired',
      feishuRegistrationExpiredHint: 'The QR code expired before binding finished. Any existing binding is untouched — generate a new QR code to retry.',
      feishuRegistrationExpiredBound: 'The replacement QR code expired, so the binding did not change. The existing bot keeps working and needs no replacement.',
      feishuRetryRegister: 'Generate a new QR code',
      feishuReplaceFailedBound: 'This replacement failed (binding unchanged; the existing bot keeps working)',
      feishuQrExpiry: 'The QR code is valid for about {n} minutes; regenerate it after it expires.',
      feishuEventModeManual: 'Long-connection event subscription needs a one-time manual setup: open.feishu.cn/app → app → Events & Callbacks → subscription mode → receive events/callbacks over a long connection.',
      healthFeishuRegistration: 'Feishu binding unfinished (QR code expired)',
      feishuDisabled: 'Feishu is paused.',
      feishuEnableSwitch: 'Enable Feishu',
      feishuPausedBound: 'Feishu is paused. The existing bot binding is saved.',
      feishuEnableHowto: 'Saving applies the change immediately. A bound bot reconnects automatically. When enabling for the first time, scan to bind it.',
      recentSection: 'Recent messages',
      emptyRecent: 'No inbound messages yet',
      kindFeishu: 'Feishu',
      kindGitHub: 'GitHub',
      kindRoute: 'Direct',
      intakeSection: 'Intake policy (read-only)',
      intakeHint: 'The effective intake policy, dedup key and queue state for both entries, read straight from persisted trigger and delivery rows. Facts that were not recorded show as —.',
      intakeEmpty: 'No intake records yet',
      intakeSource: 'Entry',
      intakeLastAt: 'Last accepted',
      intakePolicy: 'Policy',
      intakeDisposition: 'Disposition',
      intakeQueue: 'Queue',
      intakeCounts: 'Totals',
      intakeDedup: 'Dedup key',
      intakeDropped: 'dropped',
      intakeInjected: 'injected',
      intakePending: 'awaiting injection',
      intakeFailed: 'delivery failed',
      intakeDiscarded: 'delivery discarded',
      timersSection: 'Follow-ups',
      ownerWorkspace: 'Owner workspace',
      ownerWorkspaceOpen: 'Open workspace',
      ownerWorkspaceOpenFor: 'Open workspace for {n}',
      ownerWorkspaceChoose: 'Select an owner',
      ownerWorkspaceLoading: 'Loading owner workspace…',
      ownerWorkspaceUnavailable: 'This owner workspace is unavailable.',
      ownerWorkspaceProgress: 'In progress and queued',
      ownerWorkspaceNoProgress: 'No work in progress or queued.',
      ownerWorkspaceNoTicket: 'This task is unavailable in the selected owner workspace.',
      ownerWorkspaceCurrent: 'Current session',
      ownerWorkspacePrevious: 'Previous session',
      ownerWorkspaceReplacement: 'Replacement session',
      switchOpenNew: 'Open new session',
      handoffSummary: 'Handoff summary', handoffGenerate: 'Generate draft', handoffConfirm: 'Confirm this summary', handoffConfirmed: 'Summary confirmed.',
      handoffCarry: 'Replace with summary', handoffCarryStop: 'Stop and replace with summary', handoffDiscard: 'Discard summary', handoffClose: 'Close', handoffDraft: 'Handoff summary text',
      handoffSource: 'Source session', handoffEvent: 'Through event', handoffExpires: 'Expires',
      handoffHint: 'Review and edit the draft. The summary carries discussion context. Current records govern task status and authorization.',
      decisionQueued: 'Decision saved and awaiting processing.', batchDecisionQueued: '{count} saved and awaiting processing.',
      switchWait: 'Replace when idle', switchStop: 'Stop and replace', switchStopConfirm: 'Stop the current owner turn and replace its session once it is idle?',
      switchCancel: 'Cancel waiting', switchRetryArchive: 'Retry archiving', switchOpenPrevious: 'Open previous session',
      switchWaiting: 'Waiting for current session to go idle', switchPreparing: 'Preparing a new session', switchCommitted: 'New session is current, awaiting archive',
      switchArchiveFailed: 'Previous session could not be archived', switchCompleted: 'Replacement complete', switchFailed: 'Replacement failed', switchCancelled: 'Replacement cancelled',
      notificationId: 'Notification ID', notificationLookup: 'Find notification', notificationLoading: 'Loading notification index…',
      notificationOpen: 'View notification details', notificationEmpty: 'No linked tasks.',
      runSection: 'Background runs', runStateFilter: 'Notification status', runSourceFilter: 'Run source', runAll: 'All',
      runSilent: 'Silent', runWaiting: 'Awaiting send or summary', runSent: 'Accepted by channel', runFailed: 'Delivery failed', runUnsent: 'No delivery record',
      runTimer: 'Reminder', runResult: 'Result available', runExecutionFailed: 'Work failed', runBlocked: 'Needs attention', runTask: 'Open linked task',
      runSourceLink: 'Open source', runEmpty: 'No matching runs.', runRefresh: 'Refresh runs', runPrevious: 'Previous page', runNext: 'Next page',
      runLoading: 'Loading runs…', runOpenWorker: 'Open original worker session', runLastProgress: 'Last progress recorded',
      timersEmpty: 'No follow-ups scheduled.',
      timerPause: 'Pause',
      timerResume: 'Resume',
      timerCancel: 'Cancel reminder',
      timerLate: 'Late',
      timerRun: 'Open task',
      timerDaily: 'Daily at {time} (Shanghai time)', timerWeekly: '{weekday} at {time} (Shanghai time)', timerNext: 'Next scheduled {time}',
      timerWeekday1: 'Mon', timerWeekday2: 'Tue', timerWeekday3: 'Wed', timerWeekday4: 'Thu', timerWeekday5: 'Fri', timerWeekday6: 'Sat', timerWeekday7: 'Sun',
      timerPending: 'Scheduled', timerPaused: 'Paused', timerFiring: 'Submitting', timerFired: 'Task created',
      timerCancelled: 'Cancelled', timerFailed: 'Failed',
      timerWorker: 'Open worker session', timerDeliverySent: 'Admitted', timerDeliveryQueued: 'Pending delivery', timerDeliveryFailed: 'Delivery failed',
      intakeCohort: 'Combined incoming messages',
      deferredExpires: 'Reply deadline', deferredTarget: 'Destination session', deferredAnswer: 'User reply',
      answerQueued: 'Reply pending delivery', answerSent: 'Reply delivered', answerFailed: 'Reply delivery failed', answerDiscarded: 'Reply delivery discarded',
      intakeInterrupt: 'Stop request',
      intakeInterruptRequested: 'Stop requested',
      intakeTriggers: 'triggers',
      intakeQueueAttempt: 'attempt {n}',
      queueQueued: 'queued',
      queueHeld: 'held',
      queueRecorded: 'pending send',
      queueSent: 'delivered',
      queueFailed: 'failed',
      droppedLabel: 'dropped',
      healthDetailRetry: 'retrying',
      healthDetailDead: 'failed deliveries (dead letters)',
      deliveryHealthTitle: 'Channels and delivery',
      deliveryHistory: 'System problem history',
      deliveryHistoryLimit: 'Showing the latest {count} records',
      deliveryChannelPaused: 'Channel paused. Delivery resumes when enabled.',
      deliveryNextPass: 'Waiting for the next delivery pass',
      deliveryUpdating: 'Updating the delivery queue…',
      deliveryResultMissing: 'The number of affected deliveries could not be confirmed.',
      deliveryRefreshFailed: 'Queue refresh failed',
      discardOneConfirm: 'Discard this delivery record?',
      healthUnprocessed: '{n} message(s) over 5 minutes old are still awaiting a ticket or a linked reply',
      healthUnprocessedJump: 'view recent messages',
      unprocessedLabel: 'unprocessed',
      unprocessedHint: 'This message arrived over 5 minutes ago and has no linked ticket or reply.',

      healthOk: 'No delivery alerts',

      retryOne: 'Retry',
      retryAll: 'Retry all',
      discardOne: 'Discard',
      discardAll: 'Discard all',


      discardAllConfirm: 'Discard every dead letter? These replies will never be delivered.',
      discardedNotice: 'Discarded {count} dead letter(s)',
      filterPlaceholder: 'Filter message / owner / ticket id…',
      filterAllStages: 'All stages',
      filterNoMatch: 'No tickets match',
      answerPlaceholder: 'Reply to the owner…',
      replyShortcut: 'Enter to send. Shift+Enter for a new line.',
      answerBtn: 'Reply',

      retryTicketBtn: 'Retry',
      cancelTicketBtn: 'Cancel task',
      cancelDone: 'Cancelled — the task is closed',
      retryDone: 'Retry requested',
      reworkBtn: 'Rework',
      reworkPlaceholder: 'Describe what needs rework…',
      cardJumpHint: 'Click to jump to the section',
      verdictCount: 'Needs attention · {count}',
      activeTicketsLabel: '{count} active tickets',
      replySent: 'replied',
      messageDetailLabel: 'View message details · {n}',
      messageOriginal: 'Original message',
      messageReply: 'Linked reply',
      messageNoText: 'No stored text',
      messageNoMatch: 'No messages match these filters.',
      messageUnavailable: 'Message details are unavailable.',
      messageOpenTicket: 'Open ticket',
      copyMessageText: 'Copy the full original message',
      copyReplyText: 'Copy the full reply',
      messageAttempts: '{count} delivery attempts',
      messageRetrying: 'Requeuing…',
      messageDroppedMention: 'The group message did not mention the bot.',
      messageDroppedType: 'Unsupported message type.',
      messageDroppedIgnore: 'The issue or pull request has the bot:ignore label.',
      messageDroppedAllowlist: 'The GitHub author is outside the allowlist.',
      messageDroppedStop: 'No tracked task was available to stop.',
      messageDroppedComment: 'No task was linked to this comment.',
      messageDroppedOther: 'Reason code',
      waitingLabel: 'waiting',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      expandAllHint: 'Expand or collapse every stage group in the stream',

      runningLabel: 'running',
      runningHint: 'Time since entering the working stage (from the last status change)',
      showMoreInGroup: 'Show {count} more',
      barFilterHint: 'Click to filter this stage',
      copyDigestBtn: 'Copy digest',
      copyDigestHint: 'Copy the needs-me list as plain text (paste to Feishu/notes)',
      revertBtn: 'Revert',
      revertHint: 'Discard changes and restore the saved values',
      copyMsgHint: 'Click to copy the original message',
      clearFilters: 'Clear filters',
      clearFiltersHint: 'Reset every filter in this section',
      waitingHint: 'Time in the current stage; gray <30m, amber <2h, red beyond',
      durNow: 'just now',
      durMin: '{n}m',
      durHour: '{n}h',
      durDay: '{n}d',
      originHint: 'Origin channel of this task',
      replyInjected: 'Sent to chief',
      replyUnlinked: 'Unlinked reply',
      replyUnlinkedHint: 'A reply exists in this chat, but its record has no link to the original message.',
      replyPending: 'delivering',
      replyFailed: 'reply delivery failed',
      artifactsLabel: 'Artifacts (owner workspace)',
      artifactsWorkingLabel: 'Workspace artifacts (in progress)',
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
      filterUnprocessedOnly: 'Unprocessed only',


      filterAllOwners: 'All owners',
      filterOwnerLabel: 'Filter by owner',
      filterStageLabel: 'Filter by stage',
      openTicketLabel: 'Open ticket {n}',
      openOwnerTasks: 'Show tasks for {n}',
      copyIdBtn: 'Copy',
      copiedBtn: 'Copied',
      copyIdHint: 'Copy ticket id',
      settingsDivider: 'Settings',
      selectAll: 'Select all',
      selectNone: 'Select none',
      batchConfirm: 'Confirm selected · {count}',
      batchReject: 'Reject selected · {count}',
      batchRunning: 'Running…',
      batchOutcome: '{count} succeeded, {failed} failed',
      selectTicket: 'Select ticket {n}',
      ticketRunning: 'Updating the ticket…',
      ticketResultMissing: 'The service returned no result for this ticket.',
      ticketRefreshFailed: 'Could not refresh tickets',
      ticketActionHeld: 'Submitted and waiting for confirmation',
      dismissTicketFeedback: 'Dismiss',
      droppedCardHint: 'Last dropped',
      retriedNotice: 'Requeued {count} row(s) to the delivery queue',
      confirmDone: 'Approval recorded',
      rejectDone: 'Rejected, ticket blocked',
      batchConfirmed: 'Confirmed {count} ticket(s)',
      batchRejected: 'Rejected {count} ticket(s)',
      answerDone: 'Reply submitted',
      reworkDone: 'Rework feedback submitted',
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
      return h('h3', { id: id, tabIndex: -1, className: 'hb-scroll-target',
        style: { display: 'flex', alignItems: 'center', gap: '12px', margin: '26px 0 14px', fontSize: '15px', fontWeight: 600 },
      }, label, h('span', { 'aria-hidden': true, style: { flex: 1, height: '1px', background: 'var(--dsw-alias-border-l2)' } }));
    }

    var settingsInputStyle = Object.assign({}, inputStyle, {
      borderColor: 'var(--dsw-alias-border-l3)', background: 'transparent',
    });
    var settingsButtonStyle = Object.assign({}, settingsInputStyle, { width: 'auto', padding: '5px 12px' });
    var settingsHintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 };

    function useSettingsForm(ctx, savedValues, buildPatch, onSaved) {
      var [draft, setDraft] = React.useState({});
      var [busy, setBusy] = React.useState(false);
      var [result, setResult] = React.useState(null);
      // Drafts track edited fields so a refresh can update the other values.
      var edits = Object.fromEntries(Object.entries(draft).filter(function ([key, value]) { return value !== savedValues[key]; }));
      var dirty = Object.keys(edits).length > 0;
      function change(key, value) {
        setDraft(function (current) {
          var next = { ...current };
          if (value === savedValues[key]) delete next[key];
          else next[key] = value;
          return next;
        });
        setResult(null);
      }
      function revert() {
        setDraft({});
        setResult(null);
      }
      async function submit(event) {
        event.preventDefault();
        if (busy || !dirty) return;
        setBusy(true);
        setResult(null);
        try {
          var patch = buildPatch(edits);
          var view = unwrap(await ctx.remote.hubBotSettings.update(patch));
          onSaved(view, patch);
          setDraft({});
          setResult({ saved: true });
        } catch (error) {
          setResult({ error: error?.message || String(error) });
        } finally {
          setBusy(false);
        }
      }
      return { values: { ...savedValues, ...edits }, change, dirty, busy, result, revert, submit };
    }

    function SettingsForm(props) {
      var { t, form, title, labels, children } = props;
      var generatedHeadingId = React.useId();
      var headingId = props.headingId || generatedHeadingId;
      var button = labels?.submit || t('save');
      var status = form.busy ? labels?.busy || t('saving') : form.dirty ? t('unsaved') : form.result?.saved ? labels?.saved || t('saved') : '';
      var statusFill = form.busy ? null : form.dirty ? 'var(--dsw-alias-state-warn-tertiary)' : 'var(--dsw-alias-state-success-tertiary)';
      return h('form', { onSubmit: form.submit, noValidate: true, 'aria-labelledby': headingId,
        style: { margin: '0 0 16px', padding: '14px 16px', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px', background: 'var(--dsw-alias-card-fill)', minWidth: 0 },
      },
        h(props.headingLevel || 'h4', { id: headingId, tabIndex: props.headingId ? -1 : undefined,
          className: props.headingId ? 'hb-scroll-target' : undefined, style: { margin: '0 0 12px', fontSize: '13px', fontWeight: 600 } }, title),
        h('fieldset', { disabled: form.busy, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } }, children),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          h('button', { type: 'submit', disabled: form.busy || !form.dirty, style: Object.assign({}, settingsButtonStyle, {
            background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-label-primary)',
            borderColor: 'transparent', fontWeight: 600, opacity: form.busy || !form.dirty ? 0.65 : 1,
          }) }, button),
          form.dirty ? h('button', { type: 'button', disabled: form.busy, onClick: form.revert,
            title: t('revertHint'), style: settingsButtonStyle }, t('revertBtn')) : null,
          h('span', { role: 'status', style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)',
            background: status ? statusFill : undefined, padding: status && statusFill ? '2px 8px' : undefined, borderRadius: '6px' } }, status)),
        form.result?.error ? h('p', { role: 'alert', style: { margin: '8px 0 0', fontSize: '12px',
          color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, t('failed') + ' · ' + form.result.error) : null);
    }

    function SettingsField(props) {
      var { label, hint, children } = props;
      var id = React.useId();
      return h('div', { style: fieldStyle },
        h('label', { htmlFor: id, style: labelStyle }, label),
        React.cloneElement(children, { id: id, 'aria-describedby': hint ? id + '-hint' : undefined }),
        hint ? h('div', { id: id + '-hint', style: settingsHintStyle }, hint) : null);
    }

    function HubBotRowConfig(props) {
      var ctx = props.hubBotCtx;
      var t = ctx.locale.bind(NS);
      var [standaloneView, setStandaloneView] = React.useState(null);
      var [loadError, setLoadError] = React.useState(null);
      var [wsList, setWsList] = React.useState(null);
      var [wsError, setWsError] = React.useState(null);
      var [wsLoading, setWsLoading] = React.useState(false);
      var view = props.view || standaloneView;
      var ws = view?.workspaces;
      var form = useSettingsForm(ctx, {
        enabled: ws?.enabled !== false, chiefWorkspaceId: ws?.chiefWorkspaceId || '',
        chiefTitle: ws?.chiefTitle || 'Hub Bot 中枢',
      }, function (edits) {
        var workspaces = { ...edits };
        if ('chiefWorkspaceId' in edits) workspaces.chiefWorkspaceId = edits.chiefWorkspaceId || null;
        if ('chiefTitle' in edits) workspaces.chiefTitle = edits.chiefTitle.trim() || 'Hub Bot 中枢';
        return { workspaces: workspaces };
      }, function (savedView, patch) {
        if (props.onSaved) props.onSaved(savedView, patch);
        else setStandaloneView(savedView);
      });

      function load() {
        setLoadError(null);
        ctx.remote.hubBotSettings.read().then(unwrap).then(setStandaloneView)
          .catch(function (error) { setLoadError(error?.message || String(error)); });
      }
      function loadWorkspaces() {
        setWsLoading(true);
        setWsError(null);
        ctx.remote.hubBotSettings.listWorkspaces().then(unwrap)
          .then(function (rows) { setWsList(Array.isArray(rows) ? rows : []); })
          .catch(function (error) { setWsError(error?.message || String(error)); })
          .finally(function () { setWsLoading(false); });
      }
      React.useEffect(function () {
        if (!props.view) load();
        loadWorkspaces();
      }, []);

      if (!view) {
        return loadError ? h('div', null,
          h('p', { role: 'alert' }, t('loadFailed') + ' · ' + loadError),
          h('button', { type: 'button', onClick: load, style: settingsButtonStyle }, t('retry')))
          : h('p', null, t('loading'));
      }
      var { enabled, chiefWorkspaceId, chiefTitle } = form.values;
      var workspaceMissing = chiefWorkspaceId && Array.isArray(wsList) && !wsList.some(w => w.workspaceId === chiefWorkspaceId);
      var workspaceForm = h(SettingsForm, { t: t, form: form, title: t('workspaceSection'), headingLevel: props.view ? 'h4' : 'h3' },
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
          h('input', { type: 'checkbox', checked: enabled, onChange: ev => form.change('enabled', ev.target.checked) }),
          h('span', null, t('enabled'))),
        h(SettingsField, { label: t('chiefWorkspace'), hint: t('chiefWorkspaceHint') },
          h('select', { style: settingsInputStyle, value: chiefWorkspaceId, onChange: ev => form.change('chiefWorkspaceId', ev.target.value) },
            h('option', { value: '' }, t('chiefWorkspaceAuto')),
            chiefWorkspaceId && (!wsList || workspaceMissing) ? h('option', { value: chiefWorkspaceId }, chiefWorkspaceId) : null,
            (wsList || []).map(function (w) {
              return h('option', { key: w.workspaceId, value: w.workspaceId }, (w.title || w.workspaceId) + (w.path ? ' — ' + w.path : ''));
            }))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } },
          h('button', { type: 'button', disabled: wsLoading, onClick: loadWorkspaces, style: settingsButtonStyle },
            t(wsLoading ? 'loading' : 'refreshWorkspaces')),
          wsError ? h('span', { role: 'alert', style: settingsHintStyle }, t('loadFailed') + ' · ' + wsError) : null,
          workspaceMissing && !wsError ? h('span', { style: settingsHintStyle }, t('chiefWorkspaceMissing')) : null),
        h(SettingsField, { label: t('chiefTitle'), hint: chiefWorkspaceId ? t('titleManagedByYou') : null },
          h('input', { style: settingsInputStyle, value: chiefTitle, disabled: !!chiefWorkspaceId,
            onChange: ev => form.change('chiefTitle', ev.target.value) })));
      if (props.view) return workspaceForm;
      var model = view.chief?.model;
      return h(React.Fragment, null, workspaceForm,
        h('div', { style: sectionStyle },
          h('h3', { style: sectionTitleStyle }, t('modelSection')),
          h('div', { style: { fontSize: '13px' } }, model ? model.provider + ' / ' + model.model : t('modelFollow')),
          h('div', { style: settingsHintStyle }, t('modelHint'))));
    }

    // cordis 服务 key（不是包名）：fiber.inject 的键按服务名等待；包级依赖在 package.json 的 dsh.client.inject 声明。
    // 本插件用到 ctx.slots / ctx.locale / ctx.remote（v0.1.4 误写成包名导致永久 pending 的教训）。
    var inject = ['slots', 'locale', 'remote', 'connection'];
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
        var ownerLinkError = null;
        var ownerLinkListeners = new Set();
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
        var NEEDS_ME = ['person/answer', 'person/confirm', 'person/review', 'blocked', 'failed'];
        var STAGE_ORDER = [...NEEDS_ME, 'working', 'queued', 'idle', 'done', 'canceled'];
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
        // durText(ms)：时长文本，时间线间隔与等待徽章共用一套刻度（round 64）。
        function durText(ms, t) {
          if (!(ms >= 0)) ms = 0;
          if (ms < 60e3) return t('durNow');
          if (ms < 3600e3) return fill(t('durMin'), Math.floor(ms / 60e3));
          if (ms < 24 * 3600e3) return fill(t('durHour'), Math.floor(ms / 3600e3));
          return fill(t('durDay'), Math.floor(ms / (24 * 3600e3)));
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
        function feishuPresentation(enabled, status) {
          if (!enabled) return { label: 'disabled', stage: 'idle' };
          if (status.registration === 'pending') return { label: 'feishuBindingStatus', stage: 'working' };
          // 绑定流失败/二维码过期都只说明这次「扫码绑定」没走完。
          // 已有可用凭据时（credentialState === 'ok'）现有 Bot 照常工作——继续按连接状态如实呈现，
          // 不把「重扫没走完」说成现有 Bot 故障；未绑上时才是需要用户处理的待办。
          if (status.registration === 'failed' && status.credentialState !== 'ok') return { label: 'feishuBindFailed', stage: 'failed' };
          if (status.registration === 'expired' && status.credentialState !== 'ok') return { label: 'feishuRegistrationExpired', stage: 'failed' };
          if (status.credentialState === 'invalid') return { label: 'feishuCredentialsInvalid', stage: 'failed' };
          if (status.credentialState !== 'ok') return { label: 'feishuWaitingBind', stage: 'queued' };
          if (status.wsState === 'reconnecting') return { label: 'feishuReconnecting', stage: 'working' };
          if (status.wsState === 'connecting') return { label: 'feishuConnecting', stage: 'working' };
          if (status.bot?.connected || status.wsState === 'connected') return { label: 'connected', stage: 'done' };
          return { label: 'feishuWsDown', stage: 'failed' };
        }

        function githubProblemCount(status) {
          return Object.values(status.repos || {}).filter(repo => repo.lastError).length + Object.keys(status.resolveErrors || {}).length;
        }

        function healthProblems(health, t) {
          var items = [];
          var feishu = health.feishu || {};
          var connection = feishuPresentation(feishu.enabled, feishu);
          if (connection.label === 'feishuCredentialsInvalid') items.push(t('healthFeishuCred'));
          if (connection.label === 'feishuBindFailed') items.push(t(connection.label));
          // 过期只在「没绑上」时出现（feishuPresentation 已排除已绑定场景），此时确属需要用户处理的待办。
          if (connection.label === 'feishuRegistrationExpired') items.push(t('healthFeishuRegistration'));
          if (connection.label === 'feishuWsDown') items.push(t('healthFeishuWs'));
          var gh = health.github || {};
          var problems = gh.enabled ? githubProblemCount(gh) : 0;
          if (problems) items.push(fill(t('healthGithubPoll'), problems));

          return items;
        }

        // 飞书 bot 管理块（唯一总 bot）：已绑定名片+权限 / 未绑定预告+扫码 / 失效重扫，三态同一区块。
        function FeishuSection(props) {
          var t = scoped.locale.bind(NS);
          var view = props.view;
          var onRefresh = props.onRefresh;
          var fs = props.status;
          var qr = view.feishu?.status?.qr;
          var enabled = fs.enabled ?? !!view.feishu?.enabled;
          var bound = fs.credentialState === 'ok' && !!fs.bot;
          var pending = enabled && fs.registration === 'pending';
          // 二维码过期：绑定没走完。已保存的绑定不受影响，只给提示 + 显式重新生成入口，不自动重开扫码。
          var expired = enabled && fs.registration === 'expired';
          var form = useSettingsForm(scoped, { enabled }, edits => ({ feishu: edits }), props.onSaved);
          var invalid = fs.credentialState === 'invalid' && !pending;
          var credentialHint = fs.credentialReason === 'credentials-unavailable' ? 'feishuCredentialsUnavailable'
            : fs.credentialReason === 'credentials-malformed' ? 'feishuCredentialsMalformed' : 'feishuInvalid';
          var connection = feishuPresentation(enabled, fs);
          var connectionTone = TONES[STAGE_TONE[connection.stage]];
          var bs = React.useState(false); var busy = bs[0]; var setBusy = bs[1];
          var es = React.useState(null); var err = es[0]; var setErr = es[1];
          React.useEffect(function () {
            if (!pending) return undefined;
            var timer = setInterval(onRefresh, 2500);
            return function () { clearInterval(timer); };
          }, [pending]);
          var start = function () {
            setBusy(true); setErr(null);
            scoped.remote.hubBotSettings.startFeishuRegister()
              .then(unwrap).then(onRefresh)
              .catch(function (e) { setErr(t(bound ? 'feishuReplaceFailedBound' : 'feishuBindFailed') + ': ' + (e && e.message ? e.message : String(e))); })
              .finally(function () { setBusy(false); });
          };
          // 二维码只在 pending 且本次状态确实返回了二维码时才渲染（不拿旧缓存），已保存的绑定与实时二维码始终分开。
          var qrReady = !!(pending && qr?.svg && qr.url === fs.qr?.url);
          var perms = fs.permissions || [];
          var rows = [h(SettingsForm, { key: 'settings', t: t, form: form, title: t('feishuSection'), headingId: 'hub-bot-feishu-title' },
            h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600, fontSize: '13px' } },
              h('input', { type: 'checkbox', checked: form.values.enabled, onChange: ev => form.change('enabled', ev.target.checked) }),
              t('feishuEnableSwitch')),
            h('p', { style: Object.assign({}, settingsHintStyle, { margin: '5px 0 0' }) }, t('feishuEnableHowto')))];
          if (!enabled) rows.push(h('p', { key: 'off', role: 'status', style: settingsHintStyle }, t(bound ? 'feishuPausedBound' : 'feishuDisabled')));
          if (bound) {
            rows.push(h('div', { key: 'card', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
              dot(connectionTone.fg),
              h('span', { style: { fontWeight: 600 } }, fs.bot.name || 'bot'),
              h('span', { style: { fontSize: '12px', opacity: 0.65 } }, 'App ID：' + (fs.bot.appIdMasked || '—')),
              fs.bot.boundAt ? h('span', { style: { fontSize: '12px', opacity: 0.65 } }, t('feishuBoundAt') + ' ' + relTime(t, fs.bot.boundAt)) : null,
              stagePill(connection.stage, t(connection.label === 'connected' ? 'feishuWsOk' : connection.label))));
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
            // 已绑定不自动开扫、也不暗示需要换 Bot：更换是显式操作，先二次确认再走注册流。
            // 已绑定时的重扫（pending/expired）只提示这次更换没走完，现有 Bot 照常工作。
            if (pending) rows.push(h('p', { key: 'pnd', role: 'status', style: { fontSize: '12px', opacity: 0.75, margin: '6px 0 0' } }, t('feishuReplacingBound')));
            else if (expired) rows.push(h('p', { key: 'expb', role: 'status', style: { fontSize: '12px', opacity: 0.75, margin: '6px 0 0' } }, t('feishuRegistrationExpiredBound')));
            if (enabled) {
              rows.push(h('button', { key: 'replace', onClick: function () {
                if (!window.confirm(t('feishuReplaceConfirm'))) return;
                start();
              }, disabled: busy || pending,
                style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 18px', marginTop: '10px', opacity: 0.85 }),
              }, t('feishuReplaceBound')));
            }
          } else if (enabled) {
            if (invalid) rows.push(h('p', { key: 'inv', style: { fontSize: '13px', color: TONES.red.fg, margin: '0 0 4px' } }, t(credentialHint)));
            else if (expired) rows.push(h('p', { key: 'exp', role: 'status', style: { fontSize: '13px', color: TONES.amber.fg, margin: '0 0 4px' } }, t('feishuRegistrationExpiredHint')));
            else if (!pending) rows.push(h('div', { key: 'nb', style: { marginBottom: '4px' } },
              h('div', { style: { fontWeight: 600 } }, t('feishuNotBound')),
              h('p', { style: { fontSize: '12px', opacity: 0.75, margin: '4px 0' } }, t('feishuSetupHint'))));
            if (!pending) {
              rows.push(h('button', { key: 'start', onClick: start, disabled: busy,
                style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 18px', marginTop: '6px' }),
              }, busy ? t('feishuBinding') : t(expired ? 'feishuRetryRegister' : 'feishuBindStart')));
            }
          }
          if (qrReady) {
            rows.push(h('div', { key: 'qr', style: { marginTop: '12px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
              h('img', {
                src: 'data:image/svg+xml;utf8,' + encodeURIComponent(qr.svg),
                alt: 'feishu qr', style: { width: '168px', height: '168px', borderRadius: '8px', background: '#fff', padding: '6px' },
              }),
              h('div', { style: { fontSize: '13px', opacity: 0.8, maxWidth: '320px' } },
                t('feishuScanHint'),
                fs.qr.expireIn ? h('div', { style: { marginTop: '4px', fontSize: '12px', opacity: 0.75 } }, fill(t('feishuQrExpiry'), Math.round(fs.qr.expireIn / 60))) : null)));
          } else if (pending) {
            rows.push(h('p', { key: 'wait', style: { fontSize: '13px', opacity: 0.7 } }, t('feishuBinding')));
          }
          // 事件订阅方式（status.eventMode）: 只有需要人工设置（manual）时才提示；已自动配置保持安静。
          if (enabled && fs.eventMode === 'manual') {
            rows.push(h('p', { key: 'evm', style: { fontSize: '12px', opacity: 0.75, margin: '8px 0 0' } }, t('feishuEventModeManual')));
          }
          if (enabled && perms.length) {
            rows.push(h('div', { key: 'perms', style: { marginTop: '12px' } },
              h('div', { style: { fontSize: '12px', opacity: 0.65, marginBottom: '6px' } }, t('feishuPermsTitle')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, perms.map(function (p) {
                return h('div', { key: p.key, style: { fontSize: '12px', opacity: 0.85 } }, '· ' + (p.label || p.key));
              }))));
          }
          if (enabled && (err || fs.registrationError)) {
            // 已绑定时的注册失败只是这次更换没成功，绑定没变——别让错误行看起来像现有 Bot 坏了。
            var errText = err || ((bound ? t('feishuReplaceFailedBound') : t('feishuBindFailed')) + ' · ' + fs.registrationError);
            rows.push(h('div', { key: 'err', role: 'alert', style: { fontSize: '12px',
              color: 'var(--dsw-alias-state-error-primary)', marginTop: '6px', overflowWrap: 'anywhere' },
            }, errText));
          }
          return h('section', { id: 'hub-bot-feishu', style: sectionStyle, 'aria-labelledby': 'hub-bot-feishu-title' }, rows);
        }

        // GitHub 监听管理块（round 34）：面板此前完全没有 GitHub 区块——状态卡不可点、看不到监听清单。
        // read() 已带全量 github 状态（每仓库水位/错误），纯客户端渲染即可。
        function GithubSection(props) {
          var t = scoped.locale.bind(NS);
          var gh = (props.view && props.view.github) || {};
          var st = props.status || gh.status || {};
          var enabled = st.enabled ?? gh.enabled;
          var repos = st.repos || {};
          var names = Object.keys(repos);
          var resolveErrors = st.resolveErrors || gh.resolveErrors || {};
          var rows = [];
          var form = useSettingsForm(scoped, {
            enabled: !!enabled, interval: String((gh.intervalMs ?? 300000) / 60000), allowlist: (gh.loginAllowlist || []).join('\n'),
          }, function (edits) {
            var github = {};
            if ('enabled' in edits) github.enabled = edits.enabled;
            if ('interval' in edits) {
              var intervalMs = Math.round(Number(edits.interval) * 60000);
              if (!Number.isSafeInteger(intervalMs) || intervalMs < 30000) throw new Error(t('githubMinInvalid'));
              github.intervalMs = intervalMs;
            }
            if ('allowlist' in edits) github.loginAllowlist = edits.allowlist.split('\n').map(line => line.trim()).filter(Boolean);
            return { github: github };
          }, props.onSaved);
          rows.push(h(SettingsForm, { key: 'controls', t: t, form: form, title: t('githubSettingsTitle') },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13px' } },
              h('input', { type: 'checkbox', checked: form.values.enabled, onChange: ev => form.change('enabled', ev.target.checked) }),
              t('githubEnableSwitch')),
            h('p', { style: Object.assign({}, settingsHintStyle, { margin: '5px 0 12px' }) }, t('githubEnableHowto')),
            h(SettingsField, { label: t('githubMinLabel'), hint: t('githubMinHint') },
              h('input', { type: 'number', min: 0.5, step: 'any', value: form.values.interval,
                onChange: ev => form.change('interval', ev.target.value), style: Object.assign({}, settingsInputStyle, { width: '120px' }) })),
            h(SettingsField, { label: t('githubAllowlistLabel') },
              h('textarea', { rows: 3, value: form.values.allowlist, onChange: ev => form.change('allowlist', ev.target.value),
                style: Object.assign({}, settingsInputStyle, { fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }) }))));
          if (!enabled) {
            rows.push(h('p', { key: 'off', role: 'status', style: settingsHintStyle }, t('githubDisabled')));
          } else {
            var mins = (st.intervalMs ?? gh.intervalMs ?? 300000) / 60000;
            var effectiveAllowlist = st.loginAllowlist || gh.loginAllowlist || [];
            var chips = [
              t('githubInterval') + '：' + fill(t('githubIntervalValue'), mins),
              t('githubHandle') + '：' + (gh.mentionHandle || '—'),
              t('githubAllowlist') + '：' + (effectiveAllowlist.length ? effectiveAllowlist.join(', ') : t('githubAllowlistEmpty')),
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
          return h('section', { id: 'hub-bot-github', style: sectionStyle, 'aria-labelledby': 'hub-bot-github-title' },
            h('h4', { id: 'hub-bot-github-title', className: 'hb-scroll-target', tabIndex: -1, style: sectionTitleStyle }, t('githubSection')), rows);
        }

        function RuntimeSection(props) {
          var t = scoped.locale.bind(NS);
          var v = props.view;
          var form = useSettingsForm(scoped, {
            slots: String(v.concurrency?.slotsPerOwner ?? 3),
            reportAuto: !!v.reporting?.auto,
            reportMin: String((v.reporting?.intervalMs ?? 60000) / 60000),
            patterns: (v.security?.dangerousPatterns || []).join('\n'),
          }, function (edits) {
            var patch = {};
            if ('slots' in edits) {
              var slots = Number(edits.slots);
              if (!Number.isSafeInteger(slots) || slots < 1) throw new Error(t('slotsInvalid'));
              patch.concurrency = { slotsPerOwner: slots };
            }
            if ('reportAuto' in edits) patch.reporting = { auto: edits.reportAuto };
            if ('reportMin' in edits) {
              var intervalMs = Math.round(Number(edits.reportMin) * 60000);
              if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error(t('reportMinInvalid'));
              patch.reporting = { ...patch.reporting, intervalMs: intervalMs };
            }
            if ('patterns' in edits) patch.security = { dangerousPatterns: edits.patterns.split('\n').map(line => line.trim()).filter(Boolean) };
            return patch;
          }, props.onSaved);
          var { slots, reportAuto, reportMin, patterns } = form.values;
          return h(SettingsForm, { t: t, form: form, title: t('runtimeSection') },
            h(SettingsField, { label: t('slotsLabel'), hint: t('slotsHint') },
              h('input', { type: 'number', min: 1, step: 1, value: slots, onChange: ev => form.change('slots', ev.target.value),
                style: Object.assign({}, settingsInputStyle, { width: '120px' }) })),
            h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
              h('input', { type: 'checkbox', checked: reportAuto, onChange: ev => form.change('reportAuto', ev.target.checked) }),
              h('span', null, t('reportAutoLabel'))),
            h(SettingsField, { label: t('reportIntervalLabel'), hint: t('reportHint') },
              h('input', { type: 'number', min: 0, step: 'any', value: reportMin, disabled: !reportAuto,
                onChange: ev => form.change('reportMin', ev.target.value),
                style: Object.assign({}, settingsInputStyle, { width: '120px', opacity: reportAuto ? 1 : 0.6 }) })),
            h(SettingsField, { label: t('patternsLabel'), hint: t('patternsHint') },
              h('textarea', { rows: 5, value: patterns, onChange: ev => form.change('patterns', ev.target.value),
                style: Object.assign({}, settingsInputStyle, { fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }) })),
            patterns.trim() === '' ? h('div', { style: Object.assign({}, settingsHintStyle, { color: 'var(--dsw-alias-state-warn-label)' }) }, t('patternsEmptyWarn')) : null);
        }

        function ChiefModelSection(props) {
          var t = scoped.locale.bind(NS);
          var catalog = props.catalog;
          var current = props.view.chief?.model;
          var savedChoice = current ? current.provider + '/' + current.model : '';
          var form = useSettingsForm(scoped, { choice: savedChoice }, function (edits) {
            if (!edits.choice) return { chief: { model: null } };
            var i = edits.choice.indexOf('/');
            return { chief: { model: { provider: edits.choice.slice(0, i), model: edits.choice.slice(i + 1) } } };
          }, props.onSaved);
          if (!Array.isArray(catalog?.groups)) {
            return h('div', { style: sectionStyle }, h('h4', { style: sectionTitleStyle }, t('modelSection')),
              h('p', { style: settingsHintStyle }, t('catalogUnavailable')));
          }
          var choice = form.values.choice;
          var choices = new Set(['']);
          var groups = catalog.groups.map(function (g) {
            return h('optgroup', { key: g.id, label: g.name || g.id }, (g.models || []).map(function (m) {
              var value = g.id + '/' + m.id;
              choices.add(value);
              var label = (m.name || m.id) + (m.reasoning ? ' · reasoning' : '') + (m.badge ? ' · ' + m.badge : '');
              return h('option', { key: value, value: value }, label);
            }));
          });
          var defaultModel = catalog.default;
          var defaultGroup = catalog.groups.find(g => g.id === defaultModel?.provider);
          var defaultEntry = defaultGroup?.models?.find(m => m.id === defaultModel?.model);
          var defaultLabel = defaultModel?.provider ? (defaultGroup?.name || defaultModel.provider) + ' · ' + (defaultEntry?.name || defaultModel.model || '?') : null;
          return h(SettingsForm, { t: t, form: form, title: t('modelSection'),
            labels: { busy: t('modelApplying'), submit: t('modelApply'), saved: t('modelApplied') },
          }, h(SettingsField, { label: t('modelSelectionLabel'), hint: t('modelPickerHint') },
            h('select', { style: settingsInputStyle, value: choice, onChange: ev => form.change('choice', ev.target.value) },
              h('option', { value: '' }, t('modelFollow')),
              !choices.has(choice) ? h('option', { value: choice }, choice) : null, groups)),
          choice === '' && defaultLabel ? h('div', { style: settingsHintStyle }, fill(t('modelDefaultNow'), defaultLabel)) : null);
        }


        var droppedReasonKeys = Object.assign(Object.create(null), {
          'no-mention': 'messageDroppedMention', 'unsupported-type': 'messageDroppedType',
          'bot-ignore': 'messageDroppedIgnore', 'not-allowlisted': 'messageDroppedAllowlist',
          'stop-without-task': 'messageDroppedStop', 'untracked-comment': 'messageDroppedComment',
        });
        function requeueOutbox(request) {
          return scoped.remote.hubBotSettings.retryOutbox(request).then(unwrap);
        }

        function DeliveryHealth({ health, alerts, stale, tickets, unprocessed, onTicket, onMessages, refresh }) {
          var t = scoped.locale.bind(NS);
          var [feedback, setFeedback] = React.useState(null);
          var lock = React.useRef(false);
          var outbox = health.outbox || {};
          var failed = outbox.failedList || [];
          var retrying = outbox.retrying || [];
          var history = outbox.recentProblems || [];
          var hasAlerts = alerts.length || failed.length || retrying.length || unprocessed;
          var compactButton = Object.assign({}, settingsButtonStyle, { padding: '3px 8px', fontSize: '12px' });
          var flexRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px', minWidth: 0 };
          async function act(mode, row) {
            if (lock.current) return;
            var discard = mode === 'discard';
            if (discard && !window.confirm(row ? t('discardOneConfirm') + ' · ' + (row.to || row.id) : t('discardAllConfirm'))) return;
            lock.current = true;
            setFeedback({ busy: true });
            try {
              var request = row ? { id: row.id } : { all: true };
              var result = discard ? unwrap(await scoped.remote.hubBotSettings.discardOutbox(request)) : await requeueOutbox(request);
              var count = discard ? result?.discarded : result?.retried;
              if (!Number.isSafeInteger(count) || count < 0) throw new Error(t('deliveryResultMissing'));
              var message = fill(t(discard ? 'discardedNotice' : 'retriedNotice'), count);
              try {
                await refresh();
                setFeedback({ message });
              } catch (error) {
                setFeedback({ message, error: t('deliveryRefreshFailed') + ' · ' + (error?.message || String(error)) });
              }
            } catch (error) {
              setFeedback({ error: error?.message || String(error) });
              try { await refresh(); } catch { /* Keep the failure from the attempted operation. */ }
            } finally { lock.current = false; }
          }
          function ticketLink(id) {
            if (!id) return null;
            if (!tickets.has(id)) return h('span', { style: settingsHintStyle }, id);
            return h('button', { type: 'button', className: 'hb-text-action', style: { maxWidth: '100%', fontSize: '12px' },
              'aria-label': fill(t('openTicketLabel'), id), onClick: () => onTicket(id),
            }, tickets.get(id).message || id);
          }
          function actionButton(mode, row, label) {
            return h('button', { type: 'button', disabled: !!feedback?.busy, style: compactButton,
              onClick: () => act(mode, row),
            }, t(label));
          }
          function retrySchedule(row) {
            var channel = (row.to || '').split(':')[0];
            if (row.state === 'recorded' && health[channel]?.enabled === false) return t('deliveryChannelPaused');
            if (row.nextRetryAt == null) return t('deliveryNextPass');
            var when = new Date(row.nextRetryAt);
            if (!Number.isFinite(when.getTime())) return t('deliveryNextPass');
            return h('time', { dateTime: when.toISOString(), title: when.toLocaleString() }, t('healthDetailNext') + ' · ' + when.toLocaleTimeString());
          }
          function deliveryRow(row, isFailed) {
            return h('li', { key: row.id, 'data-hb-delivery': row.id, style: { padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l2)',
              overflowWrap: 'anywhere', minWidth: 0 } },
              h('div', { style: flexRow },
                h('strong', { style: { fontSize: '12px' } }, row.to || row.id),
                h('span', { style: settingsHintStyle }, fill(t('messageAttempts'), row.attempts ?? 0)),
                ticketLink(row.ticketId),
                isFailed ? h('div', { style: Object.assign({}, flexRow, { marginLeft: 'auto' }) },
                  row.retryable !== false ? actionButton('retry', row, 'retryOne') : null, actionButton('discard', row, 'discardOne')) : null),
              !isFailed ? h('div', { style: settingsHintStyle }, retrySchedule(row)) : null,
              row.text ? h('p', { style: Object.assign({}, settingsHintStyle, { margin: '4px 0 0' }) }, row.text) : null,
              row.lastError ? h('p', { style: { margin: '4px 0 0', fontSize: '12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                h('strong', null, t('healthDetailLast') + ' · '), row.lastError) : null);
          }
          var listStyle = { listStyle: 'none', padding: 0, margin: '6px 0 0', maxHeight: '300px', overflowY: 'auto' };
          var groupStyle = { padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' };
          function deliveries(rows, isFailed) {
            if (!rows.length) return null;
            return h('details', { key: isFailed ? 'failed' : 'retrying', style: groupStyle },
              h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, t(isFailed ? 'healthDetailDead' : 'healthDetailRetry') + ' · ' + rows.length),
              isFailed && rows.length > 1 ? h('div', { style: Object.assign({}, flexRow, { marginTop: '6px' }) },
                rows.some(row => row.retryable !== false) ? actionButton('retry', null, 'retryAll') : null, actionButton('discard', null, 'discardAll')) : null,
              h('ul', { style: listStyle }, rows.map(row => deliveryRow(row, isFailed))));
          }
          if (!hasAlerts && !history.length && !feedback) {
            return stale ? null : h('p', { style: Object.assign({}, settingsHintStyle, { margin: '0 0 16px' }) }, t('healthOk'));
          }
          return h('section', { id: 'hub-bot-delivery', 'aria-labelledby': 'hub-bot-delivery-title',
            style: { padding: '10px 14px', marginBottom: '18px', minWidth: 0, borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-card-fill)', fontSize: '13px' },
          },
            h('h3', { id: 'hub-bot-delivery-title', style: { fontSize: '13px', margin: '0 0 6px' } }, t('deliveryHealthTitle')),
            alerts.map(item => h('p', { key: item, style: { margin: '6px 0' } }, item)),
            unprocessed > 0 ? h('p', { style: flexRow }, fill(t('healthUnprocessed'), unprocessed),
              onMessages ? h('button', { type: 'button', style: compactButton, onClick: onMessages }, t('healthUnprocessedJump')) : null) : null,
            feedback ? h('div', { style: Object.assign({}, flexRow, { margin: '8px 0', padding: '6px 8px', borderRadius: '6px',
              background: feedback.error ? 'var(--dsw-alias-state-warn-tertiary)' : 'var(--dsw-alias-card-tile-fill)' }) },
              h('span', { role: feedback.error ? 'alert' : 'status', style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } },
                feedback.busy ? t('deliveryUpdating') : feedback.message, feedback.error ? h('span', { style: { display: 'block' } }, feedback.error) : null),
              feedback.busy ? null : h('button', { type: 'button', style: compactButton, onClick: () => setFeedback(null) }, t('dismissTicketFeedback'))) : null,
            deliveries(failed, true), deliveries(retrying, false),
            history.length ? h('details', { style: groupStyle },
              h('summary', { style: { cursor: 'pointer' } }, t('deliveryHistory') + ' · ' + (outbox.systemProblems || history.length)),
              history.length < outbox.systemProblems ? h('p', { style: settingsHintStyle }, fill(t('deliveryHistoryLimit'), history.length)) : null,
              h('ul', { style: listStyle }, history.map(row => h('li', { key: row.id, style: { padding: '6px 0', overflowWrap: 'anywhere' } },
                h('div', { style: flexRow }, row.at ? h('time', { dateTime: row.at, title: row.at, style: settingsHintStyle }, relTime(t, row.at)) : null, ticketLink(row.ticketId)),
                row.body || '—')))) : null);
        }

        function RecentMessageRow(props) {
          var { entry, t, channel, ownerButton, onTicket, onRetry, onCopy, copiedId } = props;
          var [expanded, setExpanded] = React.useState(false);
          var [detail, setDetail] = React.useState(null);
          var [loadAttempt, setLoadAttempt] = React.useState(0);
          var [requeue, setRequeue] = React.useState(null);
          var detailId = React.useId();
          var replyId = entry.reply?.id;
          var replyState = entry.reply?.state;
          var replyAttempts = entry.reply?.attempts;
          React.useEffect(function () {
            if (!expanded) return;
            var current = true;
            setDetail(null);
            scoped.remote.hubBotSettings.messageDetail({ triggerId: entry.id }).then(unwrap).then(function (result) {
              if (result?.id !== entry.id) throw new Error(t('messageUnavailable'));
              if (current) setDetail({ result });
            }).catch(function (error) {
              if (current) setDetail({ error: error?.message || String(error) });
            });
            return function () { current = false; };
          }, [expanded, entry.id, replyId, replyState, replyAttempts, entry.replyUnlinked, loadAttempt]);

          async function retryReply() {
            if (!replyId || requeue?.busy) return;
            setRequeue({ busy: true });
            try {
              var result = await requeueOutbox({ id: replyId });
              await onRetry();
              setRequeue({ message: fill(t('retriedNotice'), result.retried) });
            } catch (error) {
              setRequeue({ error: error?.message || String(error) });
            }
          }

          var actionStyle = Object.assign({}, settingsButtonStyle, { fontSize: '11px', padding: '3px 8px' });
          var wrappingRow = { display: 'flex', flexWrap: 'wrap', gap: '6px 8px', alignItems: 'center', minWidth: 0 };
          function badge(label, fillColor) {
            return h('span', { style: { padding: '2px 6px', borderRadius: '6px', fontSize: '11px', background: fillColor } }, label);
          }
          function textBlock(label, text, key, copyLabel, metadata) {
            return h('div', { style: { minWidth: 0 } },
              h('div', { style: Object.assign({}, wrappingRow, { justifyContent: 'space-between', marginBottom: '5px' }) },
                h('strong', { style: { fontSize: '12px' } }, label),
                text ? h('button', { type: 'button', style: actionStyle, onClick: () => onCopy(text, key),
                  'aria-label': t(copyLabel),
                }, copiedId === key ? t('copiedBtn') : t('copyIdBtn')) : null),
              metadata,
              h('p', { style: { margin: 0, padding: '8px 10px', fontSize: '13px', lineHeight: 1.55,
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '240px', overflowY: 'auto',
                background: 'var(--dsw-alias-card-fill)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px' },
              }, text || t('messageNoText')));
          }
          var reply = detail?.result?.reply;
          var preview = entry.message || t('messageNoText');
          var routeBadge = entry.dropped ? badge(t('droppedLabel'), 'var(--dsw-alias-state-warn-tertiary)')
            : entry.unprocessed ? badge(t('unprocessedLabel'), 'var(--dsw-alias-file-diff-deleted-gutter)')
            : entry.stageText ? badge(entry.stageText, TONES[STAGE_TONE[entry.stage] || 'gray'].bg)
            : entry.injectedAt ? badge(t('replyInjected'), 'var(--dsw-alias-card-tile-fill)') : null;
          var replyBadge = replyState === 'failed' ? badge(t('replyFailed'), 'var(--dsw-alias-file-diff-deleted-gutter)')
            : replyState === 'sent' ? badge(t('replySent'), 'var(--dsw-alias-state-success-tertiary)')
            : replyState ? badge(t('replyPending'), 'var(--dsw-alias-state-warn-tertiary)')
            : entry.replyUnlinked ? badge(t('replyUnlinked'), 'var(--dsw-alias-card-tile-fill)') : null;
          return h('li', { className: 'hb-message-row', 'data-hb-message': entry.id, style: { padding: '8px 10px', minWidth: 0 } },
            h('div', { style: wrappingRow },
              h('button', { type: 'button', className: 'hb-message-preview', 'aria-expanded': expanded, 'aria-controls': detailId,
                'aria-label': fill(t('messageDetailLabel'), preview),
                onClick: function () { if (expanded) setDetail(null); setExpanded(!expanded); },
                style: { display: 'grid', gridTemplateColumns: '4rem minmax(0, 1fr) auto', gap: '6px', alignItems: 'center', flex: '1 1 200px',
                  minWidth: 0, border: 0, padding: '2px 0', color: 'inherit', background: 'transparent', textAlign: 'start', cursor: 'pointer' },
              },
                h('span', { style: settingsHintStyle }, channel,
                  entry.at ? h('time', { dateTime: entry.at, title: entry.at, style: { display: 'block', fontSize: '11px', fontVariantNumeric: 'tabular-nums' } }, relTime(t, entry.at)) : null),
                h('span', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview),
                h('span', { 'aria-hidden': true, style: settingsHintStyle }, expanded ? '▴' : '▾')),
              routeBadge, replyBadge, ownerButton,
              entry.ticketId ? h('button', { type: 'button', style: actionStyle,
                'aria-label': fill(t('openTicketLabel'), entry.ticketId), onClick: () => onTicket(entry.ticketId),
              }, t('messageOpenTicket')) : null,
              replyState === 'failed' ? h('button', { type: 'button', style: actionStyle, disabled: requeue?.busy, onClick: retryReply,
              }, t(requeue?.busy ? 'messageRetrying' : 'retryOne')) : null),
            requeue?.message || requeue?.error ? h('p', { role: requeue.error ? 'alert' : 'status',
              style: Object.assign({}, settingsHintStyle, { margin: '4px 0 0', overflowWrap: 'anywhere' }) }, requeue.error || requeue.message) : null,
            h('div', { id: detailId, hidden: !expanded, style: { marginTop: expanded ? '8px' : 0 } }, expanded ? [
              entry.dropped ? h('p', { key: 'dropped', style: Object.assign({}, settingsHintStyle, { margin: '0 0 6px' }) },
                t('droppedLabel') + ' · ' + t(droppedReasonKeys[entry.dropped] || 'messageDroppedOther'),
                !Object.hasOwn(droppedReasonKeys, entry.dropped) ? ' ' + entry.dropped : null) : null,
              detail?.error ? h('div', { key: 'error', style: wrappingRow },
                h('span', { role: 'alert', style: settingsHintStyle }, t('loadFailed') + ' · ' + detail.error),
                h('button', { type: 'button', style: actionStyle, onClick: () => setLoadAttempt(n => n + 1) }, t('retry'))) : null,
              !detail ? h('div', { key: 'loading', role: 'status', style: settingsHintStyle }, t('loading')) : null,
              detail?.result ? h('div', { key: 'text', style: { display: 'grid', gap: '10px',
                gridTemplateColumns: reply ? 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' : 'minmax(0, 1fr)' } },
                textBlock(t('messageOriginal'), detail.result.message, 'msg:' + entry.id, 'copyMessageText'),
                reply ? textBlock(t('messageReply'), reply.text, 'rpl:' + reply.id, 'copyReplyText',
                  h('div', { style: Object.assign({}, settingsHintStyle, { marginBottom: '4px', overflowWrap: 'anywhere' }) },
                    reply.sentAt ? h('time', { dateTime: reply.sentAt, title: reply.sentAt }, t('replySent') + ' · ' + new Date(reply.sentAt).toLocaleString()) : null,
                    reply.attempts > 0 && reply.state !== 'sent' ? fill(t('messageAttempts'), reply.attempts) : null,
                    reply.lastError && reply.state !== 'sent' ? h('div', null, reply.lastError) : null)) : null) : null,
              detail?.result?.intake ? h('p', { key: 'intake', style: settingsHintStyle },
                t('intakeDisposition') + ' · ' + t(({
                  dropped: 'intakeDropped', discarded: 'intakeDiscarded', injected: 'intakeInjected', pending: 'intakePending', failed: 'intakeFailed',
                  interrupt: 'intakeInterrupt', 'interrupt-requested': 'intakeInterruptRequested',
                })[detail.result.intake.disposition] || 'intakePending'),
                detail.result.intake.lastError ? h('span', null, ' · ' + detail.result.intake.lastError) : null) : null,
              detail?.result?.intake?.cohort ? h('details', { key: 'cohort' },
                h('summary', { style: settingsHintStyle }, t('intakeCohort') + ' · ' + detail.result.intake.cohort.mergedCount),
                h('ul', null, detail.result.intake.cohort.messages.map(item => h('li', { key: item.triggerId },
                  h('span', { style: settingsHintStyle }, [item.triggerId, ...item.ticketIds].join(' · ')),
                  h('p', { style: { margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, item.message))))) : null,
              detail?.result?.replyUnlinked ? h('p', { key: 'unlinked', style: settingsHintStyle }, t('replyUnlinkedHint')) : null,
            ] : null));
        }

        function TicketReport({ report, copied, copy }) {
          var t = scoped.locale.bind(NS);
          var titleId = React.useId();
          var summary = [report.summary, report.text].find(text => typeof text === 'string' && text.trim()) || '';
          var fields = [
            ['result', 'reportResult'], ['changes', 'reportChanges'],
            ['verification', 'reportVerification'], ['risks', 'reportRisks'],
          ].map(function ([key, label]) { return { key, label: t(label), text: report.sections?.[key] }; })
            .filter(field => typeof field.text === 'string' && field.text.trim());
          var evidence = typeof report.evidence === 'string' ? report.evidence : report.evidence == null ? '' : JSON.stringify(report.evidence, null, 2);
          var showSummary = summary.trim() && summary.trim() !== fields.find(field => field.key === 'result')?.text.trim();
          if (!showSummary && !fields.length && !evidence.trim()) return null;
          var parts = [showSummary ? summary : '', ...fields.map(field => field.label + '\n' + field.text),
            evidence.trim() ? t('reportEvidence') + '\n' + evidence : ''].filter(Boolean);
          var bodyStyle = { margin: 0, fontSize: '13px', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };
          return h('section', { 'aria-labelledby': titleId, 'data-hb-report': '',
            style: { marginTop: '8px', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px', background: 'var(--dsw-alias-card-fill)', minWidth: 0 },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px 10px', flexWrap: 'wrap' } },
              h('h4', { id: titleId, style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, t('reportLabel')),
              h('button', { type: 'button', style: settingsButtonStyle, 'aria-label': t('copyReportHint'),
                onClick: () => copy(parts.join('\n\n')),
              }, copied ? t('copiedBtn') : t('copyReportBtn'))),
            showSummary ? h('p', { style: Object.assign({}, bodyStyle, { marginTop: '7px' }) }, summary) : null,
            fields.length ? h('dl', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 270px), 1fr))',
              gap: '8px', margin: '8px 0 0', maxWidth: '800px' },
            }, fields.map(function (field) {
              return h('div', { key: field.key, style: { minWidth: 0, padding: '8px 10px', borderRadius: '6px',
                background: field.key === 'risks' ? 'var(--dsw-alias-state-warn-tertiary)' : 'var(--dsw-alias-card-tile-fill)' },
              }, h('dt', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '3px' } }, field.label),
                 h('dd', { style: bodyStyle }, field.text));
            })) : null,
            evidence.trim() ? h('details', { style: { marginTop: '8px', fontSize: '12px' } },
              h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, t('reportEvidence')),
              h('pre', { style: Object.assign({}, bodyStyle, { marginTop: '6px', padding: '8px 10px',
                borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', maxHeight: '260px', overflowY: 'auto',
                fontFamily: 'monospace' }), tabIndex: 0 }, evidence)) : null);
        }

        var runStateLabels = { silent: 'runSilent', waiting: 'runWaiting', sent: 'runSent', failed: 'runFailed', 'in-progress': 'runUnsent' };
        var runResultLabels = { result: 'runResult', failure: 'runExecutionFailed', blocked: 'runBlocked' };

        function TicketFacts({ ticket, render, generationId, ownerId }) {
          var t = scoped.locale.bind(NS);
          var [reading, setReading] = React.useState(null);
          var [attempt, retry] = React.useState(0);
          React.useEffect(function () {
            var current = true;
            setReading(null);
            if (!generationId) return;
            void scoped.remote.hubBotSettings.ticketDetail(ticket.id).then(unwrap).then(detail => {
              if (!detail || (ownerId && detail.owner !== ownerId)) throw new Error(t('ticketUnavailable'));
              if (current) setReading({ detail });
            }).catch(error => { if (current) setReading({ error: error?.message ?? String(error) }); });
            return () => { current = false; };
          }, [ticket.id, ticket.updatedAt, generationId, attempt, ownerId]);
          if (!generationId) return h('p', { role: 'status' }, t('monitorDisconnected'));
          if (reading?.error) return h('div', null, h('p', { role: 'alert' }, t('loadFailed') + ' · ' + reading.error),
            h('button', { type: 'button', style: settingsButtonStyle, onClick: () => retry(value => value + 1) }, t('retry')));
          return reading?.detail ? render(reading.detail) : h('p', { role: 'status', style: settingsHintStyle }, t('loading'));
        }

        function RunHistoryRow({ run, onTask, onWorker, ticketIds, t }) {
          var [open, setOpen] = React.useState(false);
          var [detail, setDetail] = React.useState(null);
          var [error, setError] = React.useState(null);
          var [notificationRequest, setNotificationRequest] = React.useState(null);
          React.useEffect(function () {
            if (!open) return;
            var current = true;
            setError(null);
            void scoped.remote.hubBotSettings.runDetail({ id: run.id }).then(unwrap).then(value => {
              if (value?.id !== run.id || value.ownerId !== run.ownerId || value.ticketId !== run.ticketId) throw new Error(t('loadFailed'));
              if (current) setDetail(value);
            }).catch(error => { if (current) setError(error?.message ?? String(error)); });
            return () => { current = false; };
          }, [open, run]);
          var date = instant => instant ? new Date(instant).toLocaleString() : '';
          var source = run.source.kind === 'github' ? [run.source.repo ?? 'GitHub', run.source.issueNumber && '#' + run.source.issueNumber].filter(Boolean).join(' ')
            : [t('runTimer'), run.source.timerId].filter(Boolean).join(' ');
          return h('details', { style: { marginBottom: '8px' }, onToggle: event => {
            if (event.target !== event.currentTarget) return;
            setOpen(event.currentTarget.open);
            if (!event.currentTarget.open) {
              setDetail(null);
              setNotificationRequest(null);
            }
          } },
            h('summary', { style: { cursor: 'pointer', padding: '4px 0', overflowWrap: 'anywhere' } },
              [date(run.createdAt), source, t(runStateLabels[run.status] ?? 'runUnsent'), run.result && t(runResultLabels[run.result.kind])].filter(Boolean).join(' · ')),
            open ? h('div', { style: Object.assign({}, settingsHintStyle, { overflowWrap: 'anywhere' }) },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' } },
                h('button', { type: 'button', style: settingsButtonStyle, onClick: () => onTask(run.ticketId) }, t('runTask')),
                run.source.url ? h('a', { href: run.source.url, target: '_blank', rel: 'noreferrer' }, t('runSourceLink')) : null,
                run.workerSession?.sessionId && onWorker ? h('button', { type: 'button', style: settingsButtonStyle,
                  onClick: () => void onWorker(run.workerSession.sessionId).catch(error => setError(error?.message ?? String(error))) }, t('runOpenWorker')) : null),
              run.reason ? h('p', null, run.reason) : null,
              run.source.fireAt ? h('p', null, date(run.source.fireAt)) : null,
              error ? h('p', { role: 'alert' }, error) : !detail ? h('p', null, t('runLoading')) : null,
              detail?.lastProgressAt ? h('p', null, t('runLastProgress') + ' · ' + date(detail.lastProgressAt)) : null,
              ...(detail?.results ?? []).map((result, index) => h('p', { key: 'result-' + index },
                [t(runResultLabels[result.kind]), date(result.at)].filter(Boolean).join(' · '))),
              ...(detail?.notifications ?? []).map((notice, index) => h('div', { key: 'notice-' + index,
                style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 8px', margin: '6px 0' } },
                [notice.channel, notice.channelAccepted ? t('runSent') : t(runStateLabels[notice.state] ?? (['held', 'queued', 'recorded'].includes(notice.state) ? 'runWaiting' : 'runUnsent')), date(notice.acceptedAt)].filter(Boolean).join(' · '),
                notice.id ? h('span', null, notice.id) : null,
                notice.id && ['recorded', 'queued', 'sent', 'failed'].includes(notice.state) ? h('button', { type: 'button', style: settingsButtonStyle, title: notice.id,
                  onClick: () => setNotificationRequest({ id: notice.id }) }, t('notificationOpen')) : null)),
              notificationRequest ? h(RunNotification, { request: notificationRequest, ticketIds, onTask, t }) : null) : null);
        }

        function NotificationTasks({ detail, ticketIds, onTask, t }) {
          var tickets = ticketIds ? detail.tickets.filter(ticket => ticketIds.has(ticket.ticketId)) : detail.tickets;
          if (!tickets.length) return h('p', { style: settingsHintStyle }, t('notificationEmpty'));
          return h('ul', { style: { paddingInlineStart: '18px' } }, tickets.map(ticket => h('li', { key: ticket.ticketId },
            h('button', { type: 'button', style: Object.assign({}, settingsButtonStyle, { maxWidth: '100%', overflowWrap: 'anywhere' }),
              onClick: () => onTask(ticket.ticketId) }, t('runTask') + ' ' + ticket.ticketId))));
        }

        function RunNotification({ request, ticketIds, onTask, t }) {
          var [reading, setReading] = React.useState(null);
          React.useEffect(() => {
            var active = true;
            void scoped.remote.hubBotSettings.notificationDetail(request).then(unwrap).then(detail => {
              if (detail?.id !== request.id || !Array.isArray(detail.tickets)) throw new Error(t('loadFailed'));
              if (active) setReading({ request, detail });
            }).catch(error => { if (active) setReading({ request, error: error?.message ?? String(error) }); });
            return () => { active = false; };
          }, [request]);
          if (reading?.request !== request) return h('p', { role: 'status' }, t('notificationLoading'));
          if (reading.error) return h('p', { role: 'alert' }, reading.error);
          return h('div', null, h('p', null, t('notificationId') + ' · ' + request.id),
            h(NotificationTasks, { detail: reading.detail, ticketIds, onTask, t }));
        }

        function NotificationLookup({ onTask, t }) {
          var [id, setId] = React.useState('');
          var [request, setRequest] = React.useState(null);
          function lookup(event) {
            event.preventDefault();
            if (id.trim()) setRequest({ id: id.trim() });
          }
          return h('div', { style: { margin: '8px 0' } },
            h('form', { onSubmit: lookup, style: { display: 'flex', flexWrap: 'wrap', gap: '6px 8px', alignItems: 'center' } },
              h('label', null, t('notificationId'), ' ', h('input', { type: 'text', value: id, onChange: event => setId(event.target.value), required: true, maxLength: 200, style: settingsInputStyle })),
              h('button', { type: 'submit', style: settingsButtonStyle }, t('notificationLookup'))),
            request ? h(RunNotification, { request, onTask, t }) : null);
        }

        function RunHistory({ onTask, onWorker, active, workspace, refreshWorkspace }) {
          var t = scoped.locale.bind(NS);
          var ownerId = workspace?.owner.id;
          var headingId = ownerId ? 'hub-bot-owner-runs-title' : 'hub-bot-runs-title';
          var ticketIds = React.useMemo(() => workspace && new Set(workspace.tickets.map(ticket => ticket.id)), [workspace]);
          var [status, setStatus] = React.useState('');
          var [source, setSource] = React.useState('');
          var [offsets, setOffsets] = React.useState([0]);
          var [refresh, setRefresh] = React.useState(0);
          var [reading, setReading] = React.useState(null);
          var offset = offsets.at(-1);
          var homePage = Boolean(workspace && !status && !source && offset === 0);
          var queryKey = JSON.stringify([ownerId, status, source, offset]);
          React.useEffect(function () {
            if (!active || homePage) return;
            var current = true;
            var request = { limit: 20, offset, ...(ownerId && { ownerId }), ...(status && { status }), ...(source && { source }) };
            void scoped.remote.hubBotSettings.listRuns(request).then(unwrap).then(value => {
              if (!Array.isArray(value?.runs)) throw new Error(t('loadFailed'));
              var page = ownerId ? { ...value, runs: value.runs.filter(run => run.ownerId === ownerId) } : value;
              if (current) setReading({ queryKey, page });
            }).catch(error => { if (current) setReading({ queryKey, error: error?.message ?? String(error) }); });
            return () => { current = false; };
          }, [queryKey, refresh, active, homePage, workspace]);
          var page = homePage ? { runs: workspace.runs, nextOffset: workspace.nextRunOffset } : reading?.queryKey === queryKey ? reading.page : null;
          var error = !homePage && reading?.queryKey === queryKey ? reading.error : null;
          function select(label, value, options, setValue) {
            return h('label', null, t(label), ' ', h('select', { style: settingsButtonStyle, value, onChange: event => {
              setOffsets([0]); setValue(event.target.value);
            } }, options.map(([key, label]) => h('option', { key, value: key }, t(label)))));
          }
          return h('section', { id: ownerId ? 'hub-bot-owner-runs' : 'hub-bot-runs', style: sectionStyle, 'aria-labelledby': headingId },
            h('h3', { id: headingId, tabIndex: -1, className: 'hb-scroll-target', style: sectionTitleStyle }, t('runSection')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' } },
              select('runStateFilter', status, [['', 'runAll'], ...Object.entries(runStateLabels)], setStatus),
              select('runSourceFilter', source, [['', 'runAll'], ['github', 'kindGitHub'], ['timer', 'runTimer']], setSource),
              h('button', { type: 'button', style: settingsButtonStyle, onClick: () => {
                if (homePage) void refreshWorkspace(); else setRefresh(value => value + 1);
              } }, t('runRefresh'))),
            ownerId ? null : h(NotificationLookup, { onTask, t }),
            error ? h('p', { role: 'alert', style: { overflowWrap: 'anywhere' } }, error) : !page ? h('p', { role: 'status', style: settingsHintStyle }, t('runLoading')) : null,
            page && page.runs.length === 0 ? h('p', { style: settingsHintStyle }, t('runEmpty')) : null,
            ...(page?.runs ?? []).map(run => h(RunHistoryRow, { key: run.id, run, onTask, onWorker, ticketIds, t })),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 8px' } },
              offsets.length > 1 ? h('button', { type: 'button', style: settingsButtonStyle, onClick: () => setOffsets(offsets.slice(0, -1)) }, t('runPrevious')) : null,
              page?.nextOffset != null ? h('button', { type: 'button', style: settingsButtonStyle, onClick: () => setOffsets([...offsets, page.nextOffset]) }, t('runNext')) : null));
        }

        function TimerSection({ headingId = 'hub-bot-timers-title', timers, ownerNames, onTask, onWorker, onRefresh, disabled }) {
          var t = scoped.locale.bind(NS);
          var [busy, setBusy] = React.useState(false);
          var [error, setError] = React.useState(null);
          if (!Array.isArray(timers)) return null;
          var timerActionsStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' };
          async function act(timer, action) {
            if (busy || disabled || (action === 'cancel' && !window.confirm(t('timerCancel') + ' · ' + timer.message + '?'))) return;
            setBusy(true);
            setError(null);
            try {
              unwrap(await scoped.remote.hubBotSettings.timerAction({ id: timer.id, action }));
              await onRefresh();
            } catch (failure) { setError(failure?.message ?? String(failure)); }
            finally { setBusy(false); }
          }
          return h('section', { id: headingId.replace(/-title$/, ''), style: sectionStyle, 'aria-labelledby': headingId },
            h('h3', { id: headingId, tabIndex: -1, className: 'hb-scroll-target', style: sectionTitleStyle }, t('timersSection')),
            error ? h('p', { role: 'alert', style: settingsHintStyle }, error) : null,
            timers.length ? timers.map(function (timer) {
              var stoppable = timer.status === 'firing' || (timer.status === 'fired' && timer.delivery?.state === 'queued') || (timer.schedule && timer.status === 'failed');
              var actions = timer.status === 'pending' ? ['pause', 'cancel'] : timer.status === 'paused' ? ['resume', 'cancel'] : stoppable ? ['cancel'] : [];
              var statusKey = ({ pending: 'timerPending', paused: 'timerPaused', firing: 'timerFiring', fired: 'timerFired', cancelled: 'timerCancelled', failed: 'timerFailed' })[timer.status];
              var deliveryKey = ({ sent: 'timerDeliverySent', queued: 'timerDeliveryQueued', failed: 'timerDeliveryFailed' })[timer.delivery?.state];
              var worker = timer.delivery?.workerSession;
              var schedule = timer.schedule;
              var cadence = schedule?.frequency === 'daily' ? t('timerDaily').replace('{time}', schedule.time)
                : schedule?.frequency === 'weekly' ? t('timerWeekly').replace('{weekday}', t('timerWeekday' + schedule.weekday)).replace('{time}', schedule.time) : null;
              var time = timer.fireAt ? new Date(timer.fireAt).toLocaleString(undefined, schedule ? { timeZone: 'Asia/Shanghai' } : {}) : '—';
              if (schedule) time = timer.status === 'cancelled' ? null : t('timerNext').replace('{time}', time);
              return h('div', { key: timer.id, style: { margin: '8px 0', overflowWrap: 'anywhere' } },
                h('strong', null, timer.message),
                h('div', { style: settingsHintStyle }, [ownerNames?.get(timer.ownerId) ?? (ownerNames ? timer.ownerId : null), cadence, time, statusKey ? t(statusKey) : timer.status, deliveryKey ? t(deliveryKey) : null, timer.late ? t('timerLate') : null].filter(Boolean).join(' · ')),
                timer.lastError?.message || timer.delivery?.lastError
                  ? h('p', { role: 'alert', style: settingsHintStyle }, timer.lastError?.message ?? timer.delivery.lastError) : null,
                h('div', { style: timerActionsStyle }, actions.map(action => h('button', { key: action, type: 'button', style: settingsButtonStyle, disabled: busy || disabled, onClick: () => void act(timer, action) },
                  t(({ pause: 'timerPause', resume: 'timerResume', cancel: 'timerCancel' })[action]))),
                  timer.delivery?.ticketId ? h('button', { type: 'button', style: settingsButtonStyle, onClick: () => onTask(timer.delivery.ticketId) }, t('timerRun')) : null,
                  worker?.sessionId && onWorker ? h('button', { type: 'button', style: settingsButtonStyle, onClick: () => {
                    void onWorker(worker.sessionId).catch(failure => setError(failure?.message ?? String(failure)));
                  } }, t('timerWorker')) : null));
            }) : h('p', { style: settingsHintStyle }, t('timersEmpty')));
        }

        var ownerWorkspacePage = 'hub-bot-owner-workspace-title';
        function linkedWorkspaceOwner() {
          return new URL(window.location.href).searchParams.get('hubBotWorkspace') || '';
        }

        function useOwnerWorkspace(ownerId, generationId) {
          var address = React.useMemo(() => ownerId && generationId ? { ownerId, generationId } : null, [ownerId, generationId]);
          var active = React.useRef(null);
          var [reading, setReading] = React.useState(null);
          React.useLayoutEffect(() => {
            active.current = address && { address, request: null };
            return () => { active.current = null; };
          }, [address]);
          var isCurrent = React.useCallback(() => Boolean(address && active.current?.address === address
            && scoped.connection.generation.getSnapshot()?.id === address.generationId), [address]);
          var refresh = React.useCallback(async () => {
            if (!isCurrent()) return;
            var scope = active.current;
            var request = {};
            scope.request = request;
            setReading(current => current?.address === address ? { ...current, loading: true } : { address, loading: true });
            var isLatest = () => isCurrent() && active.current === scope && scope.request === request;
            try {
              var value = unwrap(await scoped.remote.hubBotSettings.ownerWorkspace({ ownerId: address.ownerId }));
              if (value?.owner?.id !== address.ownerId || !Array.isArray(value.tickets) || !Array.isArray(value.timers) || !Array.isArray(value.runs)
                || value.tickets.some(ticket => ticket.owner !== address.ownerId) || value.timers.some(timer => timer.ownerId !== address.ownerId)
                || value.runs.some(run => run.ownerId !== address.ownerId) || (value.switchOperation && value.switchOperation.ownerId !== address.ownerId)) {
                throw new Error(scoped.locale.bind(NS)('loadFailed'));
              }
              if (isLatest()) setReading({ address, value });
            } catch (error) {
              if (isLatest()) setReading(current => ({
                address, error: error?.message ?? String(error),
                value: current?.address === address && (error?.remoteError?.code ?? error?.code) !== 'owner-workspace/not-found' ? current.value : undefined,
              }));
            } finally {
              if (scope.request === request) scope.request = null;
            }
          }, [address, isCurrent]);
          React.useEffect(() => {
            if (!address) return;
            void refresh();
            function poll() { if (!document.hidden && !active.current?.request) void refresh(); }
            var timer = setInterval(poll, 15000);
            document.addEventListener('visibilitychange', poll);
            return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
          }, [address, refresh]);
          return { ...(reading?.address === address ? reading : null), refresh, isCurrent };
        }

        var boardSections = [
          ['hub-bot-overview-title', 'statusSection'], [ownerWorkspacePage, 'ownerWorkspace'], ['hub-bot-timers-title', 'timersSection'],
          ['hub-bot-runs-title', 'runSection'], ['hub-bot-connections', 'connectionsSection'], ['hub-bot-settings', 'settingsDivider'],
        ];
        var boardScrollGap = 16;

        var ownerSwitchLabels = {
          waiting: 'switchWaiting', preparing: 'switchPreparing', committed: 'switchCommitted', 'archive-failed': 'switchArchiveFailed',
          completed: 'switchCompleted', failed: 'switchFailed', cancelled: 'switchCancelled',
        };

        function HandoffSummaryEditor({ owner, t, onClose, onRefresh, disabled }) {
          var [draft, setDraft] = React.useState(null);
          var [text, setText] = React.useState('');
          var [busy, setBusy] = React.useState(true);
          var [error, setError] = React.useState(null);
          var [status, setStatus] = React.useState('');
          var current = { ownerId: owner.id, expectedSessionId: owner.sessionId };
          var send = async (action, fields = {}) => unwrap(await scoped.remote.hubBotSettings.handoffSummaryAction({ action, ...current, ...fields }));
          function place(value) { setDraft(value); setText(value?.text ?? ''); }
          React.useEffect(() => {
            var mounted = true;
            async function load() {
              try {
                var list = await send('list');
                var item = list?.length ? await send('get', { draftId: list[0].draftId }) : null;
                if (mounted) place(item);
              } catch (failure) { if (mounted) setError(failure?.message ?? String(failure)); }
              finally { if (mounted) setBusy(false); }
            }
            void load();
            return () => { mounted = false; };
          }, [owner.id, owner.sessionId]);
          async function run(work) {
            if (busy || disabled) return;
            setBusy(true);
            setError(null);
            setStatus('');
            try { await work(); } catch (failure) { setError(failure?.message ?? String(failure)); }
            finally { setBusy(false); }
          }
          var confirmed = draft?.status === 'confirmed' && text === draft.text;
          var version = draft && { draftId: draft.draftId, revision: draft.revision };
          var button = (label, action) => h('button', { type: 'button', style: settingsButtonStyle, disabled: busy || disabled, onClick: () => void run(action) }, t(label));
          async function confirmDraft() {
            var saved = text !== draft.text ? await send('edit', { ...version, text }) : draft;
            place(saved);
            var reviewed = await send('confirm', { draftId: saved.draftId, revision: saved.revision });
            place(reviewed);
            setStatus(t('handoffConfirmed'));
          }
          async function start(mode) {
            if (!confirmed || (mode === 'stop' && !window.confirm(t('switchStopConfirm')))) return;
            unwrap(await scoped.remote.hubBotSettings.ownerSwitchAction({ action: 'request', mode, ...current, summary: version }));
            onClose();
            await onRefresh();
          }
          return h('div', { style: { flexBasis: '100%', minWidth: 0, padding: '8px 0' } },
            h('p', { style: settingsHintStyle }, t('handoffHint')) ,
            h('p', { style: Object.assign({}, settingsHintStyle, { overflowWrap: 'anywhere' }) },
              t('handoffSource') + ' ' + (draft?.sourceSessionId ?? owner.sessionId)
              + (draft ? ' · ' + new Date(draft.sourceReadAt).toLocaleString() : '')
              + (draft?.sourceThroughSeq != null ? ' · ' + t('handoffEvent') + ' ' + draft.sourceThroughSeq : '')
              + (draft ? ' · ' + t('handoffExpires') + ' ' + new Date(draft.expiresAt).toLocaleString() : '')) ,
            draft ? h('textarea', { rows: 7, value: text, disabled: busy, 'aria-label': t('handoffDraft'),
              onChange: event => setText(event.target.value), style: Object.assign({}, settingsInputStyle, { width: '100%', resize: 'vertical' }) }) : null,
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 8px' } },
              button('handoffGenerate', async () => place(await send('generate'))),
              draft && !confirmed ? button('handoffConfirm', confirmDraft) : null,
              confirmed ? button('handoffCarry', () => start('wait')) : null,
              confirmed ? button('handoffCarryStop', () => start('stop')) : null,
              draft ? button('handoffDiscard', async () => { await send('discard', version); onClose(); }) : null,
              h('button', { type: 'button', style: settingsButtonStyle, onClick: onClose }, t('handoffClose'))),
            status ? h('p', { role: 'status' }, status) : null,
            error ? h('p', { role: 'alert', style: { overflowWrap: 'anywhere' } }, error) : null);
        }

        function OwnerSwitchControls({ owner, operation, onRefresh, onOperationSession, showSessions, disabled, historyOnly, t }) {
          var [expanded, setExpanded] = React.useState(false);
          var [busy, setBusy] = React.useState(false);
          var [error, setError] = React.useState(null);
          async function act(request) {
            if (busy || disabled || (request.mode === 'stop' && !window.confirm(t('switchStopConfirm')))) return;
            setBusy(true);
            setError(null);
            try {
              unwrap(await scoped.remote.hubBotSettings.ownerSwitchAction({ ownerId: owner.id, ...request }));
              await onRefresh();
            } catch (error) {
              setError(error?.message ?? String(error));
            } finally { setBusy(false); }
          }
          async function openBinding(binding) {
            setError(null);
            try { await onOperationSession(operation.operationId, binding); }
            catch (failure) { setError(t('openSessionFailed') + ' · ' + (failure?.message ?? String(failure))); }
          }
          var pending = historyOnly || ['waiting', 'preparing', 'committed', 'archive-failed'].includes(operation?.status);
          var newRequest = { action: 'request', expectedSessionId: owner.sessionId };
          var button = (label, request) => h('button', { type: 'button', style: settingsButtonStyle, disabled: busy || disabled, onClick: () => void act(request) }, t(label));
          return h('div', { style: { display: 'flex', gap: '6px 8px', flexWrap: 'wrap', alignItems: 'center' } },
            owner.sessionId && !owner.recycled && !pending ? button('switchWait', { ...newRequest, mode: 'wait' }) : null,
            owner.sessionId && !owner.recycled && !pending ? button('switchStop', { ...newRequest, mode: 'stop' }) : null,
            owner.sessionId && !owner.recycled && !pending && !expanded ? h('button', { type: 'button', style: settingsButtonStyle,
              disabled, onClick: () => setExpanded(true) }, t('handoffSummary')) : null,
            owner.sessionId && !owner.recycled && !pending && expanded ? h(HandoffSummaryEditor, { key: owner.sessionId, owner, t,
              onClose: () => setExpanded(false), onRefresh, disabled }) : null,
            operation ? h('span', { role: 'status', style: settingsHintStyle }, t(ownerSwitchLabels[operation.status] ?? 'switchFailed')) : null,
            operation?.status === 'waiting' ? button('switchCancel', { action: 'cancel', operationId: operation.operationId }) : null,
            operation?.status === 'archive-failed' ? button('switchRetryArchive', { action: 'retry-archive', operationId: operation.operationId }) : null,
            operation?.committedAt && onOperationSession ? h('button', { type: 'button', style: settingsButtonStyle, onClick: () => void openBinding('oldSessionId') }, t('switchOpenPrevious')) : null,
            showSessions && operation?.committedAt && onOperationSession ? h('button', { type: 'button', style: settingsButtonStyle, onClick: () => void openBinding('newSessionId') }, t('switchOpenNew')) : null,
            showSessions && operation ? h('dl', { style: { ...settingsHintStyle, flexBasis: '100%', margin: 0, overflowWrap: 'anywhere' } },
              h('dt', null, t('ownerWorkspacePrevious')), h('dd', { style: { margin: '0 0 4px' } }, operation.oldSessionId),
              h('dt', null, t('ownerWorkspaceReplacement')), h('dd', { style: { margin: 0 } }, operation.newSessionId)) : null,
            error || operation?.reason ? h('p', { role: 'alert', style: { margin: 0, overflowWrap: 'anywhere' } }, error ?? operation.reason) : null);
        }

        function HubBotPanelPage() {
          var t = scoped.locale.bind(NS);
          var boardRef = React.useRef(null);
          var navigationRef = React.useRef(null);
          var [workspaceOwnerId, setWorkspaceOwnerId] = React.useState(linkedWorkspaceOwner);
          var [panelPage, setPanelPage] = React.useState(workspaceOwnerId ? ownerWorkspacePage : boardSections[0][0]);
          var [workspaceTarget, setWorkspaceTarget] = React.useState(null);
          var workspaceHeading = React.useRef(null);
          var workspaceCard = React.useRef(null);
          var workspaceTicketError = React.useRef(null);
          var vs = React.useState(null); var view = vs[0]; var setView = vs[1];
          var viewReadId = React.useRef(0);
          var os = React.useState(null); var owners = os[0]; var setOwners = os[1];
          var cs = React.useState(null); var catalog = cs[0]; var setCatalog = cs[1];
          var [monitor, setMonitor] = React.useState({ overview: null, receivedAt: null, error: null });
          var overview = monitor.overview;
          var [settingsReadError, setSettingsReadError] = React.useState(null);
          var [refreshing, setRefreshing] = React.useState(false);
          var [expiredReading, setExpiredReading] = React.useState(null);
          var loadRequest = React.useRef(null);
          var monitorRequest = React.useRef(null);
          var connectionStateSource = scoped.connection.state;
          var connectionState = React.useSyncExternalStore(connectionStateSource.subscribe, connectionStateSource.getSnapshot);
          var generationSource = scoped.connection.generation;
          var generation = React.useSyncExternalStore(generationSource.subscribe, generationSource.getSnapshot);
          var workspace = useOwnerWorkspace(panelPage === ownerWorkspacePage ? workspaceOwnerId : '', generation?.id);
          var workspaceId = workspace.value?.owner.id;
          React.useLayoutEffect(() => {
            if (workspaceTarget?.ownerId !== workspaceId) return;
            var target = workspaceCard.current || workspaceTicketError.current;
            if (target) focusBoardTarget(target);
          }, [workspaceTarget, workspaceId]);

          var [selfTestResult, setSelfTestResult] = React.useState(null);
          var selfTestBusy = selfTestResult?.stage === 'starting' || selfTestResult?.stage === 'waiting';
          var selfTestRun = React.useRef(null);
          React.useEffect(function () {
            return function () {
              clearTimeout(selfTestRun.current?.timer);
              selfTestRun.current = null;
            };
          }, []);

          var [ticketOperation, setTicketOperation] = React.useState(null);
          var [ticketFeedback, setTicketFeedback] = React.useState(null);
          var [ownerSessionError, setOwnerSessionError] = React.useState(null);
          var linkedOwnerError = React.useSyncExternalStore(listener => {
            ownerLinkListeners.add(listener);
            return () => ownerLinkListeners.delete(listener);
          }, () => ownerLinkError);
          var ticketInFlight = React.useRef(false);
          var fts = React.useState(''); var filterText = fts[0]; var setFilterText = fts[1];
          var fss = React.useState(''); var filterStage = fss[0]; var setFilterStage = fss[1];
          var fos = React.useState(''); var filterOwner = fos[0]; var setFilterOwner = fos[1];
          var [streamTarget, setStreamTarget] = React.useState(null);
          var [openGroups, setOpenGroups] = React.useState({});
          var [openTicketDetails, setOpenTicketDetails] = React.useState({});
          var streamHeading = React.useRef(null);
          var targetCard = React.useRef(null);
          React.useLayoutEffect(function () {
            if (!streamTarget) return;
            var card = targetCard.current;
            var target = card || streamHeading.current;
            if (!target) return;
            var details = card?.querySelector('[data-hb-ticket-details]');
            if (details) details.open = true;
            focusBoardTarget(target);
          }, [streamTarget]);
          var rks = React.useState(''); var recentKind = rks[0]; var setRecentKind = rks[1];
          var cps = React.useState(''); var copiedId = cps[0]; var setCopiedId = cps[1];
          var rds = React.useState(false); var recentDroppedOnly = rds[0]; var setRecentDroppedOnly = rds[1];
          var rus = React.useState(false); var recentUnprocOnly = rus[0]; var setRecentUnprocOnly = rus[1];

          function publishOverview(board, generationId) {
            if (!generationId || generationSource.getSnapshot()?.id !== generationId) return;
            if (!board?.generatedAt) throw new Error(t('loadFailed'));
            var receivedAt = Date.now();
            setMonitor(current => generationSource.getSnapshot()?.id !== generationId
              || (current.generationId === generationId && current.overview?.generatedAt > board.generatedAt)
              ? current : { overview: board, receivedAt, generationId, error: null });
          }
          function refreshMonitoring() {
            var generationId = generationSource.getSnapshot()?.id;
            if (monitorRequest.current && monitorRequest.current.generationId === generationId) return monitorRequest.current.request;
            var pending = { generationId };
            var api = scoped.remote.hubBotSettings;
            pending.request = Promise.allSettled([api.overview().then(unwrap), api.listOwners().then(unwrap)])
              .then(function ([board, rows]) {
                if (monitorRequest.current !== pending || generationSource.getSnapshot()?.id !== generationId) return;
                if (board.status === 'rejected') throw board.reason;
                publishOverview(board.value, generationId);
                if (rows.status === 'rejected') {
                  if (Array.isArray(board.value.owners)) setOwners(board.value.owners);
                  throw rows.reason;
                }
                setOwners(Array.isArray(rows.value) ? rows.value : []);
              }).catch(function (failure) {
                if (monitorRequest.current === pending) setMonitor(current => ({ ...current, error: failure?.message || String(failure) }));
              }).finally(function () {
                if (monitorRequest.current === pending) monitorRequest.current = null;
              });
            monitorRequest.current = pending;
            return pending.request;
          }
          function load() {
            if (loadRequest.current) return loadRequest.current;
            setRefreshing(true);
            var readId = ++viewReadId.current;
            var api = scoped.remote.hubBotSettings;
            var request = Promise.allSettled([api.read().then(unwrap), api.modelCatalog().then(unwrap), refreshMonitoring()])
              .then(function ([settings, models]) {
                if (loadRequest.current !== request) return;
                if (readId === viewReadId.current) {
                  if (settings.status === 'fulfilled') { setView(settings.value); setSettingsReadError(null); }
                  else setSettingsReadError(settings.reason?.message || String(settings.reason));
                }
                if (models.status === 'fulfilled') setCatalog(models.value);
              }).finally(function () {
                if (loadRequest.current !== request) return;
                loadRequest.current = null;
                setRefreshing(false);
              });
            loadRequest.current = request;
            return request;
          }
          React.useEffect(function () {
            load();
            function poll() { if (!document.hidden) refreshMonitoring(); }
            var timer = setInterval(poll, 15000);
            document.addEventListener('visibilitychange', poll);
            return function () {
              loadRequest.current = null;
              monitorRequest.current = null;
              clearInterval(timer);
              document.removeEventListener('visibilitychange', poll);
            };
          }, []);
          React.useEffect(function () {
            if (!generation || document.hidden) return;
            if (view) refreshMonitoring(); else load();
          }, [generation]);
          React.useEffect(function () {
            if (monitor.receivedAt === null) return;
            var timer = setTimeout(() => setExpiredReading(monitor.receivedAt), Math.max(0, monitor.receivedAt + 35000 - Date.now()));
            return function () { clearTimeout(timer); };
          }, [monitor.receivedAt]);

          function finishSelfTest(run, stage, label, detail) {
            if (selfTestRun.current !== run) return;
            clearTimeout(run.timer);
            selfTestRun.current = null;
            setSelfTestResult({ stage: stage, label: label, detail: detail });
          }
          function pollSelfTest(run) {
            if (selfTestRun.current !== run) return;
            if (run.polls-- === 0) {
              finishSelfTest(run, 'error', 'selfTestTimeout');
              return;
            }
            var generationId = generationSource.getSnapshot()?.id;
            scoped.remote.hubBotSettings.overview().then(function (raw) {
              if (selfTestRun.current !== run) return;
              if (generationSource.getSnapshot()?.id !== generationId) {
                run.timer = setTimeout(function () { pollSelfTest(run); }, 2500);
                return;
              }
              var ov = unwrap(raw);
              var result = ov?.selfTests?.find(test => test.id === run.triggerId);
              if (result?.dropped) {
                finishSelfTest(run, 'error', 'selfTestDropped', result.dropped);
              } else if (result?.reply?.state === 'sent') {
                publishOverview(ov, generationId);
                finishSelfTest(run, 'success', 'selfTestPassed');
              } else if (result?.reply?.state === 'failed') {
                publishOverview(ov, generationId);
                finishSelfTest(run, 'error', 'selfTestDeliveryFailed', result.reply.lastError);
              } else {
                run.timer = setTimeout(function () { pollSelfTest(run); }, 2500);
              }
            }).catch(function () {
              if (selfTestRun.current === run) run.timer = setTimeout(function () { pollSelfTest(run); }, 2500);
            });
          }
          function runSelfTest() {
            if (selfTestRun.current || !window.confirm(t('selfTestConfirm'))) return;
            var run = { polls: 24 };
            selfTestRun.current = run;
            setSelfTestResult({ stage: 'starting', label: 'selfTestStarting' });
            scoped.remote.hubBotSettings.selfTest().then(function (raw) {
              if (selfTestRun.current !== run) return;
              if (raw?.ok === false) throw new Error(raw.error?.message || t('selfTestFailed'));
              var result = unwrap(raw);
              if (result?.dropped) {
                finishSelfTest(run, 'error', 'selfTestDropped', result.dropped);
                return;
              }
              if (!result?.triggerId) throw new Error(t('selfTestFailed'));
              run.triggerId = result.triggerId;
              setSelfTestResult({ stage: 'waiting', label: 'selfTestInjected' });
              pollSelfTest(run);
            }).catch(function (error) {
              finishSelfTest(run, 'error', 'selfTestFailed', error?.message);
            });
          }

          var refreshView = function () {
            var readId = ++viewReadId.current;
            scoped.remote.hubBotSettings.read().then(unwrap)
              .then(function (settings) {
                if (readId !== viewReadId.current) return;
                setView(settings);
                if (settings?.feishu?.status) {
                  setMonitor(function (current) {
                    if (!current.overview) return current;
                    return { ...current, overview: { ...current.overview, health: { ...current.overview.health, feishu: settings.feishu.status } } };
                  });
                }
              })
              .catch(function () { /* keep the last successful reading */ });
          };

          function settingsSaved(savedView, patch) {
            // Ignore reads started before this save and merge only the sections the form wrote.
            viewReadId.current++;
            var savedSections = Object.fromEntries(Object.keys(patch).map(section => [section, savedView[section]]));
            setView(current => ({ ...current, ...savedSections }));
            var sources = {};
            for (var channel of ['feishu', 'github']) {
              if (patch[channel] && savedView[channel]?.status) sources[channel] = savedView[channel].status;
            }
            if (Object.keys(sources).length) {
              setMonitor(current => current.overview ? { ...current, overview: { ...current.overview,
                health: { ...current.overview.health, ...sources } } } : current);
              monitorRequest.current = null;
              refreshMonitoring();
            }
          }

          var as2 = React.useState({}); var answers = as2[0]; var setAnswers = as2[1];
          var [selected, setSelected] = React.useState(() => new Map());
          var hvs = React.useState(null); var hoverTicket = hvs[0]; var setHoverTicket = hvs[1];
          var eds = React.useState({}); var expandedDone = eds[0]; var setExpandedDone = eds[1];

          var egs = React.useState({}); var expandedGroups = egs[0]; var setExpandedGroups = egs[1];
          function startTicketOperation(operation) {
            ticketInFlight.current = true;
            setTicketFeedback(null);
            setTicketOperation(operation);
          }

          function decisionId(ticket) {
            return ticket.deferred?.status === 'pending' ? { requestId: ticket.deferred.requestId } : {};
          }

          function answerDraftKey(ticket) {
            return JSON.stringify([ticket.id, ticket.stage, ticket.question?.at ?? null, ticket.deferred?.requestId ?? null, ticket.report?.at ?? null]);
          }

          async function sendTicketResolution(request) {
            var result = unwrap(await scoped.remote.hubBotSettings.resolveTicket(request));
            if (result?.ticketId !== request.ticketId) throw new Error(t('ticketResultMissing'));
            return result;
          }

          async function finishTicketOperation(scope, feedback) {
            try {
              await Promise.all([refreshOverview(), scope === 'owner:' + workspaceId ? workspace.refresh() : null]);
            } catch (error) {
              feedback.refreshError = error?.message || String(error);
            } finally {
              setTicketFeedback({ ...feedback, scope });
              setTicketOperation(null);
              ticketInFlight.current = false;
            }
          }

          async function resolve(tk, resolution, scope) {
            if (ticketInFlight.current || (scope.startsWith('owner:') && (workspace.error || !workspace.isCurrent()))) return;
            var labels = {
              confirm: ['confirmBtn', 'confirmDone'], reject: ['rejectBtn', 'rejectDone'],
              retry: ['retryTicketBtn', 'retryDone'],
              cancel: ['cancelTicketBtn', 'cancelDone'], answer: ['answerBtn', 'answerDone'],
            };
            var [actionLabel, successLabel] = labels[resolution];
            if (resolution === 'answer' && tk.stage === 'person/review') successLabel = 'reworkDone';
            var draftKey = answerDraftKey(tk);
            var message = resolution === 'answer' ? (answers[draftKey] || '').trim() : '';
            if (resolution === 'answer') {
              if (!message) return;
            } else if (!window.confirm(t(actionLabel) + ' · ' + (tk.pendingConfirm?.text || tk.message || tk.id))) return;
            startTicketOperation({ scope });
            var feedback = { ticket: tk.message || tk.id };
            try {
              var result = await sendTicketResolution({ ticketId: tk.id, resolution, ...decisionId(tk), ...(message ? { message } : {}) });
              if (resolution === 'answer') setAnswers(function (current) {
                var next = { ...current };
                delete next[draftKey];
                return next;
              });
              if (selected.has(tk.id)) setSelected(function (current) {
                var next = new Map(current);
                next.delete(tk.id);
                return next;
              });
              feedback.message = t(result.outcome === 'queued' ? 'decisionQueued' : result.stage === 'person/confirm' ? 'ticketActionHeld' : successLabel);
            } catch (error) {
              feedback.message = t('resolveFailed');
              feedback.error = error?.message || String(error);
            }
            await finishTicketOperation(scope, feedback);
          }

          async function batchResolve(resolution) {
            if (ticketInFlight.current || !selectedConfirmations.length) return;
            var total = selectedConfirmations.length;
            var label = resolution === 'confirm' ? 'batchConfirm' : 'batchReject';
            if (!window.confirm(fill(t(label), total))) return;
            var operation = { scope: 'needs', processed: 0, total };
            startTicketOperation(operation);
            var failures = [];
            var queued = 0;
            for (var ticket of selectedConfirmations) {
              try {
                var result = await sendTicketResolution({ ticketId: ticket.id, resolution, ...decisionId(ticket) });
                if (result.outcome === 'queued') queued += 1;
              } catch (error) {
                failures.push({ id: ticket.id, ticket: ticket.message || ticket.id, error: error?.message || String(error) });
              }
              operation = { ...operation, processed: operation.processed + 1 };
              setTicketOperation(operation);
            }
            setSelected(new Map(failures.map(failure => [failure.id, selected.get(failure.id)])));
            var succeeded = total - failures.length - queued;
            var message = failures.length || queued
              ? fill(t('batchOutcome').replace('{failed}', String(failures.length)), succeeded)
              : fill(t(resolution === 'confirm' ? 'batchConfirmed' : 'batchRejected'), total);
            if (queued) message += ' ' + fill(t('batchDecisionQueued'), queued);
            await finishTicketOperation('needs', { message, failures });
          }


          React.useLayoutEffect(function () {
            var board = boardRef.current;
            var navigation = navigationRef.current;
            if (!board || !navigation) return;
            function measureNavigation() {
              board.style.setProperty('--hb-nav-height', navigation.offsetHeight + 'px');
            }
            var resize = new ResizeObserver(measureNavigation);
            resize.observe(navigation);
            measureNavigation();
            return () => resize.disconnect();
          }, [Boolean(view && owners && overview)]);

          React.useLayoutEffect(() => {
            if (panelPage === ownerWorkspacePage && workspaceHeading.current) focusBoardTarget(workspaceHeading.current);
          }, [panelPage, Boolean(view && owners && overview)]);

          function refreshOverview() {
            var generationId = generationSource.getSnapshot()?.id;
            return scoped.remote.hubBotSettings.overview().then(unwrap).then(board => publishOverview(board, generationId));
          }

          async function refreshWorkspace() {
            await Promise.all([workspace.refresh(), refreshOverview()]);
          }

          function selectWorkspace(ownerId) {
            setWorkspaceOwnerId(ownerId);
            setWorkspaceTarget(null);
            switchPage(ownerWorkspacePage);
          }

          function switchPage(page) {
            setPanelPage(page);
            boardRef.current?.scrollTo({ top: 0, behavior: 'instant' });
          }

          if (!view || !owners || !overview) {
            var initialError = settingsReadError || monitor.error;
            return h('div', { style: { padding: '20px 24px' } },
              linkedOwnerError ? h('p', { role: 'alert' }, linkedOwnerError) : null, initialError
              ? h(React.Fragment, null, h('p', { role: 'alert' }, t('loadFailed') + ' · ' + initialError),
                  h('button', { type: 'button', onClick: load, disabled: refreshing, style: settingsButtonStyle }, t('retry')))
              : h('p', { role: 'status' }, t(connectionState === 'connecting' ? 'monitorReconnecting' : 'loading')));
          }
          var monitorStale = monitor.receivedAt === expiredReading || monitor.error || !generation || monitor.generationId !== generation.id;

          var feishu = view.feishu || {};
          var fs = overview.health?.feishu || feishu.status || {};
          var feishuStatus = feishuPresentation(fs.enabled ?? feishu.enabled, fs);
          var feishuOn = feishuStatus.stage === 'done';
          var feishuText = t(feishuStatus.label);
          var github = overview.health?.github || view.github?.status || view.github || {};
          var followed = github.followed || [];
          var githubProblems = github.enabled ? githubProblemCount(github) : 0;
          var githubText = !github.enabled ? t('disabled') : followed.length ? fill(t('watching'), followed.length) : t('githubNoRepos');
          // 副标（turn 109 信息密度）: 飞书卡显示 bot 名；负责人卡显示活跃会话数。
          // 未受理消息可见性（round 26）: 状态卡直接提示最近一条 dropped，省得翻到最近消息区才发现。
          var lastDropped = (overview.recentTriggers || []).find(tr => tr.kind === 'feishu' && tr.dropped);
          var activeSessions = owners.filter(function (o) { return !!o.sessionId; }).length;
          var ownersSub = fill(t('activeSessions'), activeSessions);
          var cardSubStyle = { fontSize: '11px', opacity: 0.6, marginTop: '2px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' };

          var tickets = overview.tickets || [];
          var needs = tickets.filter(ticket => NEEDS_ME.includes(ticket.stage));
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
          function confirmationVersion(ticket) { return ticket.deferred?.requestId ?? ticket.pendingConfirm?.at ?? ticket.updatedAt; }
          function isSelected(ticket) { return selected.has(ticket.id) && selected.get(ticket.id) === confirmationVersion(ticket); }
          var selectedConfirmations = confirmable.filter(isSelected);
          var selectedCount = selectedConfirmations.length;
          var allSelected = confirmable.length > 0 && selectedCount === confirmable.length;
          var showBatchControls = confirmable.length >= 2 || selectedCount > 0;
          var ticketBusy = ticketOperation !== null;
          var focusedTicketId = streamTarget?.ticketId;
          var filterActive = Boolean(focusedTicketId || filterText.trim() || filterStage || filterOwner);
          var ticketById = new Map(tickets.map(ticket => [ticket.id, ticket]));
          var ownerNames = new Map(owners.map(owner => [owner.id, owner.dshWorkspace?.title || owner.workspace || owner.id]));
          tickets.forEach(function (ticket) {
            if (ticket.owner && !ownerNames.has(ticket.owner)) ownerNames.set(ticket.owner, ticket.ownerLabel || ticket.owner);
          });
          if (filterOwner && !ownerNames.has(filterOwner)) ownerNames.set(filterOwner, filterOwner);
          var ownerNameCounts = new Map();
          for (var name of ownerNames.values()) ownerNameCounts.set(name, (ownerNameCounts.get(name) || 0) + 1);
          var canOpenOwnerSession = typeof scoped.get('uiWorkspace')?.openSession === 'function';
          var ownerTickets = new Map();
          for (var ticket of tickets) {
            var byOwner = ownerTickets.get(ticket.owner);
            if (byOwner) byOwner.push(ticket);
            else ownerTickets.set(ticket.owner, [ticket]);
          }
          function ownerFilterLabel(id) {
            var name = ownerNames.get(id) || id;
            return ownerNameCounts.get(name) > 1 ? name + ' · ' + id : name;
          }
          var presentOwners = [...ownerNames.keys()].sort((a, b) => ownerFilterLabel(a).localeCompare(ownerFilterLabel(b)));
          var query = filterText.trim().toLowerCase();
          var filtered = tickets.filter(function (tk) {
            if (focusedTicketId) return tk.id === focusedTicketId;
            if (filterStage && tk.stage !== filterStage) return false;
            if (filterOwner && tk.owner !== filterOwner) return false;
            return !query || [tk.message, tk.ownerLabel, ownerNames.get(tk.owner), tk.owner, tk.id].some(text => text?.toLowerCase().includes(query));
          });
          var presentStages = STAGE_ORDER.filter(st => tickets.some(ticket => ticket.stage === st));
          var visibleStages = presentStages.filter(st => filtered.some(ticket => ticket.stage === st));
          function groupIsOpen(stage) {
            return openGroups[stage] ?? (stage === 'working' || stage === 'queued' || filterActive);
          }
          var allGroupsOpen = visibleStages.length > 0 && visibleStages.every(groupIsOpen);
          function toggleGroups() {
            setOpenGroups(Object.fromEntries(visibleStages.map(stage => [stage, !allGroupsOpen])));
          }
          var healthItems = healthProblems(overview.health || {}, t);

          var recent = overview.recentTriggers || [];
          var nextTimer = (overview.timers || []).filter(timer => timer.status === 'pending' && timer.fireAt)
            .sort((a, b) => a.fireAt.localeCompare(b.fireAt))[0];
          var recentResults = tickets.filter(ticket => ticket.report)
            .sort((a, b) => String(b.report.at ?? b.updatedAt ?? '').localeCompare(String(a.report.at ?? a.updatedAt ?? '')))
            .slice(0, 12);
          // S06 投喂口径（只读）: 只把 overview.intake 里已落库的事实念出来——没有输入框、没有保存按钮，
          // 缺记录就显示 —（不猜、不补、不伪造处置结果）。
          var intakeSources = (overview.intake && overview.intake.sources) || [];
          var cellHeadStyle = { textAlign: 'left', padding: '4px 8px', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(127,127,127,0.2)' };
          var cellStyle = { padding: '4px 8px', verticalAlign: 'top' };
          function intakeDash(value) {
            return value === null || value === undefined || value === '' ? '—' : String(value);
          }

          function renderIntake() {
            // 旧后端没有 intake 投影时整块不出现——不拿「没有数据」冒充「没有记录」。
            if (!overview.intake) return null;
            function queueText(queue) {
              if (!queue || !queue.state) return '—';
              var label = t('queue' + String(queue.state).charAt(0).toUpperCase() + String(queue.state).slice(1)) || queue.state;
              return queue.attempts ? label + ' · ' + fill(t('intakeQueueAttempt'), queue.attempts) : label;
            }
            function disposition(entry) {
              // 处置口径由 src/panel.js 统一判定（disposition），客户端只翻译，不自己再猜一遍。
              if (entry.disposition === 'discarded') return t('intakeDiscarded');
              if (entry.disposition === 'dropped') return t('intakeDropped') + (entry.dropped ? ': ' + String(entry.dropped).slice(0, 24) : '');
              if (entry.disposition === 'injected') return t('intakeInjected');
            if (entry.disposition === 'interrupt') return t('intakeInterrupt');
            if (entry.disposition === 'interrupt-requested') return t('intakeInterruptRequested');
              // pending = 已受理但还没注入时间戳（重启会重放），不是丢失，也不是已注入。
              if (entry.disposition === 'pending') return t('intakePending');
              return '—';
            }
            function policyText(entry) {
              if (!entry.policy) return '—';
              return Object.keys(entry.policy).map(function (key) {
                var value = entry.policy[key];
                return key + '=' + (value && typeof value === 'object' ? JSON.stringify(value) : intakeDash(value));
              }).join(' · ');
            }
            var head = h('tr', null,
              h('th', { style: cellHeadStyle }, t('intakeSource')),
              h('th', { style: cellHeadStyle }, t('intakeLastAt')),
              h('th', { style: cellHeadStyle }, t('intakePolicy')),
              h('th', { style: cellHeadStyle }, t('intakeDisposition')),
              h('th', { style: cellHeadStyle }, t('intakeQueue')),
              h('th', { style: cellHeadStyle }, t('intakeCounts')));
            var rows = intakeSources.map(function (entry) {
              var counts = entry.counts || {};
              return h('tr', { key: entry.source },
                h('td', { style: cellStyle }, (entry.label || entry.source) + ' · ' + intakeDash(entry.source)),
                h('td', { style: Object.assign({}, cellStyle, settingsHintStyle), title: entry.triggerId || '' },
                  entry.at ? hhmm(entry.at) : '—'),
                h('td', { style: Object.assign({}, cellStyle, settingsHintStyle), title: policyText(entry) },
                  intakeDash(entry.addressing), entry.policy ? ' · ' + policyText(entry) : ''),
                h('td', { style: Object.assign({}, cellStyle, settingsHintStyle) }, disposition(entry)),
                h('td', { style: Object.assign({}, cellStyle, settingsHintStyle), title: entry.queue && entry.queue.lastError ? entry.queue.lastError : '' }, queueText(entry.queue)),
                h('td', { style: Object.assign({}, cellStyle, settingsHintStyle) },
                  t('intakeTriggers') + ' ' + intakeDash(counts.triggers) + ' · ' + t('intakeDropped') + ' ' + intakeDash(counts.dropped) + ' · ' + t('intakeInjected') + ' ' + intakeDash(counts.injected)));
            });
            var dedup = intakeSources.filter(function (entry) { return entry.dedupKey; })
              .map(function (entry) { return (entry.label || entry.source) + ' → ' + entry.dedupKey; });
            return h('section', { id: 'hub-bot-intake', style: sectionStyle, 'aria-labelledby': 'hub-bot-intake-title' },
              h('h3', { id: 'hub-bot-intake-title', tabIndex: -1, className: 'hb-scroll-target', style: Object.assign({}, sectionTitleStyle, { marginTop: 0 }) }, t('intakeSection')),
              h('p', { style: Object.assign({}, settingsHintStyle, { margin: '0 0 8px' }) }, t('intakeHint')),
              intakeSources.length === 0
                ? h('p', { style: settingsHintStyle }, t('intakeEmpty'))
                : h('div', { style: { overflowX: 'auto' } },
                    h('table', { className: 'hb-intake-table', style: { borderCollapse: 'collapse', width: '100%', fontSize: '12px' } },
                      h('thead', null, head), h('tbody', null, rows))),
              dedup.length
                ? h('p', { style: Object.assign({}, settingsHintStyle, { margin: '8px 0 0' }) }, t('intakeDedup') + ': ' + dedup.join('；'))
                : null);
          }
          var recentFiltered = recent.filter(function (tr) {
            if (recentKind && tr.kind !== recentKind) return false;
            if (recentDroppedOnly && !tr.dropped) return false;
            if (recentUnprocOnly && !tr.unprocessed) return false;
            return true;
          });
          var recentFilterActive = Boolean(recentKind || recentDroppedOnly || recentUnprocOnly);
          function renderRecentMessages() {
            function filterButton(label, pressed, count, onClick, key) {
              return h('button', { key: key, type: 'button', 'aria-pressed': pressed, onClick,
                style: Object.assign({}, settingsButtonStyle, { fontSize: '11px', padding: '3px 8px',
                  background: pressed ? 'var(--dsw-alias-state-business-tertiary)' : undefined }),
              }, label + ' · ' + count);
            }
            var channelFilters = ['', 'feishu', 'github', 'route'].map(function (kind) {
              var count = kind ? recent.filter(entry => entry.kind === kind).length : recent.length;
              if (kind && count === 0 && kind !== recentKind) return null;
              return filterButton(kind ? kindLabel(kind) : t('filterAllKinds'), kind === recentKind, count, () => setRecentKind(kind), kind || 'all');
            });
            var droppedCount = recent.filter(entry => entry.dropped).length;
            var unprocessedCount = recent.filter(entry => entry.unprocessed).length;
            return h('section', { id: 'hub-bot-recent', style: sectionStyle, 'aria-labelledby': 'hub-bot-recent-title' },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', marginBottom: '8px' } },
                h('h3', { id: 'hub-bot-recent-title', tabIndex: -1, className: 'hb-scroll-target', style: Object.assign({}, sectionTitleStyle, { margin: 0 }) }, t('recentSection'),
                  recentFilterActive ? h('span', { style: settingsHintStyle }, ' · ' + recentFiltered.length + '/' + recent.length) : null),
                recent.length || recentFilterActive ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '5px', marginLeft: 'auto' } },
                  channelFilters,
                  droppedCount || recentDroppedOnly ? filterButton(t('filterDroppedOnly'), recentDroppedOnly, droppedCount, () => { setRecentDroppedOnly(!recentDroppedOnly); setRecentUnprocOnly(false); }) : null,
                  unprocessedCount || recentUnprocOnly ? filterButton(t('filterUnprocessedOnly'), recentUnprocOnly, unprocessedCount, () => { setRecentUnprocOnly(!recentUnprocOnly); setRecentDroppedOnly(false); }) : null,
                  recentFilterActive ? h('button', { type: 'button', style: settingsButtonStyle, onClick: function () { setRecentKind(''); setRecentDroppedOnly(false); setRecentUnprocOnly(false); } }, t('clearFilters')) : null) : null),
              !recentFiltered.length ? h('p', { style: Object.assign({}, settingsHintStyle, { margin: 0 }) }, t(recent.length ? 'messageNoMatch' : 'emptyRecent'))
                : h('ul', { className: 'hb-recent-list', style: { margin: 0, padding: 0, listStyle: 'none' } }, recentFiltered.map(function (entry) {
                  var ownerId = ticketById.get(entry.ticketId)?.owner;
                  return h(RecentMessageRow, { key: entry.id, entry, t, channel: kindLabel(entry.kind), copiedId, onCopy: copyText,
                    ownerButton: ownerFilterButton(ownerId, entry.ownerLabel, { maxWidth: '135px', fontSize: '11px' }),
                    onTicket: ticketId => openStream({ ticketId }),
                    onRetry: () => refreshOverview().catch(() => {}),
                  });
                })));
          }
          var kindLabel = function (k) { return k === 'feishu' ? t('kindFeishu') : k === 'github' ? t('kindGitHub') : t('kindRoute'); };
          function resetStreamTarget() {
            setStreamTarget(null);
            setOpenGroups({});
          }
          function clearStreamFilters() {
            setFilterText('');
            setFilterStage('');
            setFilterOwner('');
            resetStreamTarget();
          }
          function openStream({ ticketId = null, ownerId = '', stage = '' }) {
            setPanelPage(boardSections[0][0]);
            if (ticketId) setOpenTicketDetails(current => ({ ...current, ['stream:' + ticketId]: true }));
            setFilterText('');
            setFilterStage(stage);
            setFilterOwner(ownerId);
            setOpenGroups({});
            setStreamTarget({ ticketId: ticketId });
          }
          function ownerFilterButton(ownerId, displayName, style) {
            if (!ownerId) return null;
            return h('button', {
              type: 'button', className: 'hb-text-action', style: style,
              title: fill(t('openOwnerTasks'), ownerFilterLabel(ownerId)),
              'aria-label': fill(t('openOwnerTasks'), ownerFilterLabel(ownerId)),
              onClick: function (event) { event.stopPropagation(); openStream({ ownerId: ownerId }); },
            }, displayName || ownerNames.get(ownerId) || ownerId);
          }
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

          function focusBoardTarget(target) {
            var board = boardRef.current;
            var navigation = navigationRef.current;
            if (!board?.contains(target) || !navigation) return;
            target.focus({ preventScroll: true });
            var status = target.hasAttribute('data-hb-ticket') ? target.closest('#hub-bot-stream, [data-hb-owner-workspace]')?.querySelector('[data-hb-ticket-status]') : null;
            var top = board.scrollTop + target.getBoundingClientRect().top - board.getBoundingClientRect().top
              - navigation.offsetHeight - boardScrollGap - (status?.offsetHeight ?? 0);
            board.scrollTo({ top, behavior: 'instant' });
          }
          function scrollToSection(id) {
            var target = document.getElementById(id);
            if (target) focusBoardTarget(target);
          }
          function statusCard(id, label, value, color, details) {
            return h('button', { type: 'button', className: 'hb-status-card',
              'aria-controls': id, onClick: () => scrollToSection(id), title: t('cardJumpHint'),
              style: Object.assign({}, cardStyle, { color: 'inherit', textAlign: 'start', cursor: 'pointer' }),
            },
              h('span', { style: Object.assign({ display: 'block' }, cardTitleStyle) }, t(label)),
              h('span', { style: cardValueStyle }, color ? dot(color) : null, value), details);
          }

          async function openSessionById(sessionId) {
            var uiWorkspace = scoped.get('uiWorkspace');
            if (typeof uiWorkspace?.openSession !== 'function') throw new Error(t('ownerSessionUnavailable'));
            await uiWorkspace.openSession(sessionId);
          }

          async function openOwnerSession(owner, inWorkspace = false) {
            setOwnerSessionError(null);
            var generationId = generationSource.getSnapshot()?.id;
            function isCurrent() {
              return generationSource.getSnapshot()?.id === generationId && (!inWorkspace || workspace.isCurrent());
            }
            try {
              var api = scoped.remote.hubBotSettings;
              var current = inWorkspace ? unwrap(await api.ownerWorkspace({ ownerId: owner.id }))?.owner
                : unwrap(await api.listOwners()).find(row => row.id === owner.id);
              if (!isCurrent()) return;
              if (current?.id !== owner.id || current.recycled || !current.sessionId) throw new Error(t('sessionNone'));
              await openSessionById(current.sessionId);
            } catch (error) {
              if (isCurrent()) setOwnerSessionError({ ownerId: owner.id, sessionId: owner.sessionId, message: error?.message || String(error) });
            }
          }

          async function openOperationSession(ownerId, operationId, binding, inWorkspace = false) {
            var generationId = generationSource.getSnapshot()?.id;
            var operation = unwrap(await scoped.remote.hubBotSettings.ownerSwitchAction({ action: 'status', ownerId, operationId }));
            if (generationSource.getSnapshot()?.id !== generationId || (inWorkspace && !workspace.isCurrent())) return;
            if (operation?.ownerId !== ownerId || operation.operationId !== operationId || !operation.committedAt || !operation[binding]) {
              throw new Error(t('ownerSessionUnavailable'));
            }
            await openSessionById(operation[binding]);
          }

          function renderOwnerCard(owner) {
            var label = ownerNames.get(owner.id);
            var accessibleLabel = ownerFilterLabel(owner.id);
            var role = owner.role === 'chief' ? 'roleChief' : owner.kind === 'scratch' ? 'kindTemp' : 'roleOwner';
            var roleColor = role === 'roleChief' ? 'var(--dsw-alias-state-warn-tertiary)'
              : role === 'kindTemp' ? 'var(--dsw-alias-card-tile-fill)' : 'var(--dsw-alias-state-business-tertiary)';
            var dir = owner.cwd || owner.workspace || '';
            var directoryKey = 'cwd:' + owner.id;
            var sessionKey = 'sid:' + owner.id;
            var sessionName = owner.sessionTitle || (owner.sessionId ? String(owner.sessionId).replace(/^session-/, '').slice(0, 8) : t('sessionNone'));
            var sessionError = ownerSessionError?.ownerId === owner.id && ownerSessionError.sessionId === owner.sessionId ? ownerSessionError.message : null;
            var stages = new Map();
            var active = 0;
            var verdict = 0;
            var current = null;
            var lastAt = '';
            for (var ticket of ownerTickets.get(owner.id) || []) {
              var at = ticket.updatedAt || ticket.createdAt || '';
              if (at > lastAt) lastAt = at;
              if (ticket.stage === 'done' || ticket.stage === 'canceled') continue;
              if (ticket.stage === 'working' && (!current || at > (current.updatedAt || current.createdAt || ''))) current = ticket;
              if (NEEDS_ME.includes(ticket.stage)) verdict++;
              var stage = stages.get(ticket.stage);
              if (stage) stage.count++;
              else stages.set(ticket.stage, { text: ticket.stageText || ticket.stage, count: 1 });
              active++;
            }
            var rowStyle = { display: 'flex', alignItems: 'center', gap: '6px 8px', flexWrap: 'wrap', minWidth: 0 };
            return h('article', { key: owner.id, 'data-hb-owner': owner.id,
              style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', minWidth: 0,
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', background: 'var(--dsw-alias-card-fill)' },
            },
              h('div', { style: rowStyle },
                h('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '6px', background: roleColor } }, t(role)),
                h('h4', { style: { flex: '1 1 120px', margin: 0, fontWeight: 600, fontSize: '14px', overflowWrap: 'anywhere' } }, label),
                verdict > 0 ? h('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '6px', background: 'var(--dsw-alias-state-warn-tertiary)' } }, fill(t('verdictCount'), verdict)) : null),
              dir ? h('button', { type: 'button', className: 'hb-text-action', title: dir,
                'aria-label': fill(t('copyOwnerPath'), accessibleLabel), onClick: () => copyText(dir, directoryKey),
                style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', alignSelf: 'start', maxWidth: '100%' },
              }, copiedId === directoryKey ? t('copiedBtn') : shortPath(dir)) : null,
              h('div', { style: Object.assign({}, rowStyle, { padding: '8px 0', borderBlock: '1px solid var(--dsw-alias-border-l2)' }) },
                h('div', { style: { flex: '1 1 110px', minWidth: 0 } },
                  h('div', { style: settingsHintStyle }, t('colSession')),
                  h('div', { title: owner.sessionTitle || owner.sessionId || undefined, style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionName)),
                owner.sessionId ? h('div', { style: rowStyle },
                  canOpenOwnerSession ? h('button', { type: 'button', style: Object.assign({}, settingsButtonStyle, { background: 'var(--dsw-alias-state-business-tertiary)' }),
                    'aria-label': fill(t('openOwnerSession'), accessibleLabel), onClick: () => openOwnerSession(owner),
                  }, t('openSessionButton')) : null,
                  h('button', { type: 'button', style: settingsButtonStyle, 'aria-label': fill(t('copyOwnerSession'), accessibleLabel),
                    onClick: () => copyText(owner.sessionId, sessionKey),
                  }, copiedId === sessionKey ? t('copiedBtn') : t('copySessionButton'))) : null,
                sessionError ? h('div', { role: 'alert', style: { flexBasis: '100%', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', overflowWrap: 'anywhere' } },
                  t('openSessionFailed') + ' · ' + sessionError) : null),
              h(OwnerSwitchControls, { owner, t, operation: (overview.ownerSwitches ?? []).find(row => row.ownerId === owner.id),
                onRefresh: refreshOverview,
                onOperationSession: canOpenOwnerSession ? (id, binding) => openOperationSession(owner.id, id, binding) : null }),
              current ? h('button', { type: 'button', className: 'hb-text-action', onClick: () => openStream({ ticketId: current.id }),
                title: current.message || current.id, 'aria-label': fill(t('openTicketLabel'), current.id) + (current.message ? ' · ' + current.message : ''),
                style: { fontSize: '12px', alignSelf: 'start', maxWidth: '100%' },
              }, current.message || current.id) : null,
              stages.size ? h('div', { style: rowStyle }, Array.from(stages, function ([key, stage]) {
                var tone = TONES[STAGE_TONE[key] || 'gray'];
                return h('button', { key: key, type: 'button', title: t('barFilterHint'),
                  'aria-label': fill(t('openOwnerStage').replace('{stage}', stage.text).replace('{count}', String(stage.count)), accessibleLabel),
                  onClick: () => openStream({ ownerId: owner.id, stage: key }),
                  style: Object.assign({}, settingsButtonStyle, { padding: '3px 7px', fontSize: '11px', background: tone.bg, borderColor: tone.border }),
                }, stage.text + ' · ' + stage.count);
              })) : null,
              h('div', { style: Object.assign({}, rowStyle, { marginTop: 'auto', fontSize: '12px' }) },
                h('button', { type: 'button', style: Object.assign({}, settingsButtonStyle, { background: 'var(--dsw-alias-state-business-tertiary)' }),
                  'aria-label': fill(t('ownerWorkspaceOpenFor'), accessibleLabel), onClick: () => selectWorkspace(owner.id),
                }, t('ownerWorkspaceOpen')),
                h('button', { type: 'button', style: settingsButtonStyle, 'aria-label': fill(t('openOwnerTasks'), accessibleLabel),
                  onClick: () => openStream({ ownerId: owner.id }),
                }, t('ownerTicketsButton')),
                h('span', { style: settingsHintStyle }, fill(t('activeTicketsLabel'), active)),
                lastAt ? h('time', { dateTime: lastAt, style: Object.assign({}, settingsHintStyle, { marginLeft: 'auto' }) }, t('lastActivity') + ' ' + relTime(t, lastAt)) : null));
          }

          function ticketStatus(scope) {
            var progress = ticketOperation?.scope === scope ? ticketOperation : null;
            var feedback = ticketFeedback?.scope === scope ? ticketFeedback : null;
            if (!progress && !feedback) return null;
            var message = progress?.total ? progress.processed + '/' + progress.total + ' · ' + t('batchRunning')
              : progress ? t('ticketRunning') : feedback.message;
            var hasProblem = feedback?.error || feedback?.failures?.length || feedback?.refreshError;
            return h('div', { 'data-hb-ticket-status': scope, style: { position: 'sticky', top: 'var(--hb-nav-height, 48px)', zIndex: 1, marginBottom: '10px', padding: '8px 12px',
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
              background: hasProblem ? 'var(--dsw-alias-state-warn-tertiary)' : 'var(--dsw-alias-card-fill)',
            } },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('div', { role: hasProblem ? 'alert' : 'status', style: { flex: 1, minWidth: 0, fontSize: '12px', overflowWrap: 'anywhere' } },
                  h('strong', null, message), feedback?.ticket ? ' · ' + feedback.ticket : null,
                  feedback?.error ? h('div', null, feedback.error) : null,
                  feedback?.refreshError ? h('div', null, t('ticketRefreshFailed') + ' · ' + feedback.refreshError) : null),
                progress ? null : h('button', { type: 'button', onClick: () => setTicketFeedback(null),
                  style: settingsButtonStyle }, t('dismissTicketFeedback'))),
              progress?.total ? h('progress', { value: progress.processed, max: progress.total, 'aria-label': t('batchRunning'),
                style: { width: '100%', height: '6px', display: 'block', marginTop: '6px', accentColor: 'var(--dsw-alias-state-business-primary)' } }) : null,
              feedback?.failures?.length ? h('ul', { style: { margin: '6px 0 0', paddingInlineStart: '18px',
                maxHeight: '110px', overflowY: 'auto', overflowWrap: 'anywhere', fontSize: '12px', lineHeight: 1.5 },
              }, feedback.failures.map(failure => h('li', { key: failure.id }, h('strong', null, failure.ticket), ' · ' + failure.error))) : null);
          }

          var ticketRowItem = function (tk, scope, isTarget, archiveDetails) {
            var rows = [];
            var inWorkspace = scope.startsWith('owner:');
            var reviewing = tk.stage === 'person/review';
            var disableTicketActions = Boolean(ticketBusy || (inWorkspace && workspace.error));
            var inlineActions = scope === 'needs' || reviewing || tk.stage === 'idle' || tk.stage === 'queued'
              || (inWorkspace && NEEDS_ME.includes(tk.stage));
            var detailKey = scope + ':' + tk.id;
            var detailsOpen = archiveDetails || (openTicketDetails[detailKey] ?? Boolean(isTarget));
            if (!archiveDetails) rows.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '6px 10px', minWidth: 0, flexWrap: inWorkspace ? 'wrap' : undefined } },
              stagePill(tk.stage, tk.stageText || tk.stage),
              tk.trigger && tk.trigger.kind
                ? h('span', { style: { flexShrink: 0, fontSize: '10px', padding: '0 6px', borderRadius: '999px', background: tk.trigger.kind === 'feishu' ? 'rgba(70,150,255,0.14)' : 'rgba(150,150,150,0.14)', color: tk.trigger.kind === 'feishu' ? '#7db8ff' : 'rgba(200,200,200,0.8)', border: '1px solid ' + (tk.trigger.kind === 'feishu' ? 'rgba(70,150,255,0.3)' : 'rgba(150,150,150,0.25)') }, title: t('originHint') }, kindLabel(tk.trigger.kind))
                : null,
              inWorkspace ? null : ownerFilterButton(tk.owner, tk.ownerLabel, { fontWeight: 600, maxWidth: '32%' }),
              h('span', {
                style: { flex: inWorkspace ? '1 1 160px' : 1, minWidth: 0, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: inWorkspace ? 'normal' : 'nowrap', overflowWrap: 'anywhere', cursor: tk.message ? 'pointer' : 'default' },
                title: tk.message ? String(tk.message) + '\n' + t('copyMsgHint') : '',
                onClick: tk.message ? function () { copyText(String(tk.message), 'msg:' + tk.id); } : undefined,
              }, tk.message || tk.id),
              copiedId === 'msg:' + tk.id ? h('span', { style: { flexShrink: 0, fontSize: '11px', color: TONES.green.fg } }, t('copiedBtn')) : null,
              tk.recoveryPending ? h('span', { title: t('recoveringHint') }, stagePill('queued', t('recovering'))) : null,
              (scope === 'needs' || inWorkspace) && NEEDS_ME.includes(tk.stage)
                ? (function () {
                    var waitMs = Date.now() - new Date(tk.updatedAt || tk.createdAt).getTime();
                    if (!(waitMs >= 0)) waitMs = 0;
                    var waitTone = waitMs >= 2 * 3600e3 ? TONES.red : waitMs >= 30 * 60e3 ? TONES.amber : TONES.gray;
                    var dur = durText(waitMs, t);
                    return h('span', { style: { flexShrink: 0, fontSize: '10px', padding: '0 6px', borderRadius: '999px', background: waitTone.bg, color: waitTone.fg, border: '1px solid ' + waitTone.border, whiteSpace: 'nowrap' }, title: t('waitingHint') }, t('waitingLabel') + ' ' + dur);
                  })()
                : null,
              tk.stage === 'working'
                ? (function () {
                    var runMs = Date.now() - new Date(tk.updatedAt || tk.createdAt).getTime();
                    if (!(runMs >= 0)) runMs = 0;
                    return h('span', { style: { flexShrink: 0, fontSize: '10px', padding: '0 6px', borderRadius: '999px', background: TONES.blue.bg, color: TONES.blue.fg, border: '1px solid ' + TONES.blue.border, whiteSpace: 'nowrap' }, title: t('runningHint') }, t('runningLabel') + ' ' + durText(runMs, t));
                  })()
                : null,
              h('span', { style: { fontSize: '12px', opacity: 0.55, whiteSpace: 'nowrap' } }, relTime(t, tk.updatedAt))));
            if (tk.pendingConfirm && tk.stage === 'person/confirm') rows.push(h('div', { key: 'pc', style: { marginTop: '6px', fontSize: '13px', color: TONES.amber.fg } }, t('pendingConfirmLabel') + tk.pendingConfirm.text));
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
            if (tk.deferred?.status === 'pending') {
              var deadline = new Date(tk.deferred.expiresAt).toLocaleString();
              var targetId = tk.deferred.target?.sessionId;
              rows.push(h('p', { key: 'deferred-deadline', style: settingsHintStyle }, t('deferredExpires') + ' · ' + deadline,
                targetId ? ' · ' + t('deferredTarget') + ' ' + targetId : null));
            }
            var answerDelivery = tk.deferred?.delivery;
            var answerStatusKey = ({ queued: 'answerQueued', sent: 'answerSent', failed: 'answerFailed', discarded: 'answerDiscarded' })[answerDelivery?.state];
            var decisionNote = answerDelivery?.reason || tk.deferred?.reason;
            if (answerStatusKey || decisionNote) {
              rows.push(h('p', { key: 'deferred-result', style: settingsHintStyle },
                [answerStatusKey && t(answerStatusKey), decisionNote].filter(Boolean).join(' · ')));
            }
            if (tk.attentionReason) rows.push(h('p', { key: 'attention', style: settingsHintStyle }, tk.attentionReason));
            if (reviewing && tk.report?.summary) rows.push(h('p', { key: 'report-preview',
              style: { margin: '6px 0', fontSize: '13px', overflowWrap: 'anywhere' } }, tk.report.summary));
            var actions = [];
            if (reviewing && tk.ownerSessionId && canOpenOwnerSession) {
              actions.push(h('button', { key: 'owner-session', type: 'button', style: settingsButtonStyle,
                onClick: () => openOwnerSession({ id: tk.owner, sessionId: tk.ownerSessionId }, inWorkspace),
                'aria-label': fill(t('openOwnerSession'), ownerFilterLabel(tk.owner)),
              }, t('openSessionButton')));
            }
            function actionButton(resolution, label, tone, disabled) {
              return h('button', { key: resolution, type: 'button', disabled: disableTicketActions || disabled,
                onClick: () => resolve(tk, resolution, scope),
                style: Object.assign({}, settingsButtonStyle, { cursor: disableTicketActions || disabled ? undefined : 'pointer',
                  background: tone.bg, borderColor: tone.border, color: 'inherit' }),
              }, t(label));
            }
            if (tk.stage === 'person/confirm') {
              actions.push(actionButton('confirm', 'confirmBtn', TONES.green), actionButton('reject', 'rejectBtn', TONES.red));
            }
            if (tk.stage === 'idle' || tk.stage === 'queued') {
              actions.push(actionButton('cancel', 'cancelTicketBtn', TONES.red));
            }
            if (tk.stage === 'blocked' || tk.stage === 'failed') {
              actions.push(actionButton('retry', 'retryTicketBtn', TONES.blue));
            }
            if (tk.stage === 'person/answer' || tk.stage === 'person/review') {
              var inputLabel = t(reviewing ? 'reworkPlaceholder' : 'answerPlaceholder');
              var draftKey = answerDraftKey(tk);
              var draft = answers[draftKey] || '';
              actions.push(h('textarea', { key: draftKey, rows: 2,
                style: Object.assign({}, settingsInputStyle, { flex: '1 1 180px', minWidth: 0, padding: '5px 10px', fontSize: '13px', resize: 'vertical' }),
                value: draft, disabled: disableTicketActions, placeholder: inputLabel, 'aria-label': inputLabel,
                'aria-description': t('replyShortcut'), title: t('replyShortcut'),
                onChange: function (ev) {
                  var value = ev.target.value;
                  setAnswers(current => ({ ...current, [draftKey]: value }));
                },
                onKeyDown: function (ev) {
                  if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
                    ev.preventDefault();
                    resolve(tk, 'answer', scope);
                  }
                },
              }), actionButton('answer', reviewing ? 'reworkBtn' : 'answerBtn', reviewing ? TONES.amber : TONES.blue, !draft.trim()));
            }
            var actionBar = actions.length ? h('div', { key: 'actions', 'data-hb-ticket-actions': '',
              style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
            }, actions) : null;
            if (inlineActions && actionBar) rows.push(actionBar);
            if (reviewing && ownerSessionError?.ownerId === tk.owner && ownerSessionError.sessionId === tk.ownerSessionId) {
              rows.push(h('p', { key: 'session-error', role: 'alert', style: settingsHintStyle },
                t('openSessionFailed') + ' · ' + ownerSessionError.message));
            }
            function renderFacts(detail) {
              var evs = [];
              if (detail.createdAt) evs.push({ at: detail.createdAt, tone: 'muted', label: t('tlCreated'), detail: detail.authorization ? detail.authorization.actor + ' · ' + detail.authorization.source : null });
              (detail.assignments || []).forEach(function (a) {
                if (a.startedAt || a.at) evs.push({ at: a.startedAt ?? a.at, tone: 'blue', label: t('tlAssign'), detail: a.sessionId ? String(a.sessionId).replace(/^session-/, '').slice(0, 8) : null, copy: a.sessionId || null });
                if (a.endedAt) evs.push({ at: a.endedAt, tone: 'muted', label: t('tlAssignEnd'), detail: a.endedReason ?? a.endReason ?? null });
              });
              if (detail.question && detail.question.at) evs.push({ at: detail.question.at, tone: 'amber', label: t('tlQuestion'), detail: detail.question.text });
              if (detail.pendingConfirm && detail.pendingConfirm.at) evs.push({ at: detail.pendingConfirm.at, tone: 'amber', label: t('tlConfirm'), detail: detail.pendingConfirm.text });
              if (detail.report && detail.report.at) evs.push({ at: detail.report.at, tone: 'blue', label: t('tlReport'), detail: detail.report.summary || '' });
              evs.push({ at: detail.updatedAt || detail.createdAt, tone: STAGE_TONE[detail.stage] || 'gray', label: detail.stageText || detail.stage, detail: null, current: true });
              evs.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
              return h(React.Fragment, null,
                detail.message ? h('div', { style: { marginTop: '6px', overflowWrap: 'anywhere' } },
                  h('strong', null, t('messageOriginal')), h('p', { style: { margin: '3px 0', whiteSpace: 'pre-wrap' } }, detail.message)) : null,
                detail.deferred?.answer ? h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                  h('strong', null, t('deferredAnswer')), ' · ', detail.deferred.answer) : null,
              h('div', { style: { marginTop: '6px', paddingLeft: '4px', display: 'flex', flexDirection: 'column' } },
                evs.map(function (ev, i) {
                  var tone = TONES[ev.tone] || TONES.gray;
                  var gapRow = null;
                  if (i > 0) {
                    var prevAt = new Date(evs[i - 1].at || '').getTime();
                    var curAt = new Date(ev.at || '').getTime();
                    var gapMs = (isFinite(prevAt) && isFinite(curAt)) ? curAt - prevAt : 0;
                    if (gapMs >= 60e3) {
                      gapRow = h('div', { key: 'g' + i, style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '0 0 0 4px' } },
                        h('span', { style: { flexShrink: 0, width: '8px', borderLeft: '1px dashed rgba(127,127,127,0.35)', alignSelf: 'stretch', marginLeft: '3px' } }),
                        h('span', { style: { opacity: 0.4, fontFamily: 'monospace', fontSize: '10px' } }, '+' + durText(gapMs, t)));
                    }
                  }
                  var evRow = h('div', { key: i, style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '2px 0' } },
                    h('span', { style: { flexShrink: 0, width: '8px', height: '8px', borderRadius: '999px', background: ev.current ? tone.border : 'transparent', border: '2px solid ' + tone.border, alignSelf: 'center' } }),
                    h('span', { style: { flexShrink: 0, opacity: 0.5, fontFamily: 'monospace', fontSize: '11px', minWidth: '42px' }, title: ev.at || '' }, ev.at ? hhmm(ev.at) : '—'),
                    h('span', { style: { flexShrink: 0, color: tone.fg, fontWeight: ev.current ? 600 : 400 } }, ev.label),
                    ev.detail ? h('span', {
                      style: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: ev.copy ? 'pointer' : 'default', color: ev.copy && copiedId === 'tl:' + ev.copy ? TONES.green.fg : undefined },
                      title: ev.copy ? ev.copy + String.fromCharCode(10) + t('copySessionHint') : undefined,
                      onClick: ev.copy ? function (e2) { e2.preventDefault(); copyText(ev.copy, 'tl:' + ev.copy); } : undefined,
                    }, ev.detail) : null);
                  return gapRow ? [gapRow, evRow] : evRow;
                })),
                detail.report ? h(TicketReport, { report: detail.report,
                  copied: copiedId === 'rp:' + detail.id, copy: text => copyText(text, 'rp:' + detail.id),
                }) : null,
               Array.isArray(detail.dirListing) && detail.dirListing.length > 0
                 ? h('div', { style: { marginTop: '8px' } },
                     h('div', { style: { fontSize: '11px', opacity: 0.55, marginBottom: '4px' } }, t(detail.stage === 'person/review' ? 'artifactsLabel' : 'artifactsWorkingLabel')),
                     h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: '88px', overflowY: 'auto' } },
                       detail.dirListing.map(function (name, i) {
                         var isDir = name.endsWith('/');
                         return h('span', { key: i, style: {
                           fontFamily: 'monospace', fontSize: '11px', padding: '1px 7px', borderRadius: '5px',
                           background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.16)',
                           color: isDir ? TONES.blue.fg : 'inherit', opacity: isDir ? 1 : 0.8,
                         } }, name);
                       })))
                 : null,
               h('div', { style: { marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px' } },
                 h('span', { style: { opacity: 0.5, fontFamily: 'monospace', fontSize: '11px' } }, detail.id),
                  archiveDetails ? ownerFilterButton(detail.owner, t('ownerTicketsButton'), { fontSize: '11px' }) : null,
                 h('button', {
                   onClick: function (ev) { ev.preventDefault(); copyTicketId(detail.id); },
                   title: t('copyIdHint'),
                   style: { fontSize: '10px', padding: '0 7px', borderRadius: '5px', cursor: 'pointer',
                     background: copiedId === detail.id ? 'rgba(70,180,100,0.14)' : 'rgba(127,127,127,0.1)',
                     color: copiedId === detail.id ? TONES.green.fg : 'inherit',
                     border: '1px solid ' + (copiedId === detail.id ? TONES.green.border : 'rgba(127,127,127,0.25)'),
                     opacity: copiedId === detail.id ? 1 : 0.6 },
                 }, copiedId === detail.id ? t('copiedBtn') : t('copyIdBtn'))));
            }
            rows.push(h(archiveDetails ? 'div' : 'details', { key: 'd', 'data-hb-ticket-details': '',
              open: detailsOpen || undefined, style: { marginTop: '6px', fontSize: '12px' },
              onToggle: archiveDetails ? undefined : event => {
                if (event.target !== event.currentTarget) return;
                var open = event.currentTarget.open;
                if (open !== detailsOpen) setOpenTicketDetails(current => ({ ...current, [detailKey]: open }));
              },
            },
              archiveDetails ? null : h('summary', { style: { cursor: 'pointer' } },
                t(tk.report ? 'openReport' : !inlineActions && actionBar ? 'detailActionsToggle' : 'detailToggle')),
              detailsOpen && !inlineActions ? actionBar : null,
              detailsOpen ? h(TicketFacts, { ticket: tk, generationId: generation?.id, ownerId: inWorkspace ? tk.owner : undefined, render: renderFacts }) : null));
            var stageTone = TONES[STAGE_TONE[tk.stage] || 'gray'];
            var isHover = hoverTicket === tk.id;
            return h('div', {
              key: tk.id,
              ref: isTarget ? (inWorkspace ? workspaceCard : targetCard) : undefined,
              tabIndex: isTarget ? -1 : undefined,
              className: isTarget ? 'hb-scroll-target' : undefined,
              'data-hb-ticket': tk.id,
              'aria-label': isTarget ? (tk.message || tk.id) : undefined,
              onMouseEnter: function () { setHoverTicket(tk.id); },
              onMouseLeave: function () { setHoverTicket(null); },
              style: {
              padding: '10px 12px', borderRadius: '8px', marginBottom: '8px', overflowWrap: inWorkspace ? 'anywhere' : undefined,
              border: '1px solid var(--dsh-border, rgba(127,127,127,0.2))',
              borderLeft: '3px solid ' + stageTone.border,
              background: 'var(--dsh-surface-raised, rgba(127,127,127,0.04))',
              boxShadow: isHover ? '0 0 0 1.5px rgba(120,170,255,0.55)' : 'none',
              transition: 'box-shadow 120ms ease',
            } }, rows);
          };

          function renderOwnerWorkspace() {
            var value = workspace.value;
            var sortedOwners = [...owners].sort((a, b) => ownerFilterLabel(a.id).localeCompare(ownerFilterLabel(b.id)));
            var header = h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px', marginBottom: '12px' } },
              h('h2', { id: ownerWorkspacePage, tabIndex: -1, className: 'hb-scroll-target', ref: workspaceHeading,
                style: { flex: '1 1 160px', fontSize: '17px', fontWeight: 600, margin: 0 } }, t('ownerWorkspace')),
              h('select', { value: workspaceOwnerId, 'aria-label': t('ownerWorkspaceChoose'),
                style: { ...settingsButtonStyle, minWidth: 0, maxWidth: '100%' }, onChange: event => selectWorkspace(event.target.value) },
                h('option', { value: '' }, t('ownerWorkspaceChoose')),
                workspaceOwnerId && !sortedOwners.some(owner => owner.id === workspaceOwnerId)
                  ? h('option', { value: workspaceOwnerId }, workspaceOwnerId) : null,
                sortedOwners.map(owner => h('option', { key: owner.id, value: owner.id }, ownerFilterLabel(owner.id)))),
              workspaceOwnerId && generation ? h('button', { type: 'button', style: settingsButtonStyle, disabled: workspace.loading,
                onClick: () => void workspace.refresh() }, t('refreshBtn')) : null);
            if (!workspaceOwnerId) return h('div', null, header, h('p', { style: settingsHintStyle }, t(owners.length ? 'ownerWorkspaceChoose' : 'emptyOwners')));
            if (!generation) return h('div', null, header, h('p', { role: 'status' }, t('monitorDisconnected')));
            var readError = workspace.error ? h('div', null,
              h('p', { role: 'alert', style: { overflowWrap: 'anywhere' } },
                t(value ? 'monitorReadFailed' : 'ownerWorkspaceUnavailable') + ' · ' + workspace.error),
              h('button', { type: 'button', style: settingsButtonStyle, disabled: workspace.loading, onClick: () => void workspace.refresh() }, t('retry'))) : null;
            if (!value && readError) return h('div', null, header, readError);
            if (!value) return h('div', null, header, h('p', { role: 'status', style: settingsHintStyle }, t('ownerWorkspaceLoading')));

            var owner = value.owner;
            var scope = 'owner:' + owner.id;
            var targetId = workspaceTarget?.ownerId === owner.id ? workspaceTarget.ticketId : null;
            var priorArchives = (value.archiveFailures ?? []).filter(operation => operation.ownerId === owner.id
              && operation.status === 'archive-failed' && operation.operationId !== value.switchOperation?.operationId);
            var currentSession = owner.recycled ? null : owner.sessionId;
            var sessionError = ownerSessionError?.ownerId === owner.id && ownerSessionError.sessionId === owner.sessionId ? ownerSessionError.message : null;
            var role = owner.role === 'chief' ? 'roleChief' : owner.kind === 'scratch' ? 'kindTemp' : 'roleOwner';
            var sessionKey = 'sid:' + owner.id;
            var directory = owner.cwd && owner.cwd !== owner.workspace ? owner.cwd : null;
            var actions = { display: 'flex', gap: '6px 8px', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 };
            var needs = value.tickets.filter(ticket => NEEDS_ME.includes(ticket.stage));
            var isTerminal = ticket => ['done', 'canceled'].includes(ticket.stage);
            var progress = value.tickets.filter(ticket => !NEEDS_ME.includes(ticket.stage) && !isTerminal(ticket));
            var outcomes = value.tickets.filter(ticket => ticket.report || isTerminal(ticket))
              .sort((a, b) => String(b.report?.at ?? b.updatedAt ?? '').localeCompare(String(a.report?.at ?? a.updatedAt ?? '')));
            function openTask(ticketId) {
              if (!workspace.isCurrent()) return;
              setOpenTicketDetails(current => ({ ...current, [scope + ':' + ticketId]: true }));
              setWorkspaceTarget({ ownerId: owner.id, ticketId });
            }
            var openWorker = canOpenOwnerSession ? async sessionId => {
              if (workspace.isCurrent()) await openSessionById(sessionId);
            } : undefined;
            function renderTicket(ticket) { return ticketRowItem(ticket, scope, ticket.id === targetId); }
            function renderOutcome(ticket) {
              if (isTerminal(ticket)) return renderTicket(ticket);
              return h('div', { key: ticket.id, style: { paddingBlock: '6px' } },
                h('button', { type: 'button', className: 'hb-text-action', style: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
                  onClick: () => openTask(ticket.id) }, ticket.report?.summary || ticket.message || ticket.id));
            }
            function ticketSection(id, label, rows, empty, render = renderTicket) {
              return h('section', { 'aria-labelledby': id, style: sectionStyle },
                h('h3', { id, style: sectionTitleStyle }, t(label)),
                rows.length ? rows.map(render) : h('p', { style: settingsHintStyle }, t(empty)));
            }
            return h('div', { 'data-hb-owner-workspace': owner.id }, header, readError,
              h(React.Fragment, { key: owner.id },
                h('section', { 'aria-labelledby': 'hub-bot-workspace-owner', style: { ...sectionStyle, padding: '12px 14px', minWidth: 0,
                  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', overflowWrap: 'anywhere' } },
                  h('div', { style: actions },
                    h('h3', { id: 'hub-bot-workspace-owner', style: { margin: 0, fontSize: '15px', fontWeight: 600 } }, owner.workspace || owner.id),
                    h('span', { style: settingsHintStyle }, t(role))),
                  directory ? h('p', { style: { ...settingsHintStyle, margin: '4px 0' } }, directory) : null,
                  h('div', { style: { ...actions, margin: '8px 0', paddingBlock: '8px', borderBlock: '1px solid var(--dsw-alias-border-l2)' } },
                    h('div', { style: { flex: '1 1 160px', minWidth: 0 } },
                      h('div', { style: settingsHintStyle }, t('ownerWorkspaceCurrent')),
                      h('div', { style: { fontSize: '12px' } }, currentSession || t(owner.recycled ? 'ownerRecycled' : 'sessionNone'))),
                    currentSession && canOpenOwnerSession ? h('button', { type: 'button', style: settingsButtonStyle,
                      onClick: () => void openOwnerSession(owner, true) }, t('openSessionButton')) : null,
                    currentSession ? h('button', { type: 'button', style: settingsButtonStyle,
                      onClick: () => copyText(currentSession, sessionKey) }, t(copiedId === sessionKey ? 'copiedBtn' : 'copySessionButton')) : null),
                  sessionError ? h('p', { role: 'alert', style: settingsHintStyle }, t('openSessionFailed') + ' · ' + sessionError) : null,
                  h(OwnerSwitchControls, { key: owner.sessionId, owner, t, operation: value.switchOperation, showSessions: true, disabled: Boolean(workspace.error), onRefresh: refreshWorkspace,
                    onOperationSession: canOpenOwnerSession ? (id, binding) => openOperationSession(owner.id, id, binding, true) : null })),
                priorArchives.length ? h('section', { 'aria-labelledby': 'hub-bot-workspace-archive-failures', style: sectionStyle },
                  h('h3', { id: 'hub-bot-workspace-archive-failures', style: sectionTitleStyle }, t('switchEarlierArchives')),
                  ...priorArchives.map(operation => h(OwnerSwitchControls, { key: operation.operationId, owner, t, operation,
                    historyOnly: true, showSessions: true, disabled: Boolean(workspace.error), onRefresh: refreshWorkspace,
                    onOperationSession: canOpenOwnerSession ? (id, binding) => openOperationSession(owner.id, id, binding, true) : null }))) : null,
                ticketStatus(scope),
                targetId && !value.tickets.some(ticket => ticket.id === targetId) ? h('p', { ref: workspaceTicketError, tabIndex: -1, role: 'alert' }, t('ownerWorkspaceNoTicket')) : null,
                ticketSection('hub-bot-owner-needs-title', 'needsMe', needs, 'quiet'),
                ticketSection('hub-bot-owner-progress-title', 'ownerWorkspaceProgress', progress, 'ownerWorkspaceNoProgress'),
                ticketSection('hub-bot-owner-results-title', 'outcomesSection', outcomes, 'noResults', renderOutcome),
                h(TimerSection, { headingId: 'hub-bot-owner-timers-title', timers: value.timers, onTask: openTask, onWorker: openWorker, onRefresh: refreshWorkspace, disabled: Boolean(workspace.error) }),
                h(RunHistory, { active: true, workspace: value, refreshWorkspace: workspace.refresh, onTask: openTask, onWorker: openWorker })));
          }
          return h('div', { ref: boardRef, style: { padding: '0 24px 20px', overflowY: 'auto', height: '100%', boxSizing: 'border-box',
            scrollPaddingBlockStart: 'calc(var(--hb-nav-height, 48px) + ' + boardScrollGap + 'px)' },
          },

            h('style', null, [
              '.hb-recent-list{border:1px solid var(--dsw-alias-border-l2);border-radius:10px}',
              '.hb-message-row+.hb-message-row{border-top:1px solid var(--dsw-alias-border-l2)}',
              '.hb-message-preview:hover{text-decoration:underline}',
              '.hb-message-preview:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:5px}',
              '.hb-recent-row{transition:background 120ms ease}',
              '.hb-recent-row+.hb-recent-row{border-top:1px solid var(--dsh-border,rgba(127,127,127,.15))}',
              '.hb-recent-row:hover{background:rgba(127,127,127,.06)}',
              '.hb-text-action{background:none;border:0;color:inherit;font:inherit;padding:0;min-width:0;cursor:pointer;text-align:start;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
              '.hb-text-action:hover{text-decoration:underline}',
              '.hb-text-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}',
              '.hb-nav-button:hover,.hb-status-card:hover{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l4)}',
              '.hb-nav-button:focus-visible,.hb-status-card:focus-visible,.hb-archive-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
              '.hb-scroll-target:focus{outline:2px solid var(--dsh-accent,currentColor);outline-offset:2px}',
            ].join('')),
            h('nav', { ref: navigationRef, id: 'hub-bot-navigation', 'aria-label': t('boardNavigation'),
              style: { position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', flexWrap: 'wrap',
                gap: '4px', padding: '8px 0', marginBottom: '12px', borderBottom: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-card-fill)' },
            }, boardSections.map(function ([id, label]) {
              var active = panelPage === id;
              return h('button', { key: id, type: 'button', className: 'hb-nav-button', 'data-hb-section': id,
                'aria-controls': id, 'aria-current': active ? 'page' : undefined, onClick: () => switchPage(id),
                style: { fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap', padding: '5px 9px', border: 0, borderRadius: '6px',
                  cursor: 'pointer', background: active ? 'var(--dsw-alias-state-business-tertiary)' : 'transparent', color: 'inherit' },
              }, t(label));
             }), h('button', { type: 'button', className: 'hb-text-action',
               onClick: () => switchPage('hub-bot-connections'),
               style: { marginInlineStart: 'auto', fontSize: '11px', whiteSpace: 'normal', color: 'var(--dsw-alias-label-secondary)' },
             }, t('feishuCard') + ' ' + feishuText + ' · ' + t('githubCard') + ' ' + githubText
               + (githubProblems ? ' · ' + t('githubWatchProblems').replace('{count}', String(githubProblems)) : ''))),
             linkedOwnerError ? h('p', { role: 'alert' }, linkedOwnerError) : null,
             panelPage !== 'hub-bot-overview-title' && (monitorStale || settingsReadError)
               ? h('p', { role: 'status', style: settingsHintStyle },
                   !generation ? t('monitorDisconnected') : (monitor.error || settingsReadError || t('monitorWaiting'))) : null,
             h('div', { hidden: panelPage !== 'hub-bot-overview-title' },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px 16px', flexWrap: 'wrap', marginBottom: '8px' } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
                h('h2', { id: 'hub-bot-overview-title', tabIndex: -1, className: 'hb-scroll-target', style: { fontSize: '17px', fontWeight: 600, margin: 0 } }, t('title')),
                view.version ? h('span', { style: { fontSize: '11px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary)' } }, 'v' + view.version) : null),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                h('button', { type: 'button', onClick: runSelfTest, disabled: selfTestBusy || !feishuOn,
                  'aria-describedby': 'hub-bot-self-test-status', style: settingsButtonStyle }, t('selfTestBtn')),
                h('button', { type: 'button', onClick: load, disabled: refreshing, title: t('refreshHint'), style: settingsButtonStyle }, t(refreshing ? 'monitorRefreshing' : 'refreshBtn')))),
            h('div', { id: 'hub-bot-freshness', role: 'status', 'data-stale': Boolean(monitorStale),
              style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', margin: '0 0 8px',
                padding: '6px 10px', borderRadius: '6px', fontSize: '12px',
                background: monitorStale || settingsReadError ? 'var(--dsw-alias-state-warn-tertiary)' : 'var(--dsw-alias-card-fill)' },
            },
              h('strong', null, t(monitorStale ? 'monitorCached' : 'monitorCurrent')),
              h('time', { dateTime: overview.generatedAt, title: overview.generatedAt, style: settingsHintStyle },
                t('updatedAt') + ' ' + new Date(overview.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
              monitorStale ? h('span', { style: Object.assign({}, settingsHintStyle, { overflowWrap: 'anywhere' }) },
                connectionState === 'connecting' ? t('monitorReconnecting') : !generation ? t('monitorDisconnected')
                  : monitor.error ? t('monitorReadFailed') + ' · ' + monitor.error : t('monitorWaiting')) : null,
              settingsReadError ? h('span', { style: settingsHintStyle }, t('monitorSettingsFailed') + ' · ' + settingsReadError) : null),
            h('div', { id: 'hub-bot-self-test-status', role: 'status', style: { margin: '0 0 14px', fontSize: '12px',
              color: selfTestResult?.stage === 'error' ? TONES.red.fg : selfTestResult?.stage === 'success' ? TONES.green.fg : 'inherit',
            } }, selfTestResult ? t(selfTestResult.label) + (selfTestResult.detail ? ' · ' + selfTestResult.detail : '') : t(feishuOn ? 'selfTestHint' : 'selfTestNeedsConnection')),
             h('div', { style: cardRowStyle },
               statusCard('hub-bot-needs-title', 'needsCard', String(needs.length), needs.length > 0 ? TONES.amber.fg : TONES.green.fg,
                 h('span', { style: cardSubStyle }, needsCardSub)),
               statusCard('hub-bot-owners-title', 'ownersCard', String(owners.length), null, h('span', { style: cardSubStyle }, ownersSub)),
               statusCard('hub-bot-recent-title', 'recentSection', String(recent.length), null, lastDropped
                 ? h('span', { style: Object.assign({}, cardSubStyle, { color: TONES.amber.fg }), title: lastDropped.message || '' },
                   t('droppedCardHint') + ' ' + relTime(t, lastDropped.at) + ' · ' + String(lastDropped.dropped).slice(0, 24)) : null)),
            h(DeliveryHealth, { health: overview.health || {}, alerts: healthItems, stale: monitorStale,
              tickets: ticketById, unprocessed: overview.unprocessedTriggers || 0, onTicket: ticketId => openStream({ ticketId }),
              onMessages: recent.some(row => row.unprocessed) ? () => {
                setRecentKind(''); setRecentDroppedOnly(false); setRecentUnprocOnly(true); scrollToSection('hub-bot-recent-title');
              } : null,
              refresh: refreshOverview,
            }),
             h('section', { id: 'hub-bot-needs', 'aria-labelledby': 'hub-bot-needs-title', style: Object.assign({}, sectionStyle, needs.length > 0 ? { borderLeft: '3px solid ' + TONES.amber.border, paddingLeft: '14px' } : {}) },
               h('div', { style: Object.assign({}, sectionTitleStyle, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }) },
                 h('h3', { id: 'hub-bot-needs-title', tabIndex: -1, className: 'hb-scroll-target', style: { font: 'inherit', margin: 0 } }, t('needsMe'),
                   needs.length > 0 ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, color: TONES.amber.fg } }, '· ' + needs.length) : null),
                needs.length > 0
                  ? h('button', {
                      onClick: function () {
                        var lines = [t('needsMe') + ' · ' + needs.length];
                        needs.forEach(function (tk) {
                          lines.push('[' + (tk.stageText || tk.stage) + '] ' + (tk.ownerLabel || tk.owner) + ' · ' + (tk.message || '') + ' · ' + relTime(t, tk.updatedAt || tk.createdAt));
                        });
                        copyText(lines.join(String.fromCharCode(10)), 'needs-digest');
                      },
                      title: t('copyDigestHint'),
                      style: { fontSize: '11px', fontWeight: 400, padding: '2px 10px', borderRadius: '6px', cursor: 'pointer', background: 'rgba(127,127,127,0.1)', border: '1px solid rgba(127,127,127,0.2)', opacity: 0.8 },
                    }, copiedId === 'needs-digest' ? t('copiedBtn') : t('copyDigestBtn'))
                  : null,
                 showBatchControls ? h('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', fontWeight: 400 } },
                   h('button', { type: 'button', style: settingsButtonStyle, disabled: ticketBusy, onClick: function () {
                     setSelected(allSelected ? new Map() : new Map(confirmable.map(ticket => [ticket.id, confirmationVersion(ticket)])));
                   } }, t(allSelected ? 'selectNone' : 'selectAll')),
                   selectedCount ? h('button', { type: 'button', disabled: ticketBusy, onClick: () => batchResolve('confirm'),
                     style: Object.assign({}, settingsButtonStyle, { background: TONES.green.bg, borderColor: TONES.green.border }),
                   }, fill(t('batchConfirm'), selectedCount)) : null,
                   selectedCount ? h('button', { type: 'button', disabled: ticketBusy, onClick: () => batchResolve('reject'),
                     style: Object.assign({}, settingsButtonStyle, { background: TONES.red.bg, borderColor: TONES.red.border }),
                   }, fill(t('batchReject'), selectedCount)) : null) : null),
               ticketStatus('needs'),
               needs.length === 0
                 ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 15px', borderRadius: '10px', background: 'rgba(70,180,100,0.07)', border: '1px solid rgba(70,180,100,0.22)' } },
                      h('span', { style: { fontSize: '16px', width: '28px', height: '28px', lineHeight: '27px', textAlign: 'center', borderRadius: '50%', background: TONES.green.bg, border: '1px solid ' + TONES.green.border, color: TONES.green.fg, flexShrink: 0 } }, '✓'),
                      h('div', null,
                        h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('quiet')),
                        h('div', { style: { fontSize: '12px', opacity: 0.65, marginTop: '2px' } }, t('quietHint'))))
                 : needs.map(function (tk) {
                     var card = ticketRowItem(tk, 'needs');
                     if (!showBatchControls || tk.stage !== 'person/confirm') return card;
                     return h('div', { key: 'sel-' + tk.id, style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
                       h('input', {
                         type: 'checkbox', checked: isSelected(tk), disabled: ticketBusy,
                         'aria-label': fill(t('selectTicket'), tk.message || tk.id),
                         style: { marginTop: '14px', cursor: 'pointer', flexShrink: 0 },
                         onChange: function (event) {
                           var checked = event.target.checked;
                           setSelected(function (current) {
                             var next = new Map(current);
                             if (checked) next.set(tk.id, confirmationVersion(tk)); else next.delete(tk.id);
                             return next;
                           });
                         },
                       }),
                       h('div', { style: { flex: 1, minWidth: 0 } }, card));
                   })),
            h('section', { style: sectionStyle, id: 'hub-bot-stream', 'aria-labelledby': 'hub-bot-stream-title' },
              h('h3', { id: 'hub-bot-stream-title', className: 'hb-scroll-target', ref: streamHeading, tabIndex: -1,
                style: Object.assign({}, sectionTitleStyle, { marginTop: 0 }),
              }, t('ticketsSection'), tickets.length > 0 ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, opacity: 0.55 } },
                '· ' + filtered.length + (filtered.length !== tickets.length ? ' / ' + tickets.length : '')) : null),
              tickets.length > 0 || filterActive
                ? h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
                    h('input', {
                      style: Object.assign({}, inputStyle, { flex: '1 1 200px', width: 'auto', padding: '4px 10px', fontSize: '12px' }),
                      value: focusedTicketId || filterText, placeholder: t('filterPlaceholder'), 'aria-label': t('filterPlaceholder'),
                      onChange: function (ev) { setFilterText(ev.target.value); resetStreamTarget(); },
                      onKeyDown: function (ev) { if (ev.key === 'Escape') clearStreamFilters(); },
                    }),
                    h('select', {
                      style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 10px', fontSize: '12px' }),
                      value: filterStage, 'aria-label': t('filterStageLabel'),
                      onChange: function (ev) { setFilterStage(ev.target.value); resetStreamTarget(); },
                    }, h('option', { value: '' }, t('filterAllStages')), presentStages.map(function (stage) {
                      var sample = tickets.find(ticket => ticket.stage === stage);
                      return h('option', { key: stage, value: stage }, sample.stageText || stage);
                    })),
                    presentOwners.length > 1 || filterOwner
                      ? h('select', {
                          style: Object.assign({}, inputStyle, { width: 'auto', padding: '4px 10px', fontSize: '12px' }),
                          value: filterOwner, 'aria-label': t('filterOwnerLabel'),
                          onChange: function (ev) { setFilterOwner(ev.target.value); resetStreamTarget(); },
                        }, h('option', { value: '' }, t('filterAllOwners')), presentOwners.map(function (id) {
                          return h('option', { key: id, value: id }, ownerFilterLabel(id));
                        }))
                      : null,
                    filterActive
                      ? h('button', {
                          type: 'button', onClick: clearStreamFilters, title: t('clearFiltersHint'),
                          style: { fontSize: '11px', padding: '3px 10px', borderRadius: '999px', cursor: 'pointer', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.25)', opacity: 0.75, whiteSpace: 'nowrap' },
                        }, '× ' + t('clearFilters'))
                      : null,
                    visibleStages.length > 0 ? h('button', {
                      type: 'button', onClick: toggleGroups, title: t('expandAllHint'),
                      style: { marginLeft: 'auto', fontSize: '11px', padding: '3px 10px', borderRadius: '999px', cursor: 'pointer', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.25)', opacity: 0.75, whiteSpace: 'nowrap' },
                    }, allGroupsOpen ? '▴ ' + t('collapseAll') : '▾ ' + t('expandAll')) : null)
                : null,
              ticketStatus('stream'),
              filtered.length === 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 10px' } }, t(filterActive ? 'filterNoMatch' : 'emptyTickets'))
                : visibleStages.map(function (stage) {
                    var list = filtered.filter(ticket => ticket.stage === stage);
                    var open = groupIsOpen(stage);
                    var shown = open ? list.slice(0, expandedGroups[stage] ?? 12) : [];
                    var rows = shown.map(function (tk) {
                      var isTarget = tk.id === focusedTicketId;
                      if (tk.stage !== 'done' || isTarget) return ticketRowItem(tk, 'stream', isTarget);
                      var expanded = expandedDone[tk.id] === true;
                      return h('details', { key: tk.id, className: 'hb-recent-row', 'data-hb-archive': tk.id, open: expanded,
                        onToggle: function (event) {
                          if (event.target !== event.currentTarget || event.currentTarget.open === expanded) return;
                          var open = event.currentTarget.open;
                          setExpandedDone(current => ({ ...current, [tk.id]: open }));
                        },
                      },
                        h('summary', { className: 'hb-archive-summary', title: t('doneExpandHint'),
                          style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '6px 8px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' },
                        },
                          h('span', { 'aria-hidden': true, style: { color: TONES.green.fg, fontSize: '11px' } }, '✓'),
                          h('span', { style: { maxWidth: '32%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' } }, ownerFilterLabel(tk.owner)),
                          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: tk.message || '' }, tk.message || tk.id),
                          h('time', { dateTime: tk.updatedAt || tk.createdAt, style: { flexShrink: 0, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, relTime(t, tk.updatedAt || tk.createdAt)),
                          h('span', { 'aria-hidden': true, style: settingsHintStyle }, expanded ? '▴' : '▾')),
                        expanded ? ticketRowItem(tk, 'stream', false, true) : null);
                    });
                    if (open && list.length > shown.length) {
                      rows.push(h('button', {
                        key: 'more-' + stage, type: 'button',
                        onClick: function () { setExpandedGroups(current => ({ ...current, [stage]: (current[stage] ?? 12) + 12 })); },
                        style: { display: 'block', width: '100%', textAlign: 'center', fontSize: '12px', padding: '6px 0', marginTop: '2px', borderRadius: '6px', cursor: 'pointer', background: 'rgba(127,127,127,0.07)', border: '1px dashed rgba(127,127,127,0.3)', opacity: 0.8 },
                      }, fill(t('showMoreInGroup'), list.length - shown.length)));
                    }
                    return h('details', { key: stage, open: open, 'data-hb-stage': stage, style: { marginBottom: '6px' },
                      onToggle: function (ev) {
                        if (ev.target !== ev.currentTarget) return;
                        var nextOpen = ev.currentTarget.open;
                        if (nextOpen !== open) setOpenGroups(current => ({ ...current, [stage]: nextOpen }));
                      },
                    },
                      h('summary', { style: { cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '8px' } },
                        stagePill(stage, (list[0].stageText || stage) + ' · ' + list.length)),
                      h('div', { style: { marginTop: '8px' } }, rows));
                  })),
             h('section', { style: sectionStyle, 'aria-labelledby': 'hub-bot-outcomes-title' },
               h('h3', { id: 'hub-bot-outcomes-title', style: sectionTitleStyle }, t('outcomesSection')),
               recentResults.length ? recentResults.map(ticket => h('div', { key: ticket.id,
                 style: { display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'baseline', padding: '6px 0' },
               }, h('button', { type: 'button', className: 'hb-text-action',
                 style: { whiteSpace: 'normal', overflowWrap: 'anywhere' }, onClick: () => openStream({ ticketId: ticket.id }),
               }, ticket.report.summary || ticket.message || ticket.id), h('span', { style: settingsHintStyle }, ticket.ownerLabel)))
                 : h('p', { style: settingsHintStyle }, t('noResults'))),
             h('section', { style: sectionStyle, 'aria-labelledby': 'hub-bot-next-wake-title' },
               h('h3', { id: 'hub-bot-next-wake-title', style: sectionTitleStyle }, t('nextWake')),
               nextTimer ? h('button', { type: 'button', className: 'hb-text-action',
                 style: { whiteSpace: 'normal', overflowWrap: 'anywhere' }, onClick: () => switchPage('hub-bot-timers-title'),
               }, nextTimer.message + ' · ' + new Date(nextTimer.fireAt).toLocaleString())
                 : h('p', { style: settingsHintStyle }, t('noWake'))),
             renderIntake(),
             renderRecentMessages(),
            h('section', { style: sectionStyle, id: 'hub-bot-owners', 'aria-labelledby': 'hub-bot-owners-title' },
              h('h3', { id: 'hub-bot-owners-title', tabIndex: -1, className: 'hb-scroll-target', style: Object.assign({}, sectionTitleStyle, { marginTop: 0 }) }, t('ownersSection'),
                owners.length > 0 ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, '· ' + owners.length) : null),
              owners.length === 0
                ? h('p', { style: settingsHintStyle }, t('emptyOwners'))
                : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 315px), 1fr))', gap: '12px', maxWidth: '1080px' } },
                     owners.map(renderOwnerCard)))),
              panelPage === ownerWorkspacePage ? renderOwnerWorkspace() : null,
              h('div', { hidden: panelPage !== 'hub-bot-timers-title' },
                h(TimerSection, { timers: overview.timers, ownerNames, onRefresh: refreshOverview,
                  onTask: ticketId => openStream({ ticketId }), onWorker: canOpenOwnerSession ? openSessionById : undefined })),
              h('div', { hidden: panelPage !== 'hub-bot-runs-title' },
                h(RunHistory, { active: panelPage === 'hub-bot-runs-title', onTask: ticketId => openStream({ ticketId }),
                  onWorker: canOpenOwnerSession ? openSessionById : undefined })),
             h('div', { hidden: panelPage !== 'hub-bot-connections' },
               sectionDivider(t('connectionsSection'), 'hub-bot-connections'),
               h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 350px), 1fr))',
                 alignItems: 'start', gap: '16px', maxWidth: '1080px' } },
                 h(FeishuSection, { view: view, status: fs, onRefresh: refreshView, onSaved: settingsSaved }),
                 h(GithubSection, { view: view, status: github, onSaved: settingsSaved }))),
             h('div', { hidden: panelPage !== 'hub-bot-settings' },
               sectionDivider(t('settingsDivider'), 'hub-bot-settings'),
               h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 350px), 1fr))',
                 alignItems: 'start', gap: '16px', maxWidth: '1080px' } },
                 h('div', { style: { minWidth: 0 } },
                   h(ChiefModelSection, { view: view, catalog: catalog, onSaved: settingsSaved }),
                   h(HubBotRowConfig, { hubBotCtx: scoped, view: view, onSaved: settingsSaved })),
                 h(RuntimeSection, { view: view, onSaved: settingsSaved }))));
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

        if (linkedWorkspaceOwner()) {
          scoped.inject(['layout'], function (linkScope) {
            linkScope.effect(function () {
              var opened = false;
              function selectLinkedWorkspace() {
                if (opened || !linkedWorkspaceOwner() || !linkScope.slots.entries('main').some(entry => entry.options.key === 'hub-bot')) return;
                opened = true;
                linkScope.layout.selectPanel('hub-bot');
              }
              var unsubscribe = linkScope.slots.subscribe('main', selectLinkedWorkspace);
              selectLinkedWorkspace();
              return unsubscribe;
            }, 'hub-bot: owner workspace link');
          });
        } else if (new URL(window.location.href).searchParams.has('hubBotOwner')) {
          scoped.inject(['uiWorkspace'], function (linkScope) {
            linkScope.effect(function () {
              var current = true;
              var pendingGeneration;
              var generations = linkScope.connection.generation;
              async function openLinkedOwner() {
                var generationId = generations.getSnapshot()?.id;
                var url = new URL(window.location.href);
                var ownerId = url.searchParams.get('hubBotOwner');
                var operationId = url.searchParams.get('hubBotSwitch');
                if (!ownerId || !generationId || pendingGeneration === generationId) return;
                pendingGeneration = generationId;
                var t = linkScope.locale.bind(NS);
                try {
                  var sessionId;
                  if (operationId) {
                    var operation = unwrap(await linkScope.remote.hubBotSettings.ownerSwitchAction({ action: 'status', ownerId, operationId }));
                    sessionId = operation?.ownerId === ownerId && operation.operationId === operationId && operation.committedAt ? operation.oldSessionId : null;
                  } else {
                    var owners = unwrap(await linkScope.remote.hubBotSettings.listOwners());
                    sessionId = owners.find(row => row.id === ownerId && !row.recycled)?.sessionId;
                  }
                  if (!current || generations.getSnapshot()?.id !== generationId) return;
                  url = new URL(window.location.href);
                  if (url.searchParams.get('hubBotOwner') !== ownerId || url.searchParams.get('hubBotSwitch') !== operationId) return;
                  if (!sessionId) throw new Error(t('ownerSessionUnavailable'));
                  linkScope.get('layout')?.beginNavigation?.();
                  await linkScope.uiWorkspace.openSession(sessionId);
                  url.searchParams.delete('hubBotOwner');
                  if (operationId) url.searchParams.delete('hubBotSwitch');
                  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
                  ownerLinkError = null;
                  for (var listener of ownerLinkListeners) listener();
                } catch (error) {
                  if (!current || generations.getSnapshot()?.id !== generationId) return;
                  ownerLinkError = t('openSessionFailed') + ' · ' + (error?.message ?? String(error));
                  for (var listener of ownerLinkListeners) listener();
                  linkScope.get('layout')?.selectPanel?.('hub-bot');
                }
              }
              var unsubscribe = generations.subscribe(() => void openLinkedOwner());
              void openLinkedOwner();
              return () => { current = false; unsubscribe(); };
            }, 'hub-bot: owner session link');
          });
        }
      });
    }
    exports.name = 'hub-bot-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
