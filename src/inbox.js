export const FEISHU_SOURCE_MARK = '[hub-bot 飞书 '
export const UNSUPPORTED_MESSAGE_TYPE = '暂不支持该消息类型'

/** Render delivery from the original trigger and its saved authorization. */
export function feishuPrompt(trigger) {
  const { chatId, messageId, addressing } = trigger.source
  const { actor, at } = trigger.authorization
  return FEISHU_SOURCE_MARK + chatId + '/' + messageId + '] ' + trigger.message
    + '\n\n来源：feishu 用户 ' + actor + '（' + (addressing === 'direct' ? '私聊' : '群聊 @bot') + '）于 ' + at
    + `；回复本消息用 reply_source to='feishu:chat:${chatId}' triggerRef='${trigger.id}'。`
    + (messageId.startsWith('om_selftest-') ? '' : `若新建任务，调用 route_to_owner 时也传入 triggerRef='${trigger.id}'。`)
}
