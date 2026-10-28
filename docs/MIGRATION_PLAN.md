# client Web 化改造路线图

> **仓库迁移说明**：本项目已从旧仓库 `museaicode/Bidtools` 迁移到本仓库，以旧仓库 `main` 的最新快照作为单个初始提交，不含历史提交。旧仓库仅作为历史档案保留，不再接受改动。本文及其他文档中“旧仓库 PR #N”均指旧仓库的 PR；本仓库新建的 PR 直接写 `#N`。迁移时已取得原作者的商业授权，本项目改为闭源商业授权，原 `LICENSE`、`NOTICE` 和原作者归属信息已删除。

本文是 `client/` 从 Electron 桌面客户端改造成 Web 服务的路线图，内容来自 旧仓库 PR #1 的分析报告（以合并时的 `main` 为基线）。每个改造 PR 完成后更新下面的进度表；实际做法偏离路线图时，在 PR 中说明原因并同步修改本文。

## 进度

| 步骤 | 内容 | 状态 | PR |
|---|---|---|---|
| 0 | 前置：处理高危依赖漏洞，确定 AGPL 第 13 条源码链接方案，新增 PR CI，移除原作者的发布与镜像 workflow，梳理外部服务 | 已完成 | 旧仓库 PR #3、旧仓库 PR #4、旧仓库 PR #5、旧仓库 PR #6、旧仓库 PR #7、旧仓库 PR #8、旧仓库 PR #9、旧仓库 PR #10、旧仓库 PR #11、旧仓库 PR #12、旧仓库 PR #13、旧仓库 PR #14、旧仓库 PR #15、旧仓库 PR #16、旧仓库 PR #17、旧仓库 PR #18、旧仓库 PR #19、旧仓库 PR #20 |
| 1 | 抽象 bridge | 进行中 | 旧仓库 PR #21（决定记录）、旧仓库 PR #22（Vitest）、旧仓库 PR #23（修复 output_token_limit）、旧仓库 PR #24（新建 `src/shared/bridge`） |
| 2 | 服务端骨架 | 进行中 | 旧仓库 PR #25（设计文档 `docs/SERVER_DESIGN.md`）、旧仓库 PR #26（决定 18 项事项，新增计费与合规章节）、旧仓库 PR #27（`server/` 基础设施：配置、日志、`/healthz`、错误处理、安全响应头、Docker、CI）、旧仓库 PR #28（数据库层：PostgreSQL 17、Kysely 迁移、身份与租户表、RLS、`TenantContext`、`/readyz`）、旧仓库 PR #29（鉴权：登录前查询的 `SECURITY DEFINER` 函数、argon2id、服务端会话与 CSRF、邀请注册、找回密码、限流、平台管理员命令行）、旧仓库 PR #30（限流的客户端 IP：新增 `TRUSTED_PROXIES`，只采信可信代理附加的 `X-Forwarded-For`）、#13（测试 harness：删除测试库前等连接全部断开，修复收尾时偶发的 57P01；同 PR 在 `CLAUDE.md` 新增自动合并规则） |
| 3 | 配置与 AI 网关 | 进行中 | 旧仓库 PR #31（计费账本：组织余额、只追加的账本、带版本的价格表、幂等扣费、管理员手动充值与冲正，不调用 AI）、旧仓库 PR #32（AI 网关：调用前预扣冻结、按实际用量结算、冻结超时自动释放、`usage_records`、平台 Key 信封加密、DeepSeek / 通义千问流式适配、`POST /api/ai/chat`）、旧仓库 PR #33（平台模型白名单 `platform_models`：只有登记且启用、并有生效价格的模型能调用，免费须显式标记；管理员登记 / 启用 / 停用接口；用户断开时中止上游请求的端到端测试） |
| 4 | 文件上传 / 下载 / 资源协议 | 进行中 | 旧仓库 PR #34（文件存储：S3 兼容对象存储、本地 SeaweedFS、`files` 表与强制 RLS、按内容校验类型、大小上限与组织配额、附件方式下载、7 天恢复期）、#6（上传白名单补齐桌面版能导入的内容：OLE 内容的 `.docx`，`.doc/.wps` 的 RTF / HTML / MHT / Word 2003 XML，`.xls` 的 HTML 表格 / SpreadsheetML，`%PDF-` 前有多余字节的 PDF） |
| 5 | 数据层迁移（按业务逐个） | 已完成 | 旧仓库 PR #35（拆分计划，见“第 5 步说明”；记录上传白名单与桌面版的差距）、#7（5.1 项目：`projects` 表、`files.project_id`、项目接口、路由层归属校验、项目级表的迁移与测试模板）、#8（5.2 生成产物存储：`artifacts` 表、Store、只读接口；项目软删除与其下文件、产物联动，由 RLS 强制）、#9（5.3 配置：`org_settings`、`user_settings`、`GET/PATCH /api/settings`；写权限与删除可见性由 RLS 强制）、#10（5.4 导出模板：`export_templates`、`/api/export-templates` 增删改查与复制；系统模板只读、修改删除权限由 RLS 强制，迁移命令同步系统模板）、#11（5.5 资信库：6 张表、`/api/credential-library`；权限与删除可见性由 RLS 强制，图片随所引用文件的生命周期）、#12（5.6 知识库（一）：`knowledge_folders`、`_documents`、`_document_steps`、`/api/knowledge-base` 文件夹与文档管理；权限与删除可见性由 RLS 强制，文档随原件的生命周期）、#14（5.7 知识库（二）：切块、条目、匹配结果等 7 张表，检索与读取条目 / 分析 / Markdown 接口；删除可见性与写权限由 RLS 强制，随文档可见）、#16（5.8 标书查重：13 张项目级表、`/api/projects/:projectId/duplicate-check` 状态 / 文件选择 / 页面状态 / 清空 / Excel 导出；删除可见性与写权限由 RLS 强制，随项目和所选原件可见）、#17（5.8 后续：`files.project_id` 设置后不能再改，由触发器强制；xlsx 写出器防公式注入，回车按原样写出）、#18（5.9 废标检查：7 张项目级表、`/api/projects/:projectId/rejection-check` 状态 / 导入与移除文档 / 页面状态 / 切换与删除问题 / 清空 / Excel 导出；删除可见性与写权限由 RLS 强制，文档随原件可见，签名由服务端现算）、#19（5.10 可研报告：4 张项目级表、`/api/projects/:projectId/feasibility-report` 状态 / 步骤 / 项目信息 / 资料分析 / 目录配置 / 目录（`reason` 协议）/ 关键参数 / 正文 / 资料导入与移除 / 资料 Markdown / 清空；删除可见性与写权限由 RLS 强制，资料随原件、引用随知识库文档可见）、#20（5.11 技术方案（一）：6 张项目级表、`/api/projects/:projectId/technical-plan` 状态 / 步骤 / 生成配置 / 招标解析配置 / 正文生成选项 / 招标文件导入与移除 / 招标文件与合并正文的 Markdown / 原方案 / 投标范围选择 / 清空；删除可见性与写权限由 RLS 强制，文档随原件、引用随知识库文档可见，导出模板只能是本组织的或系统模板）、#21（5.12 技术方案（二）：目录与全局事实 2 张项目级表、`PUT .../outline`（`reason` 协议，节点 UUID 稳定、编号现算）与 `PUT .../global-facts`，下游清空扩展到目录与全局事实；删除可见性与写权限由 RLS 强制））、#22（5.13 技术方案（三）：正文生成状态与编排 2 张项目级表、`PUT .../chapters/:nodeId`、`DELETE .../content-generation`，目录保存与全局事实、下游清空扩展到正文生成状态、编排与运行进度；废标检查 `POST .../tender-from-technical-plan` 复制原件与 Markdown；删除可见性与写权限由 RLS 强制） |
| 6 | 任务队列与 worker | 进行中 | #23（拆分计划，见“第 6 步说明”）、#24（6.1 Redis 接入：Valkey 8 开启 ACL、`REDIS_URL` / `REDIS_PASSWORD[_FILE]`、`/readyz` 检查 Redis、CI 起 Valkey）、#25（6.2 `jobs` / `job_events` 表与 worker 骨架：BullMQ 只派发、`jobs` 为唯一权威，认领加 `run_id` 隔离令牌与数据库租约，Redis 重启或清空后从 `jobs` 对账恢复入队；新增定义者角色 `bidtools_jobs`）、#26（6.3 SSE 推送 `GET /api/events`：每组织一条 Stream + 频道，`Last-Event-ID` 补发与 `resync`、心跳、会话定期重新校验、单用户连接数上限；任务状态、进度、日志经 worker 推送，取消 / 暂停经控制频道立即送达 worker）、#27（6.4 worker 接入 AI 网关与余额：任务调用记 `job_id` / `job_type`，`jobs.billed_amount` 在结算的同一事务中累加，入队和继续前检查最低启动余额 1 元，运行中余额不足暂停为 `paused` / `insufficient_balance` 并推送，按“组织 + 服务商”的 Redis 分布式信号量）、#28（6.5 解析沙箱基础设施：`sandbox-runner` 服务、`SandboxDriver` 接口、断网的 `parse` 模板与镜像，取回归档逐项校验，gVisor 下的隔离测试）、#29（测试修复：`jobQueue.test.ts` 中模拟清空 Redis 的 `wipeQueueKeys` 改为原子的 Lua 脚本，清空后的断言改为“被清空的任务不再被任何键引用”，消除与运行中 worker 的竞态）、#30（6.6 解析任务（一）：`document-parse` 任务在断网沙箱中按记录的 MIME 解析二进制与纯文本格式，ZIP 炸弹与 PDF 页数检查，产物经 `writeArtifact` 写入、重新解析时旧产物标为已被替换（迁移 0023），三个模块导入后自动入队；parse 镜像加入解析入口与 LibreOffice 安全设置；沙箱总数上限的测试）、#31（6.6 补充：LibreOffice 转换超时改为对整个进程组 SIGKILL，补“解析卡住时任务按时结束并销毁沙箱”的测试）、#32（6.7 解析任务（二）文本类格式：Office 2003 XML 含 DTD 即拒绝，RTF 去掉域指令与 OLE 链接，HTML 按白名单重新生成、不留任何远程资源，MHT 先解开 MIME；恶意样本与对照组测试，远程资源测试在沙箱内监听所有连接）、#33（6.8 清理任务：新增定义者角色 `bidtools_cleanup`（迁移 0024），worker 每小时跨组织删除超过保留期的文件、产物、项目、遗留上传与任务记录，先删对象后删行，孤儿对象，冻结到期收尾移到 worker；清理角色对计费表没有任何权限）、#34（6.4a 步骤幂等：迁移 0025 新建 `job_step_results`，任务调用必须带步骤键，结果与结算同一事务提交，续跑时同一步骤取回结果、不再调用服务商、不再扣费；worker 关闭、租约丢失中止的调用不收费）、#35（6.9 废标检查任务：`rejection-items-extraction`、`rejection-check-run`，招标文件按导入顺序合并正文，结果带开始时的签名写入、文档变化后旧任务的写入被拒绝，状态中返回最近的任务；第一个调用 AI 的业务任务，按步骤键续跑不重复扣费） |
| 7 | OpenXmlHelper 容器化与离屏渲染（前置：CI 新增 .NET 编译与 OpenXmlHelper 测试，见“第 9 步说明”的品牌改名第三部分） | 未开始 | — |
| 8 | Agent 沙箱 | 未开始 | — |
| 9 | 收尾与上线 | 进行中 | #1（品牌改名第一部分：用户可见文字和文档）、#2（品牌改名第二部分：代码标识符、数据与协议、打包，新增 CI 禁用词检查）、#5（品牌改名第三部分：原产品名缩写前缀改为中性前缀 `app`，禁用词检查加入该缩写） |

状态取值：未开始 / 进行中 / 已完成。一步由多个 PR 完成时，在“PR”列依次列出编号。

### 第 0 步细项

| 细项 | 状态 | PR |
|---|---|---|
| 0.1 `npm audit fix`（不加 `--force`）+ 零代码升级：lockfile 内升级、`brace-expansion` 升到 5.0.12、`overrides` 把 pi-coding-agent 内的 `undici` 升到 8.10.2 | 已完成 | 旧仓库 PR #3 |
| 0.2 `pdfjs-dist` 升到 6.x：改 `doc2markdown/convert.mjs` 的销毁调用，并解决与 `pdf-parse` 内置 pdfjs 5.4.296 的版本冲突（实际做法：升到 6.4.299，表格提取用本模块专用的 `PDFWorker`，见下方说明） | 已完成 | 旧仓库 PR #4 |
| 0.3 `xlsx` 换成 SheetJS 0.20.3：`convert.mjs` 的 ESM 读取改成 `XLSX.read(buffer)`（实际做法：官方 CDN 的 tarball 存入 `client/vendor/xlsx-0.20.3.tgz`，`package.json` 用 `file:` 引用，见下方说明） | 已完成 | 旧仓库 PR #5 |
| 0.4 `patch-package`（`braces` / `micromatch` 没有修复版，仅开发期 postinstall 使用）：**接受风险**，见下方说明；后续升级 `@docx-editor.dev/core` 时顺带评估去掉补丁 | 已完成（接受风险） | 旧仓库 PR #18 |
| 0.5 AGPL 第 13 条源码链接方案：**上线前决定**，开发期间仓库保持公开，见下方说明（迁移到新仓库后改为闭源商业授权，已不再需要） | 已完成（不再需要） | 旧仓库 PR #18 |
| 0.6 PR CI：`.github/workflows/ci.yml`，每个 PR 和推送到 `main` 时在 `client/` 下跑 `npm ci`、`npm run build`、`electron/` 下全部 `.cjs`/`.mjs` 的 `node --check`、`npm audit --audit-level=critical` | 已完成 | 旧仓库 PR #6 |
| 0.7 删除原作者的发布与镜像 workflow：`sync-mirrors.yml`、`sync-releases.yml`、`star-history.yml`、`release.yml`，以及 `.github/scripts/` 中只被它们调用的脚本；保留 `ci.yml` | 已完成 | 旧仓库 PR #7 |
| 0.8 外部服务清单与独立运营评估（只读分析，不改代码）：`docs/EXTERNAL_SERVICES.md` | 已完成 | 旧仓库 PR #8 |
| 0.9 按 `docs/EXTERNAL_SERVICES.md` §3 修改 `AGENTS.md`、`client/开发说明.md` 中与独立运营冲突的规则（只改文档） | 已完成 | 旧仓库 PR #9 |
| 0.10 外部服务 P0：移除 Agent 失败诊断上传（`/agent-errors`），失败信息改为只写本机日志 | 已完成 | 旧仓库 PR #10 |
| 0.11 外部服务 P0：默认文本模型不再是“内测版”，改为未配置并在启动时引导用户配置；移除启动时匿名注册和下发 API Key 写入本地配置；设置页隐藏“内测版”选项（代码保留）。默认生图模型另开细项 | 已完成 | 旧仓库 PR #11 |
| 0.12 外部服务 P0：默认生图模型改为未配置；旧配置中已选中“内测版”的文本模型按 `docs/EXTERNAL_SERVICES.md` §2.2 方案 2 一次性迁移为未配置，官方 Key 保留不用，启动时提示用户 | 已完成 | 旧仓库 PR #12 |
| 0.13 外部服务 P1：停用插件系统。Main 不再注册插件 IPC、不加载已安装插件、不请求 `/plugins`；Renderer 隐藏插件管理菜单、插件更新提示和依赖桌宠插件的“AI 调整”入口。代码保留，Web 版计划下线 | 已完成 | 旧仓库 PR #13 |
| 0.14 外部服务 P0：远程公告不再渲染原始 HTML，排查所有远程内容和 AI 输出的渲染位置，`MarkdownRenderer` 默认禁用原始 HTML 并加标签/属性/协议白名单；`config:load` 返回的 API Key 和 MinerU Token 一律打码，界面只看到“已配置/未配置”和末尾几位，保存时空值表示不修改 | 已完成 | 旧仓库 PR #14 |
| 0.15 外部服务 P0（远程控制类）：移除 IP 封禁（`/ip-blocks`）及命中即退出；移除授权链路（许可证校验、过期/“来源不可信”弹窗、离线授权、公钥与构建证明）；停用原作者的 GitHub / AtomGit / Cloudflare 更新渠道，更新源改为随包配置且默认为空，验签实现前不下载；汇总桌面版待测清单 | 已完成 | 旧仓库 PR #15 |
| 0.16 外部服务 P1/P2（剩余原作者内容服务）：埋点、公告、更新日志、资源页、群二维码、模型信息、使用文档、打赏的地址改为构建时写入 `electron/resources/remote-services.json`，默认全部为空，为空时不发请求、隐藏入口或显示空状态；`client_id` 改为随机安装标识，旧的机器码派生 ID 读取时替换；删除从未挂载的启动广告组件 | 已完成 | 旧仓库 PR #16 |
| 0.17 外部服务（内测版服务）：整体移除“内测版”文本模型服务商和官方账户（服务、IPC、preload API、类型、设置页账户面板、默认 Base URL、请求头、余额不足跳转），删除 旧仓库 PR #11 的隐藏开关和 旧仓库 PR #12 的迁移提示；旧配置为 `official` 时直接切到“自定义”，本地官方会话文件和官方 Key 不删除、不读取 | 已完成 | 旧仓库 PR #17 |
| 0.18 第 0 步收尾：删除设置页金龙“获取 Key”推广链接 `s.markup.com.cn/jl`，并整体移除“金龙中转站”预置服务商（文本和生图），旧配置迁移为“自定义”；删除侧边栏“加群”按钮、内置的原作者用户群二维码和远程二维码查询；删除 `文章/` 目录；记录 0.4、0.5 和“不自建 analytics Worker”的决定 | 已完成 | 旧仓库 PR #18 |
| 0.19 清理原作者的非归属类信息（`LICENSE`、`NOTICE`、署名和原仓库链接不动）：删除 `analytics/` 目录和客户端中只为它服务的埋点、安装标识与内容服务代码（公告、更新日志、资源页、模型信息）；删除原作者的历史更新日志、使用说明中的原作者内容和 `screenshots/` 中的赞助商图片；README 改写为中性说明；删除 `configStore` 中“官方”“金龙”旧配置的迁移代码；删除失效的 `check:docx`（连同同样失效的 `check:chrome`、`check`）；全局搜索剩余引用并分类 | 已完成 | 旧仓库 PR #19 |
| 0.20 继续清理原作者的非归属类信息（`LICENSE`、`NOTICE`、署名和原仓库链接不动）：删除 `.github/FUNDING.yml` 和 AtomGit 发布工具；删除 原用户手册技能目录 `.agents/skills/`、`assets/star-history/` 和 `screenshots/`；删除打赏功能；“给作者点 star”提示改为“功能开发中”；删除 `html图片.md` 中的 `mt.agnet.top` 一段；问题反馈模板、`SECURITY.md`、`CODE_OF_CONDUCT.md` 的联系邮箱改为占位符，`CONTRIBUTING.md` 改写；隐私声明第 01、02 条改为中性表述 | 已完成 | 旧仓库 PR #20 |
| 0.21 依赖漏洞（2026-10 新公告，lockfile 内升级、不改 `package.json`）：`server/` 的 `vite` 8.3.2 → 8.3.3（vitest 的开发依赖，launch-editor 命令注入，CI 的 `--audit-level=high` 因此失败），`client/` 的 `follow-redirects` 1.16.0 → 1.16.1（开发依赖 `wait-on` → `axios` 传递引入，跨域时凭据头未剥离）；两个版本都按依赖规则发布满两周 | 已完成 | #15 |

0.2 的实际做法与原方案 B 的差异：没有另起 worker 线程，也没有调整调用顺序（Electron 主进程里多次转换时，只调顺序不够），而是在 `convert.mjs` 加载时用 pdfjs 6 自己的 worker 建一个专用 `PDFWorker` 传给 `getDocument`，然后清掉 `globalThis.pdfjsWorker`，让 pdf-parse 照常加载自己的 5.4.296。同一 PR 还补了 `cMapUrl` / `standardFontDataUrl`（非嵌入中文字体），并修了 `constructPath` 遇到空路径（`null`）时抛错的问题。之前因为版本冲突，这条路径从来没有跑到，所以这个问题一直没暴露。

0.3 的做法：SheetJS 从 0.18.5 起不再发布到 npm 官方仓库，路线图原先在“官方 CDN”和“npm 镜像”之间待定，最终选了官方 CDN，但不在安装时联网下载，而是把 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` 存进 `client/vendor/`，`package.json` 写 `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`。这样安装不依赖 cdn.sheetjs.com 的可用性，也不用信任第三方镜像；`package-lock.json` 的 `integrity` 记录了 tarball 的 sha512，文件被改动时 `npm ci` 会拒绝安装。官方没有发布校验值，核对方式是把 tarball 内容与 npm 官方仓库上独立重新发布的 `@e965/xlsx@0.20.3` 逐文件比对：全部 24 个代码文件一致，只有包名、仓库地址和 README 不同。升级 SheetJS 时替换这个文件、重新 `npm install --save ./vendor/xlsx-<版本>.tgz`，并重新核对校验值。`vendor/` 不在 electron-builder 的 `files` 里，tarball 不会进安装包。

0.6 是路线图外新增的细项：后续改造 PR 都要过同一套构建和审计，先把检查固化到 CI，避免依赖每次手工执行。CI 只读（`permissions: contents: read`），不使用任何 secret，与原有发布类 workflow 互不影响；high 级漏洞（目前是 0.4 里 `patch-package` 带进来的 `braces` / `micromatch`）不让 CI 失败，仍按 0.4 跟踪。

0.7 是路线图外新增的细项：这四个 workflow 依赖原作者的 secret、变量和自托管 Runner（AtomGit、Gitee、Cloudflare R2、构建证明私钥、Star History token），在本仓库要么跑不通，要么每次 push 都失败；`release.yml` 还会以原作者名义构建并签发桌面安装包。删掉后本仓库只剩只读的 `ci.yml`。删除的脚本：`sync-atomgit-git.mjs`、`sync-atomgit-release.mjs`（经 `release_download.*` 调用）、`sync-gitee-release.mjs`、`publish-r2-release.mjs`、`release_download.sh`、`release_download.bat`。没有被任何 workflow 调用的 `setup-atomgit-runner.*`、`sync-secrets.ps1`、`恢复到指定版本.bat` 暂时保留。仓库里其余指向这些文件或原作者镜像/存储地址的地方（文档、README、`updateService.cjs` 的更新渠道、`package.json` 的 `publish`、`tools/upload_atomgit_release.py`、`assets/star-history/` 等）本 PR 不改，清单见 PR 描述，留给后续 PR（更新渠道在第 9 步随 Web 化一并处理）。

0.8 是路线图外新增的细项：独立运营前，先弄清客户端连接了哪些原作者服务、发出了什么数据。结论和逐项建议见 `docs/EXTERNAL_SERVICES.md`。该文档 §4 列出了后续 PR 的优先级，其中 P0 项（远程公告的 `allowRawHtml`、Agent 失败诊断上传整个工作区、默认使用官方模型、IP 封禁、授权与构建证明、更新渠道）应在任何对外分发之前完成。§3 指出 `AGENTS.md` 的“禁止删除或弱化任何埋点”与独立运营冲突；本文第 4 节 AI 服务行和第 9 步的“埋点等价保留、不删任何统计”同样来自这条约束。等 `AGENTS.md` 修改后，再同步改写这两处。本 PR 不改约束本身。

0.9 是路线图外新增的细项，按 `docs/EXTERNAL_SERVICES.md` §3 改写规则：埋点从“禁止删除或弱化”改为“只能发往本项目自有服务，且不得包含用户文档内容、API Key 和设备硬件标识”；删除原作者 Cloudflare 账户的计费说明和 `release.yml` 发布流程、构建证明相关说明；“本机可信”前提收窄为本机产生的数据，远程下发的内容一律视为不可信；在 `AGENTS.md` 中明确写入当时的许可证归属声明保留要求（迁移到新仓库时已删除）。同一 PR 同步改写了本文第 4 节 AI 服务行、第 5 节部署行和第 9 步。§3 中“新增菜单页面同步 Dashboard 路由中文名”一条依赖是否自建 Dashboard，暂不改动。

0.10 起按 `docs/EXTERNAL_SERVICES.md` §4 逐项处理外部服务，每项一个细项、一个 PR，状态同时记在该文档 §4。0.10 删除了 `agentErrorReporter.cjs`、`agentErrorReportProcess.cjs`（及其 `utilityProcess`）和 `taskService.cjs` 里只为上传采集的任务参数快照；Agent 最终失败改为写本机 `userData/logs/agent/agent-failures.jsonl`，只含任务标识、错误类型、状态码和脱敏后的错误消息。`analytics/worker/` 中的 `/agent-errors` 接收端、R2 存储和 Dashboard 页面是服务端源码，客户端不再调用，本 PR 不动，等决定自建 Worker 的范围时一并处理。

0.11 只处理 `docs/EXTERNAL_SERVICES.md` §4 第三条 P0 中的文本模型和官方账户部分，偏离如下：
- 默认生图模型改成“未配置”拆到后续 PR，保持每个 PR 只做一件事；
- “未配置”没有新增一个 provider 取值，而是默认选中“自定义”且 Base URL、模型名称、API Key 均为空，复用现有的 `useTextModelSetupRedirect` 启动检查跳到设置-文本模型；
- 官方账户服务启动时只恢复用户此前主动邮箱登录的会话，不再匿名注册；邮箱登录和绑定也不再拉取或创建 API Key 写入 `user_config.json`；
- 已在本地选中“内测版”的旧配置不迁移：provider 和已写入的官方 Key 原样保留，设置页对这类配置仍显示该选项，避免下拉框与实际配置不一致。处理方案待决定，见 `docs/EXTERNAL_SERVICES.md` §2.2（已在 0.12 按方案 2 处理）。

0.12 处理 §4 第三条 P0 的剩余部分和第四条 P0，偏离如下：
- 两件事合并为一个 PR：都是“默认不再指向原作者及其合作方的模型服务”，且都只改 `configStore.cjs` 的默认值和读取时的归一化；
- 生图默认值改为空的“自定义”，与 0.11 文本模型一致，没有新增 provider 取值；生图是可选功能，不加启动跳转，未测试可用前不会调用。已保存的旧生图配置不迁移；
- 官方文本配置迁移到“自定义”时沿用用户已有的自定义档案（不清空），没有自定义档案的即为未配置；启动提示常驻并跳到设置-文本模型，即使自定义档案已可用也让用户确认一次。

0.13 处理 `docs/EXTERNAL_SERVICES.md` §4 的插件 P1 项，偏离如下：
- §4 原建议“移除插件市场的自动检查、下载和安装”，实际做法是**整体停用**插件系统，连已安装插件也不再加载：插件代码在 Main 进程中 `require()` 执行、能拿到 `ipcMain` 和 `BrowserWindow`，且没有签名校验，只停市场不停加载，已装插件仍是同样的风险；
- 代码暂时保留，用两个同名开关 `PLUGIN_SYSTEM_ENABLED = false` 控制（Main：`electron/ipc/index.cjs`；Renderer：`src/features/plugins/pluginSystem.ts`），两处需同时修改。Main 侧不注册 `plugins:*` / `plugin-config:*` IPC，`pluginService.initialize` 不再执行，所以也不会创建 `userData/plugins/`；已安装插件的文件和 `plugin-states.json` 原样留在磁盘上，不删除；
- “AI 调整”（技术方案目录与全局事实、可研报告目录）只能经桌宠插件发起，插件停用后随之隐藏，没有在本 PR 改成非插件实现；
- `preload.cjs` 中 `window.appBridge.plugins.*` 暂不删除，调用会因没有对应 handler 而失败；插件相关代码在第 9 步随 Web 化一并删除或重做。

0.14 处理 `docs/EXTERNAL_SERVICES.md` §4 第一条 P0，并提前做了第 3 步中“`config.load` 返回脱敏值”的桌面版部分，偏离如下：
- 两件事合并为一个 PR：远程公告注入 HTML 的危害正是读取 `config.load()` 中的明文 Key，只修渲染不修配置，或者反过来，都只堵住一半；
- 没有只改 `UpdateNotifier.tsx` 一处，而是把 `MarkdownRenderer` 默认值改成 `allowRawHtml=false`，所有调用方显式传值：远程内容和 AI 输出传 `false`；本地解析的文档（招标文件、知识库、废标检查的文档原文）和技术方案正文（会原样保留原方案中的 HTML 表格）传 `true`。另外不论是否开启原始 HTML，`MarkdownRenderer` 都只重建白名单中的标签，丢弃 `style`、事件属性和白名单外的 `class`，链接只允许 `http(s)`/`mailto`/`#`，图片只允许 `http(s)`/`app-asset`/`blob`/位图 `data:`。禁用原始 HTML 时仍识别不带属性的 `<br>`、`<mark>`（AI 表格单元格换行和查错高亮依赖它们）；
- 打码在 IPC 层（`configIpc.cjs`、`aiIpc.cjs` 经 `services/configSecrets.cjs`）完成，`configStore` 和 Main 内部调用仍拿明文。`config:save`、`config:list-models`、`ai:test-image-model` 收到的空凭据按已保存的档案还原；**Base URL 有改动时不还原**（否则改写 Base URL 就能让 Main 把已保存的 Key 发往任意地址），需要重新填写。删除已保存的凭据改用 `credential_clear` 显式请求，设置页提供“清除”按钮；
- MinerU Token 一并打码，虽然不是模型服务商的 Key，但同样是凭据；
- 设置页输入框只保留用户本次新填写的值；官方账户状态变化时只刷新凭据状态，不再把官方 Key 读进界面。

0.15 处理 `docs/EXTERNAL_SERVICES.md` §4 的第五、六、七条 P0，偏离如下：
- 三件事合并为一个 PR（按本次需求一并处理）：都是原作者服务对本地客户端的远程控制（远程退出、远程锁定、远程替换安装包），且都只删除或停用、不新增功能；
- 授权链路**直接删除**，没有像 0.11、0.13 那样用开关保留：它依赖原作者的私钥和构建证明，自建构建永远验证不过，保留没有可复用价值。用户本地的 `license.json` 不删除，只是不再读取；“联系作者购买离线包”文案一并删除；
- 更新功能保留代码结构但去掉三个原作者渠道，更新源从“用户在设置页选择渠道”改为“构建时写入 `electron/resources/update-feed.json`”，默认为空即不发请求。这样 Renderer 无法把更新源改到任意地址；`update_channel` 配置项随之删除；
- 验签没有在本 PR 实现（自有更新服务器和签名格式尚未确定），而是在下载前加了一道总是拒绝的 `verifyReleaseSignature`，即“先关门，接入时再按格式实现”；路线图第 9 步 Web 化时仍按原计划删除更新功能；
- `package.json` 的 `build.publish` 改为 `null`；
- 本 PR 同时把 旧仓库 PR #4、旧仓库 PR #5、旧仓库 PR #11~旧仓库 PR #14 中“需在桌面版实测”的事项汇总到下面的“桌面版待测清单”。

0.16 处理 `docs/EXTERNAL_SERVICES.md` §4 中剩余的原作者内容服务（P1 的启动广告、打赏、远程群二维码，P2 的服务地址集中配置、`client_id` 随机化、`mt.agnet.top` 文档标注），偏离如下：
- 多项合并为一个 PR（按本次需求一并处理）：都是“把写死的原作者地址改成构建时配置、默认为空”，改法相同；
- 地址集中在 `electron/resources/remote-services.json`，沿用 0.15 `update-feed.json` 的做法：Main 运行时读取（`services/remoteServices.cjs`），Renderer 在 Vite 构建时打包同一个文件（`src/shared/remoteServices.ts`），运行时无法修改；只接受 https。四个键：`analyticsUrl`（埋点完整地址）、`contentServiceUrl`（自建 Worker 根地址，承载 `/notice(s)`、`/changelogs`、`/resources`、`/system-settings`、`/model-info`）、`userGuideUrl`、`donationServiceUrl`。内容类接口没有逐个拆键，因为 `analytics/worker/` 本来就在同一个 Worker 上提供它们；
- 埋点代码结构和事件字段保留，`analyticsUrl` 为空时 `sendAnalytics`、`trackAiRequest`、`trackAgentRuntime` 直接返回，连配置都不读取；
- 打赏没有删除，而是在未配置 `donationServiceUrl` 时不弹提示、不恢复待支付订单、不发支付请求（本地仍累计使用时长和导出次数）。§4 原建议“移除”，保留结构是为了以后可能接入自己的赞助渠道；
- 启动广告 `StartupAdvertisementDialog.tsx` 经核对**从首次提交起就没有被任何组件挂载**，Vite 不会打包它，所以 `oss.agnet.top` 广告图实际从未被请求（`EXTERNAL_SERVICES.md` 原先“每次启动强制 8 秒”的描述有误，已更正）。没有改成可配置，而是连同样式直接删除；
- `client_id` 改为 `install-v1-<随机 UUID>`，`machineIdentity.cjs` 改名为 `clientIdentity.cjs` 并删除读取 `MachineGuid` / `IOPlatformUUID` / `machine-id` / 主机名的代码；旧配置中 `machine-v1-` 开头的 ID 连同创建时间在读取时丢弃并重新生成。Client ID 改由 Main 保管，`config:save` 不再用 Renderer 传入的值覆盖；Renderer 中早期 localStorage Client ID 的迁移逻辑删除，只清理旧值；
- 设置页隐私声明第 03 条按是否配置埋点地址显示，不再写死“上报到 Cloudflare”；
- 未处理：设置页金龙“获取 Key”的推广链接 `s.markup.com.cn/jl`、侧边栏内置的原作者用户群二维码（`assets/group-chat-qr.png`）、内测版服务 官方账户与模型代码（已在 0.17 移除），见 `EXTERNAL_SERVICES.md` §6。

0.17 按本项目“不使用原作者官方服务”的决定处理 `docs/EXTERNAL_SERVICES.md` §2.2 和 §4 待决定事项 1，偏离如下：
- 与 0.11、0.13 用开关保留代码的做法不同，本次**直接删除**，不再保留开关：不打算重新开放，保留只会让死代码继续携带原作者地址；
- 旧仓库 PR #12 的迁移（`official_text_provider_migrated` 标记、常驻“内测版服务暂停提供”提示）一并删除。旧配置仍为 `official` 的，`configStore.cjs` 读取时直接切到“自定义”，并丢弃顶层镜像的官方 Base URL 和 Key（否则会被当成未知服务商的配置带进自定义档案）；用户已有的自定义档案沿用，没有则为未配置，按普通“文本模型尚未配置”引导；
- 用户本地数据不删除：`official_api_session.json`、`official_recharge_qr_cache.json` 留在磁盘上不再读取；`user_config.json` 中的 `text_model_profiles.official`（含官方 Key）在写回配置时原样照抄，不解析、不返回给调用方，避免配置归一化把它删掉；
- 工作区数据库的 `official_invoice_info` 表保留：它属于已发布的第 24 版迁移，删除需要新增迁移且会丢弃用户已填的开票信息，程序只是不再读写；
- `ai:balance-insufficient` 事件、`SettingsPageRequest.openRecharge` 等只为官方余额不足服务的代码一并删除，`useTextModelSetupRedirect` 只保留启动时的未配置检查；
- `analytics/worker/` 中与官方相关的服务端代码不属于客户端，本 PR 不动。

0.18 按本次决定收尾第 0 步：
- 金龙推广链接：`SettingsPage.tsx` 的文本和生图“获取 Key”地址表中删除金龙一项。生图的“获取”按钮原先没有置灰逻辑，一并补上，地址表改为 `Partial`，未预置地址的服务商不再弹“自定义……没有预置”的提示；
- 金龙中转站预置服务商：**整体移除**（文本和生图都删除）。删除的内容包括服务商选项、预置 Base URL（`jlaudeapi.com/v1`、`img-api.jlaudeapi.com/v1`）、默认模型（文本 `gpt-3.5-turbo`、生图 `gpt-image-2`）、“模型名称为空时回退到金龙默认生图模型”的特殊处理、`aiService.cjs` 中的生图服务商元数据、设置页的说明文案和类型定义。正文配图的 Agent 提示词里“当前金龙 gpt-image-2-1k 的 tall 使用 768x1024”改为“gpt-image-2-1k 模型的 tall 使用 768x1024”，只去掉服务商名，尺寸要求不变（同步修改 `开发说明.md`）；
- 金龙旧配置迁移（`configStore.cjs` 的 `migrateLegacyJinlongProvider`，每次读取配置时在归一化之前执行，结果写回磁盘）：
  - 文本模型选中 `jinlong` 的，改为“自定义”。自定义档案取金龙档案的值，再用顶层镜像字段覆盖，Base URL、Key、模型名称、并发、思考强度、请求方式等全部沿用；
  - 生图模型选中 `jinlong` 的，`image_model.provider` 改为 `custom`，其余字段（含测试状态）原样保留；
  - 预置服务商的 Base URL 原先不可编辑，固定为金龙地址，并且每次读取都会写回配置文件，所以迁移直接用用户配置文件里已保存的地址，代码中不再保留任何金龙地址。只有配置文件中确实没有 Base URL 时，才按“未配置”引导用户填写；
  - Key 不会丢失：迁移在 `configStore.load()` 中完成，`configSecrets` 还原 Key 时拿到的“已保存档案”就是迁移后的自定义档案。设置页回传的自定义 Base URL 与已保存的一致，留空的 Key 按原规则还原；用户改了 Base URL 时仍按原规则不沿用 Key。没有改动 `configSecrets.cjs`；
  - 迁移会覆盖原有的自定义档案。覆盖前自定义档案如果已有内容（Base URL、Key 或模型名称任一非空），存到 `custom_before_jinlong_migration` 键下，留在配置文件中；
  - 没有选中金龙、只是保存过金龙档案（含 Key）的，不迁移；金龙档案连同上面的存档都按 0.17 处理官方档案的方式原样留在 `user_config.json` 中（`retainLegacyOfficialProfile` 扩展为 `retainLegacyProfiles`），程序不读取，也不返回给 Renderer；
  - 用临时 userData 验证过 4 种场景：选中金龙且自定义档案为空、选中金龙且自定义档案已有内容、未选中金龙、旧官方配置；另外验证了第二次读取不改写文件，以及经 `maskConfigForRenderer` / `resolveIncomingConfigSecrets` 回传保存后 Key 仍在。
- 加群：删除侧边栏“加群”按钮和弹窗、`client/assets/group-chat-qr.png`、对应样式和图标。远程替换二维码（`/system-settings`）原本只为这个弹窗服务，客户端查询代码一并删除；`remote-services.json` 的 `contentServiceUrl` 不再承载 `/system-settings`。底部快捷入口全部未配置时不再渲染空的快捷入口容器，侧栏底部只剩“设置”。`analytics/` 中的 `/system-settings` 服务端代码按下一条保留不动；
- `文章/`：原作者的技术文章（含 `oss.agnet.top` 图床插图）整体删除，仓库内没有其他文件引用它。删除不影响归属声明：`LICENSE`、`NOTICE`、README 中的原作者信息和原仓库链接保持不变；
- 0.4 `patch-package`：接受风险，视为完成。理由：`patch-package` 只在开发机和 CI 的 `npm install` / `npm ci` 时由 `postinstall` 运行，它带进来的 `braces` / `micromatch` 只处理仓库内固定的补丁文件路径，不接收用户输入；它是 `devDependencies`，不在 electron-builder 的 `files` 中，不进入安装包，也不会进入 Web 版服务端镜像。`npm audit` 的这两条 high 继续由 CI 的 `--audit-level=critical` 放行；
- 0.5 AGPL 第 13 条源码链接：上线前决定，视为第 0 步完成。开发期间本仓库保持公开，对外提供网络服务前（第 9 步）确定 Web 版界面中源码链接的位置和指向，并加入第 9 步的上线检查。迁移到新仓库后本项目改为闭源商业授权，不再提供源码链接，第 9 步的对应上线检查已删除；
- analytics Worker：**不自建**。客户端的埋点（`analytics.ts`、`trackAiRequest`、`trackAgentRuntime`）和内容服务代码（公告、更新日志、资源页、模型信息，及 `remote-services.json` 中对应的键）目前默认为空、不发请求，在第 9 步删除；`analytics/` 目录暂时保留，删除时机另行决定。本文第 5 节部署行和第 9 步已同步改写。

0.19 按本次需求一次清理，偏离如下：
- 多项合并为一个 PR（按本次需求一并处理）：都是删除原作者的非归属类内容，不新增功能。原计划在第 9 步删除的客户端埋点和内容服务代码提前到本 PR 删除；`analytics/` 目录的去留（0.18 待定）定为删除；
- 删除的客户端代码：Renderer `shared/analytics/analytics.ts` 及全部 `trackXxx` 调用、`shared/remoteNotice.ts` 和启动公告弹窗（`UpdateNotifier` 只保留更新检查和插件更新提示）、`features/notice`、`features/changelog`、`features/resources`（`resources` 路由和“精选资源”菜单，“资源下载”分组只在插件系统开启时显示）、设置页“自动填充高级参数”和只由它填充的思考强度下拉框（改为只能手动录入）、对应样式；Main `aiService.cjs` 的 `trackAiRequest` 和 `getModelInfo`（`config:get-model-info` IPC、preload 和类型一并删除）、`agent/agentRuntimeAnalytics.cjs`、`utils/clientIdentity.cjs` 和配置中的 `analytics_client_id` / `analytics_created_at`。`remote-services.json` 只保留 `userGuideUrl`、`donationServiceUrl`（使用文档和打赏不依赖 `analytics/`，不在本次范围）。隐私声明第 03 条改为“不上报使用统计”；
- `aiService.cjs` 中原 `analyticsTracked` 标记同时控制文本 Token 统计只记一次，改名为 `tokenStatsRecorded` 保留，生图路径的标记随埋点删除；
- 插件系统的 `pluginService.cjs` 仍写着原作者插件市场 `analytics.agnet.top/plugins`，插件系统已停用（0.13），按原计划第 9 步随插件代码处理，本 PR 不动；
- `configStore.cjs` 删除 0.17 的 `dropLegacyOfficialTextProvider`、0.18 的 `migrateLegacyJinlongProvider`、`retainLegacyProfiles` 及 `custom_before_jinlong_migration` 存档逻辑（本版本无存量用户）。旧配置中的 `official` / `jinlong` 现在按通用的“未知服务商”规则切到“自定义”，写回配置时不再照抄已移除服务商的档案；用临时 userData 验证过全新配置、`official` 旧配置和保存回读；
- 使用说明：删除 `更新日志/`、“精选资源”“公告与版本更新”“插件管理”三页及其截图（对应功能已删除或停用，插件页还描述原作者的插件市场和桌宠插件），删除“配置文本模型”中的官方 API 一节和常见问题中的官方账户、自动填充说明；
- `screenshots/` 删除 7 张赞助商图片和原作者的企业微信二维码；原作者品牌横幅、演示截图和 `assets/star-history/` 不再被 README 引用，但不属于赞助商，本 PR 不删，见 PR 描述中的剩余引用清单；
- `check:docx` 引用的 `scripts/check-docx-table-pagination.cjs` 和 `check:chrome` 引用的 `scripts/check-chrome-layout.mjs` 在仓库历史中从未存在，无从修复，三条脚本一并删除，`开发说明.md` 改为说明需手动验证；
- 第 1 步前待决定事项第 7 项随本 PR 解决：`AGENTS.md` 和 `开发说明.md` 中“新增菜单页面同步 Dashboard 路由中文名”及 Analytics 一节已删除。

0.20 按本次需求继续清理，偏离如下：
- 多项合并为一个 PR（按本次需求一并处理），都是删除原作者的非归属类内容，不新增功能；
- 删除的文件：`.github/FUNDING.yml`（爱发电链接）、`.github/scripts/`（`setup-atomgit-runner.bat/.sh`、`sync-secrets.ps1`、`恢复到指定版本.bat`）、`tools/upload_atomgit_release.py`（`tools/` 只有这一个文件）、原用户手册技能目录 `.agents/skills/`（`.agents/` 只有这一个技能）、`assets/star-history/`、`screenshots/` 全部 12 张图片（README 已不引用任何一张）；`.gitignore` 中只为这些工具服务的条目（技能 `.env.local`、使用说明同步状态、`tools/测试文件`、`tools/对比结果`、企业微信群聊导出工具）一并删除，`.env.secrets` 等密钥忽略规则保留；
- 打赏：删除 `donationService.cjs`、`donationIpc.cjs`、`DonationPromptProvider.tsx`、`shared-donation.css`、`paths.cjs` 的 `getDonationStateFilePath`、preload 的 `donation.*`、`ipc.ts` 的 `Donation*` 类型和 `PreloadBridge.donation`、导出 Word 时的计数与提示，以及 `remote-services.json` 的 `donationServiceUrl`。Main 侧 `services/remoteServices.cjs` 原本只被打赏使用，随之删除，`remote-services.json` 现在只由 Renderer 在构建时读取（`userGuideUrl`）。用户本地已有的 `donation_state.json` 不删除、不读取；
- “给作者点 star”提示（`githubStarNotice`）改名为 `developingNotice`，文案改为“功能开发中，敬请期待。”，不再附原仓库链接；问题反馈和功能建议模板中的 star 引导一并删除；
- 联系邮箱改为占位符 `{{CONTACT_EMAIL}}`，需要在对外公开前替换为本项目的联系方式；`SECURITY.md` 第一句中的旧产品名当时未改（品牌名，见第 1 步前待决定事项第 3 项；括号中的原项目名已在迁移到新仓库时删除；产品名已在 #1 改为“智标”）；
- 全局搜索时发现两处“其他”类引用，一并处理：`pluginService.cjs` 的插件市场地址 `analytics.agnet.top/plugins`（0.19 计划留到第 9 步）改为空字符串，为空时不请求插件列表、不上报下载，插件代码本身仍在第 9 步处理；`updateService.cjs` 注释中“原作者的 GitHub、AtomGit、Cloudflare 渠道已停用”一句删除。

### 第 1 步开始前需要决定的事项

以下 7 项已在 旧仓库 PR #21 决定（只改文档）。

1. **桌面版是否继续维护和发布**：**只做 Web 版，改造期间不发布桌面版。**但在 Web 版能完整运行之前，Electron 是唯一能验证功能的环境，所以每一步仍须保证 Electron 可以运行（`npm run dev` 能启动、已有功能可用）。下面的桌面版待测清单保留，继续用来验证。
2. **待测清单是否作为第 1 步的前提**：**是。**先测完待测清单第 3、7、9、10、12、17 项。测完之前只做不改变运行行为的准备工作（文档、测试框架、CI，以及新建但还没有被调用的代码）；替换 `window.appBridge` 调用、删除接口等会改变运行路径的改动，等这几项测完、结果回填后再合并。
3. **产品名称与旧 bridge 全局名命名**：**推迟到项目完成时处理。**旧 bridge 全局名、旧产品名等已有命名暂不修改；第 1 步新建的 bridge 使用中性命名（例如 `src/shared/bridge` 导出 `getBridge()`、类型 `AppBridge`，Web 实现为 `WebBridge`），不再新增带旧产品名的名字。（已在品牌改名第二部分全部替换：bridge 全局名改为 `window.appBridge`，旧产品名由 CI 禁用词检查拦截，见 `CLAUDE.md`“命名规则”。）
4. **第 1 步的 PR 粒度**：**先建 `src/shared/bridge`，再按第 2 节的模块 A~K 分批替换调用。**不一次性机械替换。
5. **已停用功能是否带进 bridge 接口**：**不带进。**插件、更新、授权遗留的接口和类型（`ipc.ts` 中的类型、`preload` 方法及对应 Main 侧代码）在第 1 步之前另开 PR 删除，bridge 只定义仍在使用的接口。依赖桌宠插件的“AI 调整”（技术方案目录与全局事实、可研报告目录）随插件一起删除，记为**待重做**（以后改成不依赖插件的实现，列入第 9 步之前的功能补齐）。
6. **是否引入单元测试框架**：**第 1 步引入 Vitest，并加入 CI**（`ci.yml` 新增测试步骤，失败即 CI 失败）。首批测试覆盖 bridge 的选择逻辑；Web 实现落地后补序列化（第 4 节提到的 `undefined` 字段丢失）的测试。
7. ~~**`AGENTS.md` 中依赖 Dashboard 的规则**~~：**已在 旧仓库 PR #19 解决**（0.19 删除了“新增菜单页面同步 Dashboard 路由中文名”及 Analytics 一节）。

#### 接下来的 PR 计划

按顺序执行。标“准备”的不改变运行行为，可以在待测项测完之前合并；其余等第 2 项所列待测项测完再合并。

| 顺序 | PR 内容 | 类型 |
|---|---|---|
| 1 | 旧仓库 PR #21 记录第 1 步前的决定：本节、`CLAUDE.md` 命名规则、第 9 步上线检查补充 | 准备（只改文档） |
| 2 | ~~引入 Vitest：`client/` 加 `vitest` 开发依赖和 `npm test` 脚本，写一个示例测试；`ci.yml` 加测试步骤~~ **已完成（旧仓库 PR #22）**，做法见下方说明 | 准备 |
| 3 | ~~新建 `src/shared/bridge`（中性命名）：默认实现返回 `window.appBridge`，类型继续以 `ipc.ts` 为准；暂不替换任何调用；给选择逻辑写 Vitest 测试~~ **已完成（旧仓库 PR #24）**，做法见下方说明 | 准备 |
| — | 在 Windows 上实测待测清单第 3、7、9、10、12、17 项并回填结果（需要人工，结果可随下一个 PR 或单独的文档 PR 回填） | 前提 |
| 4 | 删除插件、更新、授权遗留的接口和类型（`ipc.ts`、`preload.cjs`、对应 IPC 和服务），“AI 调整”入口随之删除并记为待重做；待测清单追加对应验证项 | 改变运行路径 |
| 5~ | 按第 2 节模块 A~K 分批把 `window.appBridge` 调用替换为 `getBridge()`，每批一个 PR（可把调用很少的模块合并为一批）；每批合并前确认 Electron 可运行 | 改变运行路径 |
| 最后 | 全部替换完成后，`AGENTS.md` 中“Renderer 只通过 `window.appBridge`”改为“只通过 `src/shared/bridge`”，第 1 步标为已完成 | 只改文档 |

第 2 项（旧仓库 PR #22）的实际做法，与计划的偏离如下：
- 依赖固定版本：`vitest` 4.1.11（2026-08-18 发布，兼容现有 Vite 7）、`jsdom` 29.1.1（Renderer 组件测试需要 DOM）。没有选 Vitest 5：发布不久，且要求 Node ≥22.12；jsdom 30 要求 Node ≥22.22.2，高于当前开发环境。React 组件用 `react-dom/server` 渲染，没有引入 Testing Library；
- 测试放 `client/tests/`（`tests/src/`、`tests/electron/`），不进入 Vite 构建产物，也不随 `electron/**` 打包；`.cjs` 用 `createRequire` 加载，保持 CommonJS 语义。`vitest.config.ts` 独立于 `vite.config.ts`；`tsconfig.json` 的 `include` 加上 `tests` 和 `vitest.config.ts`，测试代码也经过 `tsc --noEmit`；
- 没有写示例测试，首批测试改为覆盖第 0 步改过、但没在真实环境验证过的纯逻辑：`configSecrets.cjs` 的打码与还原（含“改 Base URL 不还原 Key”、`credential_clear`、生图模型列表）、`configStore.cjs` 的旧配置兼容与保存合并、`MarkdownRenderer` 的 HTML 白名单清洗。这些测试不能替代待测清单第 7、8 项的桌面版实测。bridge 选择逻辑的测试随第 3 项一起写；
- 没有修改业务代码。测试发现一个既有问题，先用 `it.fails` 记录，已在 旧仓库 PR #23 修复（补上该字段，测试改为普通 `it`）：`configStore.cjs` 的 `textProfileFromUnknownProvider` 没有带上 `output_token_limit`，经“未知服务商 / 没有服务商 → 自定义”路径读取的旧配置首次 `load()` 返回的配置缺这个字段（原档案里的值丢失），下一次 `load()` 才补默认值 0 并再次写盘；
- CI 在 `npm run build` 之后运行 `npm run test`，失败即 CI 失败。job 名称不变，避免影响已有的分支保护设置。

第 3 项（旧仓库 PR #24）的实际做法，与计划的偏离如下：
- 新建 `client/src/shared/bridge/`：`types.ts`（`AppBridge`）、`electronBridge.ts`（`createElectronBridge`）、`webBridge.ts`（`createWebBridge`、`BridgeNotImplementedError`）、`index.ts`（`getBridge()`、`detectBridgeKind()`）。没有任何现有文件引用它，构建产物中不包含这些代码，运行行为零变化；
- `AppBridge` = `Omit<PreloadBridge, DisabledBridgeKey>`：类型仍以 `ipc.ts` 为准，但按决定第 5 项去掉已停用的更新、插件接口（`getLatestVersion`、`getUpdateDownloadUrl`、`checkUpdate`、`startUpdate`、`quitAndInstall`、`onUpdateProgress`、`onUpdateDownloaded`、`onUpdateError`、`onPluginUpdatesAvailable`、`plugins`）。授权接口已在 旧仓库 PR #15 删除，无需排除。这些接口本身仍留在 `ipc.ts` 和 `preload.cjs`，由第 4 项删除。注意 `WorkspaceDatabaseGate.tsx`（数据库版本过新时“下载新版客户端”）仍调用 `getUpdateDownloadUrl`，第 4 项删除更新接口时要一并改掉这里，否则该模块无法替换为 `getBridge()`；
- Electron 实现不复制、不包装：`createElectronBridge` 原样返回 `window.appBridge`，只在类型上收窄。`getBridge()` 每次重新读取 `window.appBridge`（非 null 对象即选 Electron 实现），返回值与 `window.appBridge` 始终是同一个对象，后续替换调用时行为不变；
- 计划外提前新建了 `WebBridge` 空壳：所有方法都在，用 `satisfies AppBridge` 保证与接口一一对应；返回 Promise 的方法以 `BridgeNotImplementedError` 拒绝，事件订阅和 `getPathForFile` 同步抛出，错误信息带方法路径（如 `WebBridge 尚未实现：config.load`）。`platform` 为 `'web'`，`appName` 按命名规则暂留空字符串，第 9 步统一确定；
- 序列化测试提前写（计划是 Web 实现落地后补）：Web 实现尚不存在，所以写成特征测试，固定 Electron IPC（结构化克隆）与 JSON 的差异，作为 `WebBridge` 编解码设计的约束：值为 `undefined` 的字段键丢失（以 `rejectionCheckStore.cjs` 的 `hasOwn` 补丁为例，`{ tenderDocument: undefined }` 经 JSON 后从“清空”变成“不改”）、数组中 `undefined` 变 `null`、顶层 `undefined` 参数无法序列化、`Uint8Array` 变成按下标的普通对象、`Date` 变成字符串。测试在 `client/tests/src/bridge/`。

### 第 2 步说明

旧仓库 PR #25 新增 `docs/SERVER_DESIGN.md`（只写文档，不改代码），给出第 2~9 步服务端的目标设计：技术栈、多用户数据模型、注册登录与会话、API Key 加密存储、任务队列与进度推送、文件上传下载、Agent 沙箱和部署架构。该文档第 9 节列出 18 项待决定事项，决定结果记录在本节。与第 5 节原建议的偏离（均待第 9 节确认）：
- 实时推送建议用 **SSE** 而不是 WebSocket：现有 19 个 `onXxx` 都是单向推送，命令本来就走 `invoke`，SSE 走普通 HTTP，鉴权、断线重连和代理兼容都更简单；
- 运行时建议 **Node 24 LTS** 而不是 Node 22：Node 22 在 2027-04 结束维护；
- 数据访问在 Kysely / Drizzle 之间定为 **Kysely**，与现有手写 SQL 的 Store 一一对应；
- Agent 沙箱在 gVisor / Firecracker 之间建议 **gVisor 起步**，经 `SandboxDriver` 接口抽象，以后可换；整个 Pi 运行时进沙箱，沙箱只能访问 AI 网关，不持有任何 API Key；
- API Key 加密由“KMS 或 libsodium”改为 **Node 内置 `crypto` 的 AES-256-GCM 信封加密**，主密钥起步用 Docker secret，可切换到云 KMS；
- 新增设计约束：数据库加行级安全（RLS）作为第二层隔离；用户填写的 Base URL 要防 SSRF；文档解析（含 LibreOffice）和 Chromium 渲染与 Agent 共用沙箱。

#### 设计文档决定事项（旧仓库 PR #26）

`docs/SERVER_DESIGN.md` 第 9 节的 18 项已在 旧仓库 PR #26 决定（只改文档），上方几条“待第 9 节确认”的偏离随之确认：

- **采用建议**：第 1 项（组织 + 个人组织）、第 2 项（知识库、资信库、模板组织内共享）、第 3 项（数据模型支持多项目，界面第一版仍每种业务一个项目）、第 5 项（仅邀请注册）、第 9 项（BullMQ + Redis）、第 10 项（SSE）、第 11 项（Node 24 LTS）、第 12 项（gVisor 起步）、第 15 项（文档 100 MB、图片 10 MB、每组织 20 GB、每日 Agent 8 小时）、第 16 项（不接 ClamAV）、第 17 项（恢复期 7 天、注销后 30 天内删除）、第 18 项（不做桌面数据导入）；
- **第 13 项 部署位置**：服务器部署在**境外，优先香港**，面向中国大陆用户；不办理 ICP 备案，上线前实测大陆访问质量（`SERVER_DESIGN.md` 第 8.0 节）；
- **第 8、14 项**：KMS 和对象存储选**同一云厂商**（香港地域），云厂商待选，列入 `docs/EXTERNAL_SERVICES.md` §7。KEK 由此从“Docker secret 起步”改为生产环境直接用云 KMS，开发环境用密钥文件；
- **第 4 项 登录方式**：支持邮箱 + 密码和手机号 + 短信验证码两种；**第一版只实现邮箱 + 密码**，`users` 表预留 `phone`、`phone_verified_at`（第 3.1 节）；
- **第 6 项 发信服务**：待选，在 `docs/EXTERNAL_SERVICES.md` §7 列为待定外部服务，选型和上线前要验证对 QQ / 163 邮箱的送达率；
- **第 7 项 API Key 归属**：**平台统一提供 AI 并按量计费**，偏离原建议（组织级 Key）。用户不再填写 Key 和 Base URL，凭据改为平台级、由平台管理员维护（`SERVER_DESIGN.md` 第 4 节）；新增第 10 节“AI 用量计量与计费”：AI 网关是唯一计量点，按组织、按模型、按任务记账，余额不足时拒绝新任务，运行中耗尽则暂停保留 checkpoint，价格表带版本，管理员手动充值（TOTP + 大额双人复核，流水只追加）。**在线支付、发票、短信登录列为第二版**，依赖境内主体；
- **新增第 11 节“合规待确认事项”**：个人信息出境、生成式 AI 监管、模型服务商对中国大陆用户的条款限制，以及收款主体，标为**上线前必须完成**，已加入第 9 步上线检查。

对后续步骤的影响：

- 第 3 步“配置与 AI 网关”增加平台模型清单、用量计量、余额检查和价格表，下方第 6 节第 3 步已同步改写；设置页对普通用户隐藏服务商、Base URL、API Key 和测试连接；
- 第 5 节“密钥”一行原写“用户自带的 API Key”，按第 7 项改为平台凭据，已同步改写；
- 第 6 步入队时检查余额（`SERVER_DESIGN.md` 第 10.3 节）。

#### 服务端基础设施（旧仓库 PR #27）

第 2 步的第一个代码 PR，只搭基础设施，不含数据库、Redis、鉴权和任何业务接口。`client/` 未改动。

- 新建 `server/`：Node 24.21.0 + TypeScript 5.9.3 + Fastify 5.12.5，独立的 `package.json` / `package-lock.json`。直接依赖只有 `fastify`、`@fastify/helmet`，开发依赖 `typescript`、`vitest`（与 `client/` 同为 4.1.11）、`@types/node`。版本全部写死（`.npmrc` 的 `save-exact=true`），整棵依赖树用 `npm install --before=2026-10-04` 解析，即每个包都选发布超过两周的版本；`engine-strict=true`，Node 版本不对时安装失败；
- 源码用 Node 24 原生的 TypeScript 类型擦除直接运行（`npm run dev` 即 `node --watch src/server.ts`），相对导入写 `.ts` 扩展名，`tsconfig` 开启 `erasableSyntaxOnly`（禁止 `enum`、参数属性等需要转译的语法）；`npm run build` 用 `rewriteRelativeImportExtensions` 编译到 `dist/`，镜像中运行编译产物；
- **配置**（`src/config.ts`）：只读环境变量，启动时一次校验全部变量，有问题时一次性列出，stderr 输出一行结构化 JSON 并以退出码 1 退出；错误信息只含变量名和期望格式，**不回显变量值**（后续数据库密码等会走同一机制）。目前只有 `NODE_ENV`（必需，`development` / `test` / `production`，不设默认值，防止生产环境误用开发默认值）、`HOST`（默认 `127.0.0.1`，镜像中为 `0.0.0.0`）、`PORT`（默认 3000）、`LOG_LEVEL`（默认 `info`）。设计文档第 1 节入参校验用 TypeBox，环境变量只有 4 个，暂时手写解析，不引入依赖；
- **日志**（`src/logger.ts`）：pino（Fastify 内置），按字段名脱敏 `password`、`apiKey` / `api_key`、`token`、`secret`、`authorization`、`cookie`、`set-cookie` 等，覆盖顶层和两层嵌套，替换为 `[REDACTED]`；请求日志只记录方法和路径，**不记录查询串和请求头**；
- **请求 ID**：服务端生成 UUID，不采用客户端传入的值，通过 `x-request-id` 响应头和错误响应体返回，便于用户反馈问题时对照日志；
- **`/healthz`**：只返回 `{"status":"ok"}`，不返回版本、运行时长等信息，`Cache-Control: no-store`，正常请求不写 info 日志。`/readyz` 随 PostgreSQL、Redis 一起加入；
- **统一错误处理**（`src/errors.ts`）：响应体固定为 `{ error: { code, message, requestId } }`。只有 `AppError` 的文案会返回给客户端；其他 4xx（JSON 解析失败、请求体过大、校验失败等）按状态码返回通用中文文案，不带 Fastify 错误码、解析器细节和 schema 字段名；5xx 一律返回“服务器内部错误”，消息和堆栈只写日志。测试中发现业务代码 `throw` 非 `Error` 值时错误处理器自身会出错、退回 Fastify 默认处理器并原样回显消息，已修复并加测试；
- **安全响应头**：`@fastify/helmet`，CSP 按设计文档第 6.4 节，HSTS、`nosniff`、`Referrer-Policy`、`Permissions-Policy` 按第 8.2 节，另加 `X-Frame-Options: DENY`。Caddy 接入后仍保留应用层这一份，作为纵深防御；`trustProxy` 暂时关闭，接入反向代理时按实际拓扑开启；
- **Docker**：`server/Dockerfile` 多阶段构建，基础镜像 `node:24.21.0-bookworm-slim` 按 digest 固定；运行阶段只含生产依赖和 `dist/`，文件归 root 所有，进程以镜像自带的非 root 用户 `node`（UID 1000）运行，带 `HEALTHCHECK`。根目录 `docker-compose.yml` 仅供开发，目前只有 `api` 服务：端口只绑 `127.0.0.1`，只读根文件系统、`cap_drop: ALL`、`no-new-privileges`、`init: true`。PostgreSQL 和 Redis 留给下一个 PR；
- **CI**：`ci.yml` 新增 `server-checks` 任务，Node 24.21.0，依次 `npm ci`、`npm run typecheck`、`npm run build`、`npm run test`、`npm audit --audit-level=high`。与 `client-checks` 只拦 critical 不同，server 是新依赖树、目前 0 漏洞，所以从 high 起拦；`client-checks` 仍用 Node 22，不在本 PR 改动。

#### 数据库层（旧仓库 PR #28）

第 2 步的第二个代码 PR：PostgreSQL、迁移、第一批表和双层隔离中的数据库层。`client/` 未改动。

- **依赖**：`kysely` 0.29.6、`pg` 8.23.1（开发依赖 `@types/pg` 8.23.1），按 `npm install --before=2026-10-04` 解析（发布超过两周），`npm audit` 0 漏洞；
- **迁移**：用 Kysely 自带的 `Migrator`（设计文档第 1 节在它与 `node-pg-migrate` 间二选一，选它以免多一个依赖），迁移是 `src/db/migrations/` 下手写 SQL 的 TS 文件，经 `migrations/index.ts` 静态登记（不扫描目录，类型擦除直接运行和编译产物都能用）。每个迁移在独立事务中执行、由咨询锁串行化；重复执行是空操作；每个迁移都有 `down`。命令：`npm run db:migrate`（到最新）、`npm run db:rollback`（回滚一个），输出一行一条 JSON；
- **角色**：`bidtools_owner`（表属主，只用于迁移）和 `bidtools_app`（应用连接），都是 `NOSUPERUSER NOBYPASSRLS`，应用角色不拥有任何表、不能在 `public` 建表。角色和库属于集群级配置，不在迁移中创建：开发环境由 `server/db/init/10-provision.sh` 在 PostgreSQL 首次初始化时创建，生产环境由管理员按同样的属性创建（上线前写进部署文档，第 9 步）；
- **配置**：新增 `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_NAME` / `DATABASE_USER`（默认 `127.0.0.1` / `5432` / `bidtools` / `bidtools_app`）和必需的 `DATABASE_PASSWORD`（或 `DATABASE_PASSWORD_FILE`，对应 Docker secrets，二者只能设一个）；迁移命令另读 `MIGRATION_DATABASE_USER`（默认 `bidtools_owner`）和 `MIGRATION_DATABASE_PASSWORD[_FILE]`，api 进程拿不到属主密码。错误信息仍不回显值，也不回显密钥文件路径；
- **第一批表**（`0001_identity`）：`organizations`、`users`（预留 `phone`（E.164，可空，非空唯一）和 `phone_verified_at`）、`org_memberships`（沿用设计文档表名，即需求中的 memberships）、`sessions`、`auth_tokens`（类型含预留的 `sms_login`）。令牌只存 32 字节 SHA-256。组织下的表带 `org_id`：`org_memberships`、`sessions`（`(org_id, user_id)` 复合外键指向成员关系，移出组织时会话随之删除）；`users` 和 `auth_tokens` 是身份表，用户可属于多个组织，按设计文档第 2.2 节不带 `org_id`，按用户隔离；
- **RLS**：五张表都 `ENABLE` + `FORCE ROW LEVEL SECURITY`（属主也受约束）。上下文是事务级设置 `app.org_id` / `app.user_id`，经 `app_current_org_id()` / `app_current_user_id()` 读取，空值统一为 NULL，未设置时所有策略都不成立。策略：`organizations`、`org_memberships` 按当前组织；`users` 只能看到当前组织的成员、只能改自己、INSERT 按 `app.user_id`（注册时成员关系尚不存在）、不授予 DELETE；`sessions` 按当前组织 + 当前用户；`auth_tokens` 按当前用户；
- **`TenantContext`**（`src/db/tenant.ts`）：`withTenant(db, { orgId, userId, role }, fn)` 开事务、用 `set_config(..., true)` 设置上下文后执行 `fn`，提交或回滚后设置自动清除，连接回到池中不会带上一个请求的组织。`orgId` / `userId` 不是 UUID、`role` 不合法时直接拒绝；
- **`/readyz`**：执行 `SELECT 1`（2 秒超时，含建连），成功返回 `{"status":"ok"}`，失败返回 503 `{"status":"unavailable"}`，原因只写 warn 日志；`/healthz` 不变、不检查数据库。数据库暂时不可用时进程照常启动；
- **docker-compose.yml**：新增 `postgres`（`postgres:17.11-bookworm` 按 digest 固定，数据卷 `pgdata` 持久化，端口只绑 `127.0.0.1`）和一次性的 `migrate` 服务（迁移成功后 `api` 才启动）。三个密码（超级用户、属主、应用）经 Docker secrets 传入，由 `server/scripts/init-dev-secrets.sh` 随机生成到 `server/.dev-secrets/`（已 gitignore），`api` 只挂载应用角色的密码；
- **测试与 CI**：`npm run test` 仍只跑单元测试；新增 `npm run test:db`（`vitest.db.config.ts`，需要 `TEST_DATABASE_ADMIN_URL`），每个测试文件新建独立的库、结束时删除，覆盖：迁移升级、重复执行、逐个回滚到空库再升级、迁移中途失败整体回滚、迁移命令；每张业务表都强制 RLS 且有策略（防止以后漏开）；应用角色属性、不能关闭 RLS 或建表；未设置上下文时五张表都返回 0 行（含属主角色、含连接复用后）；组织 A 读不到、改不到、写不进组织 B；`/readyz` 连真实数据库。CI 的 `server-checks` 加 PostgreSQL 服务容器（与 compose 同一 digest）运行这些测试。把策略改成 `USING (true)` 后有 7 个用例失败，测试能发现策略被放宽；
- **留给鉴权 PR**：登录（按邮箱查用户）、按令牌哈希查会话、找回密码查令牌都发生在拿到用户和组织之前，在本 PR 的策略下查不到任何行。鉴权 PR 中为这几个查询提供专门的受控入口（例如只返回单行的 `SECURITY DEFINER` 函数，属主为专用角色），届时同步更新设计文档第 2.6 节。“我加入的组织列表”（切换组织）同样留到那时。

统计口径更正：第 3 节“55 张表”是 `sqliteDatabase.cjs` 中 `CREATE TABLE` 的条数，去掉迁移中重复创建的 `technical_plan_global_fact_groups`，实际为 54 张表，与 `sql/workspace_schema.sql` 一致。

#### 鉴权（旧仓库 PR #29）

第 2 步的第三个代码 PR，实现设计文档第 3 节的注册、登录与会话。`client/` 未改动，没有新增 npm 依赖。

- **登录前查询的受控入口**（迁移 `0002_auth`，补上 旧仓库 PR #28 留下的缺口）：按邮箱查用户（`auth_login_lookup`）、按令牌哈希查会话（`auth_session_lookup`）、签发和使用找回密码令牌（`auth_issue_password_reset` / `auth_reset_password`）、兑换邀请（`auth_consume_invitation`），以及修改密码时吊销本人全部会话（`auth_revoke_my_sessions`，只作用于 `app.user_id`）。六个函数都是 `SECURITY DEFINER`、`SET search_path = pg_catalog, pg_temp`、表名全限定；按完整邮箱或令牌哈希精确匹配，最多一行，只返回调用方需要的字段；收回 `PUBLIC` 的 `EXECUTE`，只授权给 `bidtools_app`。找回密码令牌的 30 分钟有效期写死在函数里，调用方不能签发长期令牌；`auth_reset_password` 只接受 argon2id 哈希，防止误写明文；
- **函数属主是新角色 `bidtools_auth`**：`NOLOGIN NOSUPERUSER NOBYPASSRLS`，不能登录，也不靠 BYPASSRLS 读数据，而是在五张表上为它单独建 `TO bidtools_auth` 的策略，并且只授予函数用到的列（例如 `users` 只有 `id`、`email`、`password_hash`、`status`、`email_verified_at`）。迁移角色是它的成员（`INHERIT FALSE, SET TRUE`），只用于在迁移中 `SET ROLE` 建删函数，不继承它的策略，直接查表仍是 0 行。偏离设计的地方：旧仓库 PR #28 设想“属主为专用角色”时没有写明需要新的集群级角色，本 PR 补进了 `server/db/init/10-provision.sh` 和测试 harness。**已有的开发数据卷不会重跑初始化脚本**，要么 `docker compose down -v` 重建，要么按脚本手工建角色；生产环境同样由管理员创建（加入第 9 步上线检查）；
- **收紧 `users` 的写权限**：应用角色改为列级授权，INSERT 只能写 `id`、`email`、`password_hash`、`email_verified_at`，UPDATE 只能改 `password_hash`、`updated_at`。应用进程因此不能把任何人设为平台管理员，也不能改状态或邮箱；
- **新表 `invitations`**：平台级邀请（受邀邮箱、令牌哈希、发起人、7 天过期、兑换时间和兑换人），RLS 只允许平台管理员以自己的名义插入、只能看到自己发出的邀请，应用角色不能改删。偏离设计：设计文档第 2.5 节的 `org_invitations`（组织 owner 邀请成员加入团队组织）留到团队功能，本 PR 只做决定第 5 项要求的“平台管理员邀请注册”；
- **密码**：argon2id（19 MiB、2 次迭代、并行度 1），用 **Node 24 内置的 `crypto.argon2`**，没有引入原生依赖，存为 PHC 字符串。至少 10 位、不超过 128 位、拒绝常见弱口令和邮箱用户名。登录时邮箱不存在、已停用、未验证都用同参数的假哈希做一次完整校验，响应码、文案（“邮箱或密码错误”）和耗时与密码错误一致；
- **会话**：256 位随机令牌，库中只存 SHA-256；Cookie 为 `__Host-session`（`HttpOnly; Secure; SameSite=Lax; Path=/`，无 `Domain`）。空闲 7 天、绝对 30 天，最近活动超过 10 分钟才写库续期。登录、注册、修改密码时轮换令牌；登出吊销当前会话；修改密码和找回密码后吊销该用户在所有组织的全部会话；被移出组织、用户停用后会话立即失效。默认需要登录，只有声明 `config.access = 'public'` 的路由（登录、登出、注册、找回密码、健康检查）放行；
- **CSRF / 跨站**：改变状态的请求必须同时满足 `Origin`（缺失时看 `Referer`）等于新配置 `PUBLIC_ORIGIN`、带 `X-Requested-With: app`、有请求体时 `Content-Type` 是 `application/json`；去掉了 Fastify 默认的 `text/plain` 解析器。`PUBLIC_ORIGIN` 生产环境必需且必须是 https，开发、测试默认 `http://localhost:3000`（浏览器只在 `localhost` 上接受非 https 的 `Secure` Cookie，所以开发时用 `localhost` 而不是 `127.0.0.1` 访问）。另外 Ajv 改为拒绝未声明的请求体字段（Fastify 默认静默删除）；
- **邀请注册**：`POST /api/admin/invitations`（平台管理员，每次从库中读取是否管理员，撤销立即生效）生成邀请，响应中返回一次链接，同时经发信接口发出。`POST /api/auth/register` 在一个事务中兑换邀请、建个人组织、用户（邮箱即受邀邮箱，凭链接送达视为已验证）、成员关系和会话，任一步失败整体回滚、邀请保持未用；
- **首个平台管理员**：`npm run admin:create -- --email <邮箱>`（镜像中 `node dist/cli/create-admin.js`），用迁移角色连接，密码在终端中两次不回显输入或从标准输入读取，不经命令行参数；
- **找回密码**：不论邮箱是否存在都返回同样的 202，邮件在响应之后异步发送；令牌一次性、30 分钟过期，新请求作废旧令牌，重放、过期、伪造一律“链接无效或已过期”。邮件和邀请链接都把令牌放在 `#` 之后，不进入访问日志和 `Referer`；
- **发信接口**（`src/mail/mailer.ts`）：发信服务未选定，目前只有日志实现。`development` 输出完整邮件（含链接）便于联调；其他环境只输出打码后的收件人和主题，正文不进日志。日志脱敏字段补充 `password_hash`、`currentPassword`、`newPassword`、`tokenHash`、`token_hash`；
- **限流**：登录按 IP（30 次 / 15 分钟）、按邮箱（10 次 / 15 分钟）并在连续 5 次失败后指数退避（1 秒起、最长 15 分钟，不存在的邮箱同样计数）；注册按 IP（10 次 / 小时）；找回密码按 IP（10 次 / 小时）和按邮箱（3 次 / 小时）；重置确认按 IP（10 次 / 15 分钟）；修改密码按用户（5 次 / 15 分钟）。超限返回 429 和 `Retry-After`。偏离设计：设计文档第 3.5 节写的是 `@fastify/rate-limit` + Redis，但 Redis 要到第 6 步才接入，本 PR 先用进程内存实现（每个限流器的键数有上限），接口不变；**多实例部署前必须换成共享存储**，已加入第 9 步上线检查。反向代理接入时同时要开启 `trustProxy`，否则所有请求的 IP 都是代理地址；
- **测试**：单元测试覆盖 argon2id 格式与假哈希耗时、密码强度、限流与退避、Cookie 属性、CSRF 各种来源与内容类型、默认需要登录、发信日志脱敏、`PUBLIC_ORIGIN` 校验。数据库测试覆盖：六个函数的属性、属主、授权（`PUBLIC`、迁移角色、其他角色都不能调用），以及通配符、正则、大小写、空值、注入串都不能列举，停用和未验证用户查不到，吊销、过期、停用、移出组织的会话查不到，令牌重放、过期、类型不符、被新令牌作废都失败，回滚后邀请保持未用；应用角色不能自封平台管理员、改状态或邮箱，非管理员不能发邀请、管理员不能冒名发邀请；端到端覆盖命令行、登录（错误与不存在的邮箱响应一致）、轮换、篡改和过期令牌、滑动续期上限、登出重放、跨站强制登出、邀请注册及重放、越权、找回密码全流程、修改密码吊销其他设备，以及每个接口的限流。把函数改成 `LIKE` 匹配、去掉吊销 / 过期检查后有 20 个用例失败。本地用 PostgreSQL 16 跑通，CI 仍是 17。

#### 限流的客户端 IP（旧仓库 PR #30）

- **修复前**：`trustProxy: false`，按 IP 的限流键（登录、注册、找回密码、重置确认）和会话的 IP 摘要取 `request.ip`，即 TCP 对端地址。直连时伪造 `X-Forwarded-For` 不起作用，但部署到 Caddy 后面时所有请求的 IP 都是 Caddy 的地址，全站共用一个计数；而如果为此简单地开 `trustProxy: true`，任何客户端都能用伪造的 `X-Forwarded-For` 换 IP 绕过限流；
- **新配置 `TRUSTED_PROXIES`**：逗号分隔的 IP 或 CIDR，默认空（不信任任何代理，行为与修复前相同）；不接受前缀为 0 的网段和 `loopback` 等别名，错误信息不回显值。非空时作为地址列表交给 Fastify 的 `trustProxy`：只有对端在列表中才读 `X-Forwarded-For`，从右往左取第一个不可信地址，客户端在左侧伪造的部分不被采信；`X-Forwarded-Host` / `Proto` 同样只在对端可信时采信，CSRF 和邮件链接用的是 `PUBLIC_ORIGIN`，不受影响；
- **部署**：`edge` 网络固定子网，`caddy` 固定地址，`TRUSTED_PROXIES` 只填这一个地址，`api` 不映射端口（设计文档第 8.1 节）；开发用 `docker-compose.yml` 显式设为空并加了说明；
- **测试**：未配置时伪造 `X-Forwarded-For`（包括来自代理地址的请求）仍按对端地址计数；配置后经代理的不同客户端分别计数，经代理时在左侧伪造的值不影响计数，绕过代理直连时不采信该头，CIDR 和 IPv4 映射的 IPv6 对端地址都能匹配。把 `trustProxy` 改成 `true` 有 4 个用例失败，改成 `false` 有 2 个失败。

#### 测试库收尾（#13）

- **问题**：`billing.test.ts` 收尾时偶发失败，错误码 57P01（`terminating connection due to administrator command`）。原因是 pg 连接池的 `end()` 在连接列表清空时就返回，并不等各连接真正断开；测试 harness 的 `drop()` 随即执行 `DROP DATABASE ... WITH (FORCE)`，终止仍在退出的后端，客户端收到 57P01，以未处理的 `error` 事件抛出。连接池越大越容易出现（`billing.test.ts` 的应用连接池为 10）。本地复现：连续 10 次关闭 10 连接的池后立刻查 `pg_stat_activity`，累计仍有 31 个后端存活；
- **修复**（`server/tests/db/harness.ts`，所有数据库测试共用，各测试文件不用改）：`connect()` 建的连接池按库名登记，`drop()` 先关闭测试文件漏关的池，再轮询 `pg_stat_activity`，等库上没有任何连接后才删除库；10 秒后仍有连接时照样删除库（不留下测试库），然后报错并列出剩余连接的用户、`application_name` 和状态，便于定位漏关的 `createDatabase()` 连接；
- **检查其他测试**：各数据库测试文件在 `afterAll` 中都先关闭自己的连接（`createDatabase()` 句柄、`connect()` 实例）再调用 `drop()`，用例内临时建的连接都在 `finally` 中关闭，没有漏关；它们都经 `drop()` 删除测试库，同一问题由本次修复一并覆盖；
- **自动合并规则**：`CLAUDE.md` 新增“自动合并”一节：最新提交上三项 CI 全部通过后可自行 squash 合并；存在需要用户决定的事项，涉及计费、鉴权与权限、Agent 沙箱，修改已有的 RLS 策略或数据库角色（按 `describeProjectTable` 模板新建表的 RLS 除外），或偏离路线图较大时，须等待用户确认；合并后发送总结并写明偏离路线图之处。分支保护目前不强制生效（第 9 步上线检查），合并前须自行核对 CI 结果。

### 第 3 步说明

#### 计费账本（旧仓库 PR #31）

第 3 步的第一个计费 PR，按 `docs/SERVER_DESIGN.md` 第 10 节实现账本，**不调用任何 AI**。`client/` 未改动，没有新增 npm 依赖。做法和与设计的偏离见 `SERVER_DESIGN.md` 第 10.7 节，要点：

- 迁移 `0003_billing`：`org_balances`、`billing_ledger`（只追加：充值、赠送、扣费、冲正，扣费记录请求编号、服务商、模型、输入 / 输出 token 数和价格版本）、`model_prices`（服务商 + 模型 + 输入 / 输出单价，带生效时间，只能新增版本）。三张表都带 `org_id` 并强制 RLS；应用角色对账本只有 `SELECT`、`INSERT`（且只能插入本组织的扣费、只能写用量列），对余额和价格表只读；
- 金额为 `bigint`，单位 0.0001 元，计价用 `numeric` 精确计算后向上取整，全程不经过浮点；
- 扣费、余额更新在同一语句（同一事务）中由账本触发器完成，持本组织余额行的行锁，同一请求编号只扣一次，余额不足整笔拒绝（402 `INSUFFICIENT_BALANCE`），余额不会为负；
- 管理员手动充值、冲正、定价只能经 `SECURITY DEFINER` 函数，校验平台管理员并记录操作人和备注；接口要求重新输入密码、充值要求再次输入金额；
- 新角色 `bidtools_billing`（`NOLOGIN`，同 `bidtools_auth`），已加入 `server/db/init/10-provision.sh` 和测试 harness。**已有的开发数据卷不会重跑初始化脚本**，要么 `docker compose down -v` 重建，要么按脚本手工建角色；
- 服务商记录为 `deepseek`、`qwen` 两家；发信服务记为“待定，首个真实用户注册前必须完成”（`docs/EXTERNAL_SERVICES.md` §7）。

与路线图 / 设计的偏离：

- **TOTP 二次验证和大额双人复核本 PR 实现不了**（TOTP 尚未实现），按要求先**禁用大额充值**：单笔手动充值 / 赠送上限写死为 1,000 元，超过一律拒绝；二次验证暂用重新输入密码。实现 TOTP 和双人复核后用新迁移放开，已加入第 9 步上线检查；
- 扣费写入账本而不是设计中的 `usage_records`，余额不能为负（设计原允许被进行中的调用透支），“调用后才发现余额不足”的处理留给 AI 网关 PR 决定（预扣冻结或差额由平台承担），届时同步修改设计第 10.3 节；
- 设计中的 `adjustment` 改为整笔冲正 `reversal`，价格表去掉 `effective_to`；`refund`、`low_balance_threshold`、缓存 token / 生图 / MinerU 单价、上游成本、充值的 `audit_logs` 和通知邮件留到后续 PR。

测试（`npm run test:db`，本地 PostgreSQL 16 跑通，CI 为 17）：计价精度（含超过 2^53 时浮点会算错的用例、溢出报错、计费列全为 `bigint`）、扣费记录字段、幂等（重复提交、并发 10 个同一请求编号、用量不一致拒绝、余额已不足时重放仍返回首次结果、编号按组织隔离）、并发扣费（余额够 10 笔时 25 笔并发恰好成功 10 笔、扣费与充值交错后不变式成立）、余额不足、未定价、跨组织隔离（余额 / 账本 / 专属价不可见、不能给其他组织记账、专属价只对本组织生效、未设置上下文返回 0 行）、账本不可修改（应用角色无 `UPDATE` / `DELETE` / `TRUNCATE`、不能写余额和价格、不能自行充值或指定金额，表属主和超级用户被触发器拒绝）、管理员充值 / 冲正 / 定价的权限与校验，以及三个管理员接口的端到端测试（二次验证、金额二次确认、JSON 数字和小数金额被拒、大额拒绝、越权、跨站、限流）。去掉行锁、幂等检查、余额检查，或放宽插入策略、给应用角色加 `UPDATE` 权限，分别有 2、4、4、1、6 个用例失败。

#### AI 网关与预扣冻结（旧仓库 PR #32）

第 3 步的第二个计费 PR，做法和与设计的偏离见 `docs/SERVER_DESIGN.md` 第 10.3、10.8 节。`client/` 未改动，没有新增 npm 依赖。要点：

- **计费决定**：调用前按“已知输入 token 的上界 + 最大输出 token”估算最高费用并冻结，余额（减去进行中的冻结）不足以冻结则拒绝、不调用服务商；调用结束按实际用量结算、释放多余部分；冻结超时自动释放（到期的冻结不再计入，不依赖后台任务）；服务商出错或超时不收费、冻结全额释放。设计文档第 10.3 节已按此改写，旧仓库 PR #31 遗留的“调用后余额不足”问题由此解决，余额仍不会为负；
- 迁移 `0004_ai_gateway`：`usage_records`（每次调用一行，含不收费的调用、所属任务、上游成本，`pending` 行即冻结）、`provider_credentials`（平台凭据密文）、`model_prices` 的上游成本单价、账本的 `usage_id` 和新版账本触发器；写入一律经 `SECURITY DEFINER` 函数，应用角色读不到上游成本；
- 平台 Key 用 KEK 文件信封加密（`AI_KEK_FILE`，开发环境由 `init-dev-secrets.sh` 生成 `ai_kek`），只有 `src/ai/gateway.ts` 解密；日志、错误信息、响应中都不出现 Key；
- 服务商：`deepseek`、`qwen`，OpenAI 兼容的流式接口，Base URL 由平台管理员与 Key 一起配置（通义千问国内站 / 国际站待定）；出站只允许 https、拒绝内网地址、不跟随重定向；
- 新配置：`AI_KEK_FILE`、`AI_KEK_VERSION`、`AI_UPSTREAM_TIMEOUT_MS`、`AI_HOLD_TTL_SECONDS`、`AI_MAX_OUTPUT_TOKENS`、`AI_UPSTREAM_PRIVATE_HOSTS`；
- 测试全部对本机模拟服务商，CI 不使用真实 Key。**已有的开发环境**需要重新运行 `server/scripts/init-dev-secrets.sh` 生成 `ai_kek`（已有的密码文件不会被覆盖），否则 `docker compose up` 找不到该 secret。

与路线图的偏离：

- 平台模型清单（`platform_models`）、设置页的“选择模型 + 查看单价”、管理后台的模型列表和连通性测试、生图和 MinerU、按组织的并发上限（依赖 Redis）留给后续 PR；请求暂时直接给出服务商和模型名；
- 网关先在 `api` 进程中提供交互式的 `ai.chat`，任务调用等第 6 步 worker 建成后接入；`jobs.billed_amount` 同样等第 6 步。

#### 平台模型白名单（旧仓库 PR #33）

AI 网关加固，做法见 `docs/SERVER_DESIGN.md` 第 10.9 节。`client/` 未改动，没有新增 npm 依赖。要点：

- **此前对未定价模型的处理**：拒绝（`ai_usage_begin` 抛 503 `MODEL_PRICE_NOT_CONFIGURED`，不冻结、不调用服务商），并非免费。但有两个缺口：价格表中有价的任何模型都能调用，没有上架控制；价格为 0 / 0 的版本等于默认免费，不需要管理员显式标记；
- 迁移 `0005_platform_models`：白名单表和管理员函数，`ai_usage_begin` 改为冻结前经 `ai_model_price` 检查；网关在解密 Key 之前预检。未登记 404、已停用 403、未定价（含未标记免费的零价格）503、免费标记与价格矛盾 503、伪造服务商名 400，都不调用服务商、不收费；
- 管理员接口：`GET /api/admin/ai/models`、`POST /api/admin/ai/models`（登记，默认停用，`isFree` 必填）、`POST /api/admin/ai/models/:id/enable`、`POST /api/admin/ai/models/:id/disable`；登记和启用要求重新输入密码；
- 用户断开：确认 `POST /api/ai/chat` 在连接关闭时立即关闭到服务商的连接，新增真实 TCP 连接的端到端测试；补上“处理开始前已断开”和“冻结前已取消”两处缺口；
- **已有的开发数据库**迁移后所有模型都要先登记并启用（`POST /api/admin/ai/models` + `/enable`）才能调用。

与路线图的偏离：第 3 步原计划的平台模型清单包括对用户展示的名称、上游模型 ID、能力、设置页“选择模型 + 查看单价”和连通性测试，本 PR 只做调用白名单，其余留到后续 PR（设计第 10.9 节）。

### 第 4 步说明

#### 文件存储（旧仓库 PR #34）

服务端的上传、下载、删除，做法见 `docs/SERVER_DESIGN.md` 第 6.5 节。`client/` 未改动。新增 npm 依赖 `@aws-sdk/client-s3`、`@aws-sdk/lib-storage`（3.1145.0）。要点：

- 对象存储只依赖 S3 API，云厂商待定（香港节点）；开发环境在 `docker-compose.yml` 中新增 `s3` 服务（SeaweedFS 4.48，只绑定 `127.0.0.1:8333`，关闭遥测），CI 以同一镜像启动；
- 迁移 `0006_files`：`files` 表带 `org_id`、强制 RLS，对象键是生成列 `org/{org_id}/files/{id}`（随机 UUID，不使用用户文件名）；配额（每组织 20 GiB）和 7 天恢复期由触发器保证；
- 接口：`POST /api/files`（原始字节上传）、`GET /api/files`、`GET /api/files/usage`、`GET /api/files/:fileId`、`GET /api/files/:fileId/content`（一律附件下载）、`DELETE /api/files/:fileId`（软删除）、`POST /api/files/:fileId/restore`；
- 新配置：`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY(_FILE)`；**已有的开发环境**需要重新运行 `server/scripts/init-dev-secrets.sh` 生成 `s3_secret_key`（已有的文件不会被覆盖），否则 `docker compose up` 找不到该 secret。

与路线图、设计的偏离：

- 上传用 `application/octet-stream` 原始字节而不是 multipart（设计第 6.1 节），理由见设计第 6.5 节；
- 表名用 `files` 而不是 `file_objects`，暂不含 `project_id`（第 5 步建 `projects` 后补）；
- 下载由 api 流式转发，不签发预签名链接；图片也一律以附件下载，不 `inline`；
- 文本文件按原样存储并记录编码，不在上传时转成 UTF-8；
- 回收站中的文件仍占配额，直到恢复期结束；
- 过期文件和遗留上传记录的物理清理、解析阶段的 ZIP 炸弹 / PDF 页数检查、替换 `getPathForFile` / `filePaths` / `app-asset://` / `openFile` / 保存对话框留给第 4 步后续 PR 和第 6 步。

#### 上传白名单与桌面版的差距（旧仓库 PR #35 记录；第 1~4 项已由 #6 补上，第 5 项随第 6 步）

`server/src/files/policy.ts` 的扩展名集合与桌面版**本地解析**的集合逐项一致：`tender`（招标文件、原方案、可研资料、废标检查的招标 / 投标文件都用它）为 txt、md、markdown、docx、pdf、doc、wps、xls、xlsx；`knowledge`、`duplicate-check` 同上但不含 txt；`credential-image` 为 png、jpg、jpeg、webp、bmp、gif。老式 `.doc` / `.xls` 和 WPS 文字 `.wps` 已覆盖（接受 OLE，也接受改了扩展名的 OOXML）。但按**内容**比较，桌面版还能导入以下文件，服务端会以 `FILE_TYPE_MISMATCH` 拒绝：

| # | 桌面版能导入、服务端拒绝的文件 | 桌面版的处理 | 补充方案 |
|---|---|---|---|
| 1 | 扩展名是 `.docx`、内容是 OLE 的老 Word 文件 | `convert.mjs` 的 `detectFileFormat` 按文件头判为 `legacy_word`，转换前改回 `.doc` | `docx` 的允许类型加 `ole`，MIME 记为 `application/msword`，解析按老式 Word 处理；风险低 |
| 2 | 扩展名是 `.doc` / `.wps`、内容是 RTF、HTML、MHT 或 Word 2003 XML（政府采购平台常见的“另存为 doc”） | 文件头既不是 OLE 也不是 ZIP 时按扩展名交给 LibreOffice / Word / WPS 转换 | 新增内容类型 `rtf`（`{\rtf`）、`mht`（`MIME-Version:` 头）、`html`、`word-xml`（`<?xml` 且含 `w:wordDocument`），只对 doc / wps 放行；MIME 按真实内容记录；只能在第 6 步的沙箱中由 LibreOffice 解析，下载仍一律附件 |
| 3 | 扩展名是 `.xls`、内容是 HTML 表格、SpreadsheetML 2003 XML、CSV 或 BIFF2~4（各类系统导出的“xls”） | 按扩展名交给 SheetJS，SheetJS 能读这些格式 | 对 xls 放行 `html`、`spreadsheet-xml`（含 `urn:schemas-microsoft-com:office:spreadsheet`）；CSV 与 BIFF2~4 没有可靠的文件头，建议不放行，提示用户另存为 xlsx |
| 4 | `%PDF-` 前有少量多余字节的 PDF | 按扩展名交给 pdfjs，pdfjs 容忍文件头前 1024 字节内的垃圾 | 文件头判断扩大到前 1024 字节内查找 `%PDF-`；优先级低 |
| 5 | 设置中解析服务选 MinerU 时的 ppt、pptx、图片（png、jpg、jpeg、jp2、webp、gif、bmp）和 html（仅精准解析） | `fileService.cjs` 的 `getSelectableExtensions` 在本地集合之外加上 MinerU 集合 | Web 版是否由平台提供 MinerU 解析尚未决定（`platform_models` 的“解析”能力）；决定提供时，`tender` 加 ppt（OLE）、pptx（ZIP 内有 `ppt/presentation.xml`）、jp2 和已有的图片类型，html 不放行 |

另外，WPS 表格 `.et`、WPS 演示 `.dps` 和模板 `.wpt` / `.ett` 桌面版本身也不支持，不算遗漏；如果产品上需要，`.et` 可按 OLE 接受、经 LibreOffice 转成 xlsx 后解析，单独评估。

以上都只改 `server/src/files/inspect.ts`、`policy.ts` 和测试，不改迁移；第 2、3 项放行的是文本类格式，必须同时满足第 6.2 节“在沙箱中解析”的前提，建议与第 6 步的解析任务一起做。旧仓库 PR #35 不修改。第 1~4 项已在 #6 提前补上（偏离见下一节），第 5 项仍随第 6 步。

#### 上传白名单补充（#6）

补上上表第 1~4 项，只改 `server/src/files/inspect.ts` 和测试；`policy.ts` 的扩展名集合、迁移、`client/` 都没有改动，没有新增依赖。做法见 `docs/SERVER_DESIGN.md` 第 6.5 节。要点：

- `.docx` 接受 OLE，MIME 记为 `application/msword`（解析按老式 Word 处理）；
- `.doc` / `.wps` 接受 RTF（`{\rtf`，`application/rtf`）、HTML（`<!doctype html` 或 `<html` 开头，`text/html`）、MHT（开头是 MIME 头且含 `MIME-Version:`，`message/rfc822`）、Word 2003 XML（`<?xml` 开头、根元素 `w:wordDocument`，`application/xml`）；`.xls` 接受 HTML 表格和 SpreadsheetML 2003 XML（`<?xml` 开头、含 `urn:schemas-microsoft-com:office:spreadsheet`，`application/xml`）。允许 UTF-8 BOM 和开头空白，UTF-16 不识别；CSV 与 BIFF2~4 仍拒绝；
- **HTML / MHT 只能以 `.doc` / `.wps` / `.xls` 上传**（MHT 只对 `.doc` / `.wps`），`.html`、`.htm`、`.mht`、`.mhtml`、`.rtf`、`.xml` 扩展名仍不开放；其他扩展名（图片、`.pdf`、`.docx`、`.xlsx`、`.txt` 以外）收到这些内容一律 `FILE_TYPE_MISMATCH`；
- PDF 在前 1024 字节（`SNIFF_BYTES`，与 pdfjs 一致）内查找 `%PDF-`；开头是 HTML / MHT / RTF / XML 的多格式文件不当作 PDF；
- 二进制文件头仍在前 16 字节判断，不符立即中断；只有文件头不是已知二进制格式、且扩展名允许文本类内容或 PDF 时，才最多再等 1024 字节；
- 下载不变：一律 `Content-Disposition: attachment`，`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`，记录为 `text/html` 的文件也不会在浏览器中渲染；
- 测试用的真实样本在 `server/tests/files/samples/`：除 MHT 外都由 LibreOffice 24.2 导出，并确认 LibreOffice 能按改后的扩展名正确读出内容（PDF 用 pdftotext 确认）。

与路线图的偏离：

- 上一节建议第 2、3 项与第 6 步的解析任务一起做，本 PR 提前做了上传校验。理由：本步只收下并按原样存储，不解析，下载一律附件；解析时的约束由第 6 步承担，见下面的“第 6 步解析要求”；
- 两种 Office 2003 XML 都记为 `application/xml`，解析时按扩展名区分（`.doc` / `.wps` 是 Word，`.xls` 是 SpreadsheetML）。

**第 6 步解析要求**（本 PR 放行的格式在第 6 步解析时必须满足，第 6 步的解析任务 PR 逐项核对）：

- **按记录的 MIME 分派，只在沙箱中解析**：`text/html`、`message/rfc822`、`application/rtf`、`application/xml` 一律只进沙箱中的 LibreOffice（`.xls` 的 HTML / SpreadsheetML 可用 SheetJS，同样在沙箱中），不在 api / worker 进程内解析；
- **解析沙箱完全断网**：没有任何网络接口（不只是限制出站），沙箱内的进程无法访问外网、内网和元数据地址；
- **HTML / MHT / RTF 禁止加载任何远程资源**：外链图片、样式表、脚本、`<iframe>` / `<object>`、RTF 的 `INCLUDEPICTURE` / `INCLUDETEXT` 等域和 OLE 链接一律不加载、不更新；MHT 中 `Content-Location` 指向的外部地址同样不跟随，只用包内已有的部分。断网是兜底，解析器本身也要关闭链接更新和远程加载；
- **XML 类格式（Word 2003 XML、SpreadsheetML）禁用 DTD 和外部实体**：拒绝含 `<!DOCTYPE` 的文档，或以禁用 DTD、外部实体、外部参数实体和 XInclude 的方式解析（防 XXE 和实体膨胀）；不能只依赖 LibreOffice 的默认设置，需要在交给 LibreOffice / SheetJS 之前先检查，并有测试；
- **MHT 先解包**：LibreOffice 不认识 MHT，会当作纯文本读出 MIME 头和 base64。需要先在沙箱中解开 MIME，取 `text/html` 部分（按其 `Content-Transfer-Encoding` 和 `charset` 解码）再交给 LibreOffice，解出的 HTML 同样适用上一条“禁止加载远程资源”。

### 第 5 步说明

#### 拆分计划

只做计划，不改代码。原则（`docs/SERVER_DESIGN.md` 第 2 节）：

- 每个 PR 只做一个模块或一组紧密相关的表：一个迁移 + 异步 Store（只接受 `TenantContext`）+ 该模块面向用户的同步接口 + 测试（含 RLS“未设置上下文返回 0 行”和跨组织访问拒绝）。Store 中给任务用的写函数（如 `checkpointTask` 写结果）在本步一并实现并直接测试，第 6 步的 worker 只负责调用；
- 各模块的 `*_tasks` 表和 `task_logs` **不迁移**，由第 6 步的 `jobs` / `job_events` 取代；本步的 `loadState` 类接口中任务状态先返回空；
- `*_path`、`document_dir` 等路径字段改为 `files.id`（用户上传的原件）或生成产物 id（解析出的 Markdown、图片等，见 5.2）；
- 导入文档在本步只做“把已上传的 `files.id` 挂到项目 / 知识库”，文档状态停在“待解析”，解析（`doc2markdown`、LibreOffice、MinerU）在第 6 步的 worker 中执行；
- 不做 `app.sqlite` 导入（第 9 节第 18 项）。路线图原写“数据迁移脚本支持从 `app.sqlite` 导入”，按 旧仓库 PR #26 的决定删去；
- `official_invoice_info` 不迁移。

**各模块涉及的表、接口与依赖**（模块编号同第 2 节）：

| 模块 | 表 | 本步的服务端接口 | 依赖 | 推迟到 |
|---|---|---|---|---|
| A 应用壳层 | 无 | 无（`database.getStatus` 由 `/readyz` 取代；更新、GPU、系统字体在 Web 端做空实现） | — | 第 9 步（bridge 空实现）；系统字体列表随第 7 步镜像字体 |
| B 配置 | 新表 `org_settings`、`user_settings`（拆自 `user_config.json`，不在 SQLite 中） | `GET/PATCH /api/settings`（组织级：选用的 `platform_model_id`、并发、导出偏好；用户级：界面偏好、`agent_auto_answer_enabled`）；返回中不含任何 Key | `platform_models`（旧仓库 PR #33） | 设置页“选择模型 + 查看单价”的前端接入随第 3 步后续 PR |
| C AI / Agent | 无 SQLite 表；Pi 持久任务状态 `task-state.json` | 无 | — | **第 8 步**（改存 `jobs.checkpoint`） |
| D 后台任务 | 各模块的 `*_tasks`、`task_logs` | 无 | — | **第 6 步**（`jobs` / `job_events`） |
| E 技术方案 | `technical_plan_meta`、`_generation_config`、`_generation_bid_tasks`、`_generation_reference_docs`、`_bid_items`、`_outline_nodes`、`_global_fact_groups`、`_content_sections`、`_content_plans`（`_tasks` 见 D） | `GET /api/projects/:id/technical-plan`（`loadState`）、`PATCH .../step`、`DELETE`（`clear`）、`.../generation-config`、`.../bid-analysis-config`、`.../content-options`、招标文件和原方案的挂载与移除、`readTenderMarkdown` / `readTenderSourceMarkdown`、`selectBidSection`、`PUT .../outline`（保留 `reason` 协议）、`PUT .../global-facts`、`PUT .../chapters/:nodeId`、`resetContentGeneration` | projects、5.2 生成产物；`_generation_reference_docs` 引用知识库文档；`_bid_items` 由招标解析任务写入 | 招标解析、多标段识别：**第 6 步**；目录生成 / 调整、全局事实生成 / 调整：**第 6 步核实**（调用 `agentService.runTask`，若 Pi 需要命令工具则**第 8 步**）；正文生成、原方案还原：**第 8 步**；`previewContentWord`、`openBidTemplate`：**第 7 步** |
| F 可研报告 | `feasibility_report_meta`、`_outline_nodes`（`_tasks` 见 D）；#19 另把资料和引用的知识库文档拆成 `_sources`、`_reference_docs` | `loadState`、`updateStep`、`saveProjectInfo`、`saveAnalysis`、`saveOutlineConfig`、`saveOutline`、`saveKeyParameters`、`saveChapterContent`、可研资料的挂载 / 移除 / `readSourceMarkdown`、`clear` | projects、5.2 | 资料分析、关键参数：**第 6 步**；目录生成 / 调整（`agentService.runTask`）：**第 6 步核实，可能第 8 步**；正文生成：**第 8 步** |
| G 废标检查 | `rejection_check_meta`、`_documents`、`_extraction`、`_results`、`_risk_findings`、`_typo_findings`、`_logic_findings`（`_tasks` 见 D） | `loadState`、`importDocument`（挂载 `files.id`）、`removeDocument`、`saveUiState`、`updateState`、`clear`、`exportExcel`（服务端同步生成 xlsx 后附件下载，不需要队列） | projects、5.2；`importTenderFromTechnicalPlan` 依赖 E | 废标项解析、废标检查：**第 6 步** |
| G 标书查重 | `duplicate_check_meta`、`_files`、`_analysis_sections`、`_content_files`、`_metadata_items`、`_outline_items`、`_outline_groups`、`_outline_pairwise`、`_content_duplicates`、`_content_occurrences`、`_image_files`、`_duplicate_images`、`_image_occurrences`（`_tasks` 见 D） | `loadState`、`saveFiles`（挂载 `files.id`，取代 `selectDuplicateCheckFiles`）、`saveUiState`、`updateState`、`clear`、`exportExcel` | projects、5.2 | 查重分析：**第 6 步** |
| H 知识库 | `knowledge_folders`、`_documents`、`_document_steps`、`_blocks`、`_candidate_items`、`_items`、`_item_blocks`、`_discarded_groups`、`_reports`、`_match_batches`（组织级） | 文件夹增删改与排序、文档移动 / 删除、`uploadDocuments`（挂载 `files.id`）、`search`（分页）、`readMarkdown`、`readItems`、`readAnalysis` | 5.2（不依赖 projects） | 文档准备（解析、切块、条目抽取）、`retryDocument`、`startMatching`、`onEvent` 推送：**第 6 步** |
| H 资信库 | `credential_library_profile`（主键改为 `org_id`）、`_certificates`、`_employees`、`_projects`、`_other_materials`、`_images`（`relative_path` 改为 `files.id`） | `load`、`saveProfile`、`addProfileImages`（挂载 `credential-image` 文件）、`deleteImage`、证书 / 人员 / 业绩 / 其他材料的保存与删除；图片经 `/api/files/:id/content` 读取 | 文件存储（旧仓库 PR #34）；不依赖 projects 和 5.2 | `importTestData`（开发者功能）不迁移 |
| I 导出与模板 | `export_templates`（系统模板 `org_id` 为空、全体只读） | `templates.list/get/create/update/delete/duplicate` | 无 | `renderPreview`、`exportWord`：**第 7 步**；`export.openFile` 改为下载，随第 4 步后续 PR |
| J 文件 / 插件 | 文件已由 `files`（旧仓库 PR #34）承担；插件无表 | `files.project_id`（见 5.1） | projects | `getPathForFile` 替换：第 4 步后续 PR；插件：第 9 步下线 |
| K 开发者工具 | 无 SQLite 表；Token 统计（JSON 文件）已由 `usage_records`（旧仓库 PR #32）取代 | 无 | — | 第 9 步改为管理员页面；Agent 监视器依赖**第 8 步** |

**PR 拆分顺序**：

| 序号 | 内容 | 依赖 | 状态 | PR |
|---|---|---|---|---|
| 5.0 | 拆分计划（本文档）、上传白名单差距记录 | — | 已完成 | 旧仓库 PR #35 |
| 5.1 | `projects`（`org_id`、`kind`：technical-plan / feasibility-report / rejection-check / duplicate-check、名称、`created_by`、软删除与 7 天恢复期）；`files` 加可空 `project_id`（复合外键 `(org_id, project_id)`）；项目接口 `GET/POST /api/projects`、`GET/PATCH/DELETE /api/projects/:id`、恢复；路由层的项目归属校验（按 `projectId` 查项目并核对 `org_id` 与 `kind`）；项目级表的迁移与测试模板（复合外键、RLS、`timestamptz` / `jsonb` 约定） | — | 已完成 | #7 |
| 5.2 | 生成产物存储：解析出的 Markdown、提取的图片等派生文件（对象键 `org/{org_id}/artifacts/{id}`，可挂 `project_id`，记来源 `file_id`，计入组织配额），只读接口；写入方是第 6 步的解析任务，本步只提供 Store 函数和测试。另补上项目删除与文件的联动（5.1 留下）：项目软删除时，其下的文件（`files.project_id`）和生成产物同步不可访问；恢复项目时一起恢复；过期后与项目一起由清理任务物理删除（清理任务本身在第 6 步） | 5.1 | 已完成 | #8 |
| 5.3 | B 配置：`org_settings`、`user_settings` | — | 已完成 | #9 |
| 5.4 | I 模板库：`export_templates` | — | 已完成 | #10 |
| 5.5 | H 资信库：6 张表 | — | 已完成 | #11 |
| 5.6 | H 知识库（一）：`knowledge_folders`、`_documents`、`_document_steps`、文件夹与文档管理接口 | 5.2 | 已完成 | #12 |
| 5.7 | H 知识库（二）：`_blocks`、`_candidate_items`、`_items`、`_item_blocks`、`_discarded_groups`、`_reports`、`_match_batches`、检索与读取接口 | 5.6 | 已完成 | #14 |
| 5.8 | G 标书查重：13 张表与接口、`exportExcel` | 5.1、5.2 | 已完成 | #16 |
| 5.9 | G 废标检查：7 张表与接口、`exportExcel`（不含 `importTenderFromTechnicalPlan`） | 5.1、5.2 | 已完成 | #18 |
| 5.10 | F 可研报告：2 张表与接口（实际拆成 4 张，见下方“可研报告”一节） | 5.1、5.2、5.6 | 已完成 | #19 |
| 5.11 | E 技术方案（一）：`technical_plan_meta`、`_generation_config`、`_generation_bid_tasks`、`_generation_reference_docs`、`_bid_items`，状态、配置、招标文件 / 原方案、标段接口（实际另有 `_documents`，见下方“技术方案（一）”一节） | 5.1、5.2、5.6 | 已完成 | #20 |
| 5.12 | E 技术方案（二）：`_outline_nodes`、`_global_fact_groups`，`saveOutline`（`reason` 协议、节点 UUID 与 `sort_order` 语义不变）、`saveGlobalFacts` | 5.11 | 已完成 | #21 |
| 5.13 | E 技术方案（三）：`_content_sections`、`_content_plans`，`saveChapterContent`、`resetContentGeneration`；补上废标检查的 `importTenderFromTechnicalPlan` | 5.12、5.9 | 已完成 | #22 |

顺序说明：5.1 是所有项目级模块的基础，最先做；5.2 是所有“导入后读 Markdown”的接口的基础。5.3~5.5 不依赖二者，可在 5.1 评审期间并行。之后按路线图原顺序（模板库 → 资信库 → 知识库 → 查重 → 废标 → 可研 → 技术方案）由简到繁，技术方案最复杂，表最多、持久化协议最多，拆成三个 PR。知识库排在技术方案之前，因为 `_generation_reference_docs` 引用知识库文档。

**推迟到第 6、7、8 步的部分**（本步只建表和 Store，不实现）：

- **第 6 步（任务队列）**：所有 `*_tasks` / `task_logs`；所有解析任务（招标文件、原方案、可研资料、废标文档、查重文件、知识库文档）；招标解析、多标段识别、查重分析、废标项解析与检查、可研资料分析与关键参数、知识库准备与匹配；所有进度推送（`onTaskEvent`、`knowledgeBase.onEvent`）；过期文件与产物的物理清理；
- **第 6 步核实、可能推迟到第 8 步**：技术方案的目录生成 / 调整、全局事实生成 / 调整，可研报告的目录生成 / 调整。它们经 `agentService.runTask` 调用 Pi，路线图第 6 步原计划在队列中迁移，需先确认这些任务的 Pi 是否用到 `read/write/bash` 等命令工具；用到则随第 8 步迁移；
- **第 7 步（OpenXmlHelper 与离屏渲染）**：模板样张 `renderPreview`、Word 导出、`previewContentWord`、模板提取；
- **第 8 步（Agent 沙箱）**：正文生成、章节重写、原方案还原、格式自检、Agent 问答，Pi 持久任务状态，开发者 Agent 监视器。

#### 项目（#7，5.1）

只改 `server/`，不改 `client/`，没有新增依赖。

- **迁移 `0007_projects`**：`projects`（`org_id`、`kind`、`name`、`created_by`、`created_at`、`updated_at`、`deleted_at`、`deleted_by`，`UNIQUE (org_id, id)` 供子表复合外键引用）。`kind` 只能是 `technical-plan` / `feasibility-report` / `rejection-check` / `duplicate-check`；名称 1~200 字、首尾无空白。强制 RLS，应用角色只能读写本组织、`created_by` 必须是当前用户；`kind`、`created_by` 没有列级 UPDATE 授权，建好后不能改；**不授予 DELETE**，只能软删除，触发器 `projects_guard` 保证已删除的项目除恢复外不能再改（`PJ004`）、删除超过 7 天不能恢复（`PJ002`），并维护 `updated_at`。物理删除留给第 6 步的清理任务。
- **`files.project_id`**：可空，复合外键 `(org_id, project_id) → projects (org_id, id)`，**不级联**（与 `files.org_id` 相同：对象存储中的内容要先由清理任务删除，项目不能连带删掉元数据而留下孤儿对象）；应用角色有该列的 INSERT / UPDATE 授权，供后续模块“把已上传的 `files.id` 挂到项目”。文件接口的返回中加了 `projectId`；上传接口暂不接受 `projectId`，挂载随各模块的导入接口。
- **项目接口**：`GET /api/projects`（`?kind=`、`?deleted=true` 为回收站、`?limit=`）、`POST /api/projects`、`GET/PATCH/DELETE /api/projects/:projectId`、`POST /api/projects/:projectId/restore`；组织内成员都可以操作（组织内共享，第 9 节第 2 项）。名称做 NFC 归一化、去掉控制字符和零宽 / 双向文本控制字符（Unicode Cc / Cf）和首尾空白。
- **项目删除与文件的联动留给 5.2**：本 PR 中项目软删除不影响其下文件，`GET /api/files/:fileId` 仍可访问；5.2 补上“同步不可访问、一起恢复、过期后一起清理”，见上方拆分顺序表。（已由 #8 补上，见下节）
- **路由层归属校验**：`src/projects/access.ts` 的 `requireProject(db, context, projectId, kind)` 和 `PROJECT_ID_PARAMS`。各模块的项目级接口（`/api/projects/:projectId/<模块>/...`）先调用它：按 `TenantContext` 查出未删除的项目，再显式核对 `org_id` 和 `kind`；查不到、别的组织、已删除、`kind` 不符一律返回同一个 `404 PROJECT_NOT_FOUND`。
- **项目级表模板**：迁移写法见 `server/tests/db/fixtures/exampleProjectTable.ts`（单行 meta 表以 `project_id` 为主键、多行子表、引用 `files` 的复合外键、`jsonb` 顶层类型约束、`timestamptz`、`updated_at` 触发器函数 `app_touch_updated_at()`（建在 0007 中）、索引以 `org_id, project_id` 开头、RLS 与授权）；该文件只在测试中执行，不登记到迁移清单。隔离测试模板是 `server/tests/db/projectTable.ts` 的 `describeProjectTable`：RLS 启用并强制、策略只授予应用角色、`org_id` / `project_id` 不可空、未设置上下文时查询返回 0 行且写入被拒绝、跨组织读写互相隔离、复合外键挡住跨组织的 `project_id`（插入和改挂）、项目物理删除时级联或被挡住。5.2 起每张项目级表都照模板写迁移，并调用一次 `describeProjectTable`；本 PR 已对 `files` 和两张模板表各跑一遍。

与路线图的偏离：

- `docs/SERVER_DESIGN.md` 第 2.5 节原写 `projects` 有“归档时间”，按拆分计划改为软删除与 7 天恢复期，与文件一致；归档如有需要以后另加列；
- 新增的通用触发器函数 `app_touch_updated_at()` 拆分计划中没有列出，属于“`timestamptz` 约定”的一部分，供项目级表复用。

#### 生成产物（#8，5.2）

只改 `server/`，不改 `client/`，没有新增依赖。

- **迁移 `0008_artifacts`**：`artifacts` 表存解析出的 Markdown、提取的图片等派生文件的元数据，内容在对象存储中。对象键是生成列 `org/{org_id}/artifacts/{id}`（随机 UUID，任何角色都不能写入）。`project_id`、`source_file_id` 都可空但至少有一个，分别以复合外键 `(org_id, …)` 指向 `projects`、`files`，**不级联**（对象要先由清理任务删除），写入后不能改挂。`kind` 只有 `markdown`（`text/markdown; charset=utf-8`）和 `image`（png / jpeg / gif / webp / bmp），种类与 MIME 由 CHECK 约束绑定，HTML、SVG 等能执行脚本的类型存不进来；`name` 由服务端生成，只允许 `[A-Za-z0-9._-]`，只作下载文件名。强制 RLS，`created_by` 必须是当前用户。与 `files` 相同分两步写入：登记 `writing`（不计入配额）→ 写对象 → 完成时触发器 `artifacts_guard` 检查配额（`AR001`，与上传文件共用同一个 advisory lock），完成后不可修改（`AR003`）；应用角色只能物理删除 `writing` 行。已按模板调用一次 `describeProjectTable`。
- **Store**（`src/artifacts/store.ts`）：给第 6 步解析任务用的 `writeArtifact`（登记 → 写对象 → 完成，任一步失败都删除对象和登记行）以及 `beginArtifact` / `completeArtifact` / `abandonArtifact`；读取用的 `findArtifact`、`listArtifacts`。参数不合法（种类、MIME、名称、没有归属）是调用方的程序错误，抛 `TypeError`。
- **只读接口**：`GET /api/artifacts?projectId=…` 或 `?sourceFileId=…`（二选一，可加 `kind`、`limit`）、`GET /api/artifacts/:artifactId`、`GET /api/artifacts/:artifactId/content`。下载与文件相同：api 流式转发、一律附件、`nosniff`、`sandbox` CSP、`private, no-store`。其他组织的、写入中的、不可访问的产物一律 `404 ARTIFACT_NOT_FOUND`。
- **项目软删除联动**（5.1 留下），**由 RLS 强制**：重建应用角色在 `files` 上的四条策略，并在 `artifacts` 的策略中加入同样的条件。所属项目已删除的文件，以及所属项目已删除或来源文件不可访问（未上传完成、已删除，或所在项目已删除）的产物，在应用角色下查不到、改不了、删不掉，也不能新写到已删除的项目或来源文件下。任何查询都绕不过这条规则，包括不带条件的全表查询和以后新写的接口；Store 中不再重复判断。删除状态不复制到文件和产物上：恢复项目即一起恢复；项目删除前就单独删除的文件仍留在回收站，按自己的恢复期处理。项目条件写成“不存在同 id 的已删除项目”，跨组织的 `project_id` 仍由复合外键报错。删除项目前已登记、删除后才完成的产物无法完成，留下的 `writing` 行不计配额，由清理任务删除。
- **配额**：`files_org_usage_bytes` 改为统计文件和产物合计（`/api/files/usage` 与上传预检随之包含产物）。文件另要求所属项目未删除或仍在恢复期内；产物要求所属项目同上，且来源文件仍计入配额。已删除项目下的行在恢复期内仍要计入，否则“删除项目 → 继续上传 → 恢复项目”可以越过配额，所以函数改为 `SECURITY DEFINER`。属主是新角色 `bidtools_storage`：`NOLOGIN`、无 `BYPASSRLS`，只有为它单独建的只读策略和列级 `SELECT` 授权。函数只允许统计当前上下文的组织（`AR004`）。项目超过恢复期后，其下文件和产物不再计入配额，由第 6 步的清理任务与项目一起物理删除（外键保证清理顺序：产物 → 文件 → 项目）。
- 新角色 `bidtools_storage` 已加入 `server/db/init/10-provision.sh` 和测试 harness。**已有的开发数据卷不会重跑初始化脚本**：要么 `docker compose down -v` 重建，要么按脚本手工建角色；生产环境同样由管理员创建（第 9 步上线检查的“数据库角色”一条，#9 补上）。
- `describeProjectTable` 新增 `definerRoles`：除应用角色外另有策略的函数属主必须显式声明，模板检查它们不能登录、没有 `BYPASSRLS`、对该表只有 `SELECT` 策略。
- **性能**：策略按行做主键查找（`projects.id`，产物另查 `files.id`，其中又带 `files` 自身的项目条件）。接口都按 id 或带上限的列表查询，代价是每行一两次索引查找；配额函数与之前一样按组织汇总。数据量增长后若列表变慢，再加按 `(org_id, project_id)` 的部分索引或改写为 join。

与路线图、设计的偏离：

- 对象键用拆分计划的 `org/{org_id}/artifacts/{id}`，而不是设计第 6.3 节的 `org/{orgId}/artifacts/{jobId}/{name}`：任务表在第 6 步才有，且名称不进对象键更简单；设计文档已同步；
- 来源文件单独删除时，其产物同样不可访问、随文件恢复。拆分计划只写了项目删除的联动，这里按同一机制补上，避免删除原件后解析结果仍可读取；
- 产物本身没有单独的软删除和删除接口：重新解析时如何替换旧产物，随第 6 步的解析任务设计；
- 测试中对象存储用内存实现（`tests/db/artifacts.test.ts`），S3 兼容服务本身由 `files.test.ts` 覆盖；
- 新增集群级角色 `bidtools_storage`（拆分计划未列出），理由见上方“配额”。

#### 配置（#9，5.3）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。

- **迁移 `0009_settings`**：由桌面版 `user_config.json` 拆出两张表，都不存任何 Key、Base URL 或服务商配置（平台统一提供 AI）。
  - `org_settings`：每个组织一行（主键 `org_id`）。`platform_model_id`（外键指向 `platform_models`，可空）、`concurrency_limit`（1~20，默认 10，与桌面版文本模型默认值相同）、`export_format`（导出偏好，`jsonb` 对象，≤ 64 KiB）、`updated_by`、`timestamptz` 时间，`updated_at` 由 `app_touch_updated_at()` 维护。
  - `user_settings`：每个组织的每个成员一行（主键 `(org_id, user_id)`）。`agent_auto_answer_enabled`（默认 false）、`ui_preferences`（界面偏好，`jsonb` 对象，≤ 16 KiB）。用户可属于多个组织，设置按组织分开，符合“每张业务表都有 `org_id`”。复合外键 `(org_id, user_id) → org_memberships` 级联删除。
  - 两张表都不授予 DELETE；`org_id`、`user_id` 没有列级 UPDATE 授权。
- **权限与删除可见性由 RLS 强制**，应用代码不判断：
  - 组织设置全体成员可读；INSERT / UPDATE 策略要求 `org_memberships` 中当前用户的角色是 owner 或 admin，且 `updated_by` 是当前用户。数据库不信任 `TenantContext.role`：伪造上下文角色直接写库、管理员降级后用旧上下文写入都被拒绝。Store 在写之前按 `context.role` 提前返回 `403 SETTINGS_FORBIDDEN`，只为给出明确的错误；RLS 拒绝（`42501`）同样映射为 403。
  - 用户设置只有本人可见、可写；策略另要求成员关系仍然存在，所以移出组织或注销后，即使行因故还在（测试中跳过级联来验证）也查不到、改不了、不能新写；正常情况下由外键级联物理删除，会话也随成员关系删除而失效。
- **平台模型选择**：触发器 `org_settings_guard` 只允许选已登记且启用的模型（`ST001` → `400 PLATFORM_MODEL_UNAVAILABLE`），只在选择发生变化时检查。选择后才停用的模型照常保留，接口返回其 `enabled: false` 供设置页提示重新选择，调用时由 `ai_model_price` 拒绝（`BL012`）；`platform_models` 不能删除。Store 先 `INSERT ... ON CONFLICT DO NOTHING` 再 `UPDATE`，不用 `ON CONFLICT DO UPDATE`：后者对拟插入的行也触发 `BEFORE INSERT`，会把“保持已停用的旧选择不变”误判为新选择。
- **接口**（`src/routes/settings.ts`、`src/settings/store.ts`）：`GET /api/settings` 返回 `{ org, user, canEditOrg }`，没写过时返回默认值，不预先插入行；`PATCH /api/settings` 接受 `{ org?, user? }` 部分更新，同一事务写入，组织部分被拒时用户部分也不写入。JSON Schema 拒绝未声明字段（包括 `apiKey`、`baseUrl`）；导出偏好、界面偏好只要求是对象，深度 ≤ 32、序列化后不超过上限，含 `\u0000` 等 `jsonb` 不接受的字符时返回 `400 SETTINGS_INVALID`，内容的归一化仍由前端完成（与桌面版相同）。响应带 `cache-control: no-store`。
- **隔离测试**：`describeProjectTable` 新增 `scope: 'org'`（组织级表：检查没有 `project_id` 列，跳过与项目有关的用例）和 `userColumn`（只属于一个成员的行：同组织其他成员看不到、改不到、不能代写、不能改挂，成员关系删除后行随之删除）。两张表各调用一次；另测了上面的 RLS 规则，去掉策略中的角色条件、成员关系条件或触发器的启用检查，分别有 2、1、1 个用例失败。

与路线图、设计的偏离：

- `describeProjectTable` 原只适用于项目级表，本 PR 按上面的方式扩展到组织级表，没有另写模板；
- `user_settings` 按 (组织, 用户) 而不是按用户存储，理由见上；
- 拆分计划写的“并发”只做了一个组织级 `concurrency_limit`，第 6 步的队列和 AI 网关按它与平台上限取较小值；桌面版生图、Mermaid、HTML 渲染各自的并发上限随相应功能迁移时再定；
- 桌面版的 GPU 加速、开发者模式、Token 统计 / Agent 监视器自动打开、`storage_cleanup_version` 不迁移（第 5 步 A、K 模块：Web 端空实现或改为管理员页面）。

#### 导出模板（#10，5.4）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。

- **迁移 `0010_export_templates`**：取代桌面版 SQLite 的 `export_templates`。`id`（UUID）、`org_id`（可空，外键级联删除）、`system_key`、`name`（1~200 字、首尾无空白）、`config`（完整的导出格式配置，`jsonb` 对象，≤ 64 KiB，与 `org_settings.export_format` 相同）、`sort_order`、`created_by` / `updated_by`、`timestamptz` 时间（`app_touch_updated_at()` 维护 `updated_at`），`UNIQUE (org_id, id)` 供以后的复合外键引用。
  - 组织模板：`org_id` 为本组织，`system_key` 为空，`created_by` / `updated_by` 必填；系统模板：`org_id` 为空，`system_key` 必填（稳定标识，取代桌面版的 `is_system` 和 `tpl-system-*` id），没有创建者。形状由 CHECK 约束 `export_templates_owner_shape` 绑定；`name` 必须等于 `config.template_name`（CHECK），与桌面版“名称取自配置”的约定一致，二者不会分叉。
  - 每个组织最多 100 个模板（触发器 `export_templates_guard`，`ET001` → `409 TEMPLATE_LIMIT_REACHED`，同一组织的插入用 advisory lock 串行），系统模板不计。
  - 删除是物理删除，与桌面版相同：模板是随时可以复制的配置，不设回收站。
- **修改、删除权限与可见性由 RLS 强制**，应用代码不判断：
  - 应用角色 SELECT：设置了组织上下文时，看到本组织的模板和系统模板；未设置上下文什么都看不到。INSERT / UPDATE / DELETE 只对 `org_id = 当前组织` 的行生效，`created_by` / `updated_by` 必须是当前用户：系统模板和其他组织的模板修改、删除都影响 0 行，不能新写 `org_id` 为空的行，也不能把组织模板改成系统模板（`org_id`、`system_key` 没有列级写授权）。组织内成员都可以增删改（组织内共享，第 9 节第 2 项）。
  - Store 只在影响 0 行时回头查一次，区分“系统模板不可编辑 / 不可删除”（`403 TEMPLATE_READ_ONLY`）和“不存在”（`404 TEMPLATE_NOT_FOUND`），只为给出明确的错误；其他组织的模板与不存在的一样 404。
  - 系统模板只由迁移角色写入：表属主在 `FORCE ROW LEVEL SECURITY` 下同样受策略约束，它在本表上只有一条策略 `USING (org_id IS NULL) WITH CHECK (org_id IS NULL)`，看不到也写不了任何组织的模板。
- **系统模板同步**（`src/templates/system.ts`）：定义在 `src/templates/systemTemplates.ts`，内容与桌面版 `client/electron/services/systemExportTemplates.cjs` 生成的配置逐字段相同（单元测试 `tests/templates/systemTemplates.test.ts` 直接加载桌面版文件核对，改预设样式时两边同步），`key` 取桌面版 `template_id` 去掉 `tpl-system-` 前缀。`npm run db:migrate`（镜像中 `node dist/db/migrate.js latest`，即 `docker-compose.yml` 的 migrate 服务）迁移到最新后幂等同步：存在则整份覆盖（id 不变），不存在则插入，定义中没有的旧系统模板删除，输出一行 `system export templates synced`。与桌面版“每次启动同步”相同，改预设样式不需要写迁移；api 进程没有写系统模板的权限，所以改在迁移命令中执行。
- **接口**（`src/routes/templates.ts`、`src/templates/store.ts`）：`GET /api/export-templates`（系统模板在前按定义顺序，组织模板按最近修改，返回完整配置，每组织最多 100 个所以不分页）、`POST /api/export-templates`、`GET/PUT/DELETE /api/export-templates/:templateId`、`POST /api/export-templates/:templateId/duplicate`，对应桌面版 `templates.list/get/create/update/delete/duplicate`。请求体 `{ config }`，拒绝未声明字段；名称取自 `config.template_name`，NFC 归一化、去掉 Unicode Cc / Cf 字符和首尾空白（与项目名称相同），为空时用“未命名模板”，超过 200 字返回 `400 TEMPLATE_INVALID`，并写回 `config`。`PUT` 整份替换配置（与桌面版相同）。复制任意可见模板（含系统模板）为本组织模板，名称加“ 副本”，超长时截短原名称。配置只要求是对象，深度 ≤ 32、序列化后 ≤ 64 KiB，含 `\u0000` 等 `jsonb` 不接受的字符时返回 `400 TEMPLATE_INVALID`；内容的归一化仍由前端完成。响应带 `cache-control: no-store`。
- **重构**：组织设置中检查 JSON 对象深度和大小的代码抽到 `src/jsonObject.ts`，设置和模板共用，行为不变（`settings.test.ts` 全部通过）。
- **隔离测试**：`describeProjectTable` 新增 `systemRows`（组织级表中 `org_id` 为空、所有组织只读的系统行）：检查 `org_id` 可空；系统行两个组织都能读、未设置上下文时读不到；应用角色改不到、删不到系统行，不能新写系统行，也不能把本组织的行改成系统行；声明的维护角色只看得到、只改得到系统行。`export_templates` 调用一次；另测了同步、约束、上限和接口。分别去掉 SELECT 策略的上下文条件、放开 UPDATE / DELETE / INSERT 策略到系统模板、放开迁移角色的策略、去掉数量上限，各有 2、3、8、1、2、1 个用例失败。

与路线图、设计的偏离：

- 设计第 2.4 节的“每张业务表都加 `org_id NOT NULL`”对系统模板不成立，拆分计划和设计第 2.3 节已写明系统模板 `org_id` 为空；本 PR 是唯一的例外，`describeProjectTable` 按上面的方式扩展，没有另写模板；
- 桌面版的 `is_system` 列由 `org_id IS NULL` 表示，另加 `system_key` 作稳定标识；桌面版文本 id `tpl-*` 改为 UUID（不做 `app.sqlite` 导入，第 9 节第 18 项）；
- 系统模板的内容在服务端另存一份（`systemTemplates.ts`），由测试核对与桌面版一致；同步放在迁移命令中而不是 api 启动时，理由见上；
- 新增每组织 100 个模板的上限（拆分计划未列出），避免单个组织无限写入大配置；
- 技术方案生成设置引用模板（`export_template_id`）随 5.11：组织模板可用复合外键 `(org_id, export_template_id)`，系统模板 `org_id` 为空不能这样引用，届时另行设计（例如单列外键加 RLS，或分两列）。

#### 资信库（#11，5.5）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。

- **迁移 `0011_credential_library`**：取代桌面版 SQLite 的 `credential_library_*` 六张表，全部是组织级表（组织内共享，第 9 节第 2 项）。
  - `credential_library_profile`：每个组织一行（主键 `org_id`，取代桌面版的 `id = 1`），企业基础信息、介绍、财务、开户行和水印配置，`updated_by`、`timestamptz` 时间；不授予 DELETE。
  - `credential_library_certificates`、`_employees`、`_projects`、`_other_materials`：主键改为 UUID（取代桌面版的 `cert-*` 等文本 id），`created_by` / `updated_by`，`UNIQUE (org_id, id)` 供图片的复合外键引用；与桌面版相同物理删除。
  - 文本列一律 `NOT NULL DEFAULT ''`，单行字段不超过 500 字、介绍 / 经营范围 / 备注不超过 20000 字（CHECK）；`validity_mode`、`id_validity_mode`、`project_type` 用 CHECK 限定为桌面版 Renderer 类型中的取值。
  - `credential_library_images`：`relative_path` 改为 `file_id`，复合外键 `(org_id, file_id) → files` 级联删除（文件被清理任务物理删除时图片行随之删除；图片行不引用对象存储，没有孤儿对象），每个文件只能挂一次（`UNIQUE (file_id)`）。桌面版的多态 `owner_type` / `owner_id` 拆成 `certificate_id`、`employee_id`、`credential_project_id`、`material_id` 四个可空列，各自以复合外键指向本组织的记录、随记录级联删除；CHECK 约束 `credential_library_images_owner_shape` 绑定归属类型、哪一列有值和允许的图片栏目（与桌面版 `importImageFieldKeys` 相同）。`original_name` 不再单独存，取 `files.display_name`。
  - 每个组织每类记录最多 1000 条、图片最多 5000 张（触发器 `credential_library_guard`，`CL001` → `409 CREDENTIAL_LIMIT_REACHED`，同一组织同一张表的插入用 advisory lock 串行）。
- **权限与删除可见性由 RLS 强制**，应用代码不判断：
  - 六张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；`created_by` / `updated_by` 必须是当前用户；`org_id`、`created_by`、图片的归属列和 `file_id` 没有列级 UPDATE 授权，写入后不能改挂。组织内成员都可以编辑。
  - 图片的 INSERT 策略要求所挂文件在应用角色下可见（本组织）、已上传、未删除、用途是 `credential-image`、不属于任何项目；其他组织的、上传中的、已删除的、其他用途的、挂在项目下的文件都被拒绝（→ `400 CREDENTIAL_IMAGE_UNAVAILABLE`）。
  - **图片随文件的生命周期**：所引用的文件已删除（进入回收站）时，图片查不到、改不了，包括不带条件的全表查询；恢复文件（`POST /api/files/:fileId/restore`）即一起恢复。应用角色没有图片的 DELETE 授权：删除图片就是软删除它的文件；删除记录时 Store 先软删除其图片的文件、再物理删除记录（图片行由外键级联删除），文件按自己的 7 天恢复期处理。
  - 隔离测试：六张表各调用一次 `describeProjectTable`（`scope: 'org'`）；另测了上面的规则。分别去掉 SELECT 策略的文件条件、INSERT 策略的用途与项目条件、INSERT 策略的文件条件、记录 INSERT / UPDATE 策略的当前用户条件、给图片授予 DELETE、去掉数量上限、去掉归属 CHECK，各有 3、2、2、1、1、4、1、1 个用例失败。去掉图片 UPDATE 策略的文件条件没有用例失败：UPDATE 同样受 SELECT 策略约束，该条件是双重保险。
- **接口**（`src/routes/credentialLibrary.ts`、`src/credentialLibrary/store.ts`）：`GET /api/credential-library`（完整快照）、`PATCH .../profile`（按 patch 保存）、`POST .../profile/images`（`{ fieldKey, images: [{ fileId, customName? }] }`）、`DELETE .../images/:imageId`、`POST .../{certificates|employees|projects|other-materials}`、`PUT/DELETE .../{类型}/:recordId`，对应桌面版 `load`、`saveProfile`、`addProfileImages`、`deleteImage` 和四类记录的 `save*` / `delete*`。`PUT` 与桌面版 `saveRecord` 相同整份保存（未给出的字段存为空字符串），并在同一事务中提交 `newImages`、`removedImageIds`、`imageNameUpdates`；只处理属于这条记录的图片 id，其他的忽略。每次修改后在同一事务中重新读取完整快照返回。请求体拒绝未声明字段；含 `\u0000` 时返回 `400 CREDENTIAL_INVALID`。其他组织的 id 与不存在的一样 404（`CREDENTIAL_RECORD_NOT_FOUND` / `CREDENTIAL_IMAGE_NOT_FOUND`）。响应带 `cache-control: no-store`。图片内容经 `GET /api/files/:fileId/content` 读取。

与路线图、设计的偏离：

- 接口字段与桌面版 Renderer 的差异：记录统一用 `id`（不再是 `certificateId` / `employeeId` / `projectId` / `materialId`），图片返回 `fileId`（不再是 `relativePath` / `assetUrl`），修改记录不再返回 `fileDeleteFailures`（文件删除与数据库在同一事务中完成）；前端接入时由第 9 步的 bridge 适配；
- 删除图片改为软删除文件、可从文件回收站恢复，桌面版是立即删除原图；
- 新增每组织的记录数、图片数上限（拆分计划未列出），理由同 5.4：快照接口一次返回全部内容，避免单个组织无限写入；
- 身份证号、银行账号等敏感字段按原样明文存储，加密或脱敏随第 9 节合规事项“个人信息出境”（上线前必须完成）一并决定；
- `importTestData`（开发者功能）按拆分计划不迁移。

#### 知识库（一）（#12，5.6）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。

- **迁移 `0012_knowledge_base`**：取代桌面版 SQLite 的 `knowledge_folders`、`knowledge_documents`、`knowledge_document_steps`，全部是组织级表（组织内共享，第 9 节第 2 项）。其余七张表随 5.7（已由 #14 补上，见下节）。
  - `knowledge_folders`：主键改为 UUID（取代桌面版的 `folder-*`），名称 1~200 字、首尾无空白，`sort_order`，`created_by` / `updated_by`，`UNIQUE (org_id, id)` 供文档的复合外键引用；与桌面版相同物理删除，其中的文档行由外键级联删除。
  - `knowledge_documents`：`document_dir`、`source_path` 改为 `file_id`，复合外键 `(org_id, file_id) → files` 级联删除（原件被清理任务物理删除时文档行随之删除），每个文件只能挂一次（`UNIQUE (file_id)`）；`markdown_path` 改为 `markdown_artifact_id`，复合外键指向 `artifacts`，产物被清理任务删除时只清空这一列（PostgreSQL 15 起的列级 `ON DELETE SET NULL (markdown_artifact_id)`）。`file_name`、`source_extension` 不再单独存，取 `files.display_name` / `extension`；`markdown_hash`、`markdown_chars` 删去（桌面版只在 Store 内部使用，产物自带 `sha256` 和大小）。状态、步骤键、步骤状态的取值与桌面版相同（CHECK）；进度 0~100，计数非负，进度说明 ≤ 2000 字、错误信息 ≤ 20000 字。
  - `knowledge_document_steps`：主键 `(document_id, step_key)`，复合外键 `(org_id, document_id)` 随文档级联删除；`result_json` 改为 `jsonb` 对象（≤ 16 MiB）；状态与开始 / 完成时间、错误信息的组合由 CHECK 约束 `knowledge_document_steps_status_shape` 绑定，与桌面版 `saveDocumentStep` 的规则相同。
  - 每个组织最多 500 个文件夹、10000 个文档（触发器 `knowledge_base_guard`，`KB001` → `409 KNOWLEDGE_LIMIT_REACHED`，同一组织同一张表的插入用 advisory lock 串行）。
- **权限与删除可见性由 RLS 强制**，应用代码不判断：
  - 三张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；文件夹的 `created_by` / `updated_by`、文档的 `created_by` 必须是当前用户；`org_id`、`created_by`、文档的 `file_id` 没有列级 UPDATE 授权，写入后不能改挂；文档的文件夹由复合外键保证属于本组织。组织内成员都可以编辑。
  - 文档的 INSERT 策略要求所挂文件在应用角色下可见（本组织）、已上传、未删除、用途是 `knowledge`、不属于任何项目；`status` 没有 INSERT 授权，新文档一律是 `pending`（解析在第 6 步）。
  - `markdown_artifact_id` 只能指向本组织已写完、种类为 `markdown`、来源文件就是本文档原件的产物（UPDATE 策略）。
  - **文档随原件的生命周期**：原件已删除（进入回收站）时，文档和它的步骤查不到、改不了，也不能新写步骤，包括不带条件的全表查询；恢复文件（`POST /api/files/:fileId/restore`）即一起恢复。应用角色没有文档的 DELETE 授权：删除文档就是软删除原件；删除文件夹时 Store 先软删除其中文档的原件、再物理删除文件夹（文档行由外键级联删除），原件按自己的 7 天恢复期处理。步骤随文档可见（策略以文档在应用角色下可见为条件）。
  - 隔离测试：三张表各调用一次 `describeProjectTable`（`scope: 'org'`）；另测了上面的规则。分别去掉文档 SELECT 策略的文件条件、INSERT 策略的用途与项目条件、INSERT 策略的文件条件、UPDATE 策略的 Markdown 条件、步骤 SELECT / INSERT 策略的文档条件、文件夹 / 文档 INSERT 策略的当前用户条件，给文档授予 DELETE、给 `status` 授予 INSERT，去掉数量上限、步骤状态 CHECK 的 running 分支，把产物外键改为级联删除，各有 4、3、3、2、1、1、1、1、1、1、1、1、1 个用例失败。
- **接口**（`src/routes/knowledgeBase.ts`、`src/knowledgeBase/store.ts`）：`GET /api/knowledge-base`（文件夹与文档的完整列表，顺序与桌面版 `list` 相同）、`POST .../folders`、`PATCH/DELETE .../folders/:folderId`、`POST .../folders/:folderId/reorder`（`{ targetFolderId, position }`）、`POST .../folders/:folderId/documents`（`{ fileIds }`，一次最多 50 个，取代桌面版 `uploadDocuments` 的“选文件并复制”）、`POST .../documents/:documentId/move`（`{ targetFolderId, targetDocumentId?, position? }`）、`DELETE .../documents/:documentId`，对应桌面版 `list`、`createFolder`、`renameFolder`、`reorderFolder`、`deleteFolder`、`uploadDocuments`、`moveDocument`、`deleteDocument`。文件夹名称做 NFC 归一化、去掉 Unicode Cc / Cf 字符和首尾空白（与项目名称相同），为空时用“未命名”（与桌面版相同），超过 200 字返回 `400 KNOWLEDGE_INVALID`。排序与桌面版相同：新建的排在末尾，拖动时整组重排 `sort_order`，跨文件夹移动时原文件夹重新编号；同一组织的排序类操作用事务级 advisory lock 串行。其他组织的 id 与不存在的一样 404（`KNOWLEDGE_FOLDER_NOT_FOUND` / `KNOWLEDGE_DOCUMENT_NOT_FOUND`），文件不可用 `400 KNOWLEDGE_FILE_UNAVAILABLE`。响应带 `cache-control: no-store`。
- **给第 6 步解析任务用的 Store 函数**（已直接测试）：`updateDocumentState`（只写给出的字段，进度取整并限制在 0~100，文本去掉 `\u0000`、超长时截短）、`setDocumentMarkdown`（产物不合规时抛 `TypeError`）、`saveDocumentStep` / `listDocumentSteps`（时间与错误的规则与桌面版相同）、`clearDocumentProcessingFromStep`（删除该步及之后的步骤，按起始步骤清除 Markdown 引用、解析器标签和计数；切块、条目等表的清除随 5.7 加入，已由 #14 补上）。

与路线图、设计的偏离：

- 接口字段与桌面版 Renderer 的差异：响应改为 camelCase（`folderId`、`fileName`、`sortOrder` 等，与服务端其他接口一致），文档另返回 `fileId`、`markdownArtifactId`，不再有 `document_dir` 等路径；`uploadDocuments` 改为挂已上传的文件；`reorderFolder` 返回重排后的文件夹，`deleteFolder` 返回删除的文档数；前端接入时由第 9 步的 bridge 适配；
- 删除文档改为软删除原件、可从文件回收站恢复，桌面版是立即删除目录；删除文件夹后，其中文档的原件仍可从回收站恢复，但文档行已随文件夹删除，恢复的只是文件；
- 移动文档不再要求文档先处理完：桌面版的限制是因为移动要重命名本地文档目录，Web 版只改一列。桌面版“处理中不能删除”的限制由第 6 步处理（任务发现文档不可见即停止，写入影响 0 行）；
- 新增每组织的文件夹数、文档数上限（拆分计划未列出），理由同 5.4、5.5：列表接口一次返回全部内容；
- `recoverInterruptedDocuments`（启动时把中断的文档标为失败）不迁移，由第 6 步的任务队列负责中断恢复。

#### 知识库（二）（#14，5.7）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。

- **迁移 `0013_knowledge_base_items`**：取代桌面版 SQLite 的 `knowledge_blocks`、`_candidate_items`、`_items`、`_item_blocks`、`_discarded_groups`、`_reports`、`_match_batches`，全部是组织级表，以复合外键 `(org_id, document_id) → knowledge_documents` 挂在文档下、随文档级联删除（删除文件夹、清理任务物理删除原件时一并删除）。
  - 字段与桌面版相同，主键改为 UUID（块、候选条目、最终条目、舍弃块组）或沿用桌面版的复合主键（来源块、报告、匹配批次）；`heading_path_json`、`block_ids_json`、`item_ids_json`、`matches_json` 改为 `jsonb`（类型由 CHECK 约束限定，≤ 64 KiB / 16 MiB），时间改为 `timestamptz`；块的 `is_filtered` 改为 `boolean`，筛除原因只属于筛除块（CHECK）。
  - 块 id、条目 id、块类型、候选条目来源 1~64 字，标题 ≤ 2000 字，摘要 ≤ 20000 字，块与条目正文 ≤ 1000 万字，报告的覆盖率、匹配率在 0~1000 之间（同时挡住 `NaN` 和 `Infinity`）；舍弃块组的来源只能是 `ai` / `system`；匹配批次的状态与开始 / 完成时间、错误信息的组合与 `knowledge_document_steps` 相同（CHECK）。
  - 来源块以复合外键 `(org_id, document_id, item_id)` 指向本文档的条目、随条目删除（桌面版没有这条外键）；`block_id` 与桌面版相同不设外键。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：
  - 七张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；策略另以文档在应用角色下可见为条件，所以原件已删除（进入回收站）时七张表的行查不到、改不了、删不掉，也不能新写，包括不带条件的全表查询；恢复文件即一起恢复。
  - 写法与桌面版相同“整体替换”：块、候选条目、最终条目、来源块、舍弃块组、报告只授予 SELECT、INSERT、DELETE，不授予 UPDATE；只有匹配批次按批更新状态（列级 UPDATE 授权，`org_id`、`document_id`、`batch_index` 写入后不能改，`updated_at` 由 `app_touch_updated_at()` 维护）。
  - 隔离测试：七张表各调用一次 `describeProjectTable`（`scope: 'org'`）；另测了上面的规则。分别去掉 SELECT、INSERT、DELETE、UPDATE 策略的文档条件，给替换表授予 UPDATE，去掉来源块的条目外键、筛除原因 CHECK、文档外键的级联，`clearDocumentProcessingFromStep` 不删切块、不删最终结果，检索不限已完成的文档，各有 1、1、1、1、25、3、1、1、1、1、1 个用例失败。
- **接口**（`src/routes/knowledgeBase.ts`、`src/knowledgeBase/content.ts`）：`GET /api/knowledge-base/search?keyword=&page=`、`GET .../documents/:documentId/items`、`GET .../documents/:documentId/analysis`、`GET .../documents/:documentId/markdown`，对应桌面版 `search`、`readItems`、`readAnalysis`、`readMarkdown`。
  - 检索与桌面版相同：只检索已处理完成（`success`）的文档的最终条目，文件名、标题、摘要、正文不区分大小写包含关键词即命中（关键词作为参数传给 `strpos`，`%` / `_` 按字面匹配），按命中字段（标题 → 摘要 → 正文 → 文件名）、文档最近更新、条目顺序排序，每页 100 条，页码超出时取最后一页，摘录 180 字；正文命中时只从数据库取命中位置前后各 1000 字生成摘录。关键词去掉首尾空白后不超过 200 字（`400 KNOWLEDGE_INVALID`）。
  - Markdown 与 `/api/artifacts/:artifactId/content` 相同流式转发、一律附件、`nosniff`、`sandbox` CSP；还没有解析出 Markdown 时与桌面版相同返回空内容。分析快照的 Markdown 字数（去掉空白后的字数，与桌面版相同按 UTF-16 码元计）流式读取对象存储统计，不整体读入内存；文档有 Markdown 但未配置对象存储时 `503 FILE_STORAGE_DISABLED`。
  - 其他组织的、原件已删除的文档一律 `404 KNOWLEDGE_DOCUMENT_NOT_FOUND`。响应带 `cache-control: no-store`。
- **给第 6 步解析任务用的 Store 函数**（已直接测试）：`saveBlocks` / `readBlocks`、`saveCandidateItems` / `readCandidateItems`、`saveMatchResult`（同一事务整体替换候选条目、最终条目及来源块、舍弃块组和报告，并写入文档计数）、`readItems`、`saveMatchBatch` / `getMatchBatch` / `readMatchBatches` / `clearMatchBatches`（时间与错误的规则与桌面版相同）。默认 id（`P000001` / `F000001`）、跳过没有 id 的条目、计数按传入条数等细节与桌面版相同；id 为空、超长或重复，正文超长是调用方的程序错误，抛 `TypeError`；AI 生成的标题、摘要、原因超长时截短，所有文本和 JSON 去掉 `jsonb` / `text` 不接受的 `\u0000`；行数多时分批插入。`clearDocumentProcessingFromStep`（5.6）按起始步骤一并清除切块、候选条目、匹配批次和最终结果。
- **隔离模板扩展**：`describeProjectTable` 的 `update` 改为可选：不授予 UPDATE 的表省略它，模板改为检查应用角色对该表没有任何 UPDATE 权限、各用例中的更新一律被拒绝。

与路线图、设计的偏离：

- 接口字段与桌面版 Renderer 的差异：响应改为 camelCase（`documentId`、`matchField`、`sourceBlockIds`、`coverageRateVsMarkdown` 等）；`readMarkdown` 改为下载 Markdown 原文（bridge 用 `fetch().text()`）；分析快照不再有开发者模式的 `debug_log_path`（Web 版没有本地调试日志）；前端接入时由第 9 步的 bridge 适配；
- 桌面版的 `readReferences` / `getOutlineReferences` 给技术方案生成用，随 5.11（`_generation_reference_docs`）迁移；
- 新增来源块指向条目的外键和各列的长度上限（桌面版没有），没有新增每文档的行数上限：行数由解析任务按原件（≤ 100 MiB）生成，不经用户接口写入；
- 检索按行扫描本组织已完成文档的条目，与桌面版相同；数据量增长后再考虑 `pg_trgm` 索引或全文检索；
- 本地验证用的是 PostgreSQL 16（开发容器无法拉取 17 的镜像），CI 用 17；迁移只用到 15 起的特性。

#### 标书查重（#16，5.8）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。

- **迁移 `0014_duplicate_check`**：取代桌面版 SQLite 的 `duplicate_check_*` 十三张表（`_tasks` 按拆分计划不迁移），全部是项目级表，挂在 `kind = 'duplicate-check'` 的项目下（取代桌面版的单例 `id = 1`），照 `exampleProjectTable` 模板写：`org_id`、`project_id` 不可空，复合外键 `(org_id, project_id) → projects` 级联，`timestamptz` / `jsonb`，索引以 `org_id, project_id` 开头。
  - `duplicate_check_meta`：每个项目一行（主键 `project_id`），步骤与分析页签；不授予 DELETE，清空时恢复默认值。桌面版的 `current_signature` 不再存：文件选择的签名按当前可见的文件（id、大小、上传完成时间）现算，接口返回 `signature`。
  - `duplicate_check_files`：`file_path` 改为 `file_id`（复合外键指向 `files`，原件被清理任务物理删除时级联），文件名、扩展名、大小取 `files`；每个文件只能被选一次。分析结果中引用文件的八张表以复合外键 `(org_id, project_id, file_id) → duplicate_check_files` 随文件行级联删除（两两相似度两列都引用）。
  - 正文提取的 `content_path` 改为 `content_artifact_id`、重复图片的 `preview_url` 改为 `preview_artifact_id`（生成产物，被清理时列级 `SET NULL`）；`*_json` 列改为 `jsonb`（顶层类型与大小由 CHECK 限定），布尔列改为 `boolean`；状态、目录来源、组类型、风险等级的取值与桌面版 Renderer 类型相同（CHECK），相似度、置信度在 0~1000 之间（挡住 `NaN` / `Infinity`），各文本列有长度上限。
  - 目录项的 `file_id::item_id` 拼接 id 改为 `(project_id, file_id, item_id)` 唯一，父目录项由复合外键指向同一文件的目录项，`DEFERRABLE INITIALLY DEFERRED`（同一次整体替换中子项可以先于父项写入，包括跨批插入）。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：
  - 十三张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；条件另含“不存在同 id 的已删除或其他 kind 的项目”，所以项目软删除后十三张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；其他 kind 的项目下写不进任何一张表。跨组织的 `project_id` 仍由复合外键报错（与 `artifacts` 相同的写法）。
  - **选中的文件随原件的生命周期**：原件已删除（进入回收站）、未上传完成或已不属于本项目时，文件行和引用它的八张结果表的行都不可见，恢复文件即一起恢复；与文件无关的结果（分析状态、目录组、重复句、重复图片）不受影响。INSERT 策略只允许选本组织已上传、未删除、用途是 `duplicate-check`、已挂到本项目（`files.project_id`）的文件。
  - 正文产物只能是本组织已写完、来源文件就是该文件的 Markdown；预览图只能是本组织已写完、属于本项目的图片（INSERT 策略）。
  - 写法与桌面版相同“整体替换”：十张结果表只授予 SELECT、INSERT、DELETE；页面状态、分析状态按列更新，文件行只能改 `content_hash`；`org_id`、`project_id`、`file_id`、`section` 等没有列级 UPDATE 授权。
  - 隔离测试：十三张表各调用一次 `describeProjectTable`（`projectKind: 'duplicate-check'`；引用选中文件的八张表 `onProjectDelete: 'restrict'`，因为项目被 `files.project_id` 挡住，要先由清理任务删除文件）；另测了上面的规则。分别去掉项目条件中的已删除判断、kind 判断，文件行的原件条件、INSERT 的用途条件，结果表的文件条件，正文产物、预览图条件，给结果表授予 UPDATE、给页面状态授予 DELETE，去掉父目录项外键的延迟检查，各有 1、1、1、1、4、1、1、51、1、1 个用例失败。
- **接口**（`src/routes/duplicateCheck.ts`、`src/duplicateCheck/store.ts`），先经 `requireProject(..., 'duplicate-check')`：`GET /api/projects/:projectId/duplicate-check`（完整状态，任务状态 `analysisTask` 先返回 `null`）、`PUT .../files`（`{ tenderFileIds, bidFileIds, step?, activeAnalysisTab? }`，招标文件最多 20 个、投标文件最多 50 个）、`PATCH .../ui-state`、`DELETE`（清空）、`GET .../export`，对应桌面版 `loadState`、`saveFiles`（取代 `selectDuplicateCheckFiles`）、`saveUiState`、`clear`、`exportExcel`。
  - 选择文件与桌面版相同整体替换并清空全部分析结果；文件挂到本项目（只挂还不属于任何项目或已属于本项目的文件），从选择中去掉的文件和清空时的全部文件软删除（进回收站，按文件自己的 7 天恢复期处理）。文件不可用时整体失败，`400 DUPLICATE_CHECK_FILE_UNAVAILABLE`。同一项目的选择、清空和任务写入用事务级 advisory lock 串行。
  - 导出与桌面版相同：六个工作表、列和文案不变，只导出签名与当前文件选择一致的结果（其余标“结果已失效”），没有可导出的当前结果时 `409 DUPLICATE_CHECK_NOTHING_TO_EXPORT`。服务端同步生成 xlsx，附件下载（`nosniff`、`sandbox` CSP、`no-store`），文件名 `标书查重结果_YYYYMMDD_HHMMSS.xlsx`。
  - 其他组织的、已删除的、kind 不符的项目一律 `404 PROJECT_NOT_FOUND`。响应带 `cache-control: no-store`。
- **给第 6 步查重任务用的 Store 函数**（已直接测试）：`saveAnalysisSection(section, analysis | null)`，取代桌面版 `updateState` 中的四类分析：状态、进度、说明、签名、开始时间只写给出的字段，统计按字段合并，结果字段（`files`、`contentFiles`、`duplicateGroups`、`pairwiseSimilarities`、`duplicateSentences`、`duplicateImages`）给出时整体替换，`null` 删除这一类；元数据对比表、目录项所在的组由读出时现算（与桌面版相同）。默认 id（`C000001` / `I000001`）、跳过没有 id 的条目等细节与桌面版相同；id 为空、超长或重复、父目录项不存在是调用方的程序错误，抛 `TypeError`；说明、错误等文本超长时截短，去掉 `\u0000`；行数多时分批插入。引用未选中文件的写入被 RLS 拒绝（文件选择已变化时任务的写入整体失败）。
- **xlsx 写出器**（`src/xlsx/writer.ts`）：桌面版用 SheetJS，npm 上的 `xlsx` 0.18.5 有未修复的 high 漏洞，新版只在 SheetJS 自己的 CDN 发布，所以不引入依赖，用 Node 自带的 zlib 写出最小的 xlsx（内联字符串、数字、百分比格式、列宽、表头筛选、标题与创建时间）。文本一律写成内联字符串，不会被当作公式求值；控制字符去掉、超长截断（与桌面版相同）。单元测试解包核对结构和 CRC，本地另用 openpyxl 和 LibreOffice 打开验证过。5.9 废标检查的导出复用它。
- **隔离模板扩展**：`describeProjectTable` 新增 `projectKind`：模板建的项目改为这种 kind（策略只允许某一种项目的表用）。

与路线图、设计的偏离：

- 接口字段与桌面版 Renderer 的差异：响应改为 camelCase（`fileId`、`fileName`、`duplicateFileIds`、`contentArtifactId` 等，与服务端其他接口一致）；文件不再有 `file_path`、`modified_at`，改为 `id`（`files.id`）、`uploadedAt`；不再有单独的 `tenderFile`（取 `tenderFiles[0]`）；正文与预览图改为产物 id，经 `/api/artifacts/:artifactId/content` 读取；前端接入时由第 9 步的 bridge 适配；
- 拆分计划列出的 `updateState` 只给任务用（Renderer 不调用，桌面版由 Main 的任务服务写入），实现为 Store 函数 `saveAnalysisSection`，不开放为接口：分析结果不应由客户端写入；
- 导出不再接收客户端传来的 `signature`，由服务端按当前文件选择现算；导出时间与文件名按北京时间（桌面版用本机时区）；
- 从选择中去掉的文件、清空时的文件改为软删除（桌面版只是不再引用本地文件）：Web 版的原件由服务端保存、计入配额，不删除会一直占用；
- 新增招标文件 20 个、投标文件 50 个的上限（桌面版没有），避免两两相似度等结果无限增长；
- `files.project_id` 的改挂仍由 `files` 的既有策略（0008）决定，应用角色可以改；“只挂还不属于任何项目的文件”是 Store 的条件，不在本 PR 修改已有的 `files` 策略。组织内成员本来就能编辑所有项目，这只关系到数据一致性，不涉及越权；如需由数据库强制，另开 PR 修改 `files` 的 UPDATE 策略；（已由 #17 改为数据库强制，见下节）
- 用自写的 xlsx 写出器代替 SheetJS，理由见上；
- 本地验证用的是 PostgreSQL 16，CI 用 17；`tests/db/files.test.ts` 需要 S3 兼容服务，本地无法启动，只在 CI 中运行（本 PR 未改动文件存储）。

#### 文件归属不可改与导出防公式注入（#17，5.8 后续）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色。修改已有表规则（`files` 新增触发器），按 CLAUDE.md 等用户确认后合并。

- **迁移 `0015_files_project_immutable`**：触发器 `files_project_guard`（`BEFORE UPDATE OF project_id ON files`）：`project_id` 只能从空设为某个项目，设置后改成别的项目或改回空一律拒绝（`FS005`）；写入同一个值不算修改。已有的 `files` 策略和 `files_guard` 都不改动。
  - **为什么用触发器而不是改 RLS**：UPDATE 策略的 `WITH CHECK` 只能看到新行、看不到旧值，表达不了“设置后不能再改”；`USING` 只能看旧行，两者都无法比较新旧值。收回 `project_id` 的列级 UPDATE 授权又会挡住“从空设为项目”（标书查重挂文件靠它）。触发器能比较新旧值，对所有角色生效（包括绕过 RLS 的超级用户和以后的清理任务），一处定义，不依赖应用代码。
  - 标书查重 `saveFiles` 去掉了 Store 中“只挂不属于其他项目的文件”的条件，改由触发器拒绝（`FS005` → `400 DUPLICATE_CHECK_FILE_UNAVAILABLE`），这条规则只在数据库中成立。
  - 隔离模板“改挂 project_id 被拒绝”的用例对 `files` 改为同时接受触发器的错误（触发器先于外键执行）。
  - 测试：应用角色从空设为项目允许、写同一个值允许、改成别的项目或改回空拒绝；超级用户同样被拒绝；其他列（软删除）照常可改。让触发器不生效时有 2 个用例失败。
- **xlsx 写出器防公式注入**（`src/xlsx/writer.ts`）：核对结果：
  - 文本一律写成内联字符串（`t="inlineStr"`），从不写 `<f>`，打开文件时不会被当作公式求值（5.8 已是如此）；
  - **新增**：以 `=`、`+`、`-`、`@`、制表符、回车开头的文本另外套用 `quotePrefix` 样式（相当于在 Excel 中输入前导单引号），用户双击编辑后回车也仍是文本；
  - **修复**：回车原来直接写进 XML，会被 XML 解析器规范化为换行，现在写成 `&#13;`，原样保留；
  - 控制字符（U+0000~U+0008、U+000B、U+000C、U+000E~U+001F）和 U+FFFE / U+FFFF 去掉，不成对的代理项替换为 U+FFFD，`& < > "` 转义（5.8 已是如此，补了测试）；工作表名称和标题同样转义。
  - 测试：危险前缀与安全前缀（含全角符号、前导空格、换行开头）各一组、转义与控制字符、代理项；本地另用 openpyxl（单元格类型为文本、`quotePrefix` 为真）和 LibreOffice（转 CSV 后 `=1+1`、`-3+1` 原样保留，回车保留）验证。去掉 `quotePrefix`、去掉回车转义，分别有 2、1 个用例失败。

与路线图的偏离：无（落实 #16 中记录的后续事项）。

#### 废标检查（#18，5.9）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色，没有修改已有表的策略。

- **迁移 `0016_rejection_check`**：取代桌面版 SQLite 的 `rejection_check_*` 七张表（`_tasks` 按拆分计划不迁移），全部是项目级表，挂在 `kind = 'rejection-check'` 的项目下（取代桌面版的单例 `id = 1`），照 `exampleProjectTable` 模板写：`org_id`、`project_id` 不可空，复合外键 `(org_id, project_id) → projects` 级联，`timestamptz`，索引以 `org_id, project_id` 开头。
  - `rejection_check_meta`：每个项目一行（主键 `project_id`），步骤、当前文档 / 结果页签、自定义检查项（≤ 10 万字）、检查选项（`check_options_json` 改为 `typo_check`、`logic_check` 两个布尔列，废标项检查始终开启）；不授予 DELETE，清空时恢复默认值。
  - `rejection_check_documents`：`document_id` / `markdown_path` 改为 `file_id`（复合外键指向 `files`，原件被清理任务物理删除时级联）与 `markdown_artifact_id`（生成产物，被清理时列级 `SET NULL`），文件名、扩展名、大小取 `files`；每个文件只能导入一次。新文档一律 `pending`（状态等解析结果没有 INSERT 授权），解析结果（状态、Markdown、字数、正文哈希、解析器、错误）由第 6 步的解析任务写入。桌面版合并的招标正文（`document_id = 'tender'`）不再存，由任务按招标文件的顺序合并。
  - `rejection_check_extraction`（每个项目一行）、`rejection_check_results`（每类检查一行）：取值与桌面版 Renderer 类型相同（CHECK），各文本列有长度上限。
  - 三张问题表：`bid_document_id` 以复合外键 `(org_id, project_id, bid_document_id) → rejection_check_documents` 随文档行级联删除，不可空（桌面版可空，读出时回退到第一份投标文件）；`(project_id, finding_id)` 唯一。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：
  - 七张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；条件另含“不存在同 id 的已删除或其他 kind 的项目”，项目软删除后七张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复。跨组织的 `project_id` 由复合外键报错。
  - **文档随原件的生命周期**：原件已删除（进入回收站）、未上传完成或已不属于本项目时，文档行和引用它的问题都不可见，恢复文件即一起恢复。应用角色没有文档的 DELETE 授权，移除文档就是软删除原件（与知识库文档相同）。INSERT 策略只允许导入本组织已上传、未删除、用途是 `tender`、已挂到本项目的文件。
  - `markdown_artifact_id` 只能是本组织已写完、来源文件就是该文档原件的 Markdown 产物（UPDATE 策略）；问题只能指向本项目的投标文件（INSERT 策略要求文档可见且 `role = 'bid'`）。
  - 问题表只授予 SELECT、INSERT、DELETE（整体替换、用户删除单条）；`org_id`、`project_id`、`file_id`、`role`、`sort_order`、`result_type` 没有列级 UPDATE 授权。
  - 隔离测试：七张表各调用一次 `describeProjectTable`（`projectKind: 'rejection-check'`；文档与三张问题表 `onProjectDelete: 'restrict'`）；另测了上面的规则。分别去掉项目条件中的已删除判断、kind 判断，文档的原件条件、INSERT 的用途条件，Markdown 产物条件、问题的投标文件条件，给问题表授予 UPDATE、给文档授予 DELETE、给文档的状态授予 INSERT，各有 1、1、5、1、1、2、16、1、1 个用例失败。
- **接口**（`src/routes/rejectionCheck.ts`、`src/rejectionCheck/store.ts`），先经 `requireProject(..., 'rejection-check')`：`GET /api/projects/:projectId/rejection-check`（完整状态，任务状态 `extractionTask` / `checkTask` 先返回 `null`）、`POST .../documents`（`{ role, fileIds }`）、`DELETE .../documents/:fileId`、`PATCH .../ui-state`、`PATCH .../results/:resultType`（`{ activeFindingId }`）、`DELETE .../results/:resultType/findings/:findingId`、`DELETE`（清空）、`GET .../export`，对应桌面版 `loadState`、`importDocument`、`removeDocument`、`saveUiState`、`updateState`（Renderer 只用它切换当前问题和删除单条问题）、`clear`、`exportExcel`。
  - 导入：文件挂到本项目，按给出的顺序追加到同类文档之后，已导入到本项目的文件跳过（`skippedCount`）；文件不可用时整体失败，`400 REJECTION_CHECK_FILE_UNAVAILABLE`；每个项目最多 20 份招标文件、50 份投标文件（`400 REJECTION_CHECK_DOCUMENT_LIMIT`）。有新文档时与桌面版相同：招标文件清空解析结果和三类检查结果、页签回到合并的招标正文；投标文件清空三类检查结果、页签切到第一份新投标文件。
  - 移除：原件软删除；招标文件清空解析与检查结果，投标文件清空检查结果；页签与桌面版相同。先删结果再软删除原件（原件进回收站后引用它的问题不可见，删不到）。不存在的文档 `404 REJECTION_CHECK_DOCUMENT_NOT_FOUND`。
  - 删除单条问题的进度说明与桌面版 Renderer 相同（“保留 N 个需复核风险项”等）；不存在的问题 `404 REJECTION_CHECK_FINDING_NOT_FOUND`。
  - **签名由服务端现算**，状态返回 `signatures: { tender, bid, rejectionInput }`：招标文件、投标文件各自按顺序由文件 id 和正文哈希算出；废标项检查的输入另含当前有效的解析结果（其 `tenderSignature` 与当前招标签名一致时才计入，同桌面版 `visibleExtractionContent`）和自定义检查项。第 6 步的任务经导出的 `computeSignatures` 用同样的方式算出并写进结果。
  - 导出与桌面版相同：四个工作表、列和文案不变，只导出输入签名与当前一致的结果（其余标“结果已失效”），没有可导出的当前结果时 `409 REJECTION_CHECK_NOTHING_TO_EXPORT`。复用 `src/xlsx/writer.ts`（文本一律内联字符串，危险前缀另加 `quotePrefix`），附件下载（`nosniff`、`sandbox` CSP、`no-store`），文件名 `废标检查结果_YYYYMMDD_HHMMSS.xlsx`。导出时间的格式化从查重导出中抽到 `src/xlsx/displayTime.ts` 共用。
  - 同一项目的导入、移除、清空、问题操作和任务写入用事务级 advisory lock 串行。其他组织的、已删除的、kind 不符的项目一律 `404 PROJECT_NOT_FOUND`。响应带 `cache-control: no-store`。
- **给第 6 步任务用的 Store 函数**（已直接测试）：`saveDocumentParse`（只写给出的字段，文档已移除时返回 `false`）、`saveExtraction`（与桌面版相同整体写入，去掉外层 `'''`，`null` 删除）、`saveCheckResult`（状态等字段只写给出的，问题给出时整体替换，`null` 删除这一类）。默认问题 id（`rejection-finding-1` 等）、类型、等级、摘要取标题等细节与桌面版相同；问题 id 为空、超长或重复，投标文件 id 不是 uuid 是调用方的程序错误，抛 `TypeError`；文本超长时截短，去掉 `\u0000`；行数多时分批插入。指向招标文件或已移除的投标文件的写入被 RLS 拒绝，整体回滚。

与路线图、设计的偏离：

- 接口字段与桌面版 Renderer 的差异：文档不再带 `content`（正文），改为 `markdownArtifactId`，经 `/api/artifacts/:artifactId/content` 读取，另有解析状态 `status`、`contentChars` 等；不再有合并的 `tenderDocument`（由第 6 步的任务合并，前端按 `tenderDocuments` 显示）；文档不再有 `source`（来自技术方案的导入随 5.13 再定）；签名改由服务端返回，导出不再接收客户端传来的签名；时间为 `Date`（JSON 中是 ISO 字符串）；前端接入时由第 9 步的 bridge 适配；
- 拆分计划列出的 `updateState`：Renderer 的用法（切换当前问题、删除单条问题）拆成两个专门的接口，只能改这两项；任务写入的部分实现为 Store 函数，不开放为接口：解析与检查结果不应由客户端写入；
- 导入时不再按“文件名 + 正文哈希”去重（导入时尚未解析），改为同一文件只导入一次；移除文档、清空时原件软删除（与 5.8 相同理由：原件计入配额）；从回收站恢复原件时文档随之恢复，但已清空的结果不会恢复，签名随之变化，旧结果按失效处理；
- 新增招标文件 20 份、投标文件 50 份的上限（桌面版没有），与 5.8 相同；
- 本地验证用的是 PostgreSQL 16，CI 用 17；`tests/db/files.test.ts` 需要 S3 兼容服务，本地无法启动，只在 CI 中运行（本 PR 未改动文件存储）。

#### 可研报告（#19，5.10）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色，没有修改已有表的策略。

- **迁移 `0017_feasibility_report`**：取代桌面版 SQLite 的 `feasibility_report_meta`、`feasibility_report_outline_nodes`（`_tasks` 按拆分计划不迁移），全部是项目级表，挂在 `kind = 'feasibility-report'` 的项目下（取代桌面版的单例 `id = 1`），照 `exampleProjectTable` 模板写：`org_id`、`project_id` 不可空，复合外键 `(org_id, project_id) → projects` 级联，`timestamptz` / `jsonb`，索引以 `org_id, project_id` 开头。
  - `feasibility_report_meta`：每个项目一行（主键 `project_id`），步骤、项目信息（桌面版的 `project_info_json` 拆成十列，默认值与桌面版 `emptyProjectInfo` 相同）、资料分析与关键参数（≤ 100 万字）、目录模板、目标字数（1000~1000000）、目录的项目名称与概述；不授予 DELETE，清空时恢复默认值。
  - `feasibility_report_sources`：可研资料。桌面版存在 meta 的 `source_files_json`（本地 Markdown 路径），这里与 `rejection_check_documents` 相同拆成表：`file_id`（复合外键指向 `files`，原件被清理任务物理删除时级联）、`markdown_artifact_id`（生成产物，被清理时列级 `SET NULL`）、解析状态、字数、正文哈希、解析器、错误，文件名、扩展名、大小取 `files`。新资料一律 `pending`（状态等解析结果没有 INSERT 授权）。
  - `feasibility_report_reference_docs`：目录生成引用的知识库文档。桌面版存在 meta 的 `reference_document_ids_json`，这里拆成表，复合外键 `(org_id, document_id) → knowledge_documents` 级联删除；整体替换，不授予 UPDATE。
  - `feasibility_report_outline_nodes`：主键 `(project_id, node_id)`，节点 id 沿用桌面版 Renderer 重新编号后的 `1`、`1.2` 等文本（≤ 64 字）；父节点以复合外键指向同一项目的节点、随父节点级联删除，`DEFERRABLE INITIALLY DEFERRED`；层级 1~10 且与是否有父节点一致（CHECK）；标题 1~2000 字，说明 ≤ 2 万字，单章正文 ≤ 50 万字，`knowledge_item_ids` 为 `jsonb` 数组（≤ 64 KiB）。只授予 SELECT、INSERT、DELETE 和 `content` 列的 UPDATE。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：
  - 四张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；条件另含“不存在同 id 的已删除或其他 kind 的项目”，项目软删除后四张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复。跨组织的 `project_id` 由复合外键报错。
  - **资料随原件的生命周期**：原件已删除（进入回收站）、未上传完成或已不属于本项目时资料行不可见，恢复文件即一起恢复。应用角色没有资料的 DELETE 授权，移除资料就是软删除原件。INSERT 策略只允许登记本组织已上传、未删除、用途是 `tender`、已挂到本项目的文件；`markdown_artifact_id` 只能是本组织已写完、来源文件就是该资料原件的 Markdown 产物（UPDATE 策略）。
  - **引用随知识库文档的可见性**：所引用的文档在应用角色下不可见（原件进回收站）时引用行同样不可见，也不能新引用；其他组织的文档由复合外键和策略挡住。
  - 隔离测试：四张表各调用一次 `describeProjectTable`（`projectKind: 'feasibility-report'`；资料 `onProjectDelete: 'restrict'`）；另测了上面的规则。分别去掉项目条件中的已删除判断、kind 判断，资料的原件条件、INSERT 的用途条件，Markdown 产物条件，引用的文档条件，给引用授予 UPDATE、给资料授予 DELETE、给资料的状态授予 INSERT、给节点的标题授予 UPDATE，各有 1、1、7、1、2、2、6、1、1、1 个用例失败。
- **接口**（`src/routes/feasibilityReport.ts`、`src/feasibilityReport/store.ts`），先经 `requireProject(..., 'feasibility-report')`：`GET /api/projects/:projectId/feasibility-report`（完整状态，六个任务状态先返回 `null`）、`PATCH .../step`、`PUT .../project-info`、`PUT .../analysis`、`PUT .../outline-config`、`PUT .../outline`、`PUT .../key-parameters`、`PUT .../chapters/:nodeId`、`PUT .../sources`、`DELETE .../sources/:fileId`、`GET .../sources/:fileId/markdown`、`DELETE`（清空），对应桌面版 `loadState`、`updateStep`、`saveProjectInfo`、`saveAnalysis`、`saveOutlineConfig`、`saveOutline`、`saveKeyParameters`、`saveChapterContent`、`importSourceDocuments`、`removeSourceDocument`、`readSourceMarkdown`、`clear`。
  - 下游清空与桌面版（经 `taskService` 调用的版本）相同：保存项目信息、导入或移除资料时清空资料分析、目录和关键参数；保存资料分析时清空目录和关键参数；保存目录（`sort` 除外）时清空关键参数；保存关键参数时清空全部正文。
  - **目录的 `reason` 协议**与桌面版相同：整体替换节点；`replace` 清空全部正文；其他 reason 中 `affectedNodeIds` 的节点清空正文，其余节点的正文取请求给出的，未给出时按 `idMap`（旧 id → 新 id）沿用已保存的；没有 id 的节点连同子节点跳过，空标题用“未命名章节”。目录树的结构、层级（≤ 10）、节点数（≤ 2000）、id 重复与各字段长度由 Store 逐层检查（`400 FEASIBILITY_REPORT_INVALID`），不用递归的 JSON Schema，避免深层嵌套的请求体在校验时递归过深。目录连同正文一起提交，这个接口的请求体上限为 8 MiB，资料分析、关键参数、单章正文为 4 MiB 余，其余接口仍是全局的 1 MiB。
  - 导入资料与桌面版相同整体替换：给出的文件按顺序成为全部资料，新文件挂到本项目、待解析，已有的保留并重排，去掉的原件软删除；每个项目最多 20 份；文件不可用时整体失败，`400 FEASIBILITY_REPORT_FILE_UNAVAILABLE`。资料的 Markdown 与知识库相同流式转发、一律附件、`nosniff`、`sandbox` CSP，还没有解析出 Markdown 时返回空内容。
  - 目录配置整份保存（与桌面版相同），引用的知识库文档去重、按顺序整体替换，最多 100 个；文档不存在、其他组织的或原件已删除时整体失败，`400 FEASIBILITY_REPORT_REFERENCE_UNAVAILABLE`。
  - 同一项目的写操作用事务级 advisory lock 串行。其他组织的、已删除的、kind 不符的项目一律 `404 PROJECT_NOT_FOUND`；资料、章节不存在分别 `404 FEASIBILITY_REPORT_SOURCE_NOT_FOUND`、`FEASIBILITY_REPORT_CHAPTER_NOT_FOUND`。响应带 `cache-control: no-store`。
- **给第 6 步任务用的 Store 函数**（已直接测试）：`saveSourceParse`（资料的解析结果，只写给出的字段，资料已移除时返回 `false`，产物不合规被 RLS 拒绝）。资料分析、目录、关键参数和正文的任务写入与用户相同，经 `saveAnalysis`、`saveOutline`（`reason: 'replace'`）、`saveKeyParameters`、`saveChapterContent`。

与路线图、设计的偏离：

- 拆分计划写的是 2 张表，实际 4 张：桌面版把资料列表和引用的知识库文档以 JSON 存在 meta 中，这里拆成 `_sources`、`_reference_docs`，才能用外键和 RLS 让它们随原件、随知识库文档的生命周期（与 `rejection_check_documents`、5.11 计划中的 `technical_plan_generation_reference_docs` 写法一致）。范围和接口没有变化；因为引用知识库文档，依赖另加 5.6；
- 接口字段与桌面版 Renderer 的差异：资料不再有 `markdownPath`，改为 `markdownArtifactId`、解析状态 `status`、`contentChars`（取代 `markdownChars`）等，导入时间为 `importedAt`（`Date`）；资料的 id 是 `files.id`；导入资料返回 `{ addedCount, removedCount, state }`；所有保存接口返回完整状态（桌面版 `saveOutline`、`saveChapterContent` 返回部分状态，`updateStep` 无返回）；任务状态为 `null`；前端接入时由第 9 步的 bridge 适配；
- 桌面版“正文生成或审校任务运行中或已暂停时不能修改目录、手工改正文”（`assertContentUnlocked`）依赖任务状态，随第 6 步的任务队列实现；
- `readCombinedSourceMarkdown`（Renderer 未调用，给任务合并资料）不开放为接口，由第 6 步的任务在服务端合并；
- 移除资料、清空时原件软删除（与 5.8、5.9 相同理由：原件计入配额）；新增资料 20 份、引用 100 个、目录 2000 项 / 10 级、各文本长度的上限（桌面版没有）；
- 保存目录时 `sort` 也按 `idMap` 沿用已保存的正文（桌面版 `sort` 直接用请求中的正文，请求总是带正文时结果相同）；
- 本地验证用的是 PostgreSQL 16，CI 用 17；`tests/db/files.test.ts` 需要 S3 兼容服务，本地无法启动，只在 CI 中运行（本 PR 未改动文件存储）。

#### 技术方案（一）（#20，5.11）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色，没有修改已有表的策略。

- **迁移 `0018_technical_plan`**：取代桌面版 SQLite 的 `technical_plan_meta`、`_generation_config`、`_generation_bid_tasks`、`_generation_reference_docs`、`_bid_items`（`_tasks` 按拆分计划不迁移），全部是项目级表，挂在 `kind = 'technical-plan'` 的项目下（取代桌面版的单例 `id = 1`），照 `exampleProjectTable` 模板写：`org_id`、`project_id` 不可空，复合外键 `(org_id, project_id) → projects` 级联，`timestamptz` / `jsonb`，索引以 `org_id, project_id` 开头。
  - `technical_plan_meta`：每个项目一行，步骤、多标段识别结果（`bid_sections` 为 `jsonb` 数组，≤ 1 MiB）、识别状态与错误、选中的投标范围（id 与标题）；桌面版的 `tender_*`、`original_plan_*`、`pending_tender_*`、v6 兼容列不迁移（文档另建表，待选择标段是旧版兼容字段）；目录的项目名称与概述、字数控制快照随 5.12，`content_generation_runtime_json` 随 5.13。不授予 DELETE，清空时恢复默认值。
  - `technical_plan_documents`：招标文件（`tender`）与原方案（`original-plan`）。桌面版存在 meta 的 `tender_files_json` 与 `original_plan_*` 列中，这里与 `rejection_check_documents` 相同拆成表：`file_id`（复合外键指向 `files`，原件被清理任务物理删除时级联）、`markdown_artifact_id`（被清理时列级 `SET NULL`）、解析状态、字数、正文哈希、解析器、错误，文件名、扩展名、大小取 `files`。新文档一律 `pending`（状态等解析结果没有 INSERT 授权）；`role`、`sort_order` 写入后不能改。原方案每个项目只有一份由 Store 在项目锁内保证（替换时旧原件进回收站、行仍在表中，不能用唯一索引表达），读出时取最近导入的一份。
  - `technical_plan_generation_config`：每个项目一行，列与桌面版相同（布尔列改为 `boolean`，配图比例只能取 0~100 的整十，字数控制 0~1000 万，HTML 配图类型 1~2000 字）；`outline_mode` 默认取桌面版代码中的 `standalone-technical`（桌面版建表语句的默认值不生效）。不授予 DELETE。
  - **导出模板引用**（#10 留下的设计）：`export_template_id` 以**单列外键**指向 `export_templates (id)`（系统模板 `org_id` 为空，不能用复合外键），`ON DELETE SET NULL`（组织模板被删除、系统模板同步下线时只清空这一列）；INSERT / UPDATE 策略要求模板在应用角色下可见（`export_templates` 的策略在子查询中生效：本组织的模板或系统模板），其他组织的模板被拒绝。默认值是系统模板“标准投标”（`system_key = 'standard-bid'`，桌面版 `tpl-system-standard-bid`），由 Store 写入；未选择时为 `null`。
  - `technical_plan_generation_bid_tasks`（`task_id` 只能是 18 个招标解析项之一）、`technical_plan_generation_reference_docs`（复合外键指向 `knowledge_documents`，级联删除）：整体替换，不授予 UPDATE。
  - `technical_plan_bid_items`：招标解析项的结果，主键 `(project_id, item_id)`，`item_id` 只能是 18 个解析项之一，内容 ≤ 100 万字；由第 6 步的任务写入。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：
  - 六张表都只对应用角色建策略：只能看到、写入本组织的行，未设置上下文时什么都看不到；条件另含“不存在同 id 的已删除或其他 kind 的项目”，项目软删除后六张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复。跨组织的 `project_id` 由复合外键报错。
  - **文档随原件的生命周期**：原件已删除（进入回收站）、未上传完成或已不属于本项目时文档行不可见，恢复文件即一起恢复。应用角色没有文档的 DELETE 授权，移除文档就是软删除原件。INSERT 策略只允许登记本组织已上传、未删除、用途是 `tender`、已挂到本项目的文件；`markdown_artifact_id` 只能是本组织已写完、来源文件就是该文档原件的 Markdown 产物（UPDATE 策略）。
  - **引用随知识库文档的可见性**：所引用的文档在应用角色下不可见（原件进回收站）时引用行同样不可见，也不能新引用。
  - 隔离测试：六张表各调用一次 `describeProjectTable`（`projectKind: 'technical-plan'`；文档 `onProjectDelete: 'restrict'`）；另测了上面的规则。分别去掉项目条件中的已删除判断、kind 判断，文档的原件条件、INSERT 的用途条件，Markdown 产物条件，引用的文档条件，模板可见条件，给选中的解析项授予 UPDATE、给文档授予 DELETE、给文档的状态授予 INSERT，各有 1、1、7、1、2、2、3、6、1、1 个用例失败。
- **接口**（`src/routes/technicalPlan.ts`、`src/technicalPlan/store.ts`），先经 `requireProject(..., 'technical-plan')`：`GET /api/projects/:projectId/technical-plan`（本步涉及的状态，`bidSectionExtractionTask`、`bidAnalysisTask` 先返回 `null`）、`PATCH .../step`、`PATCH .../generation-config`（局部保存）、`PUT .../bid-analysis-config`、`PUT .../content-options`、`POST .../tender-files`（`{ fileIds }`）、`DELETE .../tender-files/:fileId`、`GET .../tender-files/:fileId/markdown`、`GET .../tender-markdown`、`PUT .../original-plan`（`{ fileId }`）、`DELETE .../original-plan`、`PUT .../bid-section`（`{ sectionId }`）、`DELETE`（清空），对应桌面版 `loadState`、`updateStep`、`saveGenerationConfig`、`saveBidAnalysisConfig`、`saveContentGenerationOptions`、`importTenderDocument`、`removeTenderDocument`、`readTenderSourceMarkdown`、`readTenderMarkdown`、`importOriginalPlanDocument`、`removeOriginalPlanDocument`、`selectBidSection`、`clear`。
  - 生成配置的整理与桌面版 `normalizeGenerationConfig` 相同：只替换给出的顶层字段，`contentGenerationOptions` 给出时整份替换（未给出的字段取默认值），招标解析配置按 `normalizeBidAnalysisConfig` 整理（必选项总是选中）。导出模板不是本组织的或系统模板时 `400 TECHNICAL_PLAN_TEMPLATE_UNAVAILABLE`；引用的知识库文档不可见时 `400 TECHNICAL_PLAN_REFERENCE_UNAVAILABLE`，最多 100 个。
  - **下游清空**与桌面版（经 `taskService` 调用的版本）相同：导入或移除招标文件时清空招标解析结果、多标段识别结果和投标范围，生成配置恢复默认值，步骤回到 `document-analysis`（`clearDownstreamFromTender`）；切换单 / 多标段、选择投标范围时清空招标解析结果、引用的知识库文档和正文生成选项，步骤回到 `bid-analysis`（`clearDownstreamFromBidSectionChange`）；移除原方案时目录扩展方式恢复为 `ai-complement`；上传原方案不清空下游。**5.12、5.13 要把目录、全局事实、正文的清空加进这两个函数**。
  - 导入招标文件与桌面版相同追加，已导入到本项目的文件跳过（`skippedCount`），全部跳过时不做改动；每个项目最多 20 份（`400 TECHNICAL_PLAN_DOCUMENT_LIMIT`）；文件不可用（含已是原方案）时整体失败，`400 TECHNICAL_PLAN_FILE_UNAVAILABLE`。上传原方案替换已有的一份，旧原件进回收站。
  - **合并的招标正文现算**：桌面版保存合并正文 `tender-original.md` 和按投标范围裁剪的工作副本 `tender.md`，这里不再保存，`readTenderMarkdown` 按导入顺序合并各招标文件已解析出的 Markdown（与桌面版 `combineTenderMarkdown` 相同），选择了投标范围时按标段裁剪（与桌面版 `buildSelectedSectionMarkdown` 相同，改用差分数组标记行，耗时与范围数加行数成正比）。整份读入内存，Markdown 合计超过 32 MiB 时 `422 TECHNICAL_PLAN_MARKDOWN_TOO_LARGE`。第 6 步的招标解析任务同样经它读取。两个 Markdown 接口都是附件下载（`nosniff`、`sandbox` CSP）。
  - 选择投标范围需要至少两个标段（`409 TECHNICAL_PLAN_BID_SECTIONS_UNAVAILABLE`），正文为空时 `409 TECHNICAL_PLAN_TENDER_EMPTY`，标段不存在、没有有效范围或裁剪结果为空时 `400 TECHNICAL_PLAN_BID_SECTION_INVALID`（消息与桌面版相同）。
  - 同一项目的写操作（用户与任务）用事务级 advisory lock 串行。其他组织的、已删除的、kind 不符的项目一律 `404 PROJECT_NOT_FOUND`；招标文件不存在 `404 TECHNICAL_PLAN_DOCUMENT_NOT_FOUND`。响应带 `cache-control: no-store`。
- **给第 6 步任务用的 Store 函数**（已直接测试）：`saveDocumentParse`（招标文件或原方案的解析结果，只写给出的字段，文档已移除时返回 `false`，产物不合规被 RLS 拒绝）、`saveBidItems`（与桌面版 `saveBidItems` 相同逐项覆盖写入，名称默认取任务列表，`null` 或空对象删除全部，未知的解析项抛 `TypeError`）、`prepareBidSectionExtraction`（与桌面版相同清空下游、切到多标段、状态置为 `running`）、`saveBidSectionExtraction`（状态、错误、按桌面版 `normalizeBidSections` 整理的标段，超出数量的截掉、过大的结果抛 `TypeError`）。
- **纯函数**（`src/technicalPlan/tender.ts`）：招标解析项列表由单元测试直接加载桌面版 `bidAnalysisTask.cjs` 核对 id、名称、是否必选和顺序；`normalizeBidAnalysisConfig`、`normalizeBidSections`、`buildSelectedSectionMarkdown`、`combineTenderMarkdown` 桌面版没有导出，测试按桌面版的规则逐条核对。
- **测试调整**：`tests/db/projects.test.ts` 用来模拟模块接口的路由原挂在 `/api/projects/:projectId/technical-plan`，与本 PR 的真实接口冲突，改为 `/access-probe`，用例不变。

与路线图、设计的偏离：

- 拆分计划写的是 5 张表，实际 6 张：桌面版把招标文件列表和原方案存在 meta 中，这里另建 `technical_plan_documents`，才能用外键和 RLS 让它们随原件的生命周期（与 5.9、5.10 写法一致）。范围和接口没有变化；
- **`checkBidSections`（疑似多标段检测）推迟到第 6 步**：桌面版的检测正则（`\d+` 后接 `\s*个?\s*` 等）对构造的长数字串、长空白串是平方级回溯，在共享的 api 进程中同步执行会被用来阻塞事件循环；改由第 6 步的任务在解析后于 worker 中计算并写入状态，届时同时处理正则的回溯问题。拆分计划的接口列表中本来没有它，Renderer 的调用由第 9 步的 bridge 适配；
- 接口字段与桌面版 Renderer 的差异：不再有合并的 `tenderFile`（改为 `tenderFiles` 与 `selectedSection`，合并正文经 `.../tender-markdown` 读取）；文档不再有 `markdownPath`、`sourceDocxPath`，改为 `markdownArtifactId`、解析状态 `status`、`contentChars` 等，id 是 `files.id`；`exportTemplateId` 是 `export_templates.id`（`uuid`，未选择时为 `null`），不再是 `tpl-*` 文本；解析项的 `error` 为 `null` 而不是省略；保存接口返回完整状态（桌面版部分接口无返回或只返回部分字段）；导入招标文件返回 `{ addedCount, skippedCount, state }`，不再返回解析后的 Markdown 和提示文案；任务状态为 `null`；`bidTemplateExists`（投标模版）随第 7 步，目录、全局事实、正文相关字段随 5.12、5.13；前端接入时由第 9 步的 bridge 适配；
- 导入时不再按“文件名 + 正文哈希”去重（导入时尚未解析），改为同一文件只导入一次；移除招标文件、替换或移除原方案、清空时原件软删除（与 5.8~5.10 相同理由：原件计入配额）；从回收站恢复原件时文档随之恢复，但已清空的下游不会恢复；
- 桌面版导入原方案时校验原图资源、删除 Agent 持久任务，导入招标文件前取消后台任务、关闭 OpenXmlHelper：分别随第 6 步（解析）、第 8 步（Agent）、第 6 步（任务队列）、第 7 步实现；
- 新增招标文件 20 份、引用 100 个、标段 100 个（每个最多 500 个范围）、合并正文读取 32 MiB 和各文本长度的上限（桌面版没有）；
- 本地验证用的是 PostgreSQL 16，CI 用 17；`tests/db/files.test.ts` 需要 S3 兼容服务，本地无法启动，只在 CI 中运行（本 PR 未改动文件存储）。

#### 技术方案（二）（#21，5.12）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色，没有修改已有表的策略（`technical_plan_meta` 只加列和列级授权）。

- **迁移 `0019_technical_plan_outline`**：取代桌面版 SQLite 的 `technical_plan_outline_nodes`、`technical_plan_global_fact_groups`，两张都是项目级表，挂在 `kind = 'technical-plan'` 的项目下，照 `exampleProjectTable` 模板写；另给 `technical_plan_meta` 加上 5.11 留下的目录项目名称、概述（上限与招标解析项相同，概述由目录生成任务取自项目概述）和字数控制快照（`jsonb` 对象）。
  - `technical_plan_outline_nodes`：主键 `(project_id, node_id)`，`node_id` 是 `uuid`（与桌面版相同由程序分配的稳定 UUID，写入后不能改）；父节点以复合外键指向同一项目的节点、随父节点级联删除，`DEFERRABLE INITIALLY DEFERRED`；`sort_order` 是同级顺序，显示编号不存、读取时按树的顺序现算（与桌面版 `numberOutline` 相同）；层级 1~10 且与是否有父节点一致、不能以自己为父、处理方式只能取 5 种之一且说明只能配 `other`（CHECK）；标题 1~2000 字，说明 ≤ 2 万字，单节正文 ≤ 50 万字，`knowledge_item_ids` 为 `jsonb` 数组（≤ 64 KiB）。授予 SELECT、INSERT、DELETE 和除归属列、`node_id` 以外各列的 UPDATE（sort 只改位置、edit 只改标题与说明，节点身份不变）。
  - `technical_plan_global_fact_groups`：主键 `(project_id, group_id)`，`group_id` 只含小写字母、数字、下划线和连字符（与桌面版 `normalizeGlobalFactId` 相同，CHECK）；标题 1~2000 字，内容 1~10 万字；整体替换，不授予 UPDATE。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：两张表都只对应用角色建策略，只能看到、写入本组织的行，未设置上下文时什么都看不到；条件另含“不存在同 id 的已删除或其他 kind 的项目”，项目软删除后两张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复。跨组织的 `project_id`、其他项目的父节点由复合外键报错。隔离测试：两张表各调用一次 `describeProjectTable`（`projectKind: 'technical-plan'`，级联）；另测了上面的规则。分别去掉项目条件中的已删除判断、kind 判断，去掉节点 UPDATE 策略 USING 中的项目条件，去掉层级与父节点一致的 CHECK，给全局事实授予 UPDATE、给 `node_id` 授予 UPDATE，各有 1、1、1、1、2、1 个用例失败。
- **接口**（`src/routes/technicalPlan.ts`），先经 `requireProject(..., 'technical-plan')`：`PUT /api/projects/:projectId/technical-plan/outline`（`{ outlineData, reason, affectedNodeIds? }`，请求体上限 16 MiB）、`PUT .../global-facts`（`{ globalFacts }`，最多 100 组），对应桌面版 `saveOutline`、`saveGlobalFacts`，都返回完整状态。`GET .../technical-plan` 的状态加上 `outlineData`（带 `number`）、`outlineWordControlSnapshot`、`globalFacts`，`outlineGenerationTask`、`outlineAdjustmentTask`、`globalFactsTask`、`globalFactsAdjustmentTask` 先返回 `null`。
  - **`reason` 协议**与桌面版相同：`replace` 清空全部正文；`delete`、`add-root`、`add-child` 只清空 `affectedNodeIds` 中的节点和叶子 / 父节点身份变化的节点的正文，其余已有节点沿用已保存的正文（忽略请求中的正文），新节点取请求给出的正文，不在新目录中的节点删除（仍在目录中的子节点先移到新父节点下再删）；`sort` 只改父节点、同级顺序、层级和目录的项目名称与概述；`edit` 只改标题与说明；目录为空时同时清除字数控制快照。节点的整理与桌面版 `flattenOutlineItems` 相同（没有 id 的节点连同子节点跳过，标题为空用“未命名章节”，处理方式只留在叶子上），读出与 `loadOutlineData` 相同（父节点不存在的节点作为根节点，空的可选字段省略）。
  - **保存全局事实**与桌面版相同按 `normalizeGlobalFactGroups` 整理（标题或内容为空的分组丢弃，id 取 `id`、`group_id` 或标题，重复时追加 `_2`、`_3`……）后整体替换，同时清空全部正文（`clearContentGenerationState` 中本步已有的部分）。
  - **下游清空**：`clearDownstreamFromTender`、`clearDownstreamFromBidSectionChange`（导入 / 移除招标文件、切换单 / 多标段、选择投标范围、开始多标段识别）和清空技术方案都删除目录（含正文）与全局事实，并清除目录的项目名称、概述与字数控制快照，与桌面版相同。
- **给第 6 步任务用的 Store 函数**（已直接测试）：`saveGeneratedOutline`（目录生成的结果：与 `replace` 相同整体替换、清空正文，同时写入字数控制快照，取代桌面版任务 checkpoint 中的 `outlineData` / `outlineWordControlSnapshot`）；全局事实生成同样经 `saveGlobalFacts` 写入。
- **纯函数**（`src/technicalPlan/outline.ts`）：`flattenOutline`、`buildOutline`、`normalizeGlobalFactGroups`、`normalizeGlobalFactId` 桌面版没有导出，测试按桌面版的规则逐条核对；`numberOutline` 由单元测试直接加载桌面版 `technicalPlanOutline.cjs` 对照。

与路线图、设计的偏离：

- `sort`、`edit` 要求请求中的节点与已保存的完全一致，否则 `409 TECHNICAL_PLAN_OUTLINE_CHANGED`、不做改动（桌面版对不一致的节点静默跳过）：Web 版同一项目可能由组织内多个成员同时编辑，旧页面提交的排序会让部分节点停在旧位置，甚至引用已删除的父节点；
- 节点 id 必须是 UUID、处理方式必须是 5 种之一，否则 400（桌面版不校验）；新增目录 2000 个节点、10 级、每节 200 个知识库条目、全局事实 100 组和各文本长度的上限（桌面版没有）；
- 全局事实的 `updated_at` 不再取请求中的值：内容未变的分组沿用原值，变化或新增的取保存时间；
- 桌面版“正文生成任务运行或暂停中不能调整目录”的检查随第 6 步的任务队列；`saveOutline` 中正文生成状态（各节状态、编排、运行进度）的保留与清空、`saveGlobalFacts` 中正文生成状态的清空随 5.13 加入（本步只处理节点上的正文）；`saveGlobalFacts` 写入的“手工保存”任务记录随第 6 步；Agent 持久任务的删除、正文 Word 文件的暂存与回收随第 8 步、第 7 步；
- 接口字段与桌面版 Renderer 的差异：保存接口返回完整状态（桌面版 `saveOutline` 只返回目录与正文生成相关字段、`saveGlobalFacts` 只返回全局事实相关字段）；任务状态为 `null`；`updated_at` 是 `Date`（JSON 中是 ISO 字符串）；前端接入时由第 9 步的 bridge 适配；
- 本地验证用的是 PostgreSQL 16，CI 用 17；`tests/db/files.test.ts` 需要 S3 兼容服务，本地无法启动，只在 CI 中运行（本 PR 未改动文件存储）。

#### 技术方案（三）（#22，5.13）

只改 `server/`，不改 `client/`，没有新增依赖，没有新增数据库角色，没有修改已有表的策略（`technical_plan_meta` 只加列和列级授权）。

- **迁移 `0020_technical_plan_content`**：取代桌面版 SQLite 的 `technical_plan_content_sections`、`technical_plan_content_plans`，两张都是项目级表，挂在 `kind = 'technical-plan'` 的项目下，照 `exampleProjectTable` 模板写；另给 `technical_plan_meta` 加上 5.11 留下的正文生成运行进度 `content_generation_runtime`（`jsonb` 对象，≤ 1 MiB）。
  - `technical_plan_content_sections`：主键 `(project_id, node_id)`，状态只能取 `idle` / `running` / `success` / `error`，错误 ≤ 2 万字；正文仍在目录节点上。
  - `technical_plan_content_plans`：主键 `(project_id, node_id)`，`plan_version` 大于 0，`plan` 为 `jsonb` 对象（≤ 256 KiB），表格要求只能取 4 种之一或为空（桌面版的 `plan_json` 拆成三列）。
  - 两张表都以复合外键 `(org_id, project_id, node_id)` 指向同一项目的目录节点，节点删除时随之删除（与桌面版外键相同），目录整体替换或删除不会留下孤立的状态与编排。授予 SELECT、DELETE 和除归属列、`node_id` 以外各列的 INSERT / UPDATE；`updated_at` 由触发器维护。
- **删除可见性与写权限由 RLS 强制**，应用代码不判断：两张表都只对应用角色建策略，只能看到、写入本组织的行，未设置上下文时什么都看不到；条件另含“不存在同 id 的已删除或其他 kind 的项目”，项目软删除后两张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复。跨组织的 `project_id`、其他项目或不存在的节点由复合外键报错。隔离测试：两张表各调用一次 `describeProjectTable`（`projectKind: 'technical-plan'`，级联）；另测了上面的规则。分别去掉 SELECT 策略中的项目条件、给 `node_id` 授予 UPDATE、去掉节点外键，各有 1、1、2 个用例失败。
- **接口**（`src/routes/technicalPlan.ts`），先经 `requireProject(..., 'technical-plan')`：`PUT /api/projects/:projectId/technical-plan/chapters/:nodeId`（`{ content }`，单节 ≤ 50 万字，请求体上限 4 MiB 余）、`DELETE .../content-generation`，对应桌面版 `saveChapterContent`、`resetContentGeneration`，都返回完整状态。`GET .../technical-plan` 的状态加上 `contentGenerationSections`（与桌面版 `loadContentSections` 相同：没有状态行但有正文的叶子视为 `success`）、`contentGenerationPlans`、`contentGenerationRuntime`，`contentGenerationTask` 先返回 `null`。
  - **手工保存一节正文**与桌面版相同：写入正文，该节状态改为 `success`（正文为空时 `idle`）并清除错误；节点不在目录中时 `404 TECHNICAL_PLAN_CHAPTER_NOT_FOUND`。
  - **重置正文阶段**与桌面版 `clearContentGenerationState` 相同：保留目录、全局事实和生成配置，清空全部正文、生成状态、编排与运行进度。保存全局事实同样清空（5.12 只清了正文）。
  - **`saveOutline` 的正文生成状态**与桌面版相同：`sort`、`edit` 不改；`delete`、`add-*` 删除受影响节点（含叶子 / 父节点身份变化的节点）的状态与编排，运行进度按桌面版规则保留（已确认字数与 Word 小节只留仍是 `ai-generate` 叶子且未失效的节，阶段回到 `planning`，新出现的 `ai-generate` 叶子进入直接生成范围，已开始生成时也进入待生成范围，其他字段不保留，纯函数 `src/technicalPlan/content.ts`）；`replace` 全部清空。
  - **下游清空**（`clearDownstreamFromTender`、`clearDownstreamFromBidSectionChange`）和清空技术方案另清除运行进度（状态与编排随目录节点删除）。
- **给第 8 步任务用的 Store 函数**（已直接测试）：`saveContentSections`、`saveContentPlans`（与桌面版相同整体替换，编排只保存 `plan` 是对象、版本大于 0 的节）、`saveContentGenerationItem`（一节的正文、状态、编排与运行进度）、`saveContentGenerationRuntime`。已不在目录中的节点跳过；节点 id 不是 uuid、编排或运行进度过大抛 `TypeError`；文本超长时截短。目录生成的结果（`saveGeneratedOutline`）与 `replace` 相同一并清空正文生成状态、编排与运行进度。
- **废标检查从技术方案读取招标文件**（`src/rejectionCheck/fromTechnicalPlan.ts`，取代桌面版 `importTenderFromTechnicalPlan`）：`POST /api/projects/:projectId/rejection-check/tender-from-technical-plan`（`{ technicalPlanProjectId }`），返回 `{ importedCount, state }`。
  - 文件的 `project_id` 设置后不能再改（迁移 0015），废标检查的文档又必须引用挂在本项目下的原件（迁移 0016 的策略），所以为技术方案中每份已解析出 Markdown、正文不为空的招标文件**复制一份原件和一份 Markdown 产物**（流式复制，核对大小与 SHA-256 与登记的一致）到废标检查项目，再在一个事务中整体替换招标文件：新原件挂到本项目、直接写入解析结果（不再解析），原有招标文件的原件进回收站，清空解析结果与三类检查结果，技术方案中解析成功的“无效投标与废标项”作为来源为 `technical-plan` 的解析结果写入（签名取替换后的招标文件），页签回到合并的招标正文。新原件、产物的合规仍由触发器与 RLS 检查。
  - 来源不是本组织未删除的技术方案项目时 `404 REJECTION_CHECK_TECHNICAL_PLAN_NOT_FOUND`，没有已解析的招标文件时 `409 REJECTION_CHECK_TECHNICAL_PLAN_EMPTY`，未配置对象存储时 503，超出配额时 413。复制中途失败时删除已写的对象、放弃登记，已完成的副本原件软删除（应用角色不能物理删除已上传的文件），原有招标文件不变。
  - `files/store.ts` 的 `completeUpload` 只用到检查结果中的 MIME、大小与哈希，参数类型相应放宽；废标检查的路由改为接收对象存储。

与路线图、设计的偏离：

- `importTenderFromTechnicalPlan`：桌面版只有一个技术方案，Web 版须在请求中给出来源项目；副本与原件一样**计入组织配额**，之后两个项目各自删除、恢复，互不影响；桌面版合并并按投标范围裁剪的主招标文档不再保存，废标检查的招标文件是各文件的完整 Markdown（选了投标范围时，来自技术方案的解析结果仍是按裁剪后的正文得出的，与桌面版相同）；返回 `{ importedCount, state }` 而不是 `{ success, message }`，没有可读取的正文时 409；
- 桌面版“正文生成任务运行或暂停中不能手工编辑正文 / 调整目录”的检查、重置时取消正文生成任务随第 6 步；Agent 持久任务的删除、正文 Word 与 HTML 文件的暂存与回收随第 8 步、第 7 步。运行进度中的 `html_output` 是桌面版本地路径，Web 版的内容由第 8 步的任务决定，本步按不透明的对象保存，只按桌面版规则筛选 `word_sections`；
- 正文生成状态与编排的 `updated_at` 由数据库维护，不再取任务给出的值；状态的 `error` 为 `null` 而不是省略，由正文推出的状态 `updated_at` 为 `null`；保存接口返回完整状态（桌面版 `saveChapterContent` 返回空对象）；前端接入时由第 9 步的 bridge 适配；
- 新增编排 256 KiB、运行进度 1 MiB 的上限（桌面版没有）；
- 本地验证用的是 PostgreSQL 16，CI 用 17；`tests/db/files.test.ts` 需要 S3 兼容服务，本地无法启动，只在 CI 中运行（本 PR 未改动文件存储的读写，复制用测试中的内存存储验证）。



以下改动只在 Node、构建或无头浏览器中验证过，本仓库的开发环境无法启动 Electron（网络策略拦截 Electron 二进制下载、没有图形界面）。请在 Windows（必要时 macOS）的 `npm run dev` 和打包版中逐项验证，结果回填到“状态”列（未测 / 通过 / 失败：说明）。新的 PR 如果留下桌面版待测项，继续追加到这里。

| # | 来源 | 场景与预期 | 状态 |
|---|---|---|---|
| 1 | 旧仓库 PR #4 | Windows **打包版**导入一份真实招标 PDF：能正常转出 Markdown 和表格（pdfjs 6 专用 `PDFWorker` 与 pdf-parse 内置 pdfjs 5.4.296 共存；cmaps、standard_fonts 能从 asar 内 `node_modules/pdfjs-dist` 读取）。顺带关注已知问题：合并单元格的表输出两份、跨页长表误报 `pdf_text_layer_missing`、非嵌入 CID 中文字体的正文缺失 | 未测 |
| 2 | 旧仓库 PR #5 | 打包版导入一份 Excel 招标附件（ESM 路径 `convert.mjs` 读取 SheetJS 0.20.3），再导出一次废标检查结果和查重结果 xlsx（CJS 路径 `checkResultExportService.cjs`） | 未测 |
| 3 | 旧仓库 PR #11 | 全新 userData 首次启动：默认是空的“自定义”文本服务商，启动即跳到设置-文本模型并提示“请先选择服务商并填写 API Key、模型名称”；新配置下拉框里没有“内测版 API”；启动时不再向 内测版服务 匿名注册 | 未测 |
| 4 | 旧仓库 PR #11 | ~~曾邮箱登录官方账户的旧 userData：启动只恢复会话，不再拉取或写入 API Key；账户面板可查看余额~~ | 不再适用（旧仓库 PR #17 移除官方账户，见第 15 项） |
| 5 | 旧仓库 PR #12 | 旧配置 `text_model_provider: 'official'`：启动后常驻提示“内测版服务暂停提供，文本模型已切换为‘自定义’……”，跳到设置-文本模型，关闭后下次启动不再出现（旧仓库 PR #17 起不再提示，见第 15 项）；设置页生图模型初始为空的“自定义”，未测试可用前不发生图请求 | 未测 |
| 6 | 旧仓库 PR #13 | 侧边栏没有“插件管理”菜单，“资源下载”分组描述为“投标资料下载”；`plugin-manager` 路由不显示；技术方案首页和可研报告首页没有“AI 调整”按钮；启动后没有插件更新提示，已安装插件不加载，不请求 `analytics.agnet.top/plugins` | 未测 |
| 7 | 旧仓库 PR #14 | 设置页文本模型、生图模型和 MinerU Token 显示“已配置（末尾 xxxx）/ 未配置”；输入框留空保存不改动已有 Key；“清除 / 撤销”按钮生效；修改自定义 Base URL 后提示需要重新填写 Key；`config:save`、`config:list-models`、`ai:test-image-model` 用已保存的 Key 正常工作；Agent 测试页和启动检查按 `credential_status` 判断是否已配置 | 未测 |
| 8 | 旧仓库 PR #14 | 远程公告弹窗、公告板、更新日志、资源页以及各类 AI 输出正常渲染，表格单元格内 `<br>` 换行和查错 `<mark>` 高亮仍生效；招标文件和技术方案正文中的 HTML 表格仍显示 | 未测 |
| 9 | 旧仓库 PR #15 | 启动后不请求 `analytics.agnet.top/ip-blocks`、`/license/activate`，没有授权提醒或“来源不可信”弹窗；设置页“关于”只显示“项目信息”（使用文档；原仓库链接已在迁移到新仓库时删除，未配置使用文档时不显示该卡片），没有授权状态和“离线激活授权” | 未测 |
| 10 | 旧仓库 PR #15 | 打包版设置页“检查更新”提示“未配置更新源，不检查更新”，启动和每 30 分钟轮询时不访问 GitHub、AtomGit、原作者 OSS 域名（`agnet.top` 子域）；设置页没有“自动更新渠道”；`npm run dist:win` 在 `build.publish: null` 下能正常出包 | 未测 |
| 11 | 旧仓库 PR #15 | 数据库版本过新（`app.sqlite` 来自更高版本）时，点击“下载新版客户端”提示从发布渠道自行获取新版，不打开原作者地址 | 未测 |
| 12 | 旧仓库 PR #16 | 默认构建（`remote-services.json` 全空）启动：侧栏底部只有“设置”（旧仓库 PR #18 删除“加群”；旧仓库 PR #16 时为“加群”和“设置”），没有“文档”“日志”“公告”；“资源下载”分组不显示；不出现公告弹窗；设置页“自动填充高级参数”按钮隐藏，“关于”只有 GitHub 仓库一行，隐私声明第 03 条显示“当前版本未配置统计服务”；全程（含 AI 请求、Agent 任务、Word 导出 5 次以上）不访问 `analytics.agnet.top`、`wiki.agnet.top`、`oss.agnet.top`，不弹打赏提示 | 未测 |
| 13 | 旧仓库 PR #16 | 旧 userData（`analytics_client_id` 以 `machine-v1-` 开头）启动后，`user_config.json` 中改为 `install-v1-` 开头的新 ID，再次启动和在设置页保存后不再变化 | 不再适用（旧仓库 PR #19 删除安装标识、内容服务和旧配置迁移，见第 17 项） |
| 14 | 旧仓库 PR #16 | 在 `remote-services.json` 填入自建 Worker 的 https 地址后重新构建：公告、日志、资源、模型信息、使用文档入口恢复（旧仓库 PR #18 起没有群二维码），埋点发往配置地址；填 http 地址时按未配置处理 | 不再适用（旧仓库 PR #19 删除安装标识、内容服务和旧配置迁移，见第 17 项） |
| 15 | 旧仓库 PR #17 | 旧 userData（`text_model_provider: 'official'` 且未经 旧仓库 PR #12 迁移的，以及已经 旧仓库 PR #12 迁移、`official_text_provider_paused_notice_pending: true` 的两种）：启动不出现“内测版服务暂停提供”提示，只在自定义档案为空时提示“文本模型尚未配置”并跳到设置-文本模型；设置页下拉框没有“内测版 API”，文本模型页没有官方账户面板；保存设置后 `user_config.json` 中 `text_model_profiles.official` 仍在，`official_api_session.json` 仍在；全程不访问 内测版服务。本项取代第 4、5 项 | 不再适用（旧仓库 PR #19 删除安装标识、内容服务和旧配置迁移，见第 17 项） |
| 16 | 旧仓库 PR #18 | 设置页文本模型和生图模型的服务商下拉框里没有“金龙中转站”；旧 userData 中文本、生图选中金龙的，启动后变为“自定义”，Base URL 显示原金龙地址，Key 显示“已配置（末尾 xxxx）”，不重新填写即可测试连接、生成正文和配图，在设置页保存后 Key 仍在；原自定义档案已有内容的，`user_config.json` 中出现 `custom_before_jinlong_migration`；火山方舟、DeepSeek、Agnes、Google AI Studio 的“获取”仍能打开对应页面，自定义和 ComfyUI 的“获取”置灰；侧栏展开和收起时都没有“加群”，底部只有“设置”，没有多余空白 | 未测（旧配置迁移部分不再适用，旧仓库 PR #19 删除迁移代码） |
| 17 | 旧仓库 PR #19 | 全新 userData 启动：侧栏底部只有“设置”（未配置使用文档时），没有“日志”“公告”，不弹公告；“资源下载”分组不显示；设置-文本模型“高级参数”没有“自动填充高级参数”按钮，思考强度为输入框，离开设置时的上下文长度提醒不提“自动填充”；隐私声明第 03 条为“不上报使用统计”；`user_config.json` 中没有 `analytics_client_id` / `analytics_created_at`；全程（含 AI 文本请求、生图测试、Agent 任务）没有埋点请求，开发者模式下 Token 统计仍正常累计；新版更新检查（未配置更新源时）和插件停用状态不变 | 未测 |
| 18 | #5 | 全局样式变量和公共类名改用 `--app-*` / `app-*` 后，逐页检查界面外观无变化：主色、文字层级、边框、圆角、阴影、动画时长，开关（`app-switch`）、进度条（`app-progress-track`）、空状态（`app-empty-state`）、对话框弹出动画、Toast 与 Agent 提问浮层的层级，以及受限 HTML 预览中配图画框比例、图片类型角标和图片表格布局 | 未测 |
| 19 | #5 | 新生成一份含 AI 图片 / HTML 图片 / Mermaid 图、图片表格（imageText、threeImages、fourImages）和数据表格的技术方案，整本导出 Word：图片正常嵌入，`data-app-size` 画框比例和 `data-app-fit` 适配方式生效；数据表格按 `data-app-preset` 应用表头行 / 表头列样式；目录标题编号与目录一致（`data-app-outline-number`）；模板范围与页面范围切换正确（`data-app-export-template` / `data-app-export-page-template`）；再跑一次格式自检，定位书签（`app_layout_`）能对应回小节 | 未测 |

0.2 回归时发现两个既有问题，留给后续 PR：
- `hasInformativeText` 要求连续 10 个字母、数字或汉字。如果 PDF 只有表格、单元格又都很短，`|` 会把文字切断，整份文件被误判为 `pdf_text_layer_missing`。
- 同一张表被 pdf-parse 和 pdfjs 同时识别、结果又不一样时（比如有合并单元格），`hasSimilarPdfTable` 不会去重，两份都会输出。


### 第 6 步说明

#### 拆分计划

只做计划，不改代码。目标设计见 `docs/SERVER_DESIGN.md` 第 5 节（BullMQ + Redis、`jobs` 表为权威状态、SSE 推送、worker 进程）、第 6.2 节（解析阶段的防护）和第 7 节（沙箱）。原则：

- `jobs` 表是任务状态的唯一权威，BullMQ 只负责派发；worker 崩溃后由数据库租约过期收回、重新派发（6.2 起不依赖 BullMQ 的 stalled 检测，见“jobs 表与 worker 骨架”），从 `jobs.checkpoint` 继续；
- api 进程只做鉴权、校验、入队、取消和 SSE，不执行长任务、不解析文档；worker 执行全部任务，按 `TenantContext`（取自任务记录，不取自任务参数）经 `withTenant()` 读写业务表，写入一律经第 5 步已测好的 Store 函数（`saveDocumentParse`、`saveAnalysisSection`、`saveCheckResult` 等），不在 worker 中另写 SQL；
- 所有模型调用经 AI 网关，`source: 'job'`，记 `job_id`；任务参数里只放 id，不放凭据和正文；
- **上传的文件只在断网沙箱中解析**（见下方“文件解析的隔离”），worker 和 api 进程内不运行 mammoth、pdfjs、SheetJS、LibreOffice、cheerio、`adm-zip`、`cfb` 等解析器；
- 每个业务模块一个 PR：迁移该模块的任务类型、在 `loadState` 类接口中返回任务状态（第 5 步先返回 `null`）、补上第 5 步登记的“随第 6 步”的检查；桌面版任务逻辑（`taskService.cjs` 中各 `run*Task`）尽量原样搬运，只替换存储、推送和 AI 调用的接口；
- 新增依赖照 `AGENTS.md`：版本写死、发布超过两周、逐个列出许可证。

**目录生成、全局事实是否用到命令工具（已核实）**：用到，**随第 8 步迁移**。依据：
- `pi/piSessionFactory.cjs` 的 `withNativeTools` 总是把 `read/write/edit/bash/grep/find/ls` 七个原生工具加进启用列表，`agentService.runTask` 没有关闭它们的参数；
- 提示词明确要求使用命令：`outlineGenerationTaskV2.cjs`（目录审核：“可使用 grep、read 或 bash 定位相关部分”）、`globalFactsTaskV2.cjs`（“用 grep 定位……可用 node、jq 辅助合并条目”）、`outlineAdjustmentTask.cjs` / `globalFactsAdjustmentTask.cjs`（“可使用 bash 配合 node、jq 处理”）；
- 可研报告的目录生成 / 调整（`feasibilityOutlineTask.cjs`、`feasibilityOutlineAdjustmentTask.cjs`）同样经 `agentService.runTask`，七个原生工具同样启用；模板提取（`templateExtractionTask.cjs`）也经 `runTask`，随第 7、8 步。

因此第 5 步“第 6 步核实、可能推迟到第 8 步”的三类任务（技术方案目录生成 / 调整、全局事实生成 / 调整，可研目录生成 / 调整）全部定为第 8 步。另外核实了“不带 Agent”的任务：`bidAnalysisTask.cjs`、`bidSectionExtractionTask.cjs`、`rejectionCheckTask.cjs`、`feasibilityReportTasks.cjs`、`knowledgeBaseService.cjs` 只调用 `aiService`，`duplicateCheckService.cjs` 不调用 AI，都可以在第 6 步迁移。其中**可研报告正文生成与自然化审校**（`runFeasibilityContentTask`、`runFeasibilityHumanWritingTask`）也只调用 `aiService`，第 5 步的表写的是“正文生成：第 8 步”，本计划改为第 6 步（偏离，已在 #23 确认，见“决定事项”第 4 项）。

**PR 拆分顺序**：

| 序号 | 内容 | 依赖 | 需确认后合并 | 状态 | PR |
|---|---|---|---|---|---|
| 6.0 | 拆分计划（本节）与 10 项决定 | — | 是（按本次要求，已确认） | 已完成 | #23 |
| 6.1 | Redis 接入：`docker-compose.yml` 新增 `redis`（发行版见决定事项第 3 项；开启密码和 ACL，只在 `backend` 网络、开发时只绑 `127.0.0.1`）；配置 `REDIS_URL`、`REDIS_PASSWORD[_FILE]`（`init-dev-secrets.sh` 生成）；`/readyz` 加入 Redis 检查；CI 的 `server-checks` 加 Redis 服务容器。不含队列 | — | 否 | 已完成 | #24 |
| 6.2 | `jobs` 表与 worker 骨架：迁移新建 `jobs`（`SERVER_DESIGN.md` 第 5.1 节的字段，`project_id` 可空供组织级任务，强制 RLS）和 `job_events`（取代 `task_logs`，只追加）；互斥用部分唯一索引（见下方“互斥”）；`src/jobs/`（入队、取消、暂停、继续、checkpoint、状态机，事务内检查互斥和组织级并发）；BullMQ 生产者与 `src/worker.ts` 消费者（同一镜像、不同入口，compose 新增 `worker` 服务）；stalled 恢复；`GET /api/jobs`、`GET /api/jobs/:jobId`、`POST /api/jobs/:jobId/cancel`。只注册一个测试用任务类型，不迁移业务任务 | 6.1 | **是**（实现时新增定义者角色 `bidtools_jobs`，见下方“jobs 表与 worker 骨架”） | 已完成 | #25 |
| 6.3 | SSE 推送：`GET /api/events`，worker 发布到 Redis `events:org:{orgId}` 并追加 Stream，api 按连接的组织和用户过滤后写出；`Last-Event-ID` 补发、超出窗口推 `resync`、25 秒心跳；会话吊销、移出组织后关闭连接（定期重新校验会话）；单用户连接数上限 | 6.2 | 否 | 已完成 | #26 |
| 6.4 | worker 接入 AI 网关与余额：网关在 worker 中运行，任务调用记 `job_id` / `job_type`；`usage_records.job_id` 不补外键（任务记录到保留期会被删除，用量记录不可修改、永久保留，见“决定事项”第 10 项），只保留 `job_id` / `job_type` 的值；`jobs.billed_amount` 与结算在同一事务中累加（改 `ai_usage_settle`）；入队前检查最低启动余额（决定事项第 7 项）；运行中冻结失败时暂停为 `paused` / `insufficient_balance`，经 SSE 推送（取代 `onBalanceInsufficient`），充值后继续不重复扣费；AI 网关按组织 + 服务商的并发上限改为 Redis 分布式信号量（取 `org_settings.concurrency_limit` 与平台上限的较小值） | 6.2、6.3 | **是**（计费） | 已完成 | #27 |
| 6.4a | **步骤幂等，必做**（#27 确认时登记）：平台自身故障（worker 崩溃、租约收回、重启）导致的重复调用不向用户收费。现状：一次调用已结算、任务还没保存 checkpoint 时 worker 崩溃，续跑会重做这一步并再次扣费。二选一：步骤结果与 checkpoint 同一事务提交（结算、写结果、写 checkpoint 一起提交），或给每一步加幂等键（`jobId + 步骤键`，续跑时同一步已结算的调用直接复用结果或不再收费）；测试须覆盖“结算后、checkpoint 前崩溃”只扣费一次。**必须在第一个调用 AI 的业务任务 PR（6.9、6.11、6.12、6.13 中最先做的那个）之前完成** | 6.4 | **是**（计费） | 已完成 | #34 |
| 6.5 | 解析沙箱基础设施：`sandbox-runner` 服务、`SandboxDriver` 接口、`parse` 模板、解析镜像（见下方“文件解析的隔离”）；隔离测试 | 6.2 | **是**（沙箱） | 已完成 | #28 |
| 6.6 | 解析任务（一）二进制与纯文本格式：`parse` 队列；按记录的 MIME 分派（见下方分派表）；ZIP 炸弹、PDF 页数、超时检查；产出经 `writeArtifact` 写入；重新解析时替换旧产物（第 5 步 #8 留下）；接入技术方案、废标检查、可研报告三个模块的文档解析（`saveDocumentParse` / `saveSourceParse`），导入后自动入队；parse 镜像加入解析入口与其 npm 依赖，并同时加入 LibreOffice 的全局设置：链接更新设为从不、禁用宏（从 6.7 提前，#28 确认时决定，与解析入口同时上线）；**sandbox-runner 对同时存在的沙箱总数设硬上限**（#28 确认时登记）：计入全部带沙箱标签的容器，含已停止、已到期但尚未清理的残留沙箱，超出时拒绝创建并返回明确错误（429 `SANDBOX_BUSY`，文案“沙箱数已达上限，请稍后重试”），解析任务按可重试处理；6.5 已按此计数（`SANDBOX_MAX_ACTIVE`，默认 8），6.6 补测试：残留（已停止、已到期未清理）的沙箱计入上限、超出时的错误码与文案、清理后可再创建 | 6.5 | 否（实际：涉及沙箱镜像与 jszip 双许可证，按需确认处理，#30 已确认） | 已完成 | #30、#31 |
| 6.7 | 解析任务（二）文本类格式（#6 放行的 RTF、HTML、MHT、Word 2003 XML、SpreadsheetML）：逐项满足“第 6 步解析要求”，用恶意样本测试（XXE、实体膨胀、外链图片 / 样式 / `<iframe>`、RTF `INCLUDEPICTURE` / `INCLUDETEXT`、MHT 外部 `Content-Location`） | 6.6 | 否（实际：涉及解析沙箱，按本次要求确认后合并） | 已完成 | #32 |
| 6.8 | 清理任务：过期文件、产物、项目的对象与行的物理删除，遗留 `uploading` 行，按对象键前缀找出的孤儿对象，冻结到期收尾（`expireStaleHolds` 从 api 的定时器移到 worker 的定时任务），超过保留期的 `jobs` / `job_events`；跨组织，用新的 `NOLOGIN` 定义者角色 `bidtools_cleanup` 写 `SECURITY DEFINER` 函数，要求见“决定事项”第 9、10 项 | 6.2 | **是**（新增数据库角色，已确认） | 已完成 | #33 |
| 6.9 | 废标检查任务：`rejection-items-extraction`、`rejection-check-run`；任务按招标文件顺序合并正文，经 `computeSignatures` 写签名；`loadState` 返回任务状态 | 6.4、6.4a、6.6 | 否 | 已完成 | #35 |
| 6.10 | 标书查重任务：`duplicate-analysis`。`duplicateCheckService.cjs` 自己用 `adm-zip`、`cfb`、`cheerio`、`pdf-parse` 读原件（正文、元数据、目录、图片），这部分提取放进 `parse` 沙箱，产出正文与图片产物；比对计算在 worker 中进行，经 `saveAnalysisSection` 写入 | 6.5、6.6 | 否 | 未开始 | — |
| 6.11 | 技术方案任务（一）：招标解析 `bid-analysis`、多标段识别 `bid-section-extraction`；`checkBidSections`（疑似多标段检测）在 worker 中计算并写入状态，改写正则消除平方级回溯（#20 留下）；导入招标文件前取消本项目的技术方案任务（#20 留下） | 6.4、6.4a、6.6 | 否 | 未开始 | — |
| 6.12 | 可研报告任务：`feasibility-analysis`、`feasibility-parameters`、`feasibility-content`、`feasibility-human-writing`（后两项按“决定事项”第 4 项提前到第 6 步）；服务端合并资料（取代 `readCombinedSourceMarkdown`）；正文生成或审校运行、暂停时不能修改目录和手工改正文（`assertContentUnlocked`，#19 留下） | 6.4、6.4a、6.6 | 否 | 未开始 | — |
| 6.13 | 知识库任务：文档准备（解析、切块、条目抽取）、`retryDocument`、`startMatching`、`knowledgeBase.onEvent` 改为 SSE；文档在处理中被删除时任务停止（写入影响 0 行即退出，#12 留下）；取代 `recoverInterruptedDocuments` | 6.4、6.4a、6.6 | 否 | 未开始 | — |
| 6.14 | 登录、注册、找回密码的限流从进程内存换成 Redis（旧仓库 PR #29 留下，多实例部署前必须完成），接口与参数不变 | 6.1 | **是**（鉴权） | 未开始 | — |
| 6.15 | MinerU 解析（决定事项第 6 项：第一版不提供，以后决定提供时才做） | 6.6 | 视决定 | 不做（第一版） | — |

顺序说明：6.1~6.3 是所有任务的基础；6.4 让任务能调模型，6.4a 保证平台故障导致的重复调用不收费，是所有调用 AI 的业务任务（6.9、6.11、6.12、6.13）的前置；6.5~6.7 让文档能被解析，第 5 步所有“导入后读 Markdown”的模块都依赖它。6.8 只依赖 6.2，可与 6.5~6.7 并行，宜早做：6.6 起重新解析会产生被替换的旧产物。业务任务按路线图第 6 节“先迁无 Agent 的短任务（查重、废标、招标解析）”排在后面，废标检查结构最简单、最先做。6.14 只依赖 6.1，可随时插入。“需确认后合并”按 `CLAUDE.md`“自动合并”判断：涉及计费、鉴权、沙箱、数据库角色的不自行合并。

**第 6 步完成后仍不在服务端的任务**（随第 7、8 步）：技术方案目录生成 / 调整、全局事实生成 / 调整、正文生成、章节重写、原方案还原、格式自检，可研目录生成 / 调整，模板提取、Word 导出与样张；技术方案“正文生成运行或暂停中不能调整目录 / 手工改正文”的检查随第 8 步的正文生成任务一起做（第 6 步中技术方案没有会持有这个锁的任务）。

#### 任务模型的细化

- **互斥**：`SERVER_DESIGN.md` 第 5.3 节写的是 `UNIQUE(project_id, group)`。知识库任务是组织级、按文档互斥（桌面版按文档排队，不是全组互斥），清理任务没有项目，所以改为通用的 `lock_key`（例如 `project:{projectId}:technical-plan`、`knowledge-document:{documentId}`），部分唯一索引 `UNIQUE (org_id, lock_key) WHERE status IN ('queued','running','paused','cancelling')`；`lock_key` 为空的任务不互斥。实现时（6.2）同步改设计第 5.1、5.3 节；
- **组织级并发**：同时运行的任务数上限（起步 3，决定事项第 8 项），超出的留在 `queued`，按入队时间排队；`org_settings.concurrency_limit` 是模型调用并发，不是任务并发，两者分开；
- **重启恢复**：桌面版启动时把中断的任务标为失败或从 checkpoint 继续（`taskService.cjs` 的重启恢复），改为 worker 对账时收回租约过期的任务、按任务类型决定（6.2 实现）：可续跑的从 `jobs.checkpoint` 继续，不可续跑的标为失败并写日志；
- **任务日志**：`task_logs` 不迁移，改为 `job_events`，经 SSE 推送；不记录文档正文和 AI 输入输出全文（`SERVER_DESIGN.md` 第 8.3 节）；
- **保留期**：已结束的任务和日志保留期见决定事项第 10 项，由 6.8 的清理任务删除。

#### 文件解析的隔离

**要求**：路线图第 6 节和 #6 的“第 6 步解析要求”规定解析只在**完全断网**（没有任何网络接口）的沙箱中执行；`SERVER_DESIGN.md` 第 6.2、7.1 节规定解析与 Agent 共用同一套沙箱机制（gVisor、只读根文件系统、资源上限、`sandbox-runner` 是唯一持有容器运行时权限的进程）。但 Agent 沙箱排在第 8 步，第 6 步的解析任务需要先有隔离。

**选项对比**：

| | A. 提前实现完整沙箱基础设施 | B. 提前实现沙箱基础设施的公共部分，只做 `parse` 模板 **（建议）** | C. 为解析单独设计隔离 | D. 其他：把解析推迟到第 8 步之后 |
|---|---|---|---|---|
| 做法 | 第 6 步建好第 8 步的全部内容：`sandbox-runner`、`SandboxDriver`、gVisor、`parse` 和 `agent` 两个模板、`sandbox-gw` 内部网络、任务令牌、业务工具 RPC、工作区快照 | `sandbox-runner` + `SandboxDriver`（`create / exec / copyIn / copyOut / destroy`）+ 只有一个 `parse` 模板：`--network none`、gVisor（`runsc`）、只读根文件系统、非 root、`cap-drop ALL`、`no-new-privileges`、内存 / CPU / pids / 时长上限、一个解析任务一个沙箱、用完即毁；输入输出经 `copyIn` / `copyOut`，取回时校验（只收普通文件、路径在输出目录内、大小和数量上限、扩展名白名单）。第 8 步只新增 `agent` 模板、内部网络、令牌和 RPC | 不经 `sandbox-runner`：常驻的 `parser` 容器（compose `network_mode: none`，与 worker 共享临时卷，按 OpenXmlHelper 的“任务目录 + 信号”协议），或 worker 容器内用 bubblewrap / nsjail 起断网子进程 | 第 6 步只迁不依赖解析的部分，解析与第 8 步沙箱一起做，或把第 8 步的沙箱基础设施整体调到第 6 步之前 |
| 隔离强度 | 同 B | 每次解析一个全新的 gVisor 容器，断网，不同组织、不同文件之间不共享任何状态 | 常驻容器：一次被利用的解析可以留在容器里，读到之后经过它的其他组织的文件（共享卷），隔离边界是整个服务而不是单个任务；子进程方案：与 worker 共享内核和容器，worker 本身能访问数据库、Redis、对象存储和 AI 网关，逃出子进程就拿到这些凭据 | — |
| 与设计的一致性 | 一致 | 一致（第 6.2、7.1 节“共用同一套沙箱”），第 8 步在同一套机制上扩展 | 偏离第 6.2 节；第 8 步要另建一套，解析部分要么重写，要么长期维护两套隔离 | 一致 |
| 工作量与风险 | 最大；把 Agent 的网络、令牌、RPC 设计提前到还没有 Agent 任务时，无法用真实任务验证，第 6 步明显变长 | 中；`sandbox-runner` 和驱动第 8 步本来就要建，提前建的部分都会沿用 | 起步最快；但 bubblewrap / nsjail 在容器内需要用户命名空间（Docker 默认 seccomp / AppArmor 常拦截，放开又扩大 worker 的权限），常驻容器需要自己处理崩溃、超时和残留文件 | 第 5 步所有“导入后读 Markdown”的功能和第 6 步多数任务（查重、废标、招标解析、可研、知识库都要先有解析结果）一直不可用，第 6 步基本无法验证 |
| 性能 | 同 B | 每个文件多一次容器启动（gVisor 约 150–500 ms，LibreOffice 冷启动另需 1~2 秒），解析任务本来是秒级到分钟级，可接受；`parse` 队列并发起步 4 | 无额外启动开销 | — |

**采用 B**（决定事项第 1 项），理由：第 8 步一定要建 `sandbox-runner` 和 `SandboxDriver`，`parse` 模板是其中最简单的一种（不需要网络、令牌、RPC），提前建不会白做；隔离粒度是单个任务，满足“完全断网”和“不在 worker 进程内解析”；C 的两种做法都会在第 8 步被替换，而且隔离边界明显弱于设计。B 的具体约定（6.5 实现，同步写进 `SERVER_DESIGN.md` 第 7 节）：

- **运行时**：生产环境只允许 `runsc`，启动时检查，配置成 `runc` 时拒绝启动；开发环境（Windows / macOS 的 Docker Desktop 不便安装 gVisor）允许加固的 `runc`，网络、只读、权限等参数完全相同；CI 安装 `runsc`，隔离测试在 `runsc` 下跑（决定事项第 2 项，已采用）。设计第 7.2 节预留的“LibreOffice 在 gVisor 下问题过多时改用 A + 严格 seccomp + 完全断网”仍然有效，以 6.5 的实测为准；
- **镜像**：Node 24 + `doc2markdown/` 所需的 npm 依赖 + LibreOffice + 中文字体，按 digest 固定，不含编译器和网络工具；与第 8 步的 Agent 镜像分开，各自只装自己需要的东西；
- **输入输出**：worker 从对象存储取出原件，经 `copyIn` 放进沙箱 `/input`；沙箱内只运行解析入口（固定命令，参数只有分派结果，见下表），结果写到 `/output`（Markdown、图片、一个 JSON 清单）；worker 经 `copyOut` 取回、校验后经 `writeArtifact` 写入。沙箱内没有任何凭据、数据库连接串、对象存储地址；
- **sandbox-runner 的接口**：只接受“模板名 + 任务 id”，模板写死在代码中，调用方不能传镜像、挂载、网络或任意 Docker 参数；worker 和 api 都不挂载 Docker socket（设计第 7.4 节）；
- **测试**：沙箱内只有 `lo`（或没有任何接口），连接外网、内网、元数据地址、`redis`、`postgres` 全部失败；根文件系统只读；超时、超内存被终止；取回时符号链接、硬链接、设备文件、`..` 路径、超量文件被拒绝；去掉 `--network none`、只读或取回校验时有用例失败。

**按记录的 MIME 分派**（`files.mime` 由上传时的内容检查决定，第 4 步 #6；解析时不再按扩展名或重新嗅探选择解析器）：

| 记录的 MIME | 扩展名 | 解析方式（全部在 `parse` 沙箱中） |
|---|---|---|
| `application/pdf` | pdf | pdfjs / pdf-parse（现有 `convert.mjs`），先检查页数上限 |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | docx（及改了扩展名的 doc / wps） | mammoth，先检查 ZIP 条目数、解压总大小、压缩比 |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | xlsx（及改了扩展名的 xls） | SheetJS，ZIP 检查同上 |
| `application/msword` | doc、wps、docx（OLE） | LibreOffice 转 docx 后按 docx 处理，转换产物同样做 ZIP 检查 |
| `application/vnd.ms-excel` | xls（OLE） | SheetJS |
| `application/rtf` | doc、wps | LibreOffice，先去掉或拒绝 `INCLUDEPICTURE` / `INCLUDETEXT` 等域和 OLE 链接 |
| `text/html` | doc、wps → LibreOffice；xls → SheetJS | 交给解析器前移除或拒绝一切外部引用（`<img src>`、`<link>`、`<script>`、`<iframe>`、`<object>`、`<embed>`、`<base>`、CSS `url()` / `@import`），只保留 `data:` 内嵌图片 |
| `message/rfc822`（MHT） | doc、wps | 先在沙箱中解开 MIME，取 `text/html` 部分并按其 `Content-Transfer-Encoding` 与 `charset` 解码，图片只取包内部分，`Content-Location` 指向的外部地址不跟随；之后按 `text/html` 处理 |
| `application/xml` | doc、wps → Word 2003 XML，LibreOffice；xls → SpreadsheetML，SheetJS | 交给解析器前检查：含 `<!DOCTYPE` 一律拒绝（不尝试安全解析 DTD），没有 DOCTYPE 就不存在外部实体和实体膨胀；有测试 |
| `text/plain; charset=…`、`text/markdown; charset=…` | txt、md、markdown | 按记录的编码（UTF-8 或 GB18030）解码成 UTF-8，不经任何解析器；也在沙箱中执行，保持“worker 内不处理上传内容”的规则一致 |
| 其他 | — | 拒绝，记为解析失败（程序错误，写日志） |

两种 Office 2003 XML 都记为 `application/xml`，按扩展名区分（#6 的约定）；这是唯一需要看扩展名的情况，扩展名取上传时登记的值。“禁止加载远程资源”除上表的预处理外，解析器本身也关闭链接更新和远程加载（LibreOffice 的链接更新设为从不、不执行宏），断网是兜底而不是唯一措施。

**资源上限**（起步值，决定事项第 5 项）：ZIP 条目数 10,000、解压后总大小 1 GiB、单条目压缩比 100:1；PDF 页数 3,000；单个文件解析墙钟 10 分钟；沙箱内存 2 GiB、CPU 1 核、`/tmp` 与 `/output` 各 1 GiB；单个文件产出的图片 2,000 张。超限记为解析失败并给出用户可读的原因。

**MinerU**：需要把原件发到 `mineru.net`，不能在断网沙箱中进行。如果提供（决定事项第 6 项），只能由 worker 经出站校验转发原件字节（worker 不解析原件），结果中的 Markdown 只作文本处理，图片压缩包在 `parse` 沙箱中解开，Markdown 中的图片链接只接受 MinerU 的结果域名，不跟随任意地址（SSRF，`SERVER_DESIGN.md` 第 4.4 节）。

#### 前面各步登记给第 6 步的事项

| # | 事项 | 来源 | 本计划的处理 |
|---|---|---|---|
| 1 | 过期文件与产物的物理清理（7 天恢复期满的文件、产物、项目，遗留 `uploading` 行；对象先删、行后删） | 第 4 步（旧仓库 PR #34）、5.2（#8）、第 9 步上线检查“文件存储” | 6.8，已完成（#33） |
| 2 | 对象存储中的孤儿对象（如从技术方案复制到废标检查时清理失败的残留，按对象键前缀处理） | 5.13（#22，`fromTechnicalPlan.ts`） | 6.8，已完成（#33） |
| 3 | 重新解析时替换旧产物（产物没有单独的删除接口） | 5.2（#8） | 6.6，已完成（#30，迁移 0023 的 `superseded_at`）；被替换的产物由 6.8 清理（#33） |
| 4 | 按记录的 MIME 分派，只在沙箱中解析 | 第 4 步（#6）“第 6 步解析要求” | 6.5、6.6、6.7，见上方分派表；已完成（#30、#32） |
| 5 | 解析沙箱完全断网 | 同上 | 6.5（`--network none` + 测试），已完成（#28） |
| 6 | HTML / MHT / RTF 禁止加载远程资源（含 RTF 域、OLE 链接、MHT 外部 `Content-Location`） | 同上 | 6.7，已完成（#32） |
| 7 | XML 类格式禁用 DTD 和外部实体（含实体膨胀、XInclude），交给解析器前检查并有测试 | 同上 | 6.7：含 `<!DOCTYPE` 等声明一律拒绝，已完成（#32） |
| 8 | MHT 先解包再交给 LibreOffice | 同上 | 6.7，已完成（#32） |
| 9 | ZIP 炸弹、PDF 页数等解析阶段的防护 | 第 4 步（旧仓库 PR #34）、`SERVER_DESIGN.md` 第 6.2 节 | 6.6，已完成（#30） |
| 10 | MinerU（`tender` 用途加 ppt、pptx、jp2 和图片类型） | 第 4 步上传白名单差距第 5 项 | 第一版不提供（决定事项第 6 项）；以后提供时另开 6.15 |
| 11 | 目录生成 / 调整、全局事实生成 / 调整（技术方案）、可研目录生成 / 调整是否用到命令工具 | 第 5 步拆分计划 | 已核实用到，随第 8 步（见上方） |
| 12 | 所有 `*_tasks` / `task_logs` 由 `jobs` / `job_events` 取代，`loadState` 返回任务状态 | 第 5 步拆分计划 | 6.2，各模块 PR 接入 |
| 13 | 进度推送（`onTaskEvent`、`knowledgeBase.onEvent`、`onBalanceInsufficient`） | 第 5 步、第 3 步 | 6.3、6.4（`onBalanceInsufficient` 由 `job` 事件的 `pauseReason` 取代，已完成 #27）、6.13 |
| 14 | 入队检查余额、运行中耗尽暂停、`jobs.billed_amount`、`usage_records.job_id`（决定不加外键，见“决定事项”第 10 项） | 第 2、3 步（`SERVER_DESIGN.md` 第 10.3、10.8 节） | 6.4，已完成（#27） |
| 15 | AI 网关在 worker 中运行；按组织 + 服务商的并发信号量（Redis），取 `org_settings.concurrency_limit` 与平台上限的较小值 | 第 3 步（旧仓库 PR #32）、5.3（#9） | 6.4，已完成（#27） |
| 16 | 限流从进程内存换成 Redis | 第 2 步（旧仓库 PR #29） | 6.14 |
| 17 | `/readyz` 加入 Redis 检查 | 第 2 步（旧仓库 PR #27、#28） | 6.1，已完成（#24） |
| 18 | `checkBidSections` 在 worker 中计算，并消除正则的平方级回溯 | 5.11（#20） | 6.11 |
| 19 | 导入招标文件前取消本项目的后台任务；导入原方案时校验原图资源 | 5.11（#20） | 6.11（取消）、6.6（解析时校验原图资源，已完成 #30：Markdown 引用的图片必须都在解析输出中） |
| 20 | 可研“正文生成或审校运行中不能改目录 / 手工改正文”（`assertContentUnlocked`）；服务端合并资料（`readCombinedSourceMarkdown`） | 5.10（#19） | 6.12 |
| 21 | 技术方案“正文生成运行或暂停中不能调整目录 / 手工改正文”、重置正文时取消正文生成任务、`saveGlobalFacts` 写“手工保存”任务记录 | 5.12（#21）、5.13（#22） | 正文生成任务随第 8 步，锁和取消随它一起做；“手工保存”任务记录建议不迁移（`job_events` 只记任务的事件） |
| 22 | 知识库文档处理中被删除时任务停止；`recoverInterruptedDocuments` 由任务队列负责 | 5.6（#12） | 6.13 |
| 23 | 废标检查由任务合并招标正文、经 `computeSignatures` 写签名 | 5.9（#18） | 6.9，已完成（#35） |
| 24 | 冻结到期收尾从 api 定时器移到 worker | 第 3 步（旧仓库 PR #32，原由 `src/server.ts` 定时执行） | 6.8，已完成（#33，改由 worker 的清理任务每批执行） |
| 25 | 平台故障导致的重复调用不收费：结算后、checkpoint 前崩溃的步骤续跑时不再扣费（步骤结果与 checkpoint 同一事务提交，或步骤幂等键） | 6.4（#27 确认时登记） | 6.4a，已完成（#34：步骤幂等键，结果与结算同一事务提交，见“步骤幂等（#34，6.4a）”） |
| 26 | 平台模型的上下文长度：桌面版由用户按模型配置 `context_length_limit`（默认 400,000 字），任务据此决定是否分段；Web 版 `platform_models` 没有这一项，6.9 起的任务一律用默认值（`src/ai/textSplit.ts`），超过模型实际上下文时服务商报错、不收费、任务失败 | 6.9（#35） | 建议在 6.11（招标解析，输入最长）之前给 `platform_models` 加上下文长度（涉及修改已有表与平台管理接口，需确认） |
| 27 | JSON 输出模式：桌面版的 JSON 请求带 `response_format: json_object`，网关的 `ChatRequest` 没有这一项（`request_hash` 也不含它），6.9 的 JSON 请求只靠提示词约束、解析失败时修复和重试（与桌面版相同的 3 次） | 6.9（#35） | 需要时在网关加入（改请求哈希的计算，只影响新的调用），随 6.11 或之后评估 |

#### Redis 接入（#24，6.1）

- **Valkey 8**（决定事项第 3 项）：`valkey/valkey:8.1.10-trixie` 按 digest 固定，compose 与 CI 用同一 digest。启动脚本 `server/redis/start-valkey.sh` 由 compose 和 CI 共用：禁用 `default` 用户，只有 ACL 用户 `bidtools`，密码取自 Docker secret（ACL 文件只写 SHA-256，放在 tmpfs）；`bidtools` 可访问全部键和频道，但不能执行 `@admin` 类命令（`CONFIG`、`ACL`、`DEBUG`、`SHUTDOWN`、`MONITOR` 等）和 `FLUSHALL` / `FLUSHDB` / `SWAPDB`；不持久化（`SERVER_DESIGN.md` 第 8.4 节），`maxmemory-policy noeviction`（BullMQ 的要求）。容器以镜像中的 `valkey` 用户（999）运行，只读根文件系统、`cap_drop: ALL`、`no-new-privileges`，不经镜像入口脚本（它以 root 启动再降权）。6.2 起 BullMQ 若需要被禁止的命令，在同一脚本中调整并说明；
- **网络**：redis 只在新建的 `backend` 网络上，api 同时加入 `default` 和 `backend`，postgres、s3、migrate 解析不到 `redis`（已实测）。开发环境要把端口映射到 `127.0.0.1:6379` 供本机集成测试，`backend` 没有设为 `internal`（internal 网络不能映射端口）；生产按 `SERVER_DESIGN.md` 第 8.1 节设为 `internal: true`、不映射端口；
- **配置**：`REDIS_URL`（`redis://` 或 `rediss://`，可带 ACL 用户名，不接受密码、库号路径、查询串）与 `REDIS_PASSWORD` / `REDIS_PASSWORD_FILE`（`init-dev-secrets.sh` 生成 `redis_password`）。偏离计划：**未设置 `REDIS_URL` 时 Redis 关闭**，`/readyz` 不检查、启动时写一条警告，与 `S3_BUCKET`、`AI_KEK_FILE` 的处理一致；6.1 还没有任何功能用到 Redis，6.2 接入任务队列时改为必需；
- **客户端**：`ioredis` 6.0.0（MIT，BullMQ 6 的 peer 依赖为 `ioredis >=5`，6.2 沿用同一个包）。`src/redis.ts` 只提供 `ping` / `destroy`：关闭离线队列（未连接时命令立即失败，`/readyz` 不会等待重连、Redis 长时间不可用时也不堆积命令），命令超时 2 秒，断线后按最长 5 秒的间隔自动重连，连接错误写 warn 日志（不含密码）。`/readyz` 并行检查数据库和 Redis，每个失败的依赖分别写日志，响应仍只有固定的 `status`；
- **CI**：偏离计划中的“服务容器”：服务容器不能指定启动命令、不能挂载仓库中的启动脚本，所以和 SeaweedFS 一样在步骤中 `docker run`，参数与 compose 相同；`tests/db/redis.test.ts` 覆盖正确凭据、错误密码（响应和日志不含密码）、`default` 用户被禁用、不可达时 4 秒内返回 503、应用用户执行 `CONFIG` / `FLUSHALL` / `ACL` 被拒绝。

#### jobs 表与 worker 骨架（#25，6.2）

- **原则**：`jobs` 是任务状态的唯一权威；Redis（Valkey）不持久化，BullMQ 中的内容随时可能全部丢失，所以任何“任务在不在、该不该执行、执行到哪”都只看 `jobs`。BullMQ 只负责派发：任务 id 就是 `jobs.id`（重复放入是空操作），数据只有 `orgId`，`attempts = 1`、完成或失败后立即删除，失败和续跑由 `jobs` 的状态机决定。
- **迁移 0021**：`jobs`（`SERVER_DESIGN.md` 第 5.1 节的字段，`group` 改为 `lock_key`，另有 `pause_requested`、`run_id`、`lease_expires_at`；`project_id` 可空，不空时由复合外键保证同组织、新建时项目必须未删除）与 `job_events`（取代 `task_logs`，只追加：应用角色只有 `SELECT`、`INSERT`）。两表强制 RLS，按 `app.org_id` 隔离，新建时 `user_id` 必须是当前用户、状态只能是 `queued`；`type`、`params`、`user_id`、`lock_key`、`org_id` 写入后不能改（列级授权），没有 `DELETE`；已结束的任务不能再改（`JB001`）；状态与 `run_id`、租约、结束时间、错误代码的组合由 `CHECK` 约束。互斥为部分唯一索引 `UNIQUE (org_id, lock_key) WHERE status IN ('queued','running','paused','cancelling')`，冲突返回 409 `JOB_LOCKED`。
- **不丢失、不重复执行**：
  - 入队先写 `jobs`、提交后才放进 BullMQ；放入失败（Redis 不可用）不报错，任务仍是 `queued`；
  - 认领（`claimJob`）在同一组织的咨询锁内把 `queued` 改为 `running`，生成 `run_id` 和租约（默认 60 秒，每 15 秒续租）；只有 `queued` 能被认领，所以同一任务被派发多次（重复投递、对账与入队同时放入、BullMQ stalled 后再派发）也只执行一次；
  - 认领后的每次写入（进度、checkpoint、日志、结束）都带 `run_id` 条件（隔离令牌）：租约被收回后，原执行者的写入只影响 0 行，结果丢弃；
  - **对账**（worker 启动时、发现 Redis 数据丢失时、每 15 秒）：跨组织列出 `queued` 和租约过期的 `running` / `cancelling`，逐个在其组织的上下文中处理：`queued` 重新放进 BullMQ；租约过期的按请求收尾（`cancelling` → `cancelled`，已请求暂停 → `paused`），否则可续跑的类型回到 `queued` 再派发、从 checkpoint 继续，不可续跑的标为 `JOB_INTERRUPTED`；开始执行超过 3 次（可按类型设置）标为 `JOB_ATTEMPTS_EXHAUSTED`；
  - **发现 Redis 数据丢失**：Redis 被清空时连接不会断开，BullMQ 也不会报告，所以 worker 在 Redis 中放一个哨兵键，每次（重新）连上和每 5 秒用 `SET NX` 写一次，写入成功即说明数据已丢失（重启或被清空），立即对账；对账有失败时删掉哨兵，下次检查再来一遍。
- **组织级并发**：认领时统计本组织 `running` / `cancelling` 的任务数，达到 3 个（决定事项第 8 项）时本次派发延后 5 秒（BullMQ 延迟任务），任务留在 `queued`。各队列并发按设计第 5.2 节（`parse` 4、`ai` 8、`agent` 2、`export` 2）。
- **执行**：TenantContext 取自任务记录（组织、发起用户）和该用户当前在组织中的角色，不取自派发数据；用户已被移出组织时不执行（`JOB_USER_REMOVED`）。派发数据中的 `orgId` 只用来设置认领事务的组织上下文，与任务不符时在 RLS 下查不到任务，按不存在处理。worker 的系统操作（认领、续租、结束、对账）经新的 `withOrgContext()`（只设置 `app.org_id`，要求 `app.user_id` 的策略一律不成立）。任务失败时只有 `JobError` 的代码和文案写入任务，其他错误记为 `JOB_FAILED`，内部消息只写日志。
- **取消、暂停、继续**（`src/jobs/service.ts`）：`queued` / `paused` 取消即 `cancelled`；`running` 取消为 `cancelling`、暂停为记下 `pause_requested`，执行者经续租发现后中止（`AbortSignal`），在检查点退出后变为 `cancelled` / `paused`（保留 checkpoint）；`paused` 继续即回到 `queued` 并派发。worker 收到 SIGTERM 时中止执行中的任务，可续跑的回到 `queued`。
- **接口**：`GET /api/jobs?projectId=&active=&limit=`、`GET /api/jobs/:jobId`（含最近 200 条事件）、`POST /api/jobs/:jobId/cancel`。任务在组织内共享（与项目相同），成员都可以查看和取消；其他组织的任务返回 404；响应不含参数和 checkpoint。入队、暂停、继续没有接口，由各业务模块的 PR 按需开放。
- **worker 进程**：`src/worker.ts`，与 api 同一镜像、入口 `node dist/worker.js`；compose 新增 `worker` 服务（`default` + `backend` 网络，只拿应用角色密码和 Redis 密码，`/healthz`、`/readyz` 只监听容器内回环地址供 `HEALTHCHECK` 使用，`stop_grace_period: 30s`）。`src/jobs/registry.ts` 中还没有业务任务类型；测试用的两个任务类型（可续跑、不可续跑）只在 `tests/db/jobFixtures.ts` 中登记。
- **依赖**：`bullmq` 6.3.11（MIT，2026-10-01 发布）；新增传递依赖 `cron-parser` 5.10.1、`luxon` 3.7.2、`msgpackr` 2.1.0、`msgpackr-extract` 3.0.4（可选，原生加速）、`node-gyp-build-optional-packages` 5.2.2、`node-abort-controller` 3.1.1，均为 MIT。BullMQ 在 6.1 的 ACL 下正常工作（Lua 脚本、`CLIENT SETNAME` 不属于 `@admin`），`start-valkey.sh` 不需要调整。
- **测试**：`tests/db/jobQueue.test.ts`（真实 Valkey）覆盖：执行一次与事件；重复投递只执行一次；伪造的派发组织；清空 Redis 后排队中、延后中、执行中的任务全部恢复且各执行一次（执行中的任务租约有效，不被收回）；worker 与 Redis 一起“重启”；worker 运行中 Redis 被清空，经哨兵自动对账；入队时 Redis 不可用；**真实重启 Valkey**（CI 中 `docker restart valkey`，由 `TEST_REDIS_RESTART_COMMAND` 指定）后不手动对账、任务不丢失不重复；执行者崩溃后从 checkpoint 续跑、原执行者的写入被隔离；不可续跑类型、超过执行次数；worker 正常关闭后续跑；组织级并发；互斥；取消、暂停、继续。#29 修复了其中的测试竞态：`tests/db/jobFixtures.ts` 的 `wipeQueueKeys` 原先分批 `SCAN` + `DEL`，运行中的 worker 可以在两批之间取走任务并写下锁，使锁逃过删除（真实的清空是原子的，不会出现）；改为在一个 Lua 脚本中完成。清空后运行中的 worker 会合法地重建 `delayed`、`meta`、`events` 等通用键，所以“清空后键数为 0”的断言改为“被清空的任务不再被任何键引用”（`queueKeysReferencing`，清空后立即与 300 ms 后各查一次）。`tests/db/jobs.test.ts` 覆盖 RLS、列级授权、约束、`JB001`、并发入队互斥、并发认领只有一次成功、对账函数（只返回 id，分页不重复）、`bidtools_jobs` 的属性与权限（只对 `jobs` 的 5 列有 `SELECT`，对其他表包括计费表没有任何权限）和接口。

偏离计划（均需确认）：

1. **新增定义者角色 `bidtools_jobs`**（拆分计划未列出，因此本 PR 改为“需确认后合并”）。对账要跨组织找出未结束的任务，应用角色在 RLS 下做不到；照 `bidtools_storage` 的做法建 `NOLOGIN`、无 `BYPASSRLS` 的属主角色，是 `SECURITY DEFINER` 函数 `jobs_dispatch_candidates` 的属主，只对 `jobs` 的 `id`、`org_id`、`status`、`lease_expires_at`、`created_at` 有列级 `SELECT` 和为它建的只读策略；函数只返回任务 id、组织 id 和入队时间，每个任务之后的处理仍按其组织经 RLS 进行。已加入 `10-provision.sh`、测试 harness 和第 9 步上线检查“数据库角色”一条；已有的开发数据卷需要 `docker compose down -v` 重建。已知限制：api 与 worker 共用应用角色，api 进程也能调用该函数（只能得到 id）；以后 worker 改用独立的登录角色时，只把执行权授给它。
2. **崩溃恢复不依赖 BullMQ 的 stalled 检测**（拆分计划写的是“由 stalled 检测转交”）：Redis 被清空后 BullMQ 的执行中记录和锁都不在了，stalled 检测无从发现；改为数据库租约 + 对账，BullMQ 的 stalled 检测只会造成重复投递，由认领条件挡住。
3. **取消、暂停信号经续租轮询数据库**（设计第 5.6 节写的是发布 `cancel:{jobId}`）：最长延迟一个续租间隔（15 秒）；6.3 接入 Redis 发布订阅后可以缩短，数据库仍是权威。
4. **api 的 `REDIS_URL` 仍是可选**（6.1 写的是“6.2 接入任务队列时改为必需”）：6.2 没有入队接口，api 不使用队列；worker 未设置 `REDIS_URL` 时拒绝启动。第一个提供入队接口的业务 PR 给 api 接上派发，Redis 不可用时任务由对账派发。

#### SSE 推送（#26，6.3）

做法见 `docs/SERVER_DESIGN.md` 第 5.5、5.6 节。没有新增依赖、没有迁移，`client/` 未改动。要点：

- **键与脚本**（`src/events/stream.ts`）：每个组织一条 Stream `stream:org:{orgId}` 和一个频道 `events:org:{orgId}`。发布是一个 Lua 脚本，原子地 `XADD`（ID 由 Redis 生成、单调递增）→ 按 1000 条和 10 分钟裁剪 → `PEXPIRE` 10 分钟 → 向频道 `PUBLISH` “ID 空格 JSON”。补发也是一个脚本：Stream 不存在、上次的 ID 比最后生成的还大、或比下限还小时返回 `resync`，否则返回之后的全部事件。事件 64 KB 以内，类型限 `[a-z][a-z0-9.-]*`；
- **发布**（`src/events/publisher.ts`）：worker 和 api 在事务提交之后调用，尽力而为：Redis 不可用时写一条 warn 日志并丢弃，不影响任务（第 8.4 节“进度事件可丢”），丢了的由前端重连时的 `resync` 兜底。只在首次连上之前等待（最多 2 秒），之后断线期间立即丢弃，不拖慢任务；
- **订阅**（`src/events/hub.ts`，api 进程）：一条订阅连接，按组织引用计数 `SUBSCRIBE`；新连接先订阅（等 Redis 确认），期间的实时事件先缓存，再按 `Last-Event-ID` 补发，最后按 ID 去重放出缓存，所以补发与实时之间不漏、不重。指定了 `userId` 的事件只送给该用户（任务事件不指定，组织内共享，与 `GET /api/jobs` 一致）；
- **接口**（`src/routes/events.ts`）：`GET /api/events`，需要登录，组织和用户取自会话。开头 `retry: 3000`，补发之后推一条不带 id 的 `ready`（前端先等 `ready` 再拉快照），每 25 秒一条注释行心跳；每 60 秒经 `auth_session_lookup` 重新校验会话，会话过期、被吊销、用户被停用或移出组织后推 `closed`（`reason: session`）并断开；订阅连接断开（`unavailable`）、服务关闭（`shutdown`，在 `preClose` 中断开，不阻塞关闭）、客户端积压超过 1 MB（`overflow`）同样推 `closed` 后断开。每个用户在本进程中最多 10 条连接，超出 429 `EVENTS_TOO_MANY_CONNECTIONS`；未配置或连不上 Redis 时 503 `EVENTS_UNAVAILABLE`。响应带 helmet 的安全头、`Cache-Control: no-store`、`X-Accel-Buffering: no`、`Connection: close`；
- **任务事件**（`src/jobs/notify.ts`）：`job`（任务当前状态，与 `GET /api/jobs/:jobId` 的任务部分相同，状态变化后重新读出再推送）、`job.progress`、`job.log`（与 `events` 相同，不含事件数据），都不含参数和 checkpoint。worker 在认领、进度、日志、结束、对账改变状态后推送；api 在入队、取消、暂停、继续后推送（`POST /api/jobs/:jobId/cancel` 已接入）。`jobBody` 从路由移到 `src/jobs/view.ts` 供两处共用；
- **控制频道**：取消、暂停后 api 向 `{BullMQ 前缀}:jobs:control` 发布任务 id，worker 收到后对正在执行的该任务立即续租一次，从 `jobs` 读到请求并中止，不必等到下一次续租（6.2 最长 15 秒）。消息不被信任，只触发一次查询；错过时最迟在下一次续租发现。
- **测试**：`tests/db/events.test.ts`（真实 PostgreSQL 与 Valkey）覆盖：组织隔离与按用户过滤、退订与重新订阅；补发、补发与并发发布交错时不漏不重；`resync` 的四种情况（ID 格式不对、不是这条 Stream 生成的、Stream 不存在、之后的事件已被裁剪）与仍在窗口内的补发、条数与过期时间；Redis 不可达；接口的 401 / 503、响应头、心跳、任务从入队到结束的推送（同组织的另一用户收到、其他组织收不到）、HTTP 上的 `Last-Event-ID`、会话吊销与移出组织、连接数上限、取消经控制频道在续租间隔 15 秒时立即生效、服务关闭；**真实重启 Valkey**（`TEST_REDIS_RESTART_COMMAND`）后连接推 `closed` 断开、重连得到 `resync`。`tests/events/stream.test.ts` 覆盖 ID 比较、事件解析与序列化（换行经 JSON 转义，不能伪造 SSE 字段）。

偏离计划与设计：

1. **控制频道是一个 `jobs:control`**（设计第 5.6 节写的是每个任务一个 `cancel:{jobId}`，并标为“随 6.3 接入”，拆分计划的 6.3 一行没有列出）：worker 不必按任务订阅、退订；暂停也走同一频道。消息只有任务 id，伪造的消息最多引起一次多余的查询。设计文档已同步；
2. **补发的下限不用 `max-deleted-entry-id`**：实测 Redis 7 / Valkey 的 `XTRIM` / `XADD MAXLEN` 裁剪不更新这个字段（只有 `XDEL` 更新），所以改为“没有 `XDEL` 时以第一条的 ID 为下限”：上次的 ID 比第一条还小，就是之后的事件已被裁剪，或者来自已过期的上一条同名 Stream，都推 `resync`；
3. **Redis 断开时关闭所有推送连接**，而不是在 api 中重连后逐个补发：订阅连接断开期间的实时事件已经错过，由浏览器重连时带 `Last-Event-ID` 补发，逻辑只有一份。Redis 不可用期间 `GET /api/events` 返回 503，浏览器的 `EventSource` 遇到非 200 会停止自动重连，所以**第 9 步的 `WebBridge` 要自己按退避间隔重建连接**（已加入第 9 步上线检查）；
4. **连接数上限是每个 api 进程各自计数**：多实例时一个用户最多 实例数 × 10 条；扩展为多个 api 实例前改为跨实例计数（已加入第 9 步上线检查“实时推送”一条）；
5. **推送连接不延长会话**：建立连接时照常经登录钩子续期，之后长时间打开的页面不会让会话一直有效，到期后推 `closed` 断开；
6. **`job` 事件的到达顺序可能与提交顺序不同**（并发变化时各自重新读出再推送），前端按 `updatedAt` 取较新的一条；任务状态的权威始终是 `jobs` 表。

#### worker 接入 AI 网关与余额（#27，6.4）

做法见 `docs/SERVER_DESIGN.md` 第 5.3、10.1、10.3、10.10 节。`client/` 未改动，没有新增依赖。要点：

- **迁移 0022_job_billing**：
  - `jobs.billed_amount`（`bigint`，计费单位）：`ai_usage_settle` 在插入扣费、更新用量记录的同一事务中累加，只增不减（触发器 `JB002`）；应用角色没有该列的 `UPDATE` 权限，入队时也不能指定。任务已结束后才到达的结算（执行者失联后原调用才结束）照常扣费并累加，`jobs_guard` 改为已结束的任务只允许累加 `billed_amount`、其他列仍报 `JB001`、`updated_at` 不变；
  - `usage_records.job_id` 按决定事项第 10 项**不加外键**，只保留 `job_id` / `job_type` 的值；任务记录被保留期清理删除后，累加影响 0 行，扣费照常；
  - `ai_usage_begin`：`source = 'job'` 时任务必须属于本组织且状态为 `running`（`queued`、`paused`、`cancelling`、已结束、其他组织的任务一律 `BL015` → 409 `JOB_NOT_RUNNING`，不冻结、不写用量记录）；`job_type` 取任务记录中的值，传入的值与之不符时拒绝；
  - 计费角色 `bidtools_billing` 新增对 `jobs` 的列级 `SELECT (id, org_id, type, status, billed_amount)`、`UPDATE (billed_amount)` 和只限当前组织（`app.org_id`）的两条策略，没有新增数据库角色；
  - `jobs.pause_reason`：只在 `paused` 时可以有值（`CHECK`），目前只有 `insufficient_balance`；继续、取消时清除；
  - `billing_job_start_check()`：可用余额（余额 − 未到期的冻结）低于 `JOB_MIN_START_BALANCE`（10,000 计费单位 = 1 元，决定事项第 7 项，写在迁移中）时 `BL001` → 402 `INSUFFICIENT_BALANCE`。
- **入队与继续**（`src/jobs/service.ts`）：任务类型定义新增 `billable`（会调用模型）；`billable` 的任务入队时在写入的同一事务中检查最低启动余额，不足时不写任务；从 `paused` 继续前同样检查，不足时 402、任务仍是 `paused` 并保留原因。不调用模型的任务（解析、导出、清理）不检查。
- **worker 中的调用**（`src/jobs/runner.ts`、`src/worker.ts`）：worker 加载主密钥（compose 的 `worker` 服务新增 `ai_kek` secret 和 `AI_KEK_FILE`），创建同一个 AI 网关模块；任务经 `context.ai.chat()` 调用，`source: 'job'`、`jobId`、`jobType` 由执行者填写，任务被取消、暂停时随 `signal` 中止，已产生的用量照常结算。冻结失败（余额不足）时抛 `JobBalanceExhaustedError`，之后本次执行中的调用直接失败（任务吞掉错误也不能继续花钱），执行结束后 `finishRun` 把任务改为 `paused` / `insufficient_balance`（已请求取消时仍为 `cancelled`），写一条带原因的 `paused` 事件，经 6.3 的 `job` 事件推送（`pauseReason` 字段，取代设计中的 `onBalanceInsufficient`）。用户充值后“继续”，任务从上次的 checkpoint 开始：已扣费的调用其结果已写入 checkpoint，不会重做、不会重复扣费（测试中 4 步的任务在第 3 步暂停，继续后服务商共收到 4 次请求、扣费 4 次）。网关的其他错误转成 `JobError`（代码和文案与接口相同）；未配置主密钥时 `AI_UNAVAILABLE`。
- **并发信号量**（`src/ai/concurrency.ts`）：每个“组织 + 服务商”一个 Redis 有序集合，获取是一个 Lua 脚本（删掉到期的名额，未满时加入本次的随机令牌，分值为到期时间，用 Redis 服务器时钟），释放即删除令牌；名额最长占用一个冻结时长（`AI_HOLD_TTL_SECONDS`），进程崩溃未释放时到期自动收回。上限取 `org_settings.concurrency_limit`（默认 10）与平台上限 `AI_CONCURRENCY_MAX`（新配置，默认 10）的较小值。网关在白名单检查之后、解密 Key 和冻结之前取得名额，调用结束后释放；交互式调用最多等 `AI_CONCURRENCY_WAIT_MS`（新配置，默认 30 秒）后 429 `AI_CONCURRENCY_LIMITED`，任务中的调用一直等到被取消。Redis 不可用时不放行（交互式调用等待超时后 503 `AI_CONCURRENCY_UNAVAILABLE`），api 未配置 `REDIS_URL` 时不限制并发（与 6.3 之前的行为相同）。
- **测试**：`tests/db/jobBilling.test.ts`（真实 PostgreSQL、Valkey 和本机模拟服务商）覆盖：`billed_amount` 与本任务扣费一致、到期冻结和交互式调用不计入、任务结束后才到达的结算、只增不减、应用角色和计费角色的列级权限、`pause_reason` 约束；冻结时的任务检查（其他组织、不存在、`queued` / `paused` / `cancelling` / 已结束、类型不符）；最低启动余额（恰好 1 元、差 1 个单位、进行中的冻结占用、不调用模型的任务、调用方不能绕过）；从暂停继续的余额检查；运行中余额耗尽暂停（已完成的调用按实际用量扣费、暂停后没有进行中的冻结）、推送、充值后续跑不重复调用和扣费；调用进行中取消任务（立即关闭上游连接、按已产生的用量估算结算且不超过冻结额、冻结释放、不再发起后续调用）；worker 在调用中途崩溃（冻结到期后不再占用余额、清理后标为 abandoned 不收费，租约过期后从 checkpoint 续跑，已扣费的步骤不重做）；任务吞掉余额错误；上游错误和未配置网关；排队等名额时取消；信号量的上限、等待超时、释放、互不影响、20 个并发获取只成功 3 个、到期收回、取消、Redis 不可用；网关按组织设置与平台上限的较小值限制并发、超时不冻结不调用服务商。去掉结算中的累加、冻结时的任务检查、入队门槛、已结束任务的列保护、信号量的上限判断，分别有 3、1、3、1、6 个用例失败。

偏离计划与设计：

1. **入队门槛只对会调用模型的任务类型生效**（设计第 10.3 节写的是“该任务类型的最低启动额度，默认 1 元”，决定事项第 7 项是“全局 1 元”）：解析、导出、清理任务不花钱，余额为 0 也应该能导入文件；按任务类型的不同额度仍按决定事项第 7 项“有需要时再加”；
2. **任务调用要求任务正在执行**（拆分计划未列出）：防止失联的旧执行者或其他组织的任务编号继续冻结和扣费，`cancelling` 的任务也不再开始新的调用；
3. **已结束的任务允许累加 `billed_amount`**：调整了 6.2 的 `jobs_guard`（其他列仍不可改），否则执行者失联后才结束的调用会因 `JB001` 结算失败，变成“上游已收费、用户未扣费”；
4. **余额不足的暂停不经 `pause_requested`**：执行者在本次执行结束时直接写入 `paused` / `insufficient_balance`，不需要等一次续租；
5. **新配置 `AI_CONCURRENCY_MAX`、`AI_CONCURRENCY_WAIT_MS`**（拆分计划只写了“平台上限”）；
6. **冻结到期收尾（`expireStaleHolds`）仍在 api 的定时器中**，按拆分计划随 6.8 移到 worker（已完成，#33）。

**已知缺口（#27 确认时登记为 6.4a，必做；已由 #34 消除，见“步骤幂等（#34，6.4a）”）**：任务中的一次调用已结算、任务还没保存 checkpoint 时 worker 崩溃，续跑会重做这一步并再次扣费（两次调用在服务商侧都真实发生）。原则是平台自身故障导致的重复调用不向用户收费，所以在第一个调用 AI 的业务任务 PR 之前，用“步骤结果与 checkpoint 同一事务提交”或“步骤幂等键”消除这个窗口，并加入第 9 步上线检查。其余情况已有测试：冻结后、结算前崩溃的调用不收费，已保存 checkpoint 的步骤不重做。

#### 解析沙箱基础设施（#28，6.5）

按“文件解析的隔离”的方案 B 和决定事项第 1、2、5 项实现，做法见 `docs/SERVER_DESIGN.md` 第 7.5 节。只建基础设施，不解析任何文档（6.6 起）；没有迁移，`client/` 未改动，没有新增 npm 依赖。要点：

- **`SandboxDriver`**（`src/sandbox/driver.ts`）：`create / copyIn / exec / copyOut / destroy`，两个实现：sandbox-runner 进程内直接调用 Docker Engine API 的 `createDockerSandboxDriver`（`src/sandbox/docker.ts`，经 unix socket 的最小客户端 `dockerApi.ts`，无第三方依赖），和 worker 中经 HTTP 调用 sandbox-runner 的 `createSandboxRunnerClient`（`src/sandbox/client.ts`）；
- **`parse` 模板**（`src/sandbox/templates.ts`，写死在代码中）：`--network none`、只读根文件系统、用户 10001、`cap-drop ALL`、`no-new-privileges`、`--init`、内存 2 GiB 无 swap、CPU 1 核、`pids` 256、`nofile` 1024，`/tmp`、`/input`、`/output` 为 `noexec,nosuid,nodev` 的 tmpfs（1 GiB / 256 MiB / 1 GiB），不挂载任何宿主目录和卷、不注入宿主环境变量、不保留容器日志；可执行的命令只有 `parse`（`node /opt/parse/entry.mjs` + 至多 8 个不含路径的参数，墙钟 10 分钟，超时即终止整个沙箱）；沙箱最长存活 15 分钟；
- **sandbox-runner**（`src/sandbox-runner.ts`，与 api 同一镜像、入口 `dist/sandbox-runner.js`）：唯一挂载 Docker socket 的服务；接口只收“模板名 + 任务 id”和模板中的命令名与参数（多余字段 400），每个请求带共享令牌（Docker secret `sandbox_runner_token`），之后的操作带 `X-Sandbox-Job`。状态全在容器标签中（模板、任务 id、到期时间），本身无状态；每次操作按名称查出容器并核对标签，不是本服务创建的、任务不符、已到期或已停止的一律 404，不能借它在其他容器中执行命令。同时存在的沙箱数上限 8（`SANDBOX_MAX_ACTIVE`），到期的每 30 秒删除。启动时检查配置的运行时已在 Docker 中登记；生产环境 `SANDBOX_RUNTIME` 只能是 `runsc`、`SANDBOX_PARSE_IMAGE` 必须按摘要固定，否则拒绝启动；
- **输入输出**：经 exec 中的 `tar` 传送（`src/sandbox/archive.ts`，读写 tar 均无第三方依赖）。放入前按模板检查（只有普通文件、一层路径、至多 4 个、单个 128 MiB）；取回的归档来自沙箱，按不可信输入在 worker 中逐项校验，任一项不符整体拒绝（`SANDBOX_OUTPUT_REJECTED`）：只收普通文件（拒绝符号链接、硬链接、设备文件、FIFO、稀疏文件等）、路径按段校验（`..`、绝对路径、隐藏在 ustar prefix / PAX / GNU 长名中的穿越）、至多两层、至多 2,010 个文件、单个 100 MiB、合计 1 GiB、扩展名只有 `md json png jpg jpeg gif webp bmp`、同一路径不能出现两次、头部校验和正确、必须有结束块；流的字节数超过上限即中止；
- **镜像**（`server/sandbox/parse/Dockerfile`）：与 api 相同的 Node 24 基础镜像（按 digest 固定）+ `libreoffice-writer-nogui`、`libreoffice-calc-nogui` + `fonts-noto-cjk`、`fonts-dejavu-core`；删除 npm / corepack / yarn、去掉全部 setuid / setgid 位，建用户 10001；没有凭据、编译器、网络工具；
- **compose**：新增 `sandbox-runner` 服务和 `internal: true` 的 `sandbox-control` 网络（只有 sandbox-runner，6.6 起 worker 加入），`init-dev-secrets.sh` 生成 `sandbox_runner_token`；开发环境先 `docker build -t zhibiao-parse:dev server/sandbox/parse`，Linux 上设置 `DOCKER_SOCKET_GID`；
- **CI**：`server-checks` 安装 gVisor（`runsc` 20260810.0，Apache-2.0，按写死的 SHA-512 校验），登记为 Docker 运行时后 reload（不重启 Docker），构建 parse 镜像，在 `runsc` 下跑 `npm run test:sandbox`（含 LibreOffice 转换用例）；job 超时从 15 分钟改为 30 分钟；
- **测试**：单元测试（`tests/sandbox/*.test.ts`）覆盖构造的恶意归档（各种条目类型、穿越、校验和、截断、超量、PAX 键）、模板参数、配置、sandbox-runner 接口（令牌、多余字段、未登记的命令、任务不符、worker 端校验）。隔离测试（`tests/sandbox/docker/isolation.test.ts`，真实 Docker）：只有 `lo`，连接 Docker 网桥网关上的监听端口、`169.254.169.254`、外网、内网地址、UDP 全部失败，`redis` / `postgres` 等名称解析失败；根文件系统只读（`EROFS`）、`/tmp` 不能执行、用户 10001、无能力、`NoNewPrivs`；没有 setuid 程序、网络工具、包管理器和编译器；容器参数与模板一致；资源上限见下方“资源上限实测”；输入输出往返；取回时符号链接、硬链接、FIFO、超量文件、不允许的扩展名、过深路径、不安全文件名被拒绝；两个沙箱之间不共享任何文件；数量上限、到期清理；经 HTTP 的完整流程只能执行登记的命令、不能操作冒名的容器。**对照组**：去掉 `--network none` 后同一探测能连上宿主（含 sandbox-runner）、去掉只读后根以 `rw` 挂载、去掉内存 / pids / CPU 上限后同样的分配、进程数、并行度能达到、原始归档中确有被校验拒绝的符号链接条目，证明测试能发现这些加固被去掉。#28 确认前补充了资源上限与访问控制的用例后共 35 项：本机（runc、不含 LibreOffice 的镜像）32 项通过、3 项 LibreOffice 用例跳过，CI（GitHub 托管运行器，gVisor `runsc` 20260810.0）34 项通过、1 项跳过（CPU 对照组，要求宿主至少 3 核）。gVisor 下只读根文件系统对非 root 用户的写入返回 `EACCES`（先检查权限），所以测试改为核对根挂载的 `ro` 选项。

**资源上限实测**（`tests/sandbox/docker/isolation.test.ts` 的 `resource limits`，每项都验证宿主不受影响：Docker 照常响应、新建的沙箱 15 秒内能执行命令）：

| 场景 | 用例 | 结果 | 宿主侧的断言 | 对照组 |
|---|---|---|---|---|
| 内存超限（分配 4 GiB） | `kills a process that exceeds the memory limit without exhausting host memory` | 进程被终止（退出码非 0，没有输出“allocated”） | 期间宿主可用内存的最低值比开始时少不到 2 GiB + 768 MiB | 去掉内存上限后同样的分配成功 |
| 进程数 | `limits the number of processes` | 同时启动 400 个进程，成功的少于 256 个，其余 `EAGAIN` | — | 去掉 pids 上限后 400 个全部启动 |
| fork 炸弹 | `contains a fork bomb without flooding the host` | `bomb() { while :; do bomb & done; }` 在 pids 上限处被挡住。runc：`Cannot fork`，8 秒超时后整个沙箱被终止（宿主线程增量 257）。gVisor：约 0.4 秒后 runsc 的控制通道断开（exec 以 128 返回，`containerManager.WaitPID failed: EOF`），**容器仍在运行**（宿主线程增量 230），销毁后才结束 | 期间宿主线程总数的增量少于 pids 上限 + 64；销毁后容器不存在、10 秒内宿主线程数回落到基线 + 64 以内 | （去掉 pids 上限的炸弹会拖垮 CI 运行器，用上一行的对照组代替） |
| 写满临时目录 | `stops writes when a scratch directory is full and does not touch the host disk` | `/tmp`、`/input`、`/output` 分别写到各自上限（1 GiB / 256 MiB / 1 GiB）时 `ENOSPC` | 宿主根文件系统的可用空间减少不到 64 MiB（可写目录都是 tmpfs，根只读） | — |
| CPU 死循环 / 超时 | `limits a CPU busy loop to one core and terminates it at the time limit` | 4 个线程空转的总吞吐不到 1 个线程的 1.6 倍（限制为 1 核）；`for (;;) {}` 在 3 秒超时后整个沙箱被终止 | Docker 与新沙箱正常 | 去掉 CPU 上限后 4 线程吞吐超过 1 线程的 2 倍（宿主至少 3 核时运行） |
| 命令超时、调用方中止 | `terminates the sandbox when a command exceeds its time limit`、`… when the caller aborts` | 沙箱被终止，之后的操作 404 | — | — |

由 fork 炸弹的 gVisor 结果得出的约定：**exec 的任何非 0 结果（含超时、128 等运行时错误）之后，调用方都必须销毁沙箱，不再复用**；6.6 的解析任务在 `finally` 中 `destroy`，sandbox-runner 的到期清理（15 分钟）是兜底。沙箱内失控的进程在销毁前仍受内存、CPU、pids 上限约束。

**sandbox-runner 的访问控制**：

- **哪些服务能连到它**：它只监听 `sandbox-control` 网络（`internal: true`：没有出口、不映射端口）。这个网络上只有 sandbox-runner 和（6.6 起）worker；api、postgres、redis、s3 都不在上面，解析不到也路由不到它。生产部署同样（设计第 8.1 节）。
- **令牌如何校验**：每个请求（`/healthz`、`/readyz` 除外，它们只返回固定的 `status`）在路由处理之前由 `onRequest` 钩子检查 `Authorization: Bearer <令牌>`：对请求中的令牌和配置的令牌各取 SHA-256 后用 `timingSafeEqual` 比较（长度固定，不因长度不同提前返回），缺失或不符一律 401。令牌至少 32 个字符，只经 Docker secret（`SANDBOX_RUNNER_TOKEN_FILE`）给 sandbox-runner 和 worker，不写进日志（日志只记方法和路径，有测试）。令牌之外，每个沙箱还绑定任务 id，操作必须带同一个任务 id，并且只能操作本服务创建（带标签）的容器。
- **沙箱容器能否访问它**：不能。沙箱是 `--network none`（只有 `lo`），不在 `sandbox-control` 上，也解析不到 `sandbox-runner`；沙箱内没有令牌。用例 `cannot be reached from inside a sandbox` 让 sandbox-runner 监听所有地址后，从沙箱经网桥网关、`127.0.0.1` 和名称访问都失败，对照组（网桥网络）能访问到。
- **Docker 权限**：sandbox-runner 用到的 Docker API 只有 `GET /_ping`、`GET /info`、`GET /containers/json`（按标签过滤）、`POST /containers/create`、`POST /containers/{id}/start`、`GET /containers/{id}/json`、`POST /containers/{id}/kill`、`DELETE /containers/{id}`、`POST /containers/{id}/exec`、`POST /exec/{id}/start`、`GET /exec/{id}/json`。直接挂载 Docker socket 时它拥有全部 Docker 权限（等同宿主 root），所以生产环境要按第 9 步上线检查“解析沙箱”一条收窄。

**LibreOffice 在 gVisor 下的实测**（“文件解析的隔离”中“以 6.5 的实测为准”）：RTF、OLE `.doc`、HTML（需 `--infilter=HTML (StarWriter)`）转 docx 均成功，沙箱创建约 140–220 ms，单个小文件转换（含 LibreOffice 冷启动）约 2.4–3.4 秒，与计划中“gVisor 约 150–500 ms + LibreOffice 冷启动 1~2 秒”量级一致。**不需要**启用设计第 7.2 节预留的“LibreOffice 改用 runc + 严格 seccomp”方案。

偏离计划（均需确认）：

1. **输入输出经 exec 中的 `tar` 传送，不用 `docker cp`**：gVisor 下 `docker cp` 写不进沙箱内的 tmpfs（只读根文件系统上也不能写）；由沙箱内的 tar 生成的归档按不可信输入在 worker 中校验，sandbox-runner 只原样转出并限制字节数，不在持有 Docker 权限的进程中解析沙箱的输出。
2. **镜像暂不含 `doc2markdown/` 的 npm 依赖和解析入口**（计划写的是“Node 24 + `doc2markdown/` 所需的 npm 依赖 + LibreOffice + 中文字体”）：依赖与入口随 6.6 的分派实现一起加入（另列版本和许可证），6.5 的 `/opt/parse/entry.mjs` 是退出码 64 的占位。LibreOffice 关闭链接更新、不执行宏的全局设置原计划随 6.7，#28 确认时决定**提前到 6.6**，与解析入口同时上线（解析入口上线前镜像中的 LibreOffice 不处理任何上传文件）。
3. **apt 包不按版本固定**：基础镜像按 digest 固定，LibreOffice 等取构建时 Debian bookworm 的当前版本（含安全更新）；部署时按构建出的镜像摘要引用（生产配置强制 `@sha256:`），镜像漏洞扫描随第 9 步。
4. **新增 `sandbox-control` 网络**（设计第 8.1 节原写 sandbox-runner 在 `backend`）：只有 worker 需要调用它，放在单独的 internal 网络上，api、数据库、Redis 都连不到它，它也连不到它们。
5. **worker 尚未接入**：`SANDBOX_RUNNER_URL`、令牌的配置和 `context.sandbox` 随 6.6（第一个使用它的任务）加入，6.5 的 worker 与之前相同（6.6 已接入，#30）。

已知限制：开发环境直接挂载 Docker socket，等同宿主 root，sandbox-runner 被攻破即宿主被攻破，所以它只在 internal 网络上、只接受固定模板；生产环境须用 Docker API 代理或 rootless Docker 收窄（第 9 步上线检查）；worker 共用一个令牌，以任务 id 绑定沙箱只防误用，不防被攻破的 worker。

#### 解析任务（一）二进制与纯文本格式（#30，6.6）

做法见 `docs/SERVER_DESIGN.md` 第 7.6 节。`client/` 未改动。要点：

- **任务**（`src/parse/job.ts`）：`document-parse`，`parse` 队列，可续跑（重来即从头解析），不调用模型（不检查余额）。参数只有 `target`（`technical-plan-tender` / `technical-plan-original-plan` / `rejection-check` / `feasibility-report`）和 `fileId`，项目取自任务记录；互斥键 `document-parse:{fileId}`。流程：文档标为 `running` → 按记录的 MIME 分派（`src/parse/dispatch.ts`）→ 从对象存储取出原件 → 新建 parse 沙箱 → `copyIn`（固定名 `source`，不带文件名）→ 执行解析入口（参数只有 `format=` / `images=` / `charset=`）→ `copyOut`（归档按模板校验）→ 校验输出内容（`src/parse/output.ts`）→ 经 `writeArtifact` 写图片和 Markdown → 经 `saveDocumentParse` / `saveSourceParse` 写回（`status`、`markdownArtifactId`、`contentChars`、`contentHash` = 正文 SHA-256、`parserLabel` = “本地解析”）→ 该文件之前的产物标为已被替换。**沙箱在 `finally` 中销毁**（exec 的任何非 0 结果、超时、中止、取回失败之后同样）；
- **导入后自动入队**（`src/parse/enqueue.ts`）：技术方案导入招标文件、上传原方案（只有新上传的，保留图片），废标检查导入招标 / 投标文件，可研报告导入资料，在导入事务提交之后每个新文件入队一个任务；已有未结束的同一文件任务（`JOB_LOCKED`）时不重复入队。导入接口的响应多了 `addedFileIds`。api 进程 6.6 起在配置了 Redis 时创建派发器（`src/server.ts`），未配置时只写 `jobs`、由 worker 对账派发；
- **分派**：PDF → `pdf`；docx → `docx`；xlsx → `xlsx`；`application/msword`、`application/vnd.ms-works`（OLE 的 .doc / .docx / .wps）→ `word-ole`（LibreOffice 转 docx 后按 docx）；`application/vnd.ms-excel` → `xls-ole`（SheetJS）；`text/plain` / `text/markdown; charset=utf-8|gb18030` → 按记录的编码解码（不经解析器，也在沙箱中）。RTF、HTML、MHT、`application/xml` 记为解析失败 `PARSE_FORMAT_NOT_READY`（6.7 开放），其他类型 `PARSE_UNSUPPORTED_FORMAT`，都不创建沙箱；
- **解析入口**（`server/sandbox/parse/`）：`entry.mjs` + `convert.mjs`（转换逻辑搬自桌面版 `doc2markdown/convert.mjs`，输出尽量一致）+ `zipGuard.mjs`。docx、xlsx 和 LibreOffice 转出的 docx 先做 ZIP 检查：条目数 10,000、声明的解压后总大小 1 GiB、单条目压缩比 100:1，再逐个条目实际解压（只计数）核对不超过声明值（中央目录可伪造）；PDF 先只读出页数，超过 3,000 页拒绝。图片只收 png / jpeg / gif / webp / bmp，至多 2,000 张，写到 `/output/images/image-NNNN.*`。失败时只在标准输出最后一行给错误代码（退出码 65，参数不合法 64），解析库的控制台输出一律丢弃；给用户的文案由 worker 按代码决定，不采用沙箱输出的文字；
- **输出校验**（worker）：只能有 `content.md`、`manifest.json` 和清单中登记的图片（编号连续、MIME 与扩展名一致、文件头与 MIME 一致）；Markdown 必须是合法 UTF-8。Markdown 中的图片引用（含 HTML 表格中的 `<img>`）只保留指向本次输出图片的，改写为 `/api/artifacts/{id}/content`，其他图片（远程地址、`data:`）去掉；引用了输出中没有的图片时整体拒绝（`PARSE_IMAGE_MISSING`“原方案图片资源缺失，请重新导入原 Word”，即桌面版导入原方案时的“校验原图资源”，第 5 步 #20 留下）。表格类格式与桌面版相同以文件名作一级标题（由 worker 加，沙箱中不知道文件名）；
- **失败**：文档标为 `error`，原因写进文档（如“文件的压缩比异常（单个条目超过 100:1），已拒绝解析”“PDF 超过 3,000 页，已拒绝解析”“文件解析超时（超过 10 分钟）”），任务以对应代码失败（`PARSE_*`），之前和写了一半的产物都标为已被替换。程序错误同样把文档标为“文件解析失败”，原错误只写日志（任务 `JOB_FAILED`）。取消时文档标为“解析已取消”；worker 关闭、租约丢失时不写文档，由续跑的执行者重新解析；写回前先确认仍持有租约；
- **沙箱数已达上限**（429 `SANDBOX_BUSY`，“沙箱数已达上限，请稍后重试”）和 sandbox-runner 暂不可用时按可重试处理：任务按 5 秒起、约 5 分钟内的退避间隔重试创建（写任务日志），用完仍不行才失败（`PARSE_SANDBOX_BUSY` / `PARSE_UNAVAILABLE`）。worker 经 HTTP 收到 `SANDBOX_BUSY` 时用同一文案（`SANDBOX_BUSY_MESSAGE`）；
- **迁移 0023_artifact_supersede**：`artifacts.superseded_at`，只能由空设为当前时间一次（时间由触发器写入），只有 `ready` 的产物能被标记，其他列仍不可改（`AR003`），应用角色只多了这一列的 `UPDATE`；`findArtifact`、`listArtifacts` 不再返回已被替换的产物；它们在 6.8 清理之前仍计入配额。RLS 策略、配额函数、数据库角色都没有改；
- **LibreOffice 安全设置**（从 6.7 提前，与解析入口同时上线）：`server/sandbox/parse/libreoffice/zhibiao-security.xcd` 放在镜像的 `share/registry` 下，各项 `finalized`：宏安全级别 3（非常高、没有受信任位置）、`DisableMacrosExecution`、`BlockUntrustedRefererLinks`，Writer 与 Calc 的链接更新为“从不”（2），Writer 的域和图表不在加载时更新。已在 LibreOffice 24.2 上经 UNO 读取配置验证生效，用户配置（每次转换新建在 `/tmp`）中写相反的值也改不了；CI 的完整镜像中由测试核对文件内容并在其下转换 OLE Word。**宏与链接更新的实测**（#30 确认前按要求补充，`tests/sandbox/docker/parse.test.ts` 的 “LibreOffice macro and link-update settings in the parse image”，在 CI 的完整镜像与 gVisor 下运行）：样本 `macro-autorun.odt`（`samples/make-macro-sample.py` 由 LibreOffice 生成）的 Basic 宏绑定在 OnLoad、OnViewCreated、OnFocus、OnLayoutFinished 上，执行时写 `/tmp/zhibiao-macro-marker`。① 经解析入口（`format=word-ole`，LibreOffice 转 docx 后 mammoth 解析）转换完成后标记文件不存在；② 用最宽松的用户配置（宏安全级别 0、允许执行、链接“总是”更新）在沙箱中“打开”样本，标记文件不存在；③ 同一镜像中用用户配置里的应用级 Basic 宏（`macro:///`）读取有效配置，叠加同样宽松的用户配置后仍是宏安全级别 3、禁用宏执行、阻止不受信任的外部资源、Writer / Calc 链接更新 2（从不）、Writer 域与图表不更新；④ **对照组**：CI 从完整镜像派生只删掉 `zhibiao-security.xcd` 的镜像（`TEST_SANDBOX_CONTROL_IMAGE`），② 中宏执行、标记文件出现，③ 读出的是用户配置的值。**以 `--convert-to` 转换时做不出对照组**：实测 LibreOffice 转换时根本不触发文档事件宏（没有视图），即使宏安全级别 0、没有 xcd 也不执行，所以 ① 在两种镜像中结果相同，只证明解析路径不执行宏；对照组放在会触发事件的“打开文档”路径上（② ④）。本机（LibreOffice 24.2）用同样的脚本验证了四种组合；
- **worker 接入**：新配置 `SANDBOX_RUNNER_URL`、`SANDBOX_RUNNER_TOKEN[_FILE]`（至少 32 个字符），worker 6.6 起也创建对象存储；`JobContext` 新增 `objectStore`、`sandbox`。compose 的 worker 加入 `sandbox-control` 网络、拿对象存储密钥和沙箱服务令牌；api 仍不在该网络上；
- **镜像**：多阶段构建，构建阶段按 `server/sandbox/parse/package-lock.json` 执行 `npm ci --omit=dev --ignore-scripts`，最终镜像只复制 `node_modules`，仍不含 npm。新增依赖（只在沙箱镜像中，`server/package.json` 没有变化）：`mammoth` 1.13.0（BSD-2-Clause）、`pdf-parse` 2.4.5（Apache-2.0）、`pdfjs-dist` 6.4.299（Apache-2.0）、`turndown` 7.2.4（MIT）、`turndown-plugin-gfm` 1.0.2（MIT）、`cheerio` 1.2.0（MIT）、SheetJS `xlsx` 0.20.3（Apache-2.0，与客户端相同取自 `vendor/` 中的官方 tgz），版本与客户端相同、发布均超过两周；传递依赖见 #30 的审计报告，其中 `jszip` 3.10.2 为 “MIT OR GPL-3.0-or-later” 双许可证，按 MIT 使用（#30 确认）。CI 另对这份 lockfile 跑 `npm audit --audit-level=high`；
- **测试**：单元测试 `tests/sandbox/zipGuard.test.ts`（构造的 ZIP：条目数、伪造的大小、压缩比与 1 MiB 门槛、加密、ZIP64、损坏的 deflate）、`tests/parse/dispatch.test.ts`、`tests/parse/output.test.ts`、`tests/sandbox/sandboxCap.test.ts`；数据库测试 `tests/db/parseJob.test.ts`（导入后入队、写回与产物、图片改写、重新解析替换旧产物、各种失败的文案与文档状态、`finally` 中销毁、上限重试、取消与关闭、迁移 0023 的守卫与授权，以及经 worker 与真实 Valkey 从导入到解析完成的完整流程）；沙箱测试 `tests/sandbox/docker/parse.test.ts`（真实沙箱中解析 docx（含图片）、pdf、xlsx、OLE xls、GB18030 文本、Markdown 去图，ZIP 炸弹三种、3,001 页 PDF、内容与格式不符时的代码，镜像中的 LibreOffice 安全设置；`TEST_SANDBOX_OFFICE=1` 时 OLE Word 经 LibreOffice 转换）。本机（runc、不含 LibreOffice 的镜像，PostgreSQL 16）全部通过（LibreOffice 用例跳过），完整镜像与 gVisor 下的结果以 CI 为准。

**沙箱总数上限的测试**（#28 确认时登记）：`tests/sandbox/sandboxCap.test.ts`（Docker 桩）与 `tests/sandbox/docker/isolation.test.ts` 的 `counts stopped and expired-but-unswept sandboxes toward the cap…`（真实 Docker）覆盖：已停止的（模拟超时被终止）、已到期但尚未清理的、其他 sandbox-runner 进程创建的沙箱都计入上限；超出时 `SANDBOX_BUSY` 与文案“沙箱数已达上限，请稍后重试”，经 HTTP 为 429 且 worker 端保留代码和文案；并发创建不超过上限；到期清理或销毁残留后可以再创建。计数逻辑 6.5 已按此实现，本 PR 只把文案提成常量。

偏离计划：

1. **新增迁移 0023**（拆分计划只写了“重新解析时替换旧产物”）：产物写入后不可修改、没有删除接口，必须有一个标记才能让 6.8 找出被替换的产物；只加一列和列级授权，不改策略和角色。
2. **6.7 的格式解析失败而不是排队等待**：RTF、HTML、MHT、Office 2003 XML 的文档标为失败（“暂不支持解析，请另存为 docx / xlsx 后重新导入”），6.7 上线后重新导入即可解析。
3. **emf / wmf / tiff / svg 等图片丢弃**：桌面版原样保存，但迁移 0008 只登记了位图（能执行脚本的类型存不进来），Word 导出（第 7 步）若需要图元文件再议。
4. **单条目压缩比只检查解压后不小于 1 MiB 的条目**：小条目即使压缩比很高也放不大，正常文档中重复的小 XML 常超过 100:1；另外按实际解压的大小核对声明值，这是计划之外加的。
5. **没有“重新解析”接口**：失败的文档按桌面版的习惯移除后重新上传；“替换旧产物”目前在任务续跑时生效，6.7 起若开放重新解析同样适用。

**解析卡住时的终止**（#31，#30 合并后补充）：各级时限与终止方式——
- LibreOffice 转换 **8 分钟**：`soffice` 是 shell 脚本，exec 成 `oosplash`，转换由其子进程 `soffice.bin` 进行。#30 超时后只对直接子进程（`oosplash`）发 SIGKILL，`soffice.bin` 是否结束取决于 LibreOffice 自己在父进程死亡后的处理（本机实测入口返回时它仍在运行，随后才退出），不由代码保证。#31 改为在独立的进程组中运行（`detached`），超时后对整个进程组 SIGKILL 并等首进程结束，返回新的错误代码 `office_conversion_timeout`（“老式 Word 文件转换超时（超过 8 分钟）”）；不依赖 SIGTERM（gVisor 下 LibreOffice 不响应 SIGTERM）。正常结束后同样清理一次进程组；
- 解析命令墙钟 **10 分钟**（parse 模板）：到时 sandbox-runner 终止整个沙箱容器（不是发信号给进程），任务得到 `timedOut`，以 `PARSE_TIMEOUT` 失败；
- worker 调用 sandbox-runner 的请求超时 **10 分 30 秒**（模板上限 + 30 秒）：sandbox-runner 无响应时任务以 `PARSE_UNAVAILABLE` 失败；
- 任务在 `finally` 中**销毁沙箱**（上面任何一种都会走到）；兜底是沙箱最长存活 **15 分钟**，到期由 sandbox-runner 每 30 秒的清理删除。

测试：`tests/sandbox/docker/parse.test.ts` 的 “kills the whole LibreOffice process group when the conversion times out”（真实沙箱中持续冻结 `soffice.bin`，转换上限经只能调小的 `ZHIBIAO_PARSE_OFFICE_TIMEOUT_MS` 调为 5 秒：入口在 5–20 秒内以 `office_conversion_timeout` 退出，沙箱中没有活着的 LibreOffice 进程）；`tests/sandbox/docker/parseJob.test.ts`（真实沙箱 + 真实数据库执行 `document-parse`：LibreOffice 卡住时任务以 `PARSE_OFFICE_CONVERSION_TIMEOUT` 失败；整个解析命令卡住时由命令墙钟上限（测试中 8 秒代替 10 分钟）终止沙箱，任务以 `PARSE_TIMEOUT` 失败；两者都在 45 秒内结束、文档标为失败、沙箱容器不存在）。CI 的沙箱测试步骤因此也连接 PostgreSQL 服务容器。本机（LibreOffice 24.2）先验证了冻结脚本：新实现入口约 5.8 秒返回、无残留；#30 的实现入口返回时 `soffice.bin` 仍在运行。

已知限制：执行次数用完（`JOB_ATTEMPTS_EXHAUSTED`，例如 worker 连续崩溃）时文档停在 `running`；租约丢失与新执行者之间仍有很小的窗口，最坏结果是一份文档的产物被提前标为已被替换（读取不到 Markdown），重新导入可恢复；6.8 清理时应跳过仍被文档引用的产物。

#### 解析任务（二）文本类格式（#32，6.7）

逐项满足 #6 的“第 6 步解析要求”中文本类格式的三条（XML 禁用 DTD 与外部实体、HTML / MHT / RTF 禁止加载远程资源、MHT 先解包），做法见 `docs/SERVER_DESIGN.md` 第 7.7 节。没有迁移、没有新增依赖（`server/` 与 parse 镜像的 lockfile 都没有变化），`client/` 未改动。要点：

- **分派**（`src/parse/dispatch.ts`）：`application/rtf` → `rtf`，`message/rfc822` → `mht`，`text/html` 在 `.doc` / `.wps` 中是 `html-word`、在 `.xls` 中是 `html-sheet`，`application/xml` 同样分为 `word-xml` / `spreadsheet-xml`（扩展名取上传时登记的值，#6 的约定；其他扩展名 `PARSE_UNSUPPORTED_FORMAT`）。6.6 的 `PARSE_FORMAT_NOT_READY` 不再出现。表格类（`html-sheet`、`spreadsheet-xml`）与 xlsx 一样由 worker 以文件名作一级标题；
- **Office 2003 XML**（`server/sandbox/parse/markupGuard.mjs` 的 `assertSafeXml`，交给 LibreOffice / SheetJS 之前）：整个文件按 UTF-8 严格解码，除注释与 CDATA 外出现任何 `<!` 声明（`<!DOCTYPE`、`<!ENTITY`、`<!ELEMENT`、`<!ATTLIST`、`<!NOTATION`，不分大小写、含 `<! DOCTYPE`）即拒绝 `xml_doctype`，不尝试安全地解析 DTD；含 XInclude 命名空间或 `<?xml-stylesheet` 拒绝 `xml_external_reference`；缺少 XML 声明、声明的编码不是 UTF-8（例如 UTF-7 的 `+ADw-!DOCTYPE` 在按 UTF-8 检查时看不到）、含 NUL、不是合法 UTF-8 拒绝 `xml_invalid`。没有 DTD 就不存在外部实体和实体膨胀；
- **RTF**（`sanitizeRtf`）：按组结构（控制字、`\binN` 原始字节、`\'hh`）逐字节处理，目标控制字出现在组内**任何位置**（不只组首；LibreOffice 不要求在组首）都去掉整个组：`fldinst`（域指令，INCLUDEPICTURE / INCLUDETEXT / INCLUDE / LINK / DDE 等全在其中，不论如何转义或拆组）、`datafield`、`template`、`filetbl` / `subdocument`、`fontemb` / `fontfile`、`hl*`、`objdata` / `objlink` / `linkval`、`htmltag` / `mhtmltag`；`\object` 只留其 `\result` 子组；形状属性 `pibName` / `pibFlags` / `*BlipName` 等（链接图片）去掉。域的显示结果 `fldrslt` 保留。`\'` 后不是两位十六进制、参数超过 10 位、括号不配对、`\bin` 越界、嵌套超过 512 层时拒绝 `rtf_invalid`（与 LibreOffice 的切分可能不一致的写法不放行）；
- **HTML**（`server/sandbox/parse/htmlSanitize.mjs`）：先识别字符集（BOM → `<meta charset>` → UTF-8 → GB18030），再用 cheerio（parse5，不访问网络）读出、按白名单**重新生成**：只留正文结构元素，脚本、样式、`<link>`、`<base>`、`<meta>`、`<iframe>` / `<frame>`、`<object>` / `<embed>` / `<applet>`、音视频、SVG / MathML、表单等连同内容去掉，其他元素（含 Word 的 `o:p`、`v:shape`）只留文字；属性只留 `colspan` / `rowspan` / `start`、图片的 `alt` / `width` / `height`、链接的 `href`（只收 http / https / mailto 绝对地址与 `#锚点`，链接不会被加载）；图片只留 `data:` 位图（文件头与类型一致）。`style`、`background`、`srcset`、CSS `url()` / `@import`、注释与条件注释一律不输出；
- **MHT**（`extractMht`）：解开 MIME（头部折行、`multipart/*` 递归、base64 / quoted-printable / 7bit / 8bit / binary），正文取 `start` 参数指定的或第一个 `text/html` 部分，按其 `charset` 解码；图片只在包内查找（`cid:`、`Content-Location` 原样或按正文的 `Content-Location` 解析相对地址；内容在包内时即使 `Content-Location` 是远程地址也用包内字节），找到的转成 `data:`、找不到的去掉，`message/external-body` 等指向外部的部分从不跟随。上限：嵌套 8 层、叶子部分 2,000 个、单个头部块 64 KiB / 200 个字段，超过 `mht_too_complex`；没有 `MIME-Version`、multipart 缺少 boundary 或找不到分隔行、base64 不合法、未知的传输编码、multipart 声明了编码 `mht_invalid`；没有 HTML 部分 `mht_no_html`。没有结束分隔行（截断）时最后一部分到末尾为止。之后与 HTML 相同清理；
- **LibreOffice**：RTF、HTML（含 MHT 解出的）、Word 2003 XML 与 OLE Word 共用一个转换函数（`convertWithOffice`），沿用 6.6 的独立进程组、8 分钟超时后对整个进程组 SIGKILL、正常结束后清理进程组、转出的 docx 做 ZIP 检查；文本类格式都指定导入过滤器（`Rich Text Format`、`HTML (StarWriter)`、`MS Word 2003 XML`），不让 LibreOffice 按内容另行识别。表格类由 SheetJS 从已检查 / 已清理的字符串读取；
- **错误代码与文案**：`xml_invalid`、`xml_doctype`、`xml_external_reference`、`rtf_invalid`、`mht_invalid`、`mht_too_complex`、`mht_no_html`，任务代码 `PARSE_` 加大写，文案由 worker 决定（例如“XML 文件含 DTD 声明（<!DOCTYPE> 等），为防止外部实体与实体膨胀已拒绝解析，请另存为 docx / xlsx 后重新导入”）。

**实测：只靠 LibreOffice 的设置不够**：未经清理的 HTML 交给 LibreOffice 时，`<img>` 被镜像设置中的 `BlockUntrustedRefererLinks` 挡住，但 `<link>` 样式表和 CSS 背景图片照样请求（OPTIONS / HEAD / GET）——CI 中正式镜像（bookworm 的 LibreOffice 7.4，gVisor）与本机 LibreOffice 24.2 都如此，所以清理是必需的。RTF 的 INCLUDETEXT / INCLUDEPICTURE、OLE 链接、`pibName`，Word 2003 XML 的 VML 图片、域、超链接在转换时都没有请求；本机 24.2 中 Word 2003 XML 的外部实体没有被展开、billion laughs 转换失败，SheetJS 不展开实体（原样留下引用），这些是解析器的现状，6.7 不依赖它们。另：本机 LibreOffice 24.2 在固定路径找不到 CA 证书包时不发 HTTP 请求，bookworm 的 7.4 没有这个限制（正式镜像中没有证书包，照样请求），所以远程资源测试与对照组都在正式镜像中做，不依赖证书包。

**测试**：

- 单元测试 `tests/sandbox/markupGuard.test.ts`（47 项）：XML 的 XXE（本地文件、远程、参数实体）、billion laughs、二次膨胀、空 DTD、小写与带空格的 doctype、根元素之后 / CDATA 中的声明、XInclude、xml-stylesheet、UTF-7 / GB2312 / UTF-16 声明、非法 UTF-8 与 NUL，对照组为去掉 DTD 的同一文档与真实样本通过；RTF 的各种域写法（转义、拆组、非组首、大小写）、OLE 对象、`\bin` 中的括号、嵌套上限、线性用时，对照组为普通 RTF 原样输出；MHT 的包内图片查找（远程地址从不跟随）、`start`、quoted-printable 与 GB2312、单一部分、截断、嵌套上限（8 层通过、9 层拒绝）、部分数与头部上限、80 MiB 消息线性解析、七种畸形；HTML 字符集。`tests/parse/dispatch.test.ts` 与 `tests/db/parseJob.test.ts` 改为新的分派与错误代码；
- 沙箱测试 `tests/sandbox/docker/parseMarkup.test.ts`（34 项）：沙箱内只有 `lo`，测试在其中 `127.0.0.1:18080` 起一个记录一切连接的监听，样本中的远程地址都指向它。XML 的五类恶意样本在两种格式下都以错误代码拒绝、5 秒内结束、没有连接、输出中没有 `/etc/passwd` 的内容；对照组：去掉 DTD 的同一文档能解析，正文原样含 `root:x:0:0` 的文档在输出中能看到它（证明“没有”的断言有效），去掉检查时 SheetJS 会解析 XXE 文档。HTML（`html-word`、`html-sheet`）、MHT、RTF、Word 2003 XML 经解析入口转换成功、内嵌 / 包内图片保留、**没有任何连接**、没有读到 `/etc/passwd`。对照组：在同一正式镜像中把未经清理的 HTML 直接交给 LibreOffice（安全设置已加载），监听收到样式表与背景图片的请求；未经处理的 RTF 转出的 docx 中仍有 INCLUDETEXT 域，处理后没有。MHT 的畸形、无正文、部分过多、嵌套过深经入口得到对应代码，90 MiB 的 MHT 能在上限内解析；六种真实样本都能解析。`tests/sandbox/docker/parse.test.ts` 的“LibreOffice 卡住时终止整个进程组”扩展到 `rtf`、`html-word`、`mht`、`word-xml`。本机：gVisor 之外的 runc；不含 LibreOffice 的正式镜像跑全部沙箱测试，另用宿主 LibreOffice 24.2 拼出的测试镜像跑需要 LibreOffice 的用例；bookworm 的 LibreOffice 7.4 与 gVisor 下以 CI 为准（对照组只在能发请求的 LibreOffice 上成立，CI 的正式镜像满足）。

偏离计划：

1. **XML 除 `<!DOCTYPE` 外还拒绝其他声明、XInclude、xml-stylesheet 和非 UTF-8 编码**（分派表写的是“含 `<!DOCTYPE` 一律拒绝”）：声明的编码与检查时的解码不一致会让检查失效，其余都是同类的外部引用。Office 导出的这两种 XML 都是 UTF-8，误拒的代价是“另存为 docx / xlsx”。
2. **Word 2003 XML 不做远程资源的预处理**（要求中“禁止加载远程资源”列的是 HTML / MHT / RTF）：实测 LibreOffice 转换时 VML 图片、域、超链接都不请求，测试在正式镜像中核对了没有连接；以后若发现会请求，再按 RTF 的做法处理。
3. **HTML 中的超链接保留**（只限 http / https / mailto 绝对地址）：链接不会被加载，测试核对了没有连接；`javascript:`、`file:`、相对地址的链接去掉。

#### 清理任务（#33，6.8）

逐项实现“决定事项（#23）”第 9、10 项。`client/` 未改动，没有新增依赖。要点：

- **迁移 0024_cleanup**：新增定义者角色 `bidtools_cleanup`（`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`，迁移角色以 `INHERIT FALSE, SET TRUE` 加入；已加入 `10-provision.sh`、测试 harness、`src/db/roles.ts` 和第 9 步上线检查“数据库角色”一条；已有的开发数据卷需要 `docker compose down -v` 重建，或按脚本手工建角色）。它是 8 个 `SECURITY DEFINER` 函数的属主，只对 `files`、`artifacts`、`projects`、`jobs`、`job_events` 有列级 `SELECT`（只有判断条件要用的列）和 `DELETE`，没有 `UPDATE` / `INSERT`，对其他表（含计费账本、余额、价格表、用量记录、平台凭据、平台模型）没有任何授权、没有为它建的策略。项目、文件被删除时级联到项目级表、文档表的外键动作由表属主执行，不需要给它授权；
- **删除条件只在数据库中**，同一份 SQL 表达式同时写进函数和只对它生效的 `DELETE` 策略（函数写错也删不掉恢复期内的行）：
  - 文件：已上传、删除超过 7 天，或所属项目删除超过 7 天；`uploading` 登记超过 24 小时；
  - 产物：被替换超过 7 天、所属项目或来源文件已过期，`writing` 登记超过 24 小时；
  - 项目：删除超过 7 天，且其下文件、产物已删完（外键不级联，先删产物、再删文件、最后删项目）；
  - 任务：已结束超过 90 天（事件随之级联删除）；事件：创建超过 30 天。
  函数只接受行 id（`cleanup_delete_file` / `cleanup_delete_artifact`，重新检查条件，未过期的 id 只影响 0 行）、批量上限（夹在 1~1000）或对象键（`cleanup_unreferenced_keys`，只读），不接受时间、保留期或组织；过期只按数据库的 `now()` 计算；
- **过期是单调的**：恢复期满后不能恢复（FS002、PJ002），被替换、已结束不能撤销（AR003、JB001）；本迁移另外让 `files_guard` / `artifacts_guard` 拒绝登记 24 小时后才完成的上传 / 写入（`FS006` → 408 `UPLOAD_TIMEOUT`、`AR005`）。所以 worker 删掉对象之后这一行一定仍然可删，不会留下“行在、对象已删”；
- **worker**（`src/cleanup/cleanup.ts`，`src/worker.ts` 启动后 1 分钟第一批，之后每小时一批，上一批结束后才计时；关闭时在下一项之前停止）：冻结收尾 → 产物 → 文件（先删对象，成功或对象已不存在后再调删行函数；对象删除失败的行保留、计入 `failed`，下一批重试）→ 项目 → 孤儿对象 → 任务 → 事件。孤儿对象按前缀 `org/` 分页列出（`ObjectLister`，S3 `ListObjectsV2` + `StartAfter`），每批最多 10,000 个、从上次停下的位置继续、到末尾后从头开始；只删除修改时间超过 7 天、形如 `org/{org}/files|artifacts/{id}`、数据库中没有对应行的对象，其他形式的键一律不动。未配置 `S3_BUCKET` 时有对象的行一律不删，只清理项目、任务记录和冻结；
- **冻结到期收尾**：`expireStaleHolds`（`bidtools_billing` 所属的 `ai_usage_expire_holds`）从 api 的 60 秒定时器移到 worker 的每批，以应用角色调用，不经清理角色；
- **日志**：每批按 8 个类别（`holds`、`artifacts`、`files`、`uploading`、`projects`、`orphans`、`jobs`、`job_events`）各记一行 info `cleanup batch`，字段 `category`、`deleted`、`objects`、`failed`、`durationMs`，不含对象键、文件名和 id；一类出错不影响其他类，出错的类同样记一行（`failed: 1`），另记一条只含错误名称和代码的警告（S3 / 数据库的错误消息可能带对象键）；
- **测试**：`tests/db/cleanup.test.ts`（26 项，真实 PostgreSQL；最后一组用真实 S3 兼容服务）：
  - 角色：属性与成员关系，应用角色不能 `SET ROLE`；对 6 张计费表 7 种表级权限、4 种列级权限全部为假，没有为它建的策略；全库只对 5 张表有权限且只有 `DELETE` 与列级 `SELECT`；以清理角色直接读、删、`TRUNCATE` 计费表一律 42501；8 个函数的属主、`SECURITY DEFINER`、固定 `search_path`、参数只有 `p_limit integer` / `p_id uuid` / `p_keys text[]`；`ai_usage_expire_holds` 仍属于 `bidtools_billing`；
  - 保留期边界（各类别保留期前后各差 1 小时）：文件、项目（连同其下文件、产物、对象、项目级表、任务记录）、被替换的产物（引用它的文档改为空）、来源文件过期的产物、遗留上传与写入（含对象已不存在）、任务与事件（未结束的任务不论多久都不删）；每类每批 1000 行上限；
  - 不能绕过：按 id 删除恢复期内 / 未删除 / 上传未超时 / 项目在恢复期内的文件和产物一律 0 行，候选列表中也没有它们；过期文件还挂着产物时删不掉；极端上限值；带时间参数的调用没有对应函数（42883）；以清理角色直接 `DELETE` 五张表，策略只放行过期的行；改会话时区、设置租户上下文不影响判断；
  - 对象：删除对象时行仍在；对象删除失败的行与对象都保留、下一批重试成功；未配置对象存储；孤儿对象（年龄、形式、其他组织前缀下同 id、有对应行的不删）；分批扫描与失败计数；
  - 日志：8 行、字段固定，不含文件名、对象键、文件 id、任务 id、组织 id；一类出错的处理；
  - 计费：两个已结算的任务（写入账本扣费和用量记录）结束 100 天、其中一个所属项目删除 8 天，另有一条到期未结算的冻结。清理后任务和项目被删除，6 张计费表的行数不变，账本、余额、价格表、平台凭据、平台模型的全部内容（按行序列化后的 SHA-256）不变；用量记录的 id、`job_id`、金额不变，只有到期的冻结被计费函数标为 `unbilled` / `abandoned`；再跑一批什么都不变；
  - 定时执行与关闭；`tests/db/migrations.test.ts` 同步函数清单与逐个回滚；项目级表模板 `tests/db/projectTable.ts` 新增 `cleanupRoles`（除 `SELECT` 外还有 `DELETE` 策略的定义者角色，模板检查属性且只有这两种策略），`files`、`artifacts` 两处声明 `bidtools_cleanup`。
  另做了反向验证（改代码后跑本文件，再改回）：`DELETE` 策略改为放行全部，1 项失败（直接 `DELETE`）；只去掉函数中的条件，全部通过（策略兜底）；两者都去掉，3 项失败；给清理角色授 `usage_records` 的 `SELECT`，3 项失败；先删行再删对象，1 项失败；去掉 `FS006`，1 项失败；不看孤儿对象的修改时间，2 项失败。

偏离计划（均已在 #33 确认）：

1. **`files_guard`、`artifacts_guard` 新增 24 小时期限**（`FS006`、`AR005`，拆分计划未列出）：否则极慢的上传可能在对象被删后才完成，留下“已上传、对象不存在”的行。上传接口把 `FS006` 映射为 408 `UPLOAD_TIMEOUT`；解析任务写产物最长约 15 分钟，不受影响。
2. **“上传超时”取 24 小时**：上传接口只有 60 秒的空闲超时、没有总时长上限，24 小时远大于 100 MiB 文件的正常上传时间。
3. **被替换的产物保留 7 天**（决定事项只写了“产物超过 7 天恢复期”，被替换的产物没有恢复操作）：与文件、项目的恢复期相同，从被替换时算起。
4. **项目被物理删除时，其下的任务记录随项目级联删除**（即使任务结束还不满 90 天）：这是 6.2 迁移 0021 建表时的外键设计（`jobs_project_fkey ON DELETE CASCADE`）；若要保留，就得把项目行（及全部项目级表的内容）留到 90 天后，与“项目删除后 7 天删除”冲突。用量记录不受影响（没有外键，`job_id` 的值保留）。已写进第 9 步隐私声明一条。#33 确认：接受，项目物理删除时其任务记录一并删除，用量记录与账本不受影响。
5. **冻结收尾从每 60 秒改为每小时一次**（随清理批次）：到期的冻结本来就不占用余额（`billing_active_holds` 按到期时间判断），收尾只是把记录标为 `unbilled` / `abandoned`，在此之前这类记录的状态仍是 `pending`，最长 1 小时。
6. **多个 worker 不加锁**：删除函数重新检查条件、删除已不存在的对象不报错，同时执行只会多做一次；清理角色没有 `UPDATE`，所以批量删除不用 `FOR UPDATE`，后到的删除影响 0 行。
7. **已知限制**：与 `bidtools_jobs` 相同，api 与 worker 共用应用角色，api 进程也能调用清理函数（只能删除已过期的行、只能得到过期行的 id 和对象键、只能判断给定的对象键有没有对应行）；以后 worker 改用独立的登录角色时，只把执行权授给它。未完成的分片上传不是对象，按前缀列不出来，由第 9 步上线检查“文件存储”中的生命周期规则清理。

#### 步骤幂等（#34，6.4a）

消除 6.4 登记的窗口：任务中的一次调用已结算、任务还没保存 checkpoint 时 worker 崩溃，续跑会重做这一步、服务商被再调用一次、用户被再扣一次费。两个方案中选了**步骤幂等键**，并让“写结果”与“结算”在同一事务中提交（偏离说明见下）。

- **迁移 0025_job_step_results**：新表 `job_step_results`，键为 `(org_id, job_id, step_key, request_hash)`，存调用的完整输出（`content`、`reasoning_content`、`finish_reason`）和用量，`usage_id` 引用产生它的用量记录（每条用量记录最多一条结果）。强制 RLS：应用角色只读本组织的行；`INSERT` 只能引用本任务、尚未结算（`pending`）的用量记录；没有 `UPDATE`、`DELETE` 授权。复合外键挂在 `jobs` 上 `ON DELETE CASCADE`，随任务记录的 90 天保留期由清理任务一并删除；项目被物理删除时（`jobs_project_fkey` 级联）随其下的任务记录一并删除，不等满 90 天（与“决定事项”第 4 项的任务记录相同）。两条都已测，用量记录与账本不受影响。`usage_records.failure_reason` 新增两个不收费原因 `platform_interrupted`、`duplicate_step`，`ai_usage_fail` 同步放行（其余与 0004 相同，down 恢复）；
- **任务调用必须带步骤键**（`JobChatRequest.stepKey`，网关对 `source = 'job'` 的调用强制、对交互式调用拒绝）：在本任务内标识“同一次逻辑调用”，取值须在续跑时能重新算出（如 `section:<id>`），有意重试要换键（如 `section:<id>:try-2`）。`request_hash` 是请求内容（服务商、模型、最大输出、temperature、消息）的 SHA-256：暂停期间用户改了输入、续跑时同一步骤的请求不同，就是新的调用，照常收费；
- **网关**（`src/ai/gateway.ts`）：任务调用先按步骤键和请求哈希查已保存的结果，有则直接返回（`reused: true`），不检查并发名额、不冻结、不调用服务商、不扣费。调用完整结束时经 `settleJobStep`（`src/billing/usage.ts`）在**一个事务**中先写结果、再 `ai_usage_settle` 结算：提交前崩溃，结果和扣费都不存在，冻结到期后不收费（`abandoned`），续跑重新调用、只扣这一次；提交后崩溃，续跑时取回结果。同一步骤被两个执行者同时完成（原执行者失联但仍在运行）时，后提交的一方插入冲突，同一事务中把自己的调用改为不收费（`duplicate_step`）并返回先提交的结果；
- **平台原因中止的调用不收费**：worker 关闭（SIGTERM）或租约丢失时任务被中止，进行中的调用原来按已产生的用量收费、续跑再完整调用一次，同样是平台故障导致的重复扣费。runner 传入 `platformAborted`（中止原因为 `shutdown` / `lease-lost`），网关改为不收费（`platform_interrupted`），不保存部分结果。用户取消、暂停中止的调用照旧按已产生的用量收费（第 10.1 节），也不保存部分结果，继续时重新调用；
- **测试**（`tests/db/jobBilling.test.ts` 新增 8 个用例，真实 PostgreSQL、Valkey 和本机模拟服务商）：**第 0 步已结算、checkpoint 未保存时执行者崩溃，租约过期后新 worker 续跑：第 0 步取回已保存的结果，服务商共收到 3 次请求（不是 4 次）、扣费 3 次、`billed_amount` 与账本一致**；结果与结算同一事务（用量已释放时结算失败、结果不保存；用量不属于本任务时结果写不进、不扣费；结果已写入后扣费时注入故障，整个事务回滚，冻结到期后不收费）；两个执行者并发完成同一步骤只扣费一次、后者 `duplicate_step`、两边结果相同；同一请求取回不调用服务商，请求内容 / 最大输出 / temperature / 步骤 / 任务不同都是新的调用；worker 关闭与租约丢失时中止的调用不收费、续跑每步只扣费一次；`job_step_results` 的 RLS、不能改删、跨组织不能写、随任务记录删除；项目物理删除时随任务记录一并删除（任务结束不满 90 天也删）。`tests/db/aiGateway.test.ts` 补步骤键的校验。去掉调用前的查找、改回普通结算（不写结果）、去掉平台中止的判断、去掉插入冲突处理、去掉 `job_step_results` 对 `jobs` 的级联，分别有 2、4、2、1、2 个用例失败。

**偏离与说明**：

1. **选了步骤幂等键，没有选“结算、写结果、写 checkpoint 同一事务提交”**：后者要把结算从网关移到任务代码中、和业务 Store 写入及 `jobs.checkpoint`（带 `run_id` 条件）放进一个事务，每个业务任务都要按这个协议改写；步骤键只要求任务给每次调用一个稳定的键，业务任务的代码仍可原样搬运。与登记的“步骤键”方案的区别是结果和结算在同一事务中写入（登记中“或不再收费”的退路不需要：同一步骤一律取回结果、服务商不会被重复调用，只有两个执行者恰好同时在调用时服务商被调用两次，后者不收费）；
2. **AI 输出存进数据库**：结果只在 `job_step_results`（强制 RLS，不写日志），与 checkpoint 中的业务结果同等对待；随任务记录的保留期删除，已加入第 9 步上线检查“任务计费”一条写进隐私声明；
3. **单独一个 PR，没有并入下一个业务任务**：6.4a 涉及计费、须确认后合并，并入 6.9 会让计费改动和业务搬运混在一起难以审查；6.9 起的业务任务按本节的约定传步骤键。

#### 废标检查任务（#35，6.9）

只改 `server/`，不改 `client/`，没有新增依赖、数据库角色和迁移，没有修改已有的 RLS 策略。桌面版 `rejectionCheckTask.cjs` 的提示词、分段与滚动检查、结果整理原样搬运（逐项与桌面版的内部函数比对过输出：提示词、三类结果整理、按上下文长度切分、JSON 解析与修复消息完全相同）。

- **两类任务**（`src/rejectionCheck/jobs.ts`，登记到 `src/jobs/registry.ts`）：`rejection-items-extraction`（参数为空）与 `rejection-check-run`（参数为三项检查的开关），`ai` 队列，`billable`（入队检查最低启动余额），可续跑；两类互斥，`lock_key` 为 `project:{projectId}:rejection-check`（与桌面版同组互斥相同），冲突 409 `JOB_LOCKED`。
  - 输入在任务开始时从数据库读取，不取自参数：招标文件按导入顺序读出各自的 Markdown 产物、去掉首尾空白后以空行合并（取代桌面版保存的合并招标文档），投标文件逐份读取；文档须全部解析成功（有失败的提示移除后重新导入，未完成的提示稍后再试），正文合计不超过 32 MiB。模型取组织设置中选择的平台模型（`src/jobs/chat.ts` 的 `resolveJobModel`），没有选择时失败并写入原因。
  - 废标项解析（`src/bidAnalysis/discardedBids.ts`，6.11 迁移招标解析时合并）：与桌面版 `runInvalidBidAndRejectionItemsExtraction` 相同，超过上下文长度时分段解析后合并，只返回“未提取到”时完整重跑一次；结果经 `saveExtraction` 写入，带招标文件签名。
  - 三类检查（`src/rejectionCheck/checks.ts`）并发执行：不分段时废标项分析、检查、定稿三轮，错别字、逻辑各一次；超过上下文长度时废标项与逻辑按投标包滚动检查（增量 patch 由程序合并为累计状态，20 条一批定稿后全局合稿），错别字按文件分段。多个检查共用投标文件原文时先预热前缀缓存（`maxOutputTokens: 1`，失败不影响后续）。JSON 请求按桌面版 `collectJsonResponse` 最多调用 3 次、每次不合法时先请模型修复。
  - 每次调用的步骤键由调用位置决定（`extraction`、`extraction:segment:N`、`rejection:analysis`、`rejection:segment:N`、`rejection:final:N`、`typo:document:N:segment:M`、`logic:merge` 等，JSON 的重新调用和修复另加 `:try-N`、`:repair-N`），续跑时同一步骤取回已保存的结果，不再调用服务商、不再扣费（6.4a）。为此模型没给 id 的中间条目改为按内容生成 id（桌面版是随机 id，会让续跑时的请求内容不同）；测试检查了同一输入、同一模型输出时每一步的请求内容完全相同。
  - 结果经 `saveCheckResult` 写入：问题 id 统一改为 `rejection-finding-1` 等（不采用模型给出的 id，避免重复或超长），当前问题为第一条，签名为任务开始时的 `signatures.rejectionInput`（废标项）或 `signatures.bid`（错别字、逻辑）。某一类失败时其余照常写入，失败的写给用户看的原因（`JobError` 的文案，其他错误一律“{检查名}失败”，原错误交给执行者写日志），任务以“N 个检查任务失败”失败。
  - 暂停、余额不足、中断（租约丢失、worker 关闭）与取消时不改写结果：继续后从头执行、已完成的调用取回结果；余额不足的错误不被吞掉，执行者照 6.4 暂停任务。
  - 任务日志只写阶段和条数，不写文档正文和模型输出。
- **写入带开始时的签名**（`saveExtraction` / `saveCheckResult` 新增 `expectedSignature`，返回是否写入）：在写入的同一事务中（项目咨询锁内）与当前签名核对，任务开始后导入、移除了文档或改了解析结果、自定义检查项时不写入，旧任务的结果不会覆盖新的状态；检查结果因此被拒绝时任务以 `REJECTION_CHECK_INPUT_CHANGED` 失败。
- **接口**（`src/routes/rejectionCheck.ts`）：`POST .../rejection-check/extraction`、`POST .../rejection-check/check`（`{ runOptions? }`，不给出时取已保存的检查选项，给出时只运行开启的，对应桌面版的“重新检查某一项”），返回 202 `{ job }`；前置条件不满足时 409（`REJECTION_CHECK_DOCUMENT_NOT_READY`、`REJECTION_CHECK_EXTRACTION_REQUIRED` 等，文案与桌面版的提示相同），余额不足 402。任务的进度、取消、暂停、继续经已有的 `/api/jobs` 与 SSE。与桌面版相同，招标文件变化（导入、移除、从技术方案读取、清空）后取消本项目进行中的两类任务，投标文件变化后只取消检查（不等待执行者退出，其后续写入因签名不符被拒绝）。
- **状态中的任务**：`GET .../rejection-check` 的 `extractionTask`、`checkTask` 为本项目最近一次的两类任务（与 `GET /api/jobs/:jobId` 相同的形式，`src/jobs/store.ts` 新增 `latestProjectJobs`，供其他模块的 `loadState` 共用）。结果仍是 `running` 而对应的任务已结束或不存在时，按未完成显示（“上次解析未完成，请重新解析”“上次检查未完成，请重新检查”，取代桌面版启动时的 `recoverInterruptedRejectionCheckTasks`，只改读出的状态、不写库）；任务暂停中仍显示 `running`。
- **测试**：`tests/rejectionCheck/checks.test.ts`（结果整理、一次检查与分段滚动检查的流程、续跑时请求内容不变）、`tests/ai/textSplit.test.ts`、`tests/ai/json.test.ts`、`tests/jobs/chat.test.ts`；`tests/db/rejectionCheckJobs.test.ts`（真实 PostgreSQL 与 Valkey，模型调用用桩）覆盖两类任务的成功、重跑与分段、前置条件、未选择模型、输出为空、部分失败、只运行开启的检查、余额不足、任务中文档变化，接口的前置检查、互斥、402、取消、按未完成显示，以及经 worker 从接口入队到执行完成。去掉检查结果的签名核对、解析结果的签名核对、按未完成显示、导入后取消任务、不吞掉余额与中断错误、统一问题 id，以及把内容 id 改回随机 id，分别有 1、1、2、1、1、1、2 个用例失败。

偏离与说明：

1. **上下文长度一律用默认值 400,000 字**：平台模型没有上下文长度的配置，登记为上方事项第 26 项；
2. **JSON 请求没有 `response_format`**：网关不支持，登记为上方事项第 27 项；
3. **括号配平只从前 32 个左括号开始扫描**（`src/ai/json.ts`）：桌面版从每个左括号开始，病态输出下是平方级，服务端共享 CPU 时不能接受；正常输出的解析结果不变；
4. **3 次都不合法时的原因不含解析错误的细节**：桌面版附上 `JSON.parse` 的错误消息，其中可能含模型输出片段；
5. **文档须全部解析成功才能开始**：桌面版导入时同步解析，不存在“解析中”的文档；
6. **不再写 checkpoint**：续跑从头执行，已完成的调用按步骤键取回（6.4a），不需要另存中间状态；
7. 本地验证用的是 PostgreSQL 16 与 Redis 7（CI 用 PostgreSQL 17 与 Valkey 8）；`tests/db/files.test.ts` 需要 S3 兼容服务，只在 CI 中运行。

#### 决定事项（#23）

拆分计划中的 10 项待决定事项和两处偏离已在 #23 决定（只改文档）：

1. **解析的隔离方案**：**采用 B**。第 6 步提前建 `sandbox-runner` + `SandboxDriver`，只做断网的 `parse` 模板，第 8 步在其上加 `agent` 模板。
2. **沙箱运行时**：**采用建议**。生产只允许 gVisor（`runsc`，启动时检查），CI 安装 `runsc` 跑隔离测试，开发环境允许参数相同的加固 `runc`。
3. **Redis 发行版**：**Valkey 8**（BSD-3-Clause），许可证已确认可以使用。BullMQ、`ioredis`（MIT）引入时仍在审计报告中列出版本和许可证。
4. **可研正文生成与自然化审校放在第 6 步**：**同意**（6.12），偏离第 5 步表中的“第 8 步”。
5. **解析资源上限**：**采用起步值**（见“资源上限”）。
6. **MinerU**：**第一版不提供**。第 6 步只做本地解析，上传白名单不加 ppt / pptx / 图片；以后决定提供时再开 6.15。
7. **入队最低启动余额**：**全局 1 元**，写在迁移中；按任务类型配置等有需要时再加。
8. **并发**：组织级同时运行的任务 3 个；全局 `parse` 队列 4、`ai` 队列 8。
9. **清理角色**：**同意新建** `bidtools_cleanup`（`NOLOGIN`，属性同其他定义者角色，加进 `10-provision.sh`、测试 harness 和第 9 步上线检查“数据库角色”一条），每小时一批。要求（6.8 逐项实现并测试）：
   - **只删除超过保留期的数据**：文件、产物、项目超过 7 天恢复期，遗留 `uploading` 行超过上传超时，任务记录超过第 10 项的保留期；恢复期内的行一律不动，删除条件写在 `SECURITY DEFINER` 函数中，调用方不能传入时间或 id 绕过；
   - **同时删除对象存储中的对应文件**：先删对象，确认删除成功（或对象已不存在）后再删行；对象删除失败的行保留，下一批重试，不留下“行已删、对象还在”的孤儿；按前缀找出的孤儿对象同样只删除超过保留期的；
   - **每批记录删除数量**：每批按类别（文件、产物、项目、`uploading` 行、孤儿对象、任务、任务事件、冻结收尾）记一行结构化日志，含删除条数、对象数、失败数和耗时，不含文件名和内容；
   - **不得有计费账本的任何权限**：`bidtools_cleanup` 对 `billing_ledger`、`org_balances`、`model_prices`、`usage_records`、`provider_credentials`、`platform_models` 没有任何授权、也没有为它建的策略；测试检查这些表上它的权限为空（`has_table_privilege` 全部为假），清理后账本和用量记录的行数不变。冻结到期收尾仍调用 `bidtools_billing` 所属的 `ai_usage_expire_holds`，不经清理角色。
10. **任务记录的保留期**：**同意**。已结束的 `jobs` 保留 90 天、`job_events` 保留 30 天，写进隐私声明。**保留期清理不涉及计费数据，账本永久保留**：`billing_ledger` 不删除（其不可修改、不可删除的触发器不变），`usage_records` 同样不删除；因此 6.4 不给 `usage_records.job_id` 加外键（否则删除任务记录会被外键挡住或连带用量记录），用量记录中只保留 `job_id` / `job_type` 的值，任务删除后按任务汇总的费用仍可从用量记录算出。

两处偏离均已确认：可研正文生成与自然化审校提前到第 6 步（第 4 项）；任务互斥改用通用的 `lock_key`（见“任务模型的细化”，6.2 实现时同步修改 `SERVER_DESIGN.md` 第 5.1、5.3 节）。

### 第 9 步说明

#### 品牌改名第一部分：用户可见文字和文档（#1）

产品名改为中文“智标”（全称“智标投标工具箱”）、英文“ZhiBiaoTools”。偏离路线图：第 1 步前决定第 3 项把品牌名替换推迟到第 9 步，本 PR 按需求提前做其中不涉及代码标识符和数据路径的部分，不改变运行行为。

- **已改**：README（中英文标题）、`SECURITY.md`、`client/开发说明.md` 和 `openxmlhelper/开发说明.md` 中的产品名；侧栏品牌文字、`index.html` 标题、主窗口标题、preload 的 `appName`；智能体任务默认标题、Pi 自检步骤文案和诊断提示词、Agent 工作区说明（`agent-workspace.md`）、生图测试提示词中的产品名、Pi 内部 provider 的显示名；开发者测试页的示例项目名和报错文案；导出模板默认名称前缀（旧产品名前缀改为 `ZhiBiaoTools-`，已保存的模板名称不变）；`package.json` 的 `description`。
- **未改，留到第二部分**（随第 9 步上线检查处理）：旧产品名在代码标识符、数据与协议名称、打包配置和代码注释中的残留，以及 docs 中对内测版服务的描述。第二部分已完成，见下方“品牌改名第二部分”。

#### 品牌改名第二部分：代码标识符、数据与协议、打包、CI 检查（#2）

清除全部旧产品名残留；本版本无存量用户，不做数据目录迁移。新名称：

- Bridge：`window.appBridge`（preload 完整接口类型 `PreloadBridge`，`AppBridge` 不变），`window.appClient`；
- 打包：包名 `zhibiao-client`、`appId` `com.zhibiao.client`、`build.productName` “智标”（`userData` 目录随之变化）、安装包 `ZhiBiao-${version}-${os}-${arch}.${ext}`（`updateService.cjs` 同步）、图标 `zhibiao_256.ico`、macOS 说明中的 `智标.app`；
- 环境变量 `ZHIBIAO_*`，日志前缀与 User-Agent `zhibiao-client`，C# 命名空间 `ZhiBiao.OpenXmlHelper`；
- 数据与协议（中性前缀 `app`）：`app.sqlite`、`app-asset://`、`<!-- app:block -->`、`<!-- app:keep-N -->`、Word 内容控件标签 `app:body:` / `app:field:`、OpenXmlHelper 段落标记 `APPMARK*`、Pi 自检令牌 `APP_PI_*`、表格令牌 `APP_CONTENT_TABLE_`、废标分隔符 `---app-rejection-*---`、`app:plugins-changed` 事件、Pi provider id `app`、临时目录与 DOM id 前缀 `app-`；
- docs 中原作者服务统一称“内测版（已移除）”，不写原产品名和域名；
- `CLAUDE.md` 删除“已有命名暂不修改”规则和禁用词原文，改由 CI 的 `scripts/check-banned-words.sh` 检查（检查脚本自身除外）；
- 未改：原产品名缩写（CSS 变量、受限 HTML 属性、布局标记等的前缀）留给下一个单独 PR，已在第三部分（#5）完成。

#### 品牌改名第三部分：原产品名缩写前缀改为 `app`（#5）

原产品名的两字母拼音缩写曾用作样式、属性和标识符前缀，本 PR 统一改为中性前缀 `app`，后半部分不变；新名称均已确认与仓库现有名称不冲突。本版本无存量用户，**不做兼容**：解析与导出代码不再识别旧属性。

- CSS：设计变量 `--app-*`（44 个，`tokens.css` 定义，19 个样式文件引用）；公共类名 `app-switch`、`app-switch-thumb`、`app-switch-control`、`app-empty-state`、`app-progress-track`；动画 `app-spin`、`app-progress-sweep`、`app-dialog-overlay-in`、`app-dialog-card-in`；
- 受限 HTML 属性：`data-app-generation`、`data-app-size`、`data-app-fit`、`data-app-role`、`data-app-asset-ref`、`data-app-preset`；整本导出由 Main 组装的 `data-app-outline-number`、`data-app-export-template`、`data-app-export-page-template`；样式表中的 `data-app-rows`、`data-app-row-even`；
- 格式自检定位标记 `APPMARKLAYOUT:app_layout_<序号>`（Main 与 OpenXmlHelper 同步）；
- 函数和变量：`appTableKeepNext`、`appTableKeepEnd`、`appTableRowKeepsNext`、`appTableRowStart`、`appTableKeepRowsHeight`、`appTableCellKeepHeight`、`appKeepHeight`、`appPageContentHeight`、`appCellContentHeight`，探针 id `app-keep-probe`（均在 docx-editor 补丁中，只改补丁新增行，`npm ci` 时 `patch-package --error-on-fail --error-on-warn` 能正常打上）；
- AI 提示词（`受限HTML生成规范.md`、`正文模板.html`）、解析与清洗（`restrictedHtml.ts`、`htmlStructure.cjs`、布局预算）、Main 服务、OpenXmlHelper（C#）、`scripts/受限HTML转Word.ps1` 和两份开发说明同步修改；开发测试页的项目编号改为 `ZB-TEST-001`；
- 新增 `client/tests/src/restrictedHtmlAttributes.test.ts`：AI 提示词示例与正文模板能通过前端解析和 Main 导出预检，前端预览保留新属性且样式表有对应选择器，其他前缀的属性不被识别，C# 读取的属性与前端白名单、Main 组装的属性一致，定位标记前缀一致；
- 本 PR 在开发环境用 apt 安装 .NET SDK 10，实跑一次真实导出链路（`technicalPlanExport.build` → `openXmlHelperService` → OpenXmlHelper），结果见 PR 描述；
- `scripts/check-banned-words.sh` 新增该缩写的检查（规则见脚本）：前面不是字母或数字、后接连字符或下划线的写法，以及 data 属性前缀写法，不区分大小写；另以区分大小写的规则拦截后接大写字母的驼峰标识符。无关单词（如 `PyBuilder`、可研报告编号前缀 `KYBG-`、依赖锁文件中的哈希、docx-editor 压缩代码中的变量名）不会误报。

后续事项（本 PR 登记，未做）：

- **CI 新增 .NET 编译与 OpenXmlHelper 测试**：仓库目前没有 C# 测试项目，CI 也不编译 OpenXmlHelper，C# 改动只能靠本地实跑验证。新增测试项目（覆盖受限 HTML 的配图、表格预设、标题编号和页面范围）和 CI 任务，**最迟在第 7 步 Word 导出迁到服务端之前完成**。新增测试框架依赖时按 `CLAUDE.md` 做许可证审计。

## 1. 现状概览

- 调用链：Renderer（React/Vite）→ `window.appBridge`（`electron/preload.cjs`，约 208 个方法，其中 172 个 `invoke`、19 个事件订阅）→ `electron/ipc/*.cjs`（21 个文件）→ `electron/services/*.cjs`（78 个服务，约 4.6 万行）。
- Renderer 有 55 个文件、约 307 处调用 `window.appBridge`。另有少量调用经 `bridge` / `getBridge()` 别名，主要在开发者页面。
- Renderer 不直接访问 Node 或 `fs`，**bridge 是唯一的端口**，所以 Web 化可以用“替换 bridge 实现”的方式渐进推进。这是本项目最大的有利条件。

## 2. `window.appBridge` 调用清单（按功能模块）

格式：`方法（调用处数）`。标 ⚡ 的是事件订阅（Main → Renderer 推送）。

**A. 应用壳层 / 更新 / 系统**
- `getVersion(2)`、`platform(1)`、`openExternal(11)`、`ui.setCurrentView(3)`
- `checkUpdate(2)`、`quitAndInstall(2)`、`getUpdateDownloadUrl(1)`、⚡`onUpdateProgress`、⚡`onUpdateDownloaded`、⚡`onUpdateError`、⚡`onPluginUpdatesAvailable`
- GPU：`getGpuHardwareAccelerationStatus`、`saveGpuHardwareAccelerationPreference`、`startGpuHardwareAccelerationTrial`、`relaunchWithGpuHardwareAccelerationDisabled`
- `requiredOnlineServices.getStatus(1)`；`database.getStatus` / ⚡`database.onStatus`（`WorkspaceDatabaseGate`）
- `systemFonts.list(1)`
- 已暴露但 Renderer 没有调用：`getLatestVersion`、`startUpdate`

**B. 配置 / 许可证 / 官方账户 / 打赏**
- `config.load(18)`、`config.save(2)`、`config.listModels(2)`、`config.getModelInfo(1)`、`config.openConfigFolder(1)`
- `license.getStatus(3)`、`refresh(1)`、`importOfflineFile(1)`、`activateOfflineCode(1)`
- （已在 0.17 删除）`officialAccount.*` 17 个方法共 24 处：登录、发送验证码、绑定邮箱、余额、充值下单/查询/关闭、流水、兑换码、发票，以及 ⚡`onStateChanged`、⚡`onRechargeOrderChanged`
- `donation.createTip`、`getOrderStatus`、`finalizeOrderStatus`、⚡`onPrompt`、⚡`onPaid`；已暴露未调用：`donation.getConfig`

**C. AI / Agent**
- `ai.chat`、`ai.requestJson`（经 `shared/ai/aiClient.ts`）、`ai.testImageModel`、⚡`ai.onHttpError`、⚡`ai.onBalanceInsufficient`（已在 0.17 删除）
- `agent.run`、`selfCheck`、`exportSelfCheckReport`、`getStatus`、`restart`、`getPendingQuestion`、`answerQuestion`、`suppressQuestionAutoAnswer`、⚡`onStatus`、⚡`onQuestion`
- `autoConfirmation.getState`、`setEnabled`、⚡`onChanged`

**D. 后台任务（`tasks`，18 个方法共 31 处）**
- 技术方案：`startBidSectionExtraction(2)`、`startBidAnalysis`、`startOutlineGeneration`、`suppressOutlineSelectionAutoConfirmation`、`startGlobalFactsGeneration`、`startContentGeneration(5)`、`pauseContentGeneration`；`technicalPlan.saveOutlineSelection` 实际走 `tasks:confirm-outline-selection`
- 可研报告：`startFeasibilityAnalysis`、`startFeasibilityOutline`、`startFeasibilityParameters`、`startFeasibilityContent`、`pauseFeasibilityContent`；已暴露未调用：`startFeasibilityHumanWriting`
- 废标 / 查重：`startRejectionItemsExtraction`、`startRejectionCheck`、`startDuplicateAnalysis`
- 通用：`getActiveTasks(4)`、⚡`onTaskEvent(4)`

**E. 技术方案（`technicalPlan`，21 个方法共 37 处）**
- 状态：`loadState(11)`、`updateStep`、`clear`、`resetContentGeneration`
- 生成配置：`saveGenerationConfig(7)`、`saveBidAnalysisConfig`、`saveContentGenerationOptions`
- 文件：`importTenderDocument`、`removeTenderDocument`、`importOriginalPlanDocument`、`removeOriginalPlanDocument`、`readTenderMarkdown`、`readTenderSourceMarkdown`、`openBidTemplate`（用系统程序打开 docx）
- 标段：`checkBidSections`、`selectBidSection`
- 目录 / 事实 / 正文：`saveOutline`（`reason` 持久化协议）、`saveGlobalFacts`、`saveChapterContent`、`previewContentWord`
- 已暴露未调用：`loadGenerationConfig`、`readContentWord`

**F. 可研报告（`feasibilityReport`，12 个方法共 17 处）**
- `loadState(4)`、`importSourceDocuments`、`removeSourceDocument`、`readSourceMarkdown`、`updateStep`、`saveProjectInfo`、`saveAnalysis(2)`、`saveOutlineConfig`、`saveOutline`、`saveKeyParameters(2)`、`saveChapterContent`、`clear`；已暴露未调用：`readCombinedSourceMarkdown`

**G. 废标检查 / 标书查重**
- `rejectionCheck.*` 8 个方法共 15 处：`loadState(4)`、`importDocument`、`importTenderFromTechnicalPlan(2)`、`removeDocument`、`saveUiState(3)`、`updateState`、`exportExcel(2)`、`clear`
- `duplicateCheck.*` 5 个方法共 7 处：`loadState(2)`、`saveFiles`、`saveUiState`、`exportExcel(2)`、`clear`；已暴露未调用：`duplicateCheck.updateState`
- `file.selectDuplicateCheckFiles(1)`（Main 原生文件选择框）

**H. 知识库 / 资信库**
- `knowledgeBase.*` 15 个方法共 20 处：文件夹 CRUD 与排序、文档移动/删除、`uploadDocuments`（Main 弹选择框）、`retryDocument`、`startMatching`、`search`（分页）、`readMarkdown`、`readItems`、`readAnalysis`、⚡`onEvent`
- `credentialLibrary.*` 13 个方法：`load`、`importTestData`、`saveProfile`、`addProfileImages(fieldKey, filePaths)`、`deleteImage`，以及证书、人员、业绩、其他材料的 save/delete

**I. 导出与模板**
- `export.exportWord(3)`（Main 弹保存框）、`export.openFile(5)`（系统程序打开）、⚡`export.onWordExportProgress(3)`
- `templates.list(3)`、`get(2)`、`create`、`update`、`delete`、`duplicate`、`renderPreview`（经 OpenXmlHelper 生成 Word 样张）

**J. 文件 / 插件**
- `file.getPathForFile(8)`：把拖拽的 `File` 转成本地绝对路径。所有上传入口都依赖它，Web 里**不存在等价能力**。
- `plugins.*` 12 个方法共 21 处：市场、安装（含离线）、卸载、启停、更新、`openConfig`（独立 BrowserWindow）、`notifyEvent`；已暴露未调用：`plugins.checkUpdates`

**K. 开发者工具（只在开发者模式）**
- `developerTokenStats.*`、`developerAgentMonitor.*`（含 `openWorkspace` 打开本地目录）、`developerExpansionReplaceTest.run`、`developerLayoutFigure.*`

## 3. Electron Main 中依赖本地能力的部分

| 类别 | 关键实现 | 本地依赖 |
|---|---|---|
| **文件系统** | `utils/paths.cjs`、`fileService.cjs`、各 Store、`utils/importedImages.cjs`、`storageCleanupService.cjs`、`utils/forceRemove.cjs` | `userData/` 下的 `user_config.json`（含明文 API Key）、`workspace/<feature>/`、`imported-images/`、`generated-images/`、`logs/`、`plugins/`、`agent-runtime/pi/`；`dialog.showOpen/SaveDialog`（fileService、knowledgeBase、export、checkResultExport、license、credentialLibrary、plugin、agent）；`shell.openPath/openExternal`；自定义协议 `app-asset://` |
| **文档解析** | `fileService.cjs` → `doc2markdown/convert.mjs` | mammoth、pdf-parse/pdfjs、xlsx、turndown；`.doc/.wps` 通过 `child_process` 调本机 **LibreOffice**；可选 MinerU 在线 API |
| **SQLite** | `sqliteDatabase.cjs`（55 张表、migration、健康检查、备份）、`technicalPlanStore`、`knowledgeBaseStore`、`rejectionCheckStore`、`duplicateCheckStore`、`feasibilityReportStore`、`templateStore`、`taskLogStore`、`officialInvoiceStore`、`textTokenStatsStore`；`piPersistentTaskStore` | `better-sqlite3` native 模块，单文件 `app.sqlite`，**同步 API**，整库默认单用户（表中没有 user/tenant 字段，大量 `*_meta` 是单行“当前项目”） |
| **.NET OpenXmlHelper** | `openXmlHelperService.cjs`、`pi/piOpenXmlTool.cjs`、`technicalPlanExport.cjs`、`contentGenerationOutput.cjs`、`templateExtractionTask.cjs` | 随包 .NET 10 自包含可执行文件（`vendor/openxml-tools/<platform>`），常驻子进程，stdin/stdout 一行 JSON 信号，**任务目录在 `userData/workspace` 下靠共享文件系统交换数据**，一次只跑一个任务 |
| **Pi Agent 命令工具** | `agentService.cjs`、`services/pi/*`、`services/agent/agentToolEnvironment.cjs`、`agentOpenAiProxy.cjs`、`piSelfCheckService.cjs` | `@earendil-works/pi-coding-agent` 在 Main 内运行；七个原生工具 `read/write/edit/bash/grep/find/ls` **直接操作本机文件系统**；`bash` 在 Windows 上实际是 PowerShell 5.1，其他系统是 `/bin/sh`；随包 `rg`/`fd`/`jq`（`vendor/agent-tools`）注入 PATH；本地 HTTP 代理把 Pi 请求转到 `aiService`；Agent 最终失败只写本机日志（旧仓库 PR #10 起不再上传） |
| **后台任务** | `taskService.cjs`（技术方案 / 查重 / 废标三组互斥任务、checkpoint、重启恢复）、`knowledgeBaseService.cjs`（文档级 preparation/matching）、`contentGeneration*.cjs`、`aiService.cjs`（文本/生图队列、并发、重试、Token 统计）、`exportService.cjs` | 进程内内存状态 + SQLite 持久化；进度通过 `webContents.send` 推送；队列作用域和取消信号都在单进程内 |
| **离屏渲染** | `localImageRenderService.cjs`（HTML/Mermaid → PNG）、`contentGenerationLayout.cjs` + `wordLayoutPreload.cjs`（隐藏窗口里跑 docx-editor 做 Canvas 分页测量） | 隐藏的 Electron `BrowserWindow` / Chromium |
| **其他本机能力** | `systemFontService.cjs`（子进程枚举系统字体）、`utils/clientIdentity.cjs`（随机安装标识，用于配置中的 client_id；0.16 起不再读取机器码，许可证已在 0.15 移除）、`updateService.cjs`（electron-updater，0.15 起更新源默认为空）、`pluginService.cjs` + `pluginContext.cjs`（`require()` 加载第三方插件代码并给 `ipcMain`、`BrowserWindow`）、GPU 加速开关 | 依赖桌面进程和本机 |

## 4. 每一类的 Web 服务端方案与难度

| 类别 | Web 方案 | 难度 | 关键风险 |
|---|---|---|---|
| **bridge 层**（第 2 节全部） | 新建 `WebBridge`（`src/shared/bridge/webBridge.ts`，旧仓库 PR #24 已建空壳）实现 `AppBridge` 接口：`invoke` → `fetch('/api/<channel>')`，事件 → 一条 WebSocket/SSE 按频道分发，`onXxx` 仍返回取消函数。Electron 和 Web 两套实现并存，Renderer 业务代码基本不动 | 中 | 约 170 个通道要逐一映射；`hasOwnProperty` 型 patch 语义必须在 JSON 序列化后保持（`undefined` 字段会丢失，需要改用显式 `null` 或字段清单） |
| **文件选择 / 路径**（`getPathForFile`、`importXxx(filePaths)`、`uploadDocuments`、`addProfileImages`、`selectDuplicateCheckFiles`） | 改成浏览器 `<input type=file>` / 拖拽 → multipart 上传或分片直传对象存储，接口参数从 `filePaths` 改成 `uploadIds` | 中 | 改接口签名，Renderer 上传区组件（`UploadBoard` 等）要改；上传必须做类型/大小/文件名校验（这是唯一的用户输入边界） |
| **导出 / 打开文件**（`exportWord`、`exportExcel`、`openFile`、`openBidTemplate`、`openConfigFolder`、`app-asset://`） | 服务端生成后返回下载 URL（带签名、短时效）；`openFile` 改成浏览器下载/在线预览；`app-asset://` 改成带鉴权的 `/assets/:userId/...` 静态路由 | 低-中 | 资源 URL 必须校验归属，防止跨用户访问 |
| **配置 / API Key**（`config.*`） | `user_config.json` 拆成按用户的 DB 记录；API Key 加密存储（KMS/信封加密），**只在服务端解密使用**，`config.load` 返回脱敏值；模型列表、模型测试在服务端代理 | 中 | 桌面版 `config.load` 已改为打码返回、保存时空值不修改（0.14，`services/configSecrets.cjs`）；Web 化时把这层搬到服务端，并补上加密存储 |
| **SQLite** | 迁到 PostgreSQL：所有表加 `user_id`/`workspace_id`，把单行 `*_meta` “当前项目”模型改成“多项目”；Store 从 `better-sqlite3` 同步 API 改成异步（Kysely/Drizzle + 事务）；`sqliteDatabase.cjs` 的 migration 转成正式迁移工具；`sql/workspace_schema.sql` 作为目标结构起点 | **高** | Store 共约 9 千行同步代码，`checkpointTask` 依赖同步事务原子性；要逐 Store 改写并保持 `saveOutline reason` 等持久化协议不变 |
| **文件型产物**（workspace 下的 Markdown、图片、Word、Agent 会话目录） | 对象存储（S3/MinIO）保存长期产物，按 `tenant/user/project/...` 前缀隔离；任务执行时拉到 worker 本地临时目录，结束后回写 | 中-高 | 现在大量逻辑靠“同一台机器上的路径”串起来（OpenXmlHelper 任务目录、Agent 工作区、HTML 引用图片），需要定义清楚“工作区挂载”约定 |
| **文档解析**（mammoth/pdf/xlsx/LibreOffice/MinerU） | 纯 JS 部分直接搬到服务端；LibreOffice 放进 worker 镜像（`soffice --headless`）；MinerU 保持服务端调用 | 低-中 | `pdfjs-dist`、`xlsx` 存在高危漏洞，处理多用户上传前必须升级或隔离；解析放在受限容器里，设超时和资源上限 |
| **.NET OpenXmlHelper** | 作为独立 sidecar / 微服务容器（.NET 10 本身跨平台）：保留现有“任务目录 + 一行 JSON 信号”协议，worker 与 helper 共享同一临时卷；或者包一层 HTTP/gRPC，入参出参走对象存储。按并发需要水平扩展多个实例（现在一次只跑一个任务） | 中 | 需要验证 Linux 下的中文字体、EMF/WMF 处理与 Windows 输出一致；`job` 名称校验已经有防路径穿越 |
| **Pi Agent 命令工具** | **每个 Agent 任务一个隔离沙箱**（容器 / gVisor / Firecracker），工作区挂载到沙箱内；`bash` 统一用 Linux `/bin/sh`，`rg`/`fd`/`jq` 预装进镜像；禁网或只放行到内部 AI 网关；资源和时长配额；Agent 的 `ask-user` 问答通过 WebSocket 推到对应用户 | **高** | 现在的工具直接操作本机，多用户服务端上这是**任意命令执行**面，必须做到沙箱隔离、不能挂载其他用户的数据；提示词里写死的 “Windows PowerShell 5.1” 等环境说明要随之调整；`agentToolEnvironment` 的 PATH 注入改成镜像内置 |
| **后台任务** | 任务队列（BullMQ + Redis，或基于 Postgres 的 pg-boss/Graphile Worker），API 进程只负责入队；worker 进程执行 `taskService` 逻辑；进度经 Redis pub/sub → WebSocket 推给对应用户；`queueScopeId`、取消、暂停改成“任务记录状态 + 分布式取消信号”；重启恢复逻辑原样复用到 worker 启动 | **高** | 现在的互斥是“全局一组只能跑一个”，Web 化后要改成“每用户/每项目”互斥；`aiService` 的并发上限要从“单机”改成“每用户 + 全局”两级；长任务（正文生成可能跑几十分钟）需要可抢占和断点续跑 |
| **离屏渲染**（HTML/Mermaid 转图、docx-editor 分页测量） | worker 内用 Playwright + Chromium（headless）替代隐藏 `BrowserWindow`；字体随镜像安装，保证与桌面版测量口径一致 | 中 | 渲染的是 AI 生成的 HTML，需要禁网、禁 JS 外联，并在独立 Chromium 上下文中执行 |
| **AI 服务**（`aiService.cjs`、Agent 本地代理） | 基本可以原样搬到服务端（本来就在 Main）；作为 AI 网关统一管理 Key、队列、重试和 Token 统计；`onHttpError`/`onBalanceInsufficient` 改成按用户推送 | 低-中 | 客户端埋点已在 0.19 删除；如需统计另行设计服务端统计，不得包含用户文档内容和 API Key |
| **鉴权 / 账户 / 许可证** | 新增用户体系（邮箱验证码登录或接 OIDC；原“官方账户”已在 0.17 移除，不再复用），会话用 HttpOnly Cookie；**每个 API 都要校验资源归属**；原机器码许可证模型（已在 0.15 移除）改成按账户/席位授权 | 中-高 | 当前代码按“本机可信、不做层间校验”设计（AGENTS.md 明确规定），Web 化后这条前提**不再成立**，鉴权、授权和输入校验要从头补上 |
| **更新 / GPU / 系统字体** | 更新和 GPU 在 Web 端删除或做成空实现；系统字体改成“服务端可用字体列表”（Word 导出实际用的就是服务端字体） | 低 | — |
| **插件** | 现有插件在 Main 中 `require()` 任意代码并拿到 `ipcMain`/`BrowserWindow`，**不能**搬到多用户服务端。Web 版建议先下线，以后重做成前端 iframe 沙箱 + 受限 API（桌面版已在 0.13 停用，代码保留） | 高（重做）/ 低（下线） | 安全边界完全不同 |
| **开发者工具** | Token 统计、Agent 监视器改成管理员页面（按任务查看）；`openWorkspace` 改成在线浏览工作区文件 | 低-中 | 只对管理员开放 |

## 5. 建议的后端技术栈

详细设计和与下列建议的偏离见 `docs/SERVER_DESIGN.md` 及上方“第 2 步说明”。

- **语言 / 框架**：**Node.js 22 + TypeScript + Fastify**（或 NestJS）。理由：现有约 4.6 万行 Main 业务是 Node CommonJS，`aiService`、`taskService`、各 Task、Pi Agent SDK（`@earendil-works/pi-coding-agent`）、cheerio/mammoth/docx 等都能直接复用，迁移成本最低。
- **数据库**：**PostgreSQL**（多租户、并发写、JSONB 存编排/运行时快照），ORM 用 Kysely 或 Drizzle；迁移工具用 Drizzle Kit / node-pg-migrate。
- **任务队列**：**BullMQ + Redis**（Redis 同时用于进度 pub/sub 和分布式取消信号）；如果想少一个组件，可以用 pg-boss。
- **实时推送**：WebSocket（`@fastify/websocket` 或 Socket.IO），一条连接按频道复用，对应现在 19 个 `onXxx` 事件。
- **文件存储**：S3 兼容对象存储（自建可用 MinIO），签名 URL 上传和下载。
- **Word 助手**：现有 `openxmlhelper/` .NET 10 独立容器，与 worker 共享临时卷。
- **Agent 沙箱**：Docker/Kubernetes Job + gVisor（或 Firecracker），镜像内置 `rg`/`fd`/`jq`、LibreOffice、中文字体、Chromium（Playwright）。
- **鉴权**：邮箱验证码 / OIDC + HttpOnly Session Cookie，RBAC 至少分普通用户和管理员。（旧仓库 PR #26 决定：邮箱 + 密码和手机号 + 短信验证码两种，第一版只做邮箱 + 密码。）
- **密钥**：~~用户自带的 API Key 用信封加密（KMS 或 libsodium + 主密钥）存库~~。旧仓库 PR #26 决定由平台统一提供 AI 并按量计费：平台持有的模型服务 Key 用信封加密存库，主密钥在云 KMS（`docs/SERVER_DESIGN.md` 第 4、10 节）。
- **部署**：Docker Compose 起步（api / worker / openxml / redis / postgres / minio），之后上 K8s；不自建 `analytics/` Worker（0.18 决定，0.19 已删除该目录和客户端埋点）；上线后如需统计，另行设计服务端统计，不沿用客户端埋点。

## 6. 分步改造顺序（每步一个或几个小 PR）

0. **前置**：处理 `npm audit` 中跟上传、解析、网络相关的高危漏洞（`pdfjs-dist`、`xlsx`、`adm-zip`、`undici`、`tar`）；~~补 Web 版的 AGPL 第 13 条源码链接方案~~（0.5：改为闭源商业授权后不再需要）。
1. **抽象 bridge**：Renderer 改成从 `src/shared/bridge` 获取 API（默认仍是 `window.appBridge`），类型继续以 `ipc.ts` 为准。行为零变化，Electron 照常可用。
2. **服务端骨架**：Fastify + 鉴权 + PostgreSQL + 用户/工作区表；`WebBridge` 打通 `invoke` → HTTP 和事件 → WebSocket 的通用机制，先迁 `getVersion`、`config.*` 这类无状态接口。
3. **配置与 AI 网关**：配置按组织 / 用户入库；平台统一提供 AI（旧仓库 PR #26），API Key 由平台持有、只在服务端；`aiService` 搬到服务端成为 AI 网关，同时实现平台模型清单、用量计量、余额检查和价格表（`docs/SERVER_DESIGN.md` 第 10 节）；`ai.chat/requestJson/testImageModel`、`config.listModels/getModelInfo` 走服务端，后两者只在管理后台提供。
4. **文件上传 / 下载 / 资源协议**：上传接口 + 对象存储 + 带鉴权的资源路由，替换 `getPathForFile`/`filePaths`、`app-asset://`、`openFile`、保存对话框。
5. **数据层迁移（按业务逐个）**：模板库 → 资信库 → 知识库 → 标书查重 → 废标检查 → 可研报告 → 技术方案，每个 Store 改成异步 Postgres 实现并按 `org_id`（项目级再加 `project_id`）隔离；不做 `app.sqlite` 导入（旧仓库 PR #26 第 18 项）。拆分为 13 个 PR，先做 `projects` 和生成产物存储，见“第 5 步说明”。
6. **任务队列与 worker**：`taskService` 迁到 BullMQ worker，进度推送、暂停/继续、重启恢复、每用户互斥和两级并发上限。先迁无 Agent 的短任务（查重、废标、招标解析）；目录、全局事实经核实用到 Agent 命令工具，改随第 8 步（见“第 6 步说明”）。解析在断网沙箱中执行，建议提前建 `sandbox-runner` 和只含 `parse` 模板的沙箱基础设施，拆分计划与待决定事项见“第 6 步说明”。文档解析须满足第 4 步说明中“上传白名单补充（#6）”的“第 6 步解析要求”（沙箱完全断网、HTML / MHT / RTF 禁止加载远程资源、XML 类格式禁用 DTD 和外部实体等）。
7. **OpenXmlHelper 容器化**：Word 导出、模板样张、模板提取改成调用 helper 服务；离屏渲染改成 Playwright。前置：CI 新增 .NET 编译与 OpenXmlHelper 测试（#5 登记）。
8. **Agent 沙箱**：Pi Runtime 迁到隔离沙箱，最后迁正文生成、原方案还原、格式自检这类最复杂的长任务。
9. **收尾**：插件下线或重做、开发者工具改管理员页面；不自建 analytics Worker（0.18 决定；客户端埋点、内容服务代码和 `analytics/` 目录已在 0.19 删除）；压测、安全评审，再上线。
   上线检查（对外提供服务前逐项完成）：
   - ~~品牌名替换：旧产品名、旧 bridge 全局名、旧资源协议和数据库文件名等已有命名统一改为本项目名称“智标” / ZhiBiaoTools（第 1 步前决定第 3 项推迟到此）~~ 已完成：第一部分（用户可见文字和文档）见 #1，第二部分（其余全部）见“第 9 步说明”；
   - ~~原产品名缩写前缀改为中性前缀 `app`，完成后把该缩写加入 CI 禁用词检查~~ 已完成：品牌改名第三部分，见 #5 和“第 9 步说明”；
   - 升级 GitHub 计划，使分支保护在私有仓库上强制生效：`main` 要求 PR 合并，CI 的 `Banned words`、`Client build / syntax / audit`、`Server typecheck / test / audit` 设为必须通过；当前免费版私有仓库的分支保护不生效，`#3`（临时草稿 PR，已关闭）验证时 `Banned words` 失败但 PR 仍显示为可合并（`mergeable_state: unstable`）；升级后用同样方法复测，确认显示为无法合并（`blocked`）；
   - 把 `SECURITY.md`、`CODE_OF_CONDUCT.md`、`.github/ISSUE_TEMPLATE/问题反馈.md` 中的 `{{CONTACT_EMAIL}}` 占位符（0.20）替换为本项目的联系方式；
   - 重写 Web 版隐私声明：现有设置页隐私声明按桌面版“数据保存在本机”编写，Web 版需说明服务端存储的数据、API Key 的保管方式、日志与保留期限、删除方式；按 旧仓库 PR #26 决定还要写明服务器位于境外（香港）、调用的第三方模型服务商、用量记录的保留期，以及项目删除后 7 天恢复期、注销后 30 天内删除；任务记录的保留期（已结束的任务 90 天、任务日志 30 天，决定事项（#23）第 10 项；项目被物理删除时其下的任务记录随之删除，见“清理任务（#33，6.8）”偏离第 4 项）；
   - 完成 `docs/SERVER_DESIGN.md` 第 11 节“合规待确认事项”（旧仓库 PR #26），每项都有律师确认的结论并已落实到设计和界面，未完成不得对外提供服务：
     - 个人信息出境：合规路径、告知与单独同意、个人信息保护影响评估、向模型服务商再转移、备份地域；
     - 生成式 AI 监管：是否适用及所需备案或登记、生成内容标识、内容审核与投诉渠道、用户身份要求；
     - 模型服务商对中国大陆用户的条款限制：逐家确认，确定 `platform_models` 上架清单；
     - 第一版线下收款的主体、方式与币种；
   - 发信服务选定并完成 QQ / 163 等邮箱的送达率实测（`docs/EXTERNAL_SERVICES.md` §7）；**首个真实用户注册前必须完成**（旧仓库 PR #31），不必等到上线；
   - 数据库角色（#9 汇总）：生产数据库按 `server/db/init/10-provision.sh` 同样的属性创建**全部**角色，写进部署文档：迁移角色 `bidtools_owner`、应用角色 `bidtools_app`，以及全部 `SECURITY DEFINER` 函数属主（定义者角色）`bidtools_auth`（旧仓库 PR #29）、`bidtools_billing`（旧仓库 PR #31）、`bidtools_storage`（#8）、`bidtools_jobs`（#25）、`bidtools_cleanup`（#33）。定义者角色一律 `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`，迁移角色以 `INHERIT FALSE, SET TRUE` 加入；缺任何一个，迁移在 `SET ROLE` 时失败。执行迁移前对照 `server/src/db/roles.ts` 逐个核对 `pg_roles` 中的属性和 `pg_auth_members` 中的成员关系；以后新增定义者角色时同步加到本条、`10-provision.sh` 和测试 harness；
   - 鉴权上线前提（旧仓库 PR #29）：数据库角色见上一条；发信接口换成正式发信服务的实现；登录、注册、找回密码的限流从进程内存换成 Redis（多实例部署前必须完成）；按反向代理拓扑设置 `TRUSTED_PROXIES`（旧仓库 PR #30，只填 Caddy 的固定地址），用两个不同出口的客户端确认限流和会话中的 IP 是真实客户端地址；用 `npm run admin:create` 创建首个平台管理员后，确认平台管理员已开启 TOTP（设计文档第 3.4 节，TOTP 尚未实现）；
   - 计费核对：价格表已录入并公示，计价函数测试通过，余额不足拒绝新任务和运行中耗尽暂停已实测，管理员充值的 TOTP 和双人复核已启用；旧仓库 PR #31 暂用重新输入密码做二次验证并禁用 1,000 元以上的单笔充值，TOTP 和双人复核实现后再用新迁移放开大额充值；`bidtools_billing` 角色见“数据库角色”一条；
   - AI 网关（旧仓库 PR #32）：主密钥从 `AI_KEK_FILE` 换成云 KMS 的 `KeyWrapper` 实现（第 9 节第 8 项），开启删除保护和调用审计；6.4（#27）起 worker 同样解密平台 Key，KMS 的解密权限同时授给 api 和 worker 的身份；按真实服务商的限流设置 `AI_CONCURRENCY_MAX`；生产环境 `AI_UPSTREAM_PRIVATE_HOSTS` 为空；确定通义千问使用国内站还是国际站并在管理后台填写对应 Base URL；用真实 Key 在预发环境核对两家服务商流式响应中的用量字段与控制台账单一致；
   - 任务计费（#27、6.4a）：平台自身故障（worker 崩溃、租约收回、重启）导致的重复调用不向用户收费，6.4a 已完成（#34）且其“结算后、checkpoint 前崩溃只扣费一次”的测试在 CI 中通过；所有调用 AI 的业务任务都经步骤幂等调用模型（`context.ai.chat` 的 `stepKey` 必填，网关拒绝不带步骤键的任务调用），各业务任务 PR 审查步骤键在续跑时可以重新算出、不同调用不重复；`job_step_results` 存有 AI 输出，随任务记录 90 天保留期删除，写进隐私声明；
   - 实时推送（#26）：Caddy 对 `/api/events` 关闭响应缓冲和压缩（`flush_interval -1`、`encode` 排除 `text/event-stream`），开启 HTTP/2（每个页面一条长连接，HTTP/1.1 每域名只有 6 条）；Caddy 与 api 的空闲 / 读超时大于 25 秒的心跳间隔；`WebBridge` 在 `GET /api/events` 返回非 200 或连接断开时按退避间隔自己重建连接（浏览器 `EventSource` 遇到 503 不再重连），收到 `ready` 后再拉快照、收到 `resync` 时重新拉快照、收到 `closed`（`session`）时转登录页；在预发环境确认经 Caddy 的推送没有延迟、断线后能补发；**扩展为多个 api 实例前**，把 `GET /api/events` 的单用户连接数上限（目前每个 api 进程各自计数，见“SSE 推送（#26，6.3）”偏离第 4 项）改为跨实例计数（例如 Redis 中按用户计数并带过期时间）；
   - Redis（#24）：生产用与开发相同的 `server/redis/start-valkey.sh`（禁用 `default` 用户、ACL 用户 `bidtools`、禁止 `@admin` 与清空命令、不持久化、`noeviction`），`maxmemory` 按实例内存设置（`REDIS_MAXMEMORY`）；redis 只在 `internal: true` 的 `backend` 网络上、不映射端口；密码走 Docker secret；api 和 worker 都设置 `REDIS_URL`，确认 `/readyz` 在停掉 Redis 后返回 503；
   - 解析沙箱（#28）：生产主机安装 gVisor 并在 Docker 中登记 `runsc`，`SANDBOX_RUNTIME=runsc`（配置强制）；**限制 sandbox-runner 的 Docker 权限，不得直接挂载有完整权限的 Docker socket**，二选一：(a) 只放行必要接口的 Docker API 代理（只放行“sandbox-runner 的访问控制”中列出的接口，其余一律拒绝；`POST /containers/create` 还要校验请求体：只允许配置的 parse 镜像、`runsc` 运行时、`NetworkMode: none`、`ReadonlyRootfs: true`、`Privileged: false`、`CapDrop: [ALL]`、不带 `Binds` / `Mounts` / `Devices` / `CapAdd`，例如用 Docker 授权插件或自建的校验代理，只按路径放行的代理挡不住被攻破的 sandbox-runner 创建特权容器），或 (b) 在专用的非 root 用户下运行 rootless Docker（或 Podman），使 sandbox-runner 被攻破也拿不到宿主 root；上线前用一个伪造的特权容器创建请求、一个未放行的接口（如 `GET /images/json`、`POST /containers/{id}/attach`）确认被拒绝；parse 镜像在 CI 中构建并做漏洞扫描，`SANDBOX_PARSE_IMAGE` 按摘要引用、部署前预先拉取；`sandbox-control` 为 `internal: true` 且只有 worker 与 sandbox-runner；令牌走 Docker secret；在生产主机上（实际的 gVisor 版本和内核）跑一遍 `npm run test:sandbox`；
   - 从大陆主要省份和运营商实测访问香港服务器的延迟和可用性（`docs/SERVER_DESIGN.md` 第 8.0 节）。
   - 文件存储（旧仓库 PR #34）：选定云厂商对象存储（与 KMS 同一家、香港地域），bucket 私有、禁止公开读和列目录，开启服务端加密（默认加密或 KMS 密钥），配置生命周期规则清理未完成的分片上传；api 使用只能访问该 bucket 的最小权限访问密钥；用真实服务跑一遍 `tests/db/files.test.ts` 确认 S3 兼容性；过期文件和遗留 `uploading` 记录的物理清理任务已上线（否则对象只增不减；#33 实现，在 worker 中每小时一批，未配置 `S3_BUCKET` 时不删有对象的行，上线时确认 worker 配置了对象存储并在日志中看到每小时一组 `cleanup batch`）；Caddy 层设置请求体上限（略大于 100 MB）；`S3_ENDPOINT` 为 https。
