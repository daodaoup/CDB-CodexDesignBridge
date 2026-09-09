# CDB 0.9 Windows 开发与验收交接（2026-08-31）

当前候选：`0.9.0`

精确构建：`0.9.0+codex.20260829100031`

交接目标：在 Windows 真实 Codex、Figma Desktop 和本地 Web Workspace 上完成 0.9 发布门禁；不读取、不迁移、不兼容任何旧版本数据。

## 先看结论

- macOS 的 0.9 主链路、双页面导入、六宽度响应式矩阵、20 轮冻结双页真实 Chrome 往返、安装和 daemon 强杀恢复已经通过。
- 当前剩余的发布阻断是 Windows 真实桌面证据，不是继续增加旧版本兼容。
- Windows 必须从全新工作区、全新 Figma 文件和当前 exact-build 开始，不复制 Mac 项目的 `.cdb`、`.figma-sync`、运行目录、插件缓存或旧 Figma 页面关联。
- 当前仓库处于 detached HEAD，基准提交为 `d55656be470a0edec98c3fcd34e8e9a650cb8f64`，并有大量未提交和未跟踪文件。只检出该 SHA 不包含 0.9 工作成果；必须复制完整工作树，或先由用户明确授权后再提交/推送。
- Windows 通过前不得把 0.9 标为发布完成，也不得用 GitHub Actions、PowerShell 语法检查或 macOS 上的便携 PowerShell 结果替代真实 Windows Codex/Figma Desktop 验收。

## 当前代码与验证事实

| 项目 | 当前事实 |
| --- | --- |
| 根版本 | `package.json` 为 `0.9.0` |
| 插件精确版本 | `0.9.0+codex.20260829100031` |
| 协议与页面模型 | protocol 16 / Page IR Responsive v2 schema 2 |
| 旧数据策略 | 旧协议、旧 Page IR、旧 exact-build 绑定、提案、payload、恢复会话和同步基线全部拒绝，不迁移 |
| macOS 完整测试 | 166 项：162 通过、0 失败、4 项 Windows OS 专用跳过 |
| 仓库校验 | 18 个 JSON 与仓库规则通过 |
| macOS 安装 | `--check-only` 与真实干净安装通过，核心哈希一致 |
| macOS 运行时恢复 | daemon `24636 → 24637`，项目、页面、预览和 lease 全部恢复 |
| macOS Figma 双页 | home 69 节点、library 74 节点；单独更新第二页后两页仍为 `synced`，`unsentChanges = false` |
| 真实浏览器矩阵 | 320、375、402、430、768、1440 六宽度各 10 轮；冻结 home/search-explore 各 10 轮，完整 diff 为 0 |

macOS 证据文件仅用于核对，不要在 Windows 当作验收结果：

- `/tmp/cdb-install-check-20260829100031.json`
- `/tmp/cdb-install-20260829100031.json`
- `/tmp/cdb-runtime-verify-20260829100031.json`

## 最后完成的修复

1. 图片较多的页面从 Figma 改文字写回时，紧凑 baseline 会移除图片 base64。过去 `carryBaselineResources` 会把当前有效图片资源错误替换成无 base64 的 baseline 资源，最终报 `resource base64 is required`。现在仅在当前资源缺数据且 baseline 确实有 base64 时才补资源，当前有效图片数据不会被覆盖。
2. Figma Bridge 操作默认超时从 20 秒提升为 120 秒，可用 `CODEX_DESIGN_BRIDGE_FIGMA_OPERATION_TIMEOUT_MS` 覆盖。
3. gateway 的 daemon 启动超时和工具执行超时已拆分：启动仍默认为 4 秒，工具请求默认 180 秒，可分别用 `CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS` 与 `CODEX_DESIGN_BRIDGE_REQUEST_TIMEOUT_MS` 设置。
4. Figma 插件 UI 会显示 `fastApply.error` 的具体错误，不再只显示“页面生成器发生异常”。
5. 上述三类问题均增加自动化回归；最终完整 Node 测试因此从 164 项增加到 166 项。

## Mac 现场停点

