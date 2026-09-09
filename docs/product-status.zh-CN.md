# Codex Design Bridge 当前产品状态

更新日期：2026-09-09

公开版本：`0.9.0`

精确构建：`0.9.0+codex.20260829100031`

## 一句话结论

0.9.0 已启用 protocol 16 与 Page IR Responsive v2，把设计 viewport、HTML 运行 viewport 和预览比例拆分为独立字段，并将响应式 sizing、constraints、overflow、text flow、breakpoints 与字段所有权纳入严格合同。旧协议、旧 Page IR、旧精确构建缓存、提案、payload、恢复数据和同步基线不迁移，直接拒绝。M0 的 home / search-explore 双页 fixture 已冻结；macOS 本地 daemon、Figma Desktop 与 Safari fit-preview 的既有真实验收仍保留为基线，Windows 与合同外复杂框架语义仍未完成。

## 当前身份

| 范围 | 当前事实 |
| --- | --- |
| 仓库版本 | 根 `package.json` 为 `0.9.0` |
| Codex 插件 | `0.9.0+codex.20260829100031`；工作台显示公开版本 `V 0.9.0` |
| Figma 插件 | 用户可见版本 `0.9.0`；本地 Bridge 协议 16 / Page IR schema 2 |
| 升级策略 | 只接受当前 exact-build 的 protocol 16 / Responsive v2 身份；不读取、不迁移旧缓存、提案、payload、恢复会话或同步基线 |
| MCP 生命周期 | 每个任务加载轻量 `gateway.mjs`；同版本任务复用一个 `daemon.mjs` |
| 单工作台资源 | 后台唯一拥有预览、`127.0.0.1:9847`、Figma Bridge 和项目 lease |
| 当前平台证据 | macOS 已完成精确候选安装、后台启动、seed / 创建项目 / 新增页面 / 更新关联页，以及 daemon 强杀后自动重连的真实 Figma Desktop 验收 |

## 已实现

### Page IR 与共同同步基线

- 新增 Page IR Responsive v2，把 HTML capture 与 Figma pageSeed 直接归一化为同一响应式节点、布局、视觉、文字和资源模型，不经过 v1 适配器。
- 新增 HTML/Figma/Shared/System 字段归属、确定性 diff 和三方 merge；两端同时修改 shared 字段时明确产生冲突，不按最后写入获胜。
- 每页成功同步后原子保存 `.cdb/sync-baselines/<pageId>.json`，包含源码哈希、Figma 根身份、事务 ID 和无二进制 Page IR。
- HTML 成功导入 Figma、Figma 首次 pageSeed 成功生成源码和 protocol 16 payload 入库均已接入 Page IR；基线写入失败不再显示已同步。
- 常规 Figma ChangeSet 会附带完整页面快照；写源码前先采集当前 HTML 做三方合并。字段冲突会落盘且阻止源码写入，无冲突事务会在 HTML 回读验证后推进基线。
- 工作台状态会展示冲突字段、归属和 HTML/Figma 两端值。
- 工作台现已提供“保留 HTML 并更新 Figma”和“接受 Figma 并更新源码”两个显式动作；两条路径都会验证目标端并推进共同基线，冲突记录保留解决方向和事务 ID。
- 首次 HTML → Figma 导入结果会回传 `pageNodeId ↔ figmaNodeId ↔ sourceRef`，共同基线持久化完整节点映射，不必等到第一次修改后才补齐身份。
- protocol 16 完整 payload 与常规页面快照现在必须携带 Figma 权威 PNG；CDB 在同一设计 viewport 生成真实浏览器截图并执行像素 Diff，未达到门禁会回滚源码事务或移除本次新建项目，不再显示“已同步”。
- 视觉门禁使用内置 PNG 解码器，不依赖系统图片库；当前默认阈值为单通道 `32`、差异像素比 `12%`、平均通道误差 `12`，结果包含参考图/浏览器图哈希、尺寸、差异像素数和误差统计。

### 启动与工作台

