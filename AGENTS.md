# AGENTS.md

## 范围
- 当前有效产品代码在 `client/`。
- 原作者的 `analytics/`（Cloudflare Worker 与 Dashboard）已删除，客户端不包含埋点和公告、更新日志、资源页、模型信息等内容服务；不自建，也不要重新引入。外部服务现状见 `docs/EXTERNAL_SERVICES.md`。

## Client
- 开发 `client/` 前以及初次对话时，必须先完整阅读 `client/开发说明.md`，保持框架风格一致性。
- 没有 root `package.json`；客户端命令都先 `cd client`。
- 安装/验证：`npm ci` 后 `npm run build`。`npm run build` 等价 `tsc --noEmit && vite build`；`npm run test` 运行 Vitest 单元测试。仓库未配置统一 lint 脚本。
- 开发启动：`npm run dev`，固定 Vite `127.0.0.1:5173 --strictPort` 后再启动 Electron。
- 打包：`npm run dist:win` / `npm run dist:mac`，配置在 `client/package.json` 的 `build` 字段，产物在 `client/release/`。
- Electron Main 和 preload 是 CommonJS：`client/electron/**/*.cjs`；Renderer 是 ESM TypeScript：`client/src/**/*.ts(x)`。
- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer`，只通过 `window.yibiao`；改 preload API 时同步 `client/src/shared/types/ipc.ts`。
- 新业务 IPC 默认只注册/转发，业务逻辑放 `electron/services/*.cjs`；数据库生命周期装配和现有插件编排是例外，不作为普通功能模板。
- Main 侧文件读写显式使用 UTF-8，并把 Windows 中文路径当默认场景处理。

## Client 架构
- 主窗口 Renderer 入口：`client/src/main.tsx` -> `AppProviders` -> `WorkspaceDatabaseGate` -> `App` -> `AppShell` / `src/app/AppRouter.tsx`；开发者独立窗口由 `main.tsx` 的 `?window=...` 分支挂载。
- 新增菜单页面要同步 `src/shared/types/navigation.ts`、`src/app/menuConfig.ts`、`src/app/AppRouter.tsx`、`src/components/Sidebar.tsx` 的图标映射；页面操作条按需复用 `FloatingToolbar`。
- 功能代码放 `src/features/<feature>/`；跨功能运行时代码放 `src/shared/`，且不引用 feature。现有 bridge/type barrel 组合 feature 类型是边界例外，不扩展成组件或服务依赖。
- Renderer 可复用 Prompt 放 `src/shared/prompts/`，feature 或 Main 后台任务专用 Prompt 与对应 service/task 放在一起；不要在产品组件内硬编码大段 Prompt。
- UI 使用全局 CSS + Radix 基础组件，不使用 Tailwind；用户可见文案用中文。
- 成功、失败和普通提示走 `shared/ui/ToastProvider` 的 `success` / `error` / `info`，不要用 `alert`；确认或长文案使用 `AppDialog`。
- 页面根容器保持 `height: 100%`/`min-height: 0`，长内容在页面内部滚动；不要依赖 `body` 全局滚动或为 `FloatingToolbar` 额外留大空白。

## 数据与流程
- 配置存到 Electron `userData/user_config.json`；业务工作区存到 `userData/workspace/`；结构化业务状态的权威存储是 `userData/workspace/yibiao.sqlite`。运行时 schema/migration 以 `electron/services/sqliteDatabase.cjs` 为准，改表时同步根目录 `sql/workspace_schema.sql`；技术方案旧 `technical_plan.json` 仅是启动清理对象，不得继续读写。
- Renderer 只用 `localStorage` 存轻量 UI 偏好；草稿、API Key、流程状态以及业务正文都走 Main 侧存储/IPC。
- 技术方案除文件导入/展示外，标书分析、目录、全局事实和正文等耗时流程都在 Electron Main 后台任务中运行，并持续写入对应 SQLite Store；页面卸载不应取消任务。
- 技术方案目录与正文以 `technical_plan_outline_nodes`（Renderer 对应 `outlineData.outline[*].content`）为权威。`saveOutline()` 的 `reason` 是持久化协议：`replace` 清空全部旧正文，`edit` / `delete` / `add-*` 只使受影响节点失效，`sort` 只改变顺序和显示编号，保持节点 ID、正文文件名和相关状态不变；不要在 Renderer 复制清理规则。
- 技术方案节点 `id` 是程序分配的稳定 UUID；`number` 按目录树顺序计算，仅供展示和章节编号。数据库以 `node_id` 关联、`parent_node_id` 表示父子关系、`sort_order` 表示同级顺序；不得从 ID 推算编号、层级或顺序。
- Mermaid 只用于技术方案正文生成：Agent 生成源码后，由 Main 的 `localImageRenderService.cjs` 立即在本地转成图片，正文以 figure 引用。Markdown 中的 `mermaid` 代码块不再预览或转图，按普通代码块处理。
- `MarkdownRenderer` 默认禁用原始 HTML，调用方仍应显式传值：AI、Agent、远程下发等非本地可信内容传 `allowRawHtml={false}`，只有明确需要保留本地解析 HTML 时才开启。不论是否开启，渲染都只保留白名单内的标签、属性和 URL 协议，不要为了显示效果放宽白名单。
- `config:load` 返回给 Renderer 的 API Key、MinerU Token 一律为空字符串，只附 `credential_status`（是否已配置、末尾几位）；保存时空值表示不修改，删除用 `credential_clear`。打码在 IPC 层（`services/configSecrets.cjs`）完成，新增接收配置的 IPC 时同样要还原或打码，Renderer 不得重新拿到明文凭据。

## Server
- Web 版服务端在 `server/`（第 2 步起，设计见 `docs/SERVER_DESIGN.md`），独立的 `package.json`，命令都先 `cd server`；要求 Node 24（`engine-strict`）。
- 安装/验证：`npm ci` 后 `npm run typecheck`、`npm run test`；`npm run build` 编译到 `dist/`；`npm run dev` 用 Node 原生类型擦除直接运行 `src/server.ts`。
- 相对导入写 `.ts` 扩展名；不用 `enum`、参数属性等需要转译的语法（`erasableSyntaxOnly`）。
- 依赖写死版本（`save-exact`），新增或升级时选发布超过两周的版本；改依赖后在 `server/` 下跑 `npm audit`。
- 配置只从环境变量读取，统一在 `src/config.ts` 声明和校验，错误信息不得回显变量值；接口错误经 `src/errors.ts` 统一返回，需要给用户看的文案用 `AppError`，其他错误不得把内部消息返回给客户端。
- 测试放 `server/tests/`。开发用 `docker-compose.yml` 在仓库根目录，首次运行前先执行 `server/scripts/init-dev-secrets.sh` 生成数据库密码。
- 数据库：PostgreSQL 17 + Kysely。迁移放 `src/db/migrations/`，在 `migrations/index.ts` 登记，必须有 `down`，已合并的迁移不再修改；`npm run db:migrate` / `npm run db:rollback` 用属主角色执行。新增业务表必须带 `org_id`，并在同一迁移中 `ENABLE` + `FORCE ROW LEVEL SECURITY`、建策略、只给 `bidtools_app` 授权。访问业务数据一律经 `withTenant()`（`src/db/tenant.ts`）。
- 鉴权（第 3 节）：路由默认需要登录，公开路由声明 `config: { access: 'public' }`；改变状态的请求要过全局跨站校验（`Origin` = `PUBLIC_ORIGIN`、`X-Requested-With: app`、JSON）。登录前的查询只能经 `0002_auth` 中的 `SECURITY DEFINER` 函数（属主 `bidtools_auth`，固定 `search_path`、精确匹配、最多一行、只授权给 `bidtools_app`），不要为此放宽 RLS 策略；新增此类函数要写证明不能列举、不能越权的测试。应用角色对 `users` 只有列级写权限，平台管理员只能用 `npm run admin:create` 创建。令牌只存 SHA-256，链接中的令牌放在 `#` 之后；邮件经 `src/mail/mailer.ts`，非开发环境不得把令牌写进日志。客户端 IP 一律用 `request.ip`（只采信 `TRUSTED_PROXIES` 中代理附加的 `X-Forwarded-For`），不要自己解析 `X-Forwarded-*` 头。
- AI 网关（`src/ai/`，设计第 4、10 节）：所有模型调用都经 `createAiGateway().chat()`，调用前冻结、调用后结算或释放（`src/billing/usage.ts`），不要绕过它直接请求服务商或直接扣费。平台 Key 只在 `src/ai/gateway.ts` 中解密，不导出解密函数、不缓存明文、不把服务商的错误正文写进日志或响应；价格只来自 `model_prices`，不在代码中写单价。能否调用由平台模型白名单（`platform_models`，迁移 0005，`src/ai/models.ts`）决定：未登记、已停用、未定价的模型一律拒绝，零价格不等于免费，免费必须由管理员登记时显式标记 `is_free`。测试用 `tests/ai/mockProvider.ts` 模拟服务商，不使用真实 Key。
- 改了 `src/db/` 或迁移，跑 `npm run test:db`（需要 `TEST_DATABASE_ADMIN_URL` 指向一个超级用户连接，例如本机 Docker 起的 PostgreSQL）。

## 聚焦验证
- 改 Renderer/TypeScript：`cd client; npm run build`。
- 改 Electron Main/preload：先在 `client/` 下运行 `node --check electron\preload.cjs` 或对应 `.cjs` 文件，再跑 `npm run build`；涉及窗口/IPC 还要 `npm run dev` 手动打开验证。
- 改 SQLite Store、migration 或 native 模块：增加 `npm run smoke:electron-native`；有对应 `*.test.cjs` 时用 `node --test <test-file>` 定向执行。
- 改有单元测试覆盖的代码，或新增纯逻辑：`cd client; npm run test`。测试放 `client/tests/`（`tests/src/` 对应 Renderer，`tests/electron/` 对应 Main），不放进 `src/` 或 `electron/`，避免进入构建产物和安装包；`.cjs` 在测试中用 `createRequire` 加载，需要 DOM 的测试在文件头声明 `// @vitest-environment jsdom`。
- 改依赖：`cd client; npm audit`。
- `npm run build` 可能只有既有 chunk 体积警告；不要把它当失败，除非命令退出非 0。

## 发布
- 本仓库目前没有发布流程，`.github/workflows/` 只有只读的 `ci.yml`。自有发布流程建立前，不对外分发安装包；分发前先完成 `docs/EXTERNAL_SERVICES.md` §4 的 P0 项。
- 客户端自动更新源只由随包的 `client/electron/resources/update-feed.json` 决定，默认为空（不检查、不下载）。接入自有更新服务器时，先在 `updateService.cjs` 的 `verifyReleaseSignature` 实现更新清单验签和安装包哈希校验（含 electron-updater 路径），再填写 https 地址和公钥；不得重新指向原作者的 GitHub、AtomGit 或 Cloudflare 渠道。
- 使用文档的地址只由随包的 `client/electron/resources/remote-services.json` 决定（Renderer 经 `src/shared/remoteServices.ts` 在构建时读入），默认为空：为空时不发任何请求，对应入口隐藏。不得在代码中写死服务地址，也不得指向原作者的 `agnet.top` 服务。

## 必须遵守的原则
- 尽量保持整体编码风格统一；前端组件和样式优先封装、复用现有实现。
- 当用户提出功能异常时，不要猜原因；先真实排查代码和复现链路，按需增加诊断日志，精准定位后再修复。
- 本机产生的数据在 Electron Renderer、preload、Main 和内部 IPC 之间流转时，不在层级间重复堆叠参数校验，只在用户输入层校验。
- 远程下发的内容一律视为不可信，包括插件、更新包，以及 AI / Agent 返回的文本：渲染时禁用原始 HTML（`MarkdownRenderer` 传 `allowRawHtml={false}`），下载的代码和安装包执行前必须验签或校验哈希，解析结果按不可信输入校验。Web 化之后，Renderer 与服务端之间同样按不可信边界处理。
- 严格遵守用户命令。额外想法只在 Plan 阶段提出；进入 Build 阶段后仅执行确认方案，如需增加范围必须先向用户确认。
