# CDB 0.9 测试版 Codex/Figma 桌面验收清单

精确候选：以 `.codex-plugin/plugin.json` 为准；当前文档编写时为 `0.9.0+codex.20260829100031`

本地 Bridge：protocol 16 / Page IR Responsive v2 schema 2；不兼容、不迁移任何旧协议、旧 Page IR、旧 exact-build 或旧同步数据

原则：自动化、localhost 请求和安装器 `--check-only` 不能替代真实 Codex/Figma Desktop 验收。

Windows 当前候选的完整执行顺序和证据模板见 [Windows 开发与验收交接](handoff-2026-08-31-windows.zh-CN.md)。

每轮记录操作系统、Codex/Figma 版本、精确构建、耗时、截图、修改文件、后台 PID 和失败恢复结果。

## 1. 安装与版本身份

- [ ] 完全退出 Codex/ChatGPT，安装精确候选后新建任务。
- [ ] 安装报告为 `installed`，个人源码与运行缓存哈希一致。
- [ ] 工作台显示 `V 0.9.0`，诊断 `runtimeVersion` 为精确候选。
- [ ] `get_cdb_health` healthy；后台 PID 稳定，活动项目与预期一致。
- [ ] 关闭并重新运行 Figma CDB 开发插件；连接客户端为 1，`lastError` 为空。

## 2. 后台、启动器与新任务

- [ ] 无项目任务可以打开 CDB 启动器，不因当前目录没有 `.cdb` 而失败。
- [ ] 关闭当前任务后，新任务复用同版本后台；工作台打开不重复启动多个 `9847` 服务。
- [ ] 新精确版本使用新运行 socket；旧版本后台不能劫持新版本网关。
- [ ] 启动器不创建假项目、不扫描无关目录、不抢占仍在工作的真实项目。
- [ ] 打开明确项目后只存在一个 preview/Figma/lease owner。

## 3. 项目和重复连接隔离

- [ ] 在项目 A 建立 Figma 页面映射，再打开项目 B；B 不继承 A 的“已导入”状态。
- [ ] Figma 插件显示当前项目名称和正确 `projectKey` 短键。
- [ ] 连续重载 Figma 插件 5 次，Bridge 始终只使用最新客户端。
- [ ] 旧 WebSocket 收到替换通知并关闭，不出现重复回执或随机发送到旧窗口。
- [ ] 切回项目 A 后仅恢复 A 自己的映射和未发送修改状态。

## 4. CDB → Figma

- [ ] 静态 HTML/CSS 项目通过预检，页面列表只包含页面而非 CSS/JS/资源。
- [ ] 当前页导入后得到稳定顶层 Frame，Text/Frame/SVG/图片保持可编辑。
- [ ] 再次发送只更新对应页面；未变化节点尽量复用。
- [ ] Figma 有未发送修改时，源码更新不会静默覆盖。
- [ ] 多页入口/路由分别对应正确 Frame，不重复生成同一页。

## 5. Figma → 已有静态项目 pageSeed

准备一个 `acceptsFigmaSeed: true` 的占位页面，并在 Figma 选中一个完整顶层 Frame。

- [ ] 页面未导入时显示“用选中稿生成当前页面”。
- [ ] 点击后立即显示处理中，不需要再向 Codex发送第二条消息。
- [ ] 成功后显示“已同步”、写入文件和耗时。
- [ ] `index.html`、`styles.css` 和资源实际生成；稳定 `data-codex-id` 唯一。
- [ ] 工作台 `appliedChangeCount > 0` 且 `pendingChangeCount = 0`。
- [ ] Figma 背景模糊 SVG 包含 `foreignObject` 时，安全移除 XHTML 层并保留可用 SVG 主体。
- [ ] 没有 Auto Layout 字段的普通矩形/Group 可以生成，不报 `invalid_inserted_node_style`。
- [ ] 对同一已关联 Frame 重试不会创建重复页面或重复修改源码。

