/** Configuration validation: absolute stateDir + homeRepo required; devApi off unless explicitly token-guarded. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, ConfigError } from '../src/config.js'
import { DEFAULT_DANGEROUS_PATTERNS } from '../src/security.js'

/** The minimal valid configuration; tests override one key at a time. */
const valid = () => ({ stateDir: '/tmp/hub-bot-state', homeRepo: '/Volumes/home' })

test('accepts an absolute stateDir and homeRepo', () => {
  assert.deepEqual(resolveConfig(valid()), { stateDir: '/tmp/hub-bot-state', homeRepo: '/Volumes/home', reporting: { auto: false, intervalMs: 60000 }, feishu: { enabled: false }, github: { enabled: false, intervalMs: 300000, loginAllowlist: [] }, concurrency: { slotsPerOwner: 3 }, security: { dangerousPatterns: [...DEFAULT_DANGEROUS_PATTERNS] }, chief: { model: null }, workspaces: { enabled: true, chiefPath: null, chiefTitle: 'Hub Bot 中枢', chiefWorkspaceId: null } })
})

test('reporting defaults to OFF (无自动汇报) and parses explicit overrides', () => {
  assert.deepEqual(resolveConfig(valid()).reporting, { auto: false, intervalMs: 60000 })
  assert.deepEqual(resolveConfig({ ...valid(), reporting: { auto: true } }).reporting, { auto: true, intervalMs: 60000 })
  assert.deepEqual(resolveConfig({ ...valid(), reporting: { auto: true, intervalMs: 5000 } }).reporting, { auto: true, intervalMs: 5000 })
  assert.throws(() => resolveConfig({ ...valid(), reporting: { auto: 'yes' } }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), reporting: { intervalMs: 0 } }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), reporting: { nope: true } }), ConfigError)
})


test('ordinary notification window is configurable in positive whole milliseconds', () => {
  const config = resolveConfig({ ...valid(), notifications: { windowMs: 30_000 } })
  assert.deepEqual(config.notifications, { windowMs: 30_000 })
  for (const notifications of [{ windowMs: 0 }, { windowMs: 1.5 }, { windowMs: '30' }, { interval: 1000 }, true]) {
    assert.throws(() => resolveConfig({ ...valid(), notifications }), ConfigError)
  }
})

test('rejects a missing stateDir', () => {
  const { stateDir, ...rest } = valid()
  void stateDir
  assert.throws(() => resolveConfig(rest), /requires config.stateDir/)
})

test('rejects undefined config entirely', () => {
  assert.throws(() => resolveConfig(undefined), ConfigError)
  assert.throws(() => resolveConfig(null), ConfigError)
})

test('rejects an empty or non-string stateDir', () => {
  assert.throws(() => resolveConfig({ ...valid(), stateDir: '' }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), stateDir: 42 }), ConfigError)
})

test('rejects a relative stateDir', () => {
  assert.throws(() => resolveConfig({ ...valid(), stateDir: 'state/hub-bot' }), /must be absolute/)
})

// The chief owner is anchored at the Home Repo; without it the startup bootstrap has nothing to register.

test('rejects a missing, empty, non-string, or relative homeRepo', () => {
  const { homeRepo, ...rest } = valid()
  void homeRepo
  assert.throws(() => resolveConfig(rest), /requires config.homeRepo/)
  assert.throws(() => resolveConfig({ ...valid(), homeRepo: '' }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), homeRepo: 42 }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), homeRepo: 'relative/home' }), /homeRepo must be absolute/)
})

test('rejects unknown keys so configuration typos cannot pass silently', () => {
  assert.throws(() => resolveConfig({ ...valid(), statedir: '/tmp/x' }), /unknown|does not know/i)
  assert.throws(() => resolveConfig({ ...valid(), verbose: true }), ConfigError)
})

// The management API can inject into any Session, so it stays off unless devApi is configured with a token.

test('no devApi means the management API stays disabled', () => {
  const config = resolveConfig(valid())
  assert.equal(config.devApi, undefined)
})

test('accepts devApi with a token', () => {
  const config = resolveConfig({ ...valid(), devApi: { token: 's3cret' } })
  assert.deepEqual(config.devApi, { token: 's3cret' })
})

test('rejects devApi without a usable token', () => {
  // 空对象是 cordis Config schema 的缺省回填 → 视为未配置（API 不启用），不报错。
  assert.equal(resolveConfig({ ...valid(), devApi: {} }).devApi, undefined)
  assert.throws(() => resolveConfig({ ...valid(), devApi: { token: '' } }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), devApi: { token: 42 } }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), devApi: true }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), devApi: null }), ConfigError)
})

test('rejects unknown keys inside devApi', () => {
  assert.throws(() => resolveConfig({ ...valid(), devApi: { token: 'x', port: 3199 } }), /does not know config.devApi key/)
})

test('cordis schema backfill tolerance: empty objects/arrays keep safe defaults', () => {
  const resolved = resolveConfig({ ...valid(), devApi: {}, chief: { model: {} }, security: { dangerousPatterns: [] }, workspaces: {} })
  assert.equal(resolved.devApi, undefined)
  assert.equal(resolved.chief.model, null)
  assert.deepEqual(resolved.security.dangerousPatterns, [...DEFAULT_DANGEROUS_PATTERNS]) // 绝不被回填清空
  assert.deepEqual(resolved.workspaces, { enabled: true, chiefPath: null, chiefTitle: 'Hub Bot 中枢', chiefWorkspaceId: null })
})

