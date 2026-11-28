export const DEFAULT_FEISHU_CREDENTIAL_REF = 'hub-bot/feishu'
export const MALFORMED = 'credentials-malformed'
export const UNAVAILABLE = 'credentials-unavailable'
export const MISSING = 'credentials-missing'

export class CredentialsError extends Error {
  constructor(message, reason = UNAVAILABLE) {
    super(message)
    this.name = 'CredentialsError'
    this.reason = reason
  }
}

export function isFeishuCredentialRef(value) {
  return typeof value === 'string' && /^hub-bot[/][a-z][a-z0-9-]*$/.test(value)
}

function isBinding(binding) {
  return binding && typeof binding.appId === 'string' && !!binding.appId
    && typeof binding.appSecret === 'string' && !!binding.appSecret
}

function decodeBinding(record) {
  if (record?.kind !== 'grant' || !isBinding(record.payload)) {
    throw new CredentialsError('hub-bot feishu: 宿主凭据记录无效（缺少 appId 或 appSecret）', MALFORMED)
  }
  const { appId, appSecret, boundAt } = record.payload
  return { appId, appSecret, boundAt: typeof boundAt === 'string' ? boundAt : null }
}

/** Adapt one namespaced grant in the installed DSH credentials service. */
export function createFeishuCredentialsPort(service, reference = DEFAULT_FEISHU_CREDENTIAL_REF) {
  if (!isFeishuCredentialRef(reference)) throw new CredentialsError('hub-bot feishu: 无效的凭据引用', MALFORMED)
  const available = typeof service?.readRecord === 'function' && typeof service?.modifyRecord === 'function'
  function requireService() {
    if (!available) throw new CredentialsError('hub-bot feishu: 宿主凭据服务不可用')
  }
  return {
    requireService,
    async read() {
      requireService()
      let record
      try {
        record = await service.readRecord(reference)
      } catch {
        throw new CredentialsError('hub-bot feishu: 无法读取宿主凭据记录')
      }
      return record === undefined ? undefined : decodeBinding(record)
    },
    async write(binding, signal) {
      requireService()
      if (!isBinding(binding)) throw new CredentialsError('hub-bot feishu: 飞书绑定缺少 appId 或 appSecret', MALFORMED)
      let record
      try {
        record = await service.modifyRecord(reference, async () => {
          signal?.throwIfAborted()
          return { kind: 'grant', payload: binding }
        })
      } catch {
        throw new CredentialsError('hub-bot feishu: 无法保存宿主凭据记录')
      }
      if (record === undefined) {
        throw new CredentialsError('hub-bot feishu: 宿主凭据服务未确认写入')
      }
      const saved = decodeBinding(record)
      if (saved.appId !== binding.appId || saved.appSecret !== binding.appSecret) {
        throw new CredentialsError('hub-bot feishu: 宿主凭据与此次绑定不一致')
      }
      return saved
    },
  }
}