- daemon 同时提供独立于 Codex 任务的本地 Web Workspace；默认地址为 `http://127.0.0.1:9846/`，端口冲突时自动选择空闲 loopback 端口。
- 独立 Web Workspace 首次打开或刷新时会与当前 exact-build daemon 的活动项目重新对齐；后台已打开项目时直接进入工作台，不再被早先缓存的启动器输出卡住。
- macOS 可双击 `Open CDB Workspace.command`，有 Node.js 的环境可运行 `npm run workspace`；默认新项目位置为 `~/Codex Design Bridge Projects`。
- `open_cdb` 统一处理恢复当前项目、打开明确项目、从 Figma 开始和无项目启动器。
- `get_cdb_health` 返回后台 PID、精确版本、活动项目、预览数量、Figma 客户端和未发送修改状态。
- 后台启动失败会在有限时间内返回明确错误；运行日志位于 CDB runtime 目录。
- 新精确版本使用独立运行 socket；安装器原子切换个人插件源码和缓存，不删除仍被旧任务使用的运行缓存。
- gateway 复用 daemon 前会重新确认精确版本与存活状态；daemon 被强杀后会清除 stale socket，并在同一 gateway 的下一次请求中自动拉起新 PID。
- 旧 lease 控制端不可达且 owner PID 已死亡时可立即安全接管，不再等待 8 秒 TTL；旧 secret 会同步清理。
- 项目打开前会检查未完成的源码事务：仅当目标仍等于事务前或事务后哈希时自动回滚，崩溃后出现外部编辑则保留当前文件并报告恢复冲突。
- 新项目和候选页 staging 目录携带 owner PID；launcher 或下一次项目操作会清理死亡生成进程留下的隐藏目录，不触碰仍在运行的 staging。
- Codex 工作区新增“清除当前页面”：经确认后只从 `.cdb/manifest.json` 页面列表移除当前页，不删除 HTML、CSS、资源或 Figma 画布；项目至少保留一页，操作使用源码事务并支持普通撤销即时恢复页面列表。
- 工作台新增 `1:1`、`适应窗口` 和 `320/375/402/430/768/1440` 验收断点预览；设计 viewport、响应式验收宽度和展示缩放继续相互独立。
- 工作台会展示最近一次真实渲染验收证据，包括验收尺寸、像素差比例和结构位置误差；视觉失败明确显示为“未标记同步”。
- 视觉失败会列出首批节点级差异，直接给出稳定节点 ID、字段、Figma 值、HTML 实测值，并保留 Figma node ID、源码 selector 和实测 bounds；点击差异会在预览中标出对应区域。
- 工作台可按需载入最近一次 Figma 参考 PNG 与浏览器实测 PNG，提供左右叠加滑杆和超阈值红色热区；大图不进入常规 workspace state，只在用户打开审查时读取。
- 每条视觉差异可直接让本地 Figma 插件选中并放大当前 exact-build 页面中的原生节点，也可在工作台内打开受限于项目目录、最多 2 MB 的对应源码片段；两个入口只接受当前视觉验收返回的节点身份，不接受任意节点 ID 或任意文件路径。

### 连接与项目隔离

- Figma 握手携带 `projectKey`；页面根也保存项目键，旧项目映射不会再被当前项目误判为已导入。
- 同一项目或同一会话重连时只保留最新 WebSocket 客户端，旧连接收到替换通知后停止重连并终止。
- Bridge 只向当前项目且最新的就绪客户端发送页面或采集请求。
- 工作区身份确认不再形成 `plugin.ready → workspace.identity → plugin.hello` 回路；重复 hello 也不会重新导入已缓存页面。
- 插件重载后会重新同步工作区身份、已关联页面和未发送修改状态。
- 项目绑定现在携带当前 exact-build 运行身份；旧版本绑定直接作废并重建，不恢复旧页面同步状态。旧同步基线仍会被读取门禁拒绝，只能在当前构建完成一次全新导入后被新的共同基线原子覆盖，不执行迁移。

### Figma → 已有静态项目

- 对允许 Figma seed 的页面，可选中一个 `Frame`、`Group`、`Component` 或 `Instance` 直接生成当前页面。
- `pageSeed` 保留 Frame、Text、Image、安全 SVG、Auto Layout、基础尺寸、视觉属性和稳定节点 ID。
- Figma 背景模糊导出的 XHTML `foreignObject` 会被安全移除后继续保留 SVG 主体，不再整页失败。
- 没有 Auto Layout 字段的普通矩形/Group 按普通布局处理，不再报 `invalid_inserted_node_style`。
- 成功后 `index.html`、`styles.css` 和资源在同一事务写入；Figma 状态更新为“已同步”。
- 失败时区分“传输失败”和“已收到但生成未完成”，展示失败阶段和原因，并保留重试能力；未完成差异不会被错误标记为已接受。

