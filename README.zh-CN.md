# Codex Design Bridge（CDB）

[English](README.md) | 简体中文

CDB 把 Codex、本地 HTML/CSS 项目和 Figma Desktop 连接起来，让页面可以在 HTML 与可编辑 Figma 图层之间往返，并把受支持的设计修改安全写回源码。

> **当前是公开测试版，不是稳定生产版。** 当前公开版本为 `0.9.0`，精确构建为 `0.9.0+codex.20260829100031`。macOS 主路径已经完成真实桌面验收；Windows 安装和自动化已准备好，但仍需完成真实 Codex/Figma Desktop 联合验收。遇到问题可以直接让 Codex读取本仓库、诊断、修改、运行测试并重新安装 CDB。

## 适合什么项目

当前最适合结构明确、可在本机运行的静态 HTML/CSS 页面。

- HTML → Figma：把页面转换为可编辑的 Frame、Text、图片、安全 SVG 和受支持布局。
- Figma → HTML：从完整顶层 Frame 创建项目、添加页面或更新已关联页面。
- 双向同步：支持文字、颜色、尺寸、透明度、圆角、描边、排版、Flex/Auto Layout、基础 Grid、约束和部分结构调整。
- 多页面与响应式：独立管理页面身份，并提供 `320 / 375 / 402 / 430 / 768 / 1440` 六个验收宽度。
- 安全写入：使用源码哈希、共同基线、多文件事务、真实浏览器验证和 Undo，避免静默覆盖。

React、Vue、Vite、CSS-in-JS、复杂运行时 DOM、完整 Figma Variables/Variant 和原型动画仍不属于当前测试版的完整承诺。

## 安装条件

两个平台都需要：

- Codex Desktop，且本机可以使用 Codex CLI。
- Figma Desktop；浏览器版 Figma 不能加载本地开发插件。
- 下载或克隆**完整仓库**，不能只下载安装器或 `manifest.json`。
- 可用的 Node.js 20 以上运行时。安装器会优先寻找 Codex 自带 Node，再尝试系统 Node。
- 安装前保存工作并完全退出 Codex/ChatGPT；安装后必须重新打开并新建任务。

CDB 只连接本机回环地址，不需要 Figma API Key，不使用官方 Figma MCP，也不消耗官方 Figma MCP 配额。

## 下载项目

仓库地址：<https://github.com/daodaoup/CDB-CodexDesignBridge>

可使用 GitHub Desktop 克隆，也可以在 GitHub 选择 **Code → Download ZIP**。ZIP 解压后保持原目录结构。

## macOS 安装

额外条件：系统需要 `python3`；缺少时安装 Xcode Command Line Tools。

1. 完全退出 Codex/ChatGPT。
2. 在 Finder 中打开完整项目目录。
3. 双击 `Install Codex Design Bridge.command`。
4. 等待终端显示精确版本、缓存路径和安装报告。
5. 重新打开 Codex并新建任务。

如果 macOS 阻止首次运行，Control-点击 `.command` 并选择“打开”。若文件没有执行权限：

```bash
chmod +x "./Install Codex Design Bridge.command"
chmod +x "./scripts/install-codex-design-bridge-macos.sh"
./Install\ Codex\ Design\ Bridge.command
```

只检查完整性、不安装：

```bash
bash ./scripts/install-codex-design-bridge-macos.sh \
  --source ./codex-plugin/codex-design-bridge \
  --check-only
```

## Windows 安装

额外条件：PowerShell 5.1 以上，且 `codex.exe` 或 `codex.cmd` 可被安装器找到。推荐 Windows 10/11 64 位。

1. 完全退出 Codex/ChatGPT。
2. 在解压后的完整项目目录中双击 `Install Codex Design Bridge.vbs`。
3. 等待系统提示安装完成；需要查看详细日志时运行 PowerShell 安装脚本。
4. 重新打开 Codex并新建任务。

只检查完整性：

```powershell
.\scripts\install-codex-design-bridge.ps1 `
  -CheckOnly `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath "$env:TEMP\cdb-package-check.json"
```

详细安装：

```powershell
.\scripts\install-codex-design-bridge.ps1 `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath "$env:TEMP\cdb-install.json" `
  -WaitForExit
```

Windows 当前仍属于待完成真实桌面验收的平台。详细步骤见 [Windows 开发与验收交接](docs/handoff-2026-08-31-windows.zh-CN.md)。

## 安装 Figma 插件

当前 Figma 端是本地开发插件，尚未发布到 Figma Community。

