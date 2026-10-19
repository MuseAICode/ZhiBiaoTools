# 外部服务清单与独立运营评估

本文列出 `client/` 运行时会连接的所有外部服务，说明每个服务收发哪些数据、哪些功能依赖它、移除后的影响，并给出处理建议。基线是 `main` 的 `058ea05`（旧仓库 PR #7 合并后）。本文只做分析，不改代码；改动按“建议的处理顺序”另开 PR。

结论先行：

1. 原作者服务（`analytics.agnet.top`、内测版服务、`wiki.agnet.top`、`oss.agnet.top` 及另一个 `agnet.top` 子域的原作者 OSS）在**默认配置、用户什么都不操作**时就会被调用。其中三条链路会把**用户文档内容**发到原作者服务器：
   - ~~默认文本模型是“内测版”（`text_model_provider: 'official'`），所有 Prompt（含招标文件、知识库、生成的正文）都发到内测版服务~~（旧仓库 PR #11 已改为未配置；旧仓库 PR #12 把已选中官方的旧配置一次性迁移为未配置；旧仓库 PR #17 整体移除官方服务商和官方账户，见 §2.2）；
   - ~~Agent 失败诊断（`/agent-errors`）会把**整个 Agent 工作区目录的全部文件**、完整 Prompt 和任务状态打包上传，界面上没有开关~~（旧仓库 PR #10 已移除）；
   - ~~远程公告用 `allowRawHtml` 渲染，原作者可以向 Renderer 注入 HTML（见 §2.1.5）~~（旧仓库 PR #14 已改为禁用原始 HTML，`config.load` 也不再返回明文 Key）。
2. ~~两条链路能远程控制本地客户端：`/ip-blocks` 命中就 `process.exit(0)`；`/license/activate` 下发的配置可以把授权弹窗设成不可关闭~~（旧仓库 PR #15 已移除 IP 封禁和授权链路，并停用了原作者的更新渠道）。
3. ~~所有原作者服务都用同一个设备标识 `analytics_client_id`。它是操作系统机器码（Windows `MachineGuid` / macOS `IOPlatformUUID` / Linux `machine-id`）的确定性 SHA-256，重装软件也不变；授权链路还额外上报包含网卡 MAC 的指纹哈希~~（旧仓库 PR #15 移除授权指纹；旧仓库 PR #16 把 `analytics_client_id` 改为随机安装标识，客户端不再读取任何设备硬件标识）。
5. ~~埋点、公告、更新日志、资源、群二维码、模型信息、使用文档、打赏写死原作者地址~~（旧仓库 PR #16：改为构建时写入 `client/electron/resources/remote-services.json`，默认为空即不发请求）。旧仓库 PR #18 决定**不自建** analytics Worker；群二维码和金龙推广链接已在 旧仓库 PR #18 删除。旧仓库 PR #19 提前删除了 `analytics/` 目录和客户端埋点、公告、更新日志、资源页、模型信息代码，`remote-services.json` 只剩使用文档和打赏两个键。剩余引用见 §6。
4. 独立运营前，至少要处理 §4 列出的 P0 项。

## 1. 总表

| # | 服务 | 默认就会连接 | 发送用户文档内容 | 发送 API Key | 发送设备标识 | 建议 |
|---|---|---|---|---|---|---|
| 1 | `analytics.agnet.top/track`（埋点） | ~~是~~ 否（旧仓库 PR #16：地址默认为空） | 否 | 否 | ~~是（client_id）~~ 仅随机安装标识（旧仓库 PR #16） | **已停用（旧仓库 PR #16）**；不自建（旧仓库 PR #18 决定）；**客户端埋点代码已删除（旧仓库 PR #19）** |
| 2 | `analytics.agnet.top/agent-errors`（Agent 失败诊断） | ~~是（有授权文件时）~~ | ~~是（整个工作区）~~ | 否（已脱敏） | 是 | **已移除（旧仓库 PR #10）**，改为只写本机日志 |
| 3 | `analytics.agnet.top/license/activate`（授权） | ~~是~~ 否（旧仓库 PR #15） | 否 | 否 | ~~是（client_id + 机器/MAC 指纹）~~ | **已移除（旧仓库 PR #15）**，连同公钥、构建证明、离线授权和设置页授权区 |
| 4 | `analytics.agnet.top/ip-blocks`（IP 封禁） | ~~是~~ 否（旧仓库 PR #15） | 否 | 否 | 否（服务端取 IP） | **已移除（旧仓库 PR #15）** |
| 5 | `analytics.agnet.top/notice(s)`（公告） | ~~是（每 30 分钟）~~ 否（旧仓库 PR #16） | 否 | 否 | 否 | **已停用（旧仓库 PR #16）**，配置 `contentServiceUrl` 后指向自建 |
| 6 | `analytics.agnet.top/changelogs`（更新日志） | ~~是~~ 否（旧仓库 PR #16） | 否 | 否 | 否 | **已停用（旧仓库 PR #16）**，同上 |
| 7 | `analytics.agnet.top/resources`（资源页） | ~~打开页面时~~ 否（旧仓库 PR #16，菜单隐藏） | 否（搜索词会发送） | 否 | 否 | **已停用（旧仓库 PR #16）**，同上 |
| 8 | `analytics.agnet.top/system-settings`（群二维码） | ~~是~~ 否（旧仓库 PR #16） | 否 | 否 | 否 | **已删除（旧仓库 PR #18）**：“加群”按钮、内置二维码和远程查询一并删除 |
| 9 | `analytics.agnet.top/model-info`（模型参数查询） | ~~用户点击时~~ 否（旧仓库 PR #16，按钮隐藏） | 否（只发模型名） | 否 | 否 | **已停用（旧仓库 PR #16）**，同上 |
| 10 | `analytics.agnet.top/plugins`（插件市场与下载） | ~~是（启动检查更新）~~ 否（旧仓库 PR #13 停用插件系统） | 否 | 否 | 否 | **已停用（旧仓库 PR #13）**，代码保留，Web 版计划下线；旧仓库 PR #20 起地址置空，代码中不再有该地址 |
| 11 | 内测版服务（官方账户 + 官方模型 API） | ~~是（启动自动注册，且是默认文本模型）~~ 否（旧仓库 PR #11；旧仓库 PR #17 起客户端代码中不再有该地址） | ~~是（选用官方时，所有 Prompt）~~ 否 | ~~是（官方 Key）~~ 否 | ~~随机安装标识~~ 否 | **已移除（旧仓库 PR #17）**：官方服务商、官方账户服务及其 IPC、preload API、设置页账户面板一并删除 |
| 12 | `wiki.agnet.top`（使用说明 + 打赏支付） | ~~打赏：导出 Word 达到次数时弹出~~ 否（旧仓库 PR #16） | 否 | 否 | 否 | **已停用（旧仓库 PR #16）**：文档入口未配置时隐藏；打赏功能已删除（旧仓库 PR #20） |
| 13 | 更新渠道：~~`api.atomgit.com` / `atomgit.com`（默认）、`api.github.com` / `github.com`、原作者 OSS 域名（`agnet.top` 子域）~~ | ~~是（每 30 分钟）~~ 否（旧仓库 PR #15：更新源默认为空，不发请求） | 否 | 否 | 否 | **已停用（旧仓库 PR #15）**，更新源改为随包配置；接入自建更新服务器前须实现验签（第 9 步 Web 化时删除） |
| 14 | `oss.agnet.top`（启动广告图）+ `s.markup.com.cn/jl`（广告跳转） | ~~是（每次启动强制 8 秒）~~ **否**：组件从未被挂载（旧仓库 PR #16 核对） | 否 | 否 | 否 | **已删除（旧仓库 PR #16）**；设置页金龙“获取 Key”中的同一推广链接也已删除（旧仓库 PR #18） |
| 15 | `mt.agnet.top` | **否**：只出现在设计文档 `client/doc/html图片.md`，代码中没有调用 | — | — | — | 文档已标注废弃（旧仓库 PR #16）；旧仓库 PR #20 删除该段 |
| 16 | `raw.githubusercontent.com`（已装插件图标） | ~~打开插件页时~~ 否（旧仓库 PR #13 隐藏插件页） | 否 | 否 | 否 | **已停用（旧仓库 PR #13）**，随插件一起下线 |
| 17 | 第三方模型服务（~~`jlaudeapi.com`、`img-api.jlaudeapi.com`~~（旧仓库 PR #18 移除金龙预置服务商）、`ark.cn-beijing.volces.com`、`api.deepseek.com`、`apihub.agnes-ai.com`、`generativelanguage.googleapis.com`、自定义地址、本地 ComfyUI） | 仅当用户选用；~~默认生图模型是 jlaudeapi~~（旧仓库 PR #12 已改为未配置） | 是（Prompt） | 是（用户自己的 Key） | 否 | 保留，调整默认值 |
| 18 | `mineru.net`（在线文档解析） | 仅当用户选用（默认 `local`） | **是（原始文件）** | 是（用户 MinerU Token） | 否 | 保留，作为用户可选项 |
| 19 | Markdown 中的任意 `http(s)` 图片 URL（Word 导出时下载） | 内容中有远程图片时 | 否 | 否 | 否（暴露 IP） | 保留；Web 化时加 SSRF 防护 |

