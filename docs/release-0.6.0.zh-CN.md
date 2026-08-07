# Codex Design Bridge 0.6.0

## 版本主题

单页面无缝双向互传：用户既可以从 Codex 网页开始，也可以从现有 Figma 页面 Frame 开始。

## 核心变化

- 本地 Bridge 协议升级到 13，旧 Figma 插件窗口会明确提示版本不匹配。
- 新增 `create_figma_seed_project`，创建可接收现有 Figma 页面 Frame 的空白 CDB 项目。
- Figma 本地插件新增“用选中稿创建页面”，将一个完整 Frame 及其支持的后代事务化写入 HTML/CSS。
- 首次 Figma→Codex 生成后把新的页面哈希回传给 Figma，后续修改不会误报为过期映射。
- 当前工作区已有 `.cdb/manifest.json` 时，CDB 直接恢复工作台；没有上下文时才显示启动器。
- 启动器聚焦“从 Figma 开始”和“新建设计”；本地 HTML 上传入口从常规 UI 隐藏，底层工具保留。
- 多页面清单继续保留，工作台页面项移除入口/路由副标题。
- Frame 纯色填充改用完整 `background` 覆盖，修复原渐变仍压在 `background-color` 上的问题。
- 忽略 Figma 页面根 Frame 的画布 `x/y`，避免把画布摆放位置误写为网页布局。
- 继续把 `nodeClone`、插入、删除与重排作为结构变更处理；替换克隆未落地时不单独删除原布局。

## 当前边界

- Figma-first 入口要求选择一个完整的 Frame、Component、Instance 或 Group。
- 复用现有可序列化节点模型：Frame、文字、图片和安全 SVG；复杂组件语义、Variant、变量与原型交互不在本版本范围。
- 多页面选择保留，但批量导入、批量同步和本地项目转换继续作为后期高级能力。

## 自动化证据

- Figma-first 项目创建与预检。
- 选中 Frame 生成 `pageSeed` 差异。
- 未预先导入 Codex 页面时的本地 Bridge 快速写回。
- 首次生成后的新 source hash 确认。
- 渐变到纯色的 CSS 覆盖。
- 页面根 Frame 画布坐标过滤。
- 工作台本地上传隐藏、页面副标题移除与新入口暴露。

真实 Figma Desktop、全新 Codex 任务缓存和 macOS 仍需按发布门禁验收。
