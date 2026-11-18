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
    };
    var NS = 'dsh-hub-bot.settings';

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
        ctx.remote.hubBotSettings.read().then(function (v) {
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
        }).then(function (v) { setView(v); setSaved(true); })
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
        h('div', { style: sectionStyle },
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
        function HubBotPanelPage() {
          var t = scoped.locale.bind(NS);
          return h('div', { style: { padding: '20px 24px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
            h('h2', { style: { fontSize: '17px', fontWeight: 600, margin: '0 0 18px' } }, t('title')),
            h(HubBotRowConfig, { hubBotCtx: scoped }));
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