“设备标识”指 `analytics_client_id`，下文统一称 client_id。

## 2. 逐项说明

### 2.1 `analytics.agnet.top`（原作者的 Cloudflare Worker）

服务端代码就是本仓库的 `analytics/worker/`，部署在原作者 Cloudflare 账户，自定义域 `analytics.agnet.top`（`analytics/worker/wrangler.jsonc`），Dashboard 在 `static.analytics.agnet.top`。Worker 用 `getRequestClientIp` 记录请求方公网 IP（`analyticsTrack.js` → Analytics Engine `blob13`），Dashboard 可以按 IP 查看客户端数和 Token 用量。

> **决定（旧仓库 PR #18）：不自建这个 Worker。** 下面各小节中“替换为自建”的建议不再执行：客户端的埋点（§2.1.1）和内容服务代码（§2.1.5~§2.1.7、§2.1.9）保持当前“默认为空、不发请求”，在路线图第 9 步删除；群二维码（§2.1.8）已在 旧仓库 PR #18 删除。`analytics/` 目录暂时保留，删除时机另定。

#### 2.1.1 `/track` 普通埋点

- 代码：`src/shared/analytics/analytics.ts`（Renderer）、`electron/services/aiService.cjs` `trackAiRequest`、`electron/services/agent/agentRuntimeAnalytics.cjs`。
- 发送：
  - 公共字段：`projectName`、`event`、版本、平台、架构、`client_id`、`client_created_at`；
  - Renderer 事件还带授权快照：`license_status`、`license_plan`、`license_expires_at`、`source_trusted`、`untrusted_reason`；
  - `app_open`、`page_view`（页面名）、`resource_click`（资源 key）；
  - `config_usage`：24 项生成参数，例如文件解析方式、生图开关、字数设置、审计开关；
  - `ai_request`：每次 AI 请求都发，包含模型提供方、模型地址的 **hostname**、模型名、Token 用量；
  - `agent_runtime`：Agent 成功/失败、重试次数、模型提供方/hostname/模型名。
- 不发送：API Key、Prompt、响应、文件内容、文件名、路径（代码和 `开发说明.md` 都这样约束，核对属实）。
- 接收：无业务数据，失败静默。
- 依赖它的功能：无。只有原作者的统计 Dashboard 用。
- 移除后：客户端功能不受影响，原作者失去这部分统计。
- 建议：**替换为自建**。自建前先做成可关闭，并在首次启动时告知用户。注意 `AGENTS.md` 禁止删除或弱化埋点，见 §3。
- **已停用（旧仓库 PR #16）**：
  - 三处上报（Renderer `analytics.ts`、Main `trackAiRequest`、`trackAgentRuntime`）的地址统一取自 `remote-services.json` 的 `analyticsUrl`，默认为空，为空时直接返回、不发任何请求。事件类型和字段保持不变，以后接入自有统计服务只需填写地址并重新构建；
  - `client_id` 不再由机器码派生：`utils/machineIdentity.cjs` 改为 `utils/clientIdentity.cjs`，生成 `install-v1-<随机 UUID>`，删除读取 `MachineGuid` / `IOPlatformUUID` / `machine-id` / 主机名的代码；已有配置中 `machine-v1-` 开头的 ID 连同 `analytics_created_at` 在读取时替换为新的随机值。全客户端已没有读取设备硬件标识（机器码、网卡 MAC、主机名）的代码；埋点只带随机安装标识、版本、平台和架构；
  - 设置页隐私声明按是否配置埋点地址显示，默认显示“当前版本未配置统计服务，不上报任何埋点”。

#### 2.1.2 `/agent-errors` Agent 失败诊断

> **状态：已移除（旧仓库 PR #10）。** 客户端删除了 `agentErrorReporter.cjs`、`agentErrorReportProcess.cjs` 和对应 `utilityProcess`，不再预检或上传。Agent 最终失败改为写本机 `userData/logs/agent/agent-failures.jsonl`（`services/agent/agentFailureLog.cjs`），只含任务标识、错误类型、状态码和按配置凭据及常见认证格式脱敏后的错误消息，不含 Prompt、工作区文件、模型原始响应、配置和 API Key。界面和设置里本来就没有对应入口，无需同步删除。`analytics/worker/` 的接收端未改动。以下为移除前的分析，保留备查。

- 代码：`electron/services/agent/agentErrorReporter.cjs`、`agentErrorReportProcess.cjs`，在独立 `utilityProcess` 中执行。
- 触发：任意 Agent 任务非用户中断的失败。前提是本地有授权文件、有 client_id，并且 `GET /agent-errors?version=` 预检返回 `accepted: true`（服务端可以按版本开关）。**界面上没有任何开关，也不提示用户。**
- 发送（gzip 后上限 95 MB）：
  - **工作区的全部文件**：`collectWorkspaceFiles` 递归读取 Agent 工作区目录，文本原文、二进制转 base64，包括招标文件转出的 Markdown、知识库摘录、已生成的正文和图片；
  - **任务 Prompt 全文**（`task.prompt`），通常内嵌文档内容；
  - `userTaskContext`：当前受管任务的 `payload`、任务状态，技术方案还有生成设置；
  - 错误详情，包括模型原始响应体（`raw_response_body`、`raw_sse_data` 等）；
  - **完整 `user_config.json`**（经脱敏）、授权 envelope（授权请求头，含 client_id 和机器指纹哈希）、构建证明；
  - 本机路径：`userData`、可执行文件路径、`cwd`，Windows 下通常包含**系统用户名**；还有进程 PID、`process.versions`；
  - client_id。
