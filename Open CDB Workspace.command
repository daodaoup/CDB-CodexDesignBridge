#!/bin/bash

set -Eeuo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd -P)"
for NODE_PATH in \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ]; then
    "$NODE_PATH" "$SCRIPT_DIRECTORY/scripts/open-local-workspace.mjs"
    exit $?
  fi
done

printf 'CDB could not find a Node.js runtime. Install or update Codex, then try again.\n' >&2
read -r -p 'Press Return to close this window...' _
exit 1
