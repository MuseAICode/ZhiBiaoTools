# Web 版服务端设计

本文是 `client/` Web 化之后服务端的设计稿，对应路线图 `docs/MIGRATION_PLAN.md` 第 2~9 步。路线图回答“按什么顺序改”，本文回答“改成什么样”。本文只是设计，不包含代码；各步骤实施时以本文为起点，偏离时在对应 PR 中说明，并同步修改本文。

第 9 节列出的 18 项决定事项已在 旧仓库 PR #26 中决定，结果见第 9 节“决定”列和路线图“第 2 步说明”。按决定新增第 10 节“AI 用量计量与计费”和第 11 节“合规待确认事项”。

基线：`main` 的 `337c622`（旧仓库 PR #24 合并后）。下文提到的现有代码均以此为准。

**旧仓库 PR #26 决定后的主要变化**（正文已同步修改）：

- **平台统一提供 AI 并按量计费**（第 7 项）：模型服务的 Key 由平台持有，用户不再填写 API Key 和 Base URL；第 4 节改为平台凭据的加密存储，新增第 10 节计量与计费；
- **部署在境外（优先香港），面向中国大陆用户**（第 13 项）；KMS 和对象存储选同一云厂商（第 8、14 项）；
- **登录**：支持邮箱密码和手机短信验证码两种，第一版只实现邮箱密码，数据模型预留手机号（第 4 项）；
- 发信服务待选，列入 `docs/EXTERNAL_SERVICES.md` §7（第 6 项）；
- 在线支付、发票、短信登录列为**第二版**，依赖境内主体；
- 个人信息出境、生成式 AI 监管、模型服务商条款列为**上线前必须完成**的合规确认（第 11 节）。

## 0. 设计前提

1. **信任边界改变。**桌面版按“本机可信、层间不重复校验”设计（`AGENTS.md`）。Web 版中浏览器、上传的文件、AI / Agent 输出、平台管理员填写的 Base URL（第 4.4 节）都按不可信输入处理，服务端每个接口都要做鉴权、归属校验和输入校验。
2. **复用现有 Node 业务代码。**Main 进程约 4.6 万行 CommonJS（`aiService`、`taskService`、各 Task、Pi Agent SDK、文档解析）是最大的资产，服务端选型以能直接搬运这些代码为第一考虑。
3. **bridge 是唯一端口。**Renderer 经 `src/shared/bridge`（旧仓库 PR #24）访问能力，Web 版实现 `WebBridge` 即可，Renderer 业务代码尽量不动。服务端 API 的形状以 `AppBridge` 为准。
4. **不依赖原作者的任何服务**，也不自建 analytics（0.18、0.19 已决定）。
5. **小步上线。**先能在单台服务器上用 Docker Compose 跑起来，架构上为水平扩展留出口，但不为此提前引入 Kubernetes。

## 1. 技术栈选型

| 层 | 建议 | 理由 | 与路线图第 5 节的关系 |
|---|---|---|---|
| 运行时 | **Node.js 24 LTS** + TypeScript | 现有业务代码全是 Node，直接复用；Node 22 在 2027-04 结束维护，新服务从 24 起步免得上线前后就要升级。`server/` 固定 Node 24.21.0（`engines`、CI 的 `server-checks` 和 Dockerfile 一致，旧仓库 PR #27）；`client/` 的 CI 仍是 Node 22 | 路线图写 Node 22，**偏离**，已决定（第 9 节第 11 项） |
| Web 框架 | **Fastify 5** | 路线图首选；插件体系覆盖 Cookie、multipart、限流、helmet；JSON Schema 校验和序列化内置，正好用来给约 170 个通道逐一声明入参（对应前提 1）；比 NestJS 轻，便于直接挂载现有 CommonJS 服务 | 一致 |
| 入参校验 | TypeBox（Fastify 原生支持） | 现有 Pi 工具已在用 `typebox`；Schema 同时生成类型，可与 `ipc.ts` 对照 | 新增 |
| 数据库 | **PostgreSQL 17** | 多用户并发写、事务、行级安全（RLS，见第 2.6 节）、JSONB 存编排快照 | 一致 |
| 数据访问 | **Kysely** + 手写 SQL 迁移（Kysely Migrator，旧仓库 PR #28 选定，不另引入 `node-pg-migrate`） | 现有 Store 是手写 SQL（better-sqlite3），Kysely 是“类型化 SQL 构造器”，改写时 SQL 结构基本可以一一对应，比 Drizzle 的 schema-first 模式改动小 | 路线图在 Kysely / Drizzle 间待定，**建议 Kysely** |
| 任务队列 | **BullMQ + Redis 7** | 延迟任务、重试、stalled 检测、并发控制成熟；Redis 同时承担进度 pub/sub、取消信号、限流计数和分布式信号量 | 一致（已决定，第 9 节第 9 项） |
| 实时推送 | **SSE**（Server-Sent Events），命令仍走 HTTP POST | 现有 19 个 `onXxx` 全是服务端→浏览器的单向推送，SSE 足够；走普通 HTTP，Cookie 鉴权、反向代理、断线重连（`Last-Event-ID`）都是标准行为。比较见第 5.4 节 | 路线图写 WebSocket，**偏离** |
| 对象存储 | **云厂商对象存储**（S3 兼容接口），与 KMS 同一云厂商、同一地域（优先香港） | 已决定（第 9 节第 13、14 项）。服务端只依赖 S3 API，存储后端可替换；开发环境和 CI 用本地 S3 兼容实现（MinIO 社区版 2025 年起进入维护状态，需核实现状，备选 Garage、SeaweedFS） | 一致 |
| 文档解析 | 现有 `doc2markdown/`（mammoth、pdfjs、SheetJS、turndown）+ LibreOffice headless | 原样搬运，放进 worker 镜像，在沙箱内执行（第 7 节） | 一致 |
| Word 助手 | 现有 `openxmlhelper/`（.NET 10），每个导出任务一个 `export` 沙箱，沙箱内一次性运行（`--run`） | 任务目录与 `request.json` / `result.json` 的约定不变；不做常驻容器、不与 worker 共享卷（第 1.1、7.9 节） | 原写独立容器 + 共享临时卷，**偏离**（路线图第 7 步决定事项第 1 项） |
| 离屏渲染 | Playwright（`playwright-core`）+ chromium-headless-shell，在 `export` 沙箱中禁用 JavaScript 运行 | 替代隐藏 `BrowserWindow`。第 7 步只做页眉页脚装饰转图（第 7.9 节）；Mermaid/HTML 转图、docx-editor 分页测量需要执行脚本，随第 8 步由用户逐项决定 | 一致 |
| Agent 沙箱 | **gVisor（runsc）容器**，起步方案 | 见第 7 节三个选项的对比 | 路线图写 gVisor 或 Firecracker，**gVisor 起步**（已决定，第 9 节第 12 项） |
| 密码哈希 | argon2id（`@node-rs/argon2`） | OWASP 推荐首选；预编译二进制，无需本地编译 | 新增 |
| 加密 | Node 内置 `crypto`（AES-256-GCM）+ **云 KMS** 包装数据密钥 | 不引入额外原生依赖，见第 4 节；KMS 与对象存储同一云厂商（第 9 节第 8 项）；开发环境用本地密钥文件 | 路线图写 KMS 或 libsodium，**内置 crypto + 云 KMS** |
| 日志 | pino（Fastify 默认） | 结构化日志，内置 `redact` 配置屏蔽凭据字段 | 新增 |
| 前端托管 | Vite 构建产物由反向代理直接托管 | 与 API 同源，Cookie 不跨域，CSP 好写 | 新增 |
| 反向代理 / TLS | Caddy 2 | 自动申请和续期证书，配置短；也可换 Nginx + certbot | 新增 |

### 1.1 服务划分

```
浏览器 ──HTTPS──> Caddy ──> web（静态文件）
                        └─> api（Fastify）──> PostgreSQL
                                 │   ├────> Redis（队列 / pub/sub / 限流）
                                 │   └────> 对象存储
                                 └─ SSE 推送
worker（BullMQ 消费者，复用 taskService / aiService 等）
   ├─> sandbox-runner ──> 沙箱容器（parse：LibreOffice 与解析库；export：OpenXmlHelper + Chromium；第 8 步：Agent）
   └─> AI 网关（worker 内模块，计量计费）──> 平台签约的模型服务
```

- **api**：只做鉴权、校验、读写数据库、入队、签发下载链接和 SSE 推送；不执行长任务、不解析文档、不调模型（模型列表、连通性测试这类几秒内完成的请求除外，同样经 AI 网关）。
- **worker**：执行全部长任务。可以起多个副本；Agent 类和解析类任务用不同队列，分别设置并发。
- **AI 网关**：worker 内的模块（不是独立服务），由现有 `aiService.cjs` 改造而来，是**唯一解密和使用 API Key 的地方**（第 4 节），也是**唯一的计量点**：每次模型调用都在这里记账、扣费（第 10 节）。沙箱内的 Agent 通过它访问模型（第 7 节）。
- **sandbox-runner**：唯一持有容器运行时权限的进程，只接受“用固定镜像、固定参数启动一个沙箱”这类受限请求，worker 不直接接触 Docker socket（第 7.4 节）。
- **OpenXmlHelper（.NET）不是常驻服务**：它解析的受限 HTML、模板配置和（第 8 步起）上传的 Word 都是不可信输入，所以与文档解析一样按任务进沙箱——每次导出一个 `export` 沙箱，沙箱内一次性运行助手（`--run`）后销毁，不与 worker 共享卷、不跨任务保留缓存（路线图第 7 步决定事项第 1 项，第 7.9 节）。原方案“常驻 `openxml` 容器 + 与 worker 共享临时卷”已放弃。

## 2. 多用户数据模型

### 2.1 现有表的情况

运行时 schema 以 `client/electron/services/sqliteDatabase.cjs` 为准（第 24 版迁移），共 55 条 `CREATE TABLE`，去掉迁移中重复创建的 `technical_plan_global_fact_groups`，实际是 **54 张表**，与 `sql/workspace_schema.sql` 一致。另有两类状态不在 SQLite 中：Token 统计（`textTokenStatsStore.cjs`，JSON 文件）和 Pi 持久任务状态（`pi/piPersistentTaskStore.cjs`，任务目录下的 `task-state.json`）。

现状的关键特征：

- **单行“当前项目”**：`technical_plan_meta`、`duplicate_check_meta`、`rejection_check_meta`、`feasibility_report_meta`、`credential_library_profile` 都是 `id INTEGER PRIMARY KEY CHECK (id = 1)`，整个库每种业务只有一个项目；
- 子表通过 `file_id`、`document_id`、`node_id` 等文本 UUID 或自增整数关联，没有任何 user / tenant 字段；
- 大量路径字段（`tender_markdown_path`、`document_dir`、`source_path`、`markdown_path` 等）存的是本机绝对或相对路径，正文、原始文件、图片都在文件系统上。

### 2.2 租户层级

```
organizations（组织，数据隔离的边界）
  ├── org_memberships ── users（用户，可属于多个组织）
  ├── projects（项目：技术方案 / 查重 / 废标检查 / 可研报告，各自一种 kind）
  │      └── 各业务表（按 project_id）
  └── 组织级共享库：知识库、资信库、导出模板（按 org_id）
```

- **组织（organization）是隔离边界**，所有业务数据最终归属于一个组织。注册时自动创建一个只有本人的“个人组织”，个人用户感觉不到组织的存在；以后开放团队功能时只需要邀请成员，数据模型不用再改。
- **项目（project）取代单行 meta**。现有每种业务“只有一个当前项目”，Web 版改为一个组织下可以有多个项目，前端增加项目列表；“当前项目”变成 URL 中的 `projectId`，不再存服务端状态。第一版界面仍每种业务一个项目、多项目界面放到第 9 步之前（第 9 节第 3 项），但数据模型从一开始就按多项目设计，避免二次迁移。
- **用户（user）只表示身份和操作者**，不直接拥有业务数据；`created_by` / `updated_by` 记录操作者，用于审计和团队协作时的显示。

### 2.3 现有 54 张表的归类

| 类别 | 表 | 数量 | 隔离方式 |
|---|---|---|---|
| 技术方案（项目级） | `technical_plan_meta`、`_generation_config`、`_generation_bid_tasks`、`_generation_reference_docs`、`_tasks`、`_bid_items`、`_outline_nodes`、`_content_sections`、`_content_plans`、`_global_fact_groups` | 10 | `project_id`（+ `org_id`） |
| 标书查重（项目级） | `duplicate_check_meta`、`_files`、`_tasks`、`_analysis_sections`、`_content_files`、`_metadata_items`、`_outline_items`、`_outline_groups`、`_outline_pairwise`、`_content_duplicates`、`_content_occurrences`、`_image_files`、`_duplicate_images`、`_image_occurrences` | 14 | 同上 |
| 废标检查（项目级） | `rejection_check_meta`、`_documents`、`_tasks`、`_extraction`、`_results`、`_risk_findings`、`_typo_findings`、`_logic_findings` | 8 | 同上 |
| 可研报告（项目级） | `feasibility_report_meta`、`_tasks`、`_outline_nodes` | 3 | 同上 |
| 任务日志 | `task_logs` | 1 | `org_id` + `project_id` + `job_id` |
| 知识库（组织级共享） | `knowledge_folders`、`_documents`、`_blocks`、`_candidate_items`、`_items`、`_item_blocks`、`_discarded_groups`、`_reports`、`_document_steps`、`_match_batches` | 10 | `org_id`；`_documents` 的 `document_dir` / `source_path` 改为 `file_id`（`knowledge` 文件），`markdown_path` 改为 `markdown_artifact_id`，文档随原件的生命周期（迁移 0012）；其余七张表随文档可见、整体替换（迁移 0013） |
| 资信库（组织级共享） | `credential_library_profile`、`_certificates`、`_employees`、`_projects`、`_other_materials`、`_images` | 6 | `org_id`；`profile` 的 `id = 1` 改为每组织一行（主键 `org_id`）；`_images` 的 `relative_path` 改为 `file_id`（`credential-image` 文件），图片随文件的生命周期（迁移 0011） |
| 导出模板 | `export_templates` | 1 | `org_id`；系统模板 `org_id` 为空（以 `system_key` 标识，取代 `is_system`），全体只读（#10） |
| 已停用 | `official_invoice_info` | 1 | **不迁移**（0.17 起程序不再读写） |

结论：**除 `official_invoice_info` 和系统模板外，53 张表都要隔离**，没有可以全局共享的业务表。

知识库、资信库、模板放在组织级而不是项目级，是因为它们本来就是“跨项目复用的素材”（技术方案生成时检索知识库、引用资信库）。已决定组织内共享（第 9 节第 2 项），个人组织下与私有等价。

### 2.4 改表规则

1. **每张业务表都加 `org_id NOT NULL`**，即使能通过父表推出来。冗余是为了让 RLS 策略（第 2.5 节）和索引都只看本表，不需要 JOIN。
2. 项目级表再加 `project_id NOT NULL`，外键指向 `projects(id) ON DELETE CASCADE`。单行 meta 表主键从 `id = 1` 改为 `project_id`。
3. **主键**：现有文本 UUID（`file_id`、`document_id`、`node_id`、`folder_id` 等）全局唯一，保持不变；自增整数主键改为 `bigint generated always as identity`。所有唯一约束补上作用域，例如 `UNIQUE(file_id, key)` 不变（`file_id` 已全局唯一），而按名称唯一的约束要改成 `UNIQUE(org_id, name)` 这类形式。实施时逐表核对。
4. **复合外键防串号**：子表引用父表时用 `(org_id, parent_id)` 复合外键，数据库层面保证子记录不会挂到别的组织的父记录上。
5. **路径字段改为对象引用**：`*_path`、`document_dir` 等改为 `file_objects.id`（第 6 节），数据库中不再出现任何服务器文件系统路径。
6. **时间字段**：现有 `TEXT` ISO 时间改为 `timestamptz`；JSON 文本字段（`*_json`）改为 `jsonb`。
7. 索引一律以 `org_id`（项目级再加 `project_id`）开头。
8. 持久化协议不变：`saveOutline()` 的 `reason`、节点 UUID 与 `sort_order` 的语义、`checkpointTask` 的原子性（改用 Postgres 事务）都原样保留（`AGENTS.md`“数据与流程”）。

### 2.5 新增的表

| 表 | 用途 |
|---|---|
| `users` | 邮箱（唯一、小写归一化）、密码哈希、邮箱验证时间、状态（正常 / 停用）、是否平台管理员；**预留** `phone`（E.164 格式，可空，非空时唯一）和 `phone_verified_at`，第一版不写入（第 3.1 节） |
| `organizations` | 名称、类型（个人 / 团队）、配额 |
| `org_balances`、`billing_ledger` | 余额与只追加的资金账本（第 10 节；旧仓库 PR #31 起扣费也写入账本） |
| `usage_records` | 每次模型调用一行的用量与费用（第 10 节） |
| `model_prices` | 计费价格表，带版本和生效时间（第 10 节）；旧仓库 PR #31 加了可空的 `org_id`：为空是平台默认价，非空是组织专属价 |
| `org_memberships` | `(org_id, user_id, role)`，角色 `owner` / `admin` / `member` |
| `org_invitations` | 邀请邮箱、角色、令牌哈希、过期时间 |
| `sessions` | 会话（第 3 节） |
| `auth_tokens` | 邮箱验证、重置密码等一次性令牌，只存哈希 |
| `projects` | `org_id`、`kind`、名称、`created_by`、软删除时间（#7 实现时由“归档时间”改为软删除与 7 天恢复期） |
| `provider_credentials` | 平台级，加密后的模型服务 API Key / MinerU Token（第 4 节），不属于任何组织 |
| `platform_models` | 平台提供给用户选择的模型清单（第 4.1 节），由平台管理员维护 |
| `org_settings`、`user_settings` | 由 `user_config.json` 拆分：选用的平台模型、并发、导出偏好等放组织级；界面偏好放用户级。不再有用户填写的 Key 和 Base URL |
| `files` | 上传文件的元数据（第 6 节）；旧仓库 PR #34 实现，表名由原计划的 `file_objects` 改为 `files`，生成产物另行设计 |
| `jobs` | 长任务的权威状态（第 5 节），取代进程内存中的任务状态和 `task-state.json` |
| `job_events` | 需要持久化的任务事件（可选，用于审计和回放） |
| （原 `token_usage`） | 并入 `usage_records`：取代 `textTokenStatsStore` 的 JSON 文件，按组织 / 用户 / 模型 / 任务 / 日期聚合由查询或物化视图完成 |
| `audit_logs` | 登录、成员变更、凭据变更、导出、删除等安全相关操作 |

### 2.6 双层隔离

只靠应用代码里每条 SQL 都写 `WHERE org_id = $1` 是不够的：一处遗漏就是跨用户数据泄露，而 Store 改写涉及约 9 千行代码。所以做两层：

1. **应用层**：Store 不接受裸的数据库连接，只接受 `TenantContext { orgId, userId, role }`。仓储函数内部统一拼 `org_id` 条件；路由层先用 `projectId` 查出项目并核对 `org_id` 与会话一致，再把上下文往下传。
2. **数据库层（PostgreSQL RLS）**：每张业务表 `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`，策略为 `org_id = current_setting('app.org_id')::uuid`。每个请求 / 任务在事务开头 `SET LOCAL app.org_id = ...`。应用连接使用**非表属主、非超级用户**的数据库角色，RLS 对它强制生效；迁移用单独的属主角色。
   - 后台维护任务（清理、统计）需要跨组织时用专门的角色，并记审计日志；
   - 测试中加一条“未设置 `app.org_id` 时任何业务表查询都返回 0 行”的用例，防止策略被误删。

**实现（旧仓库 PR #28）**：

- 角色：`bidtools_owner`（表属主，只跑迁移）和 `bidtools_app`（应用），都 `NOSUPERUSER NOBYPASSRLS`；`public` 收回 `PUBLIC` 的权限，应用角色只有 `USAGE` 和逐表授予的增删改查。
- 上下文用 `set_config('app.org_id', ..., true)`（等价于 `SET LOCAL`，但能参数化），同时设置 `app.user_id`；策略经 `app_current_org_id()` / `app_current_user_id()` 读取。注意事务结束后自定义设置变成空字符串而不是 NULL，函数用 `NULLIF(..., '')` 统一为 NULL，否则连接复用时 `''::uuid` 会报错而不是返回 0 行。
- 身份表不全按 `org_id` 隔离：`users`（可属于多个组织）只能看到当前组织的成员、只能修改自己；`auth_tokens` 按 `app.user_id`；`sessions` 按组织 + 用户。
- 登录、按令牌查会话、找回密码这类“拿到身份之前”的查询在 RLS 下查不到任何行，由鉴权 PR 提供专门的受控入口，见下方“实现（旧仓库 PR #29）”。

**实现（旧仓库 PR #29）**：

- 登录前的查询只经迁移 `0002_auth` 中的六个 `SECURITY DEFINER` 函数：`auth_login_lookup(email)`、`auth_session_lookup(token_hash)`、`auth_issue_password_reset(email, token_hash)`、`auth_reset_password(token_hash, password_hash)`、`auth_consume_invitation(token_hash)`、`auth_revoke_my_sessions()`。固定 `search_path = pg_catalog, pg_temp`，表名全限定；按完整邮箱或令牌哈希精确匹配，最多返回一行、只返回所需字段；收回 `PUBLIC` 的执行权，只授权给 `bidtools_app`。
- 函数属主是第三个角色 `bidtools_auth`：`NOLOGIN`、无 `BYPASSRLS`，表上只为它建 `TO bidtools_auth` 的策略、只授予函数用到的列。迁移角色以 `INHERIT FALSE, SET TRUE` 加入它，只在迁移中 `SET ROLE` 建删函数，不继承它的策略。
- 应用角色对 `users` 改为列级授权：只能写入注册所需的列、只能修改密码，不能设置 `is_platform_admin`、`status`。首个平台管理员由命令行用迁移角色创建。
- 新表 `invitations`（平台级邀请）：只有平台管理员能以自己的名义插入，只能看到自己发出的；兑换只能经 `auth_consume_invitation`。组织级的 `org_invitations` 留到团队功能。
- 测试中除“未设置上下文返回 0 行”外，还检查 `public` 下每张非迁移工具的表都启用并强制 RLS、至少有一条策略。

**实现（旧仓库 PR #31）**：计费新增第四个角色 `bidtools_billing`，属性与 `bidtools_auth` 相同（`NOLOGIN`、无 `BYPASSRLS`，迁移角色以 `INHERIT FALSE, SET TRUE` 加入），是账本触发器和管理员计费函数的属主，对账本和价格表只有 `SELECT`、`INSERT`，余额只能经账本触发器修改，详见第 10 节“实现（旧仓库 PR #31）”。

**实现（#8）**：存储配额新增第五个角色 `bidtools_storage`，属性同上，是配额函数 `files_org_usage_bytes` 的属主，只对 `files`、`artifacts`、`projects` 有只读策略和列级 `SELECT`。配额需要统计应用角色在 RLS 下看不到的行（已删除项目下、仍在恢复期内的文件和产物），详见路线图第 5 步“生成产物（#8，5.2）”。

**实现（#25）**：任务队列新增第六个角色 `bidtools_jobs`，属性同上，是对账函数 `jobs_dispatch_candidates` 的属主，只对 `jobs` 的 `id`、`org_id`、`status`、`lease_expires_at`、`created_at` 有列级 `SELECT` 和只读策略。worker 要在 Redis 重启或被清空后跨组织找出未结束的任务重新入队，函数只返回任务 id 和组织 id，之后每个任务的处理仍按其组织经 RLS 进行。详见路线图第 6 步“jobs 表与 worker 骨架（#25，6.2）”。

**实现（#9）**：`org_settings`、`user_settings`（迁移 `0009_settings`）不新增角色。组织设置的写权限按 `org_memberships` 中的实际角色（owner / admin）由 RLS 判断，不信任 `TenantContext.role`；用户设置只对本人可见，且要求成员关系仍存在，移出组织后不可见并随外键级联删除。详见路线图第 5 步“配置（#9，5.3）”。

**实现（#10）**：`export_templates`（迁移 `0010_export_templates`）不新增角色，是唯一一张 `org_id` 可空的业务表：系统模板 `org_id` 为空，应用角色只读（修改、删除影响 0 行，不能新写或改出系统模板），组织模板组织内成员都可以增删改；系统模板只由迁移角色同步，它在本表上的策略只覆盖 `org_id` 为空的行。详见路线图第 5 步“导出模板（#10，5.4）”。

### 2.7 桌面数据导入

0.19 记录“本版本无存量用户”，所以**第一版不做** `app.sqlite` 导入工具（第 9 节第 18 项）。如果以后需要，做成“上传整个工作区压缩包 → 在沙箱中解析 → 导入成当前组织下的新项目”，按不可信输入处理。

### 2.8 实现（#7）：项目与项目级表

- **`projects`**（迁移 `0007_projects`）：强制 RLS，应用角色只能读写本组织、`created_by` 必须是当前用户；`kind`（`technical-plan` / `feasibility-report` / `rejection-check` / `duplicate-check`）和 `created_by` 建好后不能改；只能软删除（不授予 DELETE），7 天内可恢复，由触发器 `projects_guard` 保证（已删除的项目只能恢复，`PJ004`；过期恢复 `PJ002`）。`UNIQUE (org_id, id)` 供子表的复合外键引用。
- **`files.project_id`**：可空，复合外键 `(org_id, project_id) → projects (org_id, id)`，不级联。
- **归属校验**：`src/projects/access.ts` 的 `requireProject()`，按 `TenantContext` 查出未删除的项目并核对 `org_id` 与 `kind`，不符一律 `404 PROJECT_NOT_FOUND`（第 3.4 节“资源归属校验”）。
- **项目级表的写法**以 `server/tests/db/fixtures/exampleProjectTable.ts` 为模板（第 2.4 节各条规则的具体 DDL），每张新表用 `server/tests/db/projectTable.ts` 的 `describeProjectTable` 跑一遍隔离测试。外键检查不受 RLS 约束，所以复合外键是“子记录挂不到别的组织的父记录上”的数据库层保证，即使应用代码传错了 `projectId`。

## 3. 注册、登录与会话

### 3.1 账号方案（已决定，第 9 节第 4、5 项）

支持**邮箱 + 密码**和**手机号 + 短信验证码**两种登录方式。**第一版只实现邮箱 + 密码**；短信登录列为第二版（短信签名和模板报备需要境内主体，见第 10.6 节），数据模型现在就预留手机号（`users.phone`、`phone_verified_at`，第 2.5 节），`auth_tokens` 的类型枚举预留 `sms_login`，限流维度预留“按手机号”。一个用户可以同时绑定邮箱和手机号，两种方式登录到同一账号；第二版上线时，已有用户在设置页绑定手机号，不另建账号。

- **邮箱 + 密码**：注册后必须完成邮箱验证才能使用；密码用 argon2id 哈希（参数按 OWASP 建议，如 19 MiB 内存、2 次迭代），最少 10 位，拒绝常见弱口令列表中的密码。
- 找回密码：邮件发一次性链接（令牌 256 位随机数，库中只存 SHA-256，30 分钟过期，用后作废），重置后吊销该用户全部会话。
- 预留 **OIDC** 登录（企业客户常见需求），不在第一版实现。
- 预留 **TOTP 二次验证**，管理员账号上线时就应开启。
- **注册不开放**：第一版只接受邀请注册（平台管理员或组织 owner 发邀请），避免被批量注册后滥用 Agent 算力和平台的 AI 额度；上线稳定后再考虑公开注册。
- **短信验证码（第二版）**：6 位数字，库中只存哈希，5 分钟过期，最多尝试 5 次；按手机号、IP、设备三个维度限流，并加图形或滑块验证防短信轰炸。

邮箱验证、找回密码和邀请都依赖**发信服务**，这是本项目新增的外部服务，尚未选定，列在 `docs/EXTERNAL_SERVICES.md` §7。服务器在境外、用户多用 QQ / 163 邮箱，选型时要重点验证对这两家的送达率（同一节有要求）。

### 3.2 会话

- **服务端会话 + 不透明令牌**，不用 JWT：需要能随时吊销（改密码、移出组织、管理员封禁），JWT 做不到即时失效。
- 令牌为 256 位随机数，放在 Cookie 中；数据库 `sessions` 表只存 `SHA-256(token)`，库被拖走也无法冒用会话。
- Cookie：`__Host-session`，`HttpOnly; Secure; SameSite=Lax; Path=/`，不设 `Domain`。
- 有效期：空闲 7 天、绝对 30 天；每次请求滑动续期（限频写库，如每 10 分钟最多更新一次 `last_seen_at`）。
- 会话记录 `user_id`、当前 `org_id`、创建时间、最近活动时间、UA 和 IP 摘要；设置页提供“登录设备”列表和“退出其他设备”。
- 登录成功、提权（切换组织、修改密码）时**轮换令牌**，防会话固定。
- Redis 可缓存会话查询结果（短 TTL），吊销时同步删除缓存。

**实现（旧仓库 PR #29）**：令牌 256 位随机数（base64url），库中只存 SHA-256；Cookie 属性如上，`Max-Age` 为 30 天；`expires_at` 取“最近活动 + 7 天”与“创建 + 30 天”的较早者，最近活动超过 10 分钟才写库。登录、注册、修改密码时轮换令牌；修改密码、找回密码后吊销本人在所有组织的全部会话；移出组织（复合外键级联）和停用用户后会话立即失效。会话中的 IP 只存摘要（IPv4 /24、IPv6 /48）。Redis 缓存会话留到接入 Redis 时。

### 3.3 CSRF 与跨站

- 所有改变状态的接口只接受 `POST` / `PUT` / `PATCH` / `DELETE`，且要求 `Content-Type: application/json`（multipart 上传除外）；
- 校验 `Origin`（缺失时校验 `Referer`）必须是本站；
- 再加一个自定义请求头（如 `X-Requested-With: app`），跨站表单无法设置。`SameSite=Lax` + 以上三条已足够，不再引入 CSRF Token；
- 不开启 CORS。

**实现（旧仓库 PR #29）**：上面三条在全局 `onRequest` 钩子中执行，跨站校验先于会话解析；“本站”由配置 `PUBLIC_ORIGIN` 决定（生产环境必需且必须是 https），自定义头为 `X-Requested-With: app`；去掉了 Fastify 默认的 `text/plain` 解析器。

### 3.4 鉴权与授权

- Fastify 全局 `onRequest` 钩子解析会话，未登录只放行登录、注册、找回密码、健康检查和静态资源；
- 每个路由声明所需角色（`member` / `admin` / `owner` / 平台管理员）；
- **资源归属校验**是每个带 ID 的接口的必经步骤：路由参数中的 `projectId`、`fileId`、`jobId` 等先按 `TenantContext` 查询，查不到一律返回 404（不区分“不存在”和“无权限”，避免枚举）；
- 开发者工具（Token 统计、Agent 监视器）只对平台管理员开放（路线图第 4 节）；
- 平台模型清单、平台凭据、价格表、手动充值只对平台管理员开放，且要求管理员已开启 TOTP（第 4、10 节）。旧仓库 PR #31 实现了手动充值、冲正和新增价格，TOTP 尚未实现，暂用重新输入密码做二次验证，并禁用单笔上限以上的大额充值（第 10 节“实现（旧仓库 PR #31）”）。

