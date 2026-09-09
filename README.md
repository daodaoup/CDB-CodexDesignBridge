# Codex Design Bridge (CDB)

English | [简体中文](README.zh-CN.md)

CDB connects Codex, local HTML/CSS projects, and Figma Desktop. It moves pages between source code and editable Figma layers, then writes supported design changes back through guarded local transactions.

> **This is a public beta, not a production-stable release.** The public version is `0.9.0`; the current exact build is `0.9.0+codex.20260829100031`. The primary macOS path has real desktop evidence. Windows installers and automation are ready, but real Codex/Figma Desktop acceptance is still pending. When anything breaks, Codex can inspect this repository, diagnose the exact build, patch the implementation, run tests, and reinstall CDB.

## Best-fit projects

CDB currently works best with explicit, locally runnable static HTML/CSS pages.

- HTML → Figma: editable frames, text, images, safe SVG, and supported layout semantics.
- Figma → HTML: create a project, add a page, or update an already linked page from one complete top-level frame.
- Round trips: supported text, color, size, opacity, radius, stroke, typography, Flex/Auto Layout, basic Grid, constraints, and selected structural edits.
- Multi-page and responsive review: isolated page identity plus `320 / 375 / 402 / 430 / 768 / 1440` acceptance widths.
- Guarded writes: source hashes, shared baselines, multi-file transactions, live browser verification, and Undo.

React, Vue, Vite, CSS-in-JS, complex runtime DOM, complete Figma Variables/Variants, and prototype animation are not fully supported by this beta.

## Requirements

Both platforms require:

- Codex Desktop and a usable Codex CLI.
- Figma Desktop; browser-only Figma cannot load the local development plugin.
- The **complete cloned or downloaded repository**, not an installer or manifest by itself.
- Node.js 20 or newer. Installers prefer the Node runtime bundled with Codex, then fall back to a system Node installation.
- Codex/ChatGPT must be fully closed during installation. Reopen it and create a new task afterward.

CDB listens only on loopback. It requires no Figma API key, does not use the official Figma MCP connector, and consumes no official Figma MCP quota.

## Download

Repository: <https://github.com/daodaoup/CDB-CodexDesignBridge>

Clone it with GitHub Desktop or choose **Code → Download ZIP** on GitHub. Keep the extracted directory structure intact.

## Install on macOS

macOS also requires `python3`; install the Xcode Command Line Tools if it is missing.

1. Quit Codex/ChatGPT completely.
2. Open the complete repository folder in Finder.
3. Double-click `Install Codex Design Bridge.command`.
4. Wait for the exact version, cache path, and installation report.
5. Reopen Codex and create a new task.

If macOS blocks the first launch, Control-click the command and choose **Open**. If executable permissions are missing:

```bash
chmod +x "./Install Codex Design Bridge.command"
chmod +x "./scripts/install-codex-design-bridge-macos.sh"
./Install\ Codex\ Design\ Bridge.command
```

Validate without installing:

```bash
bash ./scripts/install-codex-design-bridge-macos.sh \
  --source ./codex-plugin/codex-design-bridge \
  --check-only
```

## Install on Windows

Windows also requires PowerShell 5.1 or newer and a discoverable `codex.exe` or `codex.cmd`. Windows 10/11 x64 is recommended.

1. Quit Codex/ChatGPT completely.
2. Double-click `Install Codex Design Bridge.vbs` inside the complete extracted repository.
3. Wait for the installation result. Use the PowerShell installer when detailed output is needed.
4. Reopen Codex and create a new task.

Package validation:

```powershell
.\scripts\install-codex-design-bridge.ps1 `
  -CheckOnly `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath "$env:TEMP\cdb-package-check.json"
```

Detailed installation:

```powershell
.\scripts\install-codex-design-bridge.ps1 `
  -SourcePath .\codex-plugin\codex-design-bridge `
  -ReportPath "$env:TEMP\cdb-install.json" `
  -WaitForExit