- 脱敏：按键名匹配 `api_key|authorization|token|password|secret|cookie…`，收集 config 里的这些值，在所有文本和二进制里替换。API Key 和 MinerU Token 会被抹掉，**文档内容不做任何处理**。
- 接收：无。
- 依赖它的功能：无。只供原作者排查问题。
- 移除后：没有功能影响。
- 建议：**移除**。这是隐私风险最高的链路，相当于把用户的标书数据整包交给第三方，投标场景下可能违反保密协议。如果确实需要诊断，改成“本地导出诊断包，由用户手动提交”（现有 `agent.exportSelfCheckReport` 可以参考），或者改为自建服务、默认关闭、每次上传前请用户确认。

#### 2.1.3 `/license/activate` 授权

- 代码：`electron/services/licenseService.cjs`，启动时调用 `refreshOnStartup`（`ipc/index.cjs:486`），设置页可以手动刷新或导入离线授权。
- 发送：`projectName`、`appId`、`productName`、版本、平台、架构、`clientId`、`clientCreatedAt`、`machineFingerprintHash`（`sha256(项目名 + appId + clientId×2 + OS 机器码 + 全部网卡 MAC 的哈希 + 版本)`）、`buildAttestation`（构建证明，由原作者私钥签名）。
- 接收：原作者私钥签名的授权 envelope（`plan`、到期时间、`freeLicenseDays` 默认 30 天、`expirePopupEnabled`、`expirePopupDismissible`），用 `electron/resources/license-public-key.json` 验签后存到本地。
- 依赖它的功能：
  - `LicenseStatusPrompt`：缺少授权、授权过期、机器不匹配、“来源不可信”（非原作者构建，构建证明验签失败）时弹窗；服务端把 `expirePopupDismissible` 设为 `false` 时弹窗**不可关闭**，等于远程锁定客户端；
  - Agent 失败诊断：没有授权就不上传；
  - 埋点里的授权字段。
  - 业务功能**不检查**授权（Main 侧没有调用点）。
- 移除后：
  - 自建构建一定没有原作者的构建证明，所以 `sourceTrusted=false`，客户端会一直弹“来源不可信”。也就是说，**独立运营时这条链路必须处理**；
  - 移除后，业务功能不受影响。
- 建议：**移除**（连同公钥、构建证明、离线授权和设置页授权区块）。如果要做自己的授权体系，在 Web 化第 2 步按账户和席位重新设计，不沿用机器码模型。
- 附带：`RequiredOnlineServicesPrompt` 的“如需内网使用，请联系作者购买离线包”文案，同样是原作者的商业条款，应一并改掉。
- **已移除（旧仓库 PR #15）**：
  - 删除 `licenseService.cjs`、`licenseIpc.cjs`、`electron/resources/license-public-key.json`、`build-attestation.json`、`scripts/generate-build-attestation.cjs`（及 `package.json` 的 `generate-build-attestation` 脚本）、`LicenseStatusPrompt.tsx`（含“来源不可信”和指向原作者仓库的下载引导）、`OfflineLicenseActivationDialog.tsx`、preload 的 `license.*` 和对应类型；启动时不再请求 `/license/activate`，也不再计算机器/MAC 指纹；
  - 设置页“关于”去掉“客户端授权状态”和“离线激活授权”，卡片标题改为“项目信息”；GitHub 原仓库链接当时保留（迁移到新仓库时已删除）；
  - 埋点不再带 `license_status`、`license_plan`、`license_expires_at`、`source_trusted`、`untrusted_reason`；
  - “联系作者购买离线包”文案删除；
  - 用户本地已有的 `userData/license.json` 不删除，客户端不再读取。`analytics/worker/` 的 `/license/activate` 服务端不动。

#### 2.1.4 `/ip-blocks` IP 封禁

- 代码：`electron/main.cjs` `checkBlockedIpAfterStartup`。
- 发送：一个不带参数的 GET，服务端从请求中取得用户公网 IP。
- 接收：`clientIp`（服务端看到的 IP）、`blockedIps`（**完整封禁列表**，对所有人公开）。
- 依赖它的功能：本机 IP 命中列表时，直接 `process.exit(0)`，没有任何提示。
- 移除后：没有功能影响。
- 建议：**移除**。这是原作者的远程停用开关，独立运营不应该保留。另外，接口把全部封禁 IP 公开下发，泄露了第三方 IP。
- **已移除（旧仓库 PR #15）**：删除 `main.cjs` 的 `IP_BLOCK_LIST_ENDPOINT` 和 `checkBlockedIpAfterStartup`，启动后不再请求 `/ip-blocks`，也没有任何“命中即退出”的逻辑。`analytics/worker/` 的服务端不动。

#### 2.1.5 `/notice`、`/notices` 远程公告

- 代码：`src/shared/remoteNotice.ts`、`src/app/UpdateNotifier.tsx`（启动时和每 30 分钟各拉一次）、`features/notice/`。
- 发送：`projectName`。
- 接收：公告标题和 Markdown 正文。
- **安全问题**：`UpdateNotifier.tsx:235` 用 `<MarkdownRenderer allowRawHtml …>` 渲染远程公告，违反 `AGENTS.md`、`开发说明.md` 中“远程公告必须 `allowRawHtml={false}`”的规定（`NoticeBoardDialog` 用的是 `false`，这里没有）。Renderer 能调用 `window.appBridge.config.load()`，读到**明文 API Key**；所以只要公告服务被攻破或被滥用，就能读取用户 Key 和文档。
- 依赖它的功能：公告弹窗、公告板和未读角标。
- 移除后：没有公告。
- 建议：**替换为自建**，并**单独开一个 PR，立即把这里改成 `allowRawHtml={false}`**。这一项不受独立运营决策影响，属于安全缺陷。
- **已修复（旧仓库 PR #14）**：
  - 公告弹窗改为 `allowRawHtml={false}`。同时排查了所有 `MarkdownRenderer` 调用方：`MarkdownRenderer` 默认值改为禁用原始 HTML，远程内容（公告、公告板、更新日志、资源页）和 AI / Agent 输出（标书解析、废标检查结果、全局事实、可研报告、Agent 提问）一律 `false`；只有本地解析的文档原文和技术方案正文（会保留原方案中的 HTML 表格）开启。不论是否开启，渲染时都按标签、属性和 URL 协议白名单重建，`style`、事件属性、`javascript:` / `file:` 链接和非位图 `data:` 图片都会被丢弃。其余 HTML 出口：AI 服务商错误页在 `sandbox=""` 的 iframe 中显示，无脚本权限；`RestrictedHtmlEditor` 当前没有调用方。
  - 即使 Renderer 被注入，也读不到 Key：`config:load` 返回的文本/生图模型 API Key 和 MinerU Token 一律为空字符串，另附 `credential_status`（是否已配置、长度不少于 12 位时附末尾 4 位）；保存时空值表示不修改，Base URL 改动时不沿用旧 Key。实现见 `electron/services/configSecrets.cjs`。
  - 未处理：主进程离屏渲染 AI HTML 的隐藏窗口（`localImageRenderService.cjs`、`contentGenerationLayout.cjs`）不在 Renderer 中，留给路线图第 7 步；Renderer 仍可经 `ai.chat` 等接口间接使用 Key，彻底隔离要等 Web 化后的服务端鉴权。

#### 2.1.6 `/changelogs` 更新日志

