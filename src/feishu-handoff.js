const PAGE_CHARACTERS = 50

export const FEISHU_HANDOFF_HELP = [
  '在私聊使用 /hub-switch summary <负责人ID> 生成草稿。',
  '用 preview <草稿编号> <页码> 查看，edit-summary <草稿编号> <版本> <新正文> 修改。',
  '用 confirm-summary 或 discard-summary 加草稿编号和版本确认或放弃。',
  '选择 wait-summary 或 stop-summary，加草稿编号和确认版本后发起更换。各命令以 /hub-switch 开头。',
].join('\n')

/** Summary controls share the explicit switch prefix and never fall through to agent text. */
export function feishuHandoffCommand(text) {
  if (typeof text !== 'string') return null
  const match = /^[/]hub-switch[ \t]+(summary|preview|edit-summary|confirm-summary|discard-summary|wait-summary|stop-summary)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const [, command, supplied] = match
  const rest = supplied?.trim() ?? ''
  const help = { action: 'summary-help' }
  if (command === 'summary') return rest && !/[\r\n]/.test(rest) ? { action: 'summary-generate', ownerId: rest } : help
  const parsed = /^(summary-[a-z0-9-]+)(?:[ \t]+([1-9][0-9]*))?(?:[ \t]+([\s\S]+))?$/.exec(rest)
  if (!parsed) return help
  const [, draftId, numeric, content] = parsed
  const revision = numeric && Number(numeric)
  if (numeric && !Number.isSafeInteger(revision)) return help
  if (command === 'preview') return content === undefined ? { action: 'summary-preview', draftId, page: revision ?? 1 } : help
  if (!revision) return help
  if (command === 'edit-summary') return content?.trim() ? { action: 'summary-edit', draftId, revision, text: content } : help
  if (content !== undefined) return help
  if (command === 'wait-summary' || command === 'stop-summary') return { action: 'summary-request', draftId, revision, mode: command.split('-')[0] }
  return { action: command === 'confirm-summary' ? 'summary-confirm' : 'summary-discard', draftId, revision }
}

export function feishuHandoffPreview(draft, page = 1) {
  if (draft.status === 'discarded') return '该摘要已放弃。'
  const characters = Array.from(draft.text ?? '')
  const count = Math.max(1, Math.ceil(characters.length / PAGE_CHARACTERS))
  if (page > count) return '摘要共 ' + count + ' 页。使用 /hub-switch preview ' + draft.draftId + ' <页码> 查看。'
  const start = (page - 1) * PAGE_CHARACTERS
  return [
    draft.draftId + ' · v' + draft.revision + ' · ' + (draft.status === 'confirmed' ? '已确认' : '待确认'),
    '来源 ' + draft.sourceSessionId + (draft.sourceThroughSeq == null ? '' : ' #' + draft.sourceThroughSeq),
    '预览 ' + page + '/' + count + '\n' + characters.slice(start, start + PAGE_CHARACTERS).join(''),
    page < count ? '/hub-switch preview ' + draft.draftId + ' ' + (page + 1) : null,
  ].filter(Boolean).join('\n')
}

/** The Feishu actor and chat have already been authenticated by the inbox policy. */
export function applyFeishuHandoff(handoffs, command, trigger) {
  const { actor } = trigger.authorization
  const { chatId } = trigger.source
  if (command.action === 'summary-help') return { body: FEISHU_HANDOFF_HELP }
  const draft = handoffs.getFeishu({ draftId: command.draftId, actor, chatId })
  if (command.action === 'summary-preview') return { body: feishuHandoffPreview(draft, command.page) }
  const binding = { ownerId: draft.ownerId, expectedSessionId: draft.sourceSessionId }
  const reference = { draftId: draft.draftId, revision: command.revision }
  if (command.action === 'summary-request') {
    return { request: { action: 'request', ...binding, mode: command.mode, summary: reference, requestId: trigger.id } }
  }
  const fields = { ...binding, ...reference }
  if (command.action === 'summary-edit') return { body: feishuHandoffPreview(handoffs.edit({ ...fields, text: command.text })) }
  if (command.action === 'summary-confirm') {
    const confirmed = handoffs.confirm(fields)
    return { body: '已确认 ' + confirmed.draftId + ' v' + confirmed.revision + '\n/hub-switch wait-summary ' + confirmed.draftId + ' ' + confirmed.revision }
  }
  handoffs.discard(fields)
  return { body: '该摘要已放弃。可继续使用原来的更换指令。' }
}
