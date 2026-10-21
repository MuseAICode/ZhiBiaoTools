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
| 5 | 数据层迁移（按业务逐个） | 进行中 | 旧仓库 PR #35（拆分计划，见“第 5 步说明”；记录上传白名单与桌面版的差距）、#7（5.1 项目：`projects` 表、`files.project_id`、项目接口、路由层归属校验、项目级表的迁移与测试模板）、#8（5.2 生成产物存储：`artifacts` 表、Store、只读接口；项目软删除与其下文件、产物联动，由 RLS 强制）、#9（5.3 配置：`org_settings`、`user_settings`、`GET/PATCH /api/settings`；写权限与删除可见性由 RLS 强制）、#10（5.4 导出模板：`export_templates`、`/api/export-templates` 增删改查与复制；系统模板只读、修改删除权限由 RLS 强制，迁移命令同步系统模板）、#11（5.5 资信库：6 张表、`/api/credential-library`；权限与删除可见性由 RLS 强制，图片随所引用文件的生命周期）、#12（5.6 知识库（一）：`knowledge_folders`、`_documents`、`_document_steps`、`/api/knowledge-base` 文件夹与文档管理；权限与删除可见性由 RLS 强制，文档随原件的生命周期）、#14（5.7 知识库（二）：切块、条目、匹配结果等 7 张表，检索与读取条目 / 分析 / Markdown 接口；删除可见性与写权限由 RLS 强制，随文档可见）、#16（5.8 标书查重：13 张项目级表、`/api/projects/:projectId/duplicate-check` 状态 / 文件选择 / 页面状态 / 清空 / Excel 导出；删除可见性与写权限由 RLS 强制，随项目和所选原件可见）、#17（5.8 后续：`files.project_id` 设置后不能再改，由触发器强制；xlsx 写出器防公式注入，回车按原样写出）、#18（5.9 废标检查：7 张项目级表、`/api/projects/:projectId/rejection-check` 状态 / 导入与移除文档 / 页面状态 / 切换与删除问题 / 清空 / Excel 导出；删除可见性与写权限由 RLS 强制，文档随原件可见，签名由服务端现算）、#19（5.10 可研报告：4 张项目级表、`/api/projects/:projectId/feasibility-report` 状态 / 步骤 / 项目信息 / 资料分析 / 目录配置 / 目录（`reason` 协议）/ 关键参数 / 正文 / 资料导入与移除 / 资料 Markdown / 清空；删除可见性与写权限由 RLS 强制，资料随原件、引用随知识库文档可见） |
| 6 | 任务队列与 worker | 未开始 | — |
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
| 5.11 | E 技术方案（一）：`technical_plan_meta`、`_generation_config`、`_generation_bid_tasks`、`_generation_reference_docs`、`_bid_items`，状态、配置、招标文件 / 原方案、标段接口 | 5.1、5.2、5.6 | 未开始 | — |
| 5.12 | E 技术方案（二）：`_outline_nodes`、`_global_fact_groups`，`saveOutline`（`reason` 协议、节点 UUID 与 `sort_order` 语义不变）、`saveGlobalFacts` | 5.11 | 未开始 | — |
| 5.13 | E 技术方案（三）：`_content_sections`、`_content_plans`，`saveChapterContent`、`resetContentGeneration`；补上废标检查的 `importTenderFromTechnicalPlan` | 5.12、5.9 | 未开始 | — |

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
6. **任务队列与 worker**：`taskService` 迁到 BullMQ worker，进度推送、暂停/继续、重启恢复、每用户互斥和两级并发上限。先迁无 Agent 的短任务（查重、废标、招标解析），再迁目录、全局事实。文档解析须满足第 4 步说明中“上传白名单补充（#6）”的“第 6 步解析要求”（沙箱完全断网、HTML / MHT / RTF 禁止加载远程资源、XML 类格式禁用 DTD 和外部实体等）。
7. **OpenXmlHelper 容器化**：Word 导出、模板样张、模板提取改成调用 helper 服务；离屏渲染改成 Playwright。前置：CI 新增 .NET 编译与 OpenXmlHelper 测试（#5 登记）。
8. **Agent 沙箱**：Pi Runtime 迁到隔离沙箱，最后迁正文生成、原方案还原、格式自检这类最复杂的长任务。
9. **收尾**：插件下线或重做、开发者工具改管理员页面；不自建 analytics Worker（0.18 决定；客户端埋点、内容服务代码和 `analytics/` 目录已在 0.19 删除）；压测、安全评审，再上线。
   上线检查（对外提供服务前逐项完成）：
   - ~~品牌名替换：旧产品名、旧 bridge 全局名、旧资源协议和数据库文件名等已有命名统一改为本项目名称“智标” / ZhiBiaoTools（第 1 步前决定第 3 项推迟到此）~~ 已完成：第一部分（用户可见文字和文档）见 #1，第二部分（其余全部）见“第 9 步说明”；
   - ~~原产品名缩写前缀改为中性前缀 `app`，完成后把该缩写加入 CI 禁用词检查~~ 已完成：品牌改名第三部分，见 #5 和“第 9 步说明”；
   - 升级 GitHub 计划，使分支保护在私有仓库上强制生效：`main` 要求 PR 合并，CI 的 `Banned words`、`Client build / syntax / audit`、`Server typecheck / test / audit` 设为必须通过；当前免费版私有仓库的分支保护不生效，`#3`（临时草稿 PR，已关闭）验证时 `Banned words` 失败但 PR 仍显示为可合并（`mergeable_state: unstable`）；升级后用同样方法复测，确认显示为无法合并（`blocked`）；
   - 把 `SECURITY.md`、`CODE_OF_CONDUCT.md`、`.github/ISSUE_TEMPLATE/问题反馈.md` 中的 `{{CONTACT_EMAIL}}` 占位符（0.20）替换为本项目的联系方式；
   - 重写 Web 版隐私声明：现有设置页隐私声明按桌面版“数据保存在本机”编写，Web 版需说明服务端存储的数据、API Key 的保管方式、日志与保留期限、删除方式；按 旧仓库 PR #26 决定还要写明服务器位于境外（香港）、调用的第三方模型服务商、用量记录的保留期，以及项目删除后 7 天恢复期、注销后 30 天内删除；
   - 完成 `docs/SERVER_DESIGN.md` 第 11 节“合规待确认事项”（旧仓库 PR #26），每项都有律师确认的结论并已落实到设计和界面，未完成不得对外提供服务：
     - 个人信息出境：合规路径、告知与单独同意、个人信息保护影响评估、向模型服务商再转移、备份地域；
     - 生成式 AI 监管：是否适用及所需备案或登记、生成内容标识、内容审核与投诉渠道、用户身份要求；
     - 模型服务商对中国大陆用户的条款限制：逐家确认，确定 `platform_models` 上架清单；
     - 第一版线下收款的主体、方式与币种；
   - 发信服务选定并完成 QQ / 163 等邮箱的送达率实测（`docs/EXTERNAL_SERVICES.md` §7）；**首个真实用户注册前必须完成**（旧仓库 PR #31），不必等到上线；
   - 数据库角色（#9 汇总）：生产数据库按 `server/db/init/10-provision.sh` 同样的属性创建**全部**角色，写进部署文档：迁移角色 `bidtools_owner`、应用角色 `bidtools_app`，以及全部 `SECURITY DEFINER` 函数属主（定义者角色）`bidtools_auth`（旧仓库 PR #29）、`bidtools_billing`（旧仓库 PR #31）、`bidtools_storage`（#8）。定义者角色一律 `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`，迁移角色以 `INHERIT FALSE, SET TRUE` 加入；缺任何一个，迁移在 `SET ROLE` 时失败。执行迁移前对照 `server/src/db/roles.ts` 逐个核对 `pg_roles` 中的属性和 `pg_auth_members` 中的成员关系；以后新增定义者角色时同步加到本条、`10-provision.sh` 和测试 harness；
   - 鉴权上线前提（旧仓库 PR #29）：数据库角色见上一条；发信接口换成正式发信服务的实现；登录、注册、找回密码的限流从进程内存换成 Redis（多实例部署前必须完成）；按反向代理拓扑设置 `TRUSTED_PROXIES`（旧仓库 PR #30，只填 Caddy 的固定地址），用两个不同出口的客户端确认限流和会话中的 IP 是真实客户端地址；用 `npm run admin:create` 创建首个平台管理员后，确认平台管理员已开启 TOTP（设计文档第 3.4 节，TOTP 尚未实现）；
   - 计费核对：价格表已录入并公示，计价函数测试通过，余额不足拒绝新任务和运行中耗尽暂停已实测，管理员充值的 TOTP 和双人复核已启用；旧仓库 PR #31 暂用重新输入密码做二次验证并禁用 1,000 元以上的单笔充值，TOTP 和双人复核实现后再用新迁移放开大额充值；`bidtools_billing` 角色见“数据库角色”一条；
   - AI 网关（旧仓库 PR #32）：主密钥从 `AI_KEK_FILE` 换成云 KMS 的 `KeyWrapper` 实现（第 9 节第 8 项），开启删除保护和调用审计；生产环境 `AI_UPSTREAM_PRIVATE_HOSTS` 为空；确定通义千问使用国内站还是国际站并在管理后台填写对应 Base URL；用真实 Key 在预发环境核对两家服务商流式响应中的用量字段与控制台账单一致；
   - 从大陆主要省份和运营商实测访问香港服务器的延迟和可用性（`docs/SERVER_DESIGN.md` 第 8.0 节）。
   - 文件存储（旧仓库 PR #34）：选定云厂商对象存储（与 KMS 同一家、香港地域），bucket 私有、禁止公开读和列目录，开启服务端加密（默认加密或 KMS 密钥），配置生命周期规则清理未完成的分片上传；api 使用只能访问该 bucket 的最小权限访问密钥；用真实服务跑一遍 `tests/db/files.test.ts` 确认 S3 兼容性；过期文件和遗留 `uploading` 记录的物理清理任务已上线（否则对象只增不减）；Caddy 层设置请求体上限（略大于 100 MB）；`S3_ENDPOINT` 为 https。