**实现（旧仓库 PR #29）**：路由默认需要登录，声明 `config.access = 'public'` 的才放行（登录、登出、注册、找回密码、健康检查）；未知路由仍返回 404。平台管理员接口目前只有生成邀请，每次请求从库中读取 `is_platform_admin`，撤销立即生效；TOTP 尚未实现。

### 3.5 防滥用

- 登录、注册、找回密码、发验证邮件：按 IP 和按邮箱两个维度限流（`@fastify/rate-limit` + Redis），连续失败后指数退避；
- 登录失败不提示“邮箱不存在”还是“密码错误”；
- 每个组织的任务并发、每日 Agent 运行时长、存储容量都有配额（第 5、6 节），AI 用量受余额约束（第 10 节）。

**实现（旧仓库 PR #29）**：限流先用进程内存实现（每个限流器的键数有上限），参数见 `server/src/auth/rateLimit.ts`。**6.14（#42）起**计数存在 Redis（`server/src/auth/rateLimitStore.ts`，Lua 脚本，算法不变，未用 `@fastify/rate-limit`），api 各实例共用；键中的邮箱、IP 取 SHA-256，键都带过期时间；Redis 不可用时退回进程内存计数并写日志，未配置 `REDIS_URL` 时只用进程内存。登录失败一律返回“邮箱或密码错误”，邮箱不存在时用同参数的假哈希做一次完整校验，耗时一致；找回密码不论邮箱是否存在都返回 202，邮件在响应后异步发送。发信服务未选定，`src/mail/mailer.ts` 只有日志实现：开发环境输出完整邮件，其他环境不输出正文（令牌）。

**客户端 IP（旧仓库 PR #30）**：按 IP 的限流键和会话的 IP 摘要都取 `request.ip`。配置 `TRUSTED_PROXIES`（逗号分隔的 IP 或 CIDR，前缀不能为 0）列出可信反向代理，默认空，即不信任任何代理：`request.ip` 是 TCP 连接的对端地址，客户端自带的 `X-Forwarded-For` 一律忽略。配置后交给 Fastify 的 `trustProxy`（`@fastify/proxy-addr`）：只有对端地址在列表中时才读 `X-Forwarded-For`，从右往左跳过可信地址，取第一个不可信的地址，所以客户端在左侧伪造的值不会被采信；绕过代理直连时按对端地址计数。部署方式见第 8.1 节。

## 4. 模型服务凭据的加密存储

### 4.1 现状与 Web 版的变化

桌面版 API Key 明文存在 `user_config.json`；0.14 起 `config:load` 返回给 Renderer 时打码（`services/configSecrets.cjs`），只给 `credential_status`（是否已配置、末尾几位），保存时空值表示不修改，`credential_clear` 删除，**Base URL 有改动时不还原已保存的 Key**。

Web 版**由平台统一提供 AI 并按量计费**（第 9 节第 7 项）：

- 模型服务商的 API Key、Base URL 和 MinerU Token 都由**平台管理员**在管理后台配置，属于平台，不属于任何组织；普通用户**看不到、也不能填写** Key 和 Base URL；
- 平台管理员维护 `platform_models`（对用户展示的模型名、对应的服务商与凭据、上游模型 ID、能力：文本 / 生图 / 解析、是否上架、对应的价格表条目）。用户在设置页只能从上架模型中选择，`org_settings` 中只存 `platform_model_id`；
- 设置页的“服务商 / Base URL / API Key / 测试连接”在 Web 版对普通用户隐藏，改为“选择模型 + 查看单价”；`config.listModels`、模型连通性测试只在管理后台提供；
- 桌面版 `configSecrets.cjs` 的打码、空值不修改、Base URL 改动不沿用 Key 的规则，搬到管理后台的凭据编辑接口上继续使用。

### 4.2 信封加密

```
KEK（主密钥）── 不进数据库，生产环境为云 KMS 中的密钥，开发环境为本地密钥文件
  └─ 加密 ─> DEK（每条凭据一个随机 256 位数据密钥）
                └─ 加密 ─> API Key 明文
```

`provider_credentials` 表：

| 字段 | 说明 |
|---|---|
| `id` | 主键；平台级，没有 `org_id` |
| `kind` | `text_model` / `image_model` / `mineru` |
| `provider` | 服务商标识（与 `platform_models` 关联） |
| `base_url` | 明文保存；与 Key 绑定，见 4.4 |
| `ciphertext`、`iv`、`auth_tag` | AES-256-GCM 加密结果，`iv` 每次随机 96 位 |
| `wrapped_dek` | 用 KEK 加密后的 DEK |
| `kek_version` | 主密钥版本，用于轮换 |
| `last4` | 末尾 4 位，供界面显示“已配置（末尾 xxxx）” |
| `created_by`、`updated_at`、`last_used_at` | 审计 |

- **AAD（附加认证数据）** 绑定 `id | kind | provider | base_url`：把一行密文复制到另一行或换掉 Base URL，解密都会失败；
- **KEK 来源（已决定，第 9 节第 8 项）**：生产环境用**云 KMS**，与对象存储同一云厂商、同一地域（第 9 节第 13、14 项）。只用 KMS 的 `Encrypt/Decrypt`（或 `GenerateDataKey`）包装 DEK，明文 Key 不出服务器；worker 用实例角色（不落地的临时凭据）访问 KMS，权限只给“用这一个密钥加解密”，不给管理权限；开启 KMS 密钥的删除保护和调用审计。开发环境和 CI 用本地密钥文件。代码中抽象成 `KeyWrapper` 接口，两种实现可切换；
- **缓存**：解包后的 DEK 可以在 worker 内存中缓存几分钟，减少 KMS 调用；不写 Redis、不写磁盘；
- **轮换**：KMS 侧开启自动轮换；手动更换 KEK 时，新写入用新版本，后台任务把旧 `wrapped_dek` 解包再用新 KEK 重新包装（只动 DEK，不动密文），完成后旧 KEK 停用；
- **备份**：数据库备份里只有密文；KMS 密钥一般不能导出，所以靠删除保护防误删（第 8.4 节）。KEK 丢失等于全部平台凭据作废，平台管理员重新填写即可，业务数据不受影响。

### 4.3 使用边界

- **只有 AI 网关（worker 内）和管理后台的“模型列表 / 连通性测试”路由会解密**，解密后的明文只存在于发请求的局部变量里，不缓存到 Redis、不写数据库其他字段、不进任务参数（任务参数里只放 `platform_model_id`）；
- 任何接口都不返回明文；管理后台返回 `credential_status` 结构，普通用户的接口根本不涉及凭据；
- pino 配置 `redact`：`*.api_key`、`*.apiKey`、`*.token`、`authorization`、`headers.authorization`、`cookie` 等一律替换为 `[REDACTED]`；模型服务商返回的错误消息在写日志和推送前过一遍脱敏（与 0.10 的 `agentFailureLog.cjs` 规则一致）；
- **沙箱里没有任何 Key**：Agent 通过 AI 网关访问模型，只拿到一个任务级的短期令牌（第 7.3 节）。

### 4.4 Base URL 与 SSRF

平台统一提供 AI 后，Base URL 只由平台管理员填写，普通用户无法指定，SSRF 面大幅缩小。但管理员账号可能被盗、也可能填错，所以下列防护仍然保留（纵深防御）：

1. **Key 外泄**：沿用 0.14 规则，Base URL 一旦改动，已保存的 Key 不再沿用，必须重新填写（AAD 绑定 Base URL 使这条规则在密码学上也成立）；
2. **SSRF**：Base URL 被填成 `http://127.0.0.1:6379`、`http://169.254.169.254/`、`http://postgres:5432` 等内网地址时，服务端会替人访问内网。对策：
   - 只允许 `https`（自托管模型等确需 `http` 的场景用单独的白名单配置项，修改记审计日志）；
   - 所有出站模型请求经过一个**出站代理 / 自定义 DNS 解析器**：解析后拒绝私有、回环、链路本地、组播和保留地址（IPv4 与 IPv6 都要覆盖），并对实际连接的 IP 校验，防止 DNS rebinding；
   - 禁止跟随重定向到不同主机；
   - 响应体大小和时长设上限。

Markdown 中远程图片的下载（`docs/EXTERNAL_SERVICES.md` §2.9）URL 来自 AI 或用户内容，仍是用户可控的 SSRF 面，走同一个出站校验。

## 5. 长任务队列与进度推送

### 5.1 任务模型

`jobs` 表是任务状态的**唯一权威**，BullMQ 只负责“派发到哪个 worker”。字段：`id`、`org_id`、`project_id`、`user_id`、`type`（沿用 `taskService.cjs` 中 `taskDefinitions` 的键，如 `bid-analysis`）、`lock_key`（互斥键，见第 5.3 节；6.2 起取代原设计的 `group`）、`status`（`queued` / `running` / `paused` / `cancelling` / `succeeded` / `failed` / `cancelled`）、`pause_requested`、`progress`、`checkpoint`（jsonb）、`params`（jsonb，不含凭据）、`error_code` / `error_message`（脱敏）、`attempt`、`run_id` 与 `lease_expires_at`（执行者的隔离令牌与租约）、各时间戳。

**派发与恢复（6.2 实现）**：入队先写 `jobs` 再放进 BullMQ（任务 id 即 `jobs.id`，重复放入是空操作）；只有 `queued` 能被认领，认领生成 `run_id` 和租约，之后的写入都带 `run_id` 条件；worker 定期并在发现 Redis 数据丢失时对账：`queued` 的重新放入，租约过期的按任务类型续跑或标为失败。因此 Redis 重启或被清空后任务不丢失、不重复执行。

为什么不把状态只放在 BullMQ：Redis 不做持久备份（第 8.4 节），且需要按组织 / 项目查询、受 RLS 保护。

### 5.2 队列划分

| 队列 | 任务 | worker 并发（单实例起步值） |
|---|---|---|
| `parse` | 文档导入解析、招标文件 Markdown 转换 | 4 |
| `ai` | 不带 Agent 的 AI 任务：查重、废标检查、标书分析、知识库文档准备（解析在沙箱中，6.13a）与匹配 | 8 |
| `agent` | Pi Agent 任务：目录、全局事实、正文生成、原方案还原、格式自检 | 2（受沙箱资源限制） |
| `export` | Word / Excel 导出、模板样张、模板提取（调 OpenXmlHelper） | 2 |

### 5.3 互斥、并发与配额

- **互斥**：现有 `lockPolicy: 'group-exclusive'` 是“全机同组只能跑一个”。Web 版改为按通用的互斥键 `lock_key` 互斥（例如 `project:{projectId}:technical-plan` 即“同一项目内同组只能跑一个”，知识库按文档 `knowledge-document:{documentId}`，`lock_key` 为空的任务不互斥）：部分唯一索引 `UNIQUE (org_id, lock_key) WHERE status IN ('queued','running','paused','cancelling')` 保证并发入队也只有一个成功（6.2 实现，路线图第 6 步“任务模型的细化”）。
- **两级并发**（路线图第 4 节）：
  - 组织级：同时运行的任务数（如 3）、同时运行的 Agent 任务数（如 1）；
  - 全局：队列并发 + AI 网关对每个模型服务商的并发上限（`aiService` 现有并发设置改成 Redis 分布式信号量，键为 `org_id + provider`；6.4 实现，上限取 `org_settings.concurrency_limit` 与平台上限 `AI_CONCURRENCY_MAX` 的较小值，见第 10.10 节）。
  - 超出组织级上限的任务留在 `queued`，按入队时间排队，前端显示“排队中（前面还有 N 个）”。
- **配额**：每组织每日 Agent 运行时长（8 小时，第 9 节第 15 项）、每任务最长时长（如正文生成 2 小时）、超时即取消并保留 checkpoint。
- **实现（路线图 8.3d，迁移 0036_agent_job_runs，`src/agent/quota.ts`）**：同一组织同时运行的 Agent 任务（登记了费用与轮数上限的任务）至多 1 个，认领时检查，超出的留在 `queued`、按入队时间排队（先入队的没有开始之前，后入队的不认领），不拒绝入队。每日 Agent 运行时长按北京时间的自然日、由每次执行的起止时间（`agent_job_runs`，认领时写入、续租时推进、结束时计到现在，执行者失联只计到最后一次续租）现算；入队与继续（含确认继续）时已用完的拒绝（429 `AGENT_DAILY_RUNTIME_EXHAUSTED`），排队期间或执行中（续租时检查）用完的暂停为 `agent_daily_runtime`，次日经普通的“继续”从 checkpoint 续跑。执行记录的时间取数据库时间，应用角色不能删除或改小（触发器 `AR001`）。
- **余额**：入队前检查组织余额，余额不足时拒绝新任务；运行中的任务余额耗尽后的处理见第 10.3 节（6.4 实现，第 10.10 节）。

### 5.4 推送通道：SSE 与 WebSocket

| | SSE（建议） | WebSocket |
|---|---|---|
| 方向 | 服务端→浏览器单向，命令另走 HTTP POST | 双向 |
| 与现有代码匹配 | 19 个 `onXxx` 全是单向推送；`agent.answerQuestion` 等命令本来就是 `invoke`，映射成 POST 最自然 | 双向能力用不上 |
| 鉴权 | 普通 HTTP 请求，自动带 Cookie，走同一套会话和 Origin 校验 | 握手带 Cookie，但之后的消息要自行设计鉴权和 CSRF 防护（跨站 WebSocket 劫持） |
| 断线重连 | 浏览器 `EventSource` 内置，自动带 `Last-Event-ID` | 需自行实现重连和补发 |
| 代理 / 防火墙 | 普通 HTTP，兼容性好；需关闭代理缓冲 | 需代理支持 Upgrade，部分企业网关会拦截 |
| 连接数 | HTTP/1.1 下每域名 6 条连接上限，必须走 HTTP/2（Caddy 默认开启） | 无此问题 |

结论：**用 SSE**。一个页面只开一条 `GET /api/events` 连接，所有频道复用。

### 5.5 推送链路

1. worker 产生事件（进度、日志、Agent 提问、任务结束）→ 写 `jobs` / `job_events`（需要持久化的）→ 事务提交后向 Redis 发布到 `events:org:{orgId}`；api 中改变任务状态的操作（入队、取消、暂停、继续）同样在提交后发布；
2. 同时追加到 Redis Stream `stream:org:{orgId}`（只保留最近 10 分钟或 1000 条），每条带单调递增 ID；追加、裁剪、发布在同一个 Lua 脚本中原子完成（6.3，`src/events/stream.ts`）。发布尽力而为，Redis 不可用时丢弃并写日志，由第 4 条的 `resync` 兜底；
3. api 进程用一条订阅连接按组织引用计数订阅，按连接的 `org_id` 过滤（事件可另指定只推给某个用户；任务事件在组织内共享，不按用户过滤）后写入 SSE，`id:` 字段即 Stream ID。新连接先订阅、再补发、最后按 ID 去重放出订阅期间缓存的实时事件，补发与实时之间不漏不重；
4. 浏览器断线重连时带 `Last-Event-ID`，api 从 Stream 补发；超出保留窗口（上次的 ID 比 Stream 第一条还小）、Stream 不存在（过期、Redis 重启或被清空）或 ID 不认识的，推一条 `resync` 事件，前端重新调用 `getActiveTasks` / `loadState` 拉快照（现有页面本来就会在挂载时拉快照，“页面卸载不取消任务”的语义不变）。补发完成后推一条不带 id 的 `ready`，前端先等 `ready` 再拉快照；
5. 每 25 秒发一条注释行做心跳；Caddy 对 `/api/events` 关闭缓冲和压缩；每 60 秒重新校验会话，会话失效或用户被移出组织后推 `closed` 并断开；Redis 订阅连接断开、服务关闭时同样推 `closed` 断开，由前端重连补发；每个用户在每个 api 进程中最多 10 条连接；
6. `WebBridge` 中每个 `onXxx(callback)` 只是在这条连接上按事件名注册监听，返回取消函数，与 `AppBridge` 的签名一致。`GET /api/events` 返回非 200 时浏览器的 `EventSource` 不再自动重连，`WebBridge` 自己按退避间隔重建连接。

任务事件（6.3，`src/jobs/notify.ts`）：`job`（任务当前状态，与 `GET /api/jobs/:jobId` 的任务部分相同；并发变化时到达顺序可能与提交顺序不同，按 `updatedAt` 取较新的一条）、`job.progress`、`job.log`；都不含任务参数、checkpoint 和事件数据。

### 5.6 取消、暂停与恢复

- 取消 / 暂停：api 把 `jobs.status` 改为 `cancelling` / `paused`（执行中的暂停记为 `pause_requested`）并向控制频道 `{BullMQ 前缀}:jobs:control` 发布任务 id（6.3；原设计为每个任务一个 `cancel:{jobId}`）；worker 收到后对正在执行的该任务立即续租一次，从 `jobs` 读到请求，消息本身不被信任；worker 内每个任务持有 `AbortController`，收到信号后在下一个检查点退出（现有 `agentInterruption.cjs`、`pauseContentGeneration` 的语义保留）；
- Agent 正在等用户回答（`ask-user`）时，任务状态为 `running`，问题存进 `agent_questions`，经 SSE 的 `job.question` 事件通知、`GET /api/jobs/:id` 的 `pendingQuestion` 读取，回答经 `POST /api/jobs/:id/answer` 写入，等待中的工具调用随即取回；等待超过 10 分钟任务暂停为 `waiting_for_user`，回答后自动继续（8.4c1，见第 7.17 节）。桌面版的自动确认（到时自动选推荐项）不做，随第 9 步再定；
- 任务需要用户确认一项选择才能继续时（例如技术方案目录生成的一级目录确认，8.7e1）：任务先保存检查点（待确认的内容写在 checkpoint 中）再抛 `JobSelectionRequiredError`，执行者把任务暂停为 `waiting_for_selection`（迁移 `0044_job_pause_selection`；已请求暂停 / 取消的按请求收尾），沙箱随即销毁、不占 Agent 并发与运行时长；普通的“继续”返回 409 `JOB_SELECTION_REQUIRED`，只能经该任务类型的确认接口继续（`confirmJobSelection`：限任务发起人或 `owner` / `admin`，选择由业务代码按 checkpoint 中待确认的内容校验后写进 checkpoint，任务回到 `queued`，继续前照常检查最低启动余额与当日运行时长），见第 7.35 节；
- 恢复：worker 崩溃后租约过期，由对账收回并交给其他 worker，任务从 `jobs.checkpoint` 继续（现有“重启恢复”逻辑改成读 `jobs` 表；不依赖 BullMQ 的 stalled 检测，它在 Redis 被清空后无从发现）。6.2 中取消、暂停由执行者续租时从 `jobs` 读到；6.3 接入控制频道后立即送达，错过消息时仍在下一次续租时发现。Agent 任务的会话文件和工作区在对象存储中有快照（第 7.3 节），可以从最近一次快照恢复。

## 6. 文件上传、存储与下载

### 6.1 上传

接口参数从 `filePaths` 改为 `fileIds`（路线图第 4 步）：浏览器先上传得到 `fileId`，再调用业务接口（如 `importTenderDocument({ projectId, fileIds })`）。

上传接口 `POST /api/files`（multipart，`@fastify/multipart` 流式处理，不整体读入内存）：

| 校验 | 规则 |
|---|---|
| 鉴权 | 必须登录；请求中带 `purpose`（`tender`、`knowledge`、`credential-image` 等），决定允许的类型和大小 |
| 大小 | 单文件上限按用途（文档 100 MB、图片 10 MB，第 9 节第 15 项）；单次请求文件数上限；Caddy 层也设请求体上限；超限时立即中断流，删除已写入的部分 |
| 扩展名白名单 | 沿用现有集合：文档 `.txt .md .markdown .docx .pdf .doc .wps .xls .xlsx`（`fileService.cjs`），查重 / 知识库按各自集合，资信库图片 `.png .jpg .jpeg .webp .bmp .gif`（`credentialLibraryService.cjs`） |
| 内容校验 | 读取文件头魔数，必须与扩展名一致：PDF `%PDF-`；`.docx/.xlsx` 为 ZIP 且含 `[Content_Types].xml`；`.doc/.xls/.wps` 为 OLE（`D0 CF 11 E0`）；图片按格式头。不信任浏览器给的 `Content-Type` |
| 文本文件 | `.txt/.md` 必须是合法 UTF-8（或可识别的 GBK，转成 UTF-8），拒绝含 NUL 的内容 |
| 文件名 | 只作显示用：NFC 归一化，去掉路径分隔符和控制字符，截断到 255 字节；**存储路径从不使用用户提供的文件名** |
| 配额 | 组织存储总量上限（20 GB），超出拒绝 |
| 去重 | 计算 SHA-256，存入 `file_objects.sha256`，用于查重任务和避免重复解析 |

上传完成只表示“文件已收下”，状态为 `uploaded`；解析在 `parse` 队列中进行，状态变为 `ready` 或 `rejected`。

### 6.2 解析阶段的防护

上传的文档要经过 mammoth、pdfjs、SheetJS、LibreOffice 解析，这些解析器都有过安全漏洞（第 0 步处理过 `pdfjs-dist`、`xlsx` 的高危漏洞）。所以：

- **解析在沙箱中执行**（第 7 节同一套机制，网络关闭、只读根文件系统、内存 / CPU / 时长上限）；
- ZIP 类格式（docx、xlsx）解析前检查：条目数、解压后总大小、单条目压缩比上限，防 zip bomb；
- PDF 页数上限、单页渲染超时；
- 解析结果（Markdown、抽出的图片）按不可信输入处理：渲染时仍走 `MarkdownRenderer` 白名单；
- 第一版不接 ClamAV 病毒扫描（第 9 节第 16 项：文件只在沙箱内解析，不对其他用户分发）；面向企业客户时再加。

### 6.3 存储隔离

- 对象存储一个私有 bucket，**禁止公开读**、禁止列目录；
- 对象键由服务端生成：`org/{orgId}/files/{fileId}` 和 `org/{orgId}/artifacts/{artifactId}`（#8 实现时由原计划的 `org/{orgId}/artifacts/{jobId}/{name}` 改为按产物 id，名称只作下载文件名，见路线图第 5 步“生成产物”）；
- `file_objects` 表：`id`、`org_id`、`project_id`（可空）、`purpose`、`storage_key`、`display_name`、`mime`、`size`、`sha256`、`status`、`created_by`、时间戳；
- 开启服务端加密（用同一云厂商 KMS 管理的密钥，或对象存储默认加密）；
- 删除：项目删除时标记，后台任务延迟 7 天物理删除对象，期间可恢复；注销账户后 30 天内删除（第 9 节第 17 项）；
- worker 执行任务时把需要的对象下载到**任务私有临时目录**（每任务一个，`0700`，任务结束删除），不再有“共享的 userData 工作区”。

### 6.4 下载与资源访问

取代 `app-asset://` 协议、`export.openFile`、`shell.openPath` 和保存对话框：

- 统一入口 `GET /api/files/:fileId/content`，按 `TenantContext` 校验归属后：
  - 小文件和图片由 api 直接流式返回；
  - 大文件生成 S3 预签名 URL（有效期 5 分钟，绑定 `response-content-disposition`）并 302 跳转。预签名 URL 不能撤销，所以有效期必须短；
- 响应头：`Content-Disposition: attachment; filename*=UTF-8''<编码后的显示名>`（图片预览用 `inline`），`X-Content-Type-Options: nosniff`，`Content-Type` 用服务端记录的值而非扩展名推断；
- 图片以外的文件一律 `attachment`，防止上传的 HTML / SVG 在本站同源下被执行；**SVG 不允许作为上传图片**（现有白名单中本来就没有）；
- 前端中原来的 `app-asset://imported-images/...` 链接在服务端返回时改写为 `/api/files/:id/content`，`MarkdownRenderer` 的图片协议白名单相应改成只允许同源相对路径和 `http(s)`；
- 全站 CSP：`default-src 'self'; img-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`，配合 `MarkdownRenderer` 的白名单清洗，作为 XSS 的第二道防线。

### 6.5 实现（旧仓库 PR #34）：文件存储

第 4 步的第一个 PR，只做服务端的上传、下载、删除，不改 `client/`，不替换 `getPathForFile`、`app-asset://`、`openFile` 等调用（后续 PR）。

- **对象存储**：只依赖 S3 API（`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`，3.1145.0），云厂商待定（香港节点）。配置 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`（或 `_FILE`）；未设置 `S3_BUCKET` 时文件接口返回 503。生产环境 endpoint 必须是 https。SDK 的校验和设为“仅接口要求时”（多家 S3 兼容服务不支持 aws-chunked 尾部校验和），内容完整性由上传时计算的 SHA-256 保证。
- **本地 S3 兼容服务**：MinIO 社区版已进入维护状态、不再提供官方镜像（第 1 节待核实的事项），选用 **SeaweedFS 4.48**（Apache-2.0，`weed mini` 单进程模式，按 digest 固定）。`docker-compose.yml` 的 `s3` 服务只把 S3 端口映射到 `127.0.0.1:8333`；必须设置访问密钥（不设置时 SeaweedFS 接受任意密钥），并关闭默认开启的遥测、管理界面、WebDAV 和 Iceberg / Lance 接口。CI 中以 `docker run` 启动同一镜像（服务容器不能指定启动命令）。
- **`files` 表**（迁移 `0006_files`）：`org_id NOT NULL`，启用并强制 RLS，应用角色只能读写当前组织的行、`created_by` 必须是当前用户。对象键是**生成列** `org/{org_id}/files/{id}`，`id` 是数据库生成的随机 UUID，任何角色都不能写入；用户的文件名只进 `display_name`。应用角色只有列级的 INSERT / UPDATE 授权，只能物理删除 `uploading` 状态的行。`project_id` 由迁移 `0007_projects`（#7）加上，见第 2.8 节。
- **上传**：`POST /api/files?purpose=…&name=…`，请求体是文件原始字节（`Content-Type: application/octet-stream`），**偏离**第 6.1 节的 multipart：没有 multipart 解析器的攻击面；`octet-stream` 不是跨站表单能发送的类型，CSRF 钩子只对声明了 `config.uploadBody` 的路由放开它，其他接口仍只接受 JSON。流程：按用途检查扩展名 → 按 `Content-Length` 和剩余配额预检 → 登记 `uploading` 行 → 流式写入对象存储（8 MiB 分片），同时用 `InspectionStream` 校验：
  - 真实类型：文件头魔数（PDF、ZIP、OLE、PNG、JPEG、GIF、WebP、BMP）必须与扩展名一致，不符在前 16 字节到达时就中断；docx / xlsx 解析 ZIP 中央目录（保留末尾 4 MiB），必须含 `[Content_Types].xml` 和 `word/document.xml` / `xl/workbook.xml`；`.doc/.wps/.xls` 接受 OLE 或改了扩展名的 OOXML（与桌面版查重一致），`.docx` 也接受 OLE（记为 `application/msword`）；没有魔数的文本类格式只对 `.doc/.wps/.xls` 放行（#6）：`.doc/.wps` 接受 RTF、HTML、MHT、Word 2003 XML，`.xls` 接受 HTML 表格和 SpreadsheetML 2003 XML，MIME 按真实内容记录（`application/rtf`、`text/html`、`message/rfc822`、`application/xml`），`.html/.mht` 等扩展名不开放；PDF 在前 1024 字节内查找 `%PDF-`（与 pdfjs 一致），开头是上述文本类格式的不算；这些都只在文件头不是已知二进制格式时才再看前 1024 字节，详见路线图第 4 步“上传白名单补充”；`.txt/.md` 必须是合法 UTF-8 或 GB18030（含 GBK）、不含 NUL，**按原样存储**并在 MIME 中记录编码（第 6.1 节原写“转成 UTF-8”，改为由解析阶段按记录的编码读取）。记录的 MIME 由内容决定，浏览器给的 Content-Type 不被采信；
  - 大小：文档 100 MiB、图片 10 MiB（第 9 节第 15 项），超过即中断；
  - 任一项不通过、客户端断开或 60 秒收不到数据：放弃分片上传、删除对象和 `uploading` 行。
  - 完成时由触发器 `files_guard` 再检查配额。单进程同时上传数上限 8（超出 429）。
- **文件名**：替换为合法 Unicode、NFC 归一化，去掉控制字符、零宽和双向文本控制字符，路径分隔符和 Windows 保留字符换成 `_`，去掉首尾空白和开头的点，按 UTF-8 截断到 255 字节并尽量保留扩展名；只作显示。
- **配额**：每组织 20 GiB，常量写在迁移中，改配额需要新迁移。计入的是已上传、未删除或仍在 7 天恢复期内的文件（回收站中的文件仍占配额，防止“上传—删除”循环无限占用存储）；`uploading` 行（含进程崩溃遗留的）不计入。触发器用事务级 advisory lock 串行同一组织的检查，并发上传合计不会越过配额。
- **下载**：`GET /api/files/:fileId/content` 由 api 从对象存储**流式转发，不签发预签名链接**（无法撤销）；**一律** `Content-Disposition: attachment`（第 6.4 节原计划图片预览用 `inline`，改为一律附件，图片预览等需要时再单独设计），另加 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: private, no-store`。其他组织的 `fileId` 与不存在的一样返回 404。
- **删除**：`DELETE /api/files/:fileId` 软删除（`deleted_at`），7 天内可经 `POST /api/files/:fileId/restore` 恢复（第 9 节第 17 项），过期后不可访问、不可恢复、不计入配额；恢复期由触发器保证（过期恢复抛 `FS002`）。组织内成员都可以上传、删除（组织内共享，第 9 节第 2 项）。另有 `GET /api/files`（`?deleted=true` 为回收站）、`GET /api/files/:fileId`、`GET /api/files/usage`。
- **留给后续**：过期文件和遗留 `uploading` 行的物理清理（跨组织的后台任务，已由路线图 6.8 实现：worker 每小时一批，定义者角色 `bidtools_cleanup`，见路线图第 6 步“清理任务”）；`project_id`（已由 #7 加上）；ZIP 炸弹、PDF 页数等解析阶段的防护（第 6.2 节，在沙箱中解析时实现）；生成产物（`artifacts`，已由 #8 实现，见路线图第 5 步）；前端接入。

## 7. Agent 执行命令的沙箱隔离

### 7.1 风险

Pi Agent 有七个原生工具 `read/write/edit/bash/grep/find/ls`（`pi/piSessionFactory.cjs`），桌面版直接在本机执行，`bash` 在 Windows 上是 PowerShell 5.1（`agent/agentToolEnvironment.cjs`），其他系统是 `/bin/sh`。搬到服务端后：

- 模型的输入包含用户上传的招标文件全文，**提示注入**可以让 Agent 执行任意命令；
- 即使没有恶意，Agent 也可能 `rm -rf`、跑满 CPU、写满磁盘、无限循环；
- 一旦能读到别的用户的工作区、数据库连接串、API Key、主密钥或云元数据服务（`169.254.169.254`），就是全平台的数据泄露。

