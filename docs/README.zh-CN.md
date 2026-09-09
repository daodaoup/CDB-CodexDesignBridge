# Codex Design Bridge 文档中心

当前公开版本：`0.9.0`

当前精确构建：以 [`plugin.json`](../codex-plugin/codex-design-bridge/.codex-plugin/plugin.json) 为准

## 日常使用

| 需求 | 文档 | 内容 |
| --- | --- | --- |
| 确认现在能做什么 | [当前产品状态](product-status.zh-CN.md) | 唯一的当前能力、限制、验证结果和发布门禁事实来源。 |
| 安装、升级或恢复 | [安装与快速上手](installation.zh-CN.md) | macOS/Windows 安装、权限、Figma 插件导入和常见故障。 |
| 执行真实验收 | [Codex/Figma 桌面验收](figma-smoke-test.md) | 新任务、工作台、Figma→CDB、CDB→Figma、重连和 Undo 清单。 |

## 开发与维护

| 需求 | 文档 | 内容 |
| --- | --- | --- |
| 理解仓库 | [仓库结构](repository-layout.zh-CN.md) | Codex 插件、Figma 插件、兼容代码、测试和文档边界。 |
| 转到 Windows 继续 | [2026-08-31 Windows 交接](handoff-2026-08-31-windows.zh-CN.md) | 当前精确构建、未提交工作树风险、Windows 必做验收和证据模板。 |
| 查看 0.9 适配语义开发 | [0.9 开发计划](next-version-plan-0.9.zh-CN.md) | Responsive v2、视觉门禁、零漂移 fixture 与当前 M0/M1 实施状态。 |
| 理解 Figma ↔ HTML 互通内核 | [Page IR 与共同基线计划](figma-html-page-ir-plan.zh-CN.md) | 统一页面模型、字段归属、三方合并、冲突和分阶段完成标准。 |

## 文档职责

- “当前是否支持、验证到哪里”只在[当前产品状态](product-status.zh-CN.md)维护。
- 安装命令、权限和恢复步骤只在[安装与快速上手](installation.zh-CN.md)维护。
- 桌面验收步骤只在[Codex/Figma 桌面验收](figma-smoke-test.md)维护。
- 计划文档描述目标与尚未完成的工作，不作为“已经支持”的证据。
- 当前文档只描述 0.9 测试版；旧版本资料不作为安装、恢复或兼容依据。

## 当前结论

- CDB `0.9.0` 使用 protocol 16 与 Page IR Responsive v2；只接受当前 exact-build，不读取或迁移任何旧协议、旧 Page IR、旧缓存、旧提案或旧同步基线。
- 六个响应式宽度与冻结双页的真实 Chrome 零漂移矩阵已通过，macOS 当前候选安装、双页面 Figma Desktop 和 daemon 强杀恢复已完成。
- 当前发布阻断是 Windows 真实 Codex/Figma Desktop 联合验收与最后一轮视觉失败人工交互证据。
- Windows 接手以[2026-08-31 Windows 交接](handoff-2026-08-31-windows.zh-CN.md)为唯一执行清单；不要使用旧版本发布说明或交接文档恢复环境。