- Mac 本地测试项目位于 `~/Codex Design Bridge Projects/home-2`。不能把该目录连同隐藏状态整体复制到 Windows；可以单独复制当前 HTML、CSS 和 `assets` 作为无状态页面源码。
- Figma 文件 `Bridge` 中当前 exact-build 的 home 根为 `83:507`，标题节点为 `83:518`，对应源码选择器为 `[data-codex-id="figma-node-566-85"]`。
- 交接前只完成了精确节点定位，没有完成“修改短文案 → 写回 HTML → 恢复原文”的最终人工往返。因此这项必须在 Windows 的全新项目和全新 Figma 文件重新执行。
- Mac Figma 文件中仍能看到旧构建留下的普通画布根，其中一个旧根含临时长文案。当前 0.9 exact-build 不会读取这些根。不要为了兼容或恢复它们改代码，也不要把这个 Figma 文件用作 Windows 验收文件。

## Windows 机器准备

1. 安装或更新 Codex Desktop、Figma Desktop、Git 和 Node.js 20 以上版本。
2. 从 GitHub 克隆当前 `main`，不要复制 Mac 工作树里的 `.cdb`、`.codex`、`node_modules` 或其他本地状态。仓库已经包含 `gateway.mjs`、`daemon.mjs`、Responsive v2 schema、测试 fixture 和本交接文档。
3. 若要复用 Mac 已验收的图片双页，只额外复制以下可见源码到一个中转目录：

   - `home-2/index.html`
   - `home-2/styles.css`
   - `home-2/library.html`
   - `home-2/library.css`
   - `home-2/assets/`

   不复制 `home-2/.cdb`、`home-2/.figma-sync`、`home-2/.codex` 或 `AGENTS.md`。这会得到当前页面源码，但不会携带任何项目身份、绑定、共同基线或恢复数据。
4. 不要复制以下数据：

   - Mac 的 `~/Library/Application Support/Codex Design Bridge`
   - Mac 的 `~/.codex/plugins/cache`
   - Mac 测试项目中的 `.cdb` 与 `.figma-sync`
   - 旧 Figma 文件里的 CDB 页面根或 pluginData

5. 在 Windows 仓库根目录确认身份：

```powershell
Get-Content .\codex-plugin\codex-design-bridge\.codex-plugin\plugin.json -Raw
git status --short
node --version
```

精确版本必须是 `0.9.0+codex.20260829100031`。如果不是，停止验收，不要用相近的 0.9 缓存代替。

## Windows 必做一：完整自动化

在仓库根目录执行：

```powershell
npm ci
npm run check
```

要求：

- 仓库校验通过。
- Node 测试 0 失败。
- macOS 上跳过的 4 项 Windows OS 专用测试在 Windows 实际执行并通过。
- 记录测试总数、通过数、失败数、跳过数和总耗时；不要预填结论。

若失败，先保存完整终端输出，再修代码。修复任何插件核心文件后必须更新 exact-build、重装并重新跑完整测试；不要在旧缓存上继续桌面验收。

## Windows 必做二：安装器与缓存身份

先完全退出 Codex/ChatGPT。然后在 PowerShell 执行只检查：

```powershell
$checkReport = Join-Path $env:TEMP "cdb-windows-package-check.json"
.\scripts\install-codex-design-bridge.ps1 `
  -CheckOnly `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath $checkReport
Get-Content $checkReport -Raw
```

要求 `status` 为 `package-valid`、版本为当前 exact-build、核心文件齐全。

再执行真实安装：

```powershell
$installReport = Join-Path $env:TEMP "cdb-windows-install.json"
.\scripts\install-codex-design-bridge.ps1 `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath $installReport `
  -WaitForExit
Get-Content $installReport -Raw
```

要求：

- `status: installed`
- `hashesVerified: true`
- `pluginListConfirmed: true`
- `version` 为当前 exact-build
- `mcpNodePath` 指向真实存在的 `node.exe`
- 全新用户目录无需预建 marketplace，安装器可自举 `codex-design-bridge-local`

注意：`Install Codex Design Bridge.vbs` 仍可能显示旧的 0.8 提示文案，这是当前仓库的已知包装文案遗漏，不代表实际安装了 0.8。验收以 JSON 报告和 plugin manifest 为准；Windows 收尾时应把该提示更新为 0.9 并补安装器回归。

## Windows 必做三：纯运行时强杀恢复

使用真实安装报告中的 Node 和缓存路径：

