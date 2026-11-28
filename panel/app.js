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
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return fromUrl
  }
  return sessionStorage.getItem('hub-bot-token') ?? ''
}
let token = readToken()

async function api(route, opts = {}) {
  const requestToken = token
  const res = await fetch(API + route, {
    method: opts.method ?? 'GET',
    headers: { 'x-hub-bot-token': requestToken, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 401 && requestToken === token) {
    token = ''
    sessionStorage.removeItem('hub-bot-token')
    showTokenGate('token 无效，请重新输入。')
  }
  if (!token || requestToken !== token) throw new Error('unauthorized')
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? ('HTTP ' + res.status))
  if (!body) throw new Error('服务返回的数据无法读取。')
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

/* ---------- 工作总览 ---------- */
const NEEDS_ME = ['person/answer', 'person/confirm', 'person/review', 'blocked', 'failed']
const PROGRESS = ['working', 'queued', 'idle']
const TICKET_PAGE_SIZE = 20
const ticketOperations = new Set()
const openDetails = new Set()
let boardKey = null
let ownerKey = null
let timerKey = null
let intakeKey = null
let recentKey = null
let ticketIndex = new Map()
let refreshRequest = null
let loaded = false
let activePage = null
let focusedTicket = null

function ownerSessionLink(ownerId, sessionId) {
  return sessionId ? el('a', { href: '/?' + new URLSearchParams({ hubBotOwner: ownerId }), target: '_blank',
    rel: 'noopener noreferrer', class: 'btn session-link', title: sessionId }, text('打开负责人会话')) : null
}

function renderConnectionStatus(health) {
  const feishu = health.feishu ?? {}
  const github = health.github ?? {}
  const feishuState = !feishu.enabled ? '已关闭' : feishu.credentialState !== 'ok' ? '待绑定'
    : feishu.wsState === 'connected' ? '已连接' : ['connecting', 'reconnecting'].includes(feishu.wsState) ? '连接中' : '未连接'
  const githubState = !github.enabled ? '已关闭' : github.lastPollError ? '轮询失败'
    : github.followed?.length ? '监听 ' + github.followed.length + ' 个仓库' : '暂无监听仓库'
  $('#connection-status').textContent = '飞书 ' + feishuState + ' · GitHub ' + githubState
}

function healthProblems(health) {
  const items = []
  const feishu = health.feishu ?? {}
  // 未绑上时的待办：绑定流过期/失败优先说清「哪一步没走完」，否则才说凭据缺失/无效（同一件事不重复报）。
  if (feishu.enabled && feishu.credentialState !== 'ok') {
    if (feishu.registration === 'expired') items.push('飞书绑定未完成（二维码已过期）— 到连接页重新生成二维码')
    else if (feishu.registration === 'failed') items.push('飞书绑定失败' + (feishu.registrationError ? '：' + feishu.registrationError : ''))
    else items.push('飞书凭据' + (feishu.credentialState === 'missing' ? '缺失' : '无效') + ' — 到连接页重新扫码')
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
  for (const item of items) box.append(el('div', { class: 'health-item' }, text(item)))
  if (items.length && (health.feishu?.enabled || health.github?.enabled)) {
    box.append(el('a', { href: '#connections' }, text('查看连接状态')))
  }
}

function detailRow(label, value) {
  return el('div', { class: 'detail-row' }, el('span', { class: 'detail-label' }, text(label)), el('span', {}, text(value)))
}

function ticketDetails(t) {
  const box = el('div', { class: 'ticket-details' })
  if (t.message) box.append(detailRow('原文', t.message))
  if (t.authorization) box.append(detailRow('授权', t.authorization.actor + ' 经 ' + t.authorization.source + ' 于 ' + fmtTime(t.authorization.at)))
  if (t.deferred?.answer) box.append(detailRow('用户答复', t.deferred.answer))
  if (t.trigger) box.append(detailRow('Trigger', shortId(t.trigger.id) + (t.trigger.kind ? ' (' + t.trigger.kind + ')' : '')))
  for (const a of t.assignments ?? []) box.append(detailRow('Assignment', a.state + ' · ' + fmtTime(a.startedAt) + (a.endedAt ? ' → ' + fmtTime(a.endedAt) : '') + (a.endedReason ? ' (' + a.endedReason + ')' : '')))
  if (t.report) {
    box.append(detailRow('报告', t.report.summary ?? t.report.text))
    if (t.report.evidence != null) box.append(detailRow('证据', typeof t.report.evidence === 'string'
      ? t.report.evidence : JSON.stringify(t.report.evidence, null, 2)))
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

async function resolveTicket(ticket, resolution, message) {
  if (ticketOperations.has(ticket.id)) return
  ticketOperations.add(ticket.id)
  const row = document.getElementById('ticket-' + ticket.id)
  const buttons = row?.querySelectorAll('.row-actions button') ?? []
  for (const button of buttons) button.disabled = true
  try {
    const result = await api('tickets/resolve', { method: 'POST',
      body: { ticketId: ticket.id, resolution, message, ...(['confirm', 'reject', 'answer'].includes(resolution) && { requestId: ticket.deferred?.requestId }) } })
    const labels = { confirm: '已确认', reject: '已拒绝', answer: '答复已保存', retry: '已登记重试' }
    showNotice(result.stage === 'person/confirm' ? '请求仍在等待确认。' : labels[resolution])
    await refresh()
  } catch (error) {
    showError(error)
  } finally {
    ticketOperations.delete(ticket.id)
    for (const button of buttons) button.disabled = false
  }
}

function ticketActions(ticket) {
  if (ticket.stage === 'person/answer') {
    return el('span', { class: 'row-actions' }, el('button', { class: 'btn', type: 'button', onclick: () => {
      const message = window.prompt(ticket.question?.text ?? '回复')?.trim()
      if (message) void resolveTicket(ticket, 'answer', message)
    } }, text('回复')))
  }
  if (['blocked', 'failed'].includes(ticket.stage)) {
    return el('span', { class: 'row-actions' }, el('button', { class: 'btn', type: 'button',
      onclick: () => void resolveTicket(ticket, 'retry') }, text('重试任务')))
  }
  if (ticket.stage !== 'person/confirm') return null
  const wrap = el('span', { class: 'row-actions' })
  for (const [resolution, label, style] of [['confirm', '确认', 'primary'], ['reject', '拒绝', 'danger']]) {
    wrap.append(el('button', { class: 'btn ' + style, type: 'button', onclick: () => {
      if (window.confirm(label + '任务 ' + shortId(ticket.id) + '？\n' + (ticket.pendingConfirm?.text ?? ''))) {
        void resolveTicket(ticket, resolution)
      }
    } }, text(label)))
  }
  return wrap
}

function lazyTicketDetails(ticket) {
  const content = el('div')
  const details = el('details', { 'data-ticket-details': '' },
    el('summary', {}, text(ticket.report ? '查看报告与详情' : '查看详情')), content)
  let loadedDetail = false
  let loadingDetail = false
  async function loadDetail() {
    if (loadedDetail || loadingDetail) return
    loadingDetail = true
    content.replaceChildren(el('p', { role: 'status', class: 'quiet' }, text('正在读取详情…')))
    try {
      const detail = await api('tickets/detail?ticketId=' + encodeURIComponent(ticket.id))
      content.replaceChildren(ticketDetails(detail))
      loadedDetail = true
    } catch (error) {
      content.replaceChildren(el('p', { role: 'alert' }, text('无法读取任务详情：' + error.message)),
        el('button', { type: 'button', class: 'btn', onclick: loadDetail }, text('重试')))
    } finally {
      loadingDetail = false
    }
  }
  details.addEventListener('toggle', () => {
    if (details.open) {
      openDetails.add(ticket.id)
      void loadDetail()
    } else {
      openDetails.delete(ticket.id)
    }
  })
  if (openDetails.has(ticket.id)) details.open = true
  return details
}

function ticketRow(t) {
  const row = el('article', { class: 'ticket-row', id: 'ticket-' + t.id, tabindex: '-1', 'data-stage': t.stage })
  const head = el('div', { class: 'ticket-head' },
    el('span', { class: 'owner-label' }, text(t.ownerLabel ?? t.owner)),
    el('span', { class: 'badge' }, text(t.stageText ?? t.stage)),
    el('time', {}, text(fmtTime(t.updatedAt))))
  if (t.recoveryPending) head.append(el('span', { class: 'badge' }, text('恢复中')))
  row.append(head, el('div', { class: 'message' }, text(t.message ?? '(无原文)')))
  const prompt = t.stage === 'person/answer' ? t.question?.text : t.stage === 'person/confirm' ? t.pendingConfirm?.text : null
  if (prompt) row.append(el('p', { class: 'pending-confirm' }, text(prompt)))
  if (t.attentionReason) row.append(el('p', { class: 'warn-text small' }, text(t.attentionReason)))
  if (t.report && t.stage === 'person/review') row.append(el('p', { class: 'report-preview' }, text(t.report.summary)))
  if (t.deferred?.status === 'pending') {
    const target = t.deferred.target?.sessionId
    row.append(el('p', { class: 'quiet small' }, text('截止时间 ' + fmtTime(t.deferred.expiresAt) + (target ? ' · 目标会话 ' + target : ''))))
  }
  const delivery = t.deferred?.delivery
  const deliveryLabels = { queued: '答复待接管', sent: '答复已接管', failed: '答复投递失败', discarded: '已丢弃答复投递' }
  if (deliveryLabels[delivery?.state] || t.deferred?.reason) {
    row.append(el('p', { class: 'quiet small' }, text([deliveryLabels[delivery?.state], delivery?.reason ?? t.deferred?.reason].filter(Boolean).join(' · '))))
  }
  const actions = ticketActions(t)
  if (actions) row.append(actions)
  const session = ['person/review', 'blocked', 'failed'].includes(t.stage) ? ownerSessionLink(t.owner, t.ownerSessionId) : null
  if (session) row.append(session)
  row.append(lazyTicketDetails(t))
  return row
}

function renderStageGroups(box, stages, byStage, empty) {
  box.replaceChildren()
  for (const stage of stages) {
    const rows = byStage.get(stage) ?? []
    if (!rows.length) continue
    const group = el('section', { class: 'stage-group' }, el('h4', {}, text((rows[0].stageText ?? stage) + ' '),
      el('span', { class: 'count' }, text(rows.length))))
    let offset = 0
    const more = el('button', { class: 'btn', type: 'button', onclick: appendPage })
    function appendPage() {
      const page = rows.slice(offset, offset + TICKET_PAGE_SIZE)
      for (const ticket of page) {
        const pinned = $('#focused-ticket')
        if (pinned?.firstElementChild?.id === 'ticket-' + ticket.id) pinned.remove()
        group.insertBefore(ticketRow(ticket), more)
      }
      offset += page.length
      more.hidden = offset >= rows.length
      more.textContent = '显示更多（剩余 ' + (rows.length - offset) + '）'
    }
    group.append(more)
    appendPage()
    box.append(group)
  }
  if (!box.childElementCount) box.append(el('p', { class: 'quiet' }, text(empty)))
}

const OWNER_SWITCH_STATES = {
  waiting: '等待原会话空闲', preparing: '正在准备新会话', committed: '新会话已接管，等待归档',
  'archive-failed': '旧会话归档失败', completed: '更换完成', failed: '更换失败', cancelled: '已取消更换',
}

function ownerSwitchControls(owner, operation) {
  const controls = el('div', { class: 'run-filters' })
  const busy = operation && ['waiting', 'preparing', 'committed', 'archive-failed'].includes(operation.status)
  const actionButton = (label, request) => {
    const button = el('button', { class: 'btn', type: 'button' }, text(label))
    button.addEventListener('click', async () => {
      if (request.mode === 'stop' && !window.confirm('确认停止原负责人会话当前处理，等它空闲后更换？')) return
      const buttons = [...controls.querySelectorAll('button')]
      for (const item of buttons) item.disabled = true
      try {
        await api('owners/switch', { method: 'POST', body: { ownerId: owner.id, ...request } })
        await refresh()
      } catch (error) { showError(error) }
      finally { for (const item of buttons) item.disabled = false }
    })
    return button
  }
  if (owner.sessionId && !owner.recycled && !busy) {
    const request = { action: 'request', expectedSessionId: owner.sessionId }
    controls.append(actionButton('空闲后更换', { ...request, mode: 'wait' }), actionButton('停止后更换', { ...request, mode: 'stop' }))
  }
  if (operation) {
    const { operationId, status } = operation
    controls.append(el('span', { role: 'status', class: 'quiet small' }, text(OWNER_SWITCH_STATES[status] ?? status)))
    if (operation.reason) controls.append(el('span', { role: 'alert' }, text(operation.reason)))
    if (status === 'waiting') controls.append(actionButton('取消等待', { action: 'cancel', operationId }))
    if (status === 'archive-failed') controls.append(actionButton('重试归档', { action: 'retry-archive', operationId }))
    if (operation.committedAt) {
      const query = new URLSearchParams({ hubBotOwner: owner.id, hubBotSwitch: operationId })
      controls.append(el('a', { class: 'btn', href: '/?' + query, target: '_blank', rel: 'noopener noreferrer' }, text('打开原会话')))
    }
  }
  return controls.childElementCount ? controls : null
}

function renderOwners(owners, switches) {
  const ownerBox = $('#owners')
  ownerBox.replaceChildren()
  if (!owners.length) ownerBox.append(el('p', { class: 'quiet' }, text('暂无负责人。')))
  for (const owner of owners) {
    const label = owner.role === 'chief' ? '总管 (L1)' : (owner.workspace ?? owner.id)
    const status = owner.recycled ? '已回收' : owner.sessionId ? null : '未绑定'
    const entry = el('article', { class: 'owner-entry', 'data-owner-id': owner.id }, el('strong', {}, text(label)))
    if (status) entry.append(el('span', { class: 'quiet small' }, text(status)))
    const session = ownerSessionLink(owner.id, owner.sessionId)
    if (session) entry.append(session)
    const controls = ownerSwitchControls(owner, switches.get(owner.id))
    if (controls) entry.append(controls)
    ownerBox.append(entry)
  }
}

function renderBoard(overview) {
  const health = overview.health ?? {}
  renderHealth(health)
  renderConnectionStatus(health)
  const tickets = overview.tickets ?? []
  const owners = overview.owners ?? []
  const timers = overview.timers ?? []
  const nextBoardKey = JSON.stringify(tickets)
  if (boardKey !== nextBoardKey) {
    boardKey = nextBoardKey
    ticketIndex = new Map(tickets.map(ticket => [ticket.id, ticket]))
    const byStage = new Map()
    for (const ticket of tickets) {
      const group = byStage.get(ticket.stage) ?? []
      group.push(ticket)
      byStage.set(ticket.stage, group)
    }
    renderStageGroups($('#needs-me'), NEEDS_ME, byStage, '暂无待处理事项。')
    renderStageGroups($('#by-stage'), PROGRESS, byStage, '暂无进行中或排队的任务。')
    if ($('#ticket-history').open) renderHistory(byStage)
    const outcomes = $('#outcomes')
    const results = tickets.filter(ticket => ticket.report)
      .sort((a, b) => String(b.report.at ?? b.updatedAt ?? '').localeCompare(String(a.report.at ?? a.updatedAt ?? '')))
      .slice(0, 12)
    outcomes.replaceChildren()
    for (const ticket of results) outcomes.append(el('p', { class: 'result-line' },
      el('a', { href: '#ticket-' + encodeURIComponent(ticket.id) }, text(ticket.report.summary || ticket.message || ticket.id)),
      el('span', { class: 'quiet small' }, text(ticket.ownerLabel ?? ticket.owner))))
    if (!results.length) outcomes.append(el('p', { class: 'quiet' }, text('暂无结果。')))
    $('#focused-ticket')?.remove()
    if (focusedTicket) revealTicket(focusedTicket, false)
  }
  const switches = overview.ownerSwitches ?? []
  const nextOwnerKey = JSON.stringify([owners, switches])
  if (ownerKey !== nextOwnerKey) {
    ownerKey = nextOwnerKey
    renderOwners(owners, new Map(switches.map(operation => [operation.ownerId, operation])))
  }
  const nextTimerKey = JSON.stringify([timers, owners])
  if (timerKey !== nextTimerKey) {
    timerKey = nextTimerKey
    renderTimers(timers, owners)
    const next = timers.filter(timer => timer.status === 'pending' && timer.fireAt)
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt))[0]
    $('#next-wake').replaceChildren(el('p', { class: 'quiet' }, text(next
      ? next.message + ' · ' + fmtTime(next.fireAt) : '暂无计划中的提醒。')),
      el('a', { href: '#timers-page' }, text('管理提醒')))
  }
  const nextIntakeKey = JSON.stringify(overview.intake?.sources)
  if (intakeKey !== nextIntakeKey) { intakeKey = nextIntakeKey; renderIntake(overview.intake) }
}

function renderHistory(byStage) {
  if (!byStage) {
    byStage = new Map()
    for (const ticket of ticketIndex.values()) {
      const group = byStage.get(ticket.stage) ?? []
      group.push(ticket)
      byStage.set(ticket.stage, group)
    }
  }
  const stages = [...byStage.keys()].filter(stage => !NEEDS_ME.includes(stage) && !PROGRESS.includes(stage))
  renderStageGroups($('#history-tickets'), stages, byStage, '暂无任务历史。')
}

function revealTicket(id, moveFocus) {
  let row = document.getElementById('ticket-' + id)
  if (!row) {
    const ticket = ticketIndex.get(id)
    if (!ticket) {
      if (moveFocus) showError(new Error('找不到工单 ' + id))
      return
    }
    const history = $('#ticket-history')
    history.open = true
    const pinned = $('#focused-ticket')
    row = ticketRow(ticket)
    const entry = el('div', { id: 'focused-ticket' }, row)
    if (pinned) pinned.replaceWith(entry)
    else history.append(entry)
  }
  const history = row.closest('#ticket-history')
  if (history) history.open = true
  row.querySelector('details[data-ticket-details]').open = true
  if (moveFocus) {
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'center' })
  }
}


async function refreshRecentTriggers() {
  const box = $('#triggers')
  try {
    const { triggers } = await api('triggers?limit=15')
    const acceptedIds = new Set()
    for (const ticket of ticketIndex.values()) {
      if (ticket.trigger && ticket.lastDelivery?.state === 'sent') acceptedIds.add(ticket.trigger.id)
    }
    const nextKey = JSON.stringify(triggers.map(row => [row.id, row.injectedAt, row.dropped, row.intakeCohort, row.intakeDiscarded, acceptedIds.has(row.id)]))
    if (recentKey === nextKey) return
    recentKey = nextKey
    box.replaceChildren()
    if (!triggers.length) box.append(el('p', { class: 'quiet' }, text('暂无触发记录。')))
    for (const trigger of triggers) {
      const msg = String(trigger.message ?? trigger.title ?? '').replace(/\s+/g, ' ')
      const disposition = trigger.dropped ? '已丢弃' : trigger.injectedAt || acceptedIds.has(trigger.id) ? '已接管'
        : trigger.intakeDiscarded ? '已丢弃投递' : '已记录'
      const row = el('article', { class: 'event-entry' },
        el('div', { class: 'quiet small' }, text([trigger.kind, disposition, fmtTime(trigger.at)].filter(Boolean).join(' · '))),
        el('div', {}, text(msg.length > 100 ? msg.slice(0, 100) + '…' : msg)))
      row.append(renderTriggerDetail(trigger))
      box.append(row)
    }
  } catch (error) {
    if (error.message === 'unauthorized') return
    recentKey = null
    box.replaceChildren(el('p', { role: 'alert' }, text('触发记录加载失败：' + error.message)),
      el('button', { class: 'btn', type: 'button', onclick: refreshRecentTriggers }, text('重试')))
  }
}

function renderTriggerDetail(trigger) {
  const content = el('div', { class: 'quiet small' })
  const caption = trigger.intakeCohort ? '合并来信 · ' + trigger.intakeCohort.mergedCount : '查看原文及回复'
  const details = el('details', {}, el('summary', {}, text(caption)), content)
  details.addEventListener('toggle', async () => {
    if (!details.open) return
    content.replaceChildren(text('加载中…'))
    try {
      const detail = await api('triggers/detail?triggerId=' + encodeURIComponent(trigger.id))
      content.replaceChildren(detailRow('原文', detail.message ?? '—'))
      if (detail.reply) content.append(detailRow('回复 · ' + (QUEUE_TEXT[detail.reply.state] ?? detail.reply.state), detail.reply.text))
      if (detail.dropped) content.append(detailRow('丢弃原因', detail.dropped))
      if (detail.replyUnlinked) content.append(el('p', {}, text('回复未关联')))
      const entries = detail.intake?.cohort?.messages ?? []
      if (entries.length) content.append(el('ul', {}, ...entries.map(item => el('li', {},
        text([item.triggerId, item.message, ...item.ticketIds].filter(Boolean).join(' · '))))))
    } catch (error) {
      content.replaceChildren(el('p', { role: 'alert' }, text('无法读取触发详情：' + error.message)))
    }
  })
  return details
}

function renderTimers(timers, owners) {
  const box = $('#timers')
  box.replaceChildren()
  if (!timers.length) box.append(el('p', { class: 'quiet' }, text('暂无提醒。')))
  const states = { pending: '待触发', paused: '已暂停', firing: '正在提交', fired: '已建任务', cancelled: '已取消', failed: '失败' }
  for (const timer of timers) {
    const label = owners.find(owner => owner.id === timer.ownerId)?.workspace ?? timer.ownerId
    const actions = timer.status === 'pending' ? [['pause', '暂停'], ['cancel', '取消提醒']]
      : timer.status === 'paused' ? [['resume', '恢复'], ['cancel', '取消提醒']] : timer.status === 'firing' || (timer.status === 'fired' && timer.delivery?.state === 'queued') || (timer.schedule && timer.status === 'failed') ? [['cancel', '取消提醒']] : []
    const schedule = timer.schedule
    const repeat = schedule && (schedule.frequency === 'daily' ? '每日' : '每周' + ('一二三四五六日'[schedule.weekday - 1] ?? ''))
    const cadence = repeat ? repeat + ' ' + schedule.time + '（上海时间）' : null
    const time = schedule ? (timer.status === 'cancelled' ? null : '下次计划 ' + new Date(timer.fireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })) : fmtTime(timer.fireAt)
    const row = el('div', { class: 'ticket-row' }, el('strong', {}, text(timer.message)),
      el('p', { class: 'quiet small' }, text([label, cadence, time, states[timer.status], timer.late ? '已迟到' : null].filter(Boolean).join(' · '))))
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

const RUN_STATUS = { silent: '未通知', waiting: '待发送或汇总', sent: '通道已接受', failed: '发送失败', 'in-progress': '无发送记录' }
const RUN_RESULT = { result: '有结果', failure: '执行失败', blocked: '需要介入' }
let runQueryVersion = 0

function renderRun(run) {
  const name = run.source.kind === 'github' ? [run.source.repo, run.source.issueNumber && '#' + run.source.issueNumber].filter(Boolean).join(' ') || 'GitHub'
    : '提醒 ' + (run.source.timerId ?? '')
  const summary = el('summary', {}, text([fmtTime(run.createdAt), name, RUN_STATUS[run.status], RUN_RESULT[run.result?.kind]].filter(Boolean).join(' · ')))
  const task = el('a', { href: '#ticket-' + encodeURIComponent(run.ticketId) }, text('查看工单 ' + shortId(run.ticketId)))
  const facts = el('div', { class: 'ticket-details' }, task)
  if (run.source.url) facts.append(el('p', {}, el('a', { href: run.source.url, target: '_blank', rel: 'noreferrer' }, text('GitHub 来源'))))
  if (run.source.fireAt) facts.append(detailRow('计划时间', fmtTime(run.source.fireAt)))
  if (run.workerSession?.sessionId) facts.append(detailRow('执行会话', run.workerSession.sessionId))
  if (run.reason) facts.append(detailRow('未通知原因', run.reason))
  const history = el('div', { class: 'ticket-details' })
  const row = el('details', { class: 'ticket-row' }, summary, facts, history)
  row.addEventListener('toggle', async () => {
    if (!row.open) return
    history.replaceChildren(el('p', { class: 'quiet' }, text('正在读取明细…')))
    try {
      const detail = await api('runs/detail?id=' + encodeURIComponent(run.id))
      history.replaceChildren(
        ...(detail.lastProgressAt ? [detailRow('上次记录进展', fmtTime(detail.lastProgressAt))] : []),
        ...(detail.results ?? []).map(result => detailRow(RUN_RESULT[result.kind] ?? result.kind, fmtTime(result.at))),
        ...(detail.notifications ?? []).map(notice => {
          const state = notice.channelAccepted ? '通道已接受' : (QUEUE_TEXT[notice.state] ?? '无发送记录')
          return detailRow(notice.channel ?? '通知', [state, notice.acceptedAt && fmtTime(notice.acceptedAt), notice.id].filter(Boolean).join(' · '))
        }),
      )
    } catch (error) {
      history.replaceChildren(el('p', { role: 'alert' }, text(error.message)))
    }
  })
  return row
}

async function loadRuns(offset = 0) {
  const version = ++runQueryVersion
  const list = $('#run-list')
  const filters = new URLSearchParams({ offset, limit: 20 })
  for (const name of ['status', 'source']) {
    const value = $('#run-' + name).value
    if (value) filters.set(name, value)
  }
  list.replaceChildren(el('p', { class: 'quiet' }, text('正在读取运行记录…')))
  try {
    const page = await api('runs?' + filters)
    if (version !== runQueryVersion) return
    list.replaceChildren(...page.runs.map(renderRun))
    if (!page.runs.length) list.append(el('p', { class: 'quiet' }, text('暂无符合条件的运行。')))
    if (offset) list.append(el('button', { class: 'btn', type: 'button', onclick: () => void loadRuns(Math.max(0, offset - 20)) }, text('上一页')))
    if (page.nextOffset !== null) list.append(el('button', { class: 'btn', type: 'button', onclick: () => void loadRuns(page.nextOffset) }, text('下一页')))
  } catch (error) {
    if (version === runQueryVersion) list.replaceChildren(el('p', { role: 'alert' }, text(error.message)))
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
  cancel.addEventListener('click', () => void refresh({ reloadSettings: true }).catch(showError))
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
  const page = $('#settings-content')
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
  secSection.append(el('p', { class: 'status-line' }, text('命中黑名单的注入不直接执行：票转等您确认，确认后才注入（在总览确认）。留空 = 关闭兜底。')))
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

function renderConnections(view) {
  const page = $('#connection-content')
  page.replaceChildren()

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
      try { await api('feishu/register', { method: 'POST', body: {} }); setTimeout(() => void refresh().catch(showError), 2000) }
      catch (error) { showError(error); scanBtn.disabled = false }
    })
    fSection.append(scanBtn)
    fSection.append(el('p', { class: 'hint' }, text('授权边界在飞书侧：应用的可用范围与可见成员由飞书管理后台配置——能与 bot 说话的人即已授权。')))
    page.append(fSection)
  }

  const github = view.github ?? {}
  const gSection = el('section', { class: 'setting-block' }, el('h3', {}, text('GitHub')))
  if (!github.enabled) gSection.append(el('p', { class: 'status-line' }, text('GitHub 入口已关闭。')))
  if (github.status?.lastPollError) gSection.append(el('p', { role: 'alert', class: 'warn-text' },
    text('最近轮询失败：' + github.status.lastPollError)))
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
  page.append(gSection)
}

$('#ticket-history').addEventListener('toggle', event => {
  if (event.target === event.currentTarget && event.currentTarget.open) renderHistory()
})
for (const id of ['run-status', 'run-source']) $('#' + id).addEventListener('change', () => void loadRuns())
$('#run-refresh').addEventListener('click', () => void loadRuns())
$('#notification-form').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const input = $('#notification-id')
  const id = input.value.trim()
  if (!id) return
  const button = form.querySelector('button[type=submit]')
  const result = $('#notification-index')
  button.disabled = true
  result.replaceChildren(el('p', { role: 'status' }, text('正在读取通知索引…')))
  try {
    const detail = await api('notifications/detail?id=' + encodeURIComponent(id))
    const entries = detail.tickets.map(ticket => el('li', {},
      el('a', { href: '#ticket-' + encodeURIComponent(ticket.ticketId), style: 'display:block;overflow-wrap:anywhere' }, text('查看工单 ' + ticket.ticketId))))
    result.replaceChildren(el('ul', {}, ...entries))
  } catch (error) {
    result.replaceChildren(el('p', { role: 'alert' }, text(error.message)))
  } finally { button.disabled = false }
})

