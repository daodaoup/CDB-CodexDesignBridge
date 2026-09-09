# Figma ↔ HTML 完整互通计划：Page IR 与共同基线

更新日期：2026-08-18

状态：阶段 A、B 已落地；阶段 C、D 待继续

## 目标

CDB 不把 Figma JSON 直接翻译成 CSS，也不把浏览器 DOM 直接覆盖到 Figma。两端都先归一化为版本化的 **CDB Page IR**，再基于上一次成功同步的共同基线做三方比较。

```text
HTML + computed style ─┐
                      ├─> Page IR v1 ─> diff / merge ─> HTML transaction
Figma editable tree ──┘                  │
                                         └─────────────> Figma transaction
```

这里的“完整互通”定义为：支持范围内可编辑、可往返、可验证；支持范围外明确记录降级，不用截图或静默丢失冒充成功。像素接近、语义等价和任意前端代码可逆是三个不同指标。

## Page IR v1

Page IR 是扁平、可哈希、最多 500 节点的页面模型。每个节点包含稳定 ID、父子关系、语义和源码定位、几何、视觉、布局、文本或资源身份、Figma 节点身份和显式降级记录。

资源内容不进入共同基线；基线只保存 MIME、字节数和 SHA-256，避免重复持久化大型 base64。运行时输入仍会校验资源内容与哈希一致。

- 运行时实现：`shared/page-ir.mjs`
- JSON Schema：`shared/page-ir-v1.schema.json`
- 当前 `schemaVersion = 1`

## 字段归属

| 归属 | 典型字段 | 合并规则 |
| --- | --- | --- |
| HTML | 标签、源码定位、语义、交互、响应式提示 | HTML 单方修改可接受；Figma 单方改动视为越权 |
| Figma | Figma 节点元数据、图层名称 | Figma 单方修改可接受；HTML 单方改动视为越权 |
| Shared | 几何、显隐、视觉、布局、文字、资源 | 一侧修改接受；两侧不同修改产生冲突 |
| System | schema、稳定 ID、节点类型、资源哈希 | 任一侧直接改动都产生冲突 |

同一字段两端改成相同值可自动合并。父路径和子路径同时变化属于结构重叠，不按最后写入获胜处理。

## 共同基线

每次确认成功的同步事务写入 `.cdb/sync-baselines/<pageId>.json`。记录包括 Page IR、IR 哈希、源码哈希、Figma 根身份、事务 ID 和时间。读取时重新归一化并校验哈希；损坏或被篡改的基线会明确失败。

当前已接入：

- HTML 页面成功导入 Figma；
- Figma `pageSeed` 成功生成本地 HTML/CSS；
- protocol 15 payload 入库时生成并校验 Page IR；
- Figma 常规 ChangeSet 携带完整页面快照，Bridge 在写源码前采集当前 HTML 并执行三方合并；
- 冲突写入 `.cdb/sync-conflicts`，源码保持不变；无冲突事务完成后重新采集 HTML 回读，核对 Page IR 后才推进基线；
- 基线保存失败会把同步结果改为 pending/conflict，不再显示假成功。

## 实施阶段

### 阶段 A：统一事实层（已完成）

- Page IR v1、Schema、严格归一化和稳定哈希；
- HTML manifest 与 Figma payload 两端适配器；
- 字段归属、确定性 diff、三方 merge 和结构冲突；
- `.cdb` 共同基线原子持久化；
- 成功导入和首次 seed 的事务接线。

### 阶段 B：完整快照同步（已完成）

- Figma ChangeSet 附带完整可转换页面快照，二进制资源只在传输期存在，持久基线只保留资源哈希；
- 浏览器 capture 输出相同 Page IR；
- 每次同步先比较 `baseline / html / figma`，再生成目标端 patch；
- 冲突时零源码写入并持久化字段、归属和两端值；
- 成功后做 HTML 回读验证并推进共同基线，失败和 pending 保持旧基线。

### 阶段 C：映射与响应式

- 将 `figmaNodeId ↔ data-codex-id ↔ sourceRef` 作为持久映射表（已完成）；
- 补齐 Grid、约束、Hug/Fill、绝对定位与常见响应式断点；
- 资源按内容哈希去重，SVG 保持安全可编辑；
- 为 React/Vue 等框架增加受限适配器，不改写无法证明安全的业务结构。

### 阶段 D：冲突产品化与验收

- 工作台展示字段级冲突、两端值、归属和可选解决方案（已完成）；
- 提供接受 HTML、接受 Figma（已完成）；复制为新页面和冲突解决撤销待继续；
- 自动做结构校验、浏览器视觉回归和 Figma 回读验证；
- 建立真实 macOS/Windows Figma Desktop 往返测试矩阵。

## 完成标准

一个页面只有同时满足以下条件才显示“已同步”：

1. 输入和 Page IR 均通过版本与安全校验；
2. 三方合并没有未解决冲突；
3. HTML 或 Figma 目标事务原子提交成功；
4. 目标端回读与预期 IR 一致；
5. 共同基线成功推进；
6. 所有不支持项都有可见的降级记录。

截图只能用于视觉验收，不能作为可编辑互通的同步事实。