```powershell
$report = Get-Content "$env:TEMP\cdb-windows-install.json" -Raw | ConvertFrom-Json
$runtimeReport = Join-Path $env:TEMP "cdb-windows-runtime-recovery.json"
& $report.mcpNodePath .\scripts\verify-local-runtime.mjs `
  --plugin-root $report.installedPath `
  --report $runtimeReport
Get-Content $runtimeReport -Raw
```

要求：

- `status: passed`
- `platform: win32`
- `originalPid` 与 `recoveredPid` 均大于 0 且不同
- `projectRecovered`、`pageRecovered`、`previewRecovered`、`leaseRecovered` 全为 `true`

这一步只证明后台恢复，不能替代下一节的真实 Figma Desktop 恢复。

## Windows 必做四：全新双页项目

只使用新目录和新 Figma 文件。建议 Windows 项目目录：

```text
%USERPROFILE%\Codex Design Bridge Projects\windows-0.9-acceptance
```

把“Windows 机器准备”中转出的 `index.html`、`styles.css`、`library.html`、`library.css` 和 `assets/` 放进这个全新目录。不要复制任何隐藏 CDB 状态。仓库中的 Responsive v2 fixture 没有携带图片二进制，只用于自动化基线，不适合作为这轮图片桌面验收项目。

然后：

1. 重新打开 Codex，必须新建任务；旧任务不会热加载新插件。
2. 打开上述项目，确认工作台、preview 和 `get_cdb_health` 都来自当前 exact-build。
3. 新建一个空白 Figma Design 文件，只导入当前仓库 `plugin/manifest.json`，关闭其他所有 CDB 开发插件窗口。
4. 先发送 home，再发送 library；不能把第二个页面覆盖到第一个 Frame。
5. 记录每页顶层 Frame ID、节点映射数、设计尺寸、source hash、Page IR hash 和耗时。
6. 分别选择两个页面并单独重发第二页，确认第一页仍为 `synced`，后台 `unsentChanges = false`，页面数仍为 2。
7. 在 320、375、402、430、768、1440 六个工作台宽度检查预览；展示缩放不得改变设计 viewport 或生成源码。

通过标准：两个页面都可编辑、尺寸正确、图片和 SVG 正常、页面身份不串线、没有旧页面或旧绑定自动恢复。

## Windows 必做五：Figma → HTML 真实写回

这项必须覆盖本轮最后修复的图片资源问题：

1. 在 home 的当前 exact-build Frame 中只改标题文字，例如改为 `Good evening, Sarah — Windows sync check`。
2. 不改任何图片节点，点击“发送到 CDB 工作台”。
3. 等待真实完成；69 节点页面允许超过 20 秒，但不应在 120 秒 Bridge 边界或 180 秒 gateway 边界前产生假超时。
4. 确认 HTML 只出现目标文字变化，图片资源仍可加载，不能出现 `resource base64 is required`。
5. 确认 `appliedChangeCount = 1`、`pendingChangeCount = 0`、页面重新为 `synced`。
6. 在 Figma 把文字恢复为 `Good evening, Sarah`，再次发送并确认 HTML 恢复、共同基线同步。
7. 对 library 重复一个小型文字或颜色修改，确认第二页写回不会改变 home 的 source hash 或同步状态。

不要用 Undo 代替最后的恢复写回；需要证明同一个节点可以连续两次 Figma → HTML 往返且基线继续推进。

## Windows 必做六：真实桌面强杀与重连

保持以下状态：Codex 任务打开、工作台已打开、Figma CDB 插件窗口保持连接、两个页面均为 `synced`。

1. 调用 `get_cdb_health`，记录 daemon PID、活动项目、当前页、preview URL、`figmaBridgeCount`。
2. 在 PowerShell 强制结束该 PID：

```powershell
$daemonPid = 12345 # 替换为刚才记录的实际 PID
Stop-Process -Id $daemonPid -Force
```

3. 不重启 Codex，不重新安装；在同一任务再次调用 `get_cdb_health` 或打开同一项目。
4. 记录新 PID，要求与旧 PID 不同。
5. 确认项目、当前页、preview 和 lease 恢复，Figma 插件自动重新连接，`figmaBridgeCount = 1`。
6. Figma 页面清单仍为两个页面，均未生成重复 Frame，也没有恢复任何旧版本绑定。
7. 再执行一次小型 Figma → HTML 修改并恢复，证明重连后链路仍可写。

## Windows 必做七：视觉失败交互验收

