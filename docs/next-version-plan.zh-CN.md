# CDB 0.5.2 更新计划

更新日期：2026-08-06  
规划基线：`0.5.1+codex.0806-4`  
目标正式版本：`0.5.2`

## 1. 版本结论

0.5.2 的目标不是扩大可导入技术栈，而是把 CDB 的启动、项目准备、页面识别、发送前预检、Figma 页面同步和单工作台生命周期统一成一条确定、可恢复、可验收的链路。

本版必须做到：

- 只发送 `@CDB` 时打开不绑定项目的空启动器；不扫描工作区、不创建草稿、不启动预览、不占用 Figma Bridge 或活动工作台 lease。
- `@CDB 打开项目` 只在用户表达了打开意图后解析当前项目、附件或明确路径；无可用来源时回到启动器。
- `@CDB 新建设计：<描述>` 直接生成符合 CDB 约束的静态 HTML 项目并打开；没有描述时由启动器表单收集描述。
- 所有来源在进入真实工作台前经过同一预检；页面由 `.cdb/manifest.json` 优先定义，CSS、JS、图片、SVG 和字体只能作为依赖，不能成为页面。
- 一个 Codex 用户配置下同时最多有一个占用预览和本地 Figma Bridge 的真实 CDB 工作台；启动器不参与竞争。
- Figma 插件提供轻量的 CDB 页面列表和同步状态，不演变成源码文件管理器。
- 用户可见版本只显示 `V 0.5.2`；内部构建可使用 `0.5.2+codex.MMDD-N` 短后缀，并在诊断信息中保留完整身份。

当前实现候选为 `0.5.2+codex.20260806060812`；工作台从完整构建号提取正式版本，界面只显示 `V 0.5.2`。

## 1.1 实施状态（2026-08-06）

本计划的 P0 源码已经落地，当前状态是“自动化可测、真实桌面待验收”，不是正式发布完成：

- 已实现不绑定项目、不启动预览、不占用 Figma Bridge/lease 的 `open_design_launcher`。
- 已实现显式路径、附件路径、当前工作区的有界来源解析，以及无来源回到启动器。
- 已实现零依赖 CDB 原生脚手架、`.cdb/manifest.json` 页面模型、统一预检和绑定报告哈希的事务化安全修复。
- 已实现 manifest 页面选择，移除运行时添加/重命名假页面；依赖文件不进入页面列表；导入静态 HTML 时可把一一对应的 `data-screen` / `data-target` Tab 展开为同入口可捕获状态。
- 已实现跨进程 lease、2 秒 heartbeat、8 秒 TTL、loopback control endpoint、干净接管和未发送 Figma 修改确认。
- 已实现 Figma 插件“CDB 页面”列表、六种同步状态及定位/导入/更新动作；未加入源码文件管理功能。
- 已纳入缩放、8px 外圆角、关闭当前任务和移除“添加页面”的工作台基线。
- 已补脚手架、预检、失效修复计划、页面模型、启动器、协议 12、页面目录和接管专项测试。

仍未完成的 P0 发布门禁：当前精确构建的个人插件安装/缓存核对、新 Codex 任务中的 Apps UI 挂载、真实 Figma Desktop 页面列表与往返、Windows 缓存一致性截图，以及 macOS 验收。

## 2. 成功标准与非目标

### 2.1 0.5.2 成功标准

用户从任一入口选择来源后，都得到同一份项目描述、页面清单和预检报告；只有报告没有阻断错误，真实工作台才启动预览、获取 lease 并连接 Figma。源码、Codex 插件缓存、MCP Server、Apps UI 和 Figma 插件协议身份一致，真实 Windows Codex/Figma 桌面往返通过。

### 2.2 明确非目标

以下内容不进入 0.5.2，也不得作为完成当前计划的隐含依赖：

- React、Vue、Vite 或其他需要安装依赖、运行构建命令、解析组件语义的项目支持。
- ZIP 导入。
- 100 MB 项目、分块上传、断点续传或大文件传输协议。
- 完整的 Figma → HTML 设计模型、组件/Variant/变量/原型语义或从任意 Figma 文件生成生产项目。
- 跨父容器移动、动态模板、条件渲染、循环列表和语义不明确的业务代码重写。
- 官方 Figma MCP 作为本地 Bridge 的备用通道。
- 工作台内嵌可交互 HTML 实时预览；0.5.2 继续使用静态截图预览，并保留右上角 HTML 外部预览入口。

## 3. 版本范围

### 3.1 P0：0.5.2 发布门禁

1. 三种调用意图和不绑定项目的启动器。
2. CDB 原生静态项目脚手架与安全约束。
3. HTML 文件/文件夹拖入、选择项目和新建设计入口。
4. 统一预检、四级结果、确定性安全自动修复及事务回滚。
5. `.cdb/manifest.json` 优先的页面模型，明确页面与依赖的区别。
6. 工作台动态页面清单以及 Figma 插件中的轻量 CDB 页面列表、六种同步状态和四个页面动作。
7. 跨进程 lease、heartbeat、control endpoint、旧工作台优雅接管和崩溃恢复。
8. 视图缩放控件、8px 外圆角、移除“添加页面”、关闭当前任务按钮等已确认工作台变更。
9. 版本、安装、缓存和协议身份一致性；真实 Codex Apps UI 与 Figma Desktop 验收。
10. 继承 0.5.1 的事务写回、安全 Undo、SVG 安全边界和未完成真实桌面门禁，不产生能力回退。

### 3.2 P1：可随 0.5.2 交付，但不阻塞正式版