- GitHub 文件地址：[plugin/manifest.json](https://github.com/daodaoup/CDB-CodexDesignBridge/blob/main/plugin/manifest.json)
- 下载后的本地路径：`CDB-CodexDesignBridge/plugin/manifest.json`

导入方法：

1. 打开 Figma Desktop。
2. 选择 **Plugins → Development → Import plugin from manifest**。
3. 选择本地的 `plugin/manifest.json`。
4. 在目标 Figma 文件中选择 **Plugins → Development → CDB**。

升级 CDB 后，关闭旧 CDB 插件窗口，再重新运行开发插件。不要同时打开多个旧插件实例。

## 使用方法

### 1. 打开 CDB

在安装后的全新 Codex 任务中发送：

```text
@codex-design-bridge 打开工作台
```

也可以直接指定操作：

```text
@codex-design-bridge 打开项目 /绝对/项目路径
@codex-design-bridge 从 Figma 开始
@codex-design-bridge 新建设计：一个简洁的摄影师作品集首页
```

Mac 可双击 `Open CDB Workspace.command`，Windows 可双击 `Open CDB Workspace.cmd`，在浏览器独立打开本地工作台。

### 2. HTML → Figma

1. 用 CDB 打开包含 HTML/CSS 的本地项目。
2. 在 Figma Desktop 运行 CDB 插件，确认项目名称和短键正确。
3. 在工作台选择页面并发送到 Figma。
4. 等待 Figma 生成可编辑页面；多页面应分别生成 Frame。
5. 页面显示“已同步”、`pendingChangeCount = 0` 才算成功。

### 3. Figma → HTML

1. 在 Figma 中只选择一个完整顶层 `Frame`、`Group`、`Component` 或 `Instance`。
2. 点击“发送到 CDB 工作台”。
3. 在 CDB 选择创建新项目、添加为新页面或更新关联页。
4. 等待源码事务和真实预览验证完成。
5. 检查 HTML/CSS、资源和预览确实变化，并确认两端重新显示“已同步”。

### 4. 成功状态

- Codex加载的 `runtimeVersion` 与仓库中的精确构建一致。
- `get_cdb_health` 返回 healthy，活动项目正确，Figma 客户端通常为 1。
- Figma 页面状态为“已同步”。
- 工作台没有 pending，浏览器预览与源码实际更新。

## 遇到 Bug：直接让 Codex继续修复

CDB 本身就是可由 Codex维护的本地项目。遇到卡住、页面尺寸错误、元素不同步、第二页发送失败、安装失败或旧状态干扰时，不需要反复重装或手工删除缓存。把截图、错误文案和项目路径发给 Codex，让它检查当前精确构建、日志、源码和测试，然后直接修复。

可复制下面的提示词：

```text
继续修复 Codex Design Bridge。先阅读 README.zh-CN.md、docs/product-status.zh-CN.md 和最新交接文档，保留当前工作树已有修改。核对 plugin.json 的精确构建、get_cdb_health、安装报告和 Figma 插件连接。复现我提供的问题，定位根因，修改源码并补回归测试；如果改了插件核心文件，更新 cachebuster、重新安装并在新 Codex 任务验证。不要兼容或迁移任何旧版本、旧协议、旧 Page IR、旧缓存、旧绑定或旧同步数据。
```

建议同时提供：

- 操作系统、Codex/Figma 版本。
- `plugin.json` 精确构建号。
- 项目绝对路径和出问题的页面。
- Figma 与工作台截图、完整错误文案。
- `get_cdb_health` 和安装报告结果。
- 可以稳定复现问题的最短步骤。

## 开发与测试

需要 Node.js 20 以上；推荐 Node.js 22。

```bash
npm ci
npm run check
```

当前 macOS 完整结果为 166 项：162 通过、0 失败、4 项 Windows 专用跳过。Windows 真实桌面通过前，项目继续标记为测试版。

## 文档

- [文档中心](docs/README.zh-CN.md)
- [当前产品状态](docs/product-status.zh-CN.md)
- [详细安装与恢复](docs/installation.zh-CN.md)
- [桌面验收清单](docs/figma-smoke-test.md)
- [Windows 开发与验收交接](docs/handoff-2026-08-31-windows.zh-CN.md)
- [0.9 开发计划](docs/next-version-plan-0.9.zh-CN.md)

## 安全与许可

CDB 只监听本机回环地址。不要提交 `.figma-sync/`、`.codex/`、`.cdb/`、连接 token、事务备份、日志、个人插件缓存或真实用户项目。

本仓库当前未声明开源许可证；公开可见不代表自动授予复制、修改或再分发权利。
