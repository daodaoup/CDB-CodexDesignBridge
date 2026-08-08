# CDB 0.7 升级计划：网页/App 双向设计闭环

更新日期：2026-08-06  
规划基线：0.6.0 / 本地 Bridge 协议 13  
落地版本：0.7.0 / 本地 Bridge 协议 14  
状态：P0 与本文件定义的 P1 已实现并进入发布验收

## 0. 实施状态

| 能力 | 0.7.0 结论 | 验收证据 |
| --- | --- | --- |
| 原子跨父级移动 | 已实现 `nodeMove` / `nodeReparent`，结构和 CSS 同事务提交 | `fast-page-patch` 原子写入、循环拒绝、Undo 回归 |
| Figma 结构采集 | 已记录父级、索引、相对 bounds、世界变换、布局和定位 | 插件协议快照与克隆替换合并回归 |
| 自动验证 | 已在真实本地预览中核对父级、顺序、稳定 ID 和 2px 几何阈值 | MCP/WebSocket/浏览器集成测试 |
| daodao 场景 | 已实现跨父级重挂且不截图、不重生成业务结构 | `examples/codex-landing` 固定回归 |
| Flex/Auto Layout | 已实现方向、换行、间距、padding、对齐、尺寸和 item 属性双向映射 | 页面捕获、Figma 插件和 CSS 快速写回测试 |
| Grid | 已实现基础模板、间距与 placement；Figma 端以结构元数据和图层顺序表达 | Grid 捕获与原子移动回归 |
| 增量更新保护 | 已复用页面根及未变 Frame/Text；存在未发送 Figma 修改时拒绝覆盖 | 插件增量复用与冲突保护回归 |
| Image/SVG | 同源小型位图作为可编辑图片填充；安全 SVG 保持可编辑 | 捕获、导入与安全校验回归 |
| 三方版本身份 | CDB 运行时保留完整候选，工作台显示正式版本，Figma 插件单独上报并校验 `0.7.0` | Protocol 14 构建错配拒绝与状态暴露回归 |

自动化基线：`npm.cmd run check` 通过；102 项测试中 96 项通过、6 项 macOS 专用测试在 Windows 跳过、0 失败。真实 Figma Desktop 与 macOS 仍是发布门禁，不以自动化替代。

## 1. 产品结论

CDB 下一阶段重新聚焦两条核心链路：

1. 优先使用 Codex + CDB 设计网页或 App，并将页面写入结构清晰、可继续编辑的 Figma。
2. 设计师在 Figma 修改布局、结构和视觉细节后，将差异精确、事务化地写回当前源码。

目标闭环：

```text
Codex/CDB 设计网页或 App
  → 写入可编辑 Figma
  → Figma 修改结构与细节
  → 差异回写 Codex 源码
  → 自动预检与视觉验证
```

支持范围内的同步不应依赖截图或 Codex 人工推断。单向 Figma → Codex 回传完成后，不自动再次发送到 Figma。

## 2. 当前基线

当前快速回写路径识别约 28 类操作：

- 20 类视觉/CSS 属性：尺寸、位移、填充、边框、透明度、显隐、间距、圆角和基础排版。
- 1 类文字内容修改。
- 6 类结构与资源操作：插入、克隆、删除、重排、SVG 插入和 SVG 替换。
- 1 类整页种子导入。

已有基础：稳定节点 ID、source hash 校验、事务写入、冲突检测、安全 Undo、项目预检、本地预览、差异快照与 pending 交接。

0.6.0 的核心缺口（以下 P0/P1 已在 0.7.0 解决）：

- `x/y` 只应用相对 translate，不能处理跨父级后的坐标系变化。
- `nodeReorder` 无法处理祖先与后代同时参与的结构重组。
- 结构快照缺少完整父级、索引、定位模式及修改前后 bounds。
- Auto Layout 与 CSS Flex/Grid 尚未形成双向语义映射。
- Figma 固定画布变化不能可靠落到响应式规则。
- 高频视觉效果、图片裁切、富文本与组件语义覆盖不足。
- 缺少覆盖同步能力矩阵的自动化回归测试。

## 3. 0.7 P0：结构与位置闭环

### 3.1 新增原子结构协议

新增 `nodeMove` / `nodeReparent`，不再仅用 `nodeReorder` 隐式表达跨父级移动。协议至少携带：