- 预检问题的文件定位、按页面筛选和更完整的设计师语言说明。
- 最近一次事务 ID、修改文件、Undo 冲突文件和恢复建议的诊断面板。
- 对缺少 manifest 的既有项目提供“保存推断清单”操作；P0 只要求内存推断可用且给出警告。
- Figma 页面列表的状态筛选、失败详情和批量操作进度；P0 已包含状态展示和规定动作本身。
- 重启后恢复上次选中页面和缩放比例；不得恢复过期进程、端口、令牌或 lease。

P1 未完成时，界面应隐藏对应入口，而不是放置不可用按钮。

### 3.3 延期到 0.5.3

- 最近项目、收藏、重命名、归档和明确的复制模式/链接模式管理。
- 更丰富的导入历史、发送历史、缩略图和问题趋势。
- 同一静态项目的高级路由发现助手；0.5.2 只消费 manifest 中的路由、明确 HTML 入口或导入期可证明安全的有限 Tab 状态，不遍历任意交互。
- 待处理 Figma 差异的高级比较与分组体验。

### 3.4 延期到 0.6.x

- React/Vue/Vite 等框架和开发服务器生命周期。
- ZIP、100 MB 分块上传、断点续传和超大素材项目。
- 完整 Figma → HTML/CSS 生成和中立 CDB Design Model。
- 组件、Variant、变量、原型、动画、高级约束和复杂跨容器结构往返。
- 工作台内嵌实时 HTML 预览：固定 loopback 来源网关、沙箱 iframe、失败截图降级及真实 Codex Desktop 安全验收。

## 4. 产品交互与状态流

### 4.1 入口 A：只发送 `@CDB`

```text
invoked
  → launcher_opening
  → launcher_ready(project = null, lease = none, bridge = stopped)
```

要求：

- 不遍历当前目录，不寻找 `package.json`、HTML 或旧 CDB 状态。
- 不写入文件，不创建 `design-draft` 或假页面。
- 不启动 preview server、页面捕获器或 Figma Bridge。
- 不创建或刷新活动工作台 lease。
- 启动器提供“拖入 HTML/文件夹”“选择项目”“新建设计”三个入口。

验收：在含有多个前端项目和旧 `.figma-sync` 状态的工作区中连续调用 5 次，目录内容、进程、监听端口、Figma 连接和活动 lease 均不变化。

### 4.2 入口 B：`@CDB 打开项目`

```text
open_intent
  → resolve_source
  → source_found
  → preflight
  → ready_to_takeover
  → acquire_or_handoff_lease
  → workspace_ready
```

来源优先级固定为：

1. 用户消息中的明确绝对路径。
2. 当前消息附带的文件夹或 HTML 文件集合。
3. 当前 Codex 任务明确打开的工作区；仅在此意图下进行有界检测。
4. 无可用来源时回到启动器，不创建假项目。

“有界检测”只检查工作区根和有限的约定入口：`.cdb/manifest.json`、`index.html` 及用户明确选择的目录；0.5.2 不做无界递归项目搜索。

### 4.3 入口 C：`@CDB 新建设计：<描述>`

```text
create_intent(description present)
  → create_cdb_scaffold
  → preflight
  → ready_to_takeover
  → acquire_or_handoff_lease
  → workspace_ready
```

- 描述存在时不追问框架、端口、包管理器、项目名或页面数量。
- 默认生成依赖为零的静态 HTML/CSS；只有描述明确需要交互时才增加最小本地 JavaScript。
- 名称和稳定 ID 按确定性规则生成；名称冲突时使用安全后缀，不覆盖现有目录。
- 描述缺失时进入启动器的新建设计表单。表单提交使用现有 `sendFollowUpMessage` 把规范化意图交回当前 Codex 任务，不另开任务。

### 4.4 启动器内的来源操作

| 操作 | 结果 | 失败时 |
| --- | --- | --- |
| 拖入单个 HTML | HTML 作为候选入口，同级显式拖入资源作为依赖 | 保留启动器，展示缺失资源或路径问题 |
| 拖入文件夹 | 保留相对目录，建立候选项目描述 | 超过现有 500 文件/24 MB 限制时阻断，不建议 ZIP 或分块 |
| 选择项目 | 授权并解析用户选择的本地目录 | 目录不可读或无入口时回到启动器 |
| 新建设计 | 有描述则交给当前任务生成脚手架 | 无描述不提交；表单内提示补充目标 |

拖入和选择只建立候选来源；预检通过且用户进入真实工作台之前，不获取活动 lease，也不关闭旧工作台。

### 4.5 工作台主要状态

```text
launcher_ready
candidate_resolving
preflight_running
preflight_blocked
ready_to_takeover
handoff_confirmation_required
workspace_starting
workspace_ready
workspace_degraded
ending
ended
```

状态必须能区分：启动器已挂载、预览已启动、Apps UI 已挂载、lease 已持有、Figma 已连接。不得再用“localhost 可访问”代替“工作台成功”。

## 5. CDB 原生项目脚手架

0.5.2 默认结构：

```text
project/
├─ index.html
├─ styles.css
├─ assets/
├─ AGENTS.md
└─ .cdb/
   └─ manifest.json
```

约束：

