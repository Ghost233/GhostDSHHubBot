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
      ownersCard: '负责人',
      connected: '已连接',
      notConnected: '未连接',
      disabled: '未启用',
      watching: '监听 {count} 个仓库',
      ownersSection: '负责人',
      colRole: '角色',
      colKind: '类型',
      colDir: '目录',
      colSession: '会话',
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
      needsMe: '需要我处理',
      quiet: '没有 — 一切安静。',
      ticketsSection: '任务流',
      confirmBtn: '确认',
      rejectBtn: '拒绝',
      pendingConfirmLabel: '待确认：',
      questionLabel: '等您回复：',
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
      detailAuth: '授权',
      detailReport: '报告',
    };
    var en = {
      title: 'Hub Bot',
      panel: 'Hub Bot',
      workspaceSection: 'Workspace placement',
      enabled: 'Owner sessions are born inside their workspace',
      chiefPath: 'L1 shared workspace directory (absolute path; empty = default <homeRepo>/.hub-bot/chief)',
      chiefPathWarn: 'Note: outside the homeRepo tree the chief session loses the repo AGENTS.md context.',
      chiefTitle: 'L1 workspace title (a name you set yourself is never overwritten)',
      modelSection: 'Chief model',
      modelFollow: 'Follows the deployment default',
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
      ownersCard: 'Owners',
      connected: 'Connected',
      notConnected: 'Not connected',
      disabled: 'Disabled',
      watching: 'Watching {count} repos',
      ownersSection: 'Owners',
      colRole: 'Role',
      colKind: 'Kind',
      colDir: 'Directory',
      colSession: 'Session',
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
      ticketsSection: 'Ticket stream',
      confirmBtn: 'Confirm',
      rejectBtn: 'Reject',
      pendingConfirmLabel: 'Pending confirm: ',
      questionLabel: 'Waiting for your reply: ',
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
      detailAuth: 'Authorized',
      detailReport: 'Report',
    };
    var NS = 'dsh-hub-bot.settings';

    // 防御性拆包：remote 结果可能带 {ok:true,value} envelope（官方 stub 在生成代码里拆，
    // 我们的手写 contribution 没有那层），裸对象则原样通过。
    function unwrap(x) {
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
      var formState = React.useState({ enabled: true, chiefPath: '', chiefTitle: '' });
      var form = formState[0]; var setForm = formState[1];

      var load = function () {
        setError(null);
        ctx.remote.hubBotSettings.read().then(function (raw) {
          var v = unwrap(raw);
          setView(v);
          setForm({
            enabled: v.workspaces ? v.workspaces.enabled !== false : true,
            chiefPath: (v.workspaces && v.workspaces.chiefPath) || '',
            chiefTitle: (v.workspaces && v.workspaces.chiefTitle) || 'Hub Bot 中枢',
          });
        }).catch(function (e) { setError(e && e.message ? e.message : String(e)); });
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
            chiefPath: form.chiefPath.trim(),
            chiefTitle: form.chiefTitle.trim() || 'Hub Bot 中枢',
          },
        }).then(function (v) { setView(unwrap(v)); setSaved(true); })
          .catch(function (e) { setError(e && e.message ? e.message : String(e)); })
          .finally(function () { setBusy(false); });
      };

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
            h('label', { style: labelStyle }, t('chiefPath')),
            h('input', {
              style: inputStyle, value: form.chiefPath, placeholder: '/Volumes/…',
              onChange: function (ev) { setForm(Object.assign({}, form, { chiefPath: ev.target.value })); },
            }),
            h('div', { style: warnStyle }, t('chiefPathWarn'))),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle }, t('chiefTitle')),
            h('input', {
              style: inputStyle, value: form.chiefTitle,
              onChange: function (ev) { setForm(Object.assign({}, form, { chiefTitle: ev.target.value })); },
            }))),
        hideModel ? null : h('div', { style: sectionStyle },
          h('div', { style: sectionTitleStyle }, t('modelSection')),
          h('div', { style: { fontSize: '13px' } }, model ? model.provider + ' / ' + model.model : t('modelFollow')),
          h('div', { style: warnStyle }, t('modelHint'))),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          h('button', {
            onClick: save, disabled: busy,
            style: Object.assign({}, inputStyle, { width: 'auto', cursor: 'pointer', padding: '6px 16px' }),
          }, busy ? t('saving') : t('save')),
          saved ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('saved')) : null,
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
          flex: '1 1 170px', padding: '14px 16px', borderRadius: '10px',
          border: '1px solid var(--dsh-border, rgba(127,127,127,0.25))',
          background: 'var(--dsh-surface-raised, rgba(127,127,127,0.06))',
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

        function HubBotPanelPage() {
          var t = scoped.locale.bind(NS);
          var vs = React.useState(null); var view = vs[0]; var setView = vs[1];
          var os = React.useState(null); var owners = os[0]; var setOwners = os[1];
          var cs = React.useState(null); var catalog = cs[0]; var setCatalog = cs[1];
          var os2 = React.useState(null); var overview = os2[0]; var setOverview = os2[1];
          var es = React.useState(null); var error = es[0]; var setError = es[1];
          var ms = React.useState(''); var modelChoice = ms[0]; var setModelChoice = ms[1];
          var bs = React.useState(false); var modelBusy = bs[0]; var setModelBusy = bs[1];
          var ds = React.useState(false); var modelDone = ds[0]; var setModelDone = ds[1];
          var rs = React.useState(null); var resolving = rs[0]; var setResolving = rs[1];

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
              var m = v.chief && v.chief.model;
              setModelChoice(m ? m.provider + '/' + m.model : '');
            }).catch(function (e) { setError(e && e.message ? e.message : String(e)); });
          };
          React.useEffect(load, []);

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

          var resolve = function (tk, resolution) {
            var label = resolution === 'confirm' ? t('confirmBtn') : t('rejectBtn');
            if (!window.confirm(label + ' — ' + (tk.pendingConfirm && tk.pendingConfirm.text ? tk.pendingConfirm.text : tk.id))) return;
            setResolving(tk.id + ':' + resolution); setError(null);
            scoped.remote.hubBotSettings.resolveTicket({ ticketId: tk.id, resolution: resolution })
              .then(function () { load(); })
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

          var tickets = overview.tickets || [];
          var needs = tickets.filter(function (tk) { return NEEDS_ME.indexOf(tk.stage) >= 0; });
          var healthItems = healthProblems(overview.health || {}, t);

          var ticketRowItem = function (tk, withActions) {
            var rows = [];
            rows.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
              stagePill(tk.stage, tk.stageText || tk.stage),
              h('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, tk.ownerLabel || tk.owner),
              h('span', { style: { flex: 1, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: tk.message || '' }, tk.message || '（无原文）'),
              tk.recoveryPending ? stagePill('queued', t('recovering')) : null,
              h('span', { style: { fontSize: '12px', opacity: 0.55, whiteSpace: 'nowrap' } }, relTime(t, tk.updatedAt))));
            if (tk.pendingConfirm) rows.push(h('div', { key: 'pc', style: { marginTop: '6px', fontSize: '13px', color: TONES.amber.fg } }, t('pendingConfirmLabel') + tk.pendingConfirm.text));
            if (tk.question) rows.push(h('div', { key: 'q', style: { marginTop: '6px', fontSize: '13px', color: TONES.amber.fg } }, t('questionLabel') + tk.question.text));
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
            var details = [];
            if (tk.authorization) details.push(h('div', { key: 'a' }, t('detailAuth') + '：' + tk.authorization.actor + ' · ' + relTime(t, tk.authorization.at)));
            (tk.assignments || []).forEach(function (a, i) {
              details.push(h('div', { key: 'as' + i }, 'Assignment · ' + a.state + (a.endedReason ? '（' + a.endedReason + '）' : '')));
            });
            if (tk.report) details.push(h('div', { key: 'r' }, t('detailReport') + '：' + (tk.report.summary || '')));
            details.push(h('div', { key: 'id', style: { opacity: 0.5 } }, tk.id));
            rows.push(h('details', { key: 'd', style: { marginTop: '6px', fontSize: '12px', opacity: 0.8 } },
              h('summary', { style: { cursor: 'pointer' } }, t('detailToggle')),
              h('div', { style: { marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '3px' } }, details)));
            return h('div', { key: tk.id, style: {
              padding: '10px 12px', borderRadius: '8px', marginBottom: '8px',
              border: '1px solid var(--dsh-border, rgba(127,127,127,0.2))',
              background: 'var(--dsh-surface-raised, rgba(127,127,127,0.04))',
            } }, rows);
          };

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

          return h('div', { style: { padding: '20px 24px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
            h('h2', { style: { fontSize: '17px', fontWeight: 600, margin: '0 0 18px' } }, t('title')),
            h('div', { style: cardRowStyle },
              h('div', { style: cardStyle }, h('div', { style: cardTitleStyle }, t('feishuCard')), h('div', { style: cardValueStyle }, dot(feishuColor), feishuText)),
              h('div', { style: cardStyle }, h('div', { style: cardTitleStyle }, t('githubCard')), h('div', { style: cardValueStyle }, dot(githubColor), githubText)),
              h('div', { style: cardStyle }, h('div', { style: cardTitleStyle }, t('ownersCard')), h('div', { style: cardValueStyle }, String(owners.length)))),
            healthItems.length ? h('div', { style: {
              padding: '10px 14px', borderRadius: '8px', marginBottom: '18px', fontSize: '13px',
              background: 'rgba(230,160,40,0.1)', border: '1px solid rgba(230,160,40,0.35)', color: TONES.amber.fg,
              display: 'flex', flexDirection: 'column', gap: '4px',
            } }, healthItems.map(function (item, i) { return h('div', { key: i }, '⚠ ' + item); })) : null,
            h('div', { style: sectionStyle },
              h('div', { style: sectionTitleStyle }, t('needsMe')),
              needs.length === 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('quiet'))
                : needs.map(function (tk) { return ticketRowItem(tk, true); })),
            h('div', { style: sectionStyle },
              h('div', { style: sectionTitleStyle }, t('ticketsSection')),
              tickets.length === 0
                ? h('p', { style: { fontSize: '13px', opacity: 0.6, margin: '4px 0 0' } }, t('emptyTickets'))
                : STAGE_ORDER.map(function (stage) {
                    var list = tickets.filter(function (tk) { return tk.stage === stage; });
                    if (!list.length) return null;
                    var isPerson = NEEDS_ME.indexOf(stage) >= 0;
                    return h('details', { key: stage, open: isPerson, style: { marginBottom: '6px' } },
                      h('summary', { style: { cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '8px' } },
                        stagePill(stage, (list[0].stageText || stage) + ' · ' + list.length)),
                      h('div', { style: { marginTop: '8px' } }, list.map(function (tk) { return ticketRowItem(tk, false); })));
                  })),
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
                    modelDone ? h('span', { style: { fontSize: '12px', color: TONES.green.fg, whiteSpace: 'nowrap' } }, t('modelApplied')) : null)
                : h('div', { style: warnStyle }, t('catalogUnavailable')),
              h('div', { style: warnStyle }, t('modelPickerHint'))),
            h('div', { style: sectionStyle },
              h('div', { style: sectionTitleStyle }, t('ownersSection')),
              h('table', { style: tableStyle },
                h('thead', null, h('tr', null,
                  h('th', { style: thStyle }, 'ID'),
                  h('th', { style: thStyle }, t('colRole')),
                  h('th', { style: thStyle }, t('colKind')),
                  h('th', { style: thStyle }, t('colDir')),
                  h('th', { style: thStyle }, t('colSession')))),
                h('tbody', null, owners.map(function (o) {
                  var dir = o.cwd || o.workspace || '';
                  return h('tr', { key: o.id },
                    h('td', { style: tdStyle }, o.id),
                    h('td', { style: tdStyle }, o.role === 'chief' ? t('roleChief') : t('roleOwner')),
                    h('td', { style: tdStyle }, o.kind === 'temp' ? t('kindTemp') : t('kindRepo')),
                    h('td', { style: Object.assign({}, tdStyle, { opacity: 0.75 }), title: dir }, shortPath(dir)),
                    h('td', { style: tdStyle }, o.sessionId ? stagePill('done', t('sessionBound')) : stagePill('muted', t('sessionNone'))));
                })))),
            h(HubBotRowConfig, { hubBotCtx: scoped, hideModel: true }),
            error ? h('div', { style: { fontSize: '12px', color: TONES.red.fg, marginTop: '8px' } }, error) : null);
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
