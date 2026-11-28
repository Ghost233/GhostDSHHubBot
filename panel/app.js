/* hub-bot 面板 (#73): 静态壳 + token 参数 + 纯 REST 消费 devApi — 无构建链、不依赖 DSH 内部。
 * 面板原则（spec「观测性」）: 安静默认、诚实状态（计数 = 列表长度）、一概念一位置、破坏性动作需确认。 */
'use strict'

const API = '/hub-bot/api/'
const REFRESH_MS = 5000

/* ---------- token ---------- */
function readToken() {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    sessionStorage.setItem('hub-bot-token', fromUrl)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname)
    return fromUrl
  }
  return sessionStorage.getItem('hub-bot-token') ?? ''
}
let token = readToken()

async function api(route, opts = {}) {
  const res = await fetch(API + route, {
    method: opts.method ?? 'GET',
    headers: { 'x-hub-bot-token': token, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401) {
    sessionStorage.removeItem('hub-bot-token')
    showTokenGate('token 无效，请重新输入。')
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(body.error ?? ('HTTP ' + res.status))
  return body
}

/* ---------- helpers ---------- */
const $ = sel => document.querySelector(sel)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}
const text = value => document.createTextNode(String(value ?? ''))
const esc = value => String(value ?? '')
const fmtTime = iso => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}
const shortId = id => (id ?? '').slice(0, 12)

/* ---------- 三问 ---------- */
const STAGE_ORDER = ['person/confirm', 'person/answer', 'person/review', 'blocked', 'failed', 'working', 'queued', 'idle', 'done', 'canceled']
const NEEDS_ME = new Set(['person/confirm', 'person/answer', 'person/review', 'blocked', 'failed'])

function healthProblems(health) {
  const items = []
  const feishu = health.feishu ?? {}
  // 未绑上时的待办：绑定流过期/失败优先说清「哪一步没走完」，否则才说凭据缺失/无效（同一件事不重复报）。
  if (feishu.enabled && feishu.credentialState !== 'ok') {
    if (feishu.registration === 'expired') items.push('飞书绑定未完成（二维码已过期）— 到设置页重新生成二维码')
    else if (feishu.registration === 'failed') items.push('飞书绑定失败' + (feishu.registrationError ? '：' + feishu.registrationError : ''))
    else items.push('飞书凭据' + (feishu.credentialState === 'missing' ? '缺失' : '无效') + ' — 到设置页重新扫码')
  }
  // 已绑定：只有真的连不上（failed/off）才算待办；connecting/reconnecting 是瞬时过程，保持安静不报警。
  if (feishu.enabled && feishu.credentialState === 'ok' && (feishu.wsState === 'failed' || feishu.wsState === 'off')) items.push('飞书长连接未建立')
  const gh = health.github ?? {}
  if (gh.enabled && gh.lastPollError) items.push('GitHub 轮询最近失败：' + gh.lastPollError)
  const ob = health.outbox ?? {}
  if (ob.failed > 0) items.push(ob.failed + ' 条投递失败')
  if (ob.systemProblems > 0) items.push(ob.systemProblems + ' 条系统级问题（outbox）')
  for (const r of ob.retrying ?? []) items.push('投递重试中：' + shortId(r.ticketId ?? r.id) + '（第 ' + r.attempts + ' 次）' + (r.lastError ? ' — ' + r.lastError : ''))
  return items
}

function renderHealth(health) {
  const box = $('#health')
  const items = healthProblems(health)
  box.replaceChildren()
  // 安静默认: 健康时不占空间
  box.hidden = items.length === 0
  for (const item of items) box.append(el('div', { class: 'health-item' }, text('⚠ ' + item)))
}

function detailRow(label, value) {
  return el('div', { class: 'detail-row' }, el('span', { class: 'detail-label' }, text(label)), el('span', {}, text(value)))
}

function ticketDetails(t) {
  const box = el('div', { class: 'ticket-details' })
  if (t.authorization) box.append(detailRow('授权', t.authorization.actor + ' 经 ' + t.authorization.source + ' 于 ' + fmtTime(t.authorization.at)))
  if (t.deferred?.answer) box.append(detailRow('用户答复', t.deferred.answer))
  if (t.trigger) box.append(detailRow('Trigger', shortId(t.trigger.id) + (t.trigger.kind ? ' (' + t.trigger.kind + ')' : '')))
  for (const a of t.assignments ?? []) box.append(detailRow('Assignment', a.state + ' · ' + fmtTime(a.startedAt) + (a.endedAt ? ' → ' + fmtTime(a.endedAt) : '') + (a.endedReason ? ' (' + a.endedReason + ')' : '')))
  if (t.report) {
    box.append(detailRow('报告', t.report.summary))
    if (t.report.sections) {
      box.append(detailRow('结果', t.report.sections.result))
      box.append(detailRow('变更', t.report.sections.changes))
      box.append(detailRow('验证', t.report.sections.verification))
      box.append(detailRow('风险', t.report.sections.risks))
    }
  }
  if (t.dirListing && t.dirListing.length) box.append(detailRow('目录', t.dirListing.join('  ')))
  box.append(detailRow('id', t.id))
  return box
}

function confirmActions(t) {
  const wrap = el('span', { class: 'row-actions' })
  const act = async resolution => {
    const label = resolution === 'confirm' ? '确认' : '拒绝'
    // 破坏性动作需确认 (spec 面板原则)
    if (!window.confirm(label + '任务 ' + shortId(t.id) + '？\n' + (t.pendingConfirm?.text ?? ''))) return
    await api('tickets/resolve', { method: 'POST', body: { ticketId: t.id, resolution, requestId: t.deferred?.requestId } })
    await refresh()
  }
  wrap.append(
    el('button', { class: 'btn primary', onclick: () => void act('confirm').catch(showError) }, text('确认')),
    el('button', { class: 'btn danger', onclick: () => void act('reject').catch(showError) }, text('拒绝')),
  )
  return wrap
}

function answerAction(t) {
  return el('button', { class: 'btn', type: 'button', onclick: () => void (async () => {
    const message = window.prompt(t.question?.text ?? '回复')?.trim()
    if (!message) return
    await api('tickets/resolve', { method: 'POST', body: { ticketId: t.id, resolution: 'answer', message, requestId: t.deferred?.requestId } })
    await refresh()
  })().catch(showError) }, text('回复'))
}

function ticketRow(t, { actions } = {}) {
  const row = el('div', { class: 'ticket-row' })
  const head = el('div', { class: 'ticket-head' })
  head.append(el('span', { class: 'owner-label' }, text(t.ownerLabel ?? t.owner)))
  head.append(el('span', { class: 'message', title: esc(t.message ?? '') }, text(t.message ?? '(无原文)')))
  if (t.recoveryPending) head.append(el('span', { class: 'badge' }, text('恢复中')))
  head.append(el('time', {}, text(fmtTime(t.updatedAt))))
  if (actions) head.append(actions)
  row.append(head)
  if (t.pendingConfirm && t.stage === 'person/confirm') row.append(el('div', { class: 'pending-confirm' }, text('待确认：' + t.pendingConfirm.text)))
  if (t.question && t.stage === 'person/answer') row.append(el('div', { class: 'pending-confirm' }, text('等您回复：' + t.question.text)))
  if (t.deferred?.status === 'pending') {
    const target = t.deferred.target?.sessionId
    row.append(el('p', { class: 'quiet small' }, text('截止时间 ' + fmtTime(t.deferred.expiresAt) + (target ? ' · 目标会话 ' + target : ''))))
  }
  const answerDelivery = t.deferred?.delivery
  const answerStates = { queued: '答复待接管', sent: '答复已接管', failed: '答复投递失败', discarded: '已丢弃答复投递' }
  if (answerStates[answerDelivery?.state] || t.deferred?.reason) {
    const result = [answerStates[answerDelivery?.state], answerDelivery?.reason ?? t.deferred?.reason].filter(Boolean).join(' · ')
    row.append(el('p', { class: 'quiet small' }, text(result)))
  }
  row.append(el('details', {}, el('summary', {}, text('详情')), ticketDetails(t)))
  return row
}

function renderBoard(overview) {
  renderHealth(overview.health ?? {})
  const tickets = overview.tickets ?? []

  // Q1 有需要我的吗: person/* + blocked/failed — 每行直接给出它需要的动作
  const needs = tickets.filter(t => NEEDS_ME.has(t.stage))
  const needBox = $('#needs-me')
  needBox.replaceChildren()
  if (!needs.length) needBox.append(el('p', { class: 'quiet' }, text('没有 — 安静默认。')))
  for (const t of needs) {
    needBox.append(ticketRow(t, { actions: t.stage === 'person/confirm' ? confirmActions(t)
      : t.stage === 'person/answer' ? answerAction(t) : undefined }))
  }

  // Q2 什么状态: 按阶段分组, 组头计数 = 列表长度 (诚实状态)
  const groups = $('#by-stage')
  groups.replaceChildren()
  for (const stage of STAGE_ORDER) {
    const list = tickets.filter(t => t.stage === stage)
    if (!list.length) continue
    const text0 = list[0].stageText ?? stage
    const group = el('section', { class: 'stage-group' })
    group.append(el('h3', {}, text(text0 + ' '), el('span', { class: 'count' }, text(String(list.length)))))
    for (const t of list) group.append(ticketRow(t, { actions: t.stage === 'person/confirm' ? confirmActions(t) : undefined }))
    groups.append(group)
  }
  if (!groups.children.length) groups.append(el('p', { class: 'quiet' }, text('还没有任务。')))

  // Q3 结果在哪: 等验收票的产物与目录清单
  const review = tickets.filter(t => t.stage === 'person/review')
  const outBox = $('#outcomes')
  outBox.replaceChildren()
  if (!review.length) outBox.append(el('p', { class: 'quiet' }, text('没有等验收的任务。')))
  for (const t of review) outBox.append(ticketRow(t))

  // 负责人注册表（观测面）：每个 owner 一行——身份/工作区/会话绑定/状态
  const ownerBox = $('#owners')
  ownerBox.replaceChildren()
  const owners = overview.owners ?? []
  if (!owners.length) {
    ownerBox.append(el('p', { class: 'quiet' }, text('暂无负责人。')))
  } else {
    const table = el('table', { class: 'data-table' })
    table.append(el('tr', {},
      el('th', {}, text('负责人')), el('th', {}, text('工作区')), el('th', {}, text('会话')), el('th', {}, text('状态'))))
    for (const o of owners) {
      const label = o.role === 'chief' ? '总管 (L1)' : (o.workspace ?? o.id)
      const kindText = o.transient ? '临时' : (o.kind === 'repo' ? '仓库' : o.kind)
      table.append(el('tr', { class: o.recycled ? 'quiet' : '' },
        el('td', {}, text(label), el('span', { class: 'quiet small' }, text(' · ' + kindText))),
        el('td', { class: 'quiet small', title: o.cwd ?? '' }, text(o.cwd ?? '—')),
        el('td', { class: 'quiet small' }, text(o.sessionId ? shortId(o.sessionId) + '…' : '未绑定')),
        el('td', {}, text(o.recycled ? '已回收' : (o.status ?? '—')))))
    }
    ownerBox.append(table)
  }

  // 投喂口径（只读观测面）：飞书入口与负责人路由各自生效的受理口径/去重/队列状态
  renderTimers(overview.timers, owners)
  renderIntake(overview.intake)

  // 最近触发（观测面）：渠道消息与处置——直读 trigger 表，异步加载不阻塞三问
  const trigBox = $('#triggers')
  trigBox.replaceChildren(el('p', { class: 'quiet small' }, text('加载中…')))
  api('triggers?limit=15').then(({ triggers }) => {
    trigBox.replaceChildren()
    if (!triggers?.length) { trigBox.append(el('p', { class: 'quiet' }, text('暂无触发记录。'))); return }
    const table = el('table', { class: 'data-table' })
    table.append(el('tr', {},
      el('th', {}, text('时间')), el('th', {}, text('渠道')), el('th', {}, text('内容')), el('th', {}, text('处置'))))
    for (const t of triggers) {
      const msg = String(t.message ?? '').replace(/\s+/g, ' ')
      const message = el('td', { class: 'small', title: msg }, text(msg.length > 40 ? msg.slice(0, 40) + '…' : msg))
      if (t.intakeCohort) message.append(renderCohort(t))
      const ticket = tickets.find(ticket => ticket.trigger?.id === t.id)
      const accepted = t.injectedAt || ticket?.lastDelivery?.state === 'sent'
      table.append(el('tr', {},
        el('td', { class: 'quiet small' }, text(fmtTime(t.at))),
        el('td', { class: 'quiet small' }, text(t.kind ?? '—')),
        message,
        el('td', { class: 'quiet small' }, text(t.dropped ? '已丢弃' : accepted ? '已接管' : t.intakeDiscarded ? '已丢弃投递' : '已记录'))))
    }
    trigBox.append(table)
  }).catch(() => trigBox.replaceChildren(el('p', { class: 'quiet small' }, text('触发记录加载失败。'))))
}

function renderCohort(trigger) {
  const content = el('div', { class: 'quiet small' })
  const details = el('details', {}, el('summary', {}, text('合并来信 · ' + trigger.intakeCohort.mergedCount)), content)
  details.addEventListener('toggle', async () => {
    if (!details.open) return
    content.replaceChildren(text('加载中…'))
    try {
      const detail = await api('triggers/detail?triggerId=' + encodeURIComponent(trigger.id))
      const entries = detail.intake?.cohort?.messages ?? []
      const list = el('ul', {}, ...entries.map(item => el('li', {}, text([item.triggerId, item.message, ...item.ticketIds].filter(Boolean).join(' · ')))))
      content.replaceChildren(list)
    } catch (error) {
      content.replaceChildren(text(error.message))
    }
  })
  return details
}

function renderTimers(timers, owners) {
  const box = $('#timers')
  const available = Array.isArray(timers)
  $('#timers-title').hidden = !available
  box.replaceChildren()
  if (!available) return
  if (!timers.length) box.append(el('p', { class: 'quiet' }, text('暂无提醒。')))
  const states = { pending: '待触发', paused: '已暂停', firing: '正在提交', fired: '已建任务', cancelled: '已取消', failed: '失败' }
  for (const timer of timers) {
    const label = owners.find(owner => owner.id === timer.ownerId)?.workspace ?? timer.ownerId
    const actions = timer.status === 'pending' ? [['pause', '暂停'], ['cancel', '取消提醒']]
      : timer.status === 'paused' ? [['resume', '恢复'], ['cancel', '取消提醒']] : timer.status === 'firing' || (timer.status === 'fired' && timer.delivery?.state === 'queued') ? [['cancel', '取消提醒']] : []
    const row = el('div', { class: 'ticket-row' }, el('strong', {}, text(timer.message)),
      el('p', { class: 'quiet small' }, text([label, fmtTime(timer.fireAt), states[timer.status], timer.late ? '已迟到' : null].filter(Boolean).join(' · '))))
    if (timer.delivery?.ticketId) row.append(el('p', { class: 'quiet small' }, text('任务 ' + timer.delivery.ticketId)))
    const delivery = ({ queued: '待投递', sent: '已接管', failed: '投递失败' })[timer.delivery?.state]
    if (delivery) row.append(el('p', { class: 'quiet small' }, text(delivery)))
    if (timer.delivery?.workerSession?.sessionId) row.append(el('p', { class: 'quiet small' }, text('会话 ' + timer.delivery.workerSession.sessionId)))
    const reason = timer.lastError?.message ?? timer.delivery?.lastError
    if (reason) row.append(el('p', { role: 'alert', class: 'warn-text' }, text(reason)))
    for (const [action, name] of actions) {
      const button = el('button', { class: 'btn', type: 'button' }, text(name))
      button.addEventListener('click', async () => {
        if (action === 'cancel' && !window.confirm('取消提醒「' + timer.message + '」？')) return
        button.disabled = true
        try {
          await api('timers/manage', { method: 'POST', body: { id: timer.id, action } })
          await refresh()
        } catch (error) { showError(error) }
        finally { button.disabled = false }
      })
      row.append(button)
    }
    box.append(row)
  }
}

/* ---------- 投喂口径（只读） ---------- */
// S06: 两个入口（飞书 / 负责人路由）的「生效受理口径」投影。数据全部来自 router 已经落库的 trigger/outbox 行，
// 这一块没有任何输入框、没有保存按钮——只把事实念出来，缺什么就显示「—」，不猜、不补。
const QUEUE_TEXT = { queued: '排队中', held: '暂缓', recorded: '待发送', sent: '已送达', failed: '失败' }
// 处置口径由 src/panel.js 统一判定（disposition 字段），面板只负责翻译，不自己再猜一遍。
const DISPOSITION_TEXT = { dropped: '已丢弃', discarded: '已丢弃投递', injected: '已注入', pending: '待注入', interrupt: '停止请求', 'interrupt-requested': '已请求停止' }

function dash(value) { return value === null || value === undefined || value === '' ? '—' : String(value) }

function renderIntake(intake) {
  const box = $('#intake')
  if (!box) return
  box.replaceChildren()
  // 旧后端没有 intake 投影时整块（含标题）不出现——不拿「没有数据」冒充「没有记录」。
  const title = $('#intake-title')
  if (title) title.hidden = !intake
  if (!intake) return
  const sources = intake.sources ?? []
  if (!sources.length) { box.append(el('p', { class: 'quiet' }, text('暂无投喂口径数据。'))); return }
  const table = el('table', { class: 'data-table' })
  table.append(el('tr', {},
    el('th', {}, text('入口')), el('th', {}, text('最近受理')), el('th', {}, text('受理口径')),
    el('th', {}, text('处置')), el('th', {}, text('队列')), el('th', {}, text('累计'))))
  for (const s of sources) {
    const queue = s.queue ?? {}
    const queueText = queue.state ? (QUEUE_TEXT[queue.state] ?? queue.state) + (queue.attempts ? ' · 第 ' + queue.attempts + ' 次' : '') : '—'
    // 处置（s06-core 契约）: dropped=当场丢弃并记账；injected=真的注入过；pending=已受理、等注入
    // （重启会重放，不是丢了）；没有触发行才是「—」。
    const disposition = s.disposition ? (DISPOSITION_TEXT[s.disposition] ?? s.disposition) : '—'
    const detail = s.disposition === 'dropped' && s.dropped ? '已丢弃: ' + s.dropped : disposition
    const policy = s.policy ? Object.entries(s.policy).map(([k, v]) => k + '=' + dash(typeof v === 'object' ? JSON.stringify(v) : v)).join(' · ') : null
    table.append(el('tr', {},
      el('td', {}, text(s.label ?? s.source), el('span', { class: 'quiet small' }, text(' · ' + (s.source ?? '—')))),
      el('td', { class: 'quiet small', title: s.triggerId ?? '' }, text(fmtTime(s.at))),
      // 受理口径 = 到达时的 addressing +（若 router 落了快照）原样透传的 policy 键值，没有就只显示 addressing。
      el('td', { class: 'quiet small', title: policy ?? '' }, text(policy ? dash(s.addressing) + ' · ' + policy : dash(s.addressing))),
      el('td', { class: 'quiet small' }, text(detail)),
      el('td', { class: 'quiet small', title: queue.lastError ?? '' }, text(queueText)),
      el('td', { class: 'quiet small' },
        text('触发 ' + (s.counts?.triggers ?? 0) + ' · 丢弃 ' + (s.counts?.dropped ?? 0) + ' · 注入 ' + (s.counts?.injected ?? 0)))))
  }
  box.append(table)
  // 去重键只读展示：飞书侧就是 feishu-<messageId>，同一条消息重复投递不会再落第二条 trigger。
  const keys = sources.filter(s => s.dedupKey).map(s => (s.label ?? s.source) + ' → ' + s.dedupKey)
  if (keys.length) box.append(el('p', { class: 'quiet small' }, text('去重键: ' + keys.join('；'))))
}

/* ---------- 设置 ---------- */
function saveBar(section, collect) {
  const bar = el('div', { class: 'save-bar', hidden: '' })
  const save = el('button', { class: 'btn primary' }, text('保存'))
  const cancel = el('button', { class: 'btn' }, text('放弃'))
  save.addEventListener('click', async () => {
    save.disabled = true
    try {
      await api('settings', { method: 'POST', body: { [section]: collect() } })
      await refresh()
    } catch (error) {
      showError(error)
    } finally {
      save.disabled = false
    }
  })
  cancel.addEventListener('click', () => void refresh())
  bar.append(save, cancel)
  return bar
}

function watchDirty(bar, ...inputs) {
  const dirty = () => { bar.hidden = false }
  for (const input of inputs) input.addEventListener('input', dirty)
}

function listField(value) {
  const area = el('textarea', { rows: '3', spellcheck: 'false' })
  area.value = (value ?? []).join('\n')
  return area
}
const readList = area => area.value.split('\n').map(s => s.trim()).filter(Boolean)

function renderSettings(view) {
  const page = $('#settings')
  page.replaceChildren()

  // 总管模型（用户可配）：目录来自 models/catalog；null = 跟随部署默认。改选即时对 L1 会话生效。
  const mSection = el('section', { class: 'setting-block' })
  mSection.append(el('h3', {}, text('总管模型')))
  const mCurrent = el('p', { class: 'status-line' })
  const cur = view.chief?.model ?? null
  mCurrent.append(text(cur ? ('当前：' + cur.provider + ' / ' + cur.model + (cur.reasoningEffort ? '（推理强度 ' + cur.reasoningEffort + '）' : '')) : '当前：跟随部署默认模型'))
  mSection.append(mCurrent)
  const mSelect = el('select', { class: 'model-select' })
  mSelect.append(el('option', { value: '' }, text('跟随部署默认')))
  mSelect.disabled = true
  mSection.append(mSelect)
  const mHint = el('p', { class: 'hint' }, text('正在加载可用模型…'))
  mSection.append(mHint)
  const mBar = el('div', { class: 'save-bar', hidden: 'hidden' })
  const mSave = el('button', { class: 'btn primary' }, text('保存模型选择'))
  mBar.append(mSave)
  mSection.append(mBar)
  api('models/catalog').then(({ catalog, chief }) => {
    mSelect.replaceChildren(el('option', { value: '' }, text('跟随部署默认（' + (catalog?.default ? catalog.default.provider + ' / ' + catalog.default.model : '部署决定') + '）')))
    for (const entry of catalog?.groups ?? []) {
      const group = el('optgroup', { label: entry.name })
      for (const m of entry.models ?? []) group.append(el('option', { value: entry.id + '/' + m.id }, text(m.name ?? m.id)))
      mSelect.append(group)
    }
    for (const f of catalog?.failures ?? []) mHint.append(text(' ' + f.name + ' 不可用：' + f.message))
    const chosen = chief?.model ? chief.model.provider + '/' + chief.model.model : ''
    mSelect.value = chosen
    mHint.textContent = mHint.textContent === '正在加载可用模型…' ? '选择后点击保存——立即对总管会话生效，并持久化供未来会话。' : mHint.textContent
    mSelect.disabled = false
    const dirty = () => { mBar.hidden = mSelect.value === chosen }
    mSelect.addEventListener('change', dirty)
    dirty()
    mSave.addEventListener('click', async () => {
      mSave.disabled = true
      try {
        const v = mSelect.value
        const model = v === '' ? null : { provider: v.split('/')[0], model: v.slice(v.indexOf('/') + 1) }
        await api('settings', { method: 'POST', body: { chief: { model } } })
        await refresh()
      } catch (error) { showError(error); mSave.disabled = false }
    })
  }).catch(error => { mHint.textContent = '模型目录加载失败：' + String(error?.message ?? error) })
  page.append(mSection)

  // 飞书 bot 管理块（唯一总 bot）：三态——已绑定（名片+连接+权限，二维码收起）/ 未绑定（预告+权限+扫码）/ 失效。
  const feishu = view.feishu ?? {}
  const fs = feishu.status ?? {}
  const fSection = el('section', { class: 'setting-block' })
  fSection.append(el('h3', {}, text('飞书 bot')))
  if (feishu.enabled !== true) {
    fSection.append(el('p', { class: 'status-line' }, text('入口关闭（profile 里 feishu.enabled=false）')))
    page.append(fSection)
  } else {
    const bound = fs.credentialState === 'ok' && fs.bot
    const invalid = fs.credentialState === 'invalid'
    // bot 名片：绑定后展示真实身份；未绑定预告将创建的身份
    const card = el('div', { class: 'bot-card' + (bound ? '' : ' bot-card--ghost') })
    card.append(el('div', { class: 'bot-name' }, text(fs.bot?.name ?? fs.preset?.name ?? 'DSH 中枢 Bot')))
    card.append(el('div', { class: 'quiet small' }, text(fs.bot?.desc ?? fs.preset?.desc ?? '')))
    if (bound) {
      card.append(el('div', { class: 'quiet small' }, text('App ID：' + (fs.bot.appIdMasked ?? '—') + (fs.bot.boundAt ? ' · 绑定于 ' + String(fs.bot.boundAt).slice(0, 16).replace('T', ' ') : ''))))
      // 连接阶段如实分档（connecting/reconnecting/connected/failed），不再一律压成「已/未建立」。
      const wsPhase = fs.wsState === 'reconnecting' ? '正在重连'
        : fs.wsState === 'connecting' ? '连接中'
          : fs.wsState === 'connected' || fs.bot.connected ? '长连接已建立'
            : '长连接未建立'
      const wsOk = wsPhase === '长连接已建立'
      card.append(el('div', { class: 'small ' + (wsOk ? 'ok-text' : 'warn-text') }, text('● ' + wsPhase)))
    }
    fSection.append(card)
    if (invalid) {
      const hint = fs.credentialReason === 'credentials-unavailable' ? '宿主凭据服务不可用，请检查 DSH 的凭据服务和存储状态。'
        : fs.credentialReason === 'credentials-malformed' ? '凭据记录格式无效，请检查现有 Bot 的引用和绑定。' : '凭据失效，请检查现有 Bot 的凭据记录。'
      fSection.append(el('p', { class: 'warn-text small' }, text(hint)))
    }
    const pending = fs.registration === 'pending'
    const expired = fs.registration === 'expired'
    const qrExpiry = fs.qr?.expireIn ? '二维码有效期 ' + Math.round(fs.qr.expireIn / 60) + ' 分钟，过期需重新生成。' : ''
    // 已绑定时这两句都要说清「绑定未变更、现有 Bot 照常工作」，不能让更换流程看起来像现有 Bot 出了问题。
    if (pending) fSection.append(el('p', { role: 'status', class: 'small' }, text(bound
      ? '正在更换绑定：等待扫码授权，现有 Bot 继续工作、绑定未变更。' + qrExpiry
      : '绑定请求已受理，等待授权和凭据保存。' + qrExpiry)))
    if (expired) fSection.append(el('p', { role: 'status', class: 'warn-text small' }, text(bound
      ? '这次更换的二维码已过期，绑定未变更；现有 Bot 照常工作，无需更换。'
      : '二维码已过期，绑定未完成——现有绑定（如有）不受影响，需重新生成二维码。')))
    if (fs.registration === 'failed') {
      const detail = fs.registrationError ?? '未知原因'
      const message = bound ? '更换绑定失败：' + detail + '。现有 Bot 可继续使用。' : '绑定失败：' + detail
      fSection.append(el('p', { role: 'alert', class: 'warn-text small' }, text(message)))
    }
    // 事件订阅模式（status.eventMode）：manual=需在开发者后台手工设置一次才提示；configured 已自动设好，保持安静。
    if (fs.eventMode === 'manual') {
      fSection.append(el('p', { class: 'hint' }, text('长连接事件订阅需手工设置一次：open.feishu.cn/app → 应用 → 事件与回调 → 订阅方式 → 使用长连接接收事件/回调。')))
    }
    // 权限申明（明文）：绑定前告知将申请什么，绑定后展示已授权什么
    const permTitle = bound ? '已申明权限' : '将申明的权限（扫码时一次确认）'
    const permList = el('ul', { class: 'perm-list' })
    for (const p of fs.permissions ?? []) permList.append(el('li', {}, el('code', {}, text(p.key)), text(' — ' + p.label)))
    fSection.append(el('p', { class: 'small' }, text(permTitle)), permList)
    // 二维码只在注册流 pending、且当前状态确实返回了二维码时出现——
    // 过期的二维码不再展示（expired 只给提示与重新生成入口），保存的绑定与实时二维码始终分开。
    if (pending && fs.qr && fs.qr.url) {
      const qrBox = el('div', { class: 'qr-box' })
      try {
        const qr = qrcode(0, 'M'); qr.addData(fs.qr.url); qr.make()
        const img = el('img', { class: 'qr-img', alt: '飞书授权二维码' })
        img.src = qr.createDataURL(6, 8)
        qrBox.append(img)
      } catch { qrBox.append(text('二维码生成失败，请用下方链接')) }
      fSection.append(qrBox)
      fSection.append(el('p', { class: 'hint' }, text('用手机飞书 App「扫一扫」扫上方二维码（桌面浏览器打开授权页无效）。用户码 ' + String(fs.qr.url).match(/user_code=([^&]+)/)?.[1] + '，有效期 ' + Math.round((fs.qr.expireIn ?? 3600) / 60) + ' 分钟。')))
      fSection.append(el('p', {}, el('a', { href: fs.qr.url, target: '_blank' }, text('（手机上点我直接打开）'))))
    }
    // 操作按钮：未绑定=开始扫码绑定；过期=重新生成二维码（显式重试）；等待中禁用避免重复发起；
    // 已绑定=重新注册（覆盖凭据，需确认）——不暗示现有 Bot 需要更换，也绝不自动开始扫码。
    const scanLabel = pending ? '等待扫码授权…'
      : expired ? '重新生成二维码'
        : bound ? '重新注册（覆盖现有凭据）'
          : '开始扫码绑定'
    const scanBtn = el('button', { class: 'btn' }, text(scanLabel))
    scanBtn.disabled = pending
    scanBtn.addEventListener('click', async () => {
      if (bound && !confirm('重新注册会创建新应用并覆盖现有凭据，当前绑定即失效。继续？')) return
      scanBtn.disabled = true
      try { await api('feishu/register', { method: 'POST', body: {} }); setTimeout(() => void refresh(), 2000) }
      catch (error) { showError(error); scanBtn.disabled = false }
    })
    fSection.append(scanBtn)
    fSection.append(el('p', { class: 'hint' }, text('授权边界在飞书侧：应用的可用范围与可见成员由飞书管理后台配置——能与 bot 说话的人即已授权。')))
    page.append(fSection)
  }

  // GitHub
  const github = view.github ?? {}
  const gSection = el('section', { class: 'setting-block' })
  gSection.append(el('h3', {}, text('GitHub')))
  const gEnabled = el('input', { type: 'checkbox' })
  gEnabled.checked = github.enabled === true
  const gInterval = el('input', { type: 'number', min: '30', step: '1', style: 'width:7em' })
  gInterval.value = String(Math.round((github.intervalMs ?? 300000) / 1000))
  const gList = listField(github.loginAllowlist)
  gSection.append(el('label', { class: 'inline' }, gEnabled, text(' 轮询监听')))
  gSection.append(el('label', {}, text('轮询间隔（秒，最小 30）')), gInterval)
  gSection.append(el('label', {}, text('login 白名单（每行一个；空 = 启动时解析为本人）')), gList)
  // 监听清单跟随 owner 注册表（只读）：注册了 repo 负责人即自动监听其 origin 仓库，无需在此配置。
  const followed = github.followed ?? []
  if (followed.length) {
    const repoTable = el('table', { class: 'repo-table' })
    repoTable.append(el('tr', {}, el('th', {}, text('监听中（跟随负责人注册表）')), el('th', {}, text('负责人'))))
    for (const f of followed) repoTable.append(el('tr', {}, el('td', {}, text(f.repo)), el('td', { class: 'quiet small' }, text(f.ownerId))))
    gSection.append(repoTable)
  } else {
    gSection.append(el('p', { class: 'hint' }, text('暂无监听仓库——向总管说「为 <仓库> 建负责人」后自动开始监听其 origin。')))
  }
  const resolveErrors = Object.entries(github.resolveErrors ?? {})
  if (resolveErrors.length) gSection.append(el('p', { class: 'hint' }, text('解析失败：' + resolveErrors.map(([k, v]) => k + ' ' + v).join('；'))))
  const gBar = saveBar('github', () => ({
    enabled: gEnabled.checked,
    intervalMs: Number(gInterval.value) * 1000,
    loginAllowlist: readList(gList),
  }))
  gSection.append(gBar)
  watchDirty(gBar, gEnabled, gInterval, gList)
  page.append(gSection)

  // 并发
  const cSection = el('section', { class: 'setting-block' })
  cSection.append(el('h3', {}, text('并发')))
  const slots = el('input', { type: 'number', min: '1', step: '1', style: 'width:5em' })
  slots.value = String(view.concurrency?.slotsPerOwner ?? 3)
  cSection.append(el('label', {}, text('每负责人执行槽（working 上限）')), slots)
  const cBar = saveBar('concurrency', () => ({ slotsPerOwner: Number(slots.value) }))
  cSection.append(cBar)
  watchDirty(cBar, slots)
  page.append(cSection)

  // 安全 (危险命令黑名单 — 命中转确认, spec「Policy」安全兜底)
  const secSection = el('section', { class: 'setting-block' })
  secSection.append(el('h3', {}, text('安全')))
  secSection.append(el('p', { class: 'status-line' }, text('命中黑名单的注入不直接执行：票转等您确认，确认后才注入（三问页可裁决）。留空 = 关闭兜底。')))
  const secList = listField(view.security?.dangerousPatterns)
  secSection.append(el('label', {}, text('危险命令黑名单（每行一个模式，大小写不敏感子串匹配）')), secList)
  const secBar = saveBar('security', () => ({ dangerousPatterns: readList(secList) }))
  secSection.append(secBar)
  watchDirty(secBar, secList)
  page.append(secSection)

  // 汇报
  const rSection = el('section', { class: 'setting-block' })
  rSection.append(el('h3', {}, text('定时汇报')))
  const rAuto = el('input', { type: 'checkbox' })
  rAuto.checked = view.reporting?.auto === true
  const rInterval = el('input', { type: 'number', min: '1', step: '1', style: 'width:7em' })
  rInterval.value = String(Math.round((view.reporting?.intervalMs ?? 60000) / 1000))
  rSection.append(el('label', { class: 'inline' }, rAuto, text(' 定时汇总自动汇报')))
  rSection.append(el('label', {}, text('间隔（秒）')), rInterval)
  const rBar = saveBar('reporting', () => ({ auto: rAuto.checked, intervalMs: Number(rInterval.value) * 1000 }))
  rSection.append(rBar)
  watchDirty(rBar, rAuto, rInterval)
  page.append(rSection)
}

/* ---------- boot ---------- */
function showError(error) {
  const bar = el('div', { class: 'toast error' }, text(String(error?.message ?? error)))
  document.body.append(bar)
  setTimeout(() => bar.remove(), 6000)
}

function showTokenGate(message) {
  $('#token-gate').hidden = false
  $('#board').hidden = true
  $('#settings').hidden = true
  const err = $('#token-error')
  err.hidden = !message
  if (message) err.textContent = message
}

async function refresh() {
  const [overview, settings] = await Promise.all([api('overview'), api('settings')])
  renderBoard(overview)
  renderSettings(settings)
  $('#refreshed').textContent = '刷新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

async function boot() {
  if (!token) { showTokenGate(); return }
  $('#token-gate').hidden = true
  $('#board').hidden = false
  $('#settings').hidden = true
  try {
    await refresh()
  } catch (error) {
    if (error.message !== 'unauthorized') showError(error)
    return
  }
  setInterval(() => void refresh().catch(() => {}), REFRESH_MS)
}

$('#token-form').addEventListener('submit', event => {
  event.preventDefault()
  token = $('#token-input').value.trim()
  sessionStorage.setItem('hub-bot-token', token)
  void boot()
})

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('is-active', other === tab)
    $('#board').hidden = tab.dataset.tab !== 'board'
    $('#settings').hidden = tab.dataset.tab !== 'settings'
  })
}

void boot()