test('workspaces section: custom chiefPath/chiefTitle, strict validation', () => {
  const r = resolveConfig({ ...valid(), workspaces: { chiefPath: '/pub/ws', chiefTitle: '我的中枢', enabled: false } })
  assert.deepEqual(r.workspaces, { enabled: false, chiefPath: '/pub/ws', chiefTitle: '我的中枢', chiefWorkspaceId: null })
  assert.throws(() => resolveConfig({ ...valid(), workspaces: { chiefPath: 'relative/path' } }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), workspaces: { chiefTitle: '' } }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), workspaces: { nope: 1 } }), ConfigError)
})

// 凭据由 DSH 宿主凭据库保存。配置里的明文 appSecret 是 v1 遗留
// 人工降级通道，v2 必须拒绝并给出迁移提示——且报错文本绝不能回显密钥本身（凭据不进日志/报错）。
test('S04 regression: resolveConfig rejects a legacy plaintext feishu appSecret without echoing it', () => {
  const fakeSecret = 'fake-secret-do-not-echo-4f2a'
  assert.throws(
    () => resolveConfig({ ...valid(), feishu: { enabled: true, appId: 'cli_fake_app', appSecret: fakeSecret } }),
    error => {
      assert.ok(error instanceof ConfigError, '遗留明文 feishu.appSecret 必须抛 ConfigError')
      const message = String(error.message)
      assert.match(message, /feishu\.appSecret/, '报错必须点名 feishu.appSecret 这个键')
      assert.match(message, /migrat|migration|credential|registerApp|凭据|扫码/i, '报错必须带迁移/凭据库提示（如改用 credential store / registerApp 落盘）')
      assert.ok(!message.includes(fakeSecret), '报错绝不能回显明文 appSecret')
      return true
    },
  )
  // 纯引用式配置（只写 enabled/botOpenId，不含 appId/appSecret）必须继续正常解析——迁移只拒绝明文密钥。
  const referenced = resolveConfig({ ...valid(), feishu: { enabled: true, botOpenId: 'ou_fake_bot' } })
  assert.equal(referenced.feishu.enabled, true, '纯引用式飞书配置必须照常启用')
  assert.equal(referenced.feishu.appSecret, undefined, '解析结果里不应出现 appSecret')
})

// 只写 appId（没有 appSecret）同样是遗留明文通道的残留：必须一样拒绝，不能因为「半个密钥」就放过。
test('S04 regression: resolveConfig rejects a legacy plaintext feishu appId on its own', () => {
  assert.throws(
    () => resolveConfig({ ...valid(), feishu: { enabled: true, appId: 'cli_fake_app_only' } }),
    error => {
      assert.ok(error instanceof ConfigError, '遗留明文 feishu.appId 也必须抛 ConfigError')
      const message = String(error.message)
      assert.match(message, /feishu\.appId/, '报错必须点名 feishu.appId 这个键')
      // 提示要「只说该删的那个键」：只写了 appId 时，删除清单里不该冒出一个用户没写的 appSecret。
      assert.match(message, /请删掉 config\.feishu\.appId，/, '只写了 appId 时删除清单只列 appId')
      return true
    },
  )
  // appId + appSecret 同时出现时，报错要把两个键都点出来（一次说清要删什么）。
  assert.throws(
    () => resolveConfig({ ...valid(), feishu: { enabled: true, appId: 'cli_fake_app', appSecret: 'fake-secret-both-1d7' } }),
    error => {
      const message = String(error.message)
      assert.match(message, /请删掉 config\.feishu\.appId \/ config\.feishu\.appSecret，/, '两个遗留键都要进删除清单')
      assert.ok(!message.includes('fake-secret-both-1d7'), '报错绝不能回显明文 appSecret')
      return true
    },
  )
})

// 不写 feishu 段时默认仍是纯引用式的关闭状态；解析结果里绝不该凭空出现明文凭据字段（无静默降级）。
test('S04 regression: the resolved feishu section never carries plaintext credentials', () => {
  const omitted = resolveConfig({ ...valid() })
  assert.deepEqual(omitted.feishu, { enabled: false }, '默认飞书段只有开关，没有凭据字段')
  const disabled = resolveConfig({ ...valid(), feishu: { enabled: false, botOpenId: 'ou_fake_bot' } })
  assert.deepEqual(disabled.feishu, { enabled: false, botOpenId: 'ou_fake_bot' }, '纯引用式字段原样保留')
  assert.equal(Object.hasOwn(disabled.feishu, 'appId'), false, '解析结果不含 appId')
  assert.equal(Object.hasOwn(disabled.feishu, 'appSecret'), false, '解析结果不含 appSecret')
  // 形状不对的 feishu 段仍然按老规矩拒绝（这条边界没被凭据迁移放松）。
  assert.throws(() => resolveConfig({ ...valid(), feishu: 'nope' }), ConfigError)
  assert.throws(() => resolveConfig({ ...valid(), feishu: { nope: 1 } }), ConfigError)
})

test('S04 regression: credentialRef addresses only Hub Bot grant records', () => {
  const credentialRef = 'hub-bot/old-assistant'
  const resolved = resolveConfig({ ...valid(), feishu: { enabled: true, credentialRef } })
  assert.equal(resolved.feishu.credentialRef, credentialRef)
  for (const ref of ['other-plugin/feishu', 'hub-bot/a/b', 'plaintext-fixture-secret']) {
    assert.throws(() => resolveConfig({ ...valid(), feishu: { credentialRef: ref } }), error => {
      assert.match(error.message, /feishu[.]credentialRef/)
      assert.ok(!error.message.includes(ref))
      return true
    })
  }
})