所以必须假设**沙箱内的代码是攻击者的代码**。要隔离的不止 Agent：LibreOffice 转换、文档解析、Chromium 渲染 AI 生成的 HTML，都处理不可信输入，复用同一套沙箱。

### 7.2 三个选项

| | A. 加固的普通容器（runc） | B. gVisor 容器（runsc）**（建议起步）** | C. Firecracker / Kata 微虚拟机 |
|---|---|---|---|
| 隔离原理 | Linux namespace + cgroup + seccomp，与宿主**共享内核** | 用户态内核拦截系统调用，宿主内核暴露面大幅缩小 | 硬件虚拟化，每个沙箱有独立内核 |
| 逃逸风险 | 宿主内核漏洞即可逃逸；历史上多次出现 | 需要同时突破 gVisor 和其受限的宿主调用 | 需要突破 KVM / VMM，最低 |
| 部署要求 | 任意 Docker 主机 | Docker / containerd 安装 runsc 运行时即可，**单机 Compose 可用** | 需要 KVM：裸金属或开启嵌套虚拟化的云主机；运维最复杂 |
| 启动时间 | 约 100–300 ms | 约 150–500 ms | Firecracker 约 125 ms 起（不含镜像准备）；Kata 1 s 左右 |
| 性能 | 原生 | 系统调用密集、文件 I/O 密集的负载有明显开销（rg、LibreOffice 会慢一些） | 接近原生，内存有额外开销 |
| 兼容性 | 完全兼容 | 少数系统调用不支持；需要实测 LibreOffice、Chromium、.NET | 完全兼容 |
| 适合 | 只跑可信代码；开发环境 | 单机 / 小规模起步，安全与成本平衡 | 规模扩大、需要更强隔离或合规要求时 |

还有一类是第三方托管沙箱服务（按调用付费的云端代码执行沙箱）。不推荐：用户的招标文件和工作区会离开本平台，增加一个处理用户数据的外部服务，违背第 0 节第 4 条。

**B 起步**（第 9 节第 12 项已决定）：在单台服务器的 Docker Compose 中就能用，隔离强度明显高于 A，运维成本远低于 C。代码中把沙箱抽象成 `SandboxDriver` 接口（`create / exec / copyIn / copyOut / destroy`），以后换成 C 不影响上层。上线前用实际任务做一次兼容性和性能测试（第 9 节），如果 LibreOffice 或 Chromium 在 gVisor 下问题过多，这两项可以单独用 A + 严格 seccomp 并完全断网，Agent 仍用 B。

### 7.3 Agent 在沙箱中的运行方式

两种拆法：

1. Pi 运行时在 worker 中，只把七个工具的执行远程转发到沙箱；
2. **整个 Pi 运行时进沙箱**，worker 只做编排。

**建议第 2 种。**Pi SDK 的 `read/write/edit/grep/find/ls` 是直接操作本地文件系统的实现，拆成远程执行要改 SDK 内部；而桌面版已经有现成的结构：Pi 通过本机 HTTP 代理（`agent/agentOpenAiProxy.cjs`，监听 `127.0.0.1` 随机端口）访问模型，代理再转给 `aiService`。Web 版把这层代理换成 **AI 网关的沙箱入口**即可：

```
沙箱（网络只通 AI 网关）
  Pi 运行时 + 七个工具 + 工作区 /workspace
     │  HTTP，带任务令牌
     ▼
AI 网关（worker 内）── 解密 Key ──> 模型服务商
     │
     └─ 业务工具 RPC：OpenXml、ask-user、task-failure、JSON 校验、各 Task 的 createTools
```

- **任务令牌**：每个沙箱一个随机令牌，只在本任务存活期间有效，绑定 `job_id` 和 `org_id`，只能调用模型接口和本任务的业务工具 RPC；AI 网关按令牌上的 `job_id` 和 `org_id` 记账（第 10 节），沙箱无法冒充别的组织消费；沙箱内**没有任何 API Key、数据库连接串、对象存储凭据**；
- **业务工具**（`piOpenXmlTool`、`piUserQuestionTool`、`piTaskFailureTool`、各 Task 注入的工具）在沙箱内只是 RPC 桩，真正逻辑在 worker 中执行，worker 对每次调用重新做参数校验和归属校验；
- **工作区**：任务开始时 worker 从对象存储把所需文件放进沙箱的 `/workspace`；任务结束（或定期 checkpoint）时取回，取回时校验：只接受普通文件（拒绝符号链接、硬链接、设备文件）、路径在 `/workspace` 内、总大小和文件数在上限内、扩展名在白名单内。会话文件（`sessionsDir`）同样快照到对象存储，用于恢复；
- **提示词**：`agentToolEnvironment.cjs` 中写死的“Windows、PowerShell 5.1、不要用 `&&`”改为 Linux `/bin/sh` 的说明；`rg`、`fd`、`jq` 预装进沙箱镜像，不再注入 PATH。

### 7.4 沙箱的加固参数

不论选哪个选项，以下都要做到：

| 项 | 设置 |
|---|---|
| 镜像 | 固定镜像（按 digest 引用），只含 Node、Pi 运行时、`rg/fd/jq`、LibreOffice、中文字体、Chromium；不含编译器和其他多余工具（8.1：agent 镜像不含 LibreOffice、Chromium，渲染与转换在各自的专用沙箱中做，#70 确认，见第 7.10 节） |
| 用户 | 非 root（如 UID 10001），`--security-opt no-new-privileges`，`--cap-drop ALL` |
| 文件系统 | 根文件系统只读；`/workspace` 和 `/tmp` 为大小受限的可写卷（如 2 GB / 512 MB） |
| 资源 | CPU 1–2 核、内存 2 GB（无 swap）、`pids` 256、打开文件数上限 |
| 时长 | 单条命令超时（如 5 分钟）；整个任务的墙钟上限按任务类型设定 |
| 网络 | 解析 / 渲染类：`--network none`。Agent：只接入一个 `internal: true` 的专用网络，网络中只有 AI 网关入口；DNS 也只解析网关；显式屏蔽 `169.254.169.254`（8.1 实现为每个沙箱一个专用网络、只接入 `agent-gw`，网关地址写在 `/etc/hosts`，见第 7.10 节） |
| 挂载 | 不挂载 Docker socket、宿主目录、其他任务的卷；不注入宿主环境变量 |
| 生命周期 | 一个任务一个沙箱，结束即销毁，不复用；异常退出的沙箱由 sandbox-runner 定期清理 |
| 观测 | 记录每条 `bash` 命令（截断）、退出码、耗时到任务日志，供管理员排查；不记录文件内容 |

**sandbox-runner**：创建容器需要容器运行时权限，等同于宿主 root，所以只给一个独立的小服务。它只暴露“按预定义模板创建 / 销毁沙箱”的接口，模板（镜像、资源、网络、只读）写死在代码中，调用方只能选模板名和传入任务令牌，不能传任意 Docker 参数。worker 和 api 都不挂载 Docker socket。优先使用 rootless Docker 或 Podman 进一步降低风险。

### 7.5 实现（路线图 6.5）：解析沙箱

第 6 步先建本节的公共部分和断网的 `parse` 模板（路线图第 6 步“文件解析的隔离”方案 B），第 8 步在同一套机制上加 `agent` 模板（每个沙箱一个只通 `agent-gw` 的专用网络，见第 7.10 节；任务令牌见第 7.11 节（8.2a），`agent-gw` 见第 7.12 节（8.2b），AI 网关的工具调用见第 7.13 节（8.2c1），模型调用路由见第 7.14 节（8.2c2），业务工具 RPC 框架见第 7.15 节（8.4a））。

- **接口**：`SandboxDriver`（`server/src/sandbox/driver.ts`）的 `create / copyIn / exec / copyOut / destroy`。worker 用 HTTP 客户端（`client.ts`），sandbox-runner 用 Docker 实现（`docker.ts`）；换成微虚拟机时只换后者。
- **模板**（`templates.ts`）：镜像、网络、用户、只读、资源、可写目录、命令、取回规则都写死在代码中，调用方只选模板名；`parse` 的参数见第 7.4 节的表，取值为路线图第 6 步决定事项第 5 项的起步值。容器的主进程只是 `sleep`，命令经 exec 执行，超时或调用方中止时终止整个容器。
- **sandbox-runner**（`src/sandbox-runner.ts`）：唯一能访问容器运行时的服务，只在 internal 网络 `sandbox-control` 上监听（只有 worker 能连到；沙箱是 `--network none`，连不到它，有测试），每个请求在路由之前校验共享令牌（SHA-256 后 `timingSafeEqual`，缺失或不符 401）；生产环境不直接挂载完整权限的 Docker socket，经只放行必要接口并校验创建参数的 Docker API 代理或 rootless Docker（路线图第 9 步上线检查）；沙箱的模板、任务 id、到期时间写在容器标签中，每次操作核对标签，不是它创建的容器一律按不存在处理；到期的沙箱定期删除。生产环境只允许 `runsc`、镜像必须按摘要固定，启动时检查运行时已登记。
- **输入输出**：经 exec 中的 `tar` 传送（gVisor 下 `docker cp` 不能写入只读根文件系统上的 tmpfs）。取回的归档按第 7.3 节“工作区取回”的规则在 worker 中逐项校验（`archive.ts`），任一项不符整体拒绝；sandbox-runner 只转出并限制字节数，不解析沙箱的输出。放入的归档（worker 生成）在 sandbox-runner 中**流式**校验与转发（路线图 7.4a）：请求体不经 Fastify 缓冲，按模板的输入规则边读边校验，一个条目的头部只在通过校验后才转给沙箱内的 `tar`，文件内容按 64 KiB 分块转发，读入的字节数超过模板上限即中止；声明的 `Content-Length` 已超上限时不碰沙箱、直接 400；中途不符时之前的条目可能已放入，整个沙箱被终止（之后只能 destroy），返回 `SANDBOX_BAD_REQUEST`。sandbox-runner 的内存因此与放入的归档大小无关（parse 的输入至多约 192 MiB、export-document 至多约 128 MiB，export 队列并发 2）。worker 一侧同样**流式**生成归档（路线图 7.4e）：`copyIn` 接受内存中的文件或按需读取的文件（`SandboxStreamFile`：事先给出大小，轮到它时才打开，例如 `objectInputFile` 从对象存储读取整本导出的配图），生成之前一次校验全部条目（不合法时一个字节都不发送、一个对象都不读取），之后按顺序逐个打开、同一时刻至多一个，内容按源的分块原样发送，声明确切的 `Content-Length`；源产出的字节数与声明不符时为 `SANDBOX_BAD_REQUEST`，源出错（对象缺失、对象存储中断）时为 `SANDBOX_INPUT_FAILED`（`cause` 为源的错误），两者都使 sandbox-runner 收到被截断的归档、整个沙箱被终止；中止时直接销毁正在读取的源。worker 的内存因此也与放入的配图大小无关。接收请求的时限（路线图 #66）：Fastify 默认不限时，sandbox-runner 另设两项——放入归档时等待 worker 下一块数据超过 60 秒即销毁请求与连接（driver 随之中止、整个沙箱被终止，与 worker 断开相同；只在等待 worker 时计时，driver 向沙箱写入形成背压期间不计时）；接收整个请求不超过最长的放入时限（模板的 `transferTimeoutMs`，5 分钟）加 1 分钟。执行命令等处理本身的耗时不受这两项限制。关闭时（重启、部署）：Node 与 Fastify 默认只关闭空闲的 keep-alive 连接，已连接但还没发出请求的连接会让 `close()` 一直等到 `headersTimeout`；sandbox-runner 在在途请求处理完或等满 5 秒宽限期后关闭全部剩余连接，被截断的请求中止 driver、终止沙箱，进程正常退出（退出时限 10 秒）。连接异常与关闭时的收尾（中途断开、只关闭写方向、中途不合规或声明长度超限之后继续发送、停住、未发请求的连接、宽限期）由 `tests/sandbox/runnerDisconnect.test.ts` 逐项核对。
- **镜像**：`server/sandbox/parse/Dockerfile`，Node 24 + LibreOffice（Writer、Calc，无图形界面）+ 中文字体，删除包管理器和 setuid 位；解析入口和其 npm 依赖随 6.6 加入。
- **测试**：`npm run test:sandbox`（CI 中在 gVisor 下运行，含 LibreOffice 转换）逐项验证断网、只读、无能力、资源上限、超时、取回校验和沙箱之间不共享，并用去掉加固的对照组证明测试有效；LibreOffice 在 gVisor 下的耗时记录在 CI 日志中。

### 7.6 实现（路线图 6.6）：文档解析任务

- **任务**：`document-parse`（`server/src/parse/job.ts`），`parse` 队列。技术方案、废标检查、可研报告导入文件后每个新文件入队一个任务（`src/parse/enqueue.ts`），互斥键 `document-parse:{fileId}`。worker 只取原件、调用 sandbox-runner、校验结果、写产物，不运行任何文档解析器；
- **分派**：按 `files.mime`（上传时按内容决定）选择解析入口的 `format`（`src/parse/dispatch.ts`），不重新嗅探；只有 `text/html` 与 `application/xml` 按登记的扩展名区分 Word（`.doc` / `.wps`）与表格（`.xls`）；文本类格式见第 7.7 节；
- **解析入口**：`server/sandbox/parse/entry.mjs`，输入固定为 `/input/source`，输出 `/output/content.md`、`/output/images/*`、`/output/manifest.json`；docx / xlsx（含 LibreOffice 转出的 docx）先做 ZIP 炸弹检查（`zipGuard.mjs`：条目数、声明的总大小与压缩比，并按实际解压大小核对），PDF 先检查页数；失败只给错误代码；
- **结果校验**（`src/parse/output.ts`）：清单与文件一一对应、图片文件头与 MIME 一致、Markdown 为 UTF-8；图片引用只保留本次输出中的图片并改写为 `/api/artifacts/{id}/content`，引用缺失的图片整体拒绝，其他图片去掉；
- **写入**：图片和 Markdown 经 `writeArtifact`（配额检查），文档经各模块的 `saveDocumentParse` / `saveSourceParse` 写回；之前的产物经 `supersedeArtifacts` 标为已被替换（迁移 0023 的 `artifacts.superseded_at`），读取时不再返回，由清理任务删除；
- **沙箱生命周期**：每个任务一个沙箱，`finally` 中销毁；`SANDBOX_BUSY` 与 sandbox-runner 不可用按退避重试。时限：LibreOffice 转换 8 分钟（对整个进程组 SIGKILL）、解析命令 10 分钟（终止整个沙箱）、worker 请求 10 分 30 秒、沙箱最长存活 15 分钟（到期清理兜底）；
- **LibreOffice**：镜像中 `share/registry/zhibiao-security.xcd` 以 finalized 设置禁止宏、链接与域不在加载时更新、阻止不受信任的外部资源，用户配置不能覆盖。

### 7.7 实现（路线图 6.7）：文本类格式

RTF、HTML、MHT、Word 2003 XML、SpreadsheetML 在沙箱中先检查或清理，再交给解析器（`server/sandbox/parse/markupGuard.mjs`、`htmlSanitize.mjs`），细节与实测见路线图第 6 步“解析任务（二）”：

- **Office 2003 XML**：严格 UTF-8、必须有 XML 声明且编码为 UTF-8；除注释与 CDATA 外出现任何 `<!` 声明（DTD、实体等）即拒绝，含 XInclude 或 `xml-stylesheet` 即拒绝。不解析 DTD，因而不存在外部实体与实体膨胀；
- **RTF**：按组结构去掉域指令（`fldinst`）、OLE 对象（只留显示结果）、附加模板、子文档、字体文件、超链接目标、链接图片的形状属性；结构不合法或切分有歧义的写法拒绝；
- **HTML**：识别字符集后按元素与属性白名单重新生成，图片只留 `data:` 位图；任何远程或本地地址都不进入交给 LibreOffice / SheetJS 的文档（超链接只留 http / https / mailto，不会被加载）。实测 LibreOffice 在镜像的安全设置下仍会请求 HTML 中的样式表与 CSS 背景图片，所以清理是必需的，不是可选的纵深；
- **MHT**：自写的 MIME 解析（嵌套 8 层、部分 2,000 个、头部 64 KiB 的上限），取 HTML 部分按其编码与字符集解码，图片只在包内查找，地址从不跟随；之后按 HTML 处理；
- **转换**：Word 类由 LibreOffice 按指定的导入过滤器转成 docx（与 OLE Word 同一函数：独立进程组、8 分钟后对整个进程组 SIGKILL），表格类由 SheetJS 读取；
- **纵深**：沙箱完全断网（第 7.5 节）是兜底；远程资源测试在正式镜像中断言解析过程没有任何连接，对照组证明同一镜像中的 LibreOffice 对未经清理的 HTML 确实会发出请求。

### 7.8 实现（路线图 6.10a、6.10b）：标书查重任务

`duplicate-analysis`（`server/src/duplicateCheck/job.ts`），`ai` 队列（第 5.2 节），不调用模型，互斥键 `project:{projectId}:duplicate-check`：

- **提取在沙箱中**：每份招标、投标文件一个 parse 沙箱，解析入口加参数 `analysis=duplicate-check`（保留图片），除正文与图片外另写 `analysis.json`：逐文档的目录、句子（HTML 表格经 cheerio 读取）与图片位置（`server/sandbox/parse/duplicateText.mjs`、`duplicateTables.mjs`）。表格类格式的文件名由 worker 放入 `/input/title`，提取时作一级标题；
- **文档格式的元数据也在沙箱中**（6.10b）：每份投标文件先在一个只提取元数据的 parse 沙箱中读取（解析入口参数 `metadata=duplicate-check`，不转换正文，只写 `metadata.json`，`server/sandbox/parse/duplicateMetadata.mjs`）：docx 的 core / app / custom 属性与 rsid，老式 Word 的 OLE 属性集、存储结构、疑似账号痕迹与经 LibreOffice 转成 docx 后的属性，PDF 的 Info / XMP / 原始记录 / 结构 / 签名与附件。OLE 用镜像中 SheetJS 自带的 CFB、PDF 用已有的 pdf-parse，没有新增依赖。文档本身读取失败记为固定文字的 `metadata_error` 字段；worker 按不可信输入校验 `metadata.json`（键的规则、不能冒充文件基本信息或 Base64 解码项、字段数与长度上限、`metadata_error` 只能是固定文字），再并入文件基本信息之后。表格、纯文本类文件不开这个沙箱；
- **比对在 worker 中**（`src/duplicateCheck/analysis.ts`）：先按不可信输入校验 `analysis.json`（结构、数量、目录编号与父子关系、图片只能引用本次输出），再做招标原文白名单、目录重复 / 相似组与两两相似度、重复句、重复图片（按写入的图片产物内容的 SHA-256）。worker 不运行 HTML 解析器；
- **写入**：正文与图片经第 7.6 节的同一流程写为产物（`src/parse/run.ts`，两类任务共用），分析结果经 `saveAnalysisSection` 带任务开始时的文件选择签名写入，选择变化后写入被拒绝；重新选择文件、清空时取消进行中的任务。

### 7.9 实现（路线图 7.1）：导出沙箱

Word 导出与模板样张由 OpenXmlHelper 生成 docx，页眉页脚装饰 SVG 由 Chromium 栅格化成 PNG；两者处理的都是不可信输入，所以与文档解析复用同一套沙箱机制（第 7.5 节），每次导出一个 `export` 沙箱（路线图第 7 步决定事项第 1、2 项）。7.1 只建沙箱、镜像和入口；样张（7.3b 起）与整本导出任务（7.4）在其上接入。

- **模板**（`templates.ts`）：一个 export 镜像、按决定事项第 5 项的两档资源上限分成两个模板名。隔离参数与 `parse` 完全相同（`--network none`、gVisor、只读根文件系统、用户 10001、`cap-drop ALL`、`no-new-privileges`、`pids` 256、不挂载任何宿主目录、不注入宿主环境变量、不保留容器日志），有单元测试逐项核对：

  | 模板 | 内存（无 swap） | CPU | 命令墙钟 | 沙箱最长存活 | 输入（`/work`） | 可写目录（tmpfs） |
  |---|---|---|---|---|---|---|
  | `export-preview`（样张） | 1 GiB | 1 核 | 60 秒 | 5 分钟 | 至多 32 个文件、合计 64 MiB | `/tmp` 256 MiB、`/work` 192 MiB、`/output` 128 MiB |
  | `export-document`（整本导出） | 2 GiB | 1 核 | 20 分钟 | 35 分钟 | 配图至多 2,000 张 + 请求，单个 100 MiB、合计 128 MiB（7.4b） | `/tmp` 512 MiB、`/work` 384 MiB、`/output` 128 MiB |
  | `export-feasibility`（可研报告，7.5b） | 与 `export-document` 完全相同 | | | | | |

  可执行的命令只有 `export`（`node /opt/export/entry.mjs preview|document|feasibility`，模式由模板写死，不能追加参数）；取回只收 `document.docx` 和 `result.json` 两个普通文件，docx 不超过 100 MiB。

  tmpfs 计入内存上限（路线图 7.4b）：输入在 `/work`，助手写出的 docx 在 `/work` 的任务目录，入口再复制一份到 `/output`，助手写 docx 时的内存约为配图字节数的 2 倍（实测）。export-document 的输入合计因此定为 128 MiB（原为 1 GiB，2 GiB 内存下 512 MiB 以上的输入必然内存不足），与输出 docx 的 100 MiB 上限对齐——PNG / JPEG 等已压缩的配图在 docx 中几乎压不动，超过约 100 MiB 本来就会因 docx 过大而失败。worker 在新建沙箱之前按所引用配图的合计大小拒绝（7.4e）。
- **镜像**（`server/sandbox/export/Dockerfile`）：Node 24 + `playwright-core` 与其对应版本的 chromium-headless-shell + OpenXmlHelper 的 linux-x64 自包含发布（不裁剪；不打成单文件，单文件要把原生库解压到可写目录再加载，而 `/tmp` 是 noexec）+ Noto CJK 字体与 fontconfig 映射（模板可选的中文字体名按衬线 / 无衬线映射到 Noto Serif / Sans CJK SC，决定事项第 3 项）。装饰生成器与助手源码经具名构建上下文取自 `client/electron/shared/chrome` 与 `openxmlhelper/`，与桌面版同一份代码（测试逐个文件核对）。.NET SDK 只在构建阶段；删除包管理器和 setuid 位，与 parse 镜像、第 8 步的 Agent 镜像分开。
- **入口**（`entry.mjs`）：读 `/work/request.json`（受限 HTML、已规范化的 `export_format`、可选的 `asset_types`）与 `/work/assets/` 中的配图（只有一层，文件名就是 `data-app-asset-ref`；样张不接受，见下方 7.3b）→ 用装饰生成器生成页眉页脚 SVG → Chromium 栅格化（`render.mjs`）→ 运行助手一次（`openxmlhelper --workspace /work --run export`，独立进程组，超时对整个进程组 SIGKILL）→ 只把 docx 与只含已知字段的 `result.json` 写到 `/output`。失败时输出目录为空，只在标准输出给错误代码（参数不合法 64，导出失败 65），助手与浏览器的错误文字不外传。
- **Chromium**：**禁用 JavaScript**（浏览器上下文 `javaScriptEnabled: false`），关闭 Chromium 自身的沙箱（`--no-sandbox`，外层是本节的沙箱），每次截图一个新的浏览器上下文；页面固定尺寸、加载后直接截图，与桌面版 `renderExactHtmlToPng` 相同。第 8 步中必须执行脚本的渲染届时逐项由用户决定（决定事项第 9 项）。
- **助手的一次性运行模式**：`--run <任务编号>` 执行一个任务目录、写 `result.json` 后退出（0 成功、1 任务失败、2 参数不合法），与桌面版的常驻 stdin / stdout 模式共用 `JobRunner`，桌面版行为不变。
- **配置**：sandbox-runner 的 `SANDBOX_EXPORT_IMAGE`（生产必须按摘要固定）；7.3e 起必需（样张接口上线），未配置时 sandbox-runner 拒绝启动。
- **字体与装饰（7.2）**：`GET /api/fonts`（需要登录）返回模板可选字体名的固定清单 `{ fonts: string[] }`（`src/templates/fonts.ts`，与前端 `FONT_OPTIONS` 逐项相同，单元测试核对），取代桌面版枚举本机字体的 `systemFonts.list`；它不是服务器上安装的字体，导出的 docx 保留模板选择的原字体名（决定事项第 3 项）。装饰与桌面版逐项核对：同一页面配置（8 种样式 × 10 种变体、系统模板、未规范化的配置）在沙箱中由 `buildChrome` 生成的 SVG、几何、配色与文字层与宿主上的桌面版生成器相同；入口交给 Chromium 的 SVG 与尺寸、交给助手的 `chrome_assets` 与桌面版相同（Docker 测试经完整导出流程记录；源码级的字段对应关系另有不需要 Docker 的单元测试）。
- **样张的输入校验（7.3a）**：前端传来的样张 HTML 入队前经 `validatePreviewHtml`（`src/templates/previewHtml.ts`）校验：按与前端同一套白名单的 `parseRestrictedHtml`（`src/templates/restrictedHtml.ts`，parse5 实现，常量、提示文字与共用用例 `client/tests/fixtures/restrictedHtmlCases.json` 由两端测试核对）解析，不能有任何错误或警告，`data-app-asset-ref` 只能引用固定样张配图；只把重新序列化、不含 `src` 的 HTML 交给沙箱。`export_format` 入队前经 `normalizeExportFormat`（`src/templates/exportFormat.ts`，与桌面版逐项相同）补齐字段。
- **样张在沙箱中生成（7.3b）**：样张的固定配图（`client/assets/content-template-preview`，与桌面版同一份文件）打进镜像的 `/opt/export/preview-assets/`；`preview` 模式下 `/work` 中只能有 `request.json`、请求中不能有 `asset_types`，入口把样张配图复制到 `/work/preview/assets/`、助手的 `asset_root` 为 `preview`，样张中的 `data-app-asset-ref="assets/<文件名>"` 与桌面版相同。worker 端 `renderTemplatePreview`（`src/export/preview.ts`）：重新校验与规范化 → 新建 `export-preview` 沙箱（忙或不可用时短间隔重试）→ 只放 `request.json` → 执行 `export` → 取回 → 校验输出（`src/export/output.ts`：`result.json` 只取 `blockCount` 与告警的 `assetRef`；`src/export/docxGuard.ts`：docx 的 ZIP 结构检查，上限与 parse 的 zipGuard 相同、逐个条目实际解压核对声明大小、条目名必须是相对路径且不重复、必须有 `[Content_Types].xml` 与 `word/document.xml`）→ 销毁沙箱。失败只给按入口错误代码决定的 `EXPORT_*` 代码与提示。任务随 7.3d，接口随 7.3e。
- **样张的存储（7.3c，迁移 0027）**：样张结果存为产物种类 `template-preview`（docx），不属于项目或来源文件、带样张输入的哈希 `preview_sha256`（`preparePreviewRequest` 的 `request.json` 的 SHA-256），在本组织内可见、计入组织存储配额（0008 的 RLS 与配额函数不改）；同一组织内按哈希复用 23 小时内最近的结果，创建 24 小时后由清理任务删除（过期条件加进 0024 的清理函数与清理角色的 DELETE 策略）。样张请求表 `template_preview_requests` 保存校验、规范化后的 HTML 与配置（任务参数只放 id），只有创建者本人可见，结果产物 id 只能写一次，24 小时后由清理函数删除。读写见 `src/export/previewStore.ts`。
- **样张任务（7.3d）**：`template-preview` 任务（`export` 队列，组织级，不计费，可续跑），参数只有样张请求 id；以发起用户的身份读请求，重新准备一次且哈希必须与保存时相同，本组织 23 小时内同一输入的结果直接复用，否则经 `renderTemplatePreview` 生成并存为产物，最后写回请求的结果（`src/export/previewJob.ts`）。入队（`enqueueTemplatePreview`，7.3e 的接口调用）校验不通过时 400、不保存不入队；**取代旧请求**不用 `lock_key`：新建样张任务的同一事务中，按“组织 + 用户 + 任务类型”取事务级 advisory lock，再把本用户排队中的样张任务改为 `cancelled`（`cancelled` 事件带 `supersededBy`），运行中与暂停的不动（`src/jobs/store.ts` 的 `supersedeQueued`），同一用户任何时候最多一个排队中的样张。
- **样张接口与下载（7.3e）**：`POST /api/export-templates/preview`（`{ html, exportFormat, purpose? }`）按用户限流（`templatePreviewPerUser`，120 次 / 10 分钟，与登录类限流共用 Redis 计数），经 `enqueueTemplatePreview` 校验后入队，不通过返回 400、不入队，成功返回 202 `{ requestId, job, supersededJobIds }`；进度与结果经任务的 SSE 推送。`GET .../preview/:requestId` 返回 `pending` / `ready` / `expired`，`GET .../preview/:requestId/content` 以附件下载 docx（nosniff、sandbox CSP，文件名为“模板名_时间.docx”），前端交给 docx-editor 预览或保存；样张请求只有创建者可见，其他人的与不存在的一样 404，结果被清理后 410。`purpose: 'word'`（样张导出 Word）入队 `template-word-export`，执行与 `template-preview` 相同，但不参与“新请求取代旧请求”（取代只按同一任务类型），对应桌面版“固定使用本次导出的设置、不参与预览请求合并”。
- **整本导出的存储（7.4d，迁移 0028）**：整本导出的 docx 存为产物种类 `technical-plan-export`，必须属于项目、不能有来源文件和样张哈希，在本组织内可见、项目删除后不可见、计入组织存储配额（0008 的 RLS 与配额函数不改）。每个项目只保留最近一次：同一项目中已完成、未被替换的整本导出至多一个（部分唯一索引），新的导出完成时在同一事务中先按“组织 + 项目 + 种类”取事务级 advisory lock、把旧的标为已被替换（0023 的 `superseded_at`），再标记完成并检查配额；完成失败时整个事务回滚、旧的原样保留。被替换的立即过期、未被替换的创建 7 天后过期，由清理任务删除（过期条件加进 0024 的清理函数与清理角色的 DELETE 策略，清理角色的授权不变）。读写见 `src/export/documentStore.ts`（`findTechnicalPlanExport` 只返回 7 天内、未被替换的那一个）。任务随 7.4g，接口随 7.4h。
- **整本导出的请求（7.4f，迁移 0029）**：入队时取的快照与导出结果存在项目级表 `technical_plan_export_requests`（任务参数只有请求 id；参数 16 KiB、checkpoint 1 MiB 都放不下整本目录）。快照在一个事务中读取：目录的项目名称、模板范围、所选模板经 `normalizeExportFormat` 规范化后的配置，以及只含组装所需字段的目录（父节点与 AI 小节的正文不导出、不放进快照，组装结果与用完整目录组装的相同），之后对目录、正文、模板的修改不影响这次导出。没有目录、没有有效模板、标题超过六级、快照过大（目录 64 MiB）在入队前拒绝。挂在技术方案项目下、在本组织内可见，只能以自己的身份创建；结果（产物 id、提示、消息）只能写一次，完成时清空目录。每个项目只需要最近一次的请求，由入队（7.4g）删除本项目的其他请求，不需要清理角色。读写见 `src/export/documentRequestStore.ts`。
- **整本导出任务（7.4g）**：`technical-plan-export` 任务（`export` 队列，项目级，不计费，可续跑，`lock_key` 为 `project:{id}:technical-plan-export`），参数只有请求 id；入队（`enqueueTechnicalPlanExport`）取快照后入队，失败时删除刚保存的请求、成功后删除本项目的其他请求。执行时以发起用户的身份读请求，用 `assembleDocumentHtml` 组装，只把引用中本项目可见（RLS 下种类 `image`、已完成、未被替换、属于该项目）的图片产物以 `assets/<产物 id>` 经 `objectInputFile` 流式放入 export-document 沙箱（`asset_types` 取产物表的 MIME，不可见的由助手原位提示），新建沙箱之前按配图数量与合计大小（128 MiB）拒绝；结果存为 `technical-plan-export` 产物、经 `summarizeDocumentExport` 汇总提示并写回请求（`src/export/documentJob.ts`、`src/export/document.ts`）。WebP 配图（7.4i）由入口在沙箱内转成 PNG（与桌面版一致，兼容旧版 Word 和 WPS）：按文件头识别，动图取第一帧，Chromium（禁用 JavaScript）按原始像素栅格化成透明背景的 PNG；单张失败时原位提示；转换后的大小重新计入 128 MiB 的输入合计（`images_too_large`）与 100 MiB 的 docx 上限。样张不转换（与桌面版相同）。接口随 7.4h。
- **整本导出的接口（7.4h）**：`POST /api/projects/:projectId/technical-plan/export` 经 `requireProject` 校验项目后按用户限流（`technicalPlanExportPerUser`，30 次 / 10 分钟，在取快照之前计数），调用 `enqueueTechnicalPlanExport` 入队，202 `{ requestId, job }`；`GET .../export/:requestId` 返回 `pending` / `ready` / `expired`、下载文件名与大小、提示与消息；`GET .../export/:requestId/content` 以附件下载 docx（`nosniff`、sandbox CSP、`no-store`，api 从对象存储流式转发），文件名为“项目名称_YYYYMMDD_HHMMSS.docx”（同桌面版，按北京时间）。请求属于项目、本组织内可见，不属于路径中项目的与不存在的一样 404；未完成 409，产物被替换、清理或对象缺失 410。失败原因由任务的 SSE 给出（请求本身不记录失败）。
- **可研报告导出 Word 的生成（7.5b，#61 决定事项第 1 项方案 A）**：在 `export-feasibility` 沙箱（资源、隔离与输入输出上限与 `export-document` 完全相同）中运行与桌面版同一份的 `exportService.buildDocxResult`（`docx` 库直接生成，不经 OpenXmlHelper）：镜像经具名构建上下文 `desktop=client/electron` 复制它用到的 6 个文件与装饰生成器，依赖按 `server/sandbox/export/desktop/package-lock.json`（`client/package-lock.json` 中对应条目的原样截取）安装。入口的 `feasibility` 模式（`server/sandbox/export/feasibility.mjs`）只把 `project_name`、`outline`、`export_format`、`feasibility_options` 交给桌面版代码，注入 7.5a 的运行时：配图只认本项目产物地址（读 `/work/assets/<产物 id>`、按文件头识别类型）与 data URL，其他来源读不到、按桌面版的文字原位提示；WebP 与页眉页脚装饰由 Chromium（禁用 JavaScript）转换；正文中的原始 HTML 只由 cheerio 解析，不进浏览器。`result.json` 为 `{ version: 1, warnings }`，worker（`src/export/feasibility.ts` 的 `renderFeasibilityReportDocument`）只接受有界、不含控制字符的提示文字，消息与桌面版 `export.word` 相同。接口随 7.5e。
- **可研导出的存储（7.5c，迁移 0030）**：产物种类 `feasibility-report-export` 与整本导出的规则完全相同（必须属于项目、每个项目只保留最近一次、被替换的立即过期、未被替换的 7 天后过期、计入配额，过期条件写进清理函数与清理角色的 DELETE 策略）；项目级表 `feasibility_report_export_requests` 存入队时的快照（项目信息中的名称、所选模板规范化后的配置、导出选项与项目信息、只含导出所需字段的目录）与只能写一次的结果，读写见 `src/export/feasibilityStore.ts`、`src/export/feasibilityRequestStore.ts`。
- **可研导出任务（7.5d）**：`feasibility-report-export` 任务（`export` 队列，项目级，不计费，可续跑，`lock_key` 为 `project:{id}:feasibility-report-export`，与可研的生成任务互不影响），参数只有请求 id；入队（`enqueueFeasibilityReportExport`）取快照后入队，失败时删除刚保存的请求、成功后删除本项目的其他请求。执行时以发起用户的身份读请求，从快照正文中找出产物地址，只把本项目可见的图片产物经 `objectInputFile` 流式放入 export-feasibility 沙箱，结果存为 `feasibility-report-export` 产物并写回提示与消息（`src/export/feasibilityJob.ts`）。
- **可研导出的接口（7.5e）**：`POST /api/projects/:projectId/feasibility-report/export`（`{ templateId, options? }`，`options` 只接受桌面版的六个导出选项：三个布尔开关与编制单位、密级、文件编号三个不超过 500 字的文本，其他字段 400）经 `requireProject` 校验项目后按用户限流（`feasibilityReportExportPerUser`，30 次 / 10 分钟，与技术方案的分开计数，在取快照之前计数），调用 `enqueueFeasibilityReportExport` 入队，202 `{ requestId, job }`；状态与附件下载（`GET .../feasibility-report/export/:requestId` 与 `.../content`）的规则、响应头与错误码与整本导出的接口完全相同，文件名为“项目名称_YYYYMMDD_HHMMSS.docx”（项目名称为空时“可行性研究报告”，同桌面版）。
- **测试**：`tests/sandbox/docker/isolationSuite.ts` 是按模板参数化的同一套隔离用例（断网、只读、无能力、内存 / 进程数 / fork 炸弹 / 可写目录写满 / CPU / 超时 / 中止、取回校验、沙箱之间不共享，每项有去掉加固的对照组），parse 与两个 export 模板都跑；`export.test.ts` 另验证：恶意装饰中 7 种执行脚本的方式经完整导出流程都没有执行（对照组只把浏览器上下文改为允许 JavaScript，7 种都执行了）、装饰与受限 HTML 中的外部引用在沙箱中不被请求（对照组去掉 `--network none` 后装饰的外部引用确实被请求）、一次导出之后新的沙箱中看不到上一次的任何文件、导出结果中没有上一次的内容，以及错误代码与输出为空。CI 在 gVisor 下运行，样张与整本导出的耗时写在日志中。