### 既有双向能力

- CDB → Figma 支持静态 HTML/CSS 页面、稳定 `data-codex-id`、Text/Frame、安全 SVG 和受支持图片。
- Figma → CDB 支持文字、填充、描边、尺寸、透明度、圆角、排版、Flex/Auto Layout、CSS Grid 原始轨道/子项、Figma 横纵 resize constraints 与受约束结构变化。
- Grid 和约束使用 Page IR 严格枚举与受控 HTML 元数据闭环；浏览器实采已验证 `repeat/minmax`、Grid placement、`min/max-width` 和 constraints 不发生语义漂移。
- HTML 结构回采现在严格使用页面设计 viewport，而不是固定 `1440 × 900`；Page IR 同步记录相同的 design/runtime viewport。六个验收宽度 `320/375/402/430/768/1440` 已各执行 10 轮“生成 HTML/CSS → 真实浏览器渲染 → DOM/Page IR 回采 → 再生成”，结构、几何、节点身份、响应式字段和语义 hash 均不继续漂移。
- 冻结的真实 `home`（`402 × 874`）与 `search-explore`（`402 × 905`）也已各执行 10 轮同样的真实 Chrome 往返；两页均保持 69 个节点，20 轮的完整 Responsive Page IR diff 均为 0，资源 hash 与页面语义 hash 不变。
- 多页面状态现在分别保存“项目源码指纹”和“当前 Figma/Page IR 同步身份”：单独发送或更新第二页不会再用项目预检哈希覆盖第一页的浏览器捕获哈希，已同步页面不会误退回 `source_changed`。
- 浏览器根节点没有父级 layout-item 元数据时，Page IR 仅依据明确设计 viewport 推导根节点 fixed sizing；Page IR 的 min/max、捕获的圆角、显式副轴 `0` 间距、父子 Fill/Flex 关系与 8 位透明色均已加入再生成闭环。百分比 `min/max-width` 不再被误当成像素，SVG 会移除无意义标签间空白并保持受控属性位置，避免伪尺寸和资源 hash 漂移。
- Figma-first seed 会携带可用的 fileKey 与每节点真实 Figma ID；成功写入后重新计算 HTML source hash，并通过 changeSet 身份回写 Figma 根/子节点与共同 baseline，避免后续同步继续使用旧 hash。Figma Plugin API 在本地开发环境可能不给出 fileKey，此时使用 projectKey、rootNodeId 与逐节点映射建立身份。
- protocol 16 完整页面中不可导出的 SVG 会降级为语义一致的 `div` Frame placeholder，不再因 `type: frame` 与 `tag: svg` 冲突导致整页 `invalid_inserted_node_tag`。
- protocol 16 新页面完成结果会把 projectKey、pageId、source hash 和稳定节点映射回写 Figma；工作台页面与共同 baseline 采用同一 source hash，避免刚生成就误判为未导入或源码变化。
- 完成结果以当前 Frame 的完整结构重建 Figma baseline，SVG 原子节点内未单独映射的子层不会触发假阳性“Figma 修改”；大页面结构基线按容量安全分片保存，只接受当前 exact-build 的数据格式。
- 多文件快速写回使用事务、源码哈希冲突保护、真实预览验证和安全 Undo。
- 不安全或无法确定的结构保留为 pending，不强行改写动态业务源码。

### 协议 16 提案基线

