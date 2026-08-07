#!/bin/bash

INSTALLER_DIRECTORY="$(cd "$(dirname "$0")" && pwd -P)"
"$INSTALLER_DIRECTORY/scripts/install-codex-design-bridge-macos.sh"
INSTALL_EXIT=$?

printf '\n'
if [ "$INSTALL_EXIT" -eq 0 ]; then
  printf 'Installation succeeded.\n'
else
  printf 'Installation failed. Review the message above, then try again.\n'
fi

read -r -p 'Press Return to close this window...' _
exit "$INSTALL_EXIT"