- 代码：`src/features/changelog/services/changelogService.ts`。
- 发送：`projectName`。接收：更新日志条目，渲染时 `allowRawHtml={false}`。
- 依赖它的功能：更新日志弹窗和未读角标。内容是原作者版本的日志，与本仓库版本不对应。
- 建议：**替换为自建**，或者改为随包内置（读取仓库里的 CHANGELOG）。
- **已停用（旧仓库 PR #16）**：公告（§2.1.5）、更新日志、资源页（§2.1.7）、群二维码（§2.1.8）、模型信息（§2.1.9）统一使用 `remote-services.json` 的 `contentServiceUrl`（自建 Worker 根地址），默认为空：不发请求，不轮询红点；侧栏“日志”“公告”按钮隐藏，“资源下载”分组隐藏（插件系统也已停用），群二维码只用内置图片，设置页“自动填充高级参数”按钮隐藏（Main 侧 `getModelInfo` 也返回“未配置模型信息服务”）。

#### 2.1.7 `/resources` 资源页

- 代码：`src/features/resources/pages/ResourcesPage.tsx`。
- 发送：用户输入的搜索词 `q`。接收：资源列表，Markdown 渲染时 `allowRawHtml={false}`。点击时上报 `resource_click`。
- 依赖它的功能：“资源”菜单页。内容由原作者运营。
- 建议：有运营内容就**替换为自建**，否则移除这个菜单。

#### 2.1.8 `/system-settings` 群二维码

- 代码：`src/components/Sidebar.tsx`，启动时拉取。
- 接收：`groupChatQrUrl`，用来替换侧边栏内置的群二维码，图片 URL 由远程决定。
- 建议：**移除**远程替换，同时把内置二维码（原作者的用户群）换成自己的，或者删掉。
- **已删除（旧仓库 PR #18）**：侧边栏“加群”按钮和弹窗、`client/assets/group-chat-qr.png`、远程查询代码一并删除，客户端不再请求 `/system-settings`。服务端 `analytics/worker/src/routes/systemSettings.js` 和 Dashboard 页面未改动。

#### 2.1.9 `/model-info` 模型参数查询

- 代码：`aiService.cjs` `getModelInfo`，在设置页点击“获取模型信息”时触发。
- 发送：模型名。接收：上下文长度、输出上限、推理档位、输入/输出模态。
- 依赖它的功能：设置页自动填写模型参数。移除后需要手动填写。
- 建议：**替换为自建**。Worker 端的模型信息同步 Cron 可以直接复用；也可以随包内置一份静态表。

#### 2.1.10 `/plugins` 插件市场

- 代码：`electron/services/pluginService.cjs`，启动时 `checkAvailableUpdates`（`ipc/index.cjs:592`）；`pluginIpc.cjs` 的图标走 `raw.githubusercontent.com`。
- 发送：GET 市场列表；下载 `releaseUrl`（由市场下发，指向原作者 OSS 域名，`agnet.top` 子域）。
- 接收：插件元数据和 zip 包，解压后在 Main 进程 `require()` 执行，**没有哈希或签名校验**。
- 依赖它的功能：插件市场、安装和更新。
- 移除后：插件功能不可用。已安装插件仍可加载，但无法更新。
- 建议：**移除**。路线图第 4 节已经定为 Web 版下线插件；桌面版在独立运营期间也不应该自动从第三方源拉取并执行代码。
- **已停用（旧仓库 PR #13）**：比上面的建议更进一步，连已安装插件也不再加载（已装插件同样是无签名校验、在 Main 进程执行的代码）。Main 不注册插件 IPC、不加载插件、不请求 `/plugins`；Renderer 隐藏插件管理菜单、插件更新提示和依赖桌宠插件的“AI 调整”入口。开关为 `electron/ipc/index.cjs` 与 `src/features/plugins/pluginSystem.ts` 中的 `PLUGIN_SYSTEM_ENABLED`。`pluginService.cjs`、`pluginContext.cjs`、`pluginConfigWindow.cjs`、`pluginIpc.cjs`、`PluginsPage.tsx` 和 preload 中的 `plugins.*` 暂时保留，**Web 版计划下线**（路线图第 9 步删除或重做为前端沙箱）。`analytics/` 中的 `/plugins` 服务端不动。

### 2.2 内测版账户与模型 API（已移除）

> **状态：已移除（旧仓库 PR #17）。** 按本项目决定不与原作者合作使用官方服务，整体删除，不再保留开关：
> - 删除 `officialAccountService.cjs`、`officialInvoiceStore.cjs`、`officialAccountIpc.cjs`，`ipc/index.cjs` 不再创建、启动或注册官方账户服务，`preload.cjs` 删除 `officialAccount.*` 和 `ai.onBalanceInsufficient`，`aiHttpError.cjs` 不再识别官方余额不足（`ai:balance-insufficient`）；
> - 文本模型服务商删除 `official`（`configStore.cjs`、`SettingsPage.tsx`、`types/config.ts`），连同默认 Base URL、内测版的文本 / 推理模型名、`official_api_model_type`、客户端类型请求头（`aiService.cjs`、`piSelfCheckService.cjs`）；设置页删除官方账户面板（登录、余额、充值、兑换、订单、流水、开票）及样式；
> - 删除 旧仓库 PR #11 的隐藏开关 `OFFICIAL_TEXT_PROVIDER_ENABLED` 和 旧仓库 PR #12 的迁移标记 `official_text_provider_migrated`、`official_text_provider_paused_notice_pending` 及“内测版服务暂停提供”提示。迁移改为：旧配置仍选中 `official` 的，读取时直接切到“自定义”，顶层镜像的官方 Base URL 和 Key 不带入自定义档案；自定义档案为空即为未配置，由启动检查按普通“文本模型尚未配置”引导，不再单独提示；
> - 用户本地数据不删除，但程序不再读取：`userData/official_api_session.json`、`official_recharge_qr_cache.json` 原样留在磁盘上；`user_config.json` 中的 `text_model_profiles.official`（含官方 Key）在写回配置时原样照抄，不解析、不返回给 Renderer 或 Main 其他代码；工作区数据库的 `official_invoice_info` 表保留（属于已发布的数据库版本迁移），不再读写。
>
> 以下为 旧仓库 PR #11、旧仓库 PR #12 时的处理记录，保留备查。
>
> **状态：部分处理（旧仓库 PR #11）。**
> - 默认文本提供方改为“未配置”（默认选中“自定义”，Base URL、模型名称、API Key 为空），启动时由 `useTextModelSetupRedirect` 提示并跳到设置-文本模型；
> - `officialAccountService` 删除了启动时的 `POST /clients/register` 匿名注册，以及 `syncApiKey`（`GET/POST /api-keys` 并把 Key 写入 `user_config.json`）；邮箱登录和绑定也不再写入 Key。启动时只恢复用户此前主动邮箱登录的会话；
> - 设置页隐藏“内测版 API”选项（`OFFICIAL_TEXT_PROVIDER_ENABLED = false`），相关代码、账户面板、请求头保留，等商业授权确认后再决定启用或移除。已保存为官方的旧配置仍显示该选项；
> - 设置页“选用后文档内容会发往内测版服务”的提示未加：选项已对新用户隐藏，等决定启用时再加。
>
> **已处理：已有用户本地配置中的官方 Key（旧仓库 PR #12，采用下面的方案 2）。**
> - `configStore.cjs` 读取配置时，`text_model_provider` 为 `official` 且没有 `official_text_provider_migrated` 标记的旧配置一次性改为“自定义”（沿用用户已有的自定义档案，没有则为空，即未配置）；官方 Key 和其余官方档案字段写回 `text_model_profiles.official` 保留，不再使用；`official_api_session.json` 不删除；
> - 迁移后写入 `official_text_provider_migrated: true`，之后不再检查；新配置默认即为 `true`。授权确认后重新开放选项时，用户切回官方不会被再次迁移；
> - 迁移同时置位 `official_text_provider_paused_notice_pending`。下次启动时 `useTextModelSetupRedirect` 常驻提示“内测版服务暂停提供，文本模型已切换为‘自定义’，请配置其他服务商。官方账户余额不受影响”，跳到设置-文本模型并清除标记。标记只由迁移置位，`config:save` 只能清除，带旧快照的整份配置保存不会把提示写回；
> - 迁移后设置页不再选中官方，按 旧仓库 PR #11 的规则隐藏该选项；账户面板仍可查看余额。
>
> 处理前的现状与可选方案（保留备查）：
>
> 现状：`text_model_provider: 'official'` 和 `text_model_profiles.official.api_key` 原样保留，这些用户的文本请求仍发往内测版服务，直到 Key 失效或余额不足（402 时跳到设置页）。可选方案：
> 1. **保持现状**：不迁移。改动最小，但这部分用户的文档内容继续发往原作者服务器，与本节“拿到书面授权前”的建议不一致。
> 2. **切换但保留 Key（推荐）**：`configStore` 读取时做一次性迁移，provider 为 `official` 的配置改为未配置（空的“自定义”），官方 Key 留在 `text_model_profiles.official` 里但不再使用；首次启动时提示“内测版服务暂停提供，请配置其他服务商，官方账户余额不受影响”。默认停止外发，可逆：授权确认后重新开放选项，用户切回即可继续用原 Key 和余额。
> 3. **切换并清除**：同 2，另外清空官方 Key 并删除 `official_api_session.json`。最彻底，但授权确认后用户需要重新登录；匿名账户（未绑邮箱）的余额与 client_id 绑定，在不恢复匿名注册的前提下无法找回，需要另行说明或补偿。
>
> 以下为处理前的分析，保留备查。

