# 智标投标工具箱

<p align="center">
  <strong>简体中文</strong> | <a href="./README.en.md">English</a>
</p>

面向招投标场景的桌面标书编写工具。本仓库正在把桌面客户端改造为 Web 服务，进度见 [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md)。

## 主要功能

- 招标文件解析、技术方案目录与正文生成、已有方案扩写
- AI 生图、Mermaid 和 HTML 图表转图，导出 Word
- 文档知识库、资信库、导出模板设置
- 标书查重、废标项检查、错别字和逻辑检查
- 可行性研究报告生成

模型服务由使用者自行配置：支持 OpenAI 兼容接口（也可接入 Ollama、LM Studio 等本地模型）、MinerU 文档解析和 ComfyUI 生图。应用不内置任何默认模型服务，不包含埋点。

## 本地开发

桌面客户端代码位于 `client/`，建议使用 Node.js 22；调试 Open XML 功能或本地打包还需要 .NET 10 SDK。

```powershell
cd client
npm ci
npm run dev         # 启动 Vite 和 Electron
npm run build       # TypeScript 检查与 Vite 构建
npm run dist:win    # Windows x64 安装包和 ZIP
npm run dist:mac    # macOS Intel / Apple Silicon DMG 和 ZIP
```

打包产物位于 `client/release/`。本仓库目前没有发布流程，不对外分发安装包。

开发约定见 [AGENTS.md](AGENTS.md) 和 [client/开发说明.md](client/开发说明.md)，外部服务现状见 [docs/EXTERNAL_SERVICES.md](docs/EXTERNAL_SERVICES.md)。

## 技术架构

- **桌面端**：Electron Main / Preload 提供本地能力，Renderer 通过 `window.yibiao` 调用
- **界面层**：Vite + React + TypeScript，全局 CSS 和 Radix UI
- **数据与任务**：配置保存在本地文件，业务状态存入 SQLite；耗时任务在 Main 后台运行并支持恢复
- **AI 与 Agent**：AI Service 统一管理模型请求，Pi Agent 使用独立 Runtime / Session 执行智能体任务
- **文档处理**：本地或 MinerU 解析，Word 由 .NET Open XML 助手生成，图表在本地渲染

### 项目结构

```
├── client/                    # Electron 桌面客户端
│   ├── electron/              # Main、Preload、IPC 与本地服务
│   ├── src/                   # Renderer 应用源码
│   ├── scripts/               # 构建、资源准备与校验脚本
│   ├── vendor/                # 随包命令工具与离线依赖
│   └── package.json           # 客户端依赖和打包配置
├── openxmlhelper/             # .NET 10 Word / Open XML 助手
├── sql/workspace_schema.sql   # 工作区 SQLite 目标结构
├── docs/                      # 改造路线图与外部服务清单
├── 使用说明/                  # 使用说明
└── .github/workflows/ci.yml   # PR CI
```

## 贡献

问题和建议请提交 Issue，代码改动请提交 Pull Request，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目为闭源商业软件，保留所有权利。未经书面授权，不得使用、复制、修改或分发本项目的任何部分。