## 6. 修改回传、冲突与 Undo

- [ ] 文字、颜色、尺寸、透明度、排版、间距、圆角和描边写回当前预览。
- [ ] Flex/Auto Layout 方向、gap、padding、对齐、grow/order 可安全写回。
- [ ] 基础 Grid placement 和受约束节点重排/跨父级移动通过真实预览验证。
- [ ] 一次多文件修改全部成功；注入中途失败时全部回滚。
- [ ] Undo 恢复最近 CDB 事务；事务后有外部修改时拒绝覆盖。
- [ ] 源码与 Figma 同时变化显示冲突，不把重试当成成功。

## 7. 失败提示与恢复

- [ ] WebSocket/协议/会话失败显示“发送失败”。
- [ ] 数据已入 Bridge 但转换失败显示“已收到，但生成未完成”。
- [ ] 失败信息包含阶段、原因或错误代码；不只显示泛化红条。
- [ ] pending 变更不发送 `page.changes.accepted`，也不清除未发送状态。
- [ ] 修复后可直接“重试生成”，无需清除所有关联或重装。
- [ ] 失败事务不留下半成品 HTML/CSS/assets。

## 8. protocol 16 提案

- [ ] 无活动项目时，Figma 单个顶层 Frame 可提交轻量 offer。
- [ ] CDB 启动器展示来源、尺寸、节点数和 offer 身份。
- [ ] 重复 offer 幂等；身份冲突拒绝；取消与结果查询可恢复。
- [ ] 接受后重新采集完整 payload，接收端重新计算资源字节和 SHA-256。
- [ ] 节点数、单资源或总资源超限时明确拒绝，不生成半个项目。

- [ ] 从 offer 创建完整新项目并通过事务、预检、视觉门禁和预览验证。
- [ ] 将未关联 Frame 加入现有项目并明确处理同名、身份和基线冲突。
- [ ] 成功结果重放后 Figma 建立 source hash、项目键、页面 ID 和节点映射。

## 9. 平台安装

### macOS

- [ ] `.command` 双击安装成功；缺执行权限时按安装文档恢复。
- [ ] 不要求完全磁盘访问、关闭 Gatekeeper 或关闭 SIP。
- [ ] 精确缓存、新任务、Figma 重载和 pageSeed 往返均使用同一候选。

### Windows

- [ ] `.vbs`/`.cmd` 安装、备份、注册、缓存和报告均成功。
- [ ] 全新用户目录无需预建 `personal` marketplace；安装器自动创建 `codex-design-bridge-local`，报告包含可执行的 `mcpNodePath`。
- [ ] 双击 `Open CDB Workspace.cmd` 可独立于 Codex 任务打开本地 Web Workspace。
- [ ] 对安装报告中的 `installedPath` 运行 `scripts/verify-local-runtime.mjs`，报告为 `passed`，且 daemon PID 发生变化后项目、页面、预览和 lease 均恢复。
- [ ] GitHub Windows CI 的 `cdb-windows-verification` artifact 同时包含 `package-valid` 安装检查报告与 `passed` 运行时恢复报告；记录对应提交 SHA。
- [ ] 当前精确候选完成真实 Codex Apps UI 与 Figma Desktop 往返。
- [ ] 任一核心哈希不一致时安装失败并恢复旧注册。
- [ ] Figma 插件保持打开时强制结束健康检查记录的 daemon PID；同一 Codex gateway 重开项目后，插件自动恢复项目名与页面清单，`figmaBridgeCount = 1`。

## 通过标准

0.9 发布至少要求第 1–9 节在 macOS 与 Windows 分别留下真实桌面证据。Windows 未完成前继续标记为测试版。

以下情况直接阻断：版本或项目身份不一致、重复客户端、旧服务接管新任务、页面传输成功但源码未写入、pending 被错误清零、事务部分提交、真实预览失败却报告已同步。