- 代码：`electron/services/officialAccountService.cjs`（账户），`configStore.cjs` 和 `SettingsPage.tsx` 的 `official` 文本模型配置（模型 API：内测版模型 API 路径），`aiService.cjs` 给官方请求加上客户端类型请求头。
- 启动时自动执行（`ipc/index.cjs:465` `officialAccountService.start()`），不需要用户操作：
  1. `POST /clients/register {clientId}`，**用 client_id 匿名注册**，拿到 token；
  2. `GET /account`；
  3. `GET /api-keys`，没有就 `POST /api-keys {name: '开源版'}`，然后把服务端返回的 **API Key 写进本地 `user_config.json`**（`text_model_profiles.official.api_key`）。
- 用户主动操作时还会发送：邮箱、验证码（登录和绑定），兑换码，充值订单，**发票信息**（抬头类型、发票抬头、**纳税人识别号**、收票邮箱、备注），查询消费流水。
- 模型 API：默认 `text_model_provider` 是 `official`，所以**没有改过设置的用户，全部文本请求都发往内测版服务**。请求内容是完整 Prompt，包括招标文件、原方案、知识库摘录、资信库和已生成的正文；请求头带官方 API Key。
- 接收：账户状态、余额、订单、二维码、发票；模型响应；余额不足时返回 HTTP 402（触发 `ai.onBalanceInsufficient`）。
- 依赖它的功能：设置页“内测版”模型（默认选项）、官方账户面板（登录、充值、发票、流水）、余额不足提示。
- 移除后：
  - 默认文本模型不可用，用户必须配置其他提供方。默认值要改成“未配置”，并在首次使用时引导用户填写；
  - 账户、充值和发票相关界面全部失效。
- 建议：**保留的前提是与原作者书面确认授权范围**。需要确认：分发版本能否继续调用官方 API，计费和发票主体是谁，用户数据怎样处理，`open-source` 客户端标识是否需要更换。**在拿到书面授权前**：
  - 把默认文本提供方改成“未配置”；
  - 去掉启动时的自动匿名注册和自动写入 Key，改成用户在设置页主动登录后才连接；
  - 在设置页明确提示：选用后文档内容会发往内测版服务。

  如果不打算与原作者合作，就整体**移除**，或者在 Web 化第 3 步换成自建 AI 网关。

### 2.3 `wiki.agnet.top`

- 使用说明：`Sidebar.tsx` 的 `USER_GUIDE_URL` 和设置页“关于”中的链接，只是用 `openExternal` 打开外部浏览器，不发送数据。建议**替换为自建文档站**，或者指向本仓库的 `使用说明/`。
- 打赏（`/api/payments/*`，`electron/services/donationService.cjs`、`shared/ui/DonationPromptProvider.tsx`）：
  - 发送：打赏金额，选填的昵称和邮箱，订单号查询；
  - 接收：XorPay 支付二维码、订单状态；
  - 触发：Word 导出累计达到一定次数后自动弹出打赏提示，另有运行时长相关的提示。已打赏的标记用 `safeStorage` 加密保存在本地。
  - 收款方是原作者。
- 依赖它的功能：打赏弹窗。
- 建议：**移除**。继续向原作者收款的界面与独立运营冲突；如果需要自己的赞助渠道，另行实现。
- **已停用（旧仓库 PR #16）**：使用文档地址改为 `remote-services.json` 的 `userGuideUrl`，为空时侧栏“文档”按钮和设置页“使用文档”一行隐藏；打赏服务地址改为 `donationServiceUrl`，为空时不弹打赏提示、不恢复待支付订单、`donation:*` 接口直接报“未配置打赏服务”，本地仍只累计使用时长和导出次数。代码结构保留，没有删除。
- **已删除（旧仓库 PR #20）**：`donationService.cjs`、`donationIpc.cjs`、`DonationPromptProvider.tsx`、`shared-donation.css`、`donation:*` preload API 和类型、导出 Word 时的计数、`remote-services.json` 的 `donationServiceUrl` 一并删除；Main 侧的 `remoteServices.cjs` 随之没有调用方，也已删除。本地已有的 `donation_state.json` 不删除、不读取。

### 2.4 更新渠道

- 代码：`electron/services/updateService.cjs`、`src/app/UpdateNotifier.tsx`（启动时和每 30 分钟各检查一次），设置页可选三个渠道，**默认 `atomgit`**：
  - `atomgit`：AtomGit API 上原作者仓库的 releases 接口，手动下载安装包到 `userData/updates/`，然后 `shell.openPath` 运行；
  - `github`：GitHub API 上原作者仓库的 latest release 接口，Windows 用 electron-updater；
  - `cloudflare`：原作者 OSS 域名（`agnet.top` 子域）下的 `/release/latest.json`，electron-updater generic feed。
  - `package.json` `build.publish` 同样指向原作者的 GitHub 仓库。
- 发送：GET 请求（`User-Agent: zhibiao-client`），不带设备标识。
- 接收：原作者仓库的最新版本号和安装包。macOS 和 atomgit 渠道的手动下载**只校验文件大小，不校验哈希或签名**（`isDownloadedFileReady`）。
- 依赖它的功能：更新提示、下载和安装。
- 移除后：不再检查更新。
- 风险：独立运营的版本号一旦低于原作者版本，用户会被提示“升级”，**安装后会被替换成原作者的发行版**。
- 建议：**替换为自建**，指向本仓库的 Release，并补上哈希校验。在完成替换之前，先关闭自动检查。路线图已定第 9 步 Web 化时删除更新功能。
- **已停用（旧仓库 PR #15）**：
  - `updateService.cjs` 删除 GitHub、AtomGit、Cloudflare 三个渠道及其地址，更新源改为随包的 `electron/resources/update-feed.json`（`feedUrl`、`publicKey`），**默认为空**：不发任何更新请求，设置页“检查更新”提示“未配置更新源，不检查更新”。下载、`userData/updates/` 安装包、electron-updater（generic feed）等代码结构保留；
  - 更新源只认 https，且只能在构建时写进安装包，Renderer 无法修改；原 `update_channel` 配置项和设置页“自动更新渠道”下拉框删除，已保存的旧值忽略；
  - **验签门槛**：检查到新版本后，下载前一律经过 `verifyReleaseSignature`。目前它总是拒绝（未配置公钥时提示“更新源未配置验签公钥”，否则提示“更新包验签尚未实现”），所以即使填了更新源也只会提示有新版、不会下载或安装。接入自有更新服务器时，须先在这里实现清单签名验证和安装包哈希校验（electron-updater 路径同样要覆盖），再填写地址和公钥；
  - `package.json` 的 `build.publish` 改为 `null`，不再生成指向原作者仓库的 `app-update.yml`；
  - 数据库版本过新时的“下载新版客户端”按钮，在未配置更新源时改为提示用户自行从发布渠道获取新版。

