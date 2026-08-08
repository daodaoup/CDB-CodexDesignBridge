# Codex Design Bridge 当前状态

更新日期：2026-08-08
当前源码版本：`0.7.0`

## 一句话结论

0.7.0 已把静态 HTML/CSS 的跨父级结构移动、Flex/Auto Layout 双向映射和写回后的真实预览验证落到代码与自动化；Windows 全量检查通过。正式发布仍需安装精确插件候选，并在全新 Codex 任务和真实 Figma Desktop 完成往返验收；macOS 尚未验证。

## 状态总览

| 范围 | 当前结论 |
| --- | --- |
| 工作区源码 | `0.7.0` |
| 当前精确候选 | `0.7.0+codex.20260808005823` |
| 用户可见版本 | 工作台只显示 `V 0.7.0`；缓存可带短内部后缀 |
| 本地 Bridge | 协议 14；接受协议 13 迁移连接；未知未来协议安全 pending |
| Figma 插件身份 | Protocol 14 握手单独上报并校验正式版本 `0.7.0`；工作台状态暴露已连接插件版本 |
| 自动化 | `npm.cmd run check` 通过；102 项中 96 通过、0 失败、6 项 macOS 专用跳过 |
| Windows 安装器 | `CheckOnly`、核心文件校验和不完整包拒绝测试通过 |
| Windows 一键安装 | `Install Codex Design Bridge.vbs` 隐藏运行并等待 Codex 自然退出；不强杀应用，完成后系统弹窗反馈 |
| 真实浏览器验证 | MCP、WebSocket、源码事务和本地预览的 protocol 14 reparent 集成测试通过 |
| 真实 Figma Desktop | 待用精确安装候选执行结构、布局、冲突和 Undo 验收 |
| macOS | 安装器与专用测试保留；当前候选尚未在 macOS 执行 |

## 0.7.0 已实现

### 原子结构与位置回写

- `nodeMove` / `nodeReparent` 使用 protocol 14 权威 schema，携带旧/新父级、索引、相对 bounds、世界变换、布局和定位。
- 克隆替换与删除原节点会合并为一个原子重挂，避免先删后补造成半完成状态。
- 静态 HTML/JSX 安全上下文中可从旧父级移除原始标记并插入目标父级，原有文字、事件、ARIA、业务属性与稳定 ID 不被重生成。
- 目标为 absolute、flex、grid 或同父级普通布局时，分别选择 `left/top`、`order`、grid placement 或 translate。
- DOM 与 CSS 在同一多文件事务提交；循环结构、不安全模板、陈旧 source hash 或中途失败均零写入。
- 工作台 Undo 恢复最近一次 CDB 事务；事务后存在外部编辑时拒绝覆盖。

### 自动验证与失败恢复

- 快速写回后运行统一预检并捕获真实本地预览，不以截图或静态推断冒充验证。
- 校验稳定节点仍存在、父级正确、目标索引正确，且关键节点 x/y 误差不超过 2px。
- 只有验证成功才允许 `pendingChangeCount = 0`；验证失败会安全 Undo，并把节点、属性、阶段和原因写入 pending。
- `examples/codex-landing` 的 `daodao` 跨父级场景已有固定回归，不依赖用户截图或 Codex 人工定位。

### Flex、Auto Layout、Grid 与可编辑对象

- 页面捕获保留 Flex direction/wrap/gap/padding/align/justify，item grow/shrink/basis/order/absolute/Fill 等属性。
- CSS Flex 导入为 Figma Auto Layout，支持双轴间距、对齐以及 Fixed/Hug/Fill 的安全映射。
- Figma Auto Layout 修改可回写为 CSS flex；基础 Grid 模板、行列间距和 placement 可捕获和回写。
- Text、Frame、安全 SVG 和同源小型 PNG/JPEG/WebP 保持为可编辑对象；图片使用 Figma image fill。
- 再次导入同页时复用页面根和未变 Frame/Text；SVG/图片局部替换。增量失败时才退回整页替换。
- Figma 有未发送修改时，源码更新返回 `unsent_figma_changes`，不会静默覆盖设计师工作。

### 延续的产品基线

- 当前 CDB 项目直接恢复工作台；无绑定项目时 `@CDB` 打开不占 preview、Figma 连接和 lease 的启动器。
- `.cdb/manifest.json` 是页面清单主要来源；CSS、JS、图片、SVG 和字体是依赖而不是页面。
- Figma 插件保留轻量 CDB 页面列表，不成为源码文件管理器。
- 单工作台使用跨进程 lease/heartbeat/control endpoint；只有旧工作台存在未发送 Figma 修改时才确认接管。

## 明确未承诺

- React/Vue/Vite 项目转换和完整组件语义适配。
- ZIP、100MB 分块上传、断点续传或大文件传输协议。
- 完整 Figma→HTML 设计模型、Component/Instance/Variant、Variables/Design Token、原型交互。
- 任意动态模板、循环/条件渲染、CSS-in-JS、复杂业务组件的自动结构重写。
- 任意断点的响应式推断、复杂图片裁切/焦点、富文本和全部高级视觉效果。
- Figma 原生完整 Grid 编辑器；0.7.0 仅承诺基础 Grid 语义和确定性 placement。

## 发布门禁

1. 为 0.7.0 运行插件 cachebuster、manifest 校验和个人插件重装，确认个人源与运行缓存哈希一致。
2. 完整退出后新建 Codex 任务，确认 MCP 工具、启动器、内嵌工作台和版本身份来自新缓存。
3. 在真实 Figma Desktop 完成页面导入、daodao 跨父级移动、Flex/Auto Layout 回写、自动验证、Undo 和未发送修改冲突保护。
4. Windows 双击安装包以同一候选完成安装报告与恢复路径核对。
5. macOS 对同一精确候选执行 CheckOnly、安装、缓存和桌面验收；此前发布说明必须标注未验证。

## 相关文档

- [0.7.0 实施计划与完成定义](next-version-plan-0.7.zh-CN.md)
- [0.7.0 发布说明](release-0.7.0.zh-CN.md)
- [安装与快速上手](installation.zh-CN.md)
- [真实 Figma 往返验收](figma-smoke-test.md)
- [0.6.0 历史发布说明](release-0.6.0.zh-CN.md)
