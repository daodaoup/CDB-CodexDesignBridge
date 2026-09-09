# GitHub 仓库结构

此目录是 CDB 的干净源码仓库，不是运行缓存或已安装插件目录。

```text
codex-design-bridge/
├─ codex-plugin/codex-design-bridge/  # Codex 插件、gateway/daemon、Apps UI、技能和内置依赖
├─ plugin/                            # Figma Desktop 开发插件
├─ src/                               # 当前仓库的底层页面与 Bridge 工具，不承担旧版本兼容
├─ desktop/                           # 旧版 Electron 工作台，保留用于回归
├─ bin/                               # 本地 CLI 入口
├─ scripts/                           # 安装器与示例服务脚本
├─ test/                              # Node 自动化测试
├─ design-draft/design.html           # 视觉捕获回归测试夹具
├─ examples/                          # 已清理运行状态的静态示例
├─ pages/                             # 页面描述样例
├─ docs/                              # 当前状态、安装、验收、计划、发布和交接文档
├─ .github/workflows/ci.yml           # GitHub Actions 检查
├─ package.json
└─ README.md
```

## 两个插件目录的区别

- `codex-plugin/codex-design-bridge/` 是安装到 Codex 的插件包，包含 `.codex-plugin/plugin.json`、`.mcp.json`、`skills/`、`mcp/`、`shared/`、图标和自包含运行依赖。
- `plugin/` 是在 Figma Desktop 中通过 `plugin/manifest.json` 导入的本地开发插件，负责接收页面、生成可编辑图层并把受支持修改送回本地 Bridge。

## 0.9 运行时分层

- `mcp/gateway.mjs` 是每个 Codex 任务加载的轻量 stdio 网关。
- `mcp/daemon.mjs` 是按精确版本复用的后台进程，统一持有活动项目、预览、Figma Bridge 和 lease。
- `mcp/server.mjs` 提供 MCP 工具与工作台状态；`mcp/local-figma-bridge.mjs` 负责 loopback WebSocket 和项目客户端选择。
- `mcp/design-offer-store.mjs` 保存协议 15 offer/payload；`mcp/fast-page-patch.mjs` 负责既有页面的事务写回。

## 不进入仓库的内容

- `node_modules/`、`.pnpm-store/` 和构建缓存。
- `.figma-sync/`、`.codex/`、`.cdb-imports/` 等本机运行状态。
- 连接 token、事务备份、日志、环境变量文件。
- 已安装的 Codex 插件缓存和个人 marketplace 配置。
- 历史 ZIP、校验文件和重复 release 解压目录；二进制发布包应放 GitHub Releases。
- 旧设计稿和带本机绝对路径的历史交接副本。

`design-draft/design.html` 是唯一保留的旧设计稿文件，因为自动化视觉捕获测试直接使用它；同目录的运行状态和历史交接未包含。

## 修改位置

修改功能时以本仓库源码为准，不要直接编辑 Codex 的安装缓存。Codex 插件变更需要更新 cachebuster、重新安装，并在全新 Codex 任务中验收。

文档的职责和入口见[文档中心](README.zh-CN.md)。历史计划、发布说明和交接文件保留当时事实，不作为当前能力来源。