- `index.html` 中恰好一个捕获根，默认使用 `<main data-codex-root data-codex-id="page-root">`。
- 捕获根覆盖完整目标页面；导航、主要内容和页脚不得散落在根之外。
- 所有需要在 Figma 编辑或回写的元素有稳定且项目内唯一的 `data-codex-id`。
- ID 使用语义化小写短横线名称；已经同步的 ID 不因文案、顺序或样式改变而重建。
- 本地资源放入 `assets/`，使用相对 URL；不把 `data:`、`blob:`、临时签名地址或跨域资源当作稳定项目资产。
- 内联 SVG 只允许安全图形、渐变、遮罩、裁剪和本地片段引用；拒绝脚本、事件处理器、外部资源、嵌入远程图片和超限内容。
- 关键可编辑节点必须存在于初始 HTML；运行时才创建、替换或随机化的 DOM 不进入 0.5.2 自动映射。
- `AGENTS.md` 记录上述编辑约束、唯一捕获根、ID 稳定性、资源安全和“不要静默重写动态业务逻辑”。

脚手架只是 CDB 自建项目的默认值；导入既有静态 HTML 时不强制重排文件，只要求预检合同成立。

## 6. 统一预检

### 6.1 调用时机

以下来源必须进入同一个 `preflight_project` 服务，不允许各入口维护不同规则：

- 明确路径或当前工作区打开的项目。
- 启动器拖入的 HTML/文件夹。
- CDB 新建脚手架。
- 工作台重新发送、更新全部或源码发生变化后的再次检查。

### 6.2 检查项

| 检查域 | P0 规则 | 典型结果 |
| --- | --- | --- |
| 入口与根节点 | 每页有可访问入口和恰好一个覆盖完整页面的捕获根 | 无根可安全修复；多根阻断 |
| 稳定 ID | 可编辑节点 ID 存在、唯一、稳定，捕获根必须有 ID | 缺失可修复；重复或已同步映射变化阻断 |
| 资源 | 相对资源可读，路径不越界，SVG 安全 | 缺失阻断；未使用资源警告 |
| 跨域 | 字体、图片、CSS、SVG 的来源可捕获且可复现 | 不可抓取或临时 URL 阻断；明确允许但不可编辑时警告 |
| 运行时 DOM | 首屏关键节点不是只在运行时创建或随机替换 | 影响捕获时阻断；非关键动态内容警告 |
| 可编辑层 | 估算可映射层数量并标记过少/为零 | 零层阻断；异常偏少警告 |
| 捕获完整性 | 检测空白、主要区域位于根外、只捕获局部 | 空白/部分捕获阻断 |
| 多页面/路由/Tab | 页面来自 manifest；入口、路由或有限静态 Tab 状态唯一且可达 | 重复/不可达阻断；推断页面警告；任意交互不自动展开 |

### 6.3 四类结果

| 级别 | 含义 | 是否允许进入真实工作台 |
| --- | --- | --- |
| `pass` | 合同成立，无需操作 | 是 |
| `warning` | 可预览或发送，但存在保真度/可编辑性风险 | 是，页面显示警告 |
| `safe_fix` | 可用确定性变更修复，必须先展示计划 | 应用成功后重新预检 |
| `blocker` | 可能空白、越界、破坏映射或结果不可复现 | 否 |

`safe_fix` 不是“忽略后继续”。它必须生成文件级补丁计划，经用户从启动器/工作台触发后进入现有多文件事务；任一写入失败完整回滚并保留原报告。

### 6.4 允许的安全自动修复

- 在唯一、静态且边界明确的页面容器上补一个捕获根。
- 在首次同步前，为静态可编辑节点生成缺失 ID。
- 在首次同步前，对重复 ID 的后续节点生成新 ID，并展示映射差异。
- 为缺少 manifest 的静态 HTML 项目生成候选 manifest；P0 默认只在内存使用，用户选择保存时才写盘。
- 规范化项目内、无越界的相对路径。

以下情况不得自动修复：已有 Figma 映射后的 ID 变化、多捕获根取舍、运行时 DOM 重构、跨域资源下载、业务路由生成、危险 SVG 清洗或删除业务内容。

## 7. 页面模型与 manifest

### 7.1 页面和依赖的严格定义

- 页面：`.cdb/manifest.json` 中的 `pages[]` 条目，对应 HTML 入口、可明确访问的本地路由，或同一入口中可确定激活的有限静态 Tab 状态。
- 依赖：CSS、JavaScript、图片、SVG、字体、JSON 和其他被页面引用的资源。
- 依赖永远不显示为页面列表项。
- 同一 HTML 入口可在 manifest 中声明多个明确路由。导入器仅在 `[data-screen="id"]` 与 `[data-target="id"]` 至少形成两个一一对应项时自动生成 Tab 状态；捕获前只点击声明的目标 Tab，并确认对应 Screen 存在。
- 0.5.2 不自动推断框架路由，不遍历任意按钮、表单、播放器或业务流程；没有明确 Tab 触发器的 Player、弹窗等仍作为页面内交互状态。
- 缺少 manifest 时，只把用户选择的 HTML 和有限规则发现的 HTML 当作候选页面，并报告 `manifest_missing` 警告。

### 7.2 `.cdb/manifest.json` 示例

```json
{
  "schemaVersion": 1,
  "projectId": "sonder-music",
  "name": "Sonder Music",
  "source": {
    "kind": "cdb-native",
    "root": "."
  },
  "entry": "index.html",
  "pages": [
    {
      "id": "home",
      "name": "Home",
      "entry": "index.html",
      "route": "/",
      "captureRoot": "[data-codex-root]",
      "viewport": { "width": 1440, "height": 900 }
    },
    {
      "id": "discover",
      "name": "Discover",
      "entry": "index.html",
      "route": "/?__cdb_state=discover",
      "captureState": {
        "kind": "tab",
        "target": "discover"
      },
      "captureRoot": "[data-codex-root]",
      "viewport": { "width": 1440, "height": 900 }
    }
  ],
  "assets": {
    "roots": ["assets"],
    "allowRemote": false
  },
  "mapping": {
    "attribute": "data-codex-id",
    "requireUnique": true
  },
  "runtime": {
    "dom": "static",
    "spa": false
  }
}
```

