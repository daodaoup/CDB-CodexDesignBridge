# Codex Design Bridge 0.4.2

完整版本：`0.4.2+codex.20260731071605`

## 修复内容

0.4.1 已能在 Figma ChangeSet 中识别 Frame 描边变化，但快速写回没有把 `stroke` 转换为 CSS `border`，因此删除外框会被标记为 `unsupported_property`，页面预览不会变化。

0.4.2 增加确定性 Frame 描边写回：

- 删除描边写入 `border: 0`，可覆盖源码中的整圈边框或 `border-top`/`border-bottom`。
- 新增描边或修改颜色写入完整的实线 `border`，同时携带当前 Figma 描边宽度。
- 修改描边粗细写入 `border-width`。
- 支持已映射的 Frame、Component、Instance 和 Rectangle。
- SVG 内部路径描边继续作为完整 SVG 变化回写，不转换成 CSS 边框。
- Figma 本地连接协议升级到 7，旧 0.4.1 插件窗口必须关闭并重新运行。

## 当前边界

- 本轮支持统一实线描边，不处理 Figma 的逐边不同描边、虚线、描边对齐或文字轮廓。
- 普通页面结构变化仍保存为待处理差异。

## 安装

1. 完整退出 Codex/ChatGPT，包括后台进程。
2. 解压完整发布包并双击 `Install Codex Design Bridge.cmd`。
3. 重新打开 Codex，创建新任务。
4. 关闭并重新运行 Figma 开发插件，使协议 7 生效。
5. 确认工作台显示 `v0.4.2`。

## 验证

- 聚焦回归覆盖 Frame 描边删除、新增、改色和改粗。
- `npm.cmd run check`：47/47 通过。
- 插件清单校验通过；工作区、个人源码和新运行缓存的清单及七个核心文件 SHA-256 一致。
- 发布包已完成反向解压、版本、必需文件和安装器只读校验。
- 自动化不替代真实 Figma 桌面验收。