### 7.10 实现（路线图 8.1）：agent 沙箱

Agent 任务的沙箱（路线图第 8 步“沙箱扩展”，决定事项第 1～3 项）。8.1 只建镜像、模板、每个沙箱一个的专用网络和隔离测试，不接模型；任务令牌与 `agent-gw`（8.2）、业务工具 RPC（8.4）、工作区快照（8.5）、Pi 运行时与入口（8.6）在其上接入。

- **模板**（`templates.ts`）：一个 agent 镜像、按任务墙钟分成两个模板名，隔离参数与 `parse` 相同（gVisor、只读根文件系统、用户 10001、`cap-drop ALL`、`no-new-privileges`、不挂载任何宿主目录、不注入宿主环境变量、不保留容器日志），只有网络不同，有单元测试逐项核对：

  | 模板 | 内存（无 swap） | CPU | `pids` | 任务墙钟 | 沙箱最长存活 | 可写目录（tmpfs） | 工作区（`/workspace`）的放入与取回 |
  |---|---|---|---|---|---|---|---|
  | `agent`（目录、全局事实、可研目录、模板提取） | 2 GiB | 1 核 | 256 | 30 分钟 | 45 分钟 | `/tmp` 256 MiB、`/workspace` 1 GiB | 文件数 ≤ 10,000、合计 ≤ 512 MiB、单个 ≤ 100 MiB、至多 8 层；取回只收普通文件和白名单扩展名（`md`、`txt`、`json`、`jsonl`、`html`、`mmd`、`svg`、`csv` 与 png / jpg / gif / webp），放入不限扩展名 |
  | `agent-content`（正文生成、章节重写、原方案还原） | 与 `agent` 完全相同 | | | 2 小时 | 135 分钟 | | |

  8.1 没有登记可执行的命令（入口随 8.6，命令墙钟即任务墙钟）；单条 `bash` 命令 5 分钟由入口执行，只是 Agent 自身的约束，平台的控制是命令与沙箱的墙钟、cgroup 上限和网络。快照的路径规则（桌面版工作区有中文文件名）见第 7.20 节（8.5b）。
- **网络**（决定事项第 2 项 B1，取代第 7.4 节与第 8.1 节的共用网络 `sandbox-gw`）：创建 agent 沙箱时，sandbox-runner 先建一个与容器同名的专用网络——`internal: true`（没有出口路由）、网桥不分配 IPv4 地址（`com.docker.network.bridge.inhibit_ipv4`，宿主在这个网络上没有地址，沙箱连不到宿主上监听所有地址的服务）、不开 IPv6、不做地址伪装，标签与容器相同（模板、任务、到期时间）——再只把配置的 `agent-gw` 容器（`SANDBOX_AGENT_GATEWAY`）接入；网络必须是 internal、此时只有 `agent-gw` 一个成员，否则删除网络、按不可用处理。`agent-gw` 的地址写进沙箱的 `/etc/hosts`（`agent-gw`），不配置 DNS：runc 下 Docker 的内置 DNS 只认得网络中的两个容器、内部网络不向外转发查询，gVisor 下内置 DNS 不可用。网关必须是正在运行、不带沙箱标签的容器（防止把一个沙箱接进另一个沙箱的网络）。沙箱销毁时先删容器、再断开 `agent-gw` 并删除网络（容器已不存在时也删）；到期的网络与容器一起由 sweep 删除；创建中途失败时删除已建的网络。不同沙箱的网络之间由 Docker 的网桥隔离规则隔开，`agent-gw` 不转发。沙箱总数上限（`SANDBOX_MAX_ACTIVE`）同时计入专用网络（8.2d）：带沙箱标签的容器与网络按名称合并计数（同一沙箱的容器与网络同名，只算一个；只剩网络的残留单独算一个），网络数因此不超过上限、不会耗尽 Docker 的地址池；生产的 `default-address-pools` 须能分配多于上限的子网（第 9 步上线检查）。
- **镜像**（`server/sandbox/agent/Dockerfile`）：Node 24 + `ripgrep`、`fd-find`（`fd` 链接到 `fdfind`）、`jq` 与 Debian 自带的 `/bin/sh`、coreutils，删除 npm / corepack / yarn 和 setuid 位；不含 Chromium、LibreOffice、OpenXmlHelper（偏离第 7.4 节，#70 确认）、编译器与网络工具。
- **配置**：sandbox-runner 的 `SANDBOX_AGENT_IMAGE`（生产必须按摘要固定）与 `SANDBOX_AGENT_GATEWAY`（`agent-gw` 的容器名）；Agent 任务上线（8.6）之前可选，未配置时创建 agent 沙箱返回 `SANDBOX_UNAVAILABLE`。
- **测试**：`tests/sandbox/docker/agentIsolation.test.ts`（CI 中在 gVisor 下运行）对 `agent` 模板跑与 parse / export 相同的一套隔离用例（只读、无能力、内存 / 进程数 / fork 炸弹 / 可写目录写满 / CPU / 超时 / 中止、取回校验、沙箱之间不共享文件，每项有去掉加固的对照组），另验证：网络只通 `agent-gw`（外网、DNS、`169.254.169.254`、Docker 网桥与宿主地址上的服务、`agent-gw` 在其他网络上的地址、另一个同时运行的 agent 沙箱都连不到；对照组为经 `/etc/hosts` 访问 `agent-gw` 的桩成功，以及去掉 `inhibit_ipv4` 后同一探测连到宿主）；专用网络的生命周期（随沙箱创建与删除、任务不符不删、到期清理、只剩网络的残留、创建失败不残留、网关未配置 / 不存在 / 是沙箱时拒绝）；逃逸面（`mount`、`unshare -m`、`unshare -n` 失败，没有 Docker socket；runc 下 `unshare -U -r` 也失败，gVisor 下用户命名空间在 Sentry 内实现、不碰宿主内核，只记录结果）与镜像内容（有 rg / fd / jq，没有浏览器、办公套件、OpenXmlHelper、Python）。driver 的失败路径另有内存桩的单元测试（`tests/sandbox/agentNetwork.test.ts`）。

### 7.11 实现（路线图 8.2a）：Agent 任务令牌

agent 沙箱访问平台的唯一凭据（路线图第 8 步“沙箱扩展”的任务令牌，决定事项第 1 项）。8.2a 只建令牌的存储、签发、作废与按令牌查身份，不接 `agent-gw` 与模型调用（8.2b、8.2c）。细化第 7.3 节“任务令牌”：令牌按每次执行（`run_id`）签发，而不是按沙箱；绑定的是任务的一次执行，组织、项目、发起用户与任务类型都从 `jobs` 现查。

- **格式**（`src/agent/token.ts`，不依赖数据库，`agent-gw` 只用其中的格式检查）：`agt_` 加 32 字节随机数的 base64url（共 47 个字符）；库中只存 SHA-256；日志中只记哈希的前 12 个十六进制字符（`agentTokenLogId`）。
- **存储**（迁移 0031，`agent_job_tokens`）：`org_id`、`job_id`、`run_id`、`token_hash`、`expires_at`、`revoked_at`，以复合外键挂在同一组织的任务上，随任务记录删除。强制 RLS：应用角色只能为本组织中 `running`、`run_id` 相符、未请求暂停、**属于项目**的任务写入（令牌只对本任务所属项目有效；组织级任务不签发，模板提取的归属在 8.13 确定后再开放）；每个任务最多一个未作废的令牌（部分唯一索引）；读不到 `token_hash`（没有该列的 SELECT 授权）；只有 `revoked_at` 的 UPDATE 授权，作废只能一次、时间由触发器取 `now()`（`AT001`）；没有 DELETE 授权。有效期至多 135 分钟（`agent-content` 沙箱的最长存活时间，CHECK 兜底，单元测试核对与模板一致）。
- **有效条件全部在查询时现算**（`agent_token_lookup(bytea)`，写法与 `auth_session_lookup` 相同，属主是专用的定义者角色 `bidtools_agent_auth`）：令牌未作废、未过期；任务仍是 `running`、未请求暂停、`run_id` 仍是签发时的那次执行、租约未过期；发起用户仍是该组织成员、账号正常；任务属于项目且项目未删除。因此任务结束、暂停（请求暂停即失效）、取消、被对账收回、续跑换执行者、发起人被移出组织或停用、项目删除时，令牌立即失效，不依赖应用代码记得作废；返回的到期时间取令牌与租约中较早者，角色是发起人当前的角色。撤销暂停请求（执行尚未停止）后同一执行的令牌恢复有效。无效的令牌一律返回 0 行，不区分原因。
- **定义者角色 `bidtools_agent_auth`**（新建，不复用 `bidtools_auth`，令牌查身份与登录、会话的权限互不扩大）：`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`，迁移角色以 `INHERIT FALSE, SET TRUE` 加入；只对 `agent_job_tokens`（`org_id`、`job_id`、`run_id`、`token_hash`、`expires_at`、`revoked_at`）、`jobs`（`id`、`org_id`、`project_id`、`user_id`、`type`、`status`、`pause_requested`、`run_id`、`lease_expires_at`）、`projects`（`id`、`org_id`、`deleted_at`）、`org_memberships`（`org_id`、`user_id`、`role`）、`users`（`id`、`status`）有列级 `SELECT` 和只对它生效的只读策略，没有表级授权，对计费、用量、凭据、会话等其他表没有任何权限。已加入 `server/db/init/10-provision.sh` 与测试 harness。
- **Store**（`src/agent/tokenStore.ts`）：`issueAgentJobToken(run, ttlMs)` 锁住任务行确认仍在本次执行中（任务不属于项目时抛 `AgentTokenProjectRequiredError`），作废该任务之前的令牌再写入新令牌，返回令牌原文（只交给沙箱模板注入 Pi 进程的环境）；`revokeAgentJobTokens(run)` 在沙箱销毁、执行结束时作废本次执行的令牌；`lookupAgentJobToken(token)` 格式不对不查库，返回的身份是令牌所代表身份的唯一来源；`agentTenantContext(identity)` 按发起用户建立业务读写的租户上下文（8.4）。
- **测试**：`tests/db/agentJobTokens.test.ts`——对照组（有效令牌查出完整身份）与每一种失效（作废、过期、租约过期、请求暂停、取消、成功 / 失败 / 余额不足暂停、续跑换执行者、发起人移出组织、停用、项目删除），签发条件（含组织级任务被拒绝、绕过签发写入的组织级令牌也查不到），直接写入时的 RLS、有效期与唯一约束，作废只能一次、不能改其他列与删除，用户间隔离，随任务删除，函数属主、`bidtools_agent_auth` 的角色属性与成员关系、列级授权恰为所需的列、对计费等其他表无任何权限、`bidtools_auth` 未被扩大；对查询函数中的暂停 / `run_id`、账号状态、租约、项目四个条件做过变异检查（去掉后对应用例失败）。`tests/agent/token.test.ts` 覆盖格式检查与日志标识。

### 7.12 实现（路线图 8.2b）：agent-gw 与 worker 的 Agent 内部入口

agent 沙箱访问平台的唯一入口（路线图第 8 步决定事项第 1 项 B）。8.2b 只建中继、worker 端的内部入口与部署，路由只有查询令牌状态的 `GET /v1/session`；模型调用（`POST /v1/chat/completions`，8.2c）与业务工具 RPC（8.4）在其上登记。

```
agent 沙箱 ──(专用 internal 网络，/etc/hosts: agent-gw)──> agent-gw:8080 ──(internal 网络 agent-relay)──> worker:3200（Agent 内部入口）
                                                         不持有平台凭据                                    先验中继密钥，再按令牌查身份（每个请求）
```

- **`agent-gw`**（`src/agent-gw.ts`、`src/agent/gateway.ts`）：与 api 同一镜像、不同入口。**不持有平台凭据**：只挂载这一跳的中继密钥 `agent_relay_key`（见下），环境中出现数据库密码、主密钥、对象存储密钥、Redis 密码或 sandbox-runner 令牌的配置（`AGENT_GATEWAY_FORBIDDEN_ENV`）即拒绝启动。只在 `agent-relay` 与 sandbox-runner 随沙箱接入的专用网络上，在所有接口的 8080 端口（`AGENT_GATEWAY_PORT`）监听。每个请求按顺序检查，任一项不符即拒绝、不转给 worker：
  1. 头部：请求行加全部头部 ≤ 8 KiB（431），10 秒内收齐头部（否则断开）；畸形请求行、重复的 `Content-Length`、`Content-Length` 与分块传输同时出现、非法字符由 Node 的 HTTP 解析器拒绝（400 并断开）；
  2. 路由：只有登记的方法与路径（`AGENT_GATEWAY_ROUTES`），其余 404，不自动生成 `HEAD`；查询串一律丢弃；
  3. 令牌：恰好一个 `Bearer agt_...` 且格式正确（`parseAgentBearer`，不查库），否则 401——此时还没有读取请求体，响应带 `Connection: close`；
  4. 并发：同一令牌同时进行的请求 ≤ 4（429），整个进程的连接数 ≤ 256；
  5. 请求体：不带请求体的路由不接受请求体（400）；带请求体的只收 `application/json`（415），≤ 路由的上限（兜底 8 MiB，超出 413，声明的长度超限时不读取），60 秒内收齐整个请求（否则断开）。不解析 JSON，原样转发；
  6. 转发：只带 `Authorization`、`Content-Type`、`Content-Length`、agent-gw 生成的请求 id 与 agent-gw 自己的中继密钥，沙箱发来的其他头部（含同名的中继密钥头部、`Cookie`、`X-Forwarded-For`、自称的组织 / 任务 / 用户、`Host` 等）一律不转；响应只回传状态码与 `Content-Type`、`Content-Length`、`Cache-Control`，响应体流式回传、不缓冲。连接 worker 超过 5 秒为 502，整个转发超过 `AGENT_GW_RESPONSE_TIMEOUT_MS`（默认 10 分钟）中止（尚未响应时 504）；沙箱断开时立即中止转给 worker 的请求。
  
  日志只记方法、路径、状态码、耗时与令牌哈希前缀（`tokenId`），不记令牌原文、请求体。
- **中继密钥**（#73 确认）：agent-gw 与 worker 之间一个专用共享密钥（`AGENT_RELAY_KEY` / `AGENT_RELAY_KEY_FILE`，至少 32 个字符，头部 `x-agent-relay-key`），只用于这一跳，不是平台的敏感凭据。worker 的内部入口**先**校验它（两边取 SHA-256 后 `timingSafeEqual`，常量时间），不带或带错的请求即使有有效的任务令牌也 401、不查库，响应与令牌是否有效无关。目的：网络配置出错、沙箱能直接连到 worker 时，沙箱也绕不过 agent-gw 的过滤。密钥与令牌一样不进日志（日志脱敏字段另加 `x-agent-relay-key`）。
- **worker 的 Agent 内部入口**（`src/agent/endpoint.ts`）：worker 设置了 `AGENT_ENDPOINT_PORT`（同时必须有中继密钥）时另开一个监听（与健康检查分开）。**请求体大小自己检查**、不只依赖 agent-gw：声明的长度超过上限（默认 8 MiB）时不读取直接 413（GET 也一样），分块传输的按读取的字节数检查。**每个请求都调用 `lookupAgentJobToken` 重新查身份、不缓存**，令牌失效（作废、过期、暂停、取消、换执行者、发起人移出组织、项目删除）后的下一个请求立即 401，各种无效一律同样的 401。令牌身份是唯一可信来源，后续路由经 `agentIdentityOf(request)` 取得；请求中自称的组织、任务、用户等字段不采信（不依赖 agent-gw 已剥掉这些头部）。`GET /v1/session` 只返回 `{ status, expiresAt }`，不返回组织、项目、用户等标识。接收时限同样有上限；日志记令牌哈希前缀与任务 id。
- **转给哪个 worker**：agent-gw 转给 `agent-relay` 上的 worker 服务地址（多副本时由 Docker 的服务名解析分配），不必是执行该任务的那个 worker：身份每次按令牌从数据库查出，模型调用（8.2c）与业务工具（8.4）都在 worker 中按身份无状态地执行。
- **部署**（开发 compose）：新增 `agent-gw` 服务（固定容器名 `bidtools-dev-agent-gw`，即 sandbox-runner 的 `SANDBOX_AGENT_GATEWAY`）与 internal 网络 `agent-relay`（只有 `agent-gw` 与 worker）；worker 设置 `AGENT_ENDPOINT_HOST` / `AGENT_ENDPOINT_PORT`（3200）；新 secret `agent_relay_key`（`init-dev-secrets.sh` 生成）只挂给 agent-gw 与 worker。生产部署时内部入口只绑定在 `agent-relay` 网络上的地址（第 9 步上线检查），中继密钥是第二道防线。
- **测试**：`tests/agent/gateway.test.ts`（worker 用 HTTP 桩代替）——对照组（转发、请求体原样、流式响应首块即时到达）与恶意样本：缺失 / 格式错误的令牌（9 种）、未登记的方法与路径（含 `HEAD`、`..`、`//`）、查询串、自称身份的头部与 `Cookie`、worker 的 `Set-Cookie` 不回传、超大头部、慢速头部、只连接不发送、超大请求体（声明长度与分块两种）、错误的内容类型、GET 带请求体、慢速请求体、请求体不完整、畸形请求与请求走私样本、同一令牌并发超限、沙箱中途断开时中止转发、worker 超时（504）与不可用（502，不回显地址）、日志中没有令牌与请求体；令牌检查、头部时限、查询串、并发上限、请求时限、响应头白名单各做过变异检查（去掉后对应用例失败）。`tests/db/agentEndpoint.test.ts`——中继密钥（不带、空、错一个字符、长短不同、大小写不同、放在其他头部，即使带有效令牌也 401；不带密钥时有效与无效令牌的响应相同；日志中没有密钥）、请求体上限（上限以内对照组、声明长度超限、分块超限、GET 声明超大，都由 worker 自己拒绝），中继密钥检查、声明长度预检、读取上限各做过变异检查；有效令牌（对照组）、无效令牌、作废 / 请求暂停 / 取消 / 移出组织后的下一个请求立即 401（与“不存在”相同）、伪造身份头部与查询串不影响结果、响应不含内部标识、经 agent-gw 的端到端用例、日志中没有令牌。`tests/config.test.ts` 覆盖两者的配置与凭据类变量拒绝启动。

### 7.13 实现（路线图 8.2c1）：AI 网关的工具调用

Pi 运行时经 OpenAI 兼容的 chat completions 调用模型，并依赖 function calling（`bash`、读写文件与各业务工具都是工具调用，桌面版 `agentOpenAiProxy.cjs` 把 `tools` 原样转给服务商）。现有网关只支持纯文本消息，8.2c 因此拆成两步：8.2c1 在网关中加入工具调用（本节），8.2c2 在 agent-gw 与 worker 的内部入口上加 `POST /v1/chat/completions`（按令牌取组织与任务、模型固定为组织选用的白名单模型）。8.2c1 不加路由，`client/` 与交互式 `/api/ai/chat`（仍只接受 system / user / assistant 文本消息）不变。

- **请求**（`ChatRequest`）：新增 `tools`（每个 `{ name, description?, parameters }`）与 `toolChoice`（`auto` / `none` / `required` / `{ name }`）；消息新增 `tool` 角色，assistant 消息可带 `toolCalls`（`{ id, name, arguments }`），tool 消息必须带 `toolCallId`。
- **校验**（`src/ai/tools.ts`，8.2c2 起这些内容来自 agent 沙箱，按不可信输入处理）：工具 1～128 个，名称 `^[A-Za-z0-9_-]{1,64}$` 且不重复，说明 ≤ 8 KiB，参数 schema 必须是只含 JSON 类型的普通对象、嵌套 ≤ 32 层、序列化 ≤ 64 KiB，全部工具合计 ≤ 512 KiB；工具选择只能与工具一起出现，指定的工具必须在列表中；只有 assistant 能带工具调用（每条 1～128 个，id 为 1～128 个可见 ASCII 字符），只有 tool 消息能带 `toolCallId`，且必须回应**前面**某条 assistant 消息中的调用 id。不合法时 400 `INVALID_AI_REQUEST`，不冻结、不调用服务商。发给服务商的请求体只由校验过的字段重新组装，消息与工具上的其他字段（自称的组织、Base URL 等）不转；只有工具调用的 assistant 消息 `content` 传 `null`。不用工具的请求体与之前完全相同。
- **流式输出**：`delta.tool_calls` 按 `index` 归并（`ToolCallAccumulator`），`id`、`name` 取第一次出现的非空值，`arguments` 依次拼接，汇总结果在 `ChatResult.toolCalls` 中返回，各段归位后经 `onDelta({ toolCalls })` 交给调用方（8.2c2 转成 OpenAI 格式的 SSE）。**结构由服务商负责**：`index` 不是 0～127 的整数或跳号、同一调用出现两个不同的 `id`、字段类型不对、结束时缺 `id`，按上游响应不合法处理（`invalid_upstream_response`，不收费，与截断的输出相同）。**内容由模型负责**：工具名不在列表中或带奇怪字符、同一调用后来出现不同的名称（保留第一次的）、`arguments` 不是合法 JSON，照常收费、原样返回，由 Pi 处理——否则提示注入可以让模型故意写坏工具调用来白用模型。
- **计费**：冻结的输入上界计入工具定义（名称、说明、参数 schema 的 UTF-8 字节）与对话中的工具调用、工具结果引用，另加有工具时整段工具说明 1,024 token、每个工具 64 token、每次工具调用 32 token 的模板开销（宽松上界，结算时多余部分释放）；服务商没有返回用量时的本地估算同样计入，输出估算计入工具调用的名称与 `arguments`；用户中途断开时按已产生的部分工具调用估算。不用工具的请求冻结额与之前相同。
- **步骤幂等**：请求内容（`request_hash`）包含工具定义、工具选择与消息中的工具字段；不带工具字段的消息与 8.2c1 之前的写法逐字节相同，升级前保存的步骤结果升级后仍能取回（有测试）。迁移 0032 给 `job_step_results` 增加可空列 `tool_calls`（jsonb 数组，1～128 项，序列化后不超过结果的字节上限；没有工具调用的步骤为 `NULL`），应用角色补这一列的 `INSERT` 授权，仍没有 `UPDATE` / `DELETE`，RLS 策略不变；续跑时带工具调用的步骤原样取回。
- **测试**：`tests/ai/tools.test.ts`（请求校验的对照组与 40 余种恶意样本、流式汇总的对照组与结构不合法样本、请求体只含校验过的字段、冻结上界）；`tests/db/aiGateway.test.ts`“工具调用（8.2c1）”（端到端汇总与分段、请求体、冻结额、不合法请求不冻结不调用、结构不合法不收费、模型写坏的工具调用照常收费、中途断开按部分工具调用估算）；`tests/db/jobBilling.test.ts`（带工具调用的步骤保存与取回、工具字段不同是新的调用、不用工具时 `request_hash` 与旧写法相同、`tool_calls` 的 CHECK 与授权）；`migrations.test.ts` 补回滚顺序。请求内容的工具字段、冻结上界中的工具定义、`toolCallId` 的引用检查、同一调用两个 `id` 的检查做过变异检查（去掉后对应用例失败）。

### 7.14 实现（路线图 8.2c2）：Agent 的模型调用路由

agent-gw 登记 `POST /v1/chat/completions`（请求体上限 4 MiB，`AGENT_CHAT_MAX_BODY_BYTES`，agent-gw 与 worker 内部入口各自执行），worker 内部入口上的路由（`src/agent/chatCompletions.ts`）经 AI 网关调用模型。只实现 Pi（`@earendil-works/pi-ai` 的 `openai-completions`）在本平台配置下发送的 OpenAI 兼容**流式子集**，请求按攻击者的输入处理：

