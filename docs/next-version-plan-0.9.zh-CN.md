# Codex Design Bridge 0.9 开发计划

更新日期：2026-08-31

开发起点：`0.8.0+codex.20260823004648`

版本主题：**适配语义、自动视觉验收、连续往返零漂移**

## 一句话目标

0.9 不继续扩大“看起来支持”的范围，而是在明确的静态页面合同内，让 Figma、Page IR、HTML 和浏览器预览使用同一套适配语义；合同内自动验收并稳定双向往返，合同外明确阻断或报告降级。

## 当前实施状态

2026-08-24 已完成首轮 M0/M1 schema 门禁：

- `home` 与 `search-explore` 的 HTML、CSS、Page IR v1 共同基线、Figma 根身份、69 项节点映射、资源哈希和真实浏览器截图已冻结到 `test/fixtures/page-ir-responsive-v2/`。
- 新增独立的 `page-ir-responsive-v2.schema.json` 与严格运行时规范化/验证模块；设计 viewport、运行 viewport 和展示 scale 分字段保存，其中展示 scale 不进入语义 hash。
- 协议 16、Page IR schema 2 和 `0.9.0+codex.<cachebuster>` 身份失败关闭；protocol 15、Page IR v1、0.8 精确构建和不匹配的 0.9 精确缓存均被测试拒绝。
- Figma/HTML 写入器已经切换到 protocol 16 与 Responsive v2；旧运行链路只保留为冻结测试事实，0.9 运行时不会读取或兼容。

2026-08-27 已继续完成首轮 M3/M4：

- Figma 完整 payload 与页面修改快照加入权威 PNG，create/add/update/常规写回接入真实浏览器像素 Diff；失败会回滚或撤销新建结果，不能进入 `synced`。
- 工作台新增真实渲染验收证据，以及 `1:1`、适应窗口和六个验收宽度预览。
- 六个验收宽度均加入十次 Figma/Page IR 往返 hash/diff 门禁，并完成十轮真实 HTML/CSS 生成、浏览器渲染、DOM/Page IR 回采和再生成矩阵。
- 冻结的真实 `home`、`search-explore` 双页也已各完成十轮真实 Chrome 往返；每页 69 个节点，20 轮完整 diff 为 0，资源与语义 hash 不变。
- HTML 结构捕获改为使用页面自己的 viewport；真实矩阵同时修复并锁定了根节点 sizing、min/max 和圆角的跨轮保留。
- 真实双页矩阵进一步锁定了显式副轴 `0` 间距、Fill/Flex 父子关系、8 位透明色、百分比 min/max 捕获和 SVG 稳定序列化。
- 工作台视觉失败状态已提供节点/字段/Figma 值/HTML 值列表、点击 bounds 定位、参考/实测叠加滑杆和超阈值热区；差异条目还可受限跳转当前 exact-build 的 Figma 原生节点，并在工作台内打开对应源码片段。
- 项目绑定升级为 exact-build 身份校验；任何旧版本绑定都会被当作空状态，旧同步基线不会迁移，只会在当前构建完成全新导入后被原子替换。
- 多页面的项目源码指纹与同步身份已经拆分；连续发送或单独更新第二页不会把先前已同步页面误标记为源码变化。
- 图片型页面的 Figma 文字写回不再用无 base64 的紧凑 baseline 覆盖当前有效图片资源；插件会展示快速写回的具体错误。
- daemon 启动超时、Figma 操作超时和 MCP 工具请求超时已经拆分，分别覆盖快速启动失败与 69 节点以上真实长操作。

## 版本原则

- 不兼容 protocol 15、Page IR v1 或任一旧精确构建的运行缓存、提案、payload、恢复会话与迁移身份。
- 直接启用新的协议和 Page IR；缺字段、旧版本或身份不完整时失败关闭，不走隐藏 fallback。
- Figma 原始设计尺寸、HTML 运行时适配和工作台展示缩放是三套独立数据，禁止互相污染。
- “已同步”必须由结构、几何、视觉和共同基线同时证明，不能只以传输完成或文件写入成功判断。
- 只保留一个权威页面身份和一条当前共同基线；不读取历史版本数据补身份。

## 0.9 范围

### 1. Page IR Responsive v2

新增并强校验以下语义：

- 设计 viewport、运行 viewport 与预览 scale。
- Fixed、Hug、Fill、min/max、aspect ratio、overflow 与横纵 constraints。
- 明确 breakpoint 列表和每个 breakpoint 的布局覆盖，不从单一截图猜测任意响应式规则。
- Flex/Grid/freeform 的父子适配关系与字段归属。
- 文字换行、单行截断、自动高度和字体回退后的可验证尺寸。
- 每个字段的 HTML/Figma/Shared/System 所有权。

支持的首批验收宽度：`320`、`375`、`402`、`430`、`768`、`1440`。

### 2. 双向适配映射