### 2.5 `oss.agnet.top` 启动广告

- 代码：`src/app/StartupAdvertisementDialog.tsx`。
- 发送：每次启动都 GET 广告图 `oss.agnet.top/keep/2026/08/13/…png`，请求本身暴露 IP。点击广告用外部浏览器打开 `s.markup.com.cn/jl`（金龙 API 推广链接）。
- 行为：**每次启动强制展示，8 秒后才能关闭**。
- **更正（旧仓库 PR #16 核对）**：该组件从本仓库首次提交起就没有被任何组件引用（`App.tsx`、`AppShell` 等都没有挂载它），Vite 不会打包，所以客户端实际**从未请求**这张广告图。上面的“行为”只是组件本身的逻辑。旧仓库 PR #16 已删除该组件及其样式。
- 依赖它的功能：无。
- 建议：**移除**。同类推广链接还有设置页 `jinlong` 的“获取 Key”链接 `s.markup.com.cn/jl`，以及默认生图提供方 `jinlong`（见 §2.7），一并评估。（旧仓库 PR #18：推广链接删除，金龙预置服务商整体移除。）

### 2.6 `mt.agnet.top`

`client/doc/html图片.md` 是一份早期设计稿，其中提到把 HTML base64 后交给 `https://mt.agnet.top/image/url2png` 转图片。当前实现是本地渲染（`localImageRenderService.cjs` 使用隐藏 `BrowserWindow`），`client/` 的代码里**没有任何对 `mt.agnet.top` 的调用**。不需要处理，可以在文档中注明“已废弃”（旧仓库 PR #16 已标注；旧仓库 PR #20 从设计稿中删除该段，改为说明本地渲染）。

### 2.7 第三方模型服务

- 文本：~~`jinlong`（`jlaudeapi.com`）~~（旧仓库 PR #18 移除）、`volcengine`（`ark.cn-beijing.volces.com`）、`deepseek`（`api.deepseek.com`）、`agnes`（`apihub.agnes-ai.com`）、`custom`。
- 生图：~~**默认 `jinlong`（`img-api.jlaudeapi.com`）**~~（旧仓库 PR #12 改为默认未配置，旧仓库 PR #18 移除），另有火山、Google AI Studio、Agnes、自定义、本地 ComfyUI（`127.0.0.1:8188`）。
- **旧仓库 PR #18**：移除“金龙中转站”预置服务商。旧配置中文本或生图选中金龙的，迁移为“自定义”，沿用已保存的 Base URL 和 Key，仍可使用；代码中不再有 `jlaudeapi.com`，只有用户自己的配置文件里还有这个地址。
- 发送：完整 Prompt（含文档内容）和用户自己的 API Key（`Authorization: Bearer`）。
- 依赖它的功能：所有 AI 生成。
- 建议：**保留**，这些是用户自选的模型服务。需要两处调整：
  - ~~默认生图提供方改成“未配置”，不要默认指向推广合作方~~（旧仓库 PR #12：默认改为空的“自定义”，未测试可用前 `getImageModelAvailability` 不发请求；已保存的旧生图配置不迁移，这些配置要用户自己填 Key 并测试通过才会调用）；
  - ~~设置页“获取 Key”链接去掉推广参数~~（旧仓库 PR #18：金龙推广链接删除，服务商一并移除）。

  Web 化后，这些调用由服务端代理（路线图第 3 步）。Web 版改为**平台统一提供 AI 并按量计费**（`docs/SERVER_DESIGN.md` 第 9 节第 7 项）：服务商的 Key 由平台持有，用户不再填写 Key 和 Base URL；拟上架服务商对中国大陆用户的条款限制待确认，见 §7 和 `docs/SERVER_DESIGN.md` 第 11 节。

### 2.8 `mineru.net`

- 代码：`fileService.cjs`，文件解析方式选 MinerU 时使用（默认 `local`）。
- 发送：**原始上传文件**和用户的 MinerU Token。接收：解析后的 Markdown。
- 建议：**保留**，作为用户可选项。设置页注明文件会上传到第三方。

### 2.9 Markdown 中的远程图片

- 代码：`exportService.cjs` 导出 Word 时，遇到 `http(s)` 图片 URL 会直接 `fetch` 下载。URL 来自 AI 或用户内容。
- 桌面版的影响只是暴露 IP。Web 化后这是 **SSRF 面**（服务端可能被诱导访问内网地址），需要在第 4 或第 7 步加白名单或内网地址拦截。

## 3. `AGENTS.md`（及 `client/开发说明.md`）中与“独立运营”冲突的规则

| 位置 | 规则原文（摘要） | 冲突点 | 建议 |
|---|---|---|---|
| `AGENTS.md`「范围」 | `analytics/` 承载客户端公告、更新日志、资源、插件、模型信息、许可证和 Agent 失败诊断等在线服务 | 这些服务实际部署在原作者账户（`analytics.agnet.top`），客户端写死了原作者域名；独立运营要么自建部署，要么下线 | 改成“`analytics/` 是可自建的 Worker 源码；客户端连接的地址由构建配置决定” |
| `AGENTS.md`「Analytics」 | 生产 API Worker 所在 Cloudflare 账户已启用 Workers Paid Plan，允许 5 个统计 Cron 和模型信息同步 Cron | 描述的是原作者账户的计费状态，对本仓库不成立 | 删除，或改成本仓库自己的部署说明 |
| `AGENTS.md`「Analytics」 | **禁止删除、绕过或弱化任何埋点、统计、Dashboard 展示和 Worker 聚合逻辑** | 独立运营要移除原作者埋点（§2.1.1）、Agent 诊断上传（§2.1.2）、授权上报（§2.1.3）；按这条规则，这些都不允许做 | 改成“统计能力可迁移到自建服务；上报到第三方必须可关闭并告知用户；不得上传文档内容” |
| `client/开发说明.md`「仓库级关联代码」 | 埋点“不得删除或绕过现有统计”；Agent 失败诊断“不得并入普通埋点或随意弱化” | 同上，并且等于要求保留整包上传工作区的行为 | 同上，并明确诊断上传默认关闭 |
| `docs/MIGRATION_PLAN.md` 第 4 节 AI 服务行、第 9 步 | 埋点和统计“必须等价保留（AGENTS.md 硬性约束）”；第 9 步“不删任何统计” | 路线图继承了上面的约束 | 随 `AGENTS.md` 一起修改（本 PR 只在路线图中登记，不改约束本身） |
| `AGENTS.md`「Client 架构」和 `开发说明.md`「新增菜单页面」 | 新增菜单页面必须同步 `analytics/dashboard/public/src/pages/traffic.js` 的路由中文名 | 只有继续使用（自建的）Dashboard 时才有意义 | 自建 Dashboard 后保留；否则删掉这一步 |
| `AGENTS.md`「发布」 | `release.yml` 的 tag 发布流程，用私钥生成构建证明 | `release.yml` 已在 旧仓库 PR #7 删除；构建证明私钥属于原作者，自建构建永远验证不过（§2.1.3 的“来源不可信”） | 删除这一节，或改成本仓库自己的发布流程；授权和构建证明随 §2.1.3 一起移除（旧仓库 PR #9 已改写本节；旧仓库 PR #15 已移除授权和构建证明，并在本节补充更新源规则） |
| `开发说明.md`「仓库级关联代码」 | 发布渠道、构建证明、更新清单要联动 `.github/workflows/release.yml`、`.github/scripts/` | 文件已删除 | 删除该行 |
| `AGENTS.md`「必须遵守的原则」第 3、4 条 | Renderer、preload、Main 都在用户本机可信边界内，不做层间校验；“客户不会自己攻击自己，不需要加过多安全性兜底” | 这个前提把**远程下发的内容**（公告 HTML、插件代码、更新包、授权配置）也当成了可信内容。独立运营后，这些都来自不受本项目控制的第三方，§2.1.5 的 `allowRawHtml` 就是这样产生的。Web 化后这个前提完全不成立（路线图已注明） | 补一条：凡是来自网络的内容和代码一律按不可信处理，渲染禁用原始 HTML，下载执行前验签 |

