/**
 * GitHubSource polls registered repositories through the local gh CLI. The first poll saves
 * a baseline without replaying old issues and PRs. Later cycles commit watermarks only after
 * the paginated records have been processed successfully.
 *
 * The login allowlist and bot:ignore policy record rejected events. Accepted issues, PRs and
 * work comments start independent Router work under the registered repository owner. Each
 * trigger uses the GitHub item number or immutable comment ID for replay protection.
 *
 * The outbox records GitHub acknowledgements and replies, and deliverReplies posts them with
 * the DSH badge. A stop comment or source closure ends the item's eligible tasks and notifies
 * the chief. Humans merge PRs.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { insertOutbox, deliverRecordedReplies } from './outbox.js'
import { canTransition, normalizeStage } from './tasks.js'
import { Store } from './store.js'

/** The official badge (dsh-badge skill): every bot-produced GitHub content ends with it. */
export const DSH_BADGE = '[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)'

/** The injection source mark prefix (同飞书机制 — channel input vs hand-typed input are distinguishable). */
export const GITHUB_SOURCE_MARK = '[hub-bot github '

/** Consecutive gh send failures before a recorded intent fails out and reports a system problem. */
const MAX_GITHUB_ATTEMPTS = 5
const ISSUE_PAGE_SIZE = 100
// Leave headroom below the gh buffer even for large, JSON-escaped Markdown bodies.
const COMMENT_PAGE_SIZE = 30

// A leading hidden marker survives Markdown rendering without changing the visible reply.
const REPLY_MARKER = /^<!-- hub-bot-github-reply:([a-f0-9-]{36}) -->\r?\n/

function replyAttemptKey(outboxId) {
  return 'github:reply-attempt:' + outboxId
}

function replyMarkerKey(marker) {
  return 'github:reply-marker:' + marker
}

function matchesReplyMarker(comment, attempt) {
  const author = comment.user?.login
  return REPLY_MARKER.exec(comment.body ?? '')?.[1] === attempt.marker
    && typeof author === 'string' && author.toLowerCase() === attempt.login
}

function githubCommentItem(comment) {
  const item = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/i.exec(comment.issue_url ?? '')
  return item ? { repo: item[1].toLowerCase(), number: Number(item[2]) } : null
}

function postedCommentKey(repo, commentId) {
  return 'github:posted-comment:' + repo.toLowerCase() + ':' + commentId
}

function replyReceiptKey(outboxId) {
  return 'github:reply-receipt:' + outboxId
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** Where per-repo watermarks persist (重启不重放). */
export function watermarkPath(stateDir) {
  return join(stateDir, 'github-watermarks.json')
}

/** Parses owner/name from a git remote URL (https/ssh/scp-like); null when it is not a GitHub remote. */
export function parseGitHubRepo(remoteUrl) {
  const m = String(remoteUrl ?? '').trim().match(/github\.com[:\/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
  return m ? m[1] + '/' + m[2] : null
}

/** The real git runner: read-only remote resolution, 10s cap. */
export async function realGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error('git ' + args.slice(0, 3).join(' ') + ' failed: ' + (stderr || error.message).toString().trim()))
      else resolve(String(stdout))
    })
  })
}

/** The real gh runner: REST through the local CLI, 30s cap per call. */
export async function realGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error('gh ' + args.slice(0, 3).join(' ') + ' failed: ' + (stderr || error.message).toString().trim()))
      else resolve(String(stdout))
    })
  })
}

export class GitHubSource {
  #polls = new Map()
  #loginTask = null
  #authenticatedLoginTask = null

  /**
   * @param {{ store: import('./store.js').Store, registry: import('./registry.js').OwnerRegistry,
   *   router: import('./router.js').Router, sessions: object, config: object,
   *   logger: { info: Function, warn: Function }, gh?: Function, now?: () => string }} deps
   */
  constructor({ store, registry, router, sessions, config, logger, gh, git, now }) {
    this.store = store
    this.registry = registry
    this.router = router
    this.sessions = sessions
    this.config = config ?? {}
    this.logger = logger
    this.gh = gh ?? realGh
    this.git = git ?? realGit
    this.now = now ?? (() => new Date().toISOString())
    this.watermarks = { repos: {} }
    this.lastErrors = {}
    this.resolveErrors = {}
    this.#loadWatermarks()
  }

