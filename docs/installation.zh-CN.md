# CDB 0.9 测试版安装与快速上手

适用公开版本：`0.9.0`

精确构建：以发布目录中的 `codex-plugin/codex-design-bridge/.codex-plugin/plugin.json` 为准。

> CDB 0.9 当前是测试版。macOS 主路径已有真实桌面证据；Windows 安装和自动化已完成开发，但真实 Codex/Figma Desktop 联合验收仍在进行。安装失败、页面卡住或同步异常时，可以直接让 Codex读取本仓库并继续修复。

## 安装前准备

- Codex Desktop 与 Figma Desktop。
- 完整仓库或完整 ZIP，不能只复制安装器、Codex 插件目录或 Figma manifest。
- Node.js 20 以上。安装器优先使用 Codex 自带 Node，再回退到系统 Node。
- Codex CLI 可用。找不到 `codex`、`codex.exe` 或 `codex.cmd` 时，先更新或重新安装 Codex。
- macOS 需要 `python3`；缺少时安装 Xcode Command Line Tools。
- Windows 需要 PowerShell 5.1 以上；推荐 Windows 10/11 64 位。
- 安装前保存工作并完全退出 Codex/ChatGPT。安装后必须重新打开并新建任务，旧任务不会热加载新工具。

CDB 只监听本机回环地址，不需要 Figma API Key，不使用官方 Figma MCP 配额，也不要求完全磁盘访问、关闭 Gatekeeper 或关闭系统完整性保护。

## 获取完整项目

GitHub：<https://github.com/daodaoup/CDB-CodexDesignBridge>

可以使用 GitHub Desktop 克隆，或在 GitHub 选择 **Code → Download ZIP**。解压后不要改变内部目录关系。

## macOS 安装或升级

1. 完全退出 Codex/ChatGPT。
2. 在 Finder 打开完整项目目录。
3. 双击 `Install Codex Design Bridge.command`。
4. 等待终端显示安装版本、运行缓存和安装报告路径。
5. 重新打开 Codex并新建任务。

若 macOS 阻止首次运行，Control-点击 `.command` 并选择“打开”。若文件缺少执行权限：

```bash
chmod +x "./Install Codex Design Bridge.command"
chmod +x "./scripts/install-codex-design-bridge-macos.sh"
./Install\ Codex\ Design\ Bridge.command
```

只校验发布目录、不安装：

```bash
bash ./scripts/install-codex-design-bridge-macos.sh \
  --source ./codex-plugin/codex-design-bridge \
  --check-only
```

成功报告应包含当前 exact-build、`status: installed`、`hashesVerified: true` 和 `pluginListConfirmed: true`。

## Windows 安装或升级

1. 完全退出 Codex/ChatGPT。
2. 在完整解压目录中双击 `Install Codex Design Bridge.vbs`。
3. 等待系统弹窗显示成功或失败。
4. 重新打开 Codex并新建任务。

需要查看详细输出时使用 PowerShell：

```powershell
$checkReport = Join-Path $env:TEMP "cdb-package-check.json"
.\scripts\install-codex-design-bridge.ps1 `
  -CheckOnly `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath $checkReport
Get-Content $checkReport -Raw
```

真实安装：

```powershell
$installReport = Join-Path $env:TEMP "cdb-install.json"
.\scripts\install-codex-design-bridge.ps1 `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath $installReport `
  -WaitForExit
Get-Content $installReport -Raw
```

成功报告要求：

- `status: installed`
- `hashesVerified: true`
- `pluginListConfirmed: true`
- `version` 等于 `plugin.json` 的 exact-build
- `mcpNodePath` 指向存在的 `node.exe`

全新 Windows 用户目录不需要预建 `personal` marketplace；安装器会建立独立的 `codex-design-bridge-local` marketplace。

安装后可验证 daemon 强杀恢复：

```powershell
$report = Get-Content "$env:TEMP\cdb-install.json" -Raw | ConvertFrom-Json
& $report.mcpNodePath .\scripts\verify-local-runtime.mjs `
  --plugin-root $report.installedPath `
  --report "$env:TEMP\cdb-runtime-verification.json"
```

报告必须是 `status: passed`，且 `originalPid` 与 `recoveredPid` 不同。该脚本不能替代真实 Figma Desktop 验收；完整 Windows 清单见 [Windows 开发与验收交接](handoff-2026-08-31-windows.zh-CN.md)。

## 安装 Figma Desktop 插件

