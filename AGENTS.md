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
- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer`，只通过 `window.appBridge`；改 preload API 时同步 `client/src/shared/types/ipc.ts`。
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
- 配置存到 Electron `userData/user_config.json`；业务工作区存到 `userData/workspace/`；结构化业务状态的权威存储是 `userData/workspace/app.sqlite`。运行时 schema/migration 以 `electron/services/sqliteDatabase.cjs` 为准，改表时同步根目录 `sql/workspace_schema.sql`；技术方案旧 `technical_plan.json` 仅是启动清理对象，不得继续读写。
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
- 测试放 `server/tests/`。开发用 `docker-compose.yml` 在仓库根目录，首次运行前先执行 `server/scripts/init-dev-secrets.sh` 生成数据库密码等密钥。Redis 是 Valkey 8，ACL 规则只在 `server/redis/start-valkey.sh` 中维护（compose 与 CI 共用），连接经 `src/redis.ts`，本机跑 `tests/db/redis.test.ts` 需要 `TEST_REDIS_URL=redis://bidtools@127.0.0.1:6379` 和 `TEST_REDIS_PASSWORD`。
- 数据库：PostgreSQL 17 + Kysely。迁移放 `src/db/migrations/`，在 `migrations/index.ts` 登记，必须有 `down`，已合并的迁移不再修改；`npm run db:migrate` / `npm run db:rollback` 用属主角色执行。新增业务表必须带 `org_id`，并在同一迁移中 `ENABLE` + `FORCE ROW LEVEL SECURITY`、建策略、只给 `bidtools_app` 授权。访问业务数据一律经 `withTenant()`（`src/db/tenant.ts`）。项目级表（第 5 步起）照 `tests/db/fixtures/exampleProjectTable.ts` 写迁移：`org_id`、`project_id` 都不可空，`(org_id, project_id)` 复合外键指向 `projects (org_id, id)`，时间用 `timestamptz`、JSON 用 `jsonb`；每张新表在测试中调用一次 `tests/db/projectTable.ts` 的 `describeProjectTable`。带 `projectId` 的接口先经 `requireProject()`（`src/projects/access.ts`）校验组织和 `kind`，不符一律 404。所属项目已删除的文件、所属项目已删除或来源文件不可访问的产物由 RLS 隐藏（迁移 0008），不要在应用代码中重复判断，也不要为了读取它们放宽策略；需要统计或清理这些行时，照配额函数的做法用专门的 `NOLOGIN` 属主角色写 `SECURITY DEFINER` 函数，并在 `describeProjectTable` 的 `definerRoles` 中声明。生成产物（解析出的 Markdown、图片）经 `src/artifacts/store.ts` 的 `writeArtifact` 写入，只允许迁移 0008 登记的种类和 MIME。导出模板（迁移 0010）中 `org_id` 为空的是系统模板，应用角色只读，只由 `npm run db:migrate` 在迁移到最新后按 `src/templates/systemTemplates.ts` 同步；改系统模板的样式时同步改桌面版 `client/electron/services/systemExportTemplates.cjs`（`tests/templates/systemTemplates.test.ts` 核对二者一致），不要为写系统模板放宽应用角色的策略。资信库（迁移 0011）的图片只以 `file_id` 引用 `credential-image` 文件，所引用的文件已删除时图片由 RLS 隐藏；应用角色没有图片的 DELETE 授权，删除图片就是软删除文件（`src/credentialLibrary/store.ts`），不要为此授予 DELETE 或在应用代码中重复判断文件状态。知识库（迁移 0012）的文档同样只以 `file_id` 引用 `knowledge` 文件，原件已删除时文档和步骤由 RLS 隐藏，删除文档就是软删除原件（`src/knowledgeBase/store.ts`）；`markdown_artifact_id` 只能指向本文档原件的 Markdown 产物，由 UPDATE 策略检查。知识库的切块、候选条目、最终条目、来源块、舍弃块组、报告、匹配批次（迁移 0013）随文档可见（策略以文档在应用角色下可见为条件），经 `src/knowledgeBase/content.ts` 整体替换；除匹配批次外不授予 UPDATE，不要为改单行而授予，也不要在应用代码中重复判断原件状态。标书查重（迁移 0014）的十三张表挂在 `kind = 'duplicate-check'` 的项目下，项目已删除时由 RLS 隐藏；选中的文件只以 `file_id` 引用已挂到本项目的 `duplicate-check` 文件，原件已删除时文件行和引用它的分析结果由 RLS 隐藏，从选择中去掉或清空时软删除原件（`src/duplicateCheck/store.ts`）；分析结果只经 `saveAnalysisSection` 整体替换（不授予 UPDATE），不开放为接口。导出 Excel 用 `src/xlsx/writer.ts`（无第三方依赖，文本一律写成内联字符串，以 `= + - @`、制表符、回车开头的另加 `quotePrefix`），不要为此引入 SheetJS。`files.project_id` 只能从空设为某个项目，设置后不能再改（迁移 0015 的触发器，`FS005`），挂文件的模块不要再在应用代码中重复这条判断。废标检查（迁移 0016）的七张表挂在 `kind = 'rejection-check'` 的项目下，项目已删除时由 RLS 隐藏；文档只以 `file_id` 引用已挂到本项目的 `tender` 文件，原件已删除时文档和引用它的问题由 RLS 隐藏；应用角色没有文档的 DELETE 授权，移除文档就是软删除原件（`src/rejectionCheck/store.ts`），软删除前先删结果（之后问题不可见、删不到）；问题只经 `saveCheckResult` 整体替换或由用户删除单条（不授予 UPDATE）；签名由服务端按文档 id 与正文哈希现算（`computeSignatures`），不要接收客户端传来的签名。技术方案（迁移 0018）的六张表挂在 `kind = 'technical-plan'` 的项目下，招标文件与原方案（`technical_plan_documents`）只以 `file_id` 引用已挂到本项目的 `tender` 文件，原件已删除时文档由 RLS 隐藏，移除就是软删除原件（`src/technicalPlan/store.ts`）；生成配置的 `export_template_id` 是指向 `export_templates (id)` 的单列外键，只能引用本组织的模板或系统模板由策略强制，不要改成在应用代码中判断；合并的招标正文和投标范围的工作副本不保存，由 `readTenderMarkdown` 按各文件的 Markdown 现算；导入 / 移除招标文件、切换单 / 多标段、选择投标范围的下游清空集中在 `clearDownstreamFromTender` / `clearDownstreamFromBidSectionChange`，后续加入目录、全局事实、正文的表时一并扩展这两个函数。技术方案的目录与全局事实（迁移 0019）同样挂在技术方案项目下、由 RLS 隐藏；目录节点 id 是稳定 UUID（不能改），父子关系与同级顺序存在 `parent_node_id` / `sort_order`，编号读取时现算，不要存编号或从 id 推算；保存目录只经 `saveOutline` 的 `reason` 协议（`src/technicalPlan/store.ts`，纯函数在 `src/technicalPlan/outline.ts`），`sort` / `edit` 要求节点与已保存的一致，正文的保留与清空规则不要在路由或前端复制；全局事实整体替换（不授予 UPDATE），保存时清空正文阶段。技术方案的正文生成状态与编排（迁移 0020）以复合外键挂在同一项目的目录节点上、随节点删除，由 RLS 随项目隐藏；手工保存正文、重置正文阶段、目录保存时的保留与清空和运行进度（`technical_plan_meta.content_generation_runtime`）的保留规则只在 `src/technicalPlan/store.ts` / `content.ts` 中实现，不要在路由或前端复制。废标检查从技术方案读取招标文件（`src/rejectionCheck/fromTechnicalPlan.ts`）复制原件与 Markdown 产物到废标检查项目，不要为此放宽 `files.project_id` 的触发器或文档的策略。
- 鉴权（第 3 节）：路由默认需要登录，公开路由声明 `config: { access: 'public' }`；改变状态的请求要过全局跨站校验（`Origin` = `PUBLIC_ORIGIN`、`X-Requested-With: app`、JSON）。登录前的查询只能经 `0002_auth` 中的 `SECURITY DEFINER` 函数（属主 `bidtools_auth`，固定 `search_path`、精确匹配、最多一行、只授权给 `bidtools_app`），不要为此放宽 RLS 策略；新增此类函数要写证明不能列举、不能越权的测试。应用角色对 `users` 只有列级写权限，平台管理员只能用 `npm run admin:create` 创建。令牌只存 SHA-256，链接中的令牌放在 `#` 之后；邮件经 `src/mail/mailer.ts`，非开发环境不得把令牌写进日志。客户端 IP 一律用 `request.ip`（只采信 `TRUSTED_PROXIES` 中代理附加的 `X-Forwarded-For`），不要自己解析 `X-Forwarded-*` 头。
- AI 网关（`src/ai/`，设计第 4、10 节）：所有模型调用都经 `createAiGateway().chat()`，调用前冻结、调用后结算或释放（`src/billing/usage.ts`），不要绕过它直接请求服务商或直接扣费。平台 Key 只在 `src/ai/gateway.ts` 中解密，不导出解密函数、不缓存明文、不把服务商的错误正文写进日志或响应；价格只来自 `model_prices`，不在代码中写单价。能否调用由平台模型白名单（`platform_models`，迁移 0005，`src/ai/models.ts`）决定：未登记、已停用、未定价的模型一律拒绝，零价格不等于免费，免费必须由管理员登记时显式标记 `is_free`。测试用 `tests/ai/mockProvider.ts` 模拟服务商，不使用真实 Key。
- 任务队列（`src/jobs/`，设计第 5 节，迁移 0021）：`jobs` 是任务状态的唯一权威，BullMQ（Redis 不持久化）只派发，任务 id 即 `jobs.id`。入队经 `enqueueJob`（先写库后放队列），任务类型登记在 `src/jobs/registry.ts`，参数只放 id；worker（`src/worker.ts`）认领后的写入都带 `run_id`，对账负责 Redis 重启或清空后的恢复，不要改成依赖 BullMQ 保存的状态或 stalled 检测。任务的业务读写经 `withTenant(context.db, context.tenant, ...)` 和第 5 步的 Store 函数，长任务在步骤之间调用 `saveCheckpoint` / `setProgress` 并响应 `signal`。`withOrgContext()` 只给 worker 的系统操作用。跨组织对账函数属主为 `bidtools_jobs`。本机跑 `tests/db/jobQueue.test.ts` 需要 Redis 的两个变量，真实重启的用例另需 `TEST_REDIS_RESTART_COMMAND`。
- 实时推送（`src/events/`、`GET /api/events`，设计第 5.5 节）：事件经 `createEventPublisher().publish()` 在事务提交之后发布（尽力而为，失败只写日志），不要在事务内发布，也不要把推送当成状态的权威；任务事件经 `src/jobs/notify.ts`，改变任务状态的新代码路径要调用 notifier。事件不放参数、checkpoint、文档正文和 AI 输入输出；只推给某个用户的事件设置 `userId`。本机跑 `tests/db/events.test.ts` 同样需要 Redis 的两个变量。
- 解析沙箱（`src/sandbox/`、`src/sandbox-runner.ts`，设计第 7.5 节）：上传的文件只在 sandbox-runner 按模板创建的断网沙箱中解析，worker 和 api 进程内不运行任何文档解析器；模板只在 `src/sandbox/templates.ts` 中维护，不要让调用方传镜像、挂载、网络或任意命令，也不要放宽 `--network none`、只读根文件系统和权限参数；取回的文件一律经 `src/sandbox/archive.ts` 校验，不要绕过。只有 sandbox-runner 挂载 Docker socket。镜像在 `server/sandbox/parse/`。改了沙箱跑 `npm run test:sandbox`（需要 Docker 和 `TEST_SANDBOX_IMAGE`，见 `tests/sandbox/docker/env.ts`；CI 在 gVisor 下运行）。文档解析任务（`src/parse/`，6.6）：导入后经 `enqueueDocumentParses` 入队，任务只取原件、经 `context.sandbox` 在沙箱中执行 `server/sandbox/parse/entry.mjs`、经 `src/parse/output.ts` 校验结果，给用户的失败原因按错误代码决定，不要采用沙箱输出的文字；沙箱在 `finally` 中销毁。解析入口的 npm 依赖只在 `server/sandbox/parse/package.json`（改后在该目录跑 `npm audit`），不要加进 `server/package.json`。重新解析后旧产物经 `supersedeArtifacts` 标为已被替换（迁移 0023），不要为此删除产物或放宽 `artifacts` 的守卫。
- 改了 `src/db/` 或迁移，跑 `npm run test:db`（需要 `TEST_DATABASE_ADMIN_URL` 指向一个超级用户连接，例如本机 Docker 起的 PostgreSQL）。