```json
{
  "property": "nodeMove",
  "nodeId": "stable-node-id",
  "fromParentId": "old-parent-id",
  "toParentId": "new-parent-id",
  "fromIndex": 2,
  "toIndex": 4,
  "beforeBounds": { "x": 380, "y": 0, "width": 180, "height": 52 },
  "afterBounds": { "x": 647, "y": 397, "width": 180, "height": 52 },
  "beforeWorldTransform": [1, 0, 0, 1, 380, 397],
  "afterWorldTransform": [1, 0, 0, 1, 647, 397],
  "parentLayout": "NONE",
  "positioning": "ABSOLUTE"
}
```

### 3.2 Figma 采集端

- 记录旧/新父级、旧/新索引、相对 bounds 和世界变换矩阵。
- 记录父级布局、节点定位模式、约束和图层顺序。
- 将“克隆替换 + 删除原布局”合并为一个原子结构事务。
- 快照保存完整事实，不能因为当前应用端不支持就丢弃字段。
- 结构变化必须包含足够信息，使 Codex 不依赖截图推断位置。

### 3.3 CDB 源码应用端

- 从旧父级安全移除节点，插入新父级指定索引。
- 允许祖先与后代同时参与结构调整。
- 根据目标父级选择 `left/top`、flex order、grid placement 或 transform。
- 保留稳定 ID、文字、事件、ARIA 和业务属性。
- 结构、几何和依赖样式在同一 patch transaction 中提交。
- 任一环节失败则整体回滚，不产生半应用状态。
- pending 必须报告节点、属性、失败阶段和明确原因。

### 3.4 自动验证

- 写回后运行统一预检并生成页面预览。
- 校验节点父级、顺序、bounds、可见性和稳定 ID。
- 支持范围内关键节点位置误差不超过 2px。
- 验证通过后才允许 `pendingChangeCount = 0`。

### 3.5 首个端到端回归

固定使用 `examples/codex-landing` 的 `daodao` 按钮：

1. 在 Figma 中将按钮从 `hero-actions` 移动到 `hero-copy`。
2. 保持与原按钮同一水平线，并移动到右侧。
3. 回写后 DOM 父级、顺序和视觉位置均正确。
4. 稳定 ID、文字和响应式行为保持不变。
5. 不提供截图、不要求 Codex 人工定位。
6. 最终五项变化全部自动应用，`pendingChangeCount = 0`。

## 4. 0.7 P1：可编辑 Figma 与 Auto Layout

Codex → Figma：

- CSS Flex 映射为 Figma Auto Layout。
- 映射 direction、wrap、gap、padding 和双轴对齐。
- 映射 Fixed、Hug contents、Fill container。
- 保持清晰图层层级、语义命名和稳定 ID。
- Text、Image 和安全 SVG 保持可编辑对象。
- 再次写入同一页面时增量更新，不重复创建整棵图层。
- 检测并保护 Figma 中尚未提交的修改。

Figma → Codex：

- 回写 `flex-direction`、`flex-wrap`、`gap` 和 `padding`。
- 回写 `justify-content`、`align-items` 和 `align-self`。
- 回写 order、grow、shrink、basis 和 absolute positioning。
- 支持 Grid 的基础行列、间距和 placement。

## 5. 0.8：高频视觉细节