- **身份只按令牌**：组织、发起用户（`TenantContext`）、任务与任务类型取自 `agentIdentityOf`；请求体 schema 不允许未登记的字段，`org_id`、`project_id`、`job_id`、`user_id`、`provider`、`base_url`、`api_key`、`headers`、`extra_body` 等一律 400，不冻结、不调用服务商；头部中自称的身份不读取（agent-gw 也不转发）。
- **模型固定**：组织在设置中选用的平台模型（`resolveJobModel`，没有选择时 409 `AI_MODEL_NOT_CONFIGURED`），白名单与定价由网关再检查；请求中的 `model`（OpenAI SDK 必带）只校验格式、不采信。`max_tokens` / `max_completion_tokens`（只能给一个）截到平台上限 `AI_MAX_OUTPUT_TOKENS`，不给时取平台上限。
- **接受的字段**：`messages`（1～2,000 条；system / user 的 `content` 为字符串或文本分段（≤ 256 段，不接受图片）；assistant 的 `content` 可为 `null` 或省略，可带 `tool_calls`；tool 消息必须带 `tool_call_id`）、`stream`（必须为 `true`）、`stream_options.include_usage`、`temperature`（0～2）、`tools`（`strict` 只接受 `false`，空数组按不提供工具处理）、`tool_choice`、`store`（只接受 `false`）。不接受 `reasoning_content`、tool 消息的 `name`、`n`、`response_format` 等。不做类型转换（`"100"` 不当作数字），`__proto__` 键拒绝。工具字段的细节先按 8.2c1 的规则（`assertToolRequest`）检查一次，网关调用时再检查一次。
- **计费与幂等**：`source = 'job'`，步骤键固定为 `agent:chat`；网关的步骤幂等键本来就含请求内容的 SHA-256，因此同一任务、同一请求内容就是同一步骤，续跑时 Pi 重发同一请求取回已保存的结果，不再冻结、不再扣费。并发名额一直排队等待，直到沙箱断开或 worker 关闭。
- **响应**：第一段输出到达时才开始 SSE（`text/event-stream`，OpenAI 的 `chat.completion.chunk` 格式，第一块带 `role: assistant`，工具调用转回 `delta.tool_calls`），之后是带 `finish_reason` 的结束块、（要求时的）用量块和 `[DONE]`；取回已保存的结果时一次给出全部内容与工具调用。开始推送前的失败（余额不足 402、模型未选择 409、上游失败等）按普通 JSON 错误返回，开始推送后的失败以 `data: {"error": ...}` 结束、不发 `[DONE]`，非业务错误只返回通用文案。余额不足、模型未选择或不可用时先按令牌的执行记下拒绝原因（8.6d3，第 7.29 节），供执行者判断。思考内容照常计费但不转给沙箱。响应中不含组织、项目、用户、执行等内部标识。
- **中止**：沙箱断开（agent-gw 随之中止转发）按已产生的用量收费（与用户取消相同）；worker 关闭时内部入口先以 `shutdown` 中止进行中的调用（不收费，`platform_interrupted`），至多等 5 秒释放冻结，再关闭全部连接（`forceCloseConnections`，agent-gw 的空闲长连接不拖住关闭）。
- **任务上限（8.3a）**：每个请求先计入本任务的一轮（含取回已保存结果的），费用上限在冻结时检查，见第 10.11 节。
- **测试**：`tests/agent/chatCompletions.test.ts`（网关用桩代替：Pi 请求形状的对照组、转换结果、SSE 格式、33 种顶层与 18 种消息级恶意样本、上限、失败与断开）；`tests/db/agentChat.test.ts`（真实数据库与 AI 网关、本机模拟服务商、经 agent-gw：按令牌记账、模型不采信、伪造字段与头部、步骤幂等、令牌无效与暂停、余额不足、请求体上限、断开与关闭的计费、日志中没有令牌与 Key）。顶层字段白名单、`max_tokens` 截断、关闭不收费、模型不采信、任务只按令牌做过变异检查。

### 7.15 实现（路线图 8.4a）：业务工具 RPC 框架

agent-gw 登记 `POST /v1/tools/call`（请求体上限 1 MiB，`AGENT_TOOL_MAX_BODY_BYTES`，agent-gw 与 worker 内部入口各自执行），所有工具共用这一个路径，请求体只有 `{ name, arguments }`。worker 内部入口上的路由（`src/agent/tools.ts`）按以下顺序处理，请求按攻击者的输入处理：

1. **工具名**：只接受登记过（`src/agent/toolRegistry.ts`）、且本任务类型在 `JobTypeDefinition.agentTools` 中列出的工具；未登记与本任务类型不可用的一律 404 `AGENT_TOOL_NOT_FOUND`（响应相同），不执行、不计入。worker 启动时检查各任务类型列出的工具都已登记。
2. **调用次数与频率**（迁移 `0037_agent_tool_calls`）：每个任务、每个工具一行计数，一条 `INSERT ... ON CONFLICT DO UPDATE` 原子地检查并加 1——任务仍是本次执行（`running`、`run_id` 相符）且登记了 Agent 上限、累计次数 < 工具的 `maxCallsPerJob`（跨执行累计）、当前一分钟窗口内 < `maxCallsPerMinute`；否则 429 `AGENT_TOOL_CALL_LIMIT` / `AGENT_TOOL_RATE_LIMIT`，或 409 `JOB_NOT_RUNNING`。**参数不合法的调用同样计入**（防止靠无效调用空耗 worker）。计数表强制 RLS，应用角色只能写入标识列、只能更新计数列，没有 DELETE；触发器 `AT101` 保证次数只能逐次加 1、窗口只能计数或从 `now()` 重新开始、标识不能改。
3. **参数**：先按序列化后的字节数检查工具自己的 `maxArgumentBytes`（413），再按工具登记的 schema 校验（不做类型转换；400 `AGENT_TOOL_INVALID_ARGUMENTS`，说明只含参数中的位置与 schema 的要求，供模型修正，不回显请求内容）。schema 在登记时检查必须**封闭**：只允许 `type`、`properties`、`required`、`additionalProperties`（必须为 `false`）、`items`、`minItems` / `maxItems`、`uniqueItems`、`minLength` / `maxLength`、`pattern`、`format`（只有 `uuid`）、`enum`、`const`、`minimum` / `maximum`、`anyOf`、`description`；每个对象 `additionalProperties: false`，字符串必须有 `maxLength`，数组必须有 `items` 与 `maxItems`，嵌套 ≤ 16 层。因此请求中自称的 `org_id`、`project_id`、`job_id`、`user_id` 等字段（顶层或参数中）都是 400。
4. **身份只按令牌**：处理函数拿到的上下文是令牌身份（组织、项目、任务、执行、发起用户、任务类型）与据此建立的 `TenantContext`（发起用户当前的角色与 RLS），以及数据库连接、中止信号与日志；头部中自称的身份不读取。
5. **资源标识重新解析**：参数中的资源标识是不可信输入，处理函数在 `withTenant` 中按令牌的项目重新解析；8.4a 提供格式检查 `parseAgentResourceId`（小写 UUID）与产物的解析 `resolveProjectArtifact`（属于令牌的项目、已完成、未被替换），查不到一律 404 `AGENT_RESOURCE_NOT_FOUND`，不区分“不存在”“其他项目”“其他组织”。其他资源（目录节点、小节、模板等）的解析随使用它们的工具加入，规则相同。
6. **结果与错误**：响应 `{ result }`（序列化后 ≤ 4 MiB，超出按内部错误）；处理函数抛出 `AppError` 原样返回，其他错误只返回通用文案。沙箱断开、worker 关闭时经中止信号通知处理函数。日志只记工具名、任务 id、令牌哈希前缀、耗时与结果码，不记参数与结果。

8.4a 只有框架；`report-failure`（8.4b，见第 7.16 节）已登记，ask-user（8.4c）与各任务的业务工具随后在 `toolRegistry.ts` 中追加。处理函数的上下文另有 `notifyExecutor()`（8.4b），经任务控制频道通知执行者立即续租一次。

- **测试**：`tests/agent/tools.test.ts`（工具名、上限、26 种不封闭的 schema 与对照组、请求体 schema、资源标识格式、任务类型登记的工具、agent-gw 路由）；`tests/db/agentTools.test.ts`（20 个用例，真实数据库，经 agent-gw：对照组与身份、伪造身份字段与头部、令牌失效、未登记与不可用的工具、参数类型 / 必填 / 范围 / 字节上限、本项目 / 其他项目 / 其他组织 / 未完成 / 已替换 / 不存在 / 格式不对的产物 id、累计次数与 20 个并发、频率窗口、计数的 RLS / 授权 / `AT101`、处理函数出错与中止、日志、回滚）。任务类型的工具白名单、次数上限、频率上限、`run_id` 条件、参数字节上限、产物解析的项目 / 状态 / 替换条件做过变异检查。

### 7.16 实现（路线图 8.4b）：Agent 报告无法继续

业务工具 `report-failure`（`src/agent/reportFailureTool.ts`）供 Agent 报告无法按要求继续的原因，与桌面版 `piTaskFailureTool.cjs` 的“直接报告”相同；“由用户决定是否终止”是另一个工具 `request-termination`（8.4c2，第 7.18 节），一个任务类型只登记两者之一。

- **参数**：只有 `reason`（1～500 个字符）。原因是沙箱给出的不可信文本，服务端规范化为纯文本（`normalizeAgentFailureReason`：去掉控制字符、双向文本控制与零宽字符，合并空行，首尾去空白，按码点截断），为空时 400；只作为纯文本保存与显示，不转义、不解析。
- **存储**（迁移 `0038_agent_failure_reports`）：每次执行（`run_id`）至多一行，只记第一次；强制 RLS，只能为本组织 `running`、`run_id` 相符的 Agent 任务写入，没有 UPDATE、DELETE；随任务删除。
- **报告之后**：本次执行的模型调用（`beginAgentTurn`）与工具调用（`beginAgentToolCall`）一律 409 `JOB_NOT_RUNNING`，不计入轮数与次数。
- **结束**：工具写入后经任务控制频道通知执行者；`renewRun` 返回 `agentFailureReported`，执行者中止本次执行。`finishRun` 中本次执行有报告时，除成功外的任何结果都以 `AGENT_REPORTED_FAILURE` 失败（`error_message` 为报告的原因，已请求取消的仍为取消）；执行者失联后由对账收回时同样失败、不再续跑。任务结束即令牌失效。
- **显示**（第 9 步，#83 确认）：`AGENT_REPORTED_FAILURE` 的失败说明标注为“AI 给出的说明”，前端按纯文本显示，不自动识别链接、电话、邮箱（威胁模型 T10、T11）。

### 7.17 实现（路线图 8.4c1）：Agent 向用户提问

业务工具 `ask-user`（`src/agent/askUserTool.ts`、`src/agent/questions.ts`）对应桌面版 `piUserQuestionTool.cjs`：Agent 在关键事项无法从材料中确定时提一个问题、等用户回答。

- **参数**（与桌面版相同）：`question`（≤ 2,000 个字符）与 2～5 个 `options`（`label` ≤ 60、`description` ≤ 300、`custom`）。问题与选项是沙箱给出的不可信文本，服务端规范化为纯文本（问题保留分行，选项为单行；去掉控制字符、双向文本控制与零宽字符）；第一项是推荐项且不能要求输入、至多一个自定义输入选项、名称不重复，否则 400。
- **存储**（迁移 `0039_agent_questions`）：每个问题一行，每个任务同时至多一个未关闭（`pending` / `answered`）的问题；`content_hash` 是规范化后问题与选项的 SHA-256。状态只能 `pending → answered → consumed`，另有续跑时新执行接手（`pending → pending`，重新计时）与作废旧执行的问题（`→ superseded`），由触发器 `AQ001` 强制：回答人限本组织成员中的任务发起人或 `owner` / `admin`（没有用户上下文一律拒绝），答案只能交给任务当前的执行，关闭后不能再改；回答人与各时间由触发器填写。强制 RLS，只能为本组织 `running`、`run_id` 相符的 Agent 任务提问，没有 DELETE，随任务删除。`jobs.pause_reason` 新增 `waiting_for_user`。
- **等待**：一次工具调用至多等 50 秒（短于 agent-gw 的转发时限），每秒查一次；已回答即返回 `{ answered: true, answer, selected_option, is_custom }`（与桌面版相同），否则返回 `{ answered: false, pending: true }`，沙箱内的桩以相同参数再次调用继续等待（8.6）。同一次执行中重复提出同一个问题不新建；本次执行已有另一个问题在等待时 409 `AGENT_QUESTION_PENDING`；任务不在本次执行中 409 `JOB_NOT_RUNNING`。工具上限：每个任务 2,000 次、每分钟 20 次；每次等待调用都计入（一个问题等到超时约 13 次），但工具调用不计入模型轮数、不产生费用。用户的自定义回答至多 2,000 个字符，经同样的纯文本规范化后交给 Agent。
- **超时**：`renewRun` 返回 `agentQuestionExpired`（本次执行的问题等待超过 `AGENT_QUESTION_TIMEOUT_SECONDS` = 10 分钟），执行者中止本次执行，`finishRun` 暂停为 `waiting_for_user`（释放沙箱与并发名额，令牌失效，之后的等待不计入每日运行时长）；暂停前问题刚好被回答的按中止收尾（回到 `queued`），已请求暂停 / 取消的按请求收尾。这样暂停的任务普通的“继续”返回 409 `JOB_ANSWER_REQUIRED`。
- **回答**：`POST /api/jobs/:jobId/answer`（`{ questionId, optionIndex, customAnswer? }`），限任务发起人或 `owner` / `admin`（其他成员 403 `JOB_ANSWER_FORBIDDEN`）；选项序号越界、自定义选项没有输入、普通选项带输入 400，问题已回答或已作废 409，任务已结束 409。任务因等待超时暂停时，回答后回到 `queued` 并派发（照常检查最低启动余额与当日运行时长，不足时什么都不改），续跑时 Agent 再次提出同一个问题（按 `content_hash`）立即取回答案；续跑中提出了不同的问题时旧问题作废。回答写入任务事件（不含回答内容）。
- **推送与读取**：SSE 新增 `job.question` 事件（`{ jobId, projectId, type, questionId, status }`，不含问题内容）；`GET /api/jobs/:jobId` 返回 `pendingQuestion`（问题、选项、提问时间与执行中超时暂停的时间）。
- **显示**（第 9 步）：问题与选项标明“由 AI 生成”、按纯文本显示（`allowRawHtml={false}`、`linkMode="text"`），提示“不要在此输入密码等敏感信息”（威胁模型 T10）。

### 7.18 实现（路线图 8.4c2）：Agent 请求终止、由用户决定

业务工具 `request-termination`（`src/agent/requestTerminationTool.ts`）对应桌面版 `piTaskFailureTool.cjs` 的 `requestTerminationDecision` 分支：Agent 判断无法按要求继续时请求终止，是否终止由用户决定。

- **与 `report-failure` 二选一**：失败交回父 Agent 的任务（桌面版 `failure_handled_by_parent`）登记 `report-failure`（第 7.16 节，直接报告）；其余任务登记 `request-termination`。`createJobTypeRegistry` 拒绝同时登记两者的任务类型（否则被注入的 Agent 可以绕过用户的决定直接结束任务）。沙箱内面向模型的工具名仍为 `report-failure`，桩按任务类型登记的工具转发（8.6）。
- **参数**：只有 `reason`（与 `report-failure` 相同，1～500 个字符，按纯文本规范化，为空 400）。问题与三个选项（“降低质量继续”（推荐）、“终止任务”、“补充处理要求”（自定义输入））由服务端按桌面版的固定文字生成，Agent 不能提供或修改选项。
- **提问与等待**：经第 7.17 节的同一套存储、等待、超时暂停与回答接口（`agent_questions`、`POST /api/jobs/:jobId/answer`、`job.question`）；未回答返回 `{ answered: false, pending: true }`，桩以相同参数再次调用；本次执行已有另一个问题在等待 409 `AGENT_QUESTION_PENDING`。上限：每个任务 300 次、每分钟 20 次（一次请求等到超时约 13 次调用）。
- **用户选择终止**：在取回答案的同一个事务中（任务行已锁住，仍是本次执行且没有报告）写入失败报告（第 7.16 节的 `agent_failure_reports`，原因后附“（已按您的选择终止任务）”，原因截短使合计不超过 500 个字符）；写入失败时整个事务回滚，问题仍为已回答，下次调用重试。随后通知执行者，任务以 `AGENT_REPORTED_FAILURE` 失败；工具返回 `{ terminated: true, reason }`。
- **用户选择继续**：返回 `{ terminated: false, selected_option, user_reply?, instruction }`，`instruction` 是放宽后的执行要求（桌面版 `buildContinueInstruction` 的文字，补充要求附在最后）；不写报告。之后再次请求终止仍新建问题、由用户回答（桌面版此时不自动作答；Web 版没有自动确认，自然满足）。
- **续跑**：等待超时暂停后回答，续跑时 Agent 以相同的 `reason` 再次请求即取回答案（按 `content_hash`）；选择终止的报告记在新的执行上。

### 7.19 实现（路线图 8.5a）：Agent 工作区快照的存储

工作区保存方式按决定事项第 12 项 C：业务结果入库与产物，中间文件与 Pi 会话文件存为**每个项目、每类任务一个**快照，只用于续跑，丢失不影响已生成的结果。8.5a 只建存储（迁移 0040、`src/agent/workspaceSnapshots.ts`），从沙箱取回与放入（8.5b）、检查点与续跑（8.5c）在其上接入。

- **表** `agent_workspace_snapshots`：项目级（复合外键、不级联），`task_kind` 由服务端按任务类型给出；对象键为生成列 `org/{org}/agent-workspaces/{id}`；文件数 ≤ 10,000，归档 ≤ 512 MiB 加每个文件 1 KiB 的 ustar 头部与对齐（决定事项第 13 项）。不作为产物：不出现在产物接口中、不提供下载。
- **写入**：登记 `writing` → 流式写对象（服务端计算大小与 SHA-256，超过上限即中止，413 `AGENT_WORKSPACE_TOO_LARGE`）→ 同一事务中替换同一项目、同一类任务当前的快照并完成（触发器检查组织存储配额，超出 413 `STORAGE_QUOTA_EXCEEDED`；登记超过 24 小时不能完成；完成后不能改、只能被替换一次）。失败时删除新对象与登记行，旧快照原样保留；成功后立即先删旧对象、再删旧行，失败的留给清理任务。部分唯一索引保证至多一个当前的快照。
- **读取**：`openWorkspaceSnapshot` 核对大小与 SHA-256（对象缺失、截断、多出字节、篡改都抛错，多出的字节不交给调用方）；归档内容的逐项校验（只收普通文件、路径、扩展名、数量与大小）在取回时与放入沙箱前各做一次（8.5b，第 7.20 节）。
- **隔离与配额**：强制 RLS，本组织、所属项目未删除才可见可写；应用角色只能删除写入中或已被替换的行。配额函数 `files_org_usage_bytes` 加上已完成的快照（项目在恢复期内照常计入）。
- **清理**：写入中超过 24 小时、已被替换、所属项目超过恢复期的快照由清理任务先删对象、再删行（新增 `cleanup_agent_workspace_candidates` / `cleanup_delete_agent_workspace` 与清理角色的 DELETE 策略）；项目要等其下的快照删完才删除；孤儿对象的判断包括快照的键。

### 7.20 实现（路线图 8.5b）：工作区快照的取回与放入

快照是 agent 沙箱整个 `/workspace` 的 tar 归档（Pi 会话文件由 8.6 的入口放在其中）。沙箱内与对象存储中的内容都不可信，校验两次（`src/agent/workspaceSandbox.ts`）：

- **路径规则**（agent 工作区的 `pathSegments: 'unicode'`，parse / export 仍只收 ASCII）：UTF-8 严格解码；每段必须是 NFC，字符限于字母、数字（含汉字）、ASCII 的 `. _ - ( )` 与少量中文标点，首字符为字母、数字或左括号类；拒绝控制、格式（零宽、双向控制、BOM）、空白、默认可忽略等字符，NFKC 后再查一次分隔符与 `.`；每段 ≤ 100、整条 ≤ 255 个 UTF-8 字节且能写进 ustar 的 prefix + name；重复与文件 / 目录冲突按 NFKC + 大小写折叠判断。
- **取回**：driver 的 `copyOutArchive` 按取回规则逐项校验沙箱内 tar 的输出，只用普通文件重新生成归档（头部由平台生成、不带扩展头），边取回边写入快照；任何一项不符整体拒绝（`SANDBOX_OUTPUT_REJECTED`），旧快照保留。worker 经 HTTP 时在 worker 端校验。
- **放入**：核对大小与 SHA-256，再按取回规则（含扩展名白名单）重新校验与生成，文件数须与记录相同，源读完后才产出结束块；出错时销毁沙箱（`SANDBOX_INPUT_FAILED`）。sandbox-runner 照常按模板的放入规则再校验一次。

### 7.21 实现（路线图 8.5c）：工作区快照接入续跑

任务类型登记 `agentWorkspace: { taskKind, keepAfterSuccess? }`（只有 agent 队列，类别规则同 0040 的 `task_kind`，几个任务类型可以共用一个类别）后，执行者给任务上下文提供 `context.agentWorkspace`（`src/agent/workspaceJob.ts`；任务不属于项目、worker 未配置对象存储或 sandbox-runner 时为 `null`）。组织、用户与项目一律取自任务记录。

- **检查点** `saveCheckpoint(sandbox, checkpoint, progress?)`：先取回 `/workspace` 保存为快照（第 7.20 节），成功后再保存 `jobs.checkpoint`。快照保存失败时 checkpoint 不前进、旧快照保留，二者仍是上一个检查点的一对。
- **超出组织存储配额**：抛 `JobStorageQuotaError`，执行者把任务暂停为 `storage_quota`（迁移 `0041_job_pause_storage_quota`，任务吞掉错误也照样暂停），之后本次执行的检查点不再取回；用户删除文件后经普通的“继续”从上一个检查点续跑。
- **工作区不符合规则**（`SANDBOX_OUTPUT_REJECTED`）：任务以 `AGENT_WORKSPACE_REJECTED` 失败，失败说明只写类别（文件类型、链接或特殊文件、命名、数量或大小、归档格式），不含文件名与内容；不自动改名、不跳过文件。超过快照大小上限以 `AGENT_WORKSPACE_TOO_LARGE` 失败。
- **恢复** `restore(sandbox)`：由任务（8.6 的入口）在续跑、创建沙箱后调用；没有快照返回 `null`。快照不可用（`SANDBOX_INPUT_FAILED`，沙箱已被销毁）时丢弃该快照，任务以 `AGENT_WORKSPACE_RESTORE_FAILED` 失败，不自动从头开始（从头开始会重新调用模型、重新扣费，由用户决定是否重新发起）。
- **丢弃**：任务成功完成后执行者丢弃该类别的快照（`keepAfterSuccess` 的除外，供之后的同类任务接着用，例如调整沿用生成的会话），失败只写日志；用户重置某类任务时由业务的重置入口调用 `discardAgentWorkspaceSnapshots`（8.7 起接入）。

### 7.22 实现（路线图 8.6a）：agent 沙箱的入口与请求通道

worker 经 sandbox-runner 执行 agent 模板登记的唯一命令 `run`（`node /opt/agent/entry.mjs`，不接受参数；命令墙钟即任务墙钟：`agent` 30 分钟、`agent-content` 2 小时）。

- **请求只经标准输入**：模板命令新增 `maxInputBytes`（只有 agent 的 `run` 为 1 MiB，其余命令为 0、带了即拒绝）；`SandboxDriver.exec` 的 `input` 经 sandbox-runner 的 `POST /v1/sandboxes/:id/exec`（`input` 为严格的 base64）转为 exec 的标准输入。任务令牌只在请求中，不出现在 argv、容器环境（模板写死的三项）、Docker 记录的 exec 参数、工作区与 sandbox-runner / worker 的日志中；入口不把令牌放进自己的环境（之后由入口启动的 Agent 命令不会继承它）。令牌是本沙箱访问平台的凭据，沙箱内的代码（含 Agent）能拿到它不扩大权限（只对本任务、本次执行有效），所以这里的要求是“不落盘、不进日志、不进参数”，不把它当作对沙箱保密的秘密。
- **协议**（`server/sandbox/agent/protocol.mjs`，只用 Node 内置模块）：请求为一个 UTF-8 的 JSON 对象，字段恰好是登记的那几个（版本、`action`、令牌），多余的一律拒绝；结果为标准输出上恰好一行 JSON，至多 16 KiB，退出码 0 表示成功、1 表示按协议报告的失败，失败只有固定代码（`BAD_REQUEST` / `TOKEN_INVALID` / `GATEWAY_UNAVAILABLE` / `GATEWAY_FAILED` / `INTERNAL`）与固定说明，不含请求、令牌与 agent-gw 的响应正文。
- **worker 一侧**（`src/agent/entry.ts`）按不可信输入解析结果：超时、被终止、其他退出码、被截断、不是恰好一行、退出码与结果不一致、字段或取值不符一律 `AGENT_ENTRY_FAILED`；入口给出的说明文字不采用。
- `action = session`（8.6a）：入口经 `/etc/hosts` 中的 agent-gw 调用 `GET /v1/session`（第 7.12 节），确认令牌有效并返回到期时间（时限 15 秒、响应体至多 4 KiB、不跟随重定向）。
- `action = prompt`（8.6b，见第 7.23 节）：先同样确认令牌，再在 Pi 会话中执行一条提示词。
- `action = compact`（8.6d2，见第 7.28 节）：先同样确认令牌，再压缩已有会话的上下文（Pi 的 `session.compact`，指令由 worker 给出）。

### 7.23 实现（路线图 8.6b）：入口中的 Pi 会话

- **Pi 运行时进镜像**：`server/sandbox/agent/package.json` 与 `package-lock.json`（`@earendil-works/pi-coding-agent`、`pi-ai` 0.80.10 与 `typebox`，版本与传递依赖取自 `client/package-lock.json`，不用 Pi 自带的 `npm-shrinkwrap.json`——后者固定了有已知漏洞的传递依赖），在构建阶段 `npm ci --omit=dev --omit=optional --ignore-scripts`，删去非 Linux 的原生预编译文件；最终镜像只复制 `node_modules`（属主 root、只读），没有 npm、没有 `.node` 原生模块。CI 对该目录做 `npm audit`。
- **请求**（`protocol.mjs`，字段恰好是登记的那几个）：提示词（非空、至多 256 Ki 字符）、续接的会话文件名（`null` 新建；只接受 Pi 命名的 `<时间>_<uuid>.jsonl`）、启用的 Pi 原生工具（`read` / `write` / `edit` / `bash` / `grep` / `find` / `ls` 中不重复的若干个；8.6c1 起还可以有业务工具，见第 7.24 节；8.6c2a 起还可以有本地工具 `json-validation`，见第 7.25 节）、本条提示词的轮数上限（1～1,000，桌面版 `max_turns_per_prompt`）、模型的上下文长度与输出上限（worker 按组织选用的模型给出）。
- **会话**（`pi.mjs`，与桌面版 `piSessionFactory.cjs` 同一套 Pi 配置）：提供方 `app`、`openai-completions`，Base URL 固定为 `http://agent-gw:8080/v1`，任务令牌作为 Pi 的运行时 API Key 只在入口进程内存中（以 `Authorization: Bearer` 发送）；平台按令牌决定组织、模型与上限，请求中的模型名不被采信（第 7.14 节）。Pi 自身不重试（重试与暂停由 worker 决定，8.6d），不加载项目上下文、扩展、技能、提示模板与主题，不下载工具、不检查新版本、不发遥测，配置目录在 `/tmp`。
- **工具**：只注册请求中的原生工具；`bash` 使用 `/bin/sh`，每条命令至多 5 分钟（模型给出的 `timeout` 只能更短），命令的环境固定为 `PATH`、`HOME`、`TMPDIR`、`LANG` 四项，不继承入口进程的环境。
- **会话文件**：`/workspace/pi-sessions/`，随工作区快照保存（第 7.20 节），续接时只接受该目录中的普通文件（不跟随符号链接），无效时 `SESSION_INVALID`。
- **工作区说明**：镜像中的 `workspace-instructions.md`（桌面版 `agent-workspace.md` 改写：Linux `/bin/sh`、断网、5 分钟命令时限、按 agent 模板取回规则写的文件命名规则），作为 Pi 的项目说明进入系统提示词。
- **结果**：成功为会话文件名、本条提示词用掉的轮数与结束原因（`stop` / `length`）；Agent 的回复与写出的文件留在工作区，由 worker 取回（8.6d）。失败新增 `SESSION_INVALID`、`TURN_LIMIT`（第 maxTurns + 1 轮开始时中止）与 `MODEL_FAILED`（模型调用失败，含被平台拒绝；原因由 worker 按任务状态判断，不采信沙箱的说法）。worker 另检查结果的 `action` 与请求一致、轮数不超过请求的上限。
- **标准输出只留给结果**：入口把 `console` 的输出改到标准错误，写完结果即退出（不等 Pi 留下的连接与定时器）。

### 7.24 实现（路线图 8.6c1）：业务工具的桩与阶段限制

- **阶段限制在 worker 一侧**（#91 确认）：桌面版按业务阶段切换 Pi 会话中可用的工具；Web 版的 Pi 在沙箱中，沙箱内的命令可以拿到令牌、绕过入口直接调用 `POST /v1/tools/call`，所以入口按阶段登记桩不算控制。迁移 0042 新增 `agent_tool_scopes`（每次执行一行，`tools` 为当前阶段可用的业务工具名，强制 RLS，只能为本组织 running、`run_id` 相符的 Agent 任务写入与更新，旧执行的行不能再改，没有 DELETE，CHECK 限定工具名格式、无 NULL、至多 32 个），执行者在每条提示词之前写入（`setAgentToolScope`，必须是任务类型登记的 `agentTools` 的子集；`runAgentPrompt` 先写阶段再执行入口，任务已不在本次执行中时不执行、返回 `RUN_ENDED`）。工具调用的计数语句（第 7.15 节）在同一条语句中检查工具在当前阶段中：不在时 403 `AGENT_TOOL_NOT_IN_STAGE`（说明与桌面版阶段门禁相同）、不计入、处理函数不执行；还没有写下阶段时所有业务工具都不可用。检查顺序：工具名（404）→ 阶段（403）→ 次数与频率（429）→ 参数（413 / 400）。
- **桩**（`server/sandbox/agent/tools.mjs`）：prompt 请求的 `tools` 可以包含 `ask-user` 与 `report-failure` / `request-termination` 之一（后者面向模型的名字也是 `report-failure`，两者二选一，入口与 worker 都检查）。入口只为请求中的业务工具登记桩，名称、说明与提示沿用桌面版（ask-user 的问题按纯文本显示，提示改为不用 Markdown），参数 schema 与 worker 登记的相同（测试逐项核对）。调用经 agent-gw 的 `POST /v1/tools/call`（令牌只在 `Authorization` 中，请求体只有 `{ name, arguments }`，时限 120 秒，响应至多 4 MiB + 64 KiB，不跟随重定向、不复用连接）。
- **桩的行为**：`pending` 时等 1 秒后以完全相同的参数再次调用、不交给模型；`report-failure` 报告成功、`request-termination` 选择终止后立即结束 Pi 会话，入口报告 `REPORTED_FAILURE`；选择继续时把 `instruction` 作为工具结果交给模型；worker 的 4xx 说明（截短到 500 个字符）作为工具错误交给模型；401 与 409 `JOB_NOT_RUNNING` 立即结束会话（`TOKEN_INVALID` / `RUN_ENDED`）；5xx、连不上、超时、响应不合法只给固定说明。入口报告的 `REPORTED_FAILURE`、`RUN_ENDED` 同样只是沙箱的说法，任务是否失败按 `agent_failure_reports`（第 7.16 节）与任务状态判断。
- **工作区说明**：补上业务工具的段落（桌面版 `agent-workspace.md` 中 ask-user 与 report-failure 的约定；不同阶段提供的工具可能不同；按工具返回的说明调整、不要以相同参数反复重试）。`json-validation` 随 8.6c2a（第 7.25 节），受保护文件的还原随 8.6c2b，`openxml` 随使用它的任务。