## 聚焦验证
- 改 Renderer/TypeScript：`cd client; npm run build`。
- 改 Electron Main/preload：先在 `client/` 下运行 `node --check electron\preload.cjs` 或对应 `.cjs` 文件，再跑 `npm run build`；涉及窗口/IPC 还要 `npm run dev` 手动打开验证。
- 改 SQLite Store、migration 或 native 模块：增加 `npm run smoke:electron-native`；有对应 `*.test.cjs` 时用 `node --test <test-file>` 定向执行。
- 改有单元测试覆盖的代码，或新增纯逻辑：`cd client; npm run test`。测试放 `client/tests/`（`tests/src/` 对应 Renderer，`tests/electron/` 对应 Main），不放进 `src/` 或 `electron/`，避免进入构建产物和安装包；`.cjs` 在测试中用 `createRequire` 加载，需要 DOM 的测试在文件头声明 `// @vitest-environment jsdom`。
- 改依赖：`cd client; npm audit`。
- 改 `openxmlhelper/`（C#）：`cd openxmlhelper; dotnet test tests/OpenXmlHelper.Tests/OpenXmlHelper.Tests.csproj`（需要 .NET 10 SDK）。测试放 `openxmlhelper/tests/OpenXmlHelper.Tests/`，按 Main 的约定写 `request.json`、经 `JobRunner` 执行；改了助手或测试项目的 NuGet 依赖要更新测试项目的 `packages.lock.json`（CI 以 locked mode 还原）。
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