- Figma Auto Layout、resizing、constraints 与变量模式映射到确定性 CSS。
- HTML 的 Flex、Grid、min/max、aspect-ratio、overflow 和受控媒体查询映射回 Figma/Page IR。
- 只生成 Page IR 明确表达的 breakpoint；不自动创造设计中不存在的桌面版或移动版。
- 预览 fit-to-window 只作用于本地展示层，永不写入生成 HTML 或同步基线。

### 3. 自动视觉 Diff 门禁

每次导入、写回和冲突解决后自动生成并比较：

- Figma 权威渲染图。
- 同 viewport 的真实浏览器截图。
- 节点级 bounds、文字行盒、颜色、透明度、圆角、图片裁切和可见性。

默认门禁：

- 关键节点位置或尺寸误差不超过 `2px`。
- 页面级像素差达到阈值时不得显示“已同步”。
- 错误必须关联到 `pageId`、稳定节点 ID、Figma node ID、CSS/HTML sourceRef 和具体字段。

### 4. 连续往返零漂移

建立固定 fixture 语料库，覆盖：

- 手机首页、搜索页、长列表、弹窗、Tab、Sticky/Fixed 底栏。
- Flex、Grid、freeform、图片、SVG、文本截断和不同字体。
- 多页面项目、同一资源复用和跨页面组件外观一致性。

每个 fixture 连续执行至少 10 次：

`Figma → Page IR → HTML → 浏览器 capture → Page IR → Figma`

完成标准：节点身份、层级、顺序、适配字段、资源哈希和视觉结果不继续漂移。

### 5. 工作台一致性 UX

- 页面同时显示设计尺寸、当前浏览器 viewport 和展示比例。
- 提供 `1:1`、`适应窗口`、验收 breakpoint 三种预览模式。
- 修改审查按页面、节点和字段展示 HTML/Figma 两端值。
- 冲突可逐字段选择，所有接受、更新和撤销仍使用原子事务。
- 降级项在发送前展示；存在阻断项时禁用“已同步”。

## 明确推迟

以下能力不作为 0.9 发布前置：

- React/Vue/Vite 业务组件源码重构。
- 任意 CSS-in-JS、循环模板和运行时 DOM 的可逆转换。
- Figma Component/Instance/Variant 的完整代码组件生成。
- Variables/Design Token 的完整团队库发布流程。
- 原型动画、时间轴和复杂交互逻辑。

这些能力在 0.9 的适配与验收基础稳定后再进入 1.0 规划。

## 里程碑

### M0：冻结 0.8 基线与 fixture

- 固定当前 `home` 与 `search-explore` 为真实桌面验收样例。
- 保存 Figma 根身份、HTML、viewport、Page IR、截图和节点映射摘要。
- 增加现有 0.8 双页链路的不可变回归测试。

### M1：启用新协议与 Page IR v2

- 新 schema、验证器、规范化器、hash 和 diff。
- 删除旧协议分支、迁移读取和兼容测试。
- 未提供适配语义的节点明确标记 unsupported，而不是猜测。

### M2：实现响应式双向映射

- Figma → Page IR v2 → HTML/CSS。
- HTML capture → Page IR v2 → Figma。
- 六个验收宽度的结构和几何测试。

### M3：接入视觉 Diff 门禁

- 截图、像素 diff、节点几何 diff 和错误定位。
- create/add/update/conflict resolution 全部接入同一门禁。
- 验证失败自动撤销源码事务并保持原共同基线。

### M4：零漂移与工作台 UX

- 10 次连续往返矩阵。
- 1:1、适应窗口和 breakpoint 预览。
- 节点级差异与降级报告。

### M5：真实桌面与发布候选

- macOS Figma Desktop 完整验收。
- daemon 强杀、断线重连、payload 恢复和事务撤销复验。
- Windows 安装与桌面联合验收。
- 仓库检查、完整测试和精确插件候选安装。

## 0.9 发布完成定义

- 六个目标宽度全部通过结构、几何和视觉门禁。
- 固定 fixture 完成 10 次连续往返，结果不继续漂移。
- 任意失败均不留下半写源码、错误基线或“已同步”假状态。
- 当前双页真实项目仍能新增、更新、撤销并保持 Figma/HTML 身份一致。
- 新精确构建不读取任何 0.8 运行数据或兼容身份。
- macOS 与 Windows 的真实桌面结果分别记录，不以自动化代替桌面证据。

## 下一步实现任务

当前 M0–M4 自动化闭环、冻结双页真实往返语料、精确候选安装和 macOS Figma Desktop 双页面验收均已完成；剩余发布工作：

1. 按[Windows 交接清单](handoff-2026-08-31-windows.zh-CN.md)完成当前 exact-build 的 Windows 完整自动化、安装缓存身份和纯运行时强杀恢复。
2. 在全新 Windows 项目与全新 Figma 文件完成双页面 CDB → Figma、图片页面 Figma → HTML 改字/恢复、第二页隔离和真实桌面 daemon 强杀自动重连。
3. 在受控视觉失败样例中完成差异列表、叠加热区、Figma 原生节点定位和源码片段定位的人工点击验收。
4. Windows 通过后完成最终 0.9 发布审计；新项目目录选择器与项目名冲突交互作为后续体验增强单独排期。