- 工作台内嵌实时 HTML 延期到 0.8.x：先实现固定来源 Preview Gateway、沙箱 iframe、能力路径和 8 秒截图降级；详细安全调研见 [0.5.2 计划的后期规划](next-version-plan.zh-CN.md#101-后期规划工作台内嵌实时-html08x)。
- 多重填充、线性/径向渐变和透明度。
- 阴影、内阴影、背景模糊和混合模式。
- 单边边框、描边位置、虚线和四角独立圆角。
- 图片替换、裁切、焦点和 `object-fit`。
- rotation、通用 transform、constraints 和 clip content。
- 字体、字重、行高、字距、段落间距和文本自动尺寸。
- 混合样式富文本和结构化降级快照。
- 响应式变化必须明确目标断点，不能无条件覆盖所有尺寸。

## 6. 0.9/1.0：组件化与稳定产品闭环

- Figma Component、Instance、Variant 与前端组件映射。
- Component properties 与 React/Vue props 映射。
- Design Token、CSS 变量与 Figma Variable 同步。
- 多页面、多路由和共享组件。
- 冲突预览、选择性接受和事务级撤销。
- 每次同步生成结构差异、视觉差异和验证报告。
- 为 HTML/CSS、React、Vue 和 Svelte 建立明确适配器边界。

## 7. 工程拆分

- 协议层：`stylePatch`、`geometryPatch`、`layoutPatch`、`structurePatch`，定义 schema、依赖、原子组与降级策略。
- Figma 采集层：基于稳定 ID 捕获树变化、相对/世界几何、布局模式和资源引用。
- 源码适配层：映射为框架相关补丁，优先复用源码；动态 DOM 或语义不明确时保持 pending。
- 验证层：DOM 映射、节点几何、页面截图、局部视觉差异、预检与事务回滚。

## 8. 测试矩阵

覆盖维度：

- 节点：Frame、Text、Image、SVG、Component。
- 操作：Insert、Delete、Clone、Move、Reparent、Reorder、Replace。
- 布局：普通流、absolute、Flex、Grid、Auto Layout。
- 源码：静态 HTML、React JSX/TSX、Vue、Svelte。
- 样式：单 CSS、多 CSS、CSS Module、inline style、CSS-in-JS。
- 结果：自动应用、安全 pending、冲突回滚、幂等重放。

每个声明支持的操作必须有 Figma fixture、协议快照、源码应用、幂等、几何/视觉和 Undo 测试。

## 9. 产品指标

- Codex → Figma 首次导入成功率不低于 95%。
- 声明支持范围内 Figma → Codex 自动应用率不低于 90%。
- 结构事务完整率 100%，禁止半应用状态。
- 关键节点最终位置误差不超过 2px。
- 文字、稳定 ID 和交互属性保留率 100%。
- 支持范围内的操作不要求用户提供截图。
- 每个 pending 操作都有明确失败原因。

## 10. 实施顺序

立即执行：

1. 确认 Figma 开发插件源码位置，并纳入同一协议版本管理。
2. 定义 protocol 14 的 `nodeMove/nodeReparent` schema。
3. 为 `daodao` 跨父级移动建立端到端失败测试。
4. 实现 Figma 采集端结构与坐标输出。
5. 实现 CDB 原子重挂、坐标转换和回滚。
6. 加入节点几何验证并完成真实桌面验收。

Auto Layout ↔ Flex/Grid 已随 0.7.0 实施。高频视觉属性、响应式、组件和 Design Token 仍按第 5、6 节延期。

## 12. 0.7.0 明确边界

- 可靠自动应用面向静态 HTML/CSS、稳定 `data-codex-id`、明确源码父子关系和安全样式上下文。
- React JSX/TSX 仅保留既有安全补丁能力，不声明完整组件语义；Vue、Svelte、CSS-in-JS 不作为 0.7.0 完成条件。
- Grid 在 Figma 中不是完整原生 Grid 编辑器；0.7.0 保留模板/placement 元数据并支持确定性回写。
- 不推断任意响应式断点，不把固定 Figma 画布位置无条件覆盖到所有尺寸。
- 多重填充、复杂渐变、图片焦点/裁切、富文本、Component/Instance/Variant、Design Token 延期。
- 本版本不新增 React/Vue/Vite 工程转换、ZIP、100MB 分块上传或完整 Figma→HTML 设计模型。

## 13. Definition of Done

0.7.0 只有同时满足以下条件才可标记为正式完成：

1. Protocol 14 schema、协议 13 兼容和未知未来协议安全 pending 均通过测试。
2. move/reparent 在 source hash 校验下原子提交，失败零写入，成功可安全 Undo。
3. 写回后真实预览验证父级、索引、稳定 ID 与关键节点位置误差不超过 2px；失败自动回滚并给出阶段化原因。
4. daodao 固定用例无需截图或 Codex 人工定位即可 `pendingChangeCount = 0`。
5. Flex/Auto Layout 双向字段和基础 Grid 字段均有捕获、协议、应用与插件回归。
6. Figma 中未发送的修改不会被源码更新静默覆盖。
7. `npm.cmd run check`、Windows 安装包 CheckOnly、插件 manifest 校验、个人源与运行缓存一致性通过。
8. 在全新 Codex 任务和真实 Figma Desktop 完成导入、跨父级移动、回写、验证、Undo 与冲突恢复。
9. macOS 未完成同候选验收前，发布说明必须明确标注未验证，不得宣称跨平台正式通过。

## 11. 发布原则

- 每个版本只声明已有回归测试保护的能力。
- 协议升级保持向后兼容；旧客户端遇到未知操作时安全 pending。
- CDB 运行时、个人插件源码和 Figma 插件分别报告版本，阻止版本错配。
- 发布前运行插件校验、协议测试、事务测试和真实往返验收。
- 仅更新规划文档不触发 cachebuster 或插件重装；运行代码或技能变化后再执行更新流程。
