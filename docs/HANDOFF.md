# Alias File Finder / Front Intelligence 项目交接

更新时间：2026-07-28（Asia/Shanghai）

## 交接范围

本文汇总当前 Codex 任务中可见的对话信息、仓库状态、已完成工作、设计决策和下一步建议，供另一台设备继续开发。

说明：本文只能覆盖当前任务上下文和仓库中可验证的信息；其他未出现在当前上下文中的历史对话无法凭空恢复。

## 仓库

- GitHub：<https://github.com/WangKeqing1/alias-file-finder>
- 默认分支：`master`
- 项目类型：VS Code 扩展
- 主要技术：TypeScript、VS Code Extension API、esbuild、pnpm、vscode-test、ESLint
- 当前版本：`0.0.1`
- 当前产品名仍是 `Alias File Finder`；开发分支正在推进 `Front Intelligence` 定位和配置体系。

## 当前对话中完成的工作

最初检查时，`master` 比 `origin/master` 领先 3 个提交，并有 10 个已修改文件。随后将这 10 个文件提交为：

```text
82062de fix(vscode): 优化 Vue 索引并修正样式跳转
```

该提交和此前 3 个本地提交均已推送到 `origin/master`。提交主要包括：

- 将 Vue 组件索引和 provide/inject 索引改为首次使用时才初始化。
- 将 provide/inject 文件变化处理改为单文件增量刷新，避免全量重建。
- 保存 Vue 文件时只清理该文件的解析缓存并更新对应索引。
- 默认关闭 `affLog`，仅在 `ALIAS_FILE_FINDER_DEBUG=1` 或 `true` 时输出。
- 将 Vue hover/completion Markdown 标记为不可信。
- 避免将 Sass `@include` 当作导入，并忽略 `sass:` 内置模块。
- 移除别名缓存的 5 秒 TTL，改由配置变更和显式操作清理。
- 补充相关回归测试。

完成后已验证：

- `master` 与 `origin/master` 指向同一提交 `82062de2d8dffbad3cff74952c06bfccc1d2ca85`。
- `master` 工作区干净。
- `git diff --check` 通过；仅出现 Windows 下 LF 将转换为 CRLF 的提示。
- 提交时没有本地 Git 钩子报错。

本次对话没有完整运行 `pnpm test`、`pnpm run check-types` 或 `pnpm run lint`，后续整合前应补跑。

## 已有设计与计划

以下文档已提交并位于 `master`：

- `docs/superpowers/specs/2026-06-10-front-intelligence-design.md`
- `docs/superpowers/plans/2026-06-10-front-intelligence-phase-0-1.md`

核心设计方向：

- 扩展定位从单一别名跳转逐步扩展为 `Front Intelligence`。
- 保留现有 `aliasFileFinder.aliases` 和 `alias-file-finder.clearCache` 兼容性。
- 引入统一的 `SettingsService`、`ProjectContext`、`AliasResolver`、`FileResolver`、`IndexManager` 和 `PerformanceScheduler`。
- 激活阶段禁止全工作区扫描，功能必须懒加载。
- 文件变化应单文件增量更新，不应全量重建索引。
- 提供 `lowPower`、`balanced`、`highPerformance` 三种性能模式。
- 后续阶段依次推进 Vue 能力重构、Sass mixin/function 语义跳转、BEM 辅助和产品化。

计划文档中的勾选框尚未随代码提交更新，不能仅凭勾选状态判断完成度；应以开发分支的 5 个提交和实际代码为准。

## 尚未合并的开发分支

本地存在独立 worktree 和分支：

```text
branch: codex/front-intelligence-phase-0-1
local worktree: .worktrees/front-intelligence-phase-0-1
head: 10131b8f93b6eb23ef391c1f9f9676b9afa26be7
```

该 worktree 当前干净。分支相对共同基点 `f2c268c` 有 5 个提交：