- 每个精确构建使用独立提案和 payload 目录；升级后旧构建数据不会进入新工作台。同一 Figma 根的重复 pending 提案只保留最新一条，插件发现恢复身份不属于当前运行时会立即清除。
- Bridge 握手和页面 ChangeSet 均只接受 protocol 16；protocol 13/14、缺少版本、缺少 session、版本不匹配和旧 source-hash 迁移路径均直接拒绝或不再存在。
- Figma 可发送轻量 `figma.design.offer`；offer 状态支持幂等、取消、身份冲突拒绝和结果查询。
- 接受 offer 后可重新采集完整 Frame payload，并在接收端校验节点数、资源大小、base64 字节和 SHA-256。
- 无活动项目时启动器可接收并展示提案；进入真实工作台前释放启动器 Bridge。
- 接受“创建项目”提案后，CDB 会在隐藏临时目录生成 `index.html`、`styles.css`、哈希去重资源、项目 manifest 和绑定配置；预检无阻断后再原子切换为最终目录。
- 创建项目 completed result 会返回生成入口、路由、Figma 根身份和完整节点映射；映射的源码位置指向生成后的 `index.html`，插件可在成功后建立稳定页面关联。
- 新项目成功后写入 payload 对应的 Page IR 共同基线，并打开该项目的本地工作台；重复图片按内容哈希只落盘一次。
- 当前项目收到未关联 Frame 时，工作台可直接“添加为新页面”；页面使用独立 HTML/CSS，资源按哈希复用，manifest、源码和资源由同一可撤销事务提交。
- 加页前分别预检现有项目和候选页面；同名、页面 ID、路由、文件、跨项目身份及重复 Figma 根冲突都会明确阻断。成功结果包含事务、source hash 与 Page IR baseline，并自动选中新页。
- 字段冲突可把已保存的完整 Figma 快照事务生成成独立本地页面；原页面和原冲突保持不变，用户随后仍需明确选择接受 HTML 或 Figma，冲突记录会保留副本页面与事务身份。
- 已关联 Frame 可用 protocol 16 完整快照更新原页面；更新前验证 Figma 根/项目/页面身份和共同基线，本地 HTML 有独立变化时拒绝覆盖，写入后通过真实 HTML 回读再推进 baseline。
- 关联页写入后若 Page IR 不一致或 HTML 回读异常，会自动撤销整个源码事务；freeform 坐标、fixed sizing、裁切、受控排版单位和生成文本空白已覆盖真实页面回读。
- `update_page` 完成结果返回 Figma 根身份与完整节点映射；payload 缺少可选节点 ID 时沿用共同 baseline。Figma 接受结果后重建 pluginData 基线，幂等再次发送不会继续显示未发送修改。
- 三方比较会把 baseline 中 Figma 所有的图层名称和节点身份投影到 HTML 侧，浏览器捕获使用稳定元素 ID 时不会被误判为 HTML 篡改 Figma 所有字段。
- protocol 16 端到端自动化已覆盖完成结果查询重放，以及 offer 接受后 Figma 断线、同 session 重连再提交 payload；重连不会重复建页。
- accepted offer 与 completed result 已覆盖跨后台进程重启恢复；重启续传和结果查询保持同一事务身份，manifest 不会产生重复页面。
- 进程级恢复已使用 `SIGKILL` 分别覆盖 accepted 但未收到 payload、completed 但结果帧可能丢失两处边界；新 daemon 重连后继续同一 offer，最终页面只生成一次。
- “接受 Figma”冲突解决提供专用撤销：只有解决事务仍为最新事务时才回滚源码，同时恢复解决前 baseline 并重新打开原字段冲突；普通撤销会拒绝这类事务。
- “接受 HTML”冲突解决使用显式事务身份更新 Figma，并保存原始 ChangeSet 的权威页面快照；页面在解决后又被编辑、事务身份不匹配或 source hash 变化时拒绝撤销，成功撤销会恢复 Frame、旧 baseline 和原字段冲突。
- Figma 插件持久化进行中的 protocol 16 session/offer；Bridge 重连会返回同会话的 completed 结果，插件自动查询并补写稳定节点映射，成功后清除恢复身份。

## 尚未完成

- 新项目目录选择器和项目名冲突的完整交互体验。
- Windows 的后台异常终止恢复与真实 Figma Desktop 联合验收仍待完成。
- React、Vue、Vite、CSS-in-JS 或业务组件的语义级设计到代码转换。
- Figma Component/Instance/Variant、Variables、Design Token、原型交互和响应式断点的完整语义保留。
- 视觉 Diff 已完成页面级门禁、节点级字段列表、画布 bounds 定位、参考/实测叠加滑杆、差异热区、Figma 原生节点定位和工作台源码片段查看；系统级外部编辑器深链不作为 0.9 前置。
- Windows 对当前精确构建的真实 Codex/Figma 桌面验收。