另外：`AGENTS.md` 本身没有写原作者的商业条款。商业条款散在代码里：“联系作者购买离线包”的文案、授权弹窗里的原作者下载地址（`LicenseStatusPrompt.tsx`、`useNoticeToast.ts` 指向原作者的 GitHub 仓库）。处理授权和公告时，一并检查这些文案。（迁移到新仓库时已取得商业授权，README、设置页“关于”中的原作者署名和原仓库链接以及 `LICENSE`、`NOTICE` 已一并删除。）

## 4. 建议的处理顺序

每项一个小 PR；P0 应在任何对外分发之前完成。

| 优先级 | 内容 | 涉及位置 |
|---|---|---|
| P0 | 远程公告改 `allowRawHtml={false}`（安全缺陷，与独立运营无关）（**已完成，旧仓库 PR #14**：同时排查全部远程内容和 AI 输出的渲染位置、加白名单清洗，`config:load` 打码 API Key） | `src/app/UpdateNotifier.tsx`、`MarkdownRenderer.tsx`、`configIpc.cjs` |
| P0 | 移除 Agent 失败诊断上传（**已完成，旧仓库 PR #10**） | `services/agent/agentErrorReporter.cjs`、`agentErrorReportProcess.cjs` 及调用点 |
| P0 | 默认文本模型改成“未配置”；移除启动匿名注册和自动写入官方 Key；隐藏“内测版”选项（**已完成，旧仓库 PR #11**；旧配置中的官方 Key 按 §2.2 方案 2 迁移，**旧仓库 PR #12**；官方服务商与官方账户整体移除，**旧仓库 PR #17**） | `configStore.cjs`、`SettingsPage.tsx`、`officialAccountService.cjs`、`useTextModelSetupRedirect.ts` |
| P0 | 默认生图模型改成“未配置”（**已完成，旧仓库 PR #12**） | `configStore.cjs`、`SettingsPage.tsx` |
| P0 | 移除 IP 封禁检查（**已完成，旧仓库 PR #15**） | `electron/main.cjs` |
| P0 | 移除授权链路（否则自建构建会一直弹“来源不可信”）（**已完成，旧仓库 PR #15**：含离线授权、公钥、构建证明、设置页授权区、埋点授权字段和“购买离线包”文案） | `licenseService.cjs`、`LicenseStatusPrompt.tsx`、`electron/resources/` 公钥和构建证明、设置页授权区、埋点中的授权字段 |
| P0 | 更新渠道指向本仓库或暂时关闭，避免用户被“升级”回原作者版本（**已完成，旧仓库 PR #15**：停用原作者渠道，更新源改为随包配置、默认为空，验签实现前不下载） | `updateService.cjs`、`package.json` `build.publish`、设置页渠道选项 |
| P1 | 移除启动广告、打赏、远程群二维码，替换推广链接（**已完成**：旧仓库 PR #16 删除启动广告，打赏和远程群二维码改为未配置即停用；旧仓库 PR #18 删除推广链接 `s.markup.com.cn/jl` 和“【推荐】”标注、“加群”按钮、内置及远程群二维码） | `StartupAdvertisementDialog.tsx`、`donationService.cjs`、`DonationPromptProvider.tsx`、`Sidebar.tsx`、`SettingsPage.tsx` |
| P1 | 移除插件市场的自动检查、下载和安装（**已完成，旧仓库 PR #13**：整体停用插件系统，含已安装插件的加载；代码保留，Web 版计划下线） | `pluginService.cjs`、`pluginIpc.cjs`、`ipc/index.cjs` |
| P1 | 修改 `AGENTS.md`、`开发说明.md` 中的冲突规则（§3） | 两个文档 + 路线图 |
| P2 | 埋点、公告、更新日志、资源、模型信息改为指向自建 Worker（服务地址集中成一个配置，不在各文件里写死）（**已完成，旧仓库 PR #16**：`electron/resources/remote-services.json`，默认为空） | `analytics.ts`、`aiService.cjs`、`agentRuntimeAnalytics.cjs`、`remoteNotice.ts`、`changelogService.ts`、`ResourcesPage.tsx` |
| P2 | `client_id` 改为随机 UUID，不再由机器码派生（**已完成，旧仓库 PR #16**） | `utils/clientIdentity.cjs`（原 `machineIdentity.cjs`）、`configStore.cjs` |
| P2 | 标注 `client/doc/html图片.md` 中的 `mt.agnet.top` 方案已废弃（**已完成，旧仓库 PR #16**） | 文档 |

改代码前，需要原作者决定的事项：

1. ~~能否继续使用内测版服务的官方模型 API 和账户体系。如果能：计费和开票主体是谁，用户数据怎样处理，是否需要更换客户端标识请求头。~~ 已决定不使用，整体移除（旧仓库 PR #17）。
2. ~~能否在自建 Worker 上继续运营原作者的公告、资源和模型信息内容。~~ 已决定不自建 Worker（旧仓库 PR #18），不再运营这些内容。
3. 已有用户的授权、打赏记录是否需要迁移或说明。
4. ~~已有用户本地配置中的官方 Key 如何处理（§2.2 的三个方案）~~：已按方案 2 处理（旧仓库 PR #12）；旧仓库 PR #17 移除官方服务后，官方 Key 和会话文件仍留在本地、程序不再读取。

## 5. 核对方法

- 域名清单：`grep -rnoE "https?://[a-zA-Z0-9._-]+" client/electron client/src`，再逐一排除 XML 命名空间、示例地址和纯外链。
- 网络调用点：`grep -rnE "\bfetch\(|https\.get\(|net\.fetch\(" client/electron client/src`。本文列出的服务之外，只剩 `piSelfCheckService.cjs` 的本地回环探测和 `exportService.cjs` 的图片下载（§2.9）。
- 未覆盖：第三方 npm 依赖（如 `@earendil-works/pi-coding-agent`、electron-updater）自身是否另有网络请求，本文没有做抓包验证。建议在第 9 步上线前，用代理抓一次完整流程的出站流量做最终确认。

