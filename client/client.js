// hub-bot 的 client 半侧：在插件管理器里给「dsh-hub-bot → hub-bot 行」的配置按钮提供表单页。
// 数据通路：ctx.remote.hubBotSettings.read()/update(patch)（host 侧 Remote 服务，与 HTTP 面板同核心）。
// 手写 __ModuleLoader__ 格式（与官方 client 包的构建产物同构）；只用 react，保持零构建。
window.__ModuleLoader__.load({
  id: 'dsh-hub-bot',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var h = React.createElement;

    var zh = {
      title: 'Hub Bot 中枢',
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

    var inject = ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-api-remotes'];
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'hub-bot: dictionaries');
      ctx.effect(function () {
        return ctx.slots.inject('plugins.row.config', function () {
          return ctx.slots.register({
            name: 'plugins.row.config',
            key: 'dsh-hub-bot#hub-bot',
            order: 0,
            label: function () { return ctx.locale.bind(NS)('title'); },
            locale: NS,
          }, function (ownerProps) { return h(HubBotRowConfig, { hubBotCtx: ctx }); });
        });
      }, 'hub-bot: row config');
    }
    exports.name = 'hub-bot-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