## 2026-08-31 当前候选验证

- 精确构建 `0.9.0+codex.20260829100031` 的最终完整 Node 测试为 166 项：162 通过、0 失败、4 项 Windows OS 专用跳过；其中包含六宽度 60 轮、冻结双页 20 轮真实 Chrome 往返、双页面顺序更新不串扰，以及图片资源基线和长操作超时回归门禁。
- 仓库发布校验通过，检查 18 个 JSON；macOS 安装器 `--check-only` 与真实干净安装均通过，安装缓存位于当前 exact-build 独立目录。
- 安装缓存运行时验证通过：测试 daemon PID `24636` 被终止后由同一 gateway 恢复为 PID `24637`，项目、当前页、预览和 lease 均恢复。
- 当前本地项目 `home-2` 已由最终候选 daemon 打开，后台、个人源码和插件缓存三方版本一致。Figma Desktop 重载最终开发插件后，上一精确构建留下的两个页面根仍可见但不会恢复关联，home/library 均显示“未导入”。
- 随后真实执行双页面发送，共导入 `69 + 74 = 143` 个可编辑节点；再单独更新 library 后，home 与 library 仍同时保持“已同步”，`unsentChanges = false`。项目绑定和两份同步基线均已原子替换为 `0.9.0+codex.20260829100031`，节点映射分别为 69 与 74。
- 图片较多页面的 Figma 文字写回曾因紧凑 baseline 不含 base64 而错误覆盖当前有效图片资源；现在只在当前资源缺数据且 baseline 确实有 base64 时补资源。Figma UI 同时改为展示 `fastApply.error` 的具体错误。
- Figma Bridge 操作超时默认提升到 120 秒，gateway 的 4 秒 daemon 启动超时与 180 秒工具请求超时已拆分配置，避免真实 69 节点导入刚完成却被调用端误报超时。
- 交接前尚未完成当前 exact-build 的受控“Figma 改字 → HTML → 恢复原文”人工闭环；该项与视觉失败点击验收移交 Windows 全新项目执行，不以自动化回归代替。
- plugin-creator 通用 Python 校验器仍因宿主 Python 没有 PyYAML 而无法启动；这是工具环境依赖阻断，不替代也不否定上述仓库、安装器、缓存哈希和运行时验证结果。

## 2026-08-13 macOS 实测

使用精确构建 `0.8.0+codex.20260813165319` 完成：

1. macOS 安装器校验并安装个人插件缓存。
2. 新后台 PID 启动并监听 `127.0.0.1:9847`。
3. Figma CDB 开发插件重载后只保留一个连接，`lastError` 为空。
4. 选中 `bar` Frame（23 个图层）生成已有静态项目的 `index.html` 与 `styles.css`。
5. 工作台 `appliedChangeCount = 1`、`pendingChangeCount = 0`，Figma 显示“已同步”。

这证明当前 seed 链路可工作；2026-08-18 又完成 372 层 Frame 的真实 offer 新增页，以及 `Frame 38` 的创建项目和关联页再次发送验收。2026-08-21 补充完成 daemon 强杀后的真实 Figma Desktop 自动重连。Windows 验收尚未完成，因此仍不等同于 0.8 全部 DoD 已完成。

## 2026-08-21 自动化与真实桌面状态