这项是 0.9 最后一项人工 UX 证据：

1. 在可恢复副本上制造一个超过门禁的受控视觉差异，并保留原始文件副本。
2. 触发同步，确认工作台明确显示“视觉验收失败/未标记同步”，不能显示绿色已同步。
3. 展开差异，确认能看到稳定节点 ID、字段、Figma 值、HTML 值和实测 bounds。
4. 打开参考图/实测图，检查叠加滑杆和红色热区。
5. 点击“在 Figma 中定位”，必须选择当前 exact-build 对应节点，而不是同名旧节点。
6. 点击源码位置，必须打开项目目录内正确 HTML/CSS 片段，任意路径或超过 2 MB 文件应被拒绝。
7. 恢复原文件并重新同步，确认视觉门禁通过、pending 清零、共同基线未被失败结果推进。

若无法稳定构造失败样例，记录具体阻断和已尝试方式，不得把自动化测试结果冒充人工点击证据。

## Windows 证据记录模板

在 Windows 完成后新增一份日期化记录，例如 `docs/windows-acceptance-2026-09-01.zh-CN.md`：

| 证据 | 记录内容 |
| --- | --- |
| OS | Windows 版本、架构 |
| 应用 | Codex 版本、Figma Desktop 版本、Node 版本 |
| 代码身份 | exact-build、Git SHA、工作树是否有额外修改 |
| 自动化 | 总数/通过/失败/跳过、耗时 |
| 安装 | check report、install report、installedPath、mcpNodePath |
| 运行时恢复 | originalPid、recoveredPid、四项恢复布尔值 |
| 双页 | 页面 ID、Frame ID、节点数、尺寸、hash、耗时 |
| 双向写回 | 修改字段、HTML 文件、事务 ID、恢复结果 |
| 桌面强杀 | 前后 PID、Figma 客户端数、页面清单、截图 |
| 视觉失败 | 差异节点、热区、Figma 定位、源码定位、恢复结果 |
| 结论 | passed / failed / blocked，剩余问题与复现步骤 |

报告 JSON 和截图建议放到系统临时目录或单独证据目录，不要把个人路径、token、完整用户配置或旧缓存提交进仓库。

## Windows 修复时的规则

- 保留当前工作树所有既有修改，不使用 `git reset --hard` 或覆盖式 checkout。
- 不添加任何 0.8、protocol 15、Page IR v1 或旧 exact-build 兼容分支。
- 不迁移旧 `.cdb`、旧 baseline、旧 offer、旧 payload、旧 socket 或旧 Figma pluginData。
- 修复必须面向当前 protocol 16 / Responsive v2；缺身份或旧身份继续失败关闭。
- 修改插件核心文件后更新 cachebuster，重跑完整测试、Windows `-CheckOnly`、真实安装、缓存运行时恢复和受影响桌面路径。
- 先修可复现根因，再决定是否扩大产品范围；React/Vue 语义、Variables、Variant 和复杂原型不属于 0.9 Windows 门禁。

## 已知非产品阻断

- plugin-creator 的通用 Python 校验器在 Mac 宿主因缺少 PyYAML 无法启动；仓库自身校验、安装器哈希和运行时验证均已通过。Windows 不需要为了这项安装全局 Python 包，也不能用它替代 CDB 自身校验。
- `docs/installation.zh-CN.md`、`docs/figma-smoke-test.md` 和 Windows VBS 提示曾保留 0.8 文案；本交接与 `plugin.json` 是 Windows 0.9 验收的当前事实来源。旧版本文档只作历史记录。

## Windows 新任务可直接使用的提示词

```text
继续 Codex Design Bridge 0.9 Windows 验收。先完整阅读 docs/handoff-2026-08-31-windows.zh-CN.md、docs/product-status.zh-CN.md 和 docs/next-version-plan-0.9.zh-CN.md。保留当前工作树全部已有修改；当前不兼容任何旧版本、旧数据、旧协议、旧 Page IR 或旧 exact-build。先核对精确构建和 Windows 完整自动化，再依次完成安装/缓存身份、运行时强杀恢复、全新双页 CDB→Figma、图片页面 Figma→HTML 往返、真实桌面强杀重连和视觉失败交互验收。所有结果写入日期化 Windows 验收文档；不要用 CI 或脚本结果替代真实 Codex/Figma Desktop 证据。
```