当前 Figma 插件尚未发布到 Figma Community，需要导入本地开发插件。

- GitHub 地址：[plugin/manifest.json](https://github.com/daodaoup/CDB-CodexDesignBridge/blob/main/plugin/manifest.json)
- 本地文件：`项目目录/plugin/manifest.json`

1. 打开 Figma Desktop。
2. 选择 **Plugins → Development → Import plugin from manifest**。
3. 选择本地 `plugin/manifest.json`。
4. 在目标 Figma 文件运行 **Plugins → Development → CDB**。

升级时通常不必重新导入 manifest，但必须关闭旧 CDB 插件窗口并重新运行。不要同时保留多个旧插件实例。

## 打开 CDB

在安装后的新 Codex 任务中发送：

```text
@codex-design-bridge 打开工作台
```

也可以明确指定：

```text
@codex-design-bridge 打开项目 /绝对/项目路径
@codex-design-bridge 从 Figma 开始
@codex-design-bridge 新建设计：一个简洁的摄影师作品集首页
```

本地 Web Workspace 可以独立打开：

- macOS：双击 `Open CDB Workspace.command`
- Windows：双击 `Open CDB Workspace.cmd`
- Node 环境：运行 `npm run workspace`

## HTML → Figma

1. 用 CDB 打开静态 HTML/CSS 项目。
2. 在 Figma Desktop 运行 CDB 插件，确认显示的项目名称和短键正确。
3. 在工作台选择页面并发送到 Figma。
4. 等待 Figma 创建可编辑 Frame；多页项目应生成独立 Frame。
5. 页面为“已同步”且工作台 `pendingChangeCount = 0` 才算成功。

## Figma → HTML

1. 在 Figma 只选择一个完整顶层 `Frame`、`Group`、`Component` 或 `Instance`。
2. 点击“发送到 CDB 工作台”。
3. 在工作台选择创建项目、添加为新页面或更新关联页。
4. 等待事务写入和真实浏览器验证完成。
5. 检查 HTML/CSS、资源和预览实际变化，并确认两端重新为“已同步”。

## 状态含义

| 状态 | 含义 | 建议 |
| --- | --- | --- |
| 未导入 | 当前项目页面没有当前 exact-build 映射 | 重新发送当前页面，不恢复旧绑定 |
| 已同步 | 源码、Figma、视觉门禁和共同基线一致 | 可以继续修改任一端 |
| 源码更新 | 同步后 HTML/CSS 发生变化 | 从 CDB 更新 Figma |
| Figma 修改 | Figma 有尚未应用的变化 | 发送到 CDB 工作台 |
| 两边均有修改 | 两端都偏离共同基线 | 明确选择保留方向 |
| 已收到但生成未完成 | Bridge 收到数据，但转换或事务失败 | 查看具体错误，交给 Codex修复后重试 |
| 发送失败 | 连接、会话、版本或协议失败 | 检查 exact-build 和唯一插件客户端 |

## 遇到问题时让 Codex修复

不要盲目反复安装、清缓存或恢复旧版本。将截图、完整错误、项目路径、操作系统与 exact-build 发给 Codex，让它先复现并检查：

- `plugin.json`、安装报告与运行缓存是否为同一 exact-build。
- `get_cdb_health` 的 daemon、活动项目、preview 与 Figma 客户端状态。
- 工作台 pending、同步基线、事务日志和真实浏览器结果。
- Figma 连接是否来自当前项目和唯一插件窗口。

推荐提示词：

```text
继续修复 Codex Design Bridge。先阅读 README.zh-CN.md、docs/product-status.zh-CN.md 和最新交接文档，保留当前工作树已有修改。核对当前 exact-build、get_cdb_health、安装报告和 Figma 连接，复现我提供的问题，定位根因，修改源码并补回归测试。修改插件核心文件后更新 cachebuster、重新安装并在新 Codex 任务验证。不要兼容或迁移任何旧版本、旧协议、旧 Page IR、旧缓存、旧绑定或旧同步数据。
```

## 成功判定

- 新 Codex 任务加载的 `runtimeVersion` 与发布目录 exact-build 一致。
- `get_cdb_health` healthy，活动项目正确，Figma 客户端通常为 1。
- Figma 页面显示“已同步”。
- 工作台 pending 为 0，源码、资源和本地预览实际变化。

当前 0.9 仍是测试版。完整能力和已知限制见[当前产品状态](product-status.zh-CN.md)，真实验收见[桌面验收清单](figma-smoke-test.md)。
