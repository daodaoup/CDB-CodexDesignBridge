# Codex Design Bridge 0.5.2

完整版本：`0.5.2+codex.20260806060812`  
候选日期：2026-08-06  
状态：源码候选，真实 Codex/Figma 桌面验收未完成

## 版本目标

0.5.2 把 CDB 从“打开某个页面并发送到 Figma”整理为一条确定的产品链路：先明确用户意图和来源，再用 manifest 描述页面、统一预检，最后才启动真实工作台、接管唯一的本地 Figma 连接。

## 主要变化

- `@CDB` 默认打开不绑定项目的空启动器；不扫描、不建草稿、不启动 preview、不占用 lease/Figma Bridge。
- “打开项目”只解析显式路径、附件或当前工作区；没有可用静态项目时回到启动器。
- “新建设计：描述”直接生成 `index.html`、`styles.css`、`assets/`、`AGENTS.md`、`.cdb/manifest.json` 并打开。
- 所有来源进入统一预检，结果分为通过、警告、安全自动修复、阻断错误；自动修复绑定报告和源码哈希并事务提交。
- `.cdb/manifest.json` 成为页面清单主要来源；HTML 入口或路由才是页面，CSS/JS/图片/SVG/字体均为依赖。
- 导入静态 HTML 时，一一对应的 `data-screen` / `data-target` Tab 会写入 manifest 为同入口独立捕获状态；工作台预览和 Figma 发送前激活目标 Tab，Music 可得到 Home、Discover、Library 三个 Frame。
- 工作台页面列表不再支持运行时添加或重命名假页面，只允许选择 manifest 页面。
- Figma 插件新增“CDB 页面”列表、六种同步状态、定位 Frame、导入当前、导入选中和更新全部。
- 新增跨进程 lease、heartbeat 和 loopback control endpoint；干净旧工作台自动关闭，只有未发送 Figma 修改需要确认。
- 工作台用户可见版本只显示 `V 0.5.2`；完整构建号仅用于安装、缓存和诊断。
- 视图缩放、8px 外圆角、移除“添加页面”和关闭当前任务正式纳入版本基线。
- 修复安全内联 SVG 后存在普通页面脚本时被误判为 `unsafe_svg` 的问题；危险检查现在限定在每个完整 SVG 片段内。

## MCP 工具变化

新增：

- `open_design_launcher`
- `resolve_design_source`
- `create_design_project`
- `preflight_design_project`
- `apply_design_preflight_fixes`

调整：

- `open_design_workspace` 新增显式 `forceHandoff`。
- `manage_design_workspace_page` 只保留 `select`；页面增删改必须先更新 manifest/源码再重新预检。
- Figma 本地 Bridge 协议从 11 升级到 12，旧插件窗口会收到版本不匹配提示。

## 兼容与迁移

- 根目录存在静态 HTML、但没有 `.cdb/manifest.json` 的项目继续可用：CDB 在内存中推断页面并给出警告，不自动落盘。
- 旧导入副本即使缺少 manifest，也会用同一有限规则在内存中推断 `data-screen` / `data-target` Tab；仍需按预检提示补齐首次稳定 ID。
- 已有 `.codex/design-bridge.json` 只作为同步历史和选中页恢复来源，不再作为页面定义的权威来源。
- 旧绑定中的页面若不在新 manifest 中会被忽略；同 ID 页保留 Figma 导入和最后发送状态。
- 0.5.1 的事务日志、Undo、Figma 修改快照和冲突文件保持兼容。
- 协议 11 的 Figma 插件窗口必须关闭并重新打开 0.5.2 开发插件。

## 安全边界

- 不扩大到 React/Vue/Vite、ZIP、100 MB 分块上传或完整 Figma→HTML 模型。
- 多捕获根、重复稳定 ID、缺失入口/资源、禁用的跨域资源和危险 SVG 会阻断工作台启动。
- 运行时 DOM 在 0.5.2 只给警告；只有初始 HTML 中的稳定节点保证可编辑映射。
- 预检自动修复仅处理可确定的捕获根和初次稳定 ID 补全；存在同步历史后不自动补 ID。

## 自动化证据

- Node 全套顺序测试为 78 通过、0 失败、6 个平台专用项跳过，覆盖现有回归、启动器、脚手架、manifest、预检、安全修复、页面目录、同入口 Tab 捕获、旧导入推断和单工作台接管。
- Windows 安装器 `CheckOnly` 验证插件清单、17 个核心文件及 SHA-256 哈希。
- 插件 manifest、MCP server、Figma 插件代码和 Apps UI 脚本通过语法/结构测试。

自动化不能替代真实桌面验收。发布前仍须完成：个人源与缓存精确身份、全新 Codex 任务 Apps UI 挂载、Figma Desktop 页面目录与往返、双任务接管，以及 macOS 同候选验证。