/* ---------- boot ---------- */
const pages = [...document.querySelectorAll('.page')]
const navigation = [...document.querySelectorAll('[data-page]')]
let settingsKey = null
let connectionKey = null

function showNotice(message, kind = 'status') {
  const bar = el('div', { class: 'toast' + (kind === 'alert' ? ' error' : ''), role: kind }, text(message))
  document.body.append(bar)
  setTimeout(() => bar.remove(), 6000)
}

function showError(error) {
  if (error?.message !== 'unauthorized') showNotice(String(error?.message ?? error), 'alert')
}

function showTokenGate(message) {
  loaded = false
  activePage = null
  focusedTicket = null
  boardKey = ownerKey = timerKey = intakeKey = recentKey = settingsKey = connectionKey = null
  ticketIndex.clear()
  openDetails.clear()
  $('#token-gate').hidden = false
  $('#navigation').hidden = true
  $('#connection-status').hidden = true
  $('#load-state').hidden = true
  $('#refreshed').textContent = ''
  for (const page of pages) page.hidden = true
  for (const id of ['needs-me', 'by-stage', 'outcomes', 'owners', 'next-wake', 'history-tickets', 'timers',
    'health', 'intake', 'triggers', 'run-list', 'connection-content', 'settings-content']) $('#' + id).replaceChildren()
  $('#focused-ticket')?.remove()
  const err = $('#token-error')
  err.hidden = !message
  err.textContent = message ?? ''
}

