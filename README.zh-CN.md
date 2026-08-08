# Codex Design Bridge（CDB）

[English](README.md) | [简体中文](README.zh-CN.md)

Codex Design Bridge（简称 CDB）把本地前端页面、Codex 和 Figma Desktop 连接成可往返的设计工作流。它可以把静态 HTML/CSS 页面发送为 Figma 中的可编辑图层，并把受支持的文字、颜色、尺寸、间距、圆角、布局和结构修改安全写回源码。

CDB 使用本机回环连接，不依赖官方 Figma MCP，也不消耗官方 Figma MCP 配额。

当前公开版本：`0.7.0`  
Codex 插件构建：`0.7.0+codex.20260808103256`

> 0.7.0 源码和自动化测试已经完成，但真实 Codex Apps UI、Figma Desktop 往返和 macOS 安装仍属于发布验收门禁。自动化通过不等于桌面链路已经完整验收。

## 主要能力

- 在 Codex 中打开或恢复 CDB 设计工作区。
- 从静态 HTML/CSS 项目生成可编辑 Figma 页面。
- 从选中的 Figma Frame 创建可交换的静态项目。
- 使用稳定 `data-codex-id` 保持源码和 Figma 图层映射。
- 支持文字、填充、描边、尺寸、透明度、圆角和常用排版属性回写。
- 支持 Auto Layout 与 CSS Flex、基础 Grid 的双向映射。
- 支持受约束的节点重排和跨父级移动，并在真实预览中验证结果。
- 支持将 CSS 边框三角形及简单 `::before` / `::after` 图标细节转换为可见的 Figma 图层。
- 多文件事务写入、安全回滚和冲突保护 Undo。

## 安装前准备

- Codex 桌面应用。
- Figma Desktop。
- Windows 10/11，或较新的 macOS。
- 若从源码开发，需要 Node.js 20 以上；推荐 Node.js 22。

安装分为两部分：先安装 Codex 插件，再把本仓库中的 Figma 开发插件导入 Figma Desktop。两部分都完成后才能使用完整往返链路。

## 获取代码

可以克隆仓库：

```bash
git clone https://github.com/daodaoup/codex-design-bridge.git
cd codex-design-bridge
```

也可以在 GitHub 页面选择 **Code → Download ZIP**，解压后再安装。请把整个目录解压出来，不要只下载单个文件。

## Windows 安装

1. 保存工作并完全退出 Codex/ChatGPT，包括后台进程。
2. 打开解压后的 CDB 根目录。
3. 双击 `Install Codex Design Bridge.vbs`。
4. 安装器会在后台等待 Codex 完全退出，然后更新个人插件源码、注册和运行缓存。
5. 等待 Windows 弹窗提示安装成功。
6. 重新打开 Codex，并新建一个任务；旧任务不会自动加载新版插件。

如需查看安装过程或诊断错误，运行：

```text
Install Codex Design Bridge.cmd
```

安装成功后，可检查个人插件目录旁的 `.codex-design-bridge-install-report.json`。正常结果应包含：

- `status` 为 `installed`；
- `hashesVerified` 为 `true`；
- `pluginListConfirmed` 为 `true`。

## macOS 安装

1. 保存工作并完全退出 Codex/ChatGPT。
2. 打开解压后的 CDB 根目录。
3. 双击 `Install Codex Design Bridge.command`。
4. 等待终端显示安装成功和报告路径。
5. 重新打开 Codex，并新建一个任务。

如果 macOS 不允许直接运行：

- 在 Finder 中按住 Control 点击 `.command` 文件，选择“打开”；或
- 在终端进入项目目录后执行：

```bash
chmod +x "./Install Codex Design Bridge.command"
chmod +x "./scripts/install-codex-design-bridge-macos.sh"
./Install\ Codex\ Design\ Bridge.command
```

不要关闭系统安全保护来运行来源不明的文件。公开发布前，macOS 仍需对相同精确版本完成安装、缓存和真实桌面验收。