### 7.25 实现（路线图 8.6c2a）：本地工具 json-validation

- **在沙箱内执行**（#82 决定事项第 3 项）：桌面版的 `json-validation` 读取工作区中的 JSON 文件、供 Agent 自查，平台在结果提交时另按固定规则校验。Web 版不做成业务工具 RPC：文件不上传到 worker，Agent 提供的任意 schema 不在持有数据库凭据的 worker 中编译（正则回溯等资源耗尽）。入口把它作为**本地工具**（`protocol.mjs` 的 `LOCAL_TOOLS`）登记，不经 agent-gw、不写进阶段（第 7.24 节）、不计入工具调用次数；它不是控制，Agent 的自查结果不被采信。
- **请求**：prompt 请求的 `tools` 可以包含 `json-validation`；只在它启用时可以给出 `jsonSchemas`（工作区相对路径 → JSON Schema，对象或布尔值，至多 32 个；路径以 `/` 分隔，没有空段、`.`、`..`、反斜杠与控制字符，至多 255 个字节、8 级——入口与 worker 用同样的规则检查）。worker 只检查形状、不编译；Schema 由任务定义给出（8.7 起）。
- **规则与桌面版相同**（`pi/piJsonValidationTool.cjs`）：名称、说明、参数（`file_path`，没有预置时还要 `schema`）沿用桌面版；预置了 Schema 的文件只用预置的（Agent 给出的被忽略）；Ajv 8（MIT，新增依赖）`allErrors` + `strict`，Draft-07；结果为 `{ valid, stage, file_path, errors, message }`，失败时为工具错误。不同之处：文件必须是工作区内的普通文件（解析符号链接后仍在工作区内）、至多 16 MiB；至多报告 100 条错误（另给 `error_count`），说明与路径截短到 500 个字符，序列化后超过 1,000 个字符的 `params` 省略。
- **工作线程**：每次调用在新的 `worker_threads` 线程中读取、解析、编译与校验（`jsonValidationWorker.mjs`），至多 30 秒、堆至多 512 MiB、环境为空、输出不进入入口的标准输出；超时、超出资源上限、被中止时终止线程，作为校验失败（`stage` 为 `timeout` / `resource` / `aborted`）交给模型。灾难性正则不会卡住入口的事件循环，轮数上限与中止照常生效；整体仍受 agent 模板的 CPU、内存与时长限制。
- **工作区说明**：补上 `json-validation` 的段落（预置时只传 `file_path`、单个文件至多 16 MiB、一次至多 30 秒）。

### 7.26 实现（路线图 8.6c2b）：受保护文件的还原

- **在 worker 一侧**：桌面版（`pi/piWorkspaceBaseline.cjs`）在工作区外保存程序写入的文件的原件，提交校验前比对，被改或被删的直接还原。Web 版的工作区在 agent 沙箱中，沙箱内没有 Agent 碰不到的位置，登记与原件都在 worker：`src/agent/workspaceBaseline.ts` 的 `createAgentWorkspaceBaseline`。
- **登记**：`write(sandbox, group, files, { replace? })` 把文件放入 `/workspace`（覆盖同名文件），放入成功后按分组记下路径、大小与 SHA-256，原件保存在 worker 的内存中（相同内容只存一份）；整体替换某组、`release` 解除登记互不影响其他组；同一路径在几个分组中时内容同步刷新。路径按 agent 工作区的取回规则（与快照相同，第 7.20 节）校验并规范化；分组名为小写字母、数字与 `-`，至多 16 组、合计 1,000 个文件、原件合计 64 MiB（每次执行一个实例，按不同内容的大小算，含续跑后尚未取回的原件）；超出时 `write` 抛 `TypeError`（程序错误，任务失败），不放入、不登记、已有登记不变；从 checkpoint 重建时同样检查文件数与合计大小，`recover` 取回内存的原件不会超过上限。
- **比对与还原**：`restore(sandbox)` 经 `copyOutArchive` 取回 `/workspace`（按取回规则逐项校验、重新生成），边读边只对登记的路径计算 SHA-256（`archive.ts` 的 `visitArchive`），内容不同或不存在的一次放回原件，返回还原的路径。任务在每次提交校验之前、下一条提示词之前调用（8.6d），并把还原的路径告诉 Agent（桌面版的“程序已还原被改动的文件……这些文件由程序维护，不要修改”）。工作区不符合取回规则时 `AGENT_WORKSPACE_REJECTED`（与检查点相同，说明只写类别）；登记的路径与工作区中已有的文件或目录冲突（大小写折叠后同名、上级目录变成文件、文件变成非空目录）或放回失败时销毁沙箱，`AGENT_PROTECTED_FILES_RESTORE_FAILED`；中止照原样抛出。放回用沙箱内 GNU tar 的默认行为：先删除已有的文件（含符号链接、空目录）再写入。
- **续跑**：登记（不含原件）经 `toState` 写进 `jobs.checkpoint`，新的执行从 checkpoint 重建（逐项检查形状）；放入工作区快照之后、发出第一条提示词之前调用 `recover`，从刚放入、Agent 尚未执行过的工作区中取回与登记相符（路径、大小、SHA-256）的原件，返回仍不可用的路径。原件不可用的文件须由任务重新 `write`（输入资料本来每次执行都重新写入，与桌面版相同），否则需要放回时 `AGENT_PROTECTED_FILES_UNAVAILABLE` 失败，不把 Agent 改过的内容当作原件。8.6d 在保存检查点之前先 `restore`，使快照中的受保护文件就是原件。
- **平台只用原件**：还原之后沙箱内残留的后台进程仍可能再次改动，所以 worker 处理受保护文件时一律用 `original(path)` 给出的原件，不读回沙箱中的副本；还原只是让 Agent 的后续工作基于正确的输入。
- **工作区说明**：“程序写入的输入资料和不属于本次任务的文件不要修改”后补“被改动的会在提交校验前还原”（与桌面版 `agent-workspace.md` 相同）。

### 7.27 实现（路线图 8.6d1）：worker 端的 Agent 执行

- **入口**：执行者给 agent 队列中工作区快照可用（登记了 `agentWorkspace`、任务属于项目、worker 配置了对象存储与能整体放入与取回归档的 sandbox-runner）的任务提供 `context.agent`（`src/agent/execution.ts`），其余为 `null`；任务经 `withAgentRun(context.agent, fn)` 打开，`fn` 结束（含失败、中止）时销毁沙箱、作废本次执行的令牌。本次执行的 `run_id` 不交给任务代码。
- **打开**（`open`，一次执行一次）：先从 checkpoint 重建受保护文件的登记（不合法时不建沙箱），再按任务类型登记的 `agentSandboxTemplate`（`agent` 30 分钟 / `agent-content` 2 小时，默认 `agent`）新建沙箱（`SANDBOX_BUSY` / `SANDBOX_UNAVAILABLE` 按 5、15、30 秒重试，用完为 `AGENT_SANDBOX_BUSY` / `AGENT_UNAVAILABLE`），签发令牌（有效期 = 模板入口命令的墙钟；本次执行已结束或已请求暂停时不签发、按中止收尾）。checkpoint 中有执行者的现场时为续跑：放入上次的工作区快照（第 7.21 节）并 `recover` 受保护文件的原件（第 7.26 节）；现场中有会话或登记、快照却不在了时 `AGENT_WORKSPACE_RESTORE_FAILED`，不从头开始（从头开始会重新调用模型、重新扣费，由用户决定）。
- **checkpoint 的布局**：`{ agent: { version: 1, session, stage, stageIndex, promptedStage, compactionPending, baseline }, task }`（`compactionPending` 为 8.6d2 的待补压缩，见第 7.28 节；8.6d1 写下的现场没有这一项，按 `null` 读出）。`session` 为 Pi 的会话文件名（`pi-sessions/` 中），`stage` / `stageIndex` 为当前阶段，`promptedStage` 为已在会话中发出过要求的阶段（桌面版 `prompted_stage`，续跑时任务据此只发“继续之前的任务”），`baseline` 为受保护文件的登记（不含原件），`task` 为任务自己的状态。不含令牌与文件内容；读出时逐项检查形状。现场与工作区快照一起保存，二者始终是同一个检查点的一对：检查点之后才发出的提示词不在快照的会话中，续跑时任务重新发出该阶段的要求。
- **提示词**（`prompt`）：每条之前先 `restore` 被改动的受保护文件（还原的路径写一条任务日志），再经 `runAgentPrompt` 执行（先写下本条可用的业务工具，第 7.24 节）；会话由执行者管理，续接上一条的会话文件。每次执行入口只给本次执行剩余的时间（令牌到期即中止），到期后不再执行，`AGENT_TIME_LIMIT`。
- **失败按数据库中的事实判断**（不采信入口的说法与输出）：依次看任务是否已中止（取消、暂停、租约丢失、当日时长用完、问题等待超时，按执行者的中止原因收尾）、本次执行的失败报告（按报告以 `AGENT_REPORTED_FAILURE` 失败，原因取报告，第 7.16 节）、任务的费用与轮数上限（暂停为 `task_cost_limit` / `task_turn_limit`）、任务是否仍在本次执行中（不在即按中止收尾）、令牌是否到期（`AGENT_TIME_LIMIT`）；都不能说明时：`MODEL_FAILED` 按模型调用路由在本条提示词中记下的拒绝原因判断（8.6d3，第 7.29 节；取代 8.6d1 按可用余额的判断）——余额不足暂停为 `insufficient_balance`（执行者对任务抛出的 `JobBalanceExhaustedError` 同样暂停），组织没有选择模型 / 所选模型不可用同样暂停（`model_not_configured` / `model_unavailable`，任务抛出的 `JobModelUnavailableError`），没有记下拒绝时为可以重试的“模型调用失败”；`GATEWAY_UNAVAILABLE` / `GATEWAY_FAILED` 为可以重试的“连接平台服务失败”；`TURN_LIMIT` 为 `AGENT_PROMPT_TURN_LIMIT`；`SESSION_INVALID` 为 `AGENT_SESSION_INVALID`；其余（令牌无效、自称报告了失败或执行已结束却查不到对应的事实、请求被拒绝、入口内部错误、结果不符合协议、入口超时）为 `AGENT_ENTRY_FAILED`，沙箱操作失败为 `AGENT_SANDBOX_FAILED`。给用户与 Agent 看的说明都是固定的文字。不可重试的失败之后这个沙箱不再使用。
- **阶段**（`runStage`）：发出阶段要求，执行失败中可以重试的按任务给出的次数（0～3，默认 1，与桌面版 `max_retries` 相同）以固定原因的重试提示词在同一会话中重试；每次提交校验之前先 `restore` 受保护文件，再由任务按固定规则校验工作区中的结果（`readFiles` 读出，内容按不可信数据处理；受保护文件只用 `original`）。提交策略与修复提示词与桌面版相同（`src/agent/submission.ts`）：有问题即修复，连续一次没有进展时要求更换方法，连续两次没有进展时没有阻塞问题即接受、有阻塞问题按最低目标再修一轮，最低目标之后仍有阻塞问题以 `AGENT_SUBMISSION_FAILED` 失败；修复提示词写明本次还原的受保护文件。提交修复没有固定次数上限（与桌面版相同），每次修复同样计入任务的轮数与费用上限（第 10.11 节）。`checkpointAfterPrompt` 给出时每条提示词成功后、校验之前保存检查点。
- **读文件**（`readFiles`）：经 `copyOutArchive` 取回 `/workspace`（按取回规则逐项校验），只保留请求的路径（按请求时的写法，大小写不同的同名文件不算），单个文件至多 16 MiB、合计 64 MiB、一次至多 256 个，超过的只给大小。
- **检查点**（`checkpoint`）：先 `restore` 受保护文件（使快照中的受保护文件是原件），再经 `context.agentWorkspace.saveCheckpoint` 保存快照与 checkpoint；超出组织存储配额时 `JobStorageQuotaError`（任务暂停为 `storage_quota`，会话随沙箱结束），工作区不符合规则或过大时任务失败。
- **模型上限**：入口的 Pi 会话按 worker 给出的上下文长度（默认 400,000，与桌面版 `context_length_limit` 的默认值相同）与输出上限（32,768 与 `AI_MAX_OUTPUT_TOKENS` 中较小者）压缩与截断；平台另按令牌把 `max_tokens` 截到 `AI_MAX_OUTPUT_TOKENS`（第 7.14 节）。

### 7.28 实现（路线图 8.6d2）：阶段交接的上下文压缩与 Agent 回复全文

- **入口的 `compact`**（`protocol.mjs`、`pi.mjs` 的 `runPiCompaction`）：请求字段恰好为 `version` / `action` / `token` / `session`（必须是已有的会话文件，不新建）/ `instructions`（非空、至多 16 Ki 字符）/ `model`；先确认令牌，再在续接的会话上执行 `session.compact(instructions)`，**不注册任何工具**。结果为 `{ session, compacted }`：会话太短、刚压缩过时 Pi 认为无需压缩，`compacted = false`（与桌面版 `isCompactionNoopError` 相同，不算失败）；总结时的模型调用失败（含被平台拒绝）为 `MODEL_FAILED`，会话文件不可用为 `SESSION_INVALID`，其余异常 `INTERNAL`、不带出说明。压缩追加到同一个会话文件，worker 检查结果中的文件名与请求相同。压缩的模型调用经同一条模型调用路由，同样计入任务的轮数与费用上限（第 10.11 节）。
- **worker 一侧**（`src/agent/entry.ts` 的 `runAgentCompaction`）：执行入口之前先把本阶段可用的业务工具清空（迁移 0042 的阶段表；压缩期间沙箱内遗留的进程也调用不了业务工具），任务已不在本次执行中时不执行入口（`RUN_ENDED`）。
- **`run.compact({ stage, instructions, optional, checkpoint })`**（`src/agent/execution.ts`，与桌面版 `runStageCompaction` 相同）：开始前把 `{ stage, instructions, optional }` 登记为待补压缩（`compactionPending`），给出 `checkpoint` 时随即保存检查点（压缩中被暂停时，续跑知道要补做）；还没有会话时无需压缩、不执行入口；成功或无需压缩时清除登记。失败时先按数据库中的事实判断（中止、失败报告、任务上限、执行已结束、时限、记下的拒绝原因，第 7.27、7.29 节），之后入口报告的 `MODEL_FAILED` / `GATEWAY_*` / `INTERNAL`：可选压缩按原上下文继续并保留登记（返回 `failed`，写固定说明的任务日志），必须的压缩以 `AGENT_COMPACTION_FAILED` 失败；可选压缩不重试（与桌面版相同）。同一阶段再次压缩时日志写“上下文压缩未完成，正在重新压缩”。
- **登记的清除与续跑补做**：发出某阶段的要求时清除该阶段的登记（之后不再补做）；续跑后的第一条提示词之前，若 checkpoint 中有该阶段的登记、而该阶段的要求还没有发出（`promptedStage` 不是它），执行者先自动补做压缩，再发出要求；任务自己先调用 `compact` 时不再自动补做。
- **Agent 回复全文**（`src/agent/assistantText.ts`、`run.assistantText({ maxChars })`）：入口的结果至多 16 KiB，回复不经标准输出；worker 经 `readFiles` 读出 `pi-sessions/<会话>.jsonl`（至多 16 MiB，超过时为 `null`），取最后一条 assistant 消息的文本段（按换行连接、去掉首尾空白，与桌面版 `extractAssistantText` 相同）。会话文件在工作区中、Agent 的命令可以任意改写，内容按**不可信数据**处理：严格 UTF-8、每个非空行恰好一个 JSON 对象，否则为 `null`（任务用固定说明代替，与桌面版的缺省说明相同）；去掉控制字符（保留换行与制表符）与孤立的代理项，按字符数截断（默认 64 Ki、至多 256 Ki，不拆开代理对）。它是 AI 生成的内容：给用户显示时与其他 AI 内容一样按 Markdown 渲染、不允许原始 HTML，不进日志与失败说明。

### 7.29 实现（路线图 8.6d3）：模型调用被拒绝的原因

- **问题**：沙箱中的模型调用被平台拒绝时，入口只报告 `MODEL_FAILED`（沙箱的说法不可信）；8.6d1 的执行者按组织的可用余额猜测，可用余额不低于最低启动余额（1 元）、但不够一次调用的冻结额时会按模型失败重试、最后失败，用户充值后只能重新发起（#96 确认改为精确方案）。
- **记下**（迁移 0043 `agent_model_rejections`，`src/agent/modelRejections.ts`）：每次执行（`job_id`、`run_id`）一行，`reason` 是最近一次被拒绝的原因，`rejections` 是本次执行被拒绝的次数（每次加 1）。模型调用路由（第 7.14 节）按令牌的执行在拒绝时写入，原因由平台按错误代码决定、不来自请求：`INSUFFICIENT_BALANCE`（冻结时余额不足）→ `insufficient_balance`；`AI_MODEL_NOT_CONFIGURED` → `model_not_configured`；`AI_GATEWAY_DISABLED`、`AI_MODEL_NOT_REGISTERED` / `AI_MODEL_DISABLED` / `AI_MODEL_NOT_FOUND`、`MODEL_PRICE_NOT_CONFIGURED` / `AI_MODEL_PRICE_CONFLICT`、`AI_PROVIDER_NOT_CONFIGURED` → `model_unavailable`；其余（上游失败、超时、并发、请求不合法、开始推送后的失败）不记。费用与轮数上限仍只记在 `agent_job_budgets`（第 10.11 节）。写入失败只写日志，响应照常。
- **RLS 与授权**：写入与更新只能为本组织 running、`run_id` 相符且登记了上限的 Agent 任务进行（旧执行的行不能再改）；应用角色只能写入 `org_id`、`job_id`、`run_id`、`reason` 与更新 `reason`、`rejections`、`updated_at`，没有 DELETE；原因限三种、次数至少为 1（CHECK）；随任务记录删除。`jobs.pause_reason` 的 CHECK 新增 `model_not_configured`、`model_unavailable`（回滚时这类暂停改为普通暂停）。不改已有表的策略，不新增数据库角色。
- **执行者**（`src/agent/execution.ts`）：每次执行入口（提示词与压缩）之前读出本次执行的拒绝次数，入口报告 `MODEL_FAILED` 后只采信这之后的拒绝（之前的提示词中、沙箱内遗留进程的调用被拒绝不影响本条）：`insufficient_balance` 一律暂停为 `insufficient_balance`，充值后继续从 checkpoint 续跑；`model_not_configured` / `model_unavailable` 与余额不足一致，暂停为同名的暂停原因（`JobModelUnavailableError` → `finishRun` 的 `model-unavailable`，#98 确认；事件说明分别为“尚未选择文本模型，任务已暂停，请在设置中选择模型后继续”与“所选模型暂时不能使用（未登记、已停用、未定价或服务未配置），任务已暂停，请在设置中选择可用的模型后继续”），不重试；用户或管理员在设置中选择可用的模型后经普通的“继续”从 checkpoint 续跑，仍不可用时再次暂停；没有新的拒绝时按可以重试的“模型调用失败”。压缩与提示词共用这一判断（可选压缩遇到这些拒绝同样暂停，不按原上下文继续）。
- **被注入的 Agent**：沙箱内的命令可以自己发出被拒绝的调用（例如带上大量输入使冻结额超过余额），使任务暂停；这与 Agent 自己报告失败（第 7.16 节）的效果相同，不能借此调用模型、越过上限或影响其他执行与组织。

### 7.30 实现（路线图 8.7a）：可研报告目录生成

第一个接到第 7.27 节执行者上的真实 Agent 任务（`feasibility-outline`，`src/feasibilityReport/jobs.ts`；材料与结果整理在 `outlineAgent.ts`、`outlineTemplates.ts`，与桌面版 `feasibilityOutlineTask.cjs` 逐项对照）。

- **登记**：agent 队列、可续跑、调用模型；上限取 `AGENT_TASK_LIMITS.outline`（5 元 / 500 轮，8.7f 按 P95 重定）；业务工具 `ask-user`、`request-termination`（桌面版顶层任务的失败报告须经用户确认）；工作区快照类别 `feasibility-outline`，8.7a 时成功后丢弃，8.7b 起成功后保留（`keepAfterSuccess`，供目录调整接着会话，见第 7.31 节）；模板 `agent`（墙钟 30 分钟）。互斥键与其他可研任务相同（`project:{projectId}:feasibility-report`），保存上游内容时一并取消。
- **输入**：开始时从数据库读取资料分析（为空 409 / 失败“请先完成资料分析”）、项目参数、已保存的目录配置与引用的知识库轻量条目；接口 `POST .../feasibility-report/outline-job` 不接受参数（桌面版在开始时保存目录配置，Web 版由 `PUT .../outline-config` 先保存）。材料以受保护文件放入工作区，提示词、预置 Schema、工具与桌面版相同。
- **结果**：桌面版没有提交校验、不重试（`max_retries` 0），Web 版相同：Agent 结束后读出 `outline.json`（按不可信数据处理，只取约定字段并转成字符串，最多三级、按桌面版截短数量，知识库条目只保留本次清单中的，节点 id 由程序按位置分配）；不是合法 JSON、没有可用目录、文件过大时失败，说明是固定文字、不含文件内容；节点数超过 2000（服务端目录上限）时失败。经 `saveOutlineResult` 整体替换目录、清空正文与关键参数（桌面版在开始时清空，这里在写入时清空，与资料分析任务相同），超长字段截短。
- **续跑与输入签名**：每条提示词之后保存检查点，task 状态只有首次执行开始时的输入签名；续跑时签名与当前不符即失败（不按新输入接着旧会话），已发出阶段要求时只发“继续之前的任务”、不重新放入材料（原件不可用时按同一输入重新放入）；写入时在同一事务中核对签名。

### 7.31 实现（路线图 8.7b）：跨任务续用会话与可研报告目录调整

桌面版的调整类任务接着对应生成任务的持久会话继续（`persistent_task.mode = 'resume'`）。Web 版的会话文件在工作区快照中（每个项目、每类任务只保留最近一次，第 7.19 节），执行者的现场在写下该快照的任务的 checkpoint 中（第 7.27 节）；8.7b 把两者绑定，并接入第一个调整任务（`feasibility-outline-adjustment`）。

- **快照 id 写进现场**（`src/agent/execution.ts`、`workspaceJob.ts`）：`context.agentWorkspace.saveCheckpoint` 的 checkpoint 可以是函数，取刚保存的快照生成；执行者把快照 id 写进现场的 `snapshot`（8.7b 之前写下的现场没有，按 `null` 读出、续跑时不核对）。续跑放入快照后核对：快照已被其他任务替换（id 不符）时以 `AGENT_WORKSPACE_RESTORE_FAILED` 失败、不执行入口，不再把不是同一对的会话与快照拼在一起。
- **跨任务续用**（`src/agent/continuation.ts`、`open({ continueFrom })`）：`findContinuableAgentSession` 找该类任务当前的快照，再找本项目中给定几类任务里、现场的快照 id 正是它的**已结束（成功或失败）**任务（取最新的一个，现场须合法、有会话文件，否则按找不到处理）。被取消的任务不采用：保存上游内容或重置时任务被取消，取消到退出之间仍可能保存检查点、写下新的快照；暂停中、排队中、执行中的任务持有互斥键，调整任务此时无法入队。调整任务首次执行时把找到的现场交给 `open({ continueFrom })`：放入当前快照并核对 id，续接会话文件与受保护文件的登记（取回原件），阶段、已发出的阶段与待补压缩清空（新任务的要求照常发出），`run.continued` 为真、`run.resumed` 为假；之后的检查点写下新的快照 id，续跑按本任务自己的现场。续跑时再给出 `continueFrom`、现场没有会话或快照 id 是程序错误。
- **目录调整**（`src/feasibilityReport/jobs.ts`，与桌面版 `feasibilityOutlineAdjustmentTask.cjs` 逐项对照）：登记与目录生成相同（agent 队列、上限 `outline`、`ask-user` / `request-termination`、快照类别 `feasibility-outline`），两者都 `keepAfterSuccess`。参数只有 `requirement`（去掉首尾空白、不为空、至多 2000 字）。没有目录、会话不能续用时失败（文案与桌面版相同，入队时也检查，409）。当前目录（数据库中的，可能被用户手动改过）按桌面版 `buildAgentOutlineInput` 写入 `outline.json`，写入后解除登记（交给 Agent 修改，不还原）；生成时的材料仍受保护，原件不可用时按当前输入重新放入。提示词、工具、预置 Schema、不做提交修复与桌面版相同；结果与生成相同整理，经 `saveOutlineResult` 整体替换目录、清空正文与关键参数，项目名称与概述沿用原目录的，带首次执行开始时的输入签名。
- **调整说明**：Agent 最后一条回复的全文（`run.assistantText`，至多 2000 字），取不到时为“报告目录已按要求调整完成。”；是 AI 生成的内容，不写任务日志，随最后的检查点写进本任务的 checkpoint（`{ signature, summary }`，先于写入目录），页面状态的 `outlineAdjustment` 给出最近一次调整的要求与成功后的说明，`outlineAdjustable` 给出能否调整（有目录且会话可以续用）。
- **丢弃会话**（桌面版 `deleteFeasibilityOutlineAgentTask`）：保存项目信息、资料分析，导入、移除资料，清空时由接口在取消任务之后丢弃，资料分析写入结果（目录被清空）时由任务丢弃；保存目录、目录配置、关键参数不丢弃（桌面版相同，调整时以数据库中的目录为准）。新的目录生成不预先丢弃，第一个检查点替换快照。`discardWorkspaceSnapshot` 的对象存储可以为 `null`（api 未配置时只标为已被替换，对象与行留给清理任务）。
- **接口**：`POST /api/projects/:projectId/feasibility-report/outline-adjustment-job`（`{ requirement }`，202；要求为空 / 过长 / 多余字段 400；没有目录 409 `FEASIBILITY_REPORT_OUTLINE_REQUIRED`；会话不能续用 409 `FEASIBILITY_REPORT_OUTLINE_SESSION_MISSING`）。

### 7.32 实现（路线图 8.7c1）：技术方案全局事实生成

第一个技术方案的 Agent 任务（`global-facts-generation`，`src/technicalPlan/jobs.ts`；材料、提示词与提交校验在 `globalFactsAgent.ts`，与桌面版 `globalFactsTaskV2.cjs` 逐项对照）。

- **登记**：agent 队列、可续跑、调用模型；上限 `AGENT_TASK_LIMITS.outline`；业务工具 `ask-user`、`request-termination`；工作区快照类别 `technical-plan-global-facts`，8.7c1 成功后丢弃，8.7c2 起成功后保留（`keepAfterSuccess`，供全局事实调整接着会话，见第 7.33 节）；模板 `agent`。互斥键与其他技术方案任务相同（`project:{projectId}:technical-plan`），导入、移除招标文件与清空时一并取消。
- **输入**：开始时从数据库读取：招标正文（多标段且选择了投标范围时为 `readTenderMarkdown` 按投标范围裁剪的一份，否则 `readGlobalFactsSources` 读各招标文件的原文与文件名）、项目概述、招标解析结果、目录、原方案（有时）、引用的知识库文档的完整条目（`readGlobalFactsKnowledgeItems`）与全局事实的写法（生成配置，由 `PATCH .../generation-config` 先保存；接口 `POST .../technical-plan/global-facts-generation` 不采用请求体）。没有招标文件或未解析完成、没有目录、原方案未解析完成或失败时 409。招标文件在工作区中的文件名由桌面版规则得出，不符合 agent 工作区的路径规则（第 7.20 节）时不允许的字符换成 `_` 并按字节截短。
- **提交校验**：与桌面版 `validateGlobalFactsOutput` 相同：按预置 Schema（Ajv，allErrors + strict；服务端新增直接依赖 `ajv` 8.20.0，与桌面版、agent 镜像同一版本）校验、按桌面版整理（标题压成一行、内容去掉首尾空白、id 规范化去重），不是合法 JSON、Schema 错误、没有可用分组是阻塞问题，经提交修复退回 Agent（第 7.27 节）；不是合法 JSON 时说明不附解析器的错误信息；Schema 错误至多 200 条（提交校验报告的上限，超出合并为一条）；另按服务端的全局事实上限（100 组、字数）检查；结果文件过大时为阻塞问题。
- **写入与输入签名**：`saveGlobalFactsResult` 与 `saveGlobalFacts` 相同整体替换并清空正文阶段（桌面版在开始时清空全局事实，这里在写入时替换，失败时保留原来的），在项目锁内核对 `globalFactsInputSignature`（招标文件与投标范围、原方案、招标解析项、目录结构与标题说明、全局事实的写法、引用的知识库文档、当前的全局事实；不含知识库条目内容、步骤、正文与正文生成选项）。续跑与可研目录生成相同（签名在 checkpoint 中，已发出阶段要求时只发“继续之前的任务”）。
- **状态**：`globalFactsTask` 为本项目最近一次的全局事实生成任务。

### 7.33 实现（路线图 8.7c2）：技术方案全局事实调整

第二个调整任务（`global-facts-adjustment`，`src/technicalPlan/jobs.ts`；提示词与 `global-facts.json` 在 `globalFactsAgent.ts`，与桌面版 `globalFactsAdjustmentTask.cjs` 逐项对照），沿用第 7.31 节的跨任务续用。

- **登记**：与全局事实生成相同（agent 队列、上限 `outline`、`ask-user` / `request-termination`、快照类别 `technical-plan-global-facts`），两者都 `keepAfterSuccess`。参数只有 `requirement`（去掉首尾空白、不为空、至多 2000 字）。没有全局事实、会话不能续用时失败（文案与桌面版相同，入队时也检查，409）。
- **执行**：首次执行把 `findContinuableAgentSession`（同组任务类型为生成与调整）找到的现场交给 `open({ continueFrom })`；当前全局事实（数据库中的）按桌面版 `buildAgentFactsInput` 写入 `global-facts.json`，写入后解除登记；生成时的材料仍受保护，原件不可用时按当前输入重新放入（与生成相同的材料，前置条件不满足时以对应错误失败）。提示词、阶段 `global-facts-adjustment`、工具、预置 Schema、提交校验（经提交修复）与桌面版相同；结果经 `saveGlobalFactsResult` 带首次执行开始时的 `globalFactsInputSignature` 写入（整体替换、清空正文阶段）。
- **调整说明**：与第 7.31 节相同（`run.assistantText`，至多 2000 字，取不到时为“全局事实已按要求调整完成。”；写进 checkpoint 的 `{ signature, summary }`，不写任务日志）；页面状态的 `globalFactsAdjustment` 给出要求与成功后的说明，`globalFactsAdjustable` 给出能否调整（有全局事实且会话可以续用）。
- **丢弃会话**（桌面版 `deleteGlobalFactsAgentTask`）：接口在导入（有新文件时）/ 移除招标文件与清空（取消任务之后）、切换单 / 多标段（`saveGenerationConfigReporting` / `saveBidAnalysisConfigReporting` 报告下游被清空）、选择投标范围、保存后目录为空时丢弃；多标段识别与全部重新解析的任务在清空下游之后丢弃。保存全局事实、目录排序 / 编辑、其他生成配置不丢弃。
- **接口**：`POST /api/projects/:projectId/technical-plan/global-facts-adjustment`（`{ requirement }`，202；要求为空 / 过长 / 多余字段 400；409 `TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED` / `TECHNICAL_PLAN_GLOBAL_FACTS_SESSION_MISSING` / `JOB_LOCKED`）。