规则：

- 路径必须相对项目根，禁止绝对路径和 `..` 越界。
- `projectId`、`pages[].id` 在项目生命周期内稳定；显示名可修改。
- `pages[].entry` 必须是 HTML；`route` 必须在本地预览中可达。
- `captureState` 仅允许 `{ "kind": "tab", "target": "..." }`；目标必须同时匹配页面中的 `data-target` 与 `data-screen`。默认状态可省略该字段。
- manifest 不保存端口、进程 ID、lease、Token、Figma 文件 URL 或机器专属绝对路径。
- 未识别字段应忽略并保留，`schemaVersion` 不支持时阻断并给出升级说明。

### 7.3 核心运行时数据

```ts
type ProjectDescriptor = {
  projectKey: string;          // 规范化根路径的本机哈希，不写入 manifest
  rootDir: string;
  sourceKind: "cdb-native" | "selected-folder" | "imported-html";
  manifest: CdbManifest;
  manifestOrigin: "file" | "inferred";
};

type PreflightIssue = {
  code: string;
  level: "warning" | "safe_fix" | "blocker";
  pageId?: string;
  file?: string;
  message: string;
  fixId?: string;
};

type PreflightReport = {
  reportId: string;
  projectKey: string;
  sourceHash: string;
  status: "pass" | "warning" | "safe_fix" | "blocker";
  pageCount: number;
  dependencyCount: number;
  estimatedEditableLayers: number;
  issues: PreflightIssue[];
};

type PageSyncState =
  | "not_imported"
  | "synced"
  | "source_changed"
  | "figma_changed"
  | "conflict"
  | "failed";
```

## 8. 系统职责与 MCP/API 边界

### 8.1 启动技能

- 只解析 `launcher`、`open`、`create` 三类意图。
- 裸 `@CDB` 不扫描项目。
- `open` 才调用来源解析；`create` 有描述时直接创建，无描述时打开启动器。
- 不把 localhost、外部浏览器或已存在旧进程当作工作台成功。

### 8.2 MCP 工具与本地服务

建议在不破坏现有工具的前提下形成以下合同：

| 工具/API | 0.5.2 职责 |
| --- | --- |
| `open_design_launcher`（新增） | 打开 `project = null` 的 Apps UI；不得启动预览/Bridge/lease |
| `resolve_design_source`（新增） | 仅按明确 open 意图解析路径、附件或当前工作区 |
| `create_design_project`（新增） | 生成原生脚手架，返回候选项目，不直接接管旧工作台 |
| `preflight_design_project`（新增） | 返回统一预检报告和候选页面/依赖统计 |
| `apply_design_preflight_fixes`（新增） | 按 `reportId + fixIds + sourceHash` 事务化应用安全修复 |
| `open_design_workspace`（保留） | 仅接收已预检的真实项目；准备完成后执行 lease 接管和预览启动 |
| `import_html_project`（调整） | 改为 staging → 预检 → commit；保留 500 文件/24 MB 上限 |
| `get_design_workspace_state`（保留） | 返回 launcher/workspace、mount、lease、preflight、page sync 状态 |
| `send_preview_to_local_figma`（保留） | 只接受 manifest 页面 ID，不接受资源文件路径 |
| `capture_local_figma_changes`（保留） | 捕获本地 Figma 变更并更新页面同步状态 |
| `end_design_session`（保留） | 关闭当前真实任务；仅未发送 Figma 修改需要确认 |
| `manage_design_workspace_page`（弃用 add） | UI 移除“添加页面”；0.5.2 只保留选择，页面增删由源码/manifest 管理 |

工具返回稳定机器字段和设计师可读消息；路径、原因码和内部构建号只在诊断区域显示。所有写操作继续使用 0.5.1 的事务、源哈希和回滚语义。

### 8.3 Apps UI / 工作台

- 启动器负责来源选择、新建设计表单、预检结果和安全修复确认。
- 真实工作台负责预览、缩放、页面选择、发送、接收、Undo、状态和关闭当前任务。
- 使用现有 `window.openai.sendFollowUpMessage` 把新建设计或需要 Codex 处理的预检/差异交回当前任务。
- UI 不直接递归扫描磁盘，不自行决定页面，不持久化端口/令牌/lease。

### 8.4 Figma 插件

新增轻量“CDB 页面”入口，数据来自本地 Bridge 的项目页面清单和同步摘要。

每项显示：页面名、入口或路由，以及以下状态之一：

| 状态 | 含义 |
| --- | --- |
| 未导入 | manifest 有页面，Figma 中没有对应顶层 Frame |
| 已同步 | 源码和 Figma 都等于最近同步基线 |
| 源码更新 | 源码页哈希变化，Figma 未变化 |
| Figma 修改 | Figma 页面有未发送修改，源码未变化 |
| 冲突 | 两侧相对同一基线都变化 |
| 失败 | 最近导入、更新或捕获失败，保留可重试原因 |

动作：

- `定位 Frame`：选择并滚动到当前页面对应的顶层 Frame。
- `导入当前`：导入当前列表项。
- `导入选中`：导入用户在 CDB 页面列表中勾选的页面。
- `更新全部`：仅处理需要导入或存在源码更新的页面；冲突和 Figma 未发送修改不得被覆盖。