## 导入 Figma 开发插件

Codex 插件安装完成后，还需要在 Figma Desktop 中做一次导入：

1. 打开 Figma Desktop。
2. 选择 **Plugins → Development → Import plugin from manifest**。
3. 选择本仓库中的 `plugin/manifest.json`。
4. 打开目标 Figma 文件。
5. 选择 **Plugins → Development → CDB**。

升级 CDB 后，如果 Figma 仍显示旧版本或协议不匹配，请关闭旧的 CDB 插件窗口，然后重新运行 Figma 中的 CDB 开发插件。manifest 路径未变化时通常不必重复导入。

## 第一次使用

在全新的 Codex 任务中调用 CDB：

```text
@CDB
```

常用方式：

```text
@CDB 打开项目
@CDB 新建设计：一个简洁的产品落地页
```

打开已有项目时，提供明确的项目目录。当前完整闭环主要面向不依赖构建步骤的静态 HTML/CSS 项目。

工作台打开后：

1. 确认 Codex 消息区域显示内嵌 CDB 工作台，而不只是外部 localhost 页面。
2. 保持 Figma Desktop 中的 CDB 开发插件开启。
3. 在 CDB 中选择页面并发送到 Figma。
4. 在 Figma 中修改受支持的属性。
5. 把修改发送回 Codex，检查源码和当前预览是否同步更新。

## 升级与常见问题

### Codex 仍然加载旧版本

完全退出 Codex/ChatGPT，重新运行安装器，然后新建任务。不要直接修改 `.codex/plugins/cache` 中的已安装缓存。

### Figma 一直等待连接

确认 Codex 中已经打开真实的 CDB 内嵌工作台；关闭并重新运行 Figma 的 CDB 开发插件。

### Figma 只收到少量元素

检查页面是否只有一个用于捕获的 `<main>`，且它包住完整页面；需要编辑和回写的元素应具有唯一、稳定的 `data-codex-id`。不要依赖 JavaScript 在运行时生成关键设计结构。

### 圆角或布局回传不正确

先确认 Codex 插件和 Figma 插件来自同一版本，并重新发送当前页面。保留页面源码、Figma 修改和工作台回执，按 [真实 Figma 往返验收清单](docs/figma-smoke-test.md) 定位问题。

## 源码结构

```text
codex-design-bridge/
├─ codex-plugin/codex-design-bridge/  # Codex 插件、MCP Server 和 Apps UI
├─ plugin/                            # Figma Desktop 开发插件
├─ src/                               # 本地 Bridge 兼容核心
├─ desktop/                           # Electron 回归实现
├─ scripts/                           # 安装和辅助脚本
├─ test/                              # 自动化测试
├─ examples/                          # 静态示例
└─ docs/                              # 安装、状态、版本和验收文档
```

更完整的说明见 [GitHub 仓库结构](docs/repository-layout.zh-CN.md)。

## 开发与验证

```bash
npm ci
npm run check
```

当前 Windows 验证结果：102 项测试，96 通过、0 失败、6 项 macOS 专用用例跳过。仓库检查还会阻止误提交本机缓存、运行状态、发布 ZIP 和绝对路径。

## 文档

- [中文文档导航](docs/README.zh-CN.md)
- [安装与快速上手](docs/installation.zh-CN.md)
- [当前产品状态](docs/product-status.zh-CN.md)
- [0.7.0 发布说明](docs/release-0.7.0.zh-CN.md)
- [真实 Figma 往返验收](docs/figma-smoke-test.md)
- [最新开发交接](docs/handoff-2026-08-07.zh-CN.md)

## 安全与许可证

请勿提交或公开分享 `.figma-sync/`、`.codex/`、`.cdb-imports/`、连接 token、事务备份、环境变量或日志。安全报告要求见 [SECURITY.md](SECURITY.md)。

本仓库目前未声明开源许可证。公开源代码不等于自动授予复制、修改或再分发权利；需要开放复用时，应由仓库所有者明确选择并添加许可证。
