# Security Policy

## Supported version

Security fixes currently target the latest source candidate only.

## Reporting a vulnerability

Do not publish connection tokens, local file contents, private project paths, or exploit details in a public issue. Contact the repository owner privately and include the affected version, reproduction steps, impact, and the smallest safe diagnostic sample.

## Local-data boundary

CDB uses loopback services for the Codex-to-Figma development workflow. Runtime state such as `.figma-sync/`, `.codex/design-bridge.json`, connection tokens, transaction backups, and logs is intentionally excluded from version control. Review any diagnostic archive before sharing it.
