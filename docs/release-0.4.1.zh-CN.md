# Codex Design Bridge 0.4.1

完整版本：`0.4.1+codex.20260731064553`

## 修复内容

0.4.0 中，只要一批修改里有一个已映射 SVG 无法被 Figma 导出，整批发送都会失败，并显示：

```text
Failed to export node. This node may not have any visible layers.
```

常见触发条件包括 SVG 为空、全部图层被隐藏、路径退化为不可见几何，或裁剪后没有可见内容。

0.4.1 改为逐 SVG 隔离：

- 可正常导出的文字、颜色、布局和 SVG 修改继续发送并应用。
- 无可见图层的 SVG 记录为 `svgUnavailable` 待处理差异，不再中断整批。
- 快速写回结果使用 `svg_not_exportable` 标记该项，由 Codex 后续处理。
- Figma 本地连接协议升级到 6，避免旧 0.4.0 插件窗口继续连接并复现旧问题。

## 保留能力

- 同源项目 `<img src="./graphic.svg">` 展开并写回原 SVG 文件。
- 渐变、遮罩、裁剪、本地引用、安全样式和 SVG 文字往返。
- 矢量与文字组合按一个 SVG 差异发送。
- 普通页面结构变化继续保存为待处理差异。

## 安装

1. 完整退出 Codex/ChatGPT。
2. 解压完整发布包并双击 `Install Codex Design Bridge.cmd`。
3. 重新打开 Codex，创建新任务。
4. 关闭并重新运行 Figma 开发插件，使协议 6 生效。
5. manifest 仍指向当前项目 `plugin/manifest.json` 时无需重新导入；若此前从旧发布目录导入，则重新选择新包中的 manifest。
6. 确认工作台显示 `v0.4.1`。

## 验证

- `npm.cmd run check`：46/46 通过。
- 插件清单校验通过。
- 新增回归证明单个 SVG 导出失败时，同批文字修改仍会发送，且不会产生 `plugin.error`。
- 自动化不替代真实 Figma 桌面验收。
