# Contributing

## Development setup

1. Install Node.js 22 and npm.
2. Run `npm ci`.
3. Make changes in the source directory, never in an installed Codex plugin cache.
4. Run `npm run check` before opening a pull request.

## Project boundaries

- The Codex plugin source is `codex-plugin/codex-design-bridge/`.
- The local Figma development plugin is `plugin/`.
- The legacy CLI/Electron implementation remains for regression coverage but is not the primary product workflow.
- Never commit `.figma-sync`, `.codex`, `.cdb-imports`, logs, tokens, temporary imports, or generated archives.

Changes to the Codex plugin manifest must keep the outer directory name and `.codex-plugin/plugin.json` name equal to `codex-design-bridge`. Validate a release in a fresh Codex task and a real Figma Desktop session; automated tests do not replace that acceptance step.