function updatePage(focus = false) {
  if (!loaded) return
  let hash = location.hash.slice(1)
  try { hash = decodeURIComponent(hash) } catch { /* use the literal fragment */ }
  const ticketId = hash.startsWith('ticket-') ? hash.slice(7) : null
  const next = navigation.some(tab => tab.dataset.page === hash) ? hash : 'board'
  for (const page of pages) page.hidden = page.id !== next
  for (const tab of navigation) {
    tab.classList.toggle('is-active', tab.dataset.page === next)
    if (tab.dataset.page === next) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
  }
  if (next === 'run-history' && next !== activePage) void loadRuns()
  const changed = next !== activePage || ticketId !== focusedTicket
  activePage = next
  focusedTicket = ticketId
  if (ticketId && changed) revealTicket(ticketId, true)
  else if (focus && changed) window.scrollTo(0, 0)
}

function renderLoadState(message, failed = false) {
  $('#load-state').hidden = !message
  $('#load-message').textContent = message ?? ''
  $('#load-message').setAttribute('role', failed ? 'alert' : 'status')
  $('#retry-load').hidden = !failed
}

function refresh({ reloadSettings = false } = {}) {
  if (reloadSettings) settingsKey = null
  if (refreshRequest?.token === token) return refreshRequest.promise
  const request = { token }
  refreshRequest = request
  request.promise = refreshPanel(request.token).finally(() => {
    if (refreshRequest === request) refreshRequest = null
  })
  return request.promise
}

