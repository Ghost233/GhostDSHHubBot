/**
 * 负责人会话的 GUI 工作区 (#52)。
 *
 * 机制结论（2026-11-17 dev 实机探明）：
 * - GUI 分组按工作区对象的显式 sessionIds 清单；未登记会话全落「未分组」。
 * - insertSessionBefore 只排序已登记会话；attachSession 要求会话 cwd 严格等于工作区 path，
 *   且未作为 RPC 暴露——**已创建的会话没有任何办法加入工作区**（连 GUI 拖拽都不行：
 *   draggable 以 workspace/insertSessionBefore 权限为前提，未登记会话拿不到）。
 * - 唯一路径：sessionController.create({ workspaceId }) —— 出生即归位，cwd 自动 = 工作区 path。
 *
 * 因此本模块的职责是「为会话创建提供 workspaceId」：
 * - L1 chief → 专属工作区（path = homeRepo/.hub-bot/chief，标题「Hub Bot 中枢」）——
 *   必须在 homeRepo 树内：AGENTS.md 发现以 .git 为项目根标记向上查找，树外会失去仓库指令。
 * - L2 owner → 对应仓库工作区（path = owner.cwd，create 幂等复用用户已有工作区）。
 *
 * 降级铁律：workspaceController 不存在（旧版 DSH）或任何调用失败 → 返回 null，
 * 调用方回退到 cwd 创建（现状行为）——工作区是展示层增强，绝不阻塞注入主链路。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** chief 专属工作区的固定标题（用户可在 GUI 自行改名——只在新建时命名，此后尊重用户选择）。 */
export const CHIEF_WORKSPACE_TITLE = 'Hub Bot 中枢'

/** chief 专属工作区在 homeRepo 内的相对位置。 */
export const CHIEF_WORKSPACE_DIR = '.hub-bot/chief'

export class WorkspacePlacer {
  /**
   * @param {object} deps
   * @param {object|null|undefined} deps.workspaceController - ctx.get('workspaceController')；undefined 时全部返回 null。
   * @param {string} deps.homeRepo - Home Repo 绝对路径（chief 工作区落它的子目录）。
   * @param {{ warn: (...args: any[]) => void }} deps.logger
   * @param {(path: string) => void} [deps.mkdir] - 测试替身；默认 mkdirSync recursive。
   */
  constructor({ workspaceController, homeRepo, logger, mkdir }) {
    this.ws = workspaceController ?? null
    this.homeRepo = homeRepo
    this.logger = logger
    this.mkdir = mkdir ?? (p => mkdirSync(p, { recursive: true }))
  }

  get available() { return this.ws != null }

  /** chief 专属工作区：返回 { workspaceId, path }；不可用/失败 → null（调用方回退 cwd 创建）。 */
  async chiefWorkspace() {
    if (!this.available) return null
    const path = join(this.homeRepo, CHIEF_WORKSPACE_DIR)
    try { this.mkdir(path) } catch (error) {
      this.logger.warn('hub-bot workspace: chief workspace dir mkdir failed: %s', error instanceof Error ? error.message : error)
      return null
    }
    return await this.#ensure(path, CHIEF_WORKSPACE_TITLE)
  }

  /** owner 仓库工作区（path = owner.cwd）；transient/scratch 与失败 → null。 */
  async ownerWorkspace(owner) {
    if (!this.available) return null
    if (!owner?.cwd || owner.transient || owner.kind === 'scratch') return null
    return await this.#ensure(owner.cwd, owner.workspace ?? null)
  }

  /** create 幂等（DSH 侧 resolveByPath 内存查找，便宜——不做 kv 缓存，缓存会屏蔽 rename 修正路径）。 */
  async #ensure(path, title) {
    try {
      const { workspace, created } = await this.ws.create({ path })
      // 命名策略：新建时命名；已存在但标题仍是 DSH 默认（path 的 basename = 从未被命名过，
      // 例如上次 rename 因冲突失败）也补命名；用户改过名（≠ basename）则尊重用户选择。
      const defaultTitle = path.replace(/\/+$/, '').split('/').pop()
      if (title && workspace.title !== title && (created || workspace.title === defaultTitle)) {
        await this.#tryRename(workspace.workspaceId, title)
      }
      return { workspaceId: workspace.workspaceId, path }
    } catch (error) {
      this.logger.warn('hub-bot workspace: ensure %s failed (non-fatal): %s', path, error instanceof Error ? error.message : error)
      return null
    }
  }

  /** 标题冲突（用户已有同名工作区）时放弃命名——挂上比叫什么重要。 */
  async #tryRename(workspaceId, title) {
    try { await this.ws.rename({ workspaceId, title }) } catch (error) {
      this.logger.warn('hub-bot workspace: rename to %s skipped: %s', title, error instanceof Error ? error.message : error)
    }
  }
}