### 7.34 实现（路线图 8.7d）：技术方案目录调整

第三个调整任务（`outline-adjustment`，`src/technicalPlan/jobs.ts`；`outline.json`、提示词、预置 Schema 与提交校验在 `outlineAgent.ts`，与桌面版 `outlineAdjustmentTask.cjs`、`outlineGenerationTaskV2.cjs` 逐项对照），沿用第 7.31 节的跨任务续用。

- **登记**：agent 队列、上限 `outline`、`ask-user` / `request-termination`、快照类别 `technical-plan-outline-generation`、`keepAfterSuccess`。参数只有 `requirement`（去掉首尾空白、不为空、至多 2000 字）。没有目录、会话不能续用时失败（文案与桌面版相同，入队时也检查，409）。同组任务类型为 `outline-generation`（目录生成，8.7e1 起，第 7.35 节）与 `outline-adjustment`。
- **执行**：首次执行把找到的现场交给 `open({ continueFrom })`；当前目录（数据库中的）按桌面版 `buildAgentOutlineInput` 写入 `outline.json`，写入后解除登记。提交校验与桌面版 `validateOutlineOutput(..., { checkSchema: false })` 相同（节点 id 只能沿用当前目录的，新节点填 null），另按服务端目录上限检查；通过后新节点分配 id、编号并写回 `outline.json`。结果经 `saveOutlineAdjustmentResult` 带首次执行开始时的 `outlineAdjustmentInputSignature`（招标文件与投标范围、目录各节点的全部字段与正文摘要、项目名称与概述）整体替换目录、清空正文与正文生成状态。
- **调整说明**：与第 7.31 节相同（至多 2000 字，取不到时为“目录已按要求调整完成。”，写进 checkpoint，不写任务日志）；页面状态的 `outlineAdjustment` 与 `outlineAdjustable`。
- **丢弃会话**：目录与全局事实的会话在同样的入口一并丢弃（`discardTechnicalPlanSessions`，桌面版 `deleteOutlineAgentTask` 与 `deleteGlobalFactsAgentTask` 总是一起调用），入口见第 7.33 节。
- **接口**：`POST /api/projects/:projectId/technical-plan/outline-adjustment`（`{ requirement }`，202；400；409 `TECHNICAL_PLAN_OUTLINE_REQUIRED` / `TECHNICAL_PLAN_OUTLINE_SESSION_MISSING` / `JOB_LOCKED`）。

### 7.35 实现（路线图 8.7e1、8.7e2a）：技术方案目录生成

目录生成（`outline-generation`，`src/technicalPlan/jobs.ts`；材料、提示词、提交校验与确认的校验在 `outlineAgent.ts`，与桌面版 `outlineGenerationTaskV2.cjs`、`taskService.cjs` 逐项对照）：生成一级目录、等待用户确认，确认后所选一级目录无需 AI 扩展时整理为最终目录（8.7e1）；需要 AI 扩展时，无技术评分项模式执行子目录生成、叶子调整与目录审查（8.7e2a，见本节末）。评分模式的后续阶段（评分规划、叶子分配、按评分规划的子目录生成与审查）随 8.7e2b。

- **登记**：agent 队列、上限 `outline`、`ask-user` / `request-termination`、快照类别 `technical-plan-outline-generation`、`keepAfterSuccess`（目录调整接着它的会话，第 7.34 节）。参数只有 `noTechnicalScoreMode`（用户对“无技术评分项模式”的确认；技术评分项缺失时必须为 true）。目录的组织方式、扩展方式、字数控制与引用的知识库文档取已保存的生成配置。
- **前置条件**（入队与执行时相同，文案与桌面版相同）：技术评分要求须解析成功（409 `TECHNICAL_PLAN_TECH_REQUIREMENTS_REQUIRED`），技术评分项缺失而未确认时 409 `TECHNICAL_PLAN_NO_TECHNICAL_SCORE_CONFIRM_REQUIRED`；原方案未解析完成 / 解析失败时 409（Web 版新增，同第 7.32 节）。
- **一级目录阶段**：材料（`响应文件要求.md`、`技术评分信息.md`、`项目概述.md`、`原方案.md`、`参考知识库/参考资料-*.md`，按组织方式、是否只按原方案与无技术评分项模式取舍，与桌面版相同）登记为受保护文件，预置空的 `outline.json`；提示词、阶段 `initial-outline`、工具、`outline.json` 的预置 Schema 与桌面版相同；提交校验与桌面版 `validateOutlineOutput(content)` 相同（经提交修复，执行失败不重试），另限一级目录至多 100 项、内容至多 256 KiB（待确认的内容写在 checkpoint 中）；通过后写回 `outline.json`。
- **确认**：生成的一级目录与默认选择（桌面版 `defaultSelectedIds`）随检查点写进 checkpoint（`{ signature, selection }`），任务暂停为 `waiting_for_selection`（第 5.6 节）。`POST /api/projects/:projectId/technical-plan/outline-selection`（`{ jobId, selectedIds, changes? }`）经 `confirmJobSelection` 确认：选择须非空、不重复、都是待确认的一级目录，`changes` 只能改属性与内容处理模式（桌面版确认对话框能改的），标题、说明与 id 以服务端保存的为准；确认的选择写进 checkpoint 的 `confirmed`，任务回到 `queued`。页面状态的 `outlineGenerationTask` 与 `outlineSelection`（`items`、`selected_ids`、`confirmed`）。
- **确认之后**：所选一级目录按原顺序重新编号；都不需要 AI 扩展（没有 `ai-generate`）时整理为最终目录（桌面版 `buildFinalOutline`），经 `saveOutlineGenerationResult` 带首次执行开始时的 `outlineGenerationInputSignature`（目录调整的签名加原方案、招标解析项、组织方式 / 扩展方式 / 字数控制、引用的知识库文档与全局事实）整体替换目录、清空正文与全局事实、写入字数控制快照，再丢弃全局事实的会话；这一路不打开沙箱。有技术评分项（评分模式）而需要 AI 扩展时以 `TECHNICAL_PLAN_OUTLINE_STAGE_UNAVAILABLE` 失败（8.7e2b 之前）。
- **投标模板提取**：桌面版有模板填写一级目录时并行执行（属 8.13）；8.7e1 开始前用户决定先不接入，模板填写的一级目录照常保留其处理方式。
- **接口**：`POST /api/projects/:projectId/technical-plan/outline-generation`（`{ noTechnicalScoreMode? }`，202；409 见上 / `JOB_LOCKED`）；确认见上（200；400；403 `JOB_SELECTION_FORBIDDEN`；404；409 `JOB_SELECTION_NOT_PENDING`；402 / 429）。
- **无技术评分项模式的后续阶段**（8.7e2a，`runNoTechnicalScoreDirectory`）：确认后打开沙箱续接本任务一级目录阶段的会话（续跑，放入该检查点的快照），材料按同一输入重新放入为受保护文件，`outline.json` 为确认后的一级目录（交给 Agent）。阶段依次为子目录生成（`children-generation`）→ “AI 生成”叶子数与目标（桌面版 `deriveTargetLeafCount`，按字数控制算出，没有设置时为 null）不同时叶子调整（`leaf-adjustment`，可接连多次）→ 目录审查（`outline-review`，放入程序计算的 `outline-review-context.json`（受保护）与预置空的 `outline-review.json`，材料附在提示词后）；阶段名是桌面版的连字符形式，序号从 2 起每阶段加 1。提示词、工具、预置 Schema（`outline.json` 与 `outline-review.json`，一级目录阶段起一并预置）、提交校验（`outline.json` 只能沿用上一阶段目录的 id；审查阶段两份文件的问题合在一起）、阶段之间放入的文件与日志与桌面版相同。
  - **叶子调整的判断**：与桌面版相同看用户最近一次对 ask-user 的回答是否“接受当前结果”。桌面版按回答时的阶段记下回答；Web 版在第一次叶子调整开始时记下数据库时间（`agentQuestionClock`），之后用 `findLatestConsumedAgentAnswer`（`src/agent/questions.ts`）取该时间之后提出、答案已交给 Agent 的最近一个回答，排除终止确认（选项与 `request-termination` 的相同，桌面版不记下终止确认的回答）。
  - **检查点**：后续阶段的进度（阶段、序号、本阶段可以沿用的节点 id、本阶段开始时的叶子数、叶子数提示、叶子调整的起点）写在 checkpoint 中任务自己的状态的 `directory`，与签名、待确认与确认后的一级目录一起保存。每个阶段的要求发出前（交接时）保存一次（`prompted: false`），发出后每条提示词之后再保存（`prompted: true`）；续跑时 `prompted` 为 true 只发“继续之前的任务”，否则重新发出该阶段的要求（叶子调整按 checkpoint 中的叶子数，目录审查按工作区中交接时写入的 `outline.json` 与受保护的审查材料原件，原件不可用时以 `TECHNICAL_PLAN_OUTLINE_INVALID` 失败）。叶子调整可以接连多次，因此不按执行者现场中已发出的阶段判断。
  - **完成**：审查通过后整理后的目录写回 `outline.json`，经 `saveOutlineGenerationResult` 带签名写入（同上），再丢弃全局事实的会话；叶子数与目标不同、用户接受时的提示写在最后一条日志（桌面版 `leafWarning`；桌面版另在任务统计中给出叶子数，Web 版目前只写日志）。

## 8. 部署架构

### 8.0 部署位置（已决定，第 9 节第 13、14 项）

- 服务器部署在**中国大陆境外，优先香港**，面向中国大陆用户；
- 云主机、KMS、对象存储选**同一云厂商、同一地域**，减少跨厂商凭据和跨境流量；云厂商尚未选定，要求：香港地域同时提供云主机、KMS、S3 兼容对象存储，KMS 支持实例角色授权和调用审计，对象存储支持版本化和跨地域复制；
- 境外服务器**不办理 ICP 备案**，也不能使用要求备案的境内 CDN；大陆用户经跨境链路访问，上线前要实测主要省份、主要运营商的延迟和可用性，必要时选带大陆优化线路的套餐；
- 部署在境外不等于不受境内监管：面向大陆用户就要满足个人信息出境和生成式 AI 的相关要求，见第 11 节。

### 8.1 单机 Docker Compose（起步）

| 服务 | 镜像 / 说明 | 网络 |
|---|---|---|
| `caddy` | 反向代理、TLS、静态文件 | `edge` |
| `api` | Fastify | `edge`、`backend` |
| `worker` | BullMQ 消费者 + AI 网关（可多副本）；8.2b 起另有 Agent 内部入口（见第 7.12 节），8.2c2 起其上有模型调用路由（见第 7.14 节） | `backend`、`sandbox-control`、`egress`、`agent-relay`（`internal: true`，接收 `agent-gw` 转来的请求） |
| `agent-gw` | agent 沙箱访问平台的唯一入口（8.2b，见第 7.12 节），不持有平台凭据（只有转给 worker 这一跳的中继密钥） | `agent-relay`，以及 sandbox-runner 随沙箱接入的每个 agent 沙箱的专用网络 |
| `sandbox-runner` | 唯一能访问容器运行时（6.5 实现，见第 7.5 节）；按模板创建 parse、export（7.1，见第 7.9 节）沙箱 | `sandbox-control`（`internal: true`，只有 worker 能访问） |
| `postgres` | PostgreSQL 17，数据卷 | `backend` |
| `redis` | Valkey 8（第 6 步决定替代 Redis 7，协议兼容），开启密码和 ACL，不持久化；启动脚本 `server/redis/start-valkey.sh`（6.1） | `backend` |
| （云对象存储） | 生产环境用云厂商对象存储，不在本机；开发环境才在 Compose 中起本地 S3 兼容存储 | 经 `egress`，用实例角色访问 |
| 沙箱容器 | 由 sandbox-runner 动态创建：parse（文档解析）、export（OpenXmlHelper 与 Chromium，一次导出一个，用完即毁）、agent（8.1，见第 7.10 节） | parse / export 为 `none`；agent 为每个沙箱一个的专用 internal 网络，只有该沙箱与 `agent-gw`（取代原设计的共用网络 `sandbox-gw`） |

- `backend` 为 `internal: true`，数据库、Redis、对象存储不暴露端口到宿主；
- 只有 `worker` 在 `egress` 网络上能访问外网（调用模型服务商、MinerU、KMS、对象存储），并经第 4.4 节的出站校验；api 发邮件和签发预签名 URL 所需的出站访问只放行到发信服务和云厂商接口；
- 所有镜像以非 root 运行，按 digest 固定基础镜像，CI 中构建并做镜像漏洞扫描；
- 配置走环境变量，**密钥走 Docker secrets**（数据库密码、Redis 密码、发信服务凭据等），不写进 compose 文件和仓库；KMS 和对象存储优先用云主机的实例角色授权，不放长期 AccessKey；
- **客户端 IP**：`api` 不向宿主或公网映射端口，只经 Caddy 访问；`edge` 网络固定子网，给 `caddy` 分配固定地址，`api` 的 `TRUSTED_PROXIES` 只填这一个地址（不填整个子网，也不填 Docker 网关），例如：

  ```yaml
  services:
    caddy:
      networks:
        edge:
          ipv4_address: 172.30.0.2
    api:
      environment:
        TRUSTED_PROXIES: 172.30.0.2
  networks:
    edge:
      ipam:
        config:
          - subnet: 172.30.0.0/24
  ```

  Caddy 的 `reverse_proxy` 默认不信任上游传来的 `X-Forwarded-For`，改写为它看到的客户端地址；前面没有 CDN 或负载均衡时，Caddy 不配置 `trusted_proxies`。以后在 Caddy 前加 CDN / 负载均衡时，要在 Caddy 的 `trusted_proxies` 中列出它们的地址段，`api` 的配置不变。未配置 `TRUSTED_PROXIES` 时所有请求的 IP 都是 Caddy 的地址，全站共用一个限流计数；上线前用两个不同出口的客户端确认限流分别计数（第 9 步上线检查）；
- 机器规格起步建议：8 vCPU / 32 GB 内存 / 200 GB SSD（Agent 沙箱是主要消耗），实际以第 6 步之后的压测为准。

规模扩大后的路径：api 和 worker 无状态，可以水平扩展；数据库换托管 PostgreSQL；沙箱迁到 Kubernetes + gVisor RuntimeClass 或 Kata。

### 8.2 HTTPS 与安全响应头

- Caddy 自动申请 Let's Encrypt 证书，只开 TLS 1.2+，HTTP 跳转 HTTPS；
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`（确认域名下没有需要 HTTP 的子域后再加 `preload`）；
- `Content-Security-Policy`（第 6.4 节）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy` 关闭摄像头、麦克风、定位；
- 开启 HTTP/2（SSE 依赖，第 5.4 节）；
- 服务器在香港，不办理 ICP 备案（第 8.0 节）；Let's Encrypt 的签发和 OCSP 在跨境链路下要实测，必要时换用云厂商证书。

### 8.3 日志与监控

- 结构化日志（pino）输出到 stdout，由 Docker 日志驱动收集并轮转；凭据字段一律脱敏（第 4.3 节），**不记录用户文档内容和 AI 输入输出全文**；
- 健康检查：`/healthz`（进程存活，旧仓库 PR #27 已实现，只返回 `{"status":"ok"}`）、`/readyz`（数据库、Redis、对象存储可连，随对应依赖加入；旧仓库 PR #28 已加入数据库检查，#24（6.1）加入 Redis 检查（配置了 `REDIS_URL` 时），失败返回 503 `{"status":"unavailable"}`，原因只写日志）；
- 指标：队列长度、任务耗时与失败率、沙箱数量与资源、AI 请求错误率；告警至少覆盖磁盘、备份失败、队列积压、证书到期。

### 8.4 备份与恢复

| 数据 | 方式 | 频率 / 保留 |
|---|---|---|
| PostgreSQL | WAL 持续归档 + 每日全量（pgBackRest 或 WAL-G），支持按时间点恢复 | 每日全量保留 7 天，每周保留 4 周，每月保留 6 个月 |
| 对象存储 | 开启版本化；跨地域复制到同一云厂商的另一地域（选地域时要符合第 11 节个人信息出境的结论） | 删除的版本保留 30 天 |
| KEK | 云 KMS 托管，一般不可导出；开启删除保护（待删除期取最长）、限制管理权限、开启调用审计 | — |
| Redis | 不备份（队列可从 `jobs` 表重建，进度事件可丢） | — |
| 配置 | compose 文件和部署脚本在仓库中；密钥不入库 | — |

- 备份文件在上传异地前加密（备份工具自带加密，密钥与 KEK 分开）；
- `billing_ledger` 和 `usage_records` 是资金数据，按时间点恢复后要与云厂商账单、模型服务商账单对账（第 10.5 节）；
- **每月做一次恢复演练**：在隔离环境从备份恢复，跑一遍登录、打开项目、下载文件的冒烟检查；
- 用户请求删除数据时，生产库立即删除，备份按保留期自然过期，隐私声明中写明（路线图第 9 步“重写 Web 版隐私声明”）。

### 8.5 ~~AGPL 第 13 条~~

不再适用：迁移到新仓库后本项目改为闭源商业授权，Web 版不提供源码获取方式（路线图 0.5）。部署时仍可把构建所用的 Git 提交号写入镜像，由 api 的 `/api/meta` 返回，用于排查问题。

## 9. 决定事项

以下 18 项已在 旧仓库 PR #26 决定（只改文档）。“建议”列保留原建议供对照，“决定”列为结果；决定结果同时记录在 `docs/MIGRATION_PLAN.md` 第 2 步说明中。

| # | 事项 | 选项 | 建议 | 决定 | 影响的步骤 |
|---|---|---|---|---|---|
| 1 | 租户模型 | a. 只有个人账户；b. 组织 + 个人组织（本文方案）；c. 一开始就做团队 | **b**：数据模型一次到位，界面先只做个人 | **采用建议（b）** | 2、5 |
| 2 | 知识库、资信库、模板的共享范围 | a. 组织内共享；b. 每个用户私有 | **a**（个人组织下与私有等价） | **采用建议（a）** | 5 |
| 3 | 第一版是否开放“多项目” | a. 开放，前端加项目列表；b. 数据模型支持，界面仍每种业务一个项目 | **b** 先上，界面改动放到第 9 步前 | **采用建议（b）** | 5、9 |
| 4 | 登录方式 | a. 邮箱 + 密码；b. 邮箱验证码；c. 接入 OIDC | **a**，预留 c | **邮箱 + 密码、手机号 + 短信验证码两种**；第一版只实现邮箱 + 密码，数据模型预留手机号，短信登录列为第二版（第 3.1 节）；OIDC 仍预留 | 2 |
| 5 | 注册是否开放 | a. 公开注册；b. 仅邀请 | **b**，上线稳定后再考虑公开 | **采用建议（b）** | 2、9 |
| 6 | 发信服务（验证邮件、找回密码、邀请） | 自建 SMTP / 云邮件服务，需选定一家 | 需要你选 | **待选**：列入 `docs/EXTERNAL_SERVICES.md` §7 待定外部服务，选型时重点验证对 QQ / 163 邮箱的送达率 | 2 |
| 7 | API Key 归属 | a. 组织级（成员共用）；b. 每个用户自己的；c. 平台统一提供 Key 并计费 | **a** | **c：平台统一提供 AI 并按量计费**。用户不填 Key（第 4 节）；计量、余额、价格表、手动充值见第 10 节；在线支付、发票列为第二版 | 3、6 |
| 8 | 主密钥（KEK）管理 | a. 密钥文件（Docker secret）；b. 云 KMS | 取决于部署位置 | **b：云 KMS**，与对象存储同一云厂商（第 4.2 节）；开发环境用密钥文件 | 3 |
| 9 | 任务队列 | a. BullMQ + Redis；b. pg-boss | **a** | **采用建议（a）** | 6 |
| 10 | 推送通道 | a. SSE；b. WebSocket（路线图原写法） | **a**，偏离路线图，理由见第 5.4 节 | **采用建议（a）** | 2、6 |
| 11 | Node 版本 | a. Node 24 LTS；b. 沿用 Node 22（2027-04 结束维护） | **a**，需同步升级 CI 和开发环境 | **采用建议（a）** | 2 |
| 12 | Agent 沙箱 | A. 加固 runc；B. gVisor；C. Firecracker / Kata | **B** 起步 | **采用建议（B）** | 7、8 |
| 13 | 部署位置 | 自有服务器 / 云主机（哪家、哪个地域） | 需要你选 | **境外，优先香港，面向中国大陆用户**（第 8.0 节）；云厂商待选；合规事项见第 11 节 | 9 |
| 14 | 对象存储 | a. 自建；b. 云对象存储 | 跟随第 13 项 | **b：与 KMS 同一云厂商的对象存储** | 4 |
| 15 | 上传限制与配额 | 单文件大小、每组织存储总量、每日 Agent 时长 | 文档 100 MB、图片 10 MB、每组织 20 GB、每日 Agent 8 小时 | **采用建议** | 4、6 |
| 16 | 病毒扫描 | a. 接入 ClamAV；b. 不接 | **b** 起步，面向企业客户时再加 | **采用建议（b）** | 4 |
| 17 | 数据保留与删除 | 恢复期、注销后删除时限、备份保留期 | 恢复期 7 天、注销后 30 天内删除、备份按第 8.4 节；写进隐私声明 | **采用建议** | 9 |
| 18 | 桌面数据导入 | a. 不做；b. 做 `app.sqlite` 工作区导入 | **a**（目前无存量用户） | **采用建议（a）** | 5 |

## 10. AI 用量计量与计费

平台统一提供 AI（第 9 节第 7 项），所以每一次模型调用都是平台的成本，必须计量、计价并从组织余额中扣除。第一版只做**用量计量、余额与额度控制、价格表、管理员手动充值**；在线支付、发票和短信登录列为第二版（第 10.6 节）。

金额一律用 `bigint` 存整数，单位为 **0.0001 元**（下称“计费单位”），不用浮点；界面按元显示，保留 2 位（明细保留 4 位）。币种第一版只有人民币。

### 10.1 计量点与用量记录

- **唯一计量点是 AI 网关**（第 1.1 节）。api 和 worker 中所有模型调用、生图调用、MinerU 解析调用都经过 AI 网关，沙箱内的 Agent 也只能经它访问模型（第 7.3 节），没有绕过计量的路径；
- 每次调用写一行 `usage_records`：

| 字段 | 说明 |
|---|---|
| `id`、`request_id` | `request_id` 由网关生成，唯一，保证重试和重复回写不会重复扣费（幂等） |
| `org_id`、`user_id`、`project_id` | 归属；`org_id` 来自会话或任务令牌，不来自请求参数 |
| `job_id`、`job_type` | 所属任务和任务类型（如 `bid-analysis`）；交互式调用（如 `ai.chat`）为空 |
| `source` | `job` / `interactive` / `admin_test`（管理后台连通性测试，不向组织收费） |
| `platform_model_id`、`provider`、`upstream_model` | 用户选择的平台模型和实际调用的上游模型 |
| `input_tokens`、`cached_input_tokens`、`output_tokens`、`image_count`、`page_count` | 用量；文本按 token，生图按张，MinerU 按页 |
| `usage_source` | `provider`（服务商返回的用量）或 `estimated`（服务商未返回时本地估算） |
| `price_id` | 计价时使用的价格表条目（第 10.4 节） |
| `amount` | 向组织收取的费用（计费单位） |
| `upstream_cost` | 平台付给服务商的成本估算，仅平台管理员可见，用于毛利分析和对账 |
| `status` | `billed` / `unbilled`（见下方计费规则） |
| `started_at`、`finished_at` | 时间；不记录 Prompt 和输出内容 |

- **计费规则**：
  - 调用成功：按服务商返回的用量计费；
  - 用户取消或暂停导致流式输出中断：按已产生的用量计费（服务商返回用量时按服务商，否则本地估算并标 `estimated`）；
  - 服务商 5xx、超时、限流等平台侧失败及其自动重试：**不向用户收费**（`status = unbilled`，`amount = 0`），服务商若仍收费，计入 `upstream_cost` 由平台承担；
  - 输入不合法等用户侧错误且服务商未收费：不收费。
- **聚合**（三个维度都按需求给出）：
  - **按组织**：余额页显示本月 / 本日消费；
  - **按模型**：`(org_id, platform_model_id, 日期)` 汇总，用户和平台管理员都能看；
  - **按任务**：`jobs` 表加 `billed_amount`，与 `usage_records` 在同一事务中累加，任务详情显示“本任务已消费”；任务列表可按费用排序；
  - 索引：`(org_id, created_at)`、`(org_id, job_id)`、`(org_id, platform_model_id, created_at)`；按日汇总可以用物化视图或每日汇总表，明细保留期见第 10.5 节；
- `usage_records` 受 RLS 保护（第 2.6 节），用户只能看本组织的记录；`upstream_cost` 在普通用户接口中不返回；
- 取代桌面版的 `textTokenStatsStore` 和开发者工具“Token 统计”（改为管理后台的用量报表）。

### 10.2 余额与资金流水

- `org_balances`：每组织一行，`balance`（计费单位，可以为负，见 10.3）、`low_balance_threshold`（低余额提醒阈值）、`updated_at`；
- `billing_ledger`：**只追加**，不更新、不删除。类型：`recharge`（充值）、`grant`（赠送额度，如邀请试用）、`adjustment`（更正，金额可正可负，必须引用被更正的记录）、`refund`（退款）。字段：`id`、`org_id`、`type`、`amount`（有符号）、`balance_after`、`reference`（线下凭证号等）、`note`、`operator_user_id`、`related_ledger_id`、`created_at`；
- 用量扣费不写 `billing_ledger`（量太大），由 `usage_records` 承担扣费记录。不变式：**`balance = Σ billing_ledger.amount − Σ usage_records.amount`**，每日后台任务校验一次，不一致就告警；
- 扣费在一个数据库事务中完成：插入 `usage_records`、累加 `jobs.billed_amount`、`UPDATE org_balances SET balance = balance - $amount`（行锁），再把新余额写入 Redis 缓存；
- 用户界面：余额、充值与赠送记录、用量明细（按任务 / 按模型 / 按日）、导出 CSV；余额低于阈值时站内提示并发邮件给组织 owner。

### 10.3 额度控制

**已决定（旧仓库 PR #32）：调用前预扣冻结，调用后按实际用量结算。**旧仓库 PR #31 的账本不允许余额为负，“调用前只检查余额、调用后扣费”会遇到调用结束时余额已不够扣的情况，所以改为：

- **冻结**：AI 网关每次调用前，按“已知输入 token 的上界 + 最大输出 token”和当时生效的价格算出本次的最高费用并冻结。输入 token 的上界取 UTF-8 字节数加每条消息的模板开销（DeepSeek、通义千问都是字节级 BPE，每个 token 至少 1 个字节）；最大输出 token 取请求的 `maxOutputTokens`（不超过平台上限 `AI_MAX_OUTPUT_TOKENS`），并作为 `max_tokens` 发给服务商，服务商不会输出更多。冻结时持本组织余额行的行锁检查“余额 − 进行中的冻结 ≥ 本次冻结”，**不足以冻结则拒绝**（402 `INSUFFICIENT_BALANCE`），不调用服务商；
- **结算**：调用结束按服务商返回的实际用量扣费，多余部分随即释放。计价用**冻结时确定的价格版本**（冻结后改价不影响本次），扣费金额**不超过冻结额**（理论上不会超过；万一超过，超出部分由平台承担，上游成本仍按完整用量记录）；
- **不收费**：服务商返回错误（含 4xx、5xx、限流）、超时、连接失败、流中途断开或响应不合法时**不向用户收费**，冻结全额释放；用户主动断开时按已产生的用量结算（第 10.1 节），服务商没有返回用量时本地估算并标 `estimated`；
- **冻结超时自动释放**：冻结有到期时间（`AI_HOLD_TTL_SECONDS`，默认 15 分钟，必须比上游超时至少长 30 秒）。可用余额只计算未到期的冻结，进程中途崩溃、没有结算的冻结到期后**立即**不再占用余额，不依赖任何后台任务；到期后才到达的结算一律不收费。后台每分钟把到期未结算的记录标为 `abandoned`，只是收尾；
- **并发**：同一组织的冻结在余额行锁下串行，并发调用不会冻结超过余额；不经冻结的直接扣费（`chargeUsage`）的余额检查同样扣除进行中的冻结。余额因此**不会为负**，原设计中“透支上界”一条不再需要；
- **入队检查**：创建会调用模型的任务前要求组织可用余额 ≥ 最低启动额度（第一版全局 1 元，写在迁移 `0022_job_billing` 中；按任务类型配置有需要时再加），余额不足时拒绝新任务（`INSUFFICIENT_BALANCE`），前端提示充值；从暂停继续前同样检查（6.4 实现，第 10.10 节）；
- **运行中耗尽**：任务执行中某次调用冻结失败时，任务退出、保留上次的 checkpoint，状态为 `paused`、原因为 `insufficient_balance`，经 SSE 的 `job` 事件（`pauseReason`）通知用户，取代 `onBalanceInsufficient`；充值后用户点“继续”从 checkpoint 恢复，不重复扣费（6.4 实现，第 10.10 节）；
- **可选消费上限**：组织 owner 可以设置每日消费上限，达到后效果同余额不足（防止误操作或 Agent 失控烧钱）；平台管理员可以对单个组织设置每日上限的上界（未实现）；
- 交互式调用和任务调用共用同一余额，不另设额度池。

### 10.4 计费价格表

- `model_prices`：平台级，普通用户只读。字段：`id`、`platform_model_id`、`version`、`effective_from`、`effective_to`、`input_price_per_mtok`、`cached_input_price_per_mtok`、`output_price_per_mtok`（每百万 token）、`image_price`（每张，可按尺寸分档）、`page_price`（MinerU 每页）、`min_charge`（单次调用最低收费，可为 0）、`upstream_*`（对应的上游成本单价，仅管理员可见，外币成本按管理员录入的固定汇率折算）、`created_by`；
- 另有按任务类型的 `job_min_start_balance`（第 10.3 节入队门槛）；
- **改价只能新增版本**：新价格设置未来的生效时间，旧版本在同一时刻失效，同一模型同一时刻只有一个有效价格（数据库排他约束兜底）；`usage_records.price_id` 记录实际使用的版本，历史费用不重算；
- 用户界面展示当前价格表和即将生效的新价格（至少提前若干天公示，具体在用户协议中写明）；
- 计价函数是纯函数（用量 + 价格条目 → 金额，向上取整到计费单位），单独写单元测试覆盖舍入、缓存 token、最低收费、价格切换时刻。

