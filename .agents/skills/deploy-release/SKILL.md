---
name: deploy-release
description: 发布 dsh-hub-bot 插件新版本：升版本号、打包 tarball、打 tag、创建 GitHub release 并上传产物。用户要求发布、发版、release 时使用。
---

# deploy-release — dsh-hub-bot 发布流程

发布物：GitHub release（tag + `dsh-hub-bot-<version>.tgz` asset）。
消费方：DSH profile 以 release tarball URL 安装，或以 `github:Ghost233/GhostDSHHubBot#v<X.Y.Z>` git 挂载。

## 前置检查（全部通过才继续）

1. 工作区干净：`git status --short` 无输出；在 main 分支且与 origin/main 同步
2. 测试绿：`npm_config_cache=/tmp/npm-cache npm test` 全通过
3. gh 身份：`export GH_CONFIG_DIR="$HOME/.config/gh-profiles/Ghost233"`，`gh auth status` 为 Ghost233

## 步骤

1. **升版本**：`npm version <patch|minor|major> --no-git-tag-version`，提交 package.json（信息：`Bump version to X.Y.Z`），推 main
2. **打包**：`npm_config_cache=/tmp/npm-cache npm pack` 生成 tgz；先 `--dry-run` 核对文件清单（只含 src/ panel/ scripts/ README/package.json 等，无 stateDir 产物）
3. **打 tag**：`git tag vX.Y.Z && git push origin vX.Y.Z`
4. **发 release**：`gh release create vX.Y.Z dsh-hub-bot-X.Y.Z.tgz --repo Ghost233/GhostDSHHubBot --title "hub-bot vX.Y.Z" --notes "<变更摘要>"`
5. **核验**：`gh release view vX.Y.Z --json assets` 确认 asset 在；`tar tzf dsh-hub-bot-X.Y.Z.tgz | grep -c panel/` 确认面板入包（v0.1.0 漏 panel/ 导致面板 404 的教训）；`tar tzf ... | grep -c client/` 确认 client 半侧入包；新增依赖时还要在干净目录模拟 profile 安装后 `node --input-type=module -e 'import("dsh-hub-bot")'` 验证依赖闭包——**peer 依赖不会被 pnpm 自动装进 profile**（v0.1.4 漏 cordis 直接依赖、装上即无法加载的教训）
6. **client 半侧改动的额外核验**（v0.1.5 设置页不出现的教训）：dev 实例重启后必须过浏览器实证，不能只看 API——① console 无 `pending (waiting for services: ...)`：client.js 的 `exports.inject` 只写 **cordis 服务 key**（slots/locale/remote），包名永远等不到；② `ctx.remote.<自有 namespace>` 可用：**自有 Remote 命名空间必须客户端 `$mount`**（dsh-api-remotes 只预挂官方静态清单），codec 要过三道校验（mode 'strict' + 非空 typeSymbol + create() 工厂，v0.1.6 曾漏 typeSymbol 崩在 validateCodec）；③ 配置按钮出现、表单渲染真实值、保存后 overlay 落盘三点齐全才算完——「真实值」必须用一个**已知非默认值**对照（如 overlay 里已配的 chief.model），防止 fallback 默认值蒙混过关（v0.1.6 实证时 remote 返回其实一直带 {ok,value} envelope，表单全靠默认值裸奔，直到 v0.2.0 面板合并用 24 项模型目录才暴露——手写 contribution 需在客户端对结果做防御性拆包）。

7. **按钮必须点到底**（v0.12.0 retryOutbox 静默失效的教训）：渲染出来 ≠ 能用。任何按钮/交互必须真实点击并验证副作用落库（DB 状态变化），不能只看 UI 无报错。Remote 方法**带参数调用时**，客户端贡献描述符必须声明 `parameters: [{ name, source: 'json', codec, strictCodec }]`——零参声明的方法带参调用会被网关静默吞掉（按钮渲染正常、点击无报错无响应无异常，只有 host 侧探针日志能定位）。
8. **清理**：删本地 tgz（不提交）

## 失败处理

- asset 上传报 DNS/网络错（uploads.github.com）：release 对象可能未留下，重跑 create
- release 已存在缺 asset：`gh release upload vX.Y.Z <tgz>` 补传
- 发错版本：gh release delete + 删 tag 重发
- 发版脚本遇到工具异常/疑似没跑：**先 `job_list` 确认后台任务再重试**——v0.34.0 曾并发双跑产生重复提交对、版本号误标 0.35.0，事后变基清理 + 强推才收拾干净。重跑前还要核对 feat 提交真的含功能文件（v0.34.0 恢复教训：重复对里只有一对带 client.js，删错对会把功能删没）
- git push 403（钥匙串身份不是 Ghost233）：用一次性凭据 `git -c credential.helper='!f() { echo username=Ghost233; echo password=$(GH_CONFIG_DIR=... gh auth token); }; f' push`

## 铁律

- 版本号只升不降；package.json 版本、tag、release、tarball 文件名四处一致
- 只从 main 最新提交发布，不从 worktree/分支发布