```

Windows remains a real-desktop acceptance target for this beta. See the [Windows handoff and acceptance guide](docs/handoff-2026-08-31-windows.zh-CN.md).

## Install the Figma plugin

The Figma side is currently a local development plugin and is not yet published in Figma Community.

- GitHub file: [plugin/manifest.json](https://github.com/daodaoup/CDB-CodexDesignBridge/blob/main/plugin/manifest.json)
- Local path after download: `CDB-CodexDesignBridge/plugin/manifest.json`

In Figma Desktop:

1. Choose **Plugins → Development → Import plugin from manifest**.
2. Select the local `plugin/manifest.json`.
3. In the target file, choose **Plugins → Development → CDB**.

After upgrading CDB, close the previous CDB plugin window and run the development plugin again. Do not leave multiple old instances open.

## Usage

### Open CDB

In a new Codex task:

```text
@codex-design-bridge open the workspace
@codex-design-bridge open project /absolute/project/path
@codex-design-bridge start from Figma
```

The local browser workspace can also be opened with `Open CDB Workspace.command` on macOS or `Open CDB Workspace.cmd` on Windows.

### HTML → Figma

1. Open the local HTML/CSS project through CDB.
2. Run the CDB development plugin in Figma Desktop and verify the project name/key.
3. Select a page in the workspace and send it to Figma.
4. Wait for editable layers; separate pages must produce separate frames.
5. Success requires “synced” and `pendingChangeCount = 0`.

### Figma → HTML

1. Select exactly one complete top-level Frame, Group, Component, or Instance.
2. Choose **Send to CDB Workspace** in the Figma plugin.
3. In CDB, create a project, add a page, or update the linked page.
4. Wait for the source transaction and live-preview verification.
5. Confirm that source files, assets, and the preview actually changed and both sides return to “synced.”

## Bugs: ask Codex to continue fixing CDB

If the workspace hangs, a page has the wrong size, elements do not sync, a second page fails, installation fails, or stale state interferes, provide Codex with the screenshot, full error, and project path. Codex can inspect the exact runtime, logs, implementation, and tests, then patch and reinstall the plugin.

Suggested prompt:

```text
Continue fixing Codex Design Bridge. Read README.zh-CN.md, docs/product-status.zh-CN.md, and the latest handoff first. Preserve all existing worktree changes. Verify the exact plugin.json build, get_cdb_health, installation report, and Figma plugin connection. Reproduce this issue, identify the root cause, patch the implementation, and add a regression test. If core plugin files change, bump the cachebuster, reinstall, and verify in a new Codex task. Do not add compatibility or migration for any legacy version, protocol, Page IR, cache, binding, or sync data.
```

Include the OS, Codex/Figma versions, exact build, project path, screenshots, complete error text, health output, and the shortest reliable reproduction steps.

## Development and verification

Node.js 20 or newer is required; Node.js 22 is recommended.

```bash
npm ci
npm run check
```

The current macOS full result is 166 tests: 162 passed, 0 failed, and 4 Windows-only tests skipped. The project remains beta until real Windows desktop acceptance is complete.

## Documentation

- [Chinese documentation center](docs/README.zh-CN.md)
- [Current product status](docs/product-status.zh-CN.md)
- [Detailed installation and recovery](docs/installation.zh-CN.md)
- [Desktop acceptance checklist](docs/figma-smoke-test.md)
- [Windows handoff and acceptance](docs/handoff-2026-08-31-windows.zh-CN.md)
- [0.9 development plan](docs/next-version-plan-0.9.zh-CN.md)

## Security and licensing

CDB listens only on loopback. Do not commit `.figma-sync/`, `.codex/`, `.cdb/`, pairing tokens, transaction backups, logs, installed plugin caches, or real user projects.

No open-source license is currently granted. Public visibility alone does not grant rights to copy, modify, or redistribute this code.
