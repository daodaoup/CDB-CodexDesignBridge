# Codex Design Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

Codex Design Bridge (CDB) is a designer-first workspace embedded in Codex. It previews static frontend pages, sends editable layers to a local Figma development plugin, and applies supported Figma changes back to the existing source without using the official Figma MCP quota.

Current source candidate: `0.7.0`. The Codex plugin build in this repository is `0.7.0+codex.20260807151937`; the workbench displays the public version `V 0.7.0`.

This repository is the clean source distribution. It intentionally excludes local connection tokens, Codex/Figma runtime state, dependency caches, generated release archives, and machine-specific plugin caches.

## Documentation

- [`docs/README.zh-CN.md`](docs/README.zh-CN.md) — Chinese documentation index and source-of-truth map.
- [`docs/product-status.zh-CN.md`](docs/product-status.zh-CN.md) — current implementation, evidence, boundaries, and release gates.
- [`docs/next-version-plan.zh-CN.md`](docs/next-version-plan.zh-CN.md) — complete 0.5.2 product and system plan, now annotated with implementation status.
- [`docs/release-0.5.2.zh-CN.md`](docs/release-0.5.2.zh-CN.md) — 0.5.2 candidate changes, compatibility, and security boundaries.
- [`docs/release-0.6.0.zh-CN.md`](docs/release-0.6.0.zh-CN.md) — Figma-first pages, streamlined startup, and round-trip reliability fixes.
- [`docs/release-0.7.0.zh-CN.md`](docs/release-0.7.0.zh-CN.md) — atomic reparenting, verified source patches, and Auto Layout/Flex/Grid mapping.
- [`docs/installation.zh-CN.md`](docs/installation.zh-CN.md) — Windows/macOS installation and recovery.
- [`docs/figma-smoke-test.md`](docs/figma-smoke-test.md) — required real Codex/Figma desktop acceptance.
- [`docs/repository-layout.zh-CN.md`](docs/repository-layout.zh-CN.md) — source, Codex plugin, Figma plugin, tests, and documentation layout.
- [`docs/handoff-2026-08-07.zh-CN.md`](docs/handoff-2026-08-07.zh-CN.md) — current GitHub handoff, validation status, and remaining release gates.

> Release status: the 0.7.0 source and automated coverage are implemented. The Windows plugin/cache update is part of this release flow; a fresh Codex task, real Figma Desktop round trips, and macOS acceptance remain release gates.

## Daily use

1. Invoke **CDB** with no extra text. A current CDB project resumes directly; otherwise the focused launcher opens.
2. Start from an existing Figma page Frame or use “new design: `<description>`” to create a dependency-free CDB project.
3. Local HTML upload remains available internally but is hidden from the normal interface.
4. CDB preflights the source. Safe deterministic fixes require an explicit report-bound action; blockers do not start the real workspace.
5. Keep the local **CDB** development plugin open in Figma. Its **CDB Pages** list shows manifest pages and their sync state.
6. Import the current/selected pages or update all changed pages. Supported Figma edits use the existing transactional fast lane; larger or ambiguous changes remain pending for Codex.

Pages come from `.cdb/manifest.json`: HTML entries or routes are pages; CSS, JavaScript, images, SVGs, and fonts are dependencies. Runtime add/rename of fake pages is no longer supported.

## One-time Figma setup

1. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest**.
2. Select [`plugin/manifest.json`](plugin/manifest.json).
3. Run **Plugins → Development → CDB** in the target file.

The plugin pairs with the active local workspace automatically. There is no connection code or separate Bridge window in the normal workflow. Protocol 14 requires reopening any plugin window left over from an older release; protocol 13 clients remain accepted during migration.

## Architecture

```text
CDB intent / launcher
  → source resolver
  → manifest + unified preflight
  → single-workspace lease
  → embedded Apps UI + local preview
  → loopback Figma Bridge (protocol 14; protocol 13 migration compatibility)
  → local Figma development plugin
  → transactional source patch / safe Undo
```

Only one real workspace owns preview/Figma resources at a time. A clean old workspace yields automatically; takeover asks for confirmation only when Figma has unsent changes.

## Scope boundary

0.7.0 prioritizes atomic cross-parent structure edits and Flex/Grid layout round trips for static HTML/CSS while retaining manifest-backed multi-page selection. React/Vue/Vite semantic adapters, ZIP import, components/variants/tokens, advanced responsive inference, and bulk multi-page workflows remain deferred.

## Core files

- [`codex-plugin/codex-design-bridge/mcp/server.mjs`](codex-plugin/codex-design-bridge/mcp/server.mjs) — MCP tools and orchestration.
- [`codex-plugin/codex-design-bridge/mcp/project-contract.mjs`](codex-plugin/codex-design-bridge/mcp/project-contract.mjs) — scaffold, manifest, preflight, and safe fixes.
- [`codex-plugin/codex-design-bridge/mcp/workspace-lease.mjs`](codex-plugin/codex-design-bridge/mcp/workspace-lease.mjs) — cross-process ownership and handoff.
- [`codex-plugin/codex-design-bridge/mcp/workspace.html`](codex-plugin/codex-design-bridge/mcp/workspace.html) — launcher and workbench UI.
- [`codex-plugin/codex-design-bridge/mcp/local-figma-bridge.mjs`](codex-plugin/codex-design-bridge/mcp/local-figma-bridge.mjs) — local Figma transport and page catalog.
- [`plugin/code.js`](plugin/code.js) and [`plugin/ui.html`](plugin/ui.html) — Figma development plugin.
- [`scripts/install-codex-design-bridge.ps1`](scripts/install-codex-design-bridge.ps1) — Windows package/install/cache verification.
- [`Install Codex Design Bridge.vbs`](Install%20Codex%20Design%20Bridge.vbs) — terminal-free Windows installer that waits for Codex to exit without force-closing it.

## Development verification

Requires Node.js 20 or newer; Node.js 22 is recommended for the current Electron development dependency.

```bash
npm ci
npm run check
```

The repository retains the v0.4 CLI/Electron implementation for regression coverage; it is not the recommended CDB workflow.

## Repository and licensing notes

- Do not commit `.figma-sync`, `.codex`, `.cdb-imports`, environment files, logs, or generated release archives.
- Vendored runtime dependencies retain their own license files under `codex-plugin/codex-design-bridge/vendor/`.
- No open-source license is granted by this repository yet. Publishing the source on GitHub does not by itself grant reuse rights; choose and add a license before accepting external redistribution or contributions.