Figma 插件不得展示 CSS/JS/资源文件树，不编辑 manifest，不执行项目扫描，也不管理源码文件。

## 9. 单工作台接管机制

### 9.1 所有权范围

同一 Codex 用户配置下只允许一个真实 CDB 工作台持有全局活动 lease。启动器实例可同时存在，因为它们没有项目、预览或 Bridge。

```ts
type WorkspaceLease = {
  schemaVersion: 1;
  leaseId: string;
  ownerPid: number;
  taskIdHash: string;
  projectKey: string;
  state: "starting" | "active" | "handoff" | "closing";
  controlEndpoint: string;
  controlSecretRef: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
};
```

lease 不保存原始任务文本、完整项目路径或连接令牌。控制密钥单独保存在仅当前用户可读的临时文件，不进入日志、文档或项目目录。

### 9.2 心跳和过期

- 活动工作台每 2 秒更新 heartbeat。
- 连续 8 秒无心跳视为候选过期；接管前还必须检查 owner PID 和 control endpoint，避免仅因桌面卡顿误杀。
- lease 的创建、续期和替换使用原子文件锁或等价的 compare-and-swap；不能“先删后写”。
- PID 复用时以 `leaseId + control secret + endpoint health` 为准，不能只比较 PID。

### 9.3 control endpoint

仅绑定 loopback，至少提供：

- `GET /health`：返回 lease ID、状态、项目键、是否有未发送 Figma 修改。
- `POST /handoff/prepare`：旧工作台进入 handoff，停止接受新发送动作并报告是否需要确认。
- `POST /handoff/commit`：新工作台已准备好，旧工作台优雅释放预览、Bridge、轮询和 lease。
- `POST /handoff/cancel`：新项目准备失败时恢复旧工作台。
- `POST /shutdown`：显式关闭当前任务；携带 force 时仍需由上层证明用户已确认未发送修改。

### 9.4 接管顺序

```text
候选项目解析完成
  → 预检无 blocker
  → 新工作台资源准备完成（尚未启动 Bridge）
  → 查询现有 lease
  → 无 owner：原子获取 lease
  → 有 owner：handoff/prepare
       → 无未发送修改：旧工作台 5 秒内优雅关闭 → 原子转移 lease
       → 有未发送修改：提示用户
            → 返回旧任务发送修改 / 取消接管
            → 用户明确“仍要关闭”后强制接管
  → 新工作台启动 preview 和 Bridge
```

只有 `unsentFigmaChanges = true` 才允许出现确认框。源码未保存、预检警告、旧页面正在显示或普通轮询都不能触发额外确认。

新项目预检失败、用户取消或接管超时应恢复旧工作台；不能先关闭旧任务再发现新项目不可用。崩溃留下的过期 lease 可在健康检查失败后回收，并清理孤立 preview/Bridge，但不得删除项目文件或事务记录。

## 10. 工作台 UI 基线

0.5.2 实现以已确认的设计变更为基线：

- 增加视图缩放/适配控件，并显示当前缩放比例。
- 工作台最外层使用 8px 圆角；内嵌边界和点击区域仍需完整。
- 移除“添加页面”按钮和对应弹窗；页面来自 manifest/源码。
- 顶部提供“关闭当前任务”按钮；无未发送 Figma 修改时直接关闭，有未发送修改时显示唯一确认。
- 保留发送当前、导入选中/发送选中和更新全部所需动作，但不恢复源码文件树。
- 页脚只显示 `V 0.5.2`；完整内部版本放在可复制的诊断信息中。

`design-draft/design.html` 是视觉参考；真正实现位置仍是插件的 `mcp/workspace.html` 和 Figma 插件 UI，不在演示页上实现业务逻辑。

### 10.1 后期规划：工作台内嵌实时 HTML（0.8.x）

调研结论：对 CDB 原生 `HTML + CSS + JS + assets` 项目可行，工作量中等；不进入 0.7.0 发布门禁。当前工作台已经包含预览 `<iframe>`、加载超时和截图降级代码，但 `canUseLivePreview()` 只允许 `#demo`，真实 Codex Apps UI 固定使用截图。静态预览服务当前使用随机 loopback 端口，资源 CSP 则声明 `http://127.0.0.1:*` / `http://localhost:*`。OpenAI 与 MCP Apps 文档要求嵌套 iframe 通过 `frameDomains` 显式放行来源，并建议使用明确且尽可能窄的来源白名单，因此不得把动态端口通配作为正式能力的兼容性前提。

官方依据：

