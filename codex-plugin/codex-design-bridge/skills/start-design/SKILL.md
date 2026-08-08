---
name: start-design
description: Resume the current CDB workspace, start from an existing Figma page, open an explicitly requested project, or create a new design from a description.
---

# Start CDB

Use one deterministic entry point. Do not scan or create anything unless the user expresses an open or create intent.

## Bare invocation

When the user sends only `@CDB`, calls CDB without another instruction, or asks to open CDB itself:

1. Check only whether the current writable workspace contains `.cdb/manifest.json`.
2. If it does, call `open_design_workspace` with that workspace and resume its active page.
3. Otherwise call `open_design_launcher` and pass the writable workspace as `workspaceDir`.
4. Do not recursively scan project files, create a draft, or open an external browser.

The launcher focuses on starting from Figma or a new-design description. Local HTML upload remains an internal capability but is hidden from the normal interface.

## Open a project

When the user says `@CDB 打开项目` or otherwise explicitly asks to open an existing project:

1. Call `resolve_design_source` using this priority: explicit path, attached path, current workspace.
2. If a source resolves, call `open_design_workspace` with that project directory.
3. If no source resolves, keep the returned launcher open. Do not create a fake project.
4. If preflight reports safe fixes, let the embedded workspace show and apply them. Do not bypass blockers.

Only inspect `.cdb/manifest.json`, root HTML entries, or a user-selected directory. Do not recursively search unrelated workspace folders.

## Create a new design

When the user says `@CDB 新建设计：<描述>` or gives an equivalent description:

1. Call `create_design_project` immediately with the current writable workspace and the full description.
2. Do not ask about framework, package manager, port, page count, or project name.
3. The tool creates `index.html`, `styles.css`, `assets/`, `AGENTS.md`, and `.cdb/manifest.json`, runs preflight, and opens the workspace.
4. If no writable workspace exists, ask only for a save location.

When the user asks to create a design but gives no description, call `open_design_launcher`; its new-design form continues through the current task.

## Start from Figma

When the user asks to create a page from an existing Figma design:

1. Call `create_figma_seed_project` with the current writable workspace.
2. The opened workbench connects to the local CDB Figma development plugin.
3. Ask the user to select exactly one complete page Frame and use `用选中稿创建页面`.
4. The selected Frame becomes the stable page root and its supported descendants are written transactionally into the new project.
5. Never use the official Figma connector or send the generated page back to Figma as part of this path.

## Project contract

- Pages come from `.cdb/manifest.json`; HTML entries or explicit local routes are pages, while CSS, JavaScript, images, SVG, fonts, and JSON are dependencies.
- Keep exactly one complete `data-codex-root` per page.
- Keep `data-codex-id` values stable and unique.
- Keep assets project-local and SVG free of scripts, event handlers, and external resources.
- Keep important editable nodes in initial HTML. Runtime-only DOM stays a warning or blocker, not an excuse to rewrite business logic.
- Use the unified preflight before opening, refreshing, or sending a page.

## Continue with Figma

Use only the local CDB Figma development plugin. Do not use the official Figma connector or official Figma MCP tools.

- The Figma plugin receives the manifest page list and shows 未导入、已同步、源码更新、Figma 修改、冲突、失败.
- `send_preview_to_local_figma` accepts manifest page IDs only.
- Supported mapped changes keep using the transactional fast path and `undo_last_design_patch`.
- Pending structural changes continue through the existing `sendFollowUpMessage` handoff to the current Codex task.
- Treat a replacement clone plus deletion of the original layout as one structural redesign. Never apply only the deletions while the replacement remains pending.

## Workspace ownership

The launcher owns no lease. A real project acquires the single CDB workspace lease only after preflight passes. Opening a real workspace always closes the previous workspace and takes over its preview and Figma connection without asking for confirmation, even when the previous workspace has unsent Figma changes.

The embedded Apps UI reports mounting with `report_design_workspace_mounted`. A localhost preview is not proof that the embedded workspace mounted, and an external browser is never a substitute.