### 10.5 管理员手动充值与对账

- 第一版没有在线支付，充值由**平台管理员手动录入**：管理后台选择组织，填写金额、类型（`recharge` / `grant`）、线下收款凭证号、备注；要求管理员已开启 TOTP，并在提交前二次确认；
- 单笔金额设上限，超过上限需要第二位平台管理员确认（双人复核）；
- 每笔充值写 `billing_ledger` 和 `audit_logs`；**不能修改或删除**，录错只能新增一笔 `adjustment` 冲正并引用原记录；
- 充值成功后清除 Redis 余额缓存，并给组织 owner 发邮件通知；
- **对账**：每日汇总 `usage_records.upstream_cost`，与各模型服务商控制台的用量账单比对，差异超过阈值告警；每月导出组织维度的充值与消费报表；
- **保留期**：`billing_ledger` 长期保留（财务记录）；`usage_records` 明细保留期与日汇总的保留期在隐私声明和用户协议中写明，注销账户时明细随组织数据删除，财务汇总按法定要求保留（具体期限列入第 11 节确认）。

### 10.6 第二版（依赖境内主体）

以下功能都需要中国大陆境内的运营主体才能接入，列为第二版：

| 功能 | 依赖 | 第一版的替代 |
|---|---|---|
| 在线支付（微信支付、支付宝） | 境内主体的商户号 | 管理员手动充值（第 10.5 节） |
| 发票（增值税普通 / 专用发票） | 境内主体的税务登记 | 不提供发票，用户协议中写明 |
| 手机短信验证码登录 | 境内短信服务商的签名和模板报备 | 只提供邮箱 + 密码（第 3.1 节），数据模型已预留手机号 |

第一版线下收款的收款主体、方式和币种，与境内主体的设立计划一并在第 11 节确认。

### 10.7 实现（旧仓库 PR #31）：计费账本

第 3 步的第一个计费 PR，只做账本的数据库层、服务端扣费入口和管理员接口，**不调用任何 AI**；AI 网关、`usage_records`、余额检查和入队门槛留给后续 PR。

- **迁移 `0003_billing`**：`org_balances`、`billing_ledger`、`model_prices` 三张表都带 `org_id`、`ENABLE` + `FORCE ROW LEVEL SECURITY`。金额、单价、token 数一律 `bigint`，单位为计费单位（0.0001 元），计价函数 `billing_charge_amount` 用 `numeric` 精确计算后向上取整，结果超出 `bigint` 时报错，没有任何浮点列；
- **账本只追加**：类型为 `recharge`（充值）、`grant`（赠送）、`charge`（扣费）、`reversal`（冲正）。应用角色对账本只有 `SELECT` 和 `INSERT`，且 `INSERT` 只能写本组织的扣费、只能写用量列（`request_id`、`provider`、`model`、`input_tokens`、`output_tokens`），金额、价格版本、余额由触发器填写；没有任何角色被授予 `UPDATE` / `DELETE` / `TRUNCATE`，另有触发器拒绝这三种操作，表属主和超级用户同样被拒绝。录错只能由平台管理员新增一笔 `reversal`：金额与原记录相反、引用原记录（同组织复合外键），每笔最多冲正一次，冲正不能再被冲正；
- **余额只能经账本变化**：`org_balances` 对应用角色只读。账本的 `BEFORE INSERT` 触发器（`SECURITY DEFINER`，属主 `bidtools_billing`）在同一语句中 `SELECT ... FOR UPDATE` 锁住本组织的余额行、按价格表算出金额、检查余额、写入 `balance_after` 并更新余额；任何一步失败，余额更新随语句回滚。因此 `balance = Σ billing_ledger.amount` 由数据库保证，同一组织的入账串行，并发扣费不会扣成负数（另有 `CHECK (balance >= 0)` 兜底）；
- **扣费幂等**：同一组织同一 `request_id` 只扣一次。触发器在持锁后发现已有记录时返回 `NULL` 跳过本行（不报错），服务端再读出首次的结果返回 `duplicate: true`；用量与首次不一致时返回 409 `IDEMPOTENCY_CONFLICT`。`(org_id, request_id)` 唯一约束兜底。不能用 `ON CONFLICT DO NOTHING`：`BEFORE` 触发器先于冲突检测执行，被跳过的行也会改到余额；
- **余额不足**：扣费后余额会小于 0 时整笔拒绝、不入账，服务端返回 402 `INSUFFICIENT_BALANCE`（“余额不足，请充值后再试”）。模型没有价格时返回 503 `MODEL_PRICE_NOT_CONFIGURED`；
- **价格表**：`(org_id, provider, model)` 下按 `effective_from` 分版本，没有 `effective_to`；某一时刻生效的是 `effective_from` 最晚且不晚于该时刻的版本，组织专属价优先于平台默认价。新增版本的生效时间不能早于录入时刻（表上 `CHECK` + 函数校验），所以历史扣费引用的版本和金额都不会变；同一生效时间只能有一个版本（`UNIQUE NULLS NOT DISTINCT`）。只有单价（输入、输出每百万 token）两项，缓存 token、生图、MinerU、最低收费、上游成本留到 AI 网关 PR 按需新增列；
- **服务商**：`provider` 只能是 `deepseek`、`qwen`（`CHECK` 约束，`docs/EXTERNAL_SERVICES.md` §7），新增服务商需要新迁移；
- **管理员函数**：`billing_admin_credit`、`billing_admin_reverse`、`billing_admin_add_price` 都是 `SECURITY DEFINER`，校验 `app.user_id` 是正常状态的平台管理员（否则 `42501`），操作人一律取 `app.user_id` 写入 `operator_user_id` / `created_by`，充值和冲正的备注必填；只授权给 `bidtools_app`；
- **服务端**（`src/billing/ledger.ts`）：`chargeUsage`（供以后的 AI 网关调用，组织来自 `TenantContext`）、`getBalance`、`creditOrganization`、`reverseLedgerEntry`、`addModelPrice`，金额用 `BigInt`，数据库的计费错误码（`BL001`~`BL008`）映射为给用户看的 `AppError`；
- **管理员接口**：`POST /api/admin/billing/credits`、`/reversals`、`/prices`。金额和单价必须是十进制整数字符串（JSON 数字、小数、科学计数法一律 400）；充值要求再次输入金额（`confirmAmount`）做二次确认；每个请求都要重新输入当前密码做二次验证（按管理员限流 10 次 / 15 分钟）；成功后写一条不含密码的 info 日志；
- **与本节设计的偏离**：
  - 扣费写入 `billing_ledger`（第 10.2 节原设计由 `usage_records` 承担扣费），账本同时记录请求编号、服务商、模型和 token 数；不变式相应变为 `balance = Σ billing_ledger.amount`，并由触发器强制而不是每日校验。`usage_records` 仍在 AI 网关 PR 中新增，用于不收费的调用、任务归属和上游成本，收费的调用引用账本记录；
  - 余额**不能为负**（第 10.2、10.3 节原设计允许被进行中的调用透支）。调用后才知道用量、而此时余额不足的情况，旧仓库 PR #32 决定采用调用前预扣冻结、调用后按实际用量结算，第 10.3 节已改写；
  - 第 10.2 节的 `adjustment`（可正可负的更正）改为 `reversal`（整笔冲正），金额不对时先冲正再按正确金额重新录入；`refund`（退款）留到有在线支付时；`low_balance_threshold` 留到余额提醒；
  - 第 10.4 节的 `effective_to` 去掉：设置旧版本的失效时间就是改写历史；
  - **TOTP 和双人复核尚未实现**（第 10.5 节）：暂用重新输入密码做二次验证，并把单笔手动充值 / 赠送的上限写死为 1,000 元（10,000,000 计费单位），超过上限一律拒绝（422 `CREDIT_LIMIT_EXCEEDED`）。TOTP 和第二位平台管理员复核实现后，再用新迁移放开大额充值；已列入路线图第 9 步上线检查；
  - 充值的 `audit_logs` 和给组织 owner 的通知邮件尚未实现：`audit_logs` 表还不存在，账本本身记录了操作人、凭证号和备注；发信服务尚未选定；
  - 有账本记录的组织不能被直接删除（账本外键不级联），注销时财务记录的处理按第 11 节第 1 项“财务与用量记录的法定保留期”的结论另行设计。

### 10.8 实现（旧仓库 PR #32）：AI 网关与预扣冻结

第 3 步的第二个计费 PR：AI 网关、平台凭据的加密存储、`usage_records` 和预扣冻结（第 10.3 节）。`client/` 未改动，没有新增 npm 依赖。

- **迁移 `0004_ai_gateway`**：
  - `usage_records`：每次模型调用一行，**包括不收费的调用**。字段与第 10.1 节基本一致：归属（`org_id`、`user_id`）、来源（`interactive` / `job`）、所属任务（`job_id`、`job_type`）、服务商与模型、冻结时确定的 `price_id`、冻结信息（`estimated_input_tokens`、`max_output_tokens`、`hold_amount`、`hold_expires_at`）、实际用量（含缓存命中 token）、`usage_source`、`amount`、`upstream_cost`、`ledger_entry_id`、`status`（`pending` / `billed` / `unbilled`）、`failure_reason`。**`status = 'pending'` 的行就是冻结**，没有单独的冻结表；
  - 写入只能经 `SECURITY DEFINER` 函数（属主 `bidtools_billing`）：`ai_usage_begin`（冻结）、`ai_usage_settle`（结算）、`ai_usage_fail`（不收费、释放）、`ai_usage_expire_holds`（标记到期未结算的冻结），组织和用户一律取 `app.org_id` / `app.user_id`。应用角色对 `usage_records` 只读、读不到 `upstream_cost`；已结束的记录任何角色都不能修改，任何记录都不能删除（触发器，表属主和超级用户同样）；
  - 账本触发器 `billing_ledger_apply` 替换为新版本：结算的扣费带 `usage_id`（只有计费函数能写这一列），用冻结时的价格版本、以冻结额封顶；不带 `usage_id` 的直接扣费在余额检查中扣除进行中的冻结。每条用量记录最多结算一次（部分唯一索引）。`balance = Σ billing_ledger.amount` 的不变式不变；
  - `model_prices` 新增上游成本单价 `upstream_input_price_per_mtok`、`upstream_output_price_per_mtok`（两项同时为空表示未录入，此时 `upstream_cost` 为 NULL），应用角色改为列级授权、读不到这两列；`billing_admin_add_price` 增加带上游单价的 9 参数版本，管理员定价接口增加 `upstreamInputPricePerMtok`、`upstreamOutputPricePerMtok`（十进制整数字符串，两项同时提供）。**价格全部来自价格表，代码中没有任何单价**；
  - `provider_credentials`：平台级，没有 `org_id`（第 4.2 节），ENABLE + FORCE RLS，应用角色在设置了组织上下文时只读（只有密文）。写入只能经 `ai_admin_put_credential`（校验平台管理员）。`kind` 暂时只有 `text_model`，生图和 MinerU 接入时用新迁移放宽；
- **信封加密**（`src/ai/keyring.ts`、`src/ai/credentials.ts`）：每条凭据一个随机 256 位 DEK，AES-256-GCM 加密 Key；DEK 由 KEK 包装；AAD 绑定 `id | kind | provider | base_url`（JSON 编码）。KEK 来自 `AI_KEK_FILE`（32 字节随机数的 base64，开发环境由 `server/scripts/init-dev-secrets.sh` 生成并经 Docker secret 交给 `api`），只保存在 `KeyWrapper` 闭包中，不进配置对象、日志和数据库；未设置时网关和凭据接口返回 503。生产环境的云 KMS 实现同一接口，留到选定云厂商后；
- **只有网关解密**：解密函数只在 `src/ai/gateway.ts` 中且不导出，单元测试检查整个 `src/` 中只有网关和 KEK 模块使用 `createDecipheriv`、只有网关调用 `unwrap`。明文只在发请求的局部变量中；服务商的错误体不进日志和响应，只保留状态码和规整过的错误码；
- **服务商适配**（`src/ai/providers.ts`）：`deepseek`、`qwen` 都按 OpenAI 兼容的流式 `/chat/completions` 调用（`stream_options.include_usage`），区别只在缓存命中 token 的字段。**Base URL 由平台管理员与 Key 一起配置**，代码中不写死；通义千问用国内站还是国际站待定（第 11 节第 3 项）。上游一律流式调用，客户端要求非流式时由网关聚合；
- **出站防护**（`src/ai/upstream.ts`，第 4.4 节）：Base URL 只能是 https，不能带用户名、查询串和片段；连接时校验实际连接的 IP，拒绝私有、回环、链路本地、组播、保留、IPv4 映射等地址（DNS 解析与连接用同一结果，防 DNS rebinding）；不跟随重定向；响应体上限 32 MB；总时长上限 `AI_UPSTREAM_TIMEOUT_MS`（默认 5 分钟）。`AI_UPSTREAM_PRIVATE_HOSTS` 中的主机可以用 http 和内网地址，用于自托管模型和 CI 中的模拟服务商；
- **接口**：`POST /api/ai/chat`（需要登录，组织取自会话；`stream: true` 时以 SSE 推送 `delta` / `done` / `error`，冻结失败和首段内容到达前的失败仍以普通 JSON 错误返回）；平台管理员的 `GET /api/admin/ai/credentials`（只返回状态和末尾 4 位）、`PUT /api/admin/ai/credentials/:provider`（Base URL + Key + 重新输入密码，每次都要提供 Key，所以改 Base URL 不会沿用旧 Key）；
- **测试**：全部对本机模拟服务商（`server/tests/ai/mockProvider.ts`），CI 不使用真实 Key、不访问外网。覆盖冻结与结算（调用中可用余额减少、结束后释放、按冻结时的价格版本、以冻结额封顶、用量缺失时估算、缓存 token）、余额不足以冻结时不调用服务商、12 个并发调用恰好成功可冻结的 5 个、直接扣费不占用他人冻结、结算与释放互斥、子进程在调用中途被 `SIGKILL` 后冻结到期自动释放、上游各类失败不收费、用户中途断开按估算结算、Key 不进入响应 / 日志 / 错误 / 数据库明文、AAD 被改动时拒绝解密、跨组织隔离和应用角色权限，以及出站地址校验。去掉冻结检查中的“进行中的冻结”、冻结到期条件、结算封顶、上游失败不收费、按冻结时价格结算、直接扣费扣除冻结，或把上游错误体带进错误信息，分别有 2、1、1、12、1、1、2 个用例失败；
- **与设计的偏离 / 未做**：
  - `platform_models`（对用户展示的模型清单、上架状态）尚未建：请求直接给出服务商和模型名，只要价格表中有该模型、平台配置了该服务商的凭据即可调用。设置页的“选择模型 + 查看单价”在建 `platform_models` 时一并实现。**旧仓库 PR #33 已改为白名单，见第 10.9 节**；
  - 第 10.1 节的 `jobs.billed_amount` 要等第 6 步建 `jobs` 表，目前 `usage_records.job_id` 不设外键（6.4 已加 `billed_amount`；`job_id` 按路线图决定事项第 10 项永久不加外键，见第 10.10 节）；
  - `cached_input_price_per_mtok` 未加：缓存命中 token 已记录，但暂按普通输入单价计费；生图、MinerU、`min_charge`、每日消费上限、按组织 + 服务商的并发信号量（第 5.3 节，依赖 Redis；6.4 已实现，见第 10.10 节）未做；
  - `provider_credentials.last_used_at`、DEK 缓存未做（文件 KEK 解包几乎没有开销，换成 KMS 时再加缓存）；管理后台的“模型列表 / 连通性测试”未做；
  - 网关目前在 `api` 进程中运行（交互式的 `ai.chat`），第 6 步 worker 建成后任务调用在 worker 中使用同一模块（6.4 已接入，见第 10.10 节）；
  - 函数属主沿用 `bidtools_billing`，没有新增集群级角色。

### 10.9 实现（旧仓库 PR #33）：平台模型白名单

旧仓库 PR #32 的规则是“价格表里有生效价格、平台配置了该服务商的凭据就能调用”，存在两个问题：任何录过价的模型都能被调用（包括只是预先录价、还没决定上架的模型）；价格为 0 / 0 的版本等于**默认免费**，录错一次价格就会让平台承担上游费用。旧仓库 PR #33 改为白名单：

- **迁移 `0005_platform_models`**：`platform_models`（`provider`、`model`、`is_free`、`enabled`、`note`、操作人与时间），每个 (服务商, 模型) 一行，平台级、没有 `org_id`，ENABLE + FORCE RLS，应用角色在设置了组织上下文时只读。写入只能经平台管理员函数 `ai_admin_register_model`（**登记后默认停用**）、`ai_admin_set_model_enabled`；服务商、模型名、免费标记和备注登记后不能修改，记录不能删除（停用即可），触发器对表属主和超级用户同样生效；
- **可调用的条件**（内部函数 `ai_model_price`，按顺序检查）：已登记，否则 404 `AI_MODEL_NOT_REGISTERED`；已启用，否则 403 `AI_MODEL_DISABLED`；对该组织有生效价格（专属价优先于默认价），否则 503 `MODEL_PRICE_NOT_CONFIGURED`；**未标记 `is_free` 时零价格（输入、输出都为 0）视为未定价**，同样 503；标记了 `is_free` 但生效价格不为零时 503 `AI_MODEL_PRICE_CONFLICT`（标记与价格矛盾时拒绝，不按任何一边计费）。也就是说免费模型需要管理员**两次显式操作**：登记时 `isFree: true`，并录入 0 / 0 的价格；
- **检查两次，用同一个函数**：网关在解密 Key 之前经 `ai_model_check` 预检（不能调用时不解密、不冻结、不调用服务商）；`ai_usage_begin` 在冻结的同一事务中再检查一次，绕过网关直接冻结同样被拒绝。冻结之后才停用的模型，进行中的调用照常结算；
- **伪造服务商名**：服务商只能是 `deepseek`、`qwen`（接口的 JSON Schema、网关参数校验、表的 CHECK 约束三层），其他名字 400；白名单按 (服务商, 模型) 成对匹配，把真实服务商配上别家登记的模型名同样 404；
- **管理员接口**：`GET /api/admin/ai/models`（附当前生效的平台默认价和状态 `available` / `disabled` / `unpriced` / `price_conflict`；组织专属价可能让个别组织的结果不同，以调用时的检查为准）、`POST /api/admin/ai/models`（登记，`isFree` 必填且只接受 JSON 布尔值，要求重新输入密码）、`POST /api/admin/ai/models/:id/enable`（要求重新输入密码）、`POST /api/admin/ai/models/:id/disable`（收紧方向，不要求密码，便于紧急下线）；
- **用户断开**：`POST /api/ai/chat` 在连接关闭时中止网关调用，网关把取消信号传给上游请求，立即关闭到服务商的连接；已产生的用量照常结算（第 10.1 节）。本 PR 补了两处：处理函数开始前连接就已断开时直接取消（此前 `close` 事件已经错过，上游调用会跑完）；网关在冻结之前检查取消信号，已取消则不冻结、不调用服务商；
- **测试**：未登记（含价格表里有价但未登记）、已登记未定价（含只有将来生效的价格）、零价格未标记免费（含组织专属零价格）、免费标记与价格矛盾、登记后默认停用 / 停用后、伪造服务商名，均被拒绝，且**不调用服务商、不写用量记录、不扣费、余额和可用余额不变**，直接调用 `ai_usage_begin` 同样被拒；用真实 TCP 连接测试用户断开（流式收到第一段后断开、非流式在服务商返回前断开），上游超时设为 60 秒，断言上游连接在 1 秒内关闭、按估算结算且没有冻结残留。冻结时不查白名单、去掉零价格规则、去掉启用检查、去掉网关预检、去掉断开时的中止，分别有 5、2、3、1、2 个用例失败；
- **与设计的偏离 / 未做**：
  - 第 4.1 节的 `platform_models` 还包括对用户展示的名称、上游模型 ID、能力（文本 / 生图 / 解析）、`org_settings.platform_model_id`、设置页的“选择模型 + 查看单价”和管理后台的连通性测试，本 PR 只做调用白名单，以上留到后续 PR；请求仍直接给出服务商和模型名，`usage_records` 暂不记 `platform_model_id`；
  - 免费标记登记后不能修改，要改需要后续提供专门的接口；登记、启用、停用暂只记在表的操作人字段和日志中，`audit_logs` 建好后补；
  - 不经冻结的直接扣费 `chargeUsage`（旧仓库 PR #31）不调用服务商，没有接入白名单；
  - 已有的开发数据库迁移后，所有模型都需要管理员登记并启用才能调用。

### 10.10 实现（路线图 6.4）：worker 中的任务调用与余额

- **网关在 worker 中运行**：worker 与 api 使用同一个 `src/ai/gateway.ts`，各自加载主密钥；任务经 `context.ai.chat()` 调用，`source = 'job'`、`job_id`、`job_type` 由执行者填写，任务代码不能指定。冻结时（`ai_usage_begin`）任务必须属于本组织且状态为 `running`，`job_type` 以任务记录为准；
- **按任务聚合**：`jobs.billed_amount` 由 `ai_usage_settle` 在扣费的同一事务中累加，只增不减，应用角色不能写；任务结束后才到达的结算照常累加。`usage_records.job_id` 不加外键（任务记录有保留期，用量记录永久保留），任务删除后按任务的费用仍可从用量记录汇总；
- **入队门槛**：会调用模型的任务类型（`billable`）入队和从暂停继续前，经 `billing_job_start_check()` 要求可用余额（余额 − 未到期的冻结）≥ 1 元，否则 402 `INSUFFICIENT_BALANCE`；
- **运行中耗尽**：冻结失败时网关返回 402，执行者把任务改为 `paused`、`pause_reason = 'insufficient_balance'`，写带原因的 `paused` 事件并推送 `job` 事件；之后本次执行中的调用直接失败。充值后继续，从 checkpoint 开始，已扣费的调用不重做；
- **并发信号量**（`src/ai/concurrency.ts`）：键 `ai:concurrency:{orgId}:{provider}` 的有序集合，Lua 脚本原子地清掉到期名额、判断上限、加入令牌；名额最长占用一个冻结时长，崩溃时到期自动收回。上限 = min(`org_settings.concurrency_limit`，`AI_CONCURRENCY_MAX`)；网关在白名单检查之后、解密 Key 和冻结之前取得名额。交互式调用最多等 `AI_CONCURRENCY_WAIT_MS` 后 429 `AI_CONCURRENCY_LIMITED`，任务中的调用一直等到被取消；Redis 不可用时不放行（503 `AI_CONCURRENCY_UNAVAILABLE`），api 未配置 Redis 时不限制。Redis 被清空时名额一起消失，短时间内可能超出上限，不影响计费；
- **步骤幂等（路线图 6.4a，#34）**：平台自身故障导致的重复调用不向用户收费。任务的每次模型调用带步骤键，完整的调用结果与结算在同一事务中写入 `job_step_results`（迁移 0025），续跑时同一步骤、同一请求内容（SHA-256）的调用直接取回结果，不冻结、不调用服务商、不扣费；两个执行者并发完成同一步骤时后提交的不收费（`duplicate_step`）；worker 关闭、租约丢失中止的调用不收费（`platform_interrupted`），用户取消、暂停中止的照旧按已产生的用量收费；
- 细节与偏离见路线图“worker 接入 AI 网关与余额（#27，6.4）”。

### 10.11 实现（路线图 8.3a～8.3c）：Agent 任务的费用与轮数上限

被注入的 Agent 可以无限调用模型直到余额耗尽（第 8 步威胁模型 T5），因此每个 Agent 任务有一份**任务级上限**，由数据库强制（迁移 0033、0034，`src/agent/budget.ts`）：

- **登记**：`agent` 队列的任务类型必须在定义中给出 `agentLimits`（费用上限、轮数上限，起步值见 `AGENT_TASK_LIMITS`：正文生成 30 元 / 3,000 轮，章节重写与原方案还原、目录与全局事实类各 5 元 / 500 轮，模板提取 3 元 / 300 轮），其他队列不能给出（登记时检查）；入队时与任务在同一事务中写入 `agent_job_budgets`。上限写入后只能经确认继续（见下）改，轮数只能逐次加 1、不超过上限，达到上限的原因只能设置一次（触发器 `AB001`）；只能为本组织 `queued` 的任务写入、只在 `running` 时更新；
- **费用**：`ai_usage_begin` 在锁住组织余额的同一事务中检查“`jobs.billed_amount` + 本任务未到期的冻结 + 本次冻结 ≤ 费用上限”，否则 `BL016` → 409 `TASK_COST_LIMIT`，不冻结、不调用服务商。结算也先锁组织余额，并发的冻结与结算按顺序检查，已扣费不超过上限。没有登记上限的任务（第 6 步的任务）不受影响；
- **轮数**：Agent 的模型调用路由在调用网关之前按令牌的任务原子地计入一轮（一条带条件的 `UPDATE`），**取回已保存结果的请求同样计入**；达到上限即 409 `TASK_TURN_LIMIT`，不取回、不冻结、不调用服务商。没有登记上限的任务一律 409 `AGENT_BUDGET_MISSING`。worker 中 Agent 任务经 `context.ai` 的调用同样先计入一轮；
- **暂停**：达到任一上限后记下原因，之后的请求按该原因拒绝；执行者把任务暂停为 `paused`，`pause_reason` 为 `task_cost_limit` / `task_turn_limit`，`paused` 事件记下已扣费、上限与已用轮数。这类暂停不能经普通的“继续”恢复（409 `JOB_TASK_LIMIT_CONFIRM_REQUIRED`），由发起人或组织管理员确认继续（8.3b）；取消照常。暂停的同一事务中补记达到上限的原因（执行者没能记下时），作为确认继续的前提；
- **确认继续（8.3b，迁移 0034，`confirmTaskLimit`、`POST /api/jobs/:jobId/confirm-limit`）**：任务**发起人**或组织 **`owner` / `admin`** 确认（同组织的其他成员 403 `JOB_CONFIRM_FORBIDDEN`，其他组织 404），上限各加一份（“一份”= 入队时的上限，存于 `cost_step` / `turn_step`，写入时由触发器取值、之后不能改），清除原因，任务回到 `queued` 并派发，从 checkpoint 续跑；继续前照常检查最低启动余额（不足 402、什么都不改）；再加一份会超出范围（费用 10,000 元、轮数 1,000,000）时 409 `TASK_LIMIT_MAX_REACHED`；只有因上限暂停的任务可以确认（否则 409 `JOB_NOT_LIMIT_PAUSED`）。确认记录（确认人、原因、已花费金额、已用轮数、之前与新的上限、第几次确认）写入 `resumed` 事件。数据库守卫另外强制：上限只能在一次更新中同时各加一份、确认次数加 1、清除原因、轮数不变；之前确实已达到上限（一次达到上限只能确认一次，并发确认只加一份）；任务因上限暂停；当前用户是本组织成员且是发起人或 `owner` / `admin`（没有用户上下文的 worker、超级用户一律拒绝）；计入轮数与记下原因仍只在 `running` 时。`GET /api/jobs/:jobId` 另返回 `agentBudget`（上限、已用轮数、原因、一份额度、确认次数），供确认页面显示；已花费金额为 `billedAmount`。
- **按组织覆盖（8.3c，迁移 0035，`src/agent/limitOverrides.ts`、`/api/admin/agent-limits`）**：**平台管理员**可为某个组织的某个 Agent 任务类型另设费用与轮数上限（两项一起覆盖，范围同上），入队时在同一事务中取覆盖值写入 `agent_job_budgets`，没有覆盖值时取起步值；“一份”额度随之取覆盖值。覆盖只影响之后入队的任务。表 `agent_job_limit_overrides` 的写入、删除与跨组织列出只经平台管理员的 SECURITY DEFINER 函数（属主 `bidtools_billing`，校验平台管理员），应用角色只能读本组织的行，组织成员（含 owner）不能改自己的上限（组织 owner 自己调整以后与每日消费上限一起做，第 10.3 节）。设置与删除要求重新输入密码，操作写结构化日志。

## 11. 合规待确认事项

服务器在境外（香港）、面向中国大陆用户，并由平台统一提供 AI，下列事项**上线前必须完成**确认和落实，已同步加入路线图第 9 步的上线检查。本节只列需要确认的问题，不是法律意见，结论需由熟悉中国大陆数据合规和生成式 AI 监管的律师给出；确认结果写回本节，并按结论修改相关设计。

| # | 事项 | 背景 | 需要确认 | 可能影响的设计 | 状态 |
|---|---|---|---|---|---|
| 1 | **个人信息出境** | 大陆用户的账号信息（邮箱、第二版的手机号）、上传文档中的个人信息（投标文件和资信库中的人员简历、身份证号、证书等，可能属于敏感个人信息）都存储在香港服务器；Prompt 中的个人信息还会再发给境外模型服务商 | 《个人信息保护法》对境外处理者向境内个人提供服务的适用情况（含是否需要指定境内代表）；个人信息出境的合规路径（安全评估、标准合同备案、认证或豁免情形）及触发门槛；告知与单独同意的写法；个人信息保护影响评估；向模型服务商再转移时的要求；备份跨地域复制（第 8.4 节）的目的地限制；财务与用量记录的法定保留期 | 隐私声明和注册流程（单独同意）；资信库敏感字段的加密或脱敏；备份地域；可选的模型服务商 | 待确认，上线前必须完成 |
| 2 | **生成式 AI 监管** | 平台向大陆用户提供基于大模型的文本和图片生成服务 | 《生成式人工智能服务管理暂行办法》等规定是否适用（仅邀请注册的企业用户是否属于“向公众提供”）；境外提供者面向境内用户的要求；是否需要算法备案、生成式 AI 服务上线备案或登记，所用模型本身是否需已备案；《人工智能生成合成内容标识办法》（2025-09-01 施行）对生成内容显式 / 隐式标识的要求，导出的 Word 是否需要标识；内容安全审核、投诉举报渠道、用户真实身份信息要求 | 可上架的模型；导出时加标识；输入输出内容审核；用户实名（可能使短信登录提前）；用户协议 | 待确认，上线前必须完成 |
| 3 | **模型服务商对中国大陆用户的条款限制** | 平台统一采购模型服务再提供给大陆用户，属于转售或再分发 | 逐家确认拟上架服务商的条款：支持地区是否包含中国大陆（多家境外服务商的支持地区不含中国大陆，并禁止向不受支持地区转售或提供访问）；是否允许转售 / 作为平台能力提供给第三方；从香港调用是否受限；数据是否用于训练、存储地区、保留期；是否需要企业协议。境内服务商的国际站与境内站条款不同，也需分别确认 | `platform_models` 的上架清单；价格表；隐私声明中的第三方清单 | 待确认，上线前必须完成 |
| 4 | **收款主体与第二版前置条件** | 第一版由管理员手动充值，收款方式未定；第二版的在线支付、发票、短信都依赖境内主体 | 第一版线下收款的收款主体、方式和币种是否合规；境内主体的设立计划和时间 | 第 10.5、10.6 节 | 待确认，上线前必须完成 |