```text
dc4051b feat: add front intelligence settings service
c225b77 feat: add performance profile resolver
6d8255f feat: support front intelligence alias settings
b06cb47 feat: add front intelligence configuration surface
10131b8 docs: document front intelligence configuration
```

主要改动：

- 新增 `src/config/settingsService.ts`。
- 新增 `src/core/performanceScheduler.ts`。
- 扩展 `frontIntelligence.*` 配置项和命令。
- 重构别名配置合并、优先级、自动探测和兼容逻辑。
- 更新 `README.md` 和 `CHANGELOG.md`，说明 Front Intelligence 定位。
- 增加配置、别名解析和性能模式测试。

该分支相对当前 `master`：

- 分支独有 5 个提交。
- `master` 独有 1 个提交，即 `82062de`。
- 双方都修改了 `src/config/aliasResolver.ts`、`src/extension.ts` 和 `src/test/extension.test.ts`，rebase 或 merge 很可能产生冲突。

不要直接把其中一侧覆盖另一侧。整合时应同时保留：

- 开发分支的新配置体系、性能配置和兼容逻辑。
- `master` 中的懒加载、增量索引、Markdown 安全限制、Sass 内置模块过滤和新增回归测试。

## 推荐的另一设备接续流程

```powershell
git clone https://github.com/WangKeqing1/alias-file-finder.git
Set-Location alias-file-finder
git fetch origin
git switch codex/front-intelligence-phase-0-1
pnpm install
```

先在开发分支原始状态运行：

```powershell
pnpm run check-types
pnpm run lint
pnpm test
```

然后整合最新 `master`，推荐使用 rebase 以保持分支历史清晰：

```powershell
git rebase origin/master
```

重点检查冲突文件：

```text
src/config/aliasResolver.ts
src/extension.ts
src/test/extension.test.ts
```

解决冲突后再次运行：

```powershell
pnpm run check-types
pnpm run lint
pnpm test
pnpm run package
```

验证通过后再推送重写后的开发分支。若该远程分支只有本人使用，可使用：

```powershell
git push --force-with-lease origin codex/front-intelligence-phase-0-1
```

不要使用 `git push --force`。

## 后续开发优先级建议

1. 将 `codex/front-intelligence-phase-0-1` rebase 到最新 `master`，保留双方行为并解决测试冲突。
2. 运行完整类型检查、Lint、扩展测试和生产打包。
3. 核对 Phase 0/1 计划的实际完成项并更新计划勾选框。
4. 手工验证旧设置 `aliasFileFinder.aliases` 和旧命令仍兼容。
5. 手工验证新设置 `frontIntelligence.alias.*` 的优先级、自动探测、关闭开关和 fallback。
6. 验证扩展激活时不扫描工作区，首次 Vue 操作才创建 watcher/索引。
7. 验证 Vue 文件保存只更新当前文件索引。
8. 决定是以 PR 方式合并还是直接合并到 `master`；当前尚未创建 PR。
9. Phase 0/1 稳定后再推进共享 `ProjectContext` / `IndexManager`、Sass mixin/function 导航等后续阶段。

## Windows 环境约定

- 当前工作目录：`E:\alias-file-finder`
- 本地开发 worktree：`E:\alias-file-finder\.worktrees\front-intelligence-phase-0-1`
- 用户偏好的 Python：`C:\Users\Administrator\AppData\Local\Python\bin\python.exe`
- 项目命令优先使用 `pnpm`。
- `.gitignore` 已忽略 `out`、`dist`、`node_modules`、`.vscode-test/`、`*.vsix` 和 `.worktrees/`。
- `.vscode-test/` 与 `node_modules/` 中存在大量被忽略的生成文件，不属于待交接源码或文档。

## 当前已知边界

- 没有发现未提交的 Markdown、MDX、文本计划或交接文件。
- 除本文件外，原仓库没有独立的 `HANDOFF` 文档。
- 本次对话未修改或删除生成目录。
- 尚未合并 Front Intelligence 开发分支。
- 尚未创建 GitHub Pull Request。
