# Codex Design Bridge 文档导航

当前源码版本：`0.7.0`

## 我应该看哪一份

| 目标 | 文档 | 说明 |
| --- | --- | --- |
| 查看当前能力与门禁 | [当前状态](product-status.zh-CN.md) | 0.7.0 已实现范围、自动化证据、兼容边界和未完成桌面验收。 |
| 理解 0.5.2 的完整设计 | [0.5.2 更新计划](next-version-plan.zh-CN.md) | 产品状态流、manifest、职责边界、单工作台接管、实施阶段、测试矩阵、风险与 DoD。 |
| 查看候选版本变化 | [0.5.2 发布说明](release-0.5.2.zh-CN.md) | 新工具、协议 12、迁移与安全边界。 |
| 查看 0.6.0 变化 | [0.6.0 发布说明](release-0.6.0.zh-CN.md) | Figma-first、启动交互与双向同步可靠性。 |
| 查看 0.7.0 变化 | [0.7.0 发布说明](release-0.7.0.zh-CN.md) | 原子跨父级移动、真实预览验证与 Auto Layout/Flex/Grid 映射。 |
| 查看下一阶段核心升级 | [0.7 双向设计闭环升级计划](next-version-plan-0.7.zh-CN.md) | 聚焦 CDB 设计网页/App、可编辑 Figma、结构与位置回写、Auto Layout 和验证闭环。 |
| 了解仓库目录 | [GitHub 仓库结构](repository-layout.zh-CN.md) | 源码、Codex 插件、Figma 插件、测试和文档的边界。 |
| 安装或升级 | [安装与快速上手](installation.zh-CN.md) | macOS/Windows 安装、首次导入 Figma 插件、缓存核对和恢复。 |
| 做真实桌面验收 | [Figma 往返验收清单](figma-smoke-test.md) | 必须在全新 Codex 任务和真实 Figma Desktop 中执行。 |
| 接手当前版本 | [2026-08-07 开发交接](handoff-2026-08-07.zh-CN.md) | 0.7.0 GitHub 整理版、验证状态和剩余桌面门禁。 |

## 当前结论

- 0.7.0 源码已落地，用户可见版本为 `V 0.7.0`。
- 当前 CDB 项目直接恢复工作台；无上下文时启动器聚焦 Figma-first 与新建设计。
- 页面以 `.cdb/manifest.json` 为主；静态 HTML 旧项目可内存推断并显示警告。
- Figma 插件协议为 14，并兼容协议 13 客户端迁移；未知未来协议安全保留为待处理。
- 跨父级结构与位置回写、Auto Layout ↔ Flex/Grid、写回后的真实预览几何验证已进入 0.7.0。
- 自动化与 Windows `CheckOnly` 是候选证据，不等于真实桌面发布验收。
- 本地项目转换、React/Vue/Vite、ZIP、批量多页面与完整 Figma 组件语义明确延期。

## 文档事实来源

- “当前是否支持”以 [当前状态](product-status.zh-CN.md) 为准。
- 0.5.2 的启动器、manifest 和单工作台基线以 [0.5.2 更新计划](next-version-plan.zh-CN.md) 为准；0.7.0 结构/布局闭环以 [0.7 计划](next-version-plan-0.7.zh-CN.md) 为准。
- “下一阶段做什么、按什么顺序验收”以 [0.7 双向设计闭环升级计划](next-version-plan-0.7.zh-CN.md) 为准。
- 安装操作只在 [安装与快速上手](installation.zh-CN.md) 维护。
- 真实验收步骤只在 [Figma 往返验收清单](figma-smoke-test.md) 维护。
- 已发布版本的历史事实保留在 `release-*.zh-CN.md`，不随新版反向改写。

## 历史发布

- [0.7.0](release-0.7.0.zh-CN.md)
- [0.6.0](release-0.6.0.zh-CN.md)
- [0.5.2](release-0.5.2.zh-CN.md)
- [0.5.1](release-0.5.1.zh-CN.md)
- [0.5.0](release-0.5.0.zh-CN.md)
- [0.4.3](release-0.4.3.zh-CN.md)
- [0.4.2](release-0.4.2.zh-CN.md)
- [0.4.1](release-0.4.1.zh-CN.md)
- [0.4.0](release-0.4.0.zh-CN.md)
- [0.3.1](release-0.3.1.zh-CN.md)