async function refreshPanel(requestToken) {
  const [board, settings] = await Promise.allSettled([api('overview'), api('settings')])
  if (!token || requestToken !== token) throw new Error('unauthorized')
  if (board.status === 'fulfilled') {
    renderBoard(board.value)
    loaded = true
    $('#navigation').hidden = false
    $('#connection-status').hidden = false
    updatePage()
    $('#refreshed').textContent = '刷新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
    void refreshRecentTriggers()
  }
  if (settings.status === 'fulfilled') {
    const view = settings.value
    const nextSettingsKey = JSON.stringify([view.chief, view.concurrency, view.security, view.reporting,
      view.github?.enabled, view.github?.intervalMs, view.github?.loginAllowlist])
    if (settingsKey !== nextSettingsKey) {
      settingsKey = nextSettingsKey
      renderSettings(view)
    }
    const nextConnectionKey = JSON.stringify([view.feishu, view.github?.enabled, view.github?.followed,
      view.github?.resolveErrors, view.github?.status?.lastPollError])
    if (connectionKey !== nextConnectionKey) {
      connectionKey = nextConnectionKey
      renderConnections(view)
    }
  }
  const error = board.status === 'rejected' ? board.reason : settings.status === 'rejected' ? settings.reason : null
  if (error) {
    renderLoadState((loaded ? '刷新失败，页面保留上次数据：' : '加载失败：') + error.message, true)
    throw error
  }
  renderLoadState()
}

function boot() {
  if (!token) { showTokenGate(); return }
  $('#token-gate').hidden = true
  renderLoadState('正在加载 Hub Bot…')
  void refresh().catch(() => {})
}

$('#token-form').addEventListener('submit', event => {
  event.preventDefault()
  const input = $('#token-input')
  token = input.value.trim()
  if (!token) { showTokenGate('请输入管理 token。'); return }
  input.value = ''
  sessionStorage.setItem('hub-bot-token', token)
  boot()
})
$('#retry-load').addEventListener('click', () => void refresh().catch(() => {}))
window.addEventListener('hashchange', () => updatePage(true))
$('#board').addEventListener('click', event => {
  const link = event.target.closest('a[href^="#ticket-"]')
  if (link && location.hash === link.hash && focusedTicket) revealTicket(focusedTicket, true)
})
setInterval(() => { if (token) void refresh().catch(() => {}) }, REFRESH_MS)
boot()