- [OpenAI Apps UI CSP](https://developers.openai.com/plugins/build/chatgpt-ui#content-security-policy-csp)：嵌套 frame 默认阻断，必须声明具体 `frameDomains`。
- [OpenAI iframe 指南](https://developers.openai.com/plugins/app-guidelines#iframes-and-embedded-pages)：iframe 仅适用于嵌入体验确有必要的场景，开发模式可验证，但生产分发需额外审查。
- [MCP Apps 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)：宿主必须按 `ui.csp.frameDomains` 生成 `frame-src`，未声明时为 `none`。

推荐结构：

```text
Codex Apps 工作台
  -> iframe: http://127.0.0.1:<固定 CDB 端口>/preview/<随机会话能力路径>/<页面>
  -> CDB Preview Gateway
  -> 原生静态项目服务；后续再代理受支持的项目开发服务器
```

系统边界：

- Preview Gateway 只监听 loopback，可复用 CDB 固定端口但必须使用独立路径命名空间；用不可预测的会话能力路径限制其他本机页面读取，不依赖可枚举项目路径或普通 query token。
- Apps UI 的 `frameDomains` 只声明固定 loopback origin；项目真实随机端口不直接暴露给工作台 iframe。
- iframe 保留 `sandbox`，第一阶段只开放脚本、表单和同源资源所需最小权限；弹窗、下载、剪贴板、摄像头、麦克风和跨源权限默认关闭。
- 只有真实项目完成统一预检并取得工作台 lease 后才启动网关；裸启动器不得启动预览或增加端口占用。
- 实时 HTML 只负责显示和交互，不作为 Figma 捕获或可编辑映射的数据源；HTML → Figma 仍使用独立浏览器捕获和 Page Manifest，避免工作台跨源读取 DOM。
- 页面入口、路由和有限 Tab 状态继续来自 `.cdb/manifest.json`；CSS、JS、图片和字体仍是依赖，不成为页面。
- iframe 加载超时、项目自身 `X-Frame-Options` / `frame-ancestors` 阻断、服务崩溃或路由不可达时，自动降级到现有静态截图，并在 UI 明确显示降级原因和“重试实时预览”。

明确不采用：

- 不直接加载 `file://`：本地文件权限、相对资源、模块脚本和跨域行为不可稳定控制。
- 不用 `srcdoc` 拼接完整项目：无法可靠保持多文件资源、路由、模块脚本和运行时行为。
- 不把项目 HTML/CSS/JS 注入工作台 DOM：会污染工作台样式与事件边界，并扩大脚本权限。
- 不在正式能力中依赖 `http://localhost:*` 动态端口通配；可以保留为本地 POC 对照，但不作为验收标准。

分阶段实施：

1. POC：固定来源 Preview Gateway、单个静态 HTML 页面、精确 `frameDomains`、iframe `load` 握手和 8 秒截图降级；只在开发开关下启用。
2. 原生项目产品化：manifest 多页面/路由、本地 CSS/JS/图片/SVG/字体、会话能力路径、预检联动、刷新和实时/截图切换。
3. 真实桌面门禁：Windows Codex Desktop 中连续打开/关闭 10 次无端口泄漏；页面交互、缩放、页面切换、lease 接管、失败恢复和 Figma 往返不回退。
4. 后续扩展：是否支持 React/Vue/Vite 开发服务器单独立项；不得成为原生 HTML 实时预览的前置依赖。

独立完成定义：

- 真实 Codex Apps UI 中直接操作原生 HTML 页面；CSS、JS、本地图片、SVG、字体和 manifest 页面路由均正确。
- iframe 未就绪、超时、被策略阻断或预览进程退出时，工作台在 8 秒内回到截图且仍可发送 Figma。
- 实时预览与截图预览切换不重建 Figma 映射、不更改页面 hash、不产生第二个 workspace owner。
- 启动器、未通过预检的项目和已结束任务均没有残留 preview gateway、随机会话路径或子进程。
- 记录 CSP、sandbox、网关来源、Codex 版本、Windows 版本、页面类型、降级原因和截图；外部浏览器成功不能代替 Codex 内嵌验收。

## 11. 实施顺序、依赖和独立验收

### 阶段 0：冻结合同和测试夹具

交付：manifest schema、预检 issue code、页面同步状态、lease schema、三种调用意图的测试夹具。  
依赖：无。  
独立验收：schema 示例可解析；未知字段兼容；非法路径、未知 schemaVersion 和重复 page ID 有固定错误。

### 阶段 1：启动器与意图路由

交付：`open_design_launcher`、技能意图分流、启动器三个入口、现有 follow-up 提交。  
依赖：阶段 0 的意图与 launcher 状态。  
独立验收：裸 `@CDB` 连续 5 次无扫描/写入/进程/lease/Figma 副作用；open 无项目回到启动器；create 有描述零追问。

### 阶段 2：脚手架、manifest 和统一预检

交付：原生脚手架、来源解析、统一预检、四级结果、安全修复事务、HTML 导入 staging。  
依赖：阶段 0 schema；复用 0.5.1 事务模块。  
独立验收：单 HTML、含资源文件夹、多页面文件夹以及同入口三 Tab 分别得到正确 page/dependency 计数；三个 Tab 捕获到不同可编辑结构；阻断样例不启动预览；修复失败完整回滚。

### 阶段 3：真实工作台与单 owner 接管

交付：lease、heartbeat、control endpoint、准备后接管、崩溃恢复、关闭当前任务。  
依赖：阶段 1 launcher、阶段 2 `ready_to_takeover`。  
独立验收：两个 Codex 进程竞争时始终只有一个 preview/Bridge owner；新项目失败不影响旧任务；仅未发送 Figma 修改出现确认。

### 阶段 4：页面同步和 Figma 页面入口

交付：manifest 驱动的工作台页面列表、Figma CDB 页面列表、六状态、定位/导入当前/导入选中/更新全部。  
依赖：阶段 2 页面模型、阶段 3 单 owner。  
独立验收：CSS/JS/图片从不出现在列表；源码单边变化、Figma 单边变化、双边冲突和失败均可稳定复现；更新全部不覆盖冲突或未发送修改。

### 阶段 5：UI 收口、安装与真实桌面发布门禁

交付：缩放、8px 圆角、无添加页面、关闭按钮、版本身份、安装包和验收证据。  
依赖：阶段 1–4 完成。  
独立验收：自动化、包反向验证、Windows 干净升级、全新 Codex 任务、真实 Figma Desktop 往返全部通过。

阶段之间不允许用临时假项目、外部浏览器或手改运行缓存绕过前置条件。

## 12. 测试矩阵

### 12.1 自动化与集成

| 维度 | 必测样例 |
| --- | --- |
| 调用意图 | 裸调用、open+明确路径、open+附件、open+当前工作区、open 无项目、create 有/无描述 |
| 来源 | 原生脚手架、单 HTML、HTML+同级资源、完整文件夹、多层目录、中文名、空格、长路径 |
| 页面/依赖 | 1 页、10+ 页、同入口多明确路由、同入口 `data-screen/data-target` 三 Tab、CSS/JS/PNG/SVG/字体依赖、缺少 manifest |
| 预检 | 0/1/2 个根、重复 ID、缺失资源、跨域资源、危险 SVG、运行时 DOM、0 层、部分捕获、重复路由 |
| 安全修复 | 补根、补 ID、候选 manifest、源哈希变化拒绝、任一文件失败整批回滚 |
| 生命周期 | 无 owner、有干净 owner、有未发送修改 owner、旧 owner 拒绝、崩溃、过期 heartbeat、PID 复用 |
| 页面同步 | 未导入、已同步、源码更新、Figma 修改、冲突、失败；四个 Figma 动作 |
| 回归 | 0.5.1 多文件事务、安全 Undo、HTML/JSX/SVG 支持范围、挂载回执和协议错配 |

### 12.2 Windows 安装与缓存一致性

至少覆盖 Windows 11 x64：

1. 从 `0.5.1+codex.0806-4` 干净升级到候选 `0.5.2+codex.MMDD-N`。
2. Codex 已退出、仍有后台进程并选择 `Y`、选择取消三条安装路径。
3. 安装报告、个人插件源码、marketplace 注册、运行缓存、MCP Server 和 Apps UI 的完整内部版本及核心文件哈希一致。
4. 不手改缓存；升级后必须新建 Codex 任务。
5. 旧任务仍显示旧版本时给出明确诊断，不把磁盘新版本当作已加载。
6. UI 页脚只显示 `V 0.5.2`，诊断区域显示完整内部版本。
7. 包反向解压后再次执行只读校验，确认 launcher、preflight、lease、workspace、Figma 协议相关文件都在核心清单中。

若继续声明 macOS 支持，同一候选包必须完成 macOS `CheckOnly`、干净安装、权限、Apps UI 和 Figma 往返；否则发布说明必须明确标为未验收，而不能沿用 0.5.1 的部分证据。

### 12.3 真实 Codex/Figma 桌面验收

自动化不能替代以下证据：

1. 全新 Codex 任务裸调用，启动器内嵌挂载且没有 Figma 连接。
2. 从启动器拖入真实静态项目，查看预检并打开；`workspaceMounted: true`。
3. `@CDB 打开项目` 正确打开明确项目；无项目时返回启动器。
4. `@CDB 新建设计：...` 不追问并生成规定脚手架。
5. Figma 插件显示 CDB 页面、入口/路由/有限 Tab 状态和六种同步状态；同入口 Tab 分别成为稳定 Frame，并完成四个页面动作。
6. 在 Figma 修改已映射文字/样式，发送回源码，同一预览刷新；事务失败和 Undo 冲突仍安全。
7. 保留未发送 Figma 修改后尝试接管，确认只此时出现提示；返回继续和仍要关闭两条路径都正确。
8. 干净工作台接管在 5 秒内释放旧 preview/Bridge；重复 5 次无重复 owner、端口或 Bridge。
9. 记录插件/缓存/MCP/Apps UI/Figma 协议版本、截图、页面哈希、修改文件、耗时、lease 转移和恢复结果。

现有 [Figma 往返验收清单](figma-smoke-test.md) 仍是 0.5.1 回归基础；实施阶段必须补入上述 launcher、manifest、页面状态和接管场景后，才能作为 0.5.2 最终清单。

## 13. 兼容性、迁移和失败恢复

### 13.1 既有静态项目

- 有 `.cdb/manifest.json`：校验后直接使用。
- 无 manifest：有限发现 HTML，生成内存候选清单并显示警告；不因缺少 manifest 拒绝单页项目。
- 已有 `data-codex-id`：尽量保留；已有 Figma 映射时禁止自动重建。
- 已有 `.figma-sync` 事务：继续用于 Undo 和基线；迁移不得改写历史事务。
- 旧 `.codex/design-bridge.json` 或连接文件：只读取可迁移的非敏感项目状态；忽略旧 PID、端口、Token 和过期连接。

### 13.2 协议和工具兼容

- 内部插件 ID 保持 `codex-design-bridge`。
- 旧 Figma 插件与新本地协议不匹配时阻断写回并提示重开/升级，不静默降级。
- `open_design_workspace(projectDir)` 保留；裸启动改走新 launcher 工具，禁止用虚假 `projectDir` 兼容。
- `manage_design_workspace_page.add` 标记弃用并从 UI 移除；旧调用返回可操作说明，不写入仅存在于运行时的假页面。

### 13.3 失败恢复

- 来源解析或预检失败：停留启动器，旧工作台继续运行。
- 安全修复失败：使用事务回滚，重新计算报告，禁止使用旧 `reportId` 重试写入。
- 新预览启动失败：取消 handoff，恢复旧 owner。
- 旧 owner 无响应：heartbeat 过期且 endpoint/PID 健康检查失败后原子回收。
- Figma 断开：工作台降级但保留项目和 lease；重开插件自动重连，不要求端口/Token。
- 页面更新部分失败：逐页记录失败状态；更新全部不得把成功页回滚为未导入，也不得把失败页标记为已同步。
- 未发送 Figma 修改：关闭/接管前保留快照；用户取消时不停止任何资源，强制关闭时不得报告已写回。

## 14. 主要风险与缓解

| 风险 | 影响 | 缓解/门禁 |
| --- | --- | --- |
| 裸调用仍触发技能扫描 | 意外写入、慢启动、占用连接 | launcher 独立工具；副作用测试记录文件/进程/端口/lease |
| manifest 与实际路由漂移 | 页面列表正确但捕获失败 | 每次发送前轻量预检；页面 hash 和可达性检查 |
| 自动补 ID 破坏既有映射 | Figma 层重复或写错源码 | 有同步基线时禁止自动重建；源哈希和映射校验 |
| 双 owner 竞态 | 重复 Bridge、错误 Figma 文件 | 原子 lease、短 heartbeat、prepare/commit 两阶段接管 |
| Windows PID 复用/休眠 | 误判旧任务存活或死亡 | leaseId、secret、endpoint、PID 四项联合检查 |
| 未发送修改被接管吞掉 | 设计丢失 | 仅此状态确认；快照和强制关闭结果明确 |
| 依赖误列为页面 | Figma 页面噪声、批量失败 | manifest schema 限制 entry 为 HTML；自动化覆盖所有资源类型 |
| 版本/缓存错配 | 测到旧逻辑却误报成功 | 完整内部版本+核心哈希+全新任务；UI 仅简洁展示正式版本 |
| 0.5.1 桌面门禁仍未闭环 | 新版建立在未验证链路上 | 阶段 5 同时执行 0.5.1 回归，不引用旧自动化作为桌面证据 |

## 15. Definition of Done

只有同时满足以下条件，0.5.2 才算完成：

- 裸 `@CDB` 稳定打开无项目启动器，零扫描、零写入、零 preview、零 Bridge、零 lease。
- open/create 三种入口按本文状态流工作；create 有描述不追问，无描述使用启动器表单和当前任务 follow-up。
- 原生脚手架包含 `index.html`、`styles.css`、`assets/`、`AGENTS.md`、`.cdb/manifest.json`，并通过自身预检。
- 所有来源复用同一预检，实现规定检查、四级结果和事务化安全修复。
- manifest 是页面清单主要来源；资源不成为页面；缺少 manifest 的静态项目有兼容路径。
- 工作台和 Figma 插件显示一致页面与同步状态，四个 Figma 页面动作通过真实桌面验收。
- 任意时刻只有一个真实 owner；准备后接管、heartbeat、崩溃恢复和仅未发送修改确认全部通过。
- 工作台包含缩放、8px 外圆角、关闭当前任务且没有“添加页面”；用户可见版本为 `V 0.5.2`。
- 0.5.1 的事务、Undo、SVG 和挂载能力回归通过，无安全边界放宽。
- Windows 安装/升级、包反向校验、源码/缓存/MCP/Apps UI/Figma 协议版本与哈希一致；使用全新 Codex 任务验证。
- 真实 Codex Apps UI + Figma Desktop 证据完整，外部浏览器和自动化结果未被当作替代证据。
- 发布说明、安装说明、产品状态、Figma 验收清单和文档导航在候选冻结时同步到 0.5.2；不存在仍指导用户“添加页面”或裸调用创建草稿的当前文档。

## 16. 与旧文档冲突或已过期内容

| 文档/内容 | 冲突或过期点 | 0.5.2 处理 |
| --- | --- | --- |
| `docs/handoff-2026-08-01.zh-CN.md` | 基线、源码路径和缓存版本属于 0.5.1 历史；MCP Apps/Figma 未验收仍有效 | 保留为历史交接；桌面门禁并入本计划阶段 5 |
| 旧 `docs/next-version-plan.zh-CN.md` | 把 0.5.2 缩为诊断/恢复，未覆盖启动器、manifest、预检和接管 | 由本文完整取代 |
| `docs/product-status.zh-CN.md`（本轮更新前） | 记录的源码版本早于 `0.5.1+codex.0806-4` | 已更新当前基线；功能现状仍按 0.5.1 候选解释 |
| `docs/release-0.5.1.zh-CN.md` | 是不可反向改写的历史发布说明，不是 0.5.2 规格 | 保留原文，只作为回归基线 |
| `docs/figma-smoke-test.md` | 仍要求发送“开始设计”、手工添加第二路由，未覆盖启动器/lease/Figma 页面状态 | 实施阶段扩展为 0.5.2 真实验收，不在规划阶段伪称已通过 |
| `design-draft/CDB_HANDOFF.md` 的导入流程 | 导入后立即切项目/启动预览会过早抢占旧连接 | 改为 staging → 统一预检 → 准备完成后接管 |
| `design-draft/CDB_HANDOFF.md` 的 ZIP、100 MB、React/Vue/Vite 计划 | 范围过早扩张 | 分别延期到 0.6.x |
| `design-draft/CDB_HANDOFF.md` 的 Figma → HTML 完整 Design Model | 不是本版目标 | 延期到 0.6.x；0.5.2 只做 HTML/路由 → Figma 页面管理 |
| `design-draft/design.html` | 已显示 `V 0.5.2` 且含部分视觉变更，但它是演示稿 | 只作为 UI 基线，不能作为实现或验收证据 |
| `docs/installation.zh-CN.md`（本轮更新前） | 描述选择插件后发送“开始设计”且引用旧内部版本 | 已改为 0.5.2 三种意图、预检、页面目录、接管和精确候选安装说明 |

本计划是 0.5.2 范围、交互和系统合同的当前事实来源。旧交接保留历史证据，但与本文冲突时不得继续指导下一版实现。