## 6. 剩余引用（旧仓库 PR #16 后全局搜索 `agnet.top`、内测版域名）

搜索范围是整个仓库（不含 `node_modules`、`.git`）；`docs/` 下本文和路线图中的引用都是分析记录，不再列出。旧仓库 PR #17 删除第 1、2 行后，`client/` 下已没有内测版域名；旧仓库 PR #18 删除金龙推广链接后，`client/` 下也没有 `s.markup.com.cn`（README 中的赞助商推广链接暂不修改）。

| # | 位置 | 引用 | 用途 | 运行时是否会请求 | 后续处理 |
|---|---|---|---|---|---|
| 1 | ~~`client/electron/services/configStore.cjs:23`、`client/src/features/settings/pages/SettingsPage.tsx:82`~~ | 内测版模型 API 地址 | “内测版”文本模型的默认 Base URL | 否 | **已删除（旧仓库 PR #17）** |
| 2 | ~~`client/electron/services/officialAccountService.cjs:6`~~ | 内测版账户 API 地址 | 官方账户（登录、余额、充值、发票） | 否 | **已删除（旧仓库 PR #17）** |
| 3 | ~~`client/electron/services/pluginService.cjs:7`~~ | `analytics.agnet.top/plugins` | 插件市场 | 否：插件系统已停用（旧仓库 PR #13） | **已置空（旧仓库 PR #20）**：地址为空时不请求插件列表、不上报下载；插件代码仍在第 9 步处理 |
| 4 | ~~`client/doc/html图片.md:49`~~ | `mt.agnet.top/image/url2png` | 早期设计稿 | 否：代码中不调用 | **已删除（旧仓库 PR #20）** |
| 5 | ~~`analytics/worker/wrangler.jsonc`、`analytics/dashboard/…`~~ | `analytics.agnet.top`、`static.analytics.agnet.top` | 原作者 Cloudflare 部署的自定义域和 Dashboard 默认 API 地址 | 不属于客户端 | **已删除（旧仓库 PR #19）**：整个 `analytics/` 目录移出仓库 |
| 6 | ~~`analytics/worker/src/services/pluginStore.js:18`~~ | 原作者 OSS 域名（`agnet.top` 子域） | 插件包 R2 公网地址（服务端） | 不属于客户端 | **已删除（旧仓库 PR #19）** |
| 7 | ~~`analytics/README.md`~~ | `analytics.agnet.top` 等 | 部署说明和示例命令 | 否 | **已删除（旧仓库 PR #19）** |
| 8 | ~~`README.md`、`README.en.md`（内测版官网、内测版邮箱、`oss.agnet.top` 截图）~~ | 原作者官网、邮箱、图床 | 项目介绍与截图 | 否 | **已改写（旧仓库 PR #19）**：README 改为中性说明，删除赞助商、官网、邮箱和推广内容，当时保留许可证和归属声明（迁移到新仓库时已删除） |
| 9 | ~~`文章/*.md`（5 个文件、约 12 张图）~~ | `oss.agnet.top` 图床 | 原作者技术文章的插图 | 否 | **已删除（旧仓库 PR #18）**：整个 `文章/` 目录移出仓库 |

同类但不含这两个域名的原作者 / 推广依赖：~~设置页金龙“获取 Key”链接 `https://s.markup.com.cn/jl`、侧边栏内置的原作者用户群二维码（`client/assets/group-chat-qr.png`）~~（旧仓库 PR #18 已删除）、“开发中”提示里的原仓库 star 引导（`useNoticeToast.ts`；旧仓库 PR #20 改为中性的“功能开发中”，不再附链接）。

## 7. Web 版新增的外部服务（待定）

`docs/SERVER_DESIGN.md` 第 9 节的决定（旧仓库 PR #26）给 Web 版引入了下列外部服务。除模型服务商（旧仓库 PR #31 记录为 DeepSeek、通义千问两家，条款仍待确认）外都还没有选定，选定后在本节补上服务商、收发的数据和处理建议，并同步修改总表。

| # | 服务 | 用途 | 收发的数据 | 状态 | 选型要求 |
|---|---|---|---|---|---|
| 1 | **发信服务**（SMTP 或云邮件 API） | 邮箱验证、找回密码、组织邀请、余额不足和充值通知 | 用户邮箱、一次性链接（含令牌）、通知正文；不含用户文档内容 | **待定，首个真实用户注册前必须完成**（旧仓库 PR #31）：注册邀请、找回密码都依赖发信，目前 `server/src/mail/mailer.ts` 只有日志实现 | 见下方“发信服务的送达率” |
| 2 | **云厂商（香港地域）**：云主机、KMS、对象存储 | 运行服务；包装 API Key 的数据密钥；存放上传文件和生成产物 | 全部业务数据（对象存储中加密保存）；KMS 只接触数据密钥 | **待选**，KMS 和对象存储必须同一厂商（`docs/SERVER_DESIGN.md` 第 9 节第 8、13、14 项） | 香港地域同时提供三项服务；KMS 支持实例角色授权、调用审计和删除保护；对象存储 S3 兼容、支持版本化和跨地域复制 |
| 3 | **模型服务商**（平台账户） | 平台统一提供的文本、生图模型，以及 MinerU 在线解析 | 完整 Prompt（含用户文档内容）、平台的 Key | **已记录两家**（旧仓库 PR #31）：`deepseek`（DeepSeek）、`qwen`（阿里云通义千问），计费表的 `provider` 只接受这两个值；旧仓库 PR #32 已按 OpenAI 兼容的流式接口接入，Base URL 由平台管理员与 Key 一起配置，代码中不写死。具体接入哪个站点（国际站 / 境内站）和条款仍待确认，上线前必须完成 | 条款允许面向中国大陆用户转售或提供访问；不用客户数据训练；数据存储地区和保留期明确（`docs/SERVER_DESIGN.md` 第 11 节第 3 项） |
| 4 | 短信服务 | 手机号 + 短信验证码登录 | 手机号、验证码 | **第二版**，依赖境内主体完成签名和模板报备 | — |
| 5 | 在线支付（微信支付、支付宝） | 在线充值 | 订单号、金额 | **第二版**，依赖境内主体的商户号；第一版由管理员手动充值 | — |
| 6 | 发票服务 | 开具增值税发票 | 开票信息 | **第二版**，依赖境内主体 | — |

### 发信服务的送达率

服务器在境外，而大陆用户大量使用 QQ 邮箱和 163 邮箱，这两家对境外发信 IP 和新域名的过滤较严，验证邮件进垃圾箱或被延迟会直接导致用户无法注册和找回密码。选型和上线前要做到：

- 用本项目自有域名发信，配置 SPF、DKIM、DMARC（先 `p=none` 观察报告，再逐步收紧）；发信域名与站点域名一致或为其子域；
- 优先选对 QQ / 163 有实测送达数据的服务商；共享 IP 的信誉不可控，量起来后考虑独立 IP 并预热；
- **上线前实测**：用 QQ、163、126、Gmail 等邮箱各注册测试账号，分别验证注册、找回密码、邀请三类邮件是否进入收件箱、到达耗时；结果记入本节；
- 邮件内容避免短链接、大图和营销用语，链接只指向本站域名；纯文本与 HTML 双版本；
- 处理退信和投诉回调：硬退信的地址停止发送，界面提示用户更换邮箱；
- 界面提供“重新发送”（受 `docs/SERVER_DESIGN.md` 第 3.5 节限流约束）和“检查垃圾邮件箱”的提示；
- 发信服务的凭据只放在服务端（Docker secret），不进日志和仓库。