  #loadWatermarks() {
    const file = watermarkPath(this.store.stateDir)
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed.repos === 'object' && parsed.repos !== null) this.watermarks = parsed
    } catch (error) {
      this.logger.warn('hub-bot github: watermark file unreadable (%s) — starting fresh (存量不触发仍成立)', error?.message ?? error)
    }
  }

  #saveWatermark(repo, watermark) {
    const next = { ...this.watermarks, repos: { ...this.watermarks.repos, [repo]: watermark } }
    const file = watermarkPath(this.store.stateDir)
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      renameSync(temp, file)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch { /* Preserve the original write error. */ }
      throw error
    }
    this.watermarks = next
  }

  /**
   * The watched set FOLLOWS the owner registry (用户决策 2026-11-16): every registered repo owner's checkout
   * (owner.cwd) resolves its GitHub repo from `git remote get-url origin` — no separate config list to keep
   * in sync. Failures (no origin, not GitHub) are recorded in lastErrors and skipped, never fatal.
   */
  async #watchedRepos() {
    const watched = []
    const seen = new Set()
    const resolveErrors = {}
    for (const owner of this.registry.list()) {
      if (owner.kind !== 'repo' || owner.recycled === true || owner.role === 'chief' || !owner.cwd) continue
      try {
        const remote = String(await this.git(['-C', owner.cwd, 'remote', 'get-url', 'origin'])).trim()
        const repo = parseGitHubRepo(remote)
        if (!repo) { resolveErrors['owner:' + owner.id] = 'origin is not a GitHub remote: ' + (remote || '(empty)'); continue }
        if (seen.has(repo)) continue
        seen.add(repo)
        watched.push({ repo, ownerId: owner.id, workspace: owner.workspace, cwd: owner.cwd })
      } catch (error) {
        resolveErrors['owner:' + owner.id] = error?.message ?? String(error)
      }
    }
    this.resolveErrors = resolveErrors
    this.lastWatched = watched
    return watched
  }

  /** The panel-facing health view: watched repos follow the registry; per-repo watermark + last error. */
  async status() {
    const watched = this.lastWatched ?? await this.#watchedRepos()
    const repos = {}
    for (const w of watched) {
      const wm = this.watermarks.repos[w.repo] ?? { initialized: false, maxNumber: 0, maxCommentId: 0 }
      repos[w.repo] = { ownerId: w.ownerId, workspace: w.workspace, initialized: wm.initialized === true, maxNumber: wm.maxNumber ?? 0, maxCommentId: wm.maxCommentId ?? 0, lastError: this.lastErrors[w.repo] }
    }
    return {
      enabled: this.config.enabled === true,
      intervalMs: this.config.intervalMs ?? 300000,
      loginAllowlist: this.config.loginAllowlist ?? [],
      mentionHandle: this.config.mentionHandle ?? null,
      repos,
      followed: watched.map(w => ({ repo: w.repo, ownerId: w.ownerId })),
      resolveErrors: { ...this.resolveErrors },
    }
  }

  /** A best-effort login lookup for callers outside the polling port. */
  async resolveSelfLogin() {
    try { return await this.#requiredLogin() } catch { return this.config.loginAllowlist ?? [] }
  }

  async #requiredLogin() {
    if (this.config.loginAllowlist?.length) return this.config.loginAllowlist
    if (!this.#loginTask) this.#loginTask = this.#lookupLogin().finally(() => { this.#loginTask = null })
    return this.#loginTask
  }

  #authenticatedLogin() {
    if (!this.#authenticatedLoginTask) {
      this.#authenticatedLoginTask = this.#readAuthenticatedLogin()
        .finally(() => { this.#authenticatedLoginTask = null })
    }
    return this.#authenticatedLoginTask
  }

  async #readAuthenticatedLogin() {
    const raw = await this.#githubApi(['user'])
    const login = JSON.parse(String(raw))?.login
    if (typeof login !== 'string' || !login.trim()) throw new Error('GitHub user response is missing a login')
    return login
  }

  async #lookupLogin() {
    try {
      const login = await this.#authenticatedLogin()
      if (this.config.loginAllowlist?.length) return this.config.loginAllowlist
      this.config.loginAllowlist = [login]
      this.logger.info('hub-bot github: loginAllowlist resolved from gh auth → %s', login)
      return this.config.loginAllowlist
    } catch (error) {
      if (this.config.loginAllowlist?.length) return this.config.loginAllowlist
      this.logger.warn('hub-bot github: could not resolve the gh login (%s)', error?.message ?? error)
      throw error
    }
  }

  /** One full polling cycle over every repo the registry currently yields. */
  async pollAll() {
    const totals = { triggered: 0, dropped: 0, terminated: 0 }
    if (this.config.enabled !== true) return { ...totals, disabled: true }
    const watched = await this.#watchedRepos()
    if (!watched.length) return totals
    try {
      await this.#requiredLogin()
    } catch (error) {
      for (const { repo } of watched) this.lastErrors[repo] = String(error?.message ?? error)
      return totals
    }
    for (const repoCfg of watched) {
      if (this.config.enabled !== true) break
      const result = await this.pollRepo(repoCfg).catch(() => null)
      if (!result) continue
      totals.triggered += result.triggered ?? 0
      totals.dropped += result.dropped ?? 0
      totals.terminated += result.terminated ?? 0
      if (result.stops?.length) (totals.stops ??= []).push(...result.stops)
    }
    return totals
  }

  /** Resolves the requested repository from the current registrations each time. */
  async pollWatchedRepo(repo) {
    const watched = await this.#watchedRepos()
    const repoCfg = watched.find(w => w.repo === repo)
    return repoCfg ? this.pollRepo(repoCfg) : null
  }

  /** A manual and scheduled poll for the same repo share one checkpoint update. */
  async pollRepo(repoCfg) {
    if (this.config.enabled !== true) return { triggered: 0, dropped: 0, terminated: 0, disabled: true }
    const { repo } = repoCfg
    if (this.#polls.has(repo)) return this.#polls.get(repo)
    const pending = this.#pollRepo(repoCfg).then(result => {
      delete this.lastErrors[repo]
      return result
    }, error => {
      this.lastErrors[repo] = String(error?.message ?? error)
      this.logger.warn('hub-bot github: poll %s failed: %s', repo, this.lastErrors[repo])
      throw error
    }).finally(() => this.#polls.delete(repo))
    this.#polls.set(repo, pending)
    return pending
  }

  #githubApi(args) {
    return this.gh(['api', ...args, '--hostname', 'github.com'])
  }

  async #fetchList(endpoint) {
    const rows = JSON.parse(String(await this.#githubApi([endpoint])))
    if (!Array.isArray(rows)) throw new Error('Expected GitHub list for ' + endpoint)
    return rows
  }

  async *#commentPages(endpoint) {
    const separator = endpoint.includes('?') ? '&' : '?'
    const query = endpoint + separator + 'per_page=' + COMMENT_PAGE_SIZE
    // Each page has its own gh deadline and output buffer.
    for (let page = 1; ; page++) {
      const comments = await this.#fetchList(query + '&page=' + page)
      for (const comment of comments) {
        if (!isPositiveInteger(comment?.id)) throw new Error('Invalid GitHub comment ID for ' + endpoint)
      }
      yield comments
      if (comments.length < COMMENT_PAGE_SIZE) return
    }
  }

  async #fetchComments(repo, since, cutoff) {
    // GitHub's `since` is exclusive and its timestamps are second-granularity. Revisit
    // the boundary second and let immutable comment IDs prevent replay after edits.
    const inclusive = new Date(Date.parse(since) - 1000).toISOString()
    const endpoint = 'repos/' + repo + '/issues/comments?sort=created&direction=asc&since=' + encodeURIComponent(inclusive)
    const comments = new Map()
    for await (const page of this.#commentPages(endpoint)) {
      let pastCutoff = false
      for (const comment of page) {
        const created = Date.parse(comment.created_at)
        const updated = Date.parse(comment.updated_at ?? comment.created_at)
        if (!Number.isFinite(created) || !Number.isFinite(updated)) {
          throw new Error('Invalid GitHub comment timestamp for ' + endpoint)
        }
        if (created > cutoff) pastCutoff = true
        else if (updated <= cutoff && !comments.has(comment.id)) comments.set(comment.id, comment)
      }
      // Pages are in creation order. Later edits to older comments remain eligible
      // in the next `since` window, including lower IDs.
      if (pastCutoff) break
    }
    return [...comments.values()].sort((a, b) => a.id - b.id)
  }

  async #fetchNewIssues(repo, floor) {
    const pageSize = floor === null ? 1 : ISSUE_PAGE_SIZE
    const endpoint = 'repos/' + repo + '/issues?state=all&sort=created&direction=desc&per_page=' + pageSize
    const fresh = new Map()
    for (let page = 1; ; page++) {
      const items = await this.#fetchList(endpoint + '&page=' + page)
      let reachedFloor = false
      for (const item of items) {
        if (!isPositiveInteger(item?.number)) throw new Error('Invalid GitHub issue number for ' + endpoint)
        if (floor !== null && item.number <= floor) reachedFloor = true
        else if (!fresh.has(item.number)) fresh.set(item.number, item)
      }
      if (floor === null || reachedFloor || items.length < pageSize) break
    }
    return [...fresh.values()].sort((a, b) => a.number - b.number)
  }

  async #pollRepo(repoCfg) {
    await this.#requiredLogin()
    if (this.config.enabled !== true) return { triggered: 0, dropped: 0, terminated: 0, disabled: true }
    const { repo } = repoCfg
    // Starting the horizon before fetching keeps arrivals during a poll eligible next time.
    const startedAt = this.now()
    const wm = this.watermarks.repos[repo] ?? { initialized: false, maxNumber: 0, maxCommentId: 0 }
    const fresh = await this.#fetchNewIssues(repo, wm.initialized ? (wm.maxNumber ?? 0) : null)
    const maxNumber = fresh.at(-1)?.number ?? wm.maxNumber ?? 0
    if (!wm.initialized) {
      // 首次只记水位线，存量不触发。
      this.#saveWatermark(repo, { ...wm, initialized: true, maxNumber, commentsSince: startedAt })
      return { triggered: 0, initialized: true }
    }
    let triggered = 0, dropped = 0, terminated = 0
    for (const item of fresh) {
      const result = await this.handleIssueEvent(item, repoCfg)
      if (result.routed) triggered++
      if (result.dropped && !result.deduped) dropped++
    }
    const cutoff = Date.parse(startedAt)
    const comments = await this.#fetchComments(repo, wm.commentsSince ?? startedAt, cutoff)
    let maxCommentId = wm.maxCommentId ?? 0
    const stops = []
    for (const c of comments) {
      const result = await this.handleCommentEvent(c, repoCfg)
      if (result.routed) triggered++
      if (result.dropped && !result.deduped) dropped++
      if (!result.deduped && result.transitionedTicketIds) {
        terminated += result.transitionedTicketIds.length
        stops.push({ repo, commentId: c.id, ...result })
      }
      maxCommentId = Math.max(maxCommentId, c.id)
    }
    const closures = await this.checkClosures(repoCfg)
    terminated += closures.terminated.length
    this.#saveWatermark(repo, { ...wm, maxNumber, maxCommentId, commentsSince: startedAt })
    return { triggered, dropped, terminated, ...(stops.length > 0 && { stops }) }
  }

  /** Event references use the item number for issues and PRs, and the immutable ID for comments. */
  #refFor(repo, kind, number) {
    return 'github:' + repo + ':' + kind + ':' + number
  }

  #getTrigger(id) {
    const raw = this.store.db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
    return raw === undefined ? undefined : JSON.parse(String(raw.value))
  }

  #insertTrigger(row) {
    this.store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(row.id, JSON.stringify(row), row.at)
  }

  /** The ticket produced from a triggerRef, or undefined (票面权威: tickets carry triggerId). */
  ticketByRef(ref) {
    const row = this.store.db.prepare("SELECT value FROM ticket WHERE json_extract(value, '$.triggerId') = ? LIMIT 1").get(ref)
    return row && JSON.parse(String(row.value))
  }

  /** One issue/PR list item normalized. */
  normalizeIssue(item, repoCfg) {
    return {
      repo: repoCfg.repo,
      number: item.number,
      kind: item.pull_request ? 'pr' : 'issue',
      title: item.title ?? '',
      body: typeof item.body === 'string' ? item.body : '',
      author: item.user?.login ?? 'unknown',
      labels: (item.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
      state: item.state ?? 'open',
      url: item.html_url ?? ('https://github.com/' + repoCfg.repo + '/issues/' + item.number),
    }
  }

  /** Policy and acknowledgement for a newly seen issue or PR. */
  async handleIssueEvent(item, repoCfg) {
    const norm = this.normalizeIssue(item, repoCfg)
    if (!isPositiveInteger(norm.number)) return { dropped: 'malformed' }
    const ref = this.#refFor(norm.repo, norm.kind, norm.number)
    const dropId = 'github-drop:' + norm.repo + ':' + norm.number
    const existing = this.#getTrigger(ref) ?? this.#getTrigger(dropId)
    if (existing) {
      if (existing.dropped) return { deduped: true, dropped: existing.dropped }
      const ticketId = this.ticketByRef(ref)?.id ?? null
      if (ticketId && existing.kind === 'github' && norm.kind === 'issue') this.#ackIssue(norm, ref, ticketId)
      return { deduped: true, ticketId }
    }
    const at = this.now()
    const source = { kind: 'github', repo: norm.repo, issueNumber: norm.number, url: norm.url, event: norm.kind }
    const addressing = 'direct'
    const drop = reason => this.#recordDrop({ id: dropId, source, addressing, author: norm.author, title: norm.title, at }, reason)
    if (norm.labels.includes('bot:ignore')) return drop('bot-ignore')
    if (!(this.config.loginAllowlist ?? []).includes(norm.author)) return drop('not-allowlisted')
    const ownerId = this.#registeredOwner(repoCfg)
    const authorization = { actor: norm.author, source: 'github', addressing, messageId: source.url, at }
    const message = norm.kind === 'pr' ? this.#prText(norm) : this.#issueText(norm)
    const receipt = await this.router.routeBackground({ ownerId, message, triggerRef: ref, authorization, source })
    if (receipt.ticketId && norm.kind === 'issue') this.#ackIssue(norm, ref, receipt.ticketId)
    return receipt.deduped ? { deduped: true, ticketId: receipt.ticketId }
      : { routed: true, ticketId: receipt.ticketId, ownerId: receipt.ownerId }
  }

  #registeredOwner(repoCfg) {
    const owner = this.registry.get(repoCfg.ownerId ?? 'repo-' + repoCfg.workspace)
    if (!owner || owner.kind !== 'repo' || owner.role === 'chief' || owner.recycled) {
      throw new Error('GitHub repository ' + repoCfg.repo + ' has no registered owner')
    }
    return owner.id
  }

  #ackIssue({ repo, number }, triggerId, ticketId) {
    const requestId = 'hub-bot-github-ack-' + repo + '-' + number
    if (this.store.db.prepare("SELECT id FROM outbox WHERE json_extract(value, '$.requestId') = ?").get(requestId)) return
    insertOutbox(this.store, {
      id: 'out-' + requestId, ticketId, triggerId, kind: 'reply', to: 'github:' + repo + ':' + number,
      body: '已受理，处理中。\n\n' + DSH_BADGE, state: 'recorded', requestId,
    })
  }

  #issueText(norm) {
    return GITHUB_SOURCE_MARK + norm.repo + '#' + norm.number + '] 新 Issue（作者 ' + norm.author + '）：' + norm.title
      + '\n' + norm.url
      + '\n\n' + (norm.body || '(无正文)').slice(0, 1500)
      + '\n\n处理链（本人 Issue 为显式请求，危险操作需人工确认）：插件代发 ack → worktree 修复 → gh pr create 提 PR（永不直推主分支；合并永远由人）→ 提 PR 后经汇报链通知用户审核（验收对象是 PR）。'
      + '对本 Issue 的回复用 reply_source to=\'github:' + norm.repo + ':' + norm.number + '\'。'
      + '你在 GitHub 的一切产出（评论、回复、PR 描述）结尾必须带 dsh-badge：' + DSH_BADGE
  }

  #prText(norm) {
    return GITHUB_SOURCE_MARK + norm.repo + '#' + norm.number + '] 新 PR（作者 ' + norm.author + '）：' + norm.title
      + '\n' + norm.url
      + '\n\n' + (norm.body || '(无描述)').slice(0, 1500)
      + '\n\n初审：给出摘要与风险点（改动面、兼容性、测试缺口）；review 意见用 reply_source to=\'github:' + norm.repo + ':' + norm.number + '\' 回到该 PR（修复并验证的评论静默处理，拒绝给一句理由）。合并永远由人。'
      + '产出结尾必须带 dsh-badge：' + DSH_BADGE
  }

  /** An allowlisted work comment starts its own task. A stop comment only ends work for its item. */
  async handleCommentEvent(c, repoCfg) {
    const { repo } = repoCfg
    const item = githubCommentItem(c)
    const issueNumber = item?.number
    if (item?.repo !== repo.toLowerCase() || !isPositiveInteger(issueNumber) || !isPositiveInteger(c.id)) {
      return { dropped: 'malformed' }
    }
    if (this.#isOwnComment(repo, issueNumber, c)) return { skipped: 'self-generated' }
    const ref = this.#refFor(repo, 'comment', c.id)
    const legacyDropId = 'github-drop:' + repo + ':' + issueNumber + '/c' + c.id
    const existing = this.#getTrigger(ref) ?? this.#getTrigger(legacyDropId)
    if (existing) {
      if (!existing.stop) return { deduped: true }
      return { deduped: true, transitionedTicketIds: existing.stop.ticketIds, workerOutcomes: existing.stop.outcomes ?? [] }
    }
    const author = c.user?.login ?? 'unknown'
    const body = typeof c.body === 'string' ? c.body : ''
    const at = this.now()
    const source = { kind: 'github', repo, issueNumber, commentId: c.id, url: c.html_url ?? null, event: 'comment' }
    const stop = body.trim() === '停'
    const mention = this.config.mentionHandle
    const explicitAddressing = stop ? 'direct' : mention && body.includes(mention) ? 'mention' : 'none'
    const drop = reason => this.#recordDrop({ id: ref, source, addressing: explicitAddressing, author, at }, reason)
    if (!(this.config.loginAllowlist ?? []).includes(author)) return drop('not-allowlisted')
    const tickets = this.#liveSourceTickets(repo).filter(item => item.number === issueNumber).map(item => item.ticket.id)
    if (explicitAddressing === 'none' && !tickets.length) return drop('untracked-comment')
    const addressing = explicitAddressing === 'mention' ? 'mention' : 'direct'
    const authorization = { actor: author, source: 'github', addressing, messageId: source.url, at }
    if (stop) {
      const trigger = this.#writeFacts(() => {
        const ticketIds = this.#terminateTasks(tickets, repo, issueNumber, '评论喊停', { notify: false })
        if (!ticketIds.length) return null
        const workers = this.#stoppedWorkers(ticketIds)
        const event = {
          id: ref, kind: 'github', source, authorization, at, stop: { ticketIds, workers },
          policy: { addressing, mode: 'interrupt', allowed: true, reason: null },
        }
        this.#insertTrigger(event)
        return event
      })
      if (!trigger) return drop('stop-without-task')
      const { ticketIds } = trigger.stop
      const workerOutcomes = await this.#cancelStoppedWorkers(trigger)
      return { transitionedTicketIds: ticketIds, workerOutcomes }
    }
    const ownerId = this.#registeredOwner(repoCfg)
    const label = addressing === 'mention' ? '评论提及' : '新评论'
    const message = GITHUB_SOURCE_MARK + repo + '#' + issueNumber + '] ' + label + '（作者 ' + author + '）：' + body.slice(0, 1000)
      + (source.url ? '\n' + source.url : '')
      + '\n对该 Issue/PR 的回复用 reply_source to=\'github:' + repo + ':' + issueNumber + '\'。'
      + '需要改动时使用 worktree 并提 PR（永不直推主分支，合并永远由人）。产出结尾必须带 dsh-badge：' + DSH_BADGE
    const receipt = await this.router.routeBackground({ ownerId, message, triggerRef: ref, authorization, source })
    return receipt.deduped ? { deduped: true, ticketId: receipt.ticketId }
      : { routed: true, ticketId: receipt.ticketId }
  }

  #recordDrop({ id, source, addressing, author, title, at }, reason) {
    this.#insertTrigger({
      id, kind: 'github-dropped', repo: source.repo, number: source.issueNumber, author,
      ...(source.commentId === undefined ? { itemKind: source.event, title } : { commentId: source.commentId }),
      source, policy: { addressing, mode: 'drop', allowed: false, reason }, dropped: reason, at,
    })
    return { dropped: reason }
  }

  #liveSourceTickets(repo) {
    const prefix = 'github:' + repo + ':'
    const rows = this.store.db.prepare(`
      SELECT t.value AS ticket, e.value AS event FROM ticket t
      LEFT JOIN trigger e ON e.id = json_extract(t.value, '$.triggerId')
      WHERE json_extract(t.value, '$.stage') NOT IN ('done', 'failed')
        AND (json_extract(e.value, '$.source.repo') = ? OR substr(json_extract(t.value, '$.triggerId'), 1, ?) = ?)
    `).all(repo, prefix.length, prefix)
    const live = []
    for (const row of rows) {
      const ticket = JSON.parse(String(row.ticket))
      const trigger = row.event && JSON.parse(String(row.event))
      const source = trigger?.source
      if (source?.kind === 'github') {
        if (source.repo === repo && isPositiveInteger(source.issueNumber)) {
          live.push({ ticket, number: source.issueNumber, pr: source.event === 'pr' })
        }
      } else if (typeof ticket.triggerId === 'string' && ticket.triggerId.startsWith(prefix)) {
        const item = this.#legacySourceItem(repo, ticket.triggerId.slice(prefix.length), trigger, ticket)
        if (item) live.push({ ticket, ...item })
      }
    }
    return live
  }

  #legacySourceItem(repo, ref, trigger, ticket) {
    const match = /^(issue|pr|comment):([1-9]\d*)$/.exec(ref)
    if (!match || !isPositiveInteger(Number(match[2]))) return null
    const [, kind, id] = match
    const auth = trigger?.authorization ?? ticket.authorization
    if (auth && auth.source !== 'github') return null
    if (kind !== 'comment') return { number: Number(id), pr: kind === 'pr' }
    // Legacy mention triggers stored the item in the comment URL and the source mark.
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:#issuecomment-(\d+))?$/i.exec(auth?.messageId ?? '')
    if (url && url[1].toLowerCase() === repo.toLowerCase() && isPositiveInteger(Number(url[3])) && (!url[4] || url[4] === id)) {
      return { number: Number(url[3]), pr: url[2] === 'pull' }
    }
    const marker = GITHUB_SOURCE_MARK + repo + '#'
    if (!trigger?.message?.startsWith(marker)) return null
    const number = Number(trigger.message.slice(marker.length).split(']', 1)[0])
    return isPositiveInteger(number) ? { number, pr: false } : null
  }

  #writeFacts(write, store = this.store) {
    const { db } = store
    if (db.isTransaction) return write()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = write()
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  #terminateTasks(ticketIds, repo, number, why, { notify = true } = {}) {
    const terminated = []
    const item = 'github ' + repo + '#' + number
    for (const ticketId of ticketIds) {
      const ticket = this.router.tasks.getTicket(ticketId)
      if (!ticket || !canTransition(ticket.stage, 'failed')) continue
      this.router.tasks.fail({ ticketId, reason: '源头' + why + '：' + item + '（让位于人）' })
      if (notify) this.#notice(ticketId, ticket.triggerId, '[hub-bot ' + item + '] 源头' + why + '，任务 ' + ticketId + ' 已终止（让位于人）。')
      terminated.push(ticketId)
    }
    return terminated
  }

  #notice(ticketId, triggerId, body) {
    insertOutbox(this.store, { ticketId, triggerId, kind: 'reply', to: 'dsh:session:chief', state: 'queued', body })
  }

  #stoppedWorkers(ticketIds) {
    const workers = []
    for (const ticketId of ticketIds) {
      const ticket = this.router.tasks.getTicket(ticketId)
      const sessionId = ticket?.workerSession?.sessionId
      if (ticket?.background?.kind === 'github' && ticket.authorization?.source === 'github' && typeof sessionId === 'string' && sessionId) {
        workers.push({ ticketId, sessionId, failedAt: ticket.failed.at })
      }
    }
    return workers
  }

  #canCancelStoppedWorker(sessionId, targets) {
    if (this.registry.isOwnerSession(sessionId)) return false
    const stillStopped = targets.some(({ ticketId, failedAt }) => {
      const ticket = this.router.tasks.getTicket(ticketId)
      return ticket?.stage === 'failed' && ticket.failed?.at === failedAt && ticket.workerSession?.sessionId === sessionId
    })
    if (!stillStopped) return false
    const otherWork = this.store.db.prepare(`
      SELECT 1 FROM ticket
      WHERE json_extract(value, '$.stage') NOT IN ('done', 'failed')
        AND (json_extract(value, '$.workerSession.sessionId') = ? OR json_extract(value, '$.targetSession') = ?)
      LIMIT 1
    `).get(sessionId, sessionId)
    return !otherWork
  }

  async #cancelStoppedWorkers(trigger) {
    const { workers, ticketIds } = trigger.stop
    const outcomes = []
    for (const sessionId of new Set(workers.map(target => target.sessionId))) {
      if (this.store.closed) break
      const targets = workers.filter(target => target.sessionId === sessionId)
      if (typeof this.sessions?.cancel !== 'function' || !this.#canCancelStoppedWorker(sessionId, targets)) {
        outcomes.push({ sessionId, status: 'skipped' })
        continue
      }
      try {
        await this.sessions.cancel({ sessionId })
        outcomes.push({ sessionId, status: 'cancelled' })
      } catch (error) {
        const message = String(error?.message ?? error)
        this.logger.warn('hub-bot github: stop %s failed for %s: %s', trigger.id, sessionId, message)
        outcomes.push({ sessionId, status: 'failed', error: message })
      }
    }
    if (!this.store.closed) this.#writeFacts(() => {
      const settled = { ...trigger, stop: { ...trigger.stop, outcomes } }
      this.store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(settled), trigger.id)
      const item = '[hub-bot github ' + trigger.source.repo + '#' + trigger.source.issueNumber + '] '
      for (const ticketId of ticketIds) {
        const worker = workers.find(target => target.ticketId === ticketId)
        const outcome = outcomes.find(result => result.sessionId === worker?.sessionId)
        let workerStatus = '未调用执行会话停止。'
        if (outcome?.status === 'cancelled') workerStatus = '执行会话已停止。'
        if (outcome?.status === 'failed') workerStatus = '执行会话停止失败：' + outcome.error
        this.#notice(ticketId, trigger.id, item + '收到喊停，任务 ' + ticketId + ' 已标记为失败。' + workerStatus)
      }
    })
    return outcomes
  }

  /** Rechecks each item with running or pending work, including work started by comments. */
  async checkClosures(repoCfg) {
    const { repo } = repoCfg
    const items = new Map()
    for (const { ticket, number, pr } of this.#liveSourceTickets(repo)) {
      if (!canTransition(normalizeStage(ticket.stage), 'failed')) continue
      if (!items.has(number)) items.set(number, { tickets: [], pr: false })
      const item = items.get(number)
      item.tickets.push(ticket.id)
      item.pr ||= pr
    }
    const terminated = []
    for (const [number, tracked] of items) {
      const item = JSON.parse(String(await this.#githubApi(['repos/' + repo + '/issues/' + number])))
      if (item.state !== 'closed') continue
      let why = '已关闭'
      if (item.pull_request || tracked.pr) {
        const pr = JSON.parse(String(await this.#githubApi(['repos/' + repo + '/pulls/' + number])))
        why = pr.merged_at ? '已合并' : '已关闭未合并'
      }
      terminated.push(...this.#writeFacts(() => this.#terminateTasks(tracked.tickets, repo, number, why)))
    }
    return { terminated }
  }

  #isOwnComment(repo, number, comment) {
    if (this.store.get(postedCommentKey(repo, comment.id))) return true
    const marker = REPLY_MARKER.exec(comment.body ?? '')?.[1]
    if (!marker) return false
    const outboxId = this.store.get(replyMarkerKey(marker))
    const attempt = outboxId && this.store.get(replyAttemptKey(outboxId))
    // The marker index only exists for a reply claimed from the recorded outbox.
    if (!attempt || attempt.repo !== repo.toLowerCase() || attempt.number !== number || !matchesReplyMarker(comment, attempt)) {
      return false
    }
    const receipt = this.store.get(replyReceiptKey(outboxId))
    if (receipt) return receipt.commentId === comment.id
    this.#saveReplyReceipt(repo, outboxId, comment)
    return true
  }

  #saveReplyReceipt(repo, outboxId, comment) {
    // A reload can close the sending source while GitHub is still completing the POST.
    const store = this.store.closed ? new Store(this.store.stateDir) : this.store
    try {
      const receipt = { repo, commentId: comment.id, url: comment.html_url ?? null }
      this.#writeFacts(() => {
        store.set(postedCommentKey(repo, comment.id), receipt)
        if (!store.get(replyReceiptKey(outboxId))) store.set(replyReceiptKey(outboxId), receipt)
      }, store)
    } finally {
      if (store !== this.store) store.close()
    }
  }

  async #findAttemptedReply(endpoint, attempt) {
    // Fetch only this item's comments. A failed page propagates and never permits a new POST.
    for await (const page of this.#commentPages(endpoint)) {
      const sent = page.find(comment => {
        const item = githubCommentItem(comment)
        return item?.repo === attempt.repo && item.number === attempt.number && matchesReplyMarker(comment, attempt)
      })
      if (sent) return sent
    }
    return null
  }

  async #postReply({ repo, number }, body, outboxId) {
    const receiptKey = replyReceiptKey(outboxId)
    if (this.store.get(receiptKey)) return
    const attemptKey = replyAttemptKey(outboxId)
    const endpoint = 'repos/' + repo + '/issues/' + number + '/comments'
    const repoKey = repo.toLowerCase()
    let attempt = this.store.get(attemptKey)
    if (attempt) {
      if (attempt.repo !== repoKey || attempt.number !== number) throw new Error('GitHub reply target changed after its first attempt')
      const sent = await this.#findAttemptedReply(endpoint, attempt)
      if (sent) {
        this.#saveReplyReceipt(repo, outboxId, sent)
        return
      }
      if (this.store.closed || this.store.get(receiptKey)) return
    }
    const login = (await this.#authenticatedLogin()).toLowerCase()
    if (attempt && attempt.login !== login) throw new Error('GitHub posting account changed after the first attempt')
    if (this.store.closed || this.store.get(receiptKey)) return
    if (!attempt) {
      const marker = randomUUID()
      attempt = { marker, repo: repoKey, number, login }
      this.#writeFacts(() => {
        this.store.set(attemptKey, attempt)
        this.store.set(replyMarkerKey(marker), outboxId)
      })
    }
    // The Router caps the visible body before this transport-only prefix is attached.
    const markedBody = '<!-- hub-bot-github-reply:' + attempt.marker + ' -->\n\n' + body
    const raw = await this.#githubApi(['-X', 'POST', endpoint, '-f', 'body=' + markedBody])
    const sent = JSON.parse(String(raw))
    if (!isPositiveInteger(sent?.id)) throw new Error('GitHub reply response is missing a comment ID')
    this.#saveReplyReceipt(repo, outboxId, sent)
  }

  /** Posts recorded reply intents and saves the returned comment identity before marking them sent. */
  async deliverReplies() {
    return deliverRecordedReplies({
      store: this.store, logger: this.logger, now: this.now,
      channel: 'github', prefix: 'github:', maxAttempts: MAX_GITHUB_ATTEMPTS,
      parseTarget: to => {
        const target = to.slice('github:'.length)
        const cut = target.lastIndexOf(':')
        const repo = target.slice(0, cut)
        const number = Number(target.slice(cut + 1))
        return repo && isPositiveInteger(number) ? { repo, number } : null
      },
      canContinue: () => !this.store.closed,
      prepareBody: body => body.includes('powered_by-dsh') ? body : body + '\n\n' + DSH_BADGE,
      send: (target, body, row) => this.#postReply(target, body, row.id),
    })
  }
}
