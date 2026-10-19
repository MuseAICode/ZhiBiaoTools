# CLAUDE.md

本文件约束在本仓库中工作的 AI 编码助手（包括 Claude Code）。项目架构、目录与验证规则另见 `AGENTS.md` 和 `client/开发说明.md`，三者同时有效；冲突时以本文件的流程规则为准。

## 分支规则

- 所有改动必须在新分支上进行，禁止直接提交或推送到 `main`。
- 开工前先确认当前分支不是 `main`；如果是，先创建新分支再修改。

## 改造路线图

- 每次会话开始先阅读 `docs/MIGRATION_PLAN.md`，确认当前进度。
- 每个 PR 完成后同步更新其中的进度表（状态和 PR 编号）。
- 如果实际做法偏离了路线图，在 PR 中说明原因，并在同一个 PR 中更新路线图。

## 命名规则

- 代码、文件名、文档、接口、全局对象、数据库表与字段、环境变量、npm 脚本等一律不得使用原产品名称（含中英文和缩写拼写），改用本项目名称“智标” / ZhiBiaoTools（`zhibiao`）或中性名称（例如 bridge 用 `window.appBridge`、`AppBridge` / `getBridge()`）。
- 禁用词清单只维护在 `scripts/check-banned-words.sh` 中，由 CI 的 `naming-check` 检查所有跟踪文件的内容和文件名（检查脚本自身除外），出现即失败；提交前可在仓库根目录运行 `bash scripts/check-banned-words.sh` 自查。

## PR 规则

- 每个 PR 只做一件事，保持小而可审；无关改动拆成独立 PR。
- 每次创建 PR 前必须完成下列审计，并把审计报告写进 PR 描述。
- 任何一项审计不通过，不得创建 PR：先修复，或向用户说明原因并等待决定。

### 审计报告

PR 描述必须包含以下五节：

a) **改动摘要**：改了哪些文件、为什么。

b) **安全检查**：逐项给出结论和依据：
   - 鉴权与权限
   - 用户间数据隔离
   - API Key 是否只在服务端（或 Main 进程）保存和使用，不进入 Renderer、日志或仓库
   - 文件上传校验（类型、大小、路径穿越）
   - SQL 注入、命令注入
   - XSS（尤其是 `MarkdownRenderer` 的 `allowRawHtml` 和远程/AI 内容）
   - 敏感信息是否写入日志或代码

c) **构建与类型检查**：在 `client/` 下运行 `npm run build`（含 `tsc --noEmit`），贴出结果；涉及 `.cjs` 时附 `node --check` 结果。

d) **依赖漏洞**：在 `client/` 下运行 `npm audit`，列出 high 和 critical 漏洞；没有则写明“无”。
   - 已接受风险：`client/` 中 `patch-package` → `find-yarn-workspace-root` → `micromatch` → `braces` 依赖链的 4 个 high（路线图 0.4，仅开发期 `postinstall` 使用）。只要仍是这 4 个、没有新增，审计报告中写“已知接受风险，无变化”即可，不需要再建议另开 PR；出现其他 high 或 critical 时照常列出。

e) **许可证合规**：本项目为闭源商业授权。新增第三方依赖须逐个列出名称、版本和许可证；出现 GPL、AGPL 等强传染性许可证时，在审计报告中单独标出，并暂停、等待用户确认后再继续。没有新增依赖时写明“无新增依赖”。