- 完整 Node 测试：148 项，144 通过、0 失败、4 项 Windows OS 专用跳过。
- 精确构建 `0.8.0+codex.20260820175923` 已通过 macOS 安装器 `--check-only` 与干净安装；真实 Figma Desktop 保持插件窗口时强杀 PID `40861`，同一 gateway 拉起 PID `40996`，重开项目后插件自动恢复“已连接”，后台恢复到 `figmaBridgeCount = 1`。
- Windows 发行入口已改为当前 0.8 文案并增加独立 Web Workspace `.cmd`；PowerShell 7.6.4 在隔离 macOS 目录真实执行了 Windows 安装脚本的语法解析、`-CheckOnly`、独立 marketplace 自举、缓存哈希核验和安装缓存强杀恢复。该证据证明脚本逻辑可执行，但不冒充 Windows OS 或 Figma Desktop 验收。
- offer → 本地项目自动化覆盖完整 HTML/CSS/assets/manifest 生成、资源哈希去重、临时目录预检、原子提交、Page IR 基线和完成状态回传。
- offer → 现有项目新增页面同时覆盖项目级事务测试和真实 protocol 16 WebSocket offer/payload 端到端测试。
- 原 Bridge 测试挂起来自过期的协议 14 版本拒绝预期，不是资源 teardown 泄漏；测试已改为协议 16 版本冲突并正常退出。
- 仓库校验、文档链接、版本口径和行尾检查通过。
- 仓库校验通过；`20260818103200` 真实初次生成暴露的映射/hash 问题已在 `0.8.0+codex.20260818104442` 完成安装与 Figma Desktop 复验：23 个节点映射完整，页面/baseline source hash 一致，pending 为 0。
- 真实 protocol 16 新增页使用 372 层 Frame 验证：生成页面与资源事务成功，339 个节点映射均非空，页面/baseline source hash 一致，Figma 为“已同步”，后台 `unsentChanges: false`。大结构 pluginData 单值超限问题由分片基线修复。
- 精确构建 `20260818100047` 已通过 macOS 安装器 `--check-only` 与真实安装；新缓存 daemon 的运行时、个人源码和 manifest 版本一致。
- 真实 `Frame 38` 冲突撤销已验证：共同 baseline 为 `#EAF8FF`、HTML 为 `#F4F0FF`、Figma 为 `#FFFBEA`；接受 HTML 后 Figma 稳定为 `#F4F0FF`，撤销后稳定恢复 `#FFFBEA`，共同 baseline 恢复且同一字段冲突重新打开。
- 现场发现并修复工作区身份确认的重复 hello 回路；修复后一次冲突解决只产生一次页面导入和一次结果回执，等待后不再覆盖撤销结果。
- macOS 本地强杀矩阵已覆盖 daemon PID 重建与 stale lease 立即接管、半提交多文件事务自动回滚、用户外部编辑保护、死亡 staging 清理，以及 protocol 16 accepted/completed 两处恢复；恢复后 socket 与 secret 均保持唯一。
- 真实 protocol 16 创建项目使用 Figma `Frame 38`：生成项目 `/tmp/cdb-protocol15-create-workspace-20260818115650/Frame 38`，项目键 `36ed14fba486c16222eb2c72`、页面 `offer-1787025515602-14a3ff019888f8`、根 `700:204` 和 6 个节点映射均落盘。
- 同一 Frame 的最终关联更新 offer `offer-1787047321320-203b30994978c8` 为 `completed`；source hash `8d4fa97470be80f31620bdfd8fbe6459973cc3f2762d7b1a1b7a20916ec1d60f`，Page IR hash `73a2845a99f2455949287f79f67f8c8481c3c079635961170c074ceff9e415e8`，6 个映射均非空。该次为幂等无文件变化更新，Figma 显示“已同步”，后台 `syncState: synced`、`unsentChanges: false`。

## 发布门禁

1. 运行仓库校验和完整 Node 测试，记录通过/失败/平台跳过数量。
2. 运行插件 cachebuster、结构校验、安装器 `--check-only` 和真实安装。
3. 完全退出并重新打开 Codex，在新任务确认加载的是精确新缓存。
4. 关闭并重新运行 Figma 开发插件，确认只有一个客户端、项目键正确、无旧服务串线。
5. 按[桌面验收清单](figma-smoke-test.md)完成 CDB→Figma、Figma→CDB、重连、冲突、失败重试和 Undo。
6. Windows 真实桌面验收和受控视觉失败人工交互证据未完成前，只能称 0.9 开发候选。

## 相关文档

- [安装与快速上手](installation.zh-CN.md)
- [Codex/Figma 桌面验收](figma-smoke-test.md)
- [2026-08-31 Windows 开发与验收交接](handoff-2026-08-31-windows.zh-CN.md)
- [0.9 开发计划](next-version-plan-0.9.zh-CN.md)
- [Figma ↔ HTML Page IR 与共同基线计划](figma-html-page-ir-plan.zh-CN.md)
