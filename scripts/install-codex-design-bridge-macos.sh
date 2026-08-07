#!/bin/bash

set -Eeuo pipefail
export LANG=C
export LC_ALL=C

PLUGIN_NAME="codex-design-bridge"
SOURCE_PATH=""
DESTINATION_ROOT=""
DESTINATION_ROOT_EXPLICIT=0
CODEX_COMMAND="codex"
MARKETPLACE="personal"
MARKETPLACE_EXPLICIT=0
REPORT_PATH=""
REPORT_PATH_EXPLICIT=0
CHECK_ONLY=0
SKIP_PROCESS_CHECK=0
BOOTSTRAP_MARKETPLACE=0
MARKETPLACE_ADDED=0
NEEDS_MARKETPLACE_ADD=0
LOCAL_MARKETPLACE_ROOT=""

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd -P)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd -P)"

CORE_FILES=(
  ".codex-plugin/plugin.json"
  ".mcp.json"
  "assets/icon.png"
  "mcp/browser-capture.mjs"
  "mcp/workspace.html"
  "mcp/server.mjs"
  "mcp/fast-page-patch.mjs"
  "mcp/local-figma-bridge.mjs"
  "mcp/patch-transaction.mjs"
  "mcp/project-contract.mjs"
  "mcp/preview-process-guard.cjs"
  "mcp/workspace-lease.mjs"
  "shared/page-capture.mjs"
  "shared/change-set-v14.schema.json"
  "shared/page.mjs"
  "shared/svg.mjs"
  "skills/start-design/SKILL.md"
  "skills/start-design/agents/openai.yaml"
)

usage() {
  cat <<'EOF'
Install Codex Design Bridge for macOS.

Usage:
  install-codex-design-bridge-macos.sh [options]

Options:
  --source PATH              Plugin source directory.
  --destination-root PATH    Personal plugin directory (default: ~/plugins).
  --codex-command PATH       Codex CLI executable (default: codex).
  --marketplace NAME         Marketplace name (default: personal).
  --report PATH              Install report destination.
  --check-only               Validate the release without installing it.
  --skip-process-check       Allow installation while Codex/ChatGPT is running.
  -h, --help                 Show this help.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || fail "--source requires a path."
      SOURCE_PATH="$2"
      shift 2
      ;;
    --destination-root)
      [ "$#" -ge 2 ] || fail "--destination-root requires a path."
      DESTINATION_ROOT="$2"
      DESTINATION_ROOT_EXPLICIT=1
      shift 2
      ;;
    --codex-command)
      [ "$#" -ge 2 ] || fail "--codex-command requires a path."
      CODEX_COMMAND="$2"
      shift 2
      ;;
    --marketplace)
      [ "$#" -ge 2 ] || fail "--marketplace requires a name."
      MARKETPLACE="$2"
      MARKETPLACE_EXPLICIT=1
      shift 2
      ;;
    --report)
      [ "$#" -ge 2 ] || fail "--report requires a path."
      REPORT_PATH="$2"
      REPORT_PATH_EXPLICIT=1
      shift 2
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --skip-process-check)
      SKIP_PROCESS_CHECK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

command -v python3 >/dev/null 2>&1 || fail "python3 is required. Install Xcode Command Line Tools and try again."
PYTHON_COMMAND="$(command -v python3)"

absolute_path() {
  "$PYTHON_COMMAND" -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"
}

resolve_source() {
  local candidate
  if [ -n "$SOURCE_PATH" ]; then
    candidate="$SOURCE_PATH"
    if [ -d "$candidate" ] && [ -f "$candidate/.codex-plugin/plugin.json" ]; then
      absolute_path "$candidate"
      return
    fi
  else
    for candidate in "$PACKAGE_ROOT/codex-plugin/$PLUGIN_NAME" "$PACKAGE_ROOT/$PLUGIN_NAME"; do
      if [ -d "$candidate" ] && [ -f "$candidate/.codex-plugin/plugin.json" ]; then
        absolute_path "$candidate"
        return
      fi
    done
  fi
  fail "Codex Design Bridge source was not found. Extract the complete release package and try again."
}

manifest_field() {
  "$PYTHON_COMMAND" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], ""))' "$1/.codex-plugin/plugin.json" "$2"
}

validate_plugin() {
  local plugin_path="$1"
  local manifest_name manifest_version relative_path
  [ -f "$plugin_path/.codex-plugin/plugin.json" ] || fail "Plugin manifest was not found: $plugin_path/.codex-plugin/plugin.json"
  manifest_name="$(manifest_field "$plugin_path" name)"
  manifest_version="$(manifest_field "$plugin_path" version)"
  [ "$manifest_name" = "$PLUGIN_NAME" ] || fail "Unexpected plugin manifest name: $manifest_name"
  [ -n "$manifest_version" ] || fail "Plugin manifest does not contain a version."
  for relative_path in "${CORE_FILES[@]}"; do
    [ -f "$plugin_path/$relative_path" ] || fail "Release package is missing a core file: $relative_path"
  done
}

compute_hashes() {
  local plugin_path="$1"
  local output_path="$2"
  local relative_path hash
  : > "$output_path"
  for relative_path in "${CORE_FILES[@]}"; do
    hash="$(shasum -a 256 "$plugin_path/$relative_path" | awk '{print $1}')"
    printf '%s\t%s\n' "$relative_path" "$hash" >> "$output_path"
  done
}

assert_hashes_match() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if ! cmp -s "$expected" "$actual"; then
    fail "$label file verification failed."
  fi
}

assert_safe_managed_path() {
  local path_to_check expected_parent allowed_leaf actual_parent actual_leaf
  path_to_check="$(absolute_path "$1")"
  expected_parent="$(absolute_path "$2")"
  allowed_leaf="$3"
  actual_parent="$(dirname "$path_to_check")"
  actual_leaf="$(basename "$path_to_check")"
  [ "$actual_parent" = "$expected_parent" ] && [ "$actual_leaf" = "$allowed_leaf" ] || \
    fail "Refusing to operate on an unverified path: $path_to_check"
}

write_report() {
  local status="$1"
  local check_only="$2"
  local target_path="${3:-}"
  local cache_path="${4:-}"
  local backup_path="${5:-}"
  local previous_version="${6:-}"
  mkdir -p "$(dirname "$REPORT_PATH")"
  "$PYTHON_COMMAND" - "$REPORT_PATH" "$PLUGIN_NAME" "$VERSION" "$status" "$check_only" "$SOURCE" "$HASH_FILE" "$target_path" "$cache_path" "$backup_path" "$previous_version" "$MARKETPLACE" <<'PY'
import datetime
import json
import sys

(report_path, plugin, version, status, check_only, source_path, hash_path,
 target_path, cache_path, backup_path, previous_version, marketplace) = sys.argv[1:]
hashes = {}
with open(hash_path, encoding="utf-8") as handle:
    for line in handle:
        relative_path, digest = line.rstrip("\n").split("\t", 1)
        hashes[relative_path] = digest
report = {
    "plugin": plugin,
    "version": version,
    "checkedAt" if check_only == "true" else "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "checkOnly": check_only == "true",
    "sourcePath": source_path,
    "coreFileCount": len(hashes),
    "hashes": hashes,
    "status": status,
}
if check_only != "true":
    report.update({
        "targetPath": target_path,
        "installedPath": cache_path,
        "marketplace": marketplace,
        "hashesVerified": True,
        "pluginListConfirmed": True,
        "backupPath": backup_path,
        "previousVersion": previous_version,
    })
with open(report_path, "w", encoding="utf-8") as handle:
    json.dump(report, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
}

plugin_version_from_list() {
  local listing_path="$1"
  "$PYTHON_COMMAND" - "$listing_path" "$PLUGIN_SELECTOR" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    listing = json.load(handle)
for item in listing.get("installed", []):
    if item.get("pluginId") == sys.argv[2]:
        print(item.get("version", ""))
        break
PY
}

marketplace_root_from_list() {
  local listing_path="$1"
  "$PYTHON_COMMAND" - "$listing_path" "$MARKETPLACE" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    listing = json.load(handle)
for item in listing.get("marketplaces", []):
    if item.get("name") == sys.argv[2]:
        print(item.get("root", ""))
        break
PY
}

marketplace_contains_plugin() {
  "$PYTHON_COMMAND" - "$1" "$PLUGIN_NAME" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    marketplace = json.load(handle)
if any(item.get("name") == sys.argv[2] for item in marketplace.get("plugins", [])):
    raise SystemExit(0)
raise SystemExit(1)
PY
}

write_local_marketplace() {
  local marketplace_path="$1"
  mkdir -p "$(dirname "$marketplace_path")"
  "$PYTHON_COMMAND" - "$marketplace_path" "$MARKETPLACE" "$PLUGIN_NAME" <<'PY'
import json
import sys

marketplace_path, marketplace_name, plugin_name = sys.argv[1:]
payload = {
    "name": marketplace_name,
    "interface": {"displayName": "Codex Design Bridge Local"},
    "plugins": [
        {
            "name": plugin_name,
            "source": {"source": "local", "path": f"./plugins/{plugin_name}"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Productivity",
        }
    ],
}
with open(marketplace_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
}

SOURCE="$(resolve_source)"
validate_plugin "$SOURCE"
VERSION="$(manifest_field "$SOURCE" version)"
PLUGIN_SELECTOR="$PLUGIN_NAME@$MARKETPLACE"

TEMP_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/codex-design-bridge-installer.XXXXXX")"
HASH_FILE="$TEMP_DIRECTORY/source-hashes.tsv"
LIST_FILE="$TEMP_DIRECTORY/plugin-list.json"
MARKETPLACE_LIST_FILE="$TEMP_DIRECTORY/marketplace-list.json"
STAGING_HASH_FILE="$TEMP_DIRECTORY/staging-hashes.tsv"
TARGET_HASH_FILE="$TEMP_DIRECTORY/target-hashes.tsv"
CACHE_HASH_FILE="$TEMP_DIRECTORY/cache-hashes.tsv"
compute_hashes "$SOURCE" "$HASH_FILE"

if [ -z "$DESTINATION_ROOT" ]; then
  DESTINATION_ROOT="$HOME/plugins"
fi
DESTINATION_ROOT="$(absolute_path "$DESTINATION_ROOT")"
if [ -z "$REPORT_PATH" ]; then
  REPORT_PATH="$DESTINATION_ROOT/.codex-design-bridge-install-report.json"
fi
REPORT_PATH="$(absolute_path "$REPORT_PATH")"

if [ "$CHECK_ONLY" -eq 1 ]; then
  write_report "package-valid" "true"
  rm -rf "$TEMP_DIRECTORY"
  printf 'Release package verified: Codex Design Bridge %s\n' "$VERSION"
  printf 'Report: %s\n' "$REPORT_PATH"
  exit 0
fi

if [ "$SKIP_PROCESS_CHECK" -ne 1 ]; then
  BLOCKING_PROCESSES=""
  pgrep -x ChatGPT >/dev/null 2>&1 && BLOCKING_PROCESSES="ChatGPT"
  if pgrep -x Codex >/dev/null 2>&1; then
    BLOCKING_PROCESSES="${BLOCKING_PROCESSES:+$BLOCKING_PROCESSES, }Codex"
  fi
  [ -z "$BLOCKING_PROCESSES" ] || fail "$BLOCKING_PROCESSES is still running. Fully quit Codex/ChatGPT, including background processes, and run the installer again."
fi

if [ "$CODEX_COMMAND" = "codex" ] && ! command -v codex >/dev/null 2>&1; then
  for candidate in \
    "/Applications/ChatGPT.app/Contents/Resources/codex" \
    "/Applications/Codex.app/Contents/Resources/codex"; do
    if [ -x "$candidate" ]; then
      CODEX_COMMAND="$candidate"
      break
    fi
  done
fi

if [[ "$CODEX_COMMAND" == */* ]]; then
  [ -x "$CODEX_COMMAND" ] || fail "Codex CLI was not found or is not executable: $CODEX_COMMAND"
else
  command -v "$CODEX_COMMAND" >/dev/null 2>&1 || fail "Codex CLI was not found: $CODEX_COMMAND"
fi

MARKETPLACE_PATH="$HOME/.agents/plugins/marketplace.json"
if [ "$MARKETPLACE" = "personal" ] && { [ ! -f "$MARKETPLACE_PATH" ] || ! marketplace_contains_plugin "$MARKETPLACE_PATH"; }; then
  if [ "$MARKETPLACE_EXPLICIT" -eq 1 ] || [ "$DESTINATION_ROOT_EXPLICIT" -eq 1 ]; then
    fail "Personal marketplace does not contain $PLUGIN_NAME. Remove the explicit marketplace/destination options to let the installer create its dedicated local marketplace."
  fi
  MARKETPLACE="codex-design-bridge-local"
  PLUGIN_SELECTOR="$PLUGIN_NAME@$MARKETPLACE"
  LOCAL_MARKETPLACE_ROOT="$HOME/Library/Application Support/Codex Design Bridge"
  DESTINATION_ROOT="$LOCAL_MARKETPLACE_ROOT/plugins"
  if [ "$REPORT_PATH_EXPLICIT" -ne 1 ]; then
    REPORT_PATH="$DESTINATION_ROOT/.codex-design-bridge-install-report.json"
  fi
  DESTINATION_ROOT="$(absolute_path "$DESTINATION_ROOT")"
  REPORT_PATH="$(absolute_path "$REPORT_PATH")"
  BOOTSTRAP_MARKETPLACE=1
  "$CODEX_COMMAND" plugin marketplace list --json > "$MARKETPLACE_LIST_FILE"
  CONFIGURED_MARKETPLACE_ROOT="$(marketplace_root_from_list "$MARKETPLACE_LIST_FILE")"
  if [ -n "$CONFIGURED_MARKETPLACE_ROOT" ]; then
    [ "$(absolute_path "$CONFIGURED_MARKETPLACE_ROOT")" = "$(absolute_path "$LOCAL_MARKETPLACE_ROOT")" ] || \
      fail "Marketplace $MARKETPLACE is already configured from a different location: $CONFIGURED_MARKETPLACE_ROOT"
  else
    NEEDS_MARKETPLACE_ADD=1
  fi
elif [ "$MARKETPLACE" = "personal" ]; then
  marketplace_contains_plugin "$MARKETPLACE_PATH" || fail "Personal marketplace does not contain $PLUGIN_NAME."
fi

mkdir -p "$DESTINATION_ROOT"
TARGET_PATH="$DESTINATION_ROOT/$PLUGIN_NAME"
STAGING_LEAF=".$PLUGIN_NAME.install-$$"
STAGING_PATH="$DESTINATION_ROOT/$STAGING_LEAF"
BACKUP_PATH=""
TARGET_MOVED=0
NEW_TARGET_PLACED=0
INSTALLED_BEFORE=0
PREVIOUS_VERSION=""

assert_safe_managed_path "$TARGET_PATH" "$DESTINATION_ROOT" "$PLUGIN_NAME"
assert_safe_managed_path "$STAGING_PATH" "$DESTINATION_ROOT" "$STAGING_LEAF"

rollback() {
  local failure_status="$?"
  trap - ERR INT TERM
  printf 'Warning: Installation did not complete. Restoring the previous version.\n' >&2
  if [ "$NEW_TARGET_PLACED" -eq 1 ] && [ -d "$TARGET_PATH" ]; then
    rm -rf "$TARGET_PATH"
  fi
  if [ "$TARGET_MOVED" -eq 1 ] && [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
    mv "$BACKUP_PATH" "$TARGET_PATH"
  fi
  if [ -d "$STAGING_PATH" ]; then
    rm -rf "$STAGING_PATH"
  fi
  if [ "$INSTALLED_BEFORE" -eq 1 ] && [ -d "$TARGET_PATH" ]; then
    "$CODEX_COMMAND" plugin add "$PLUGIN_SELECTOR" --json >/dev/null 2>&1 || \
      printf 'Warning: Automatic plugin re-registration failed.\n' >&2
  fi
  if [ "$MARKETPLACE_ADDED" -eq 1 ]; then
    "$CODEX_COMMAND" plugin marketplace remove "$MARKETPLACE" --json >/dev/null 2>&1 || \
      printf 'Warning: Automatic marketplace removal failed.\n' >&2
  fi
  rm -rf "$TEMP_DIRECTORY"
  exit "$failure_status"
}
trap rollback ERR INT TERM

if [ -d "$STAGING_PATH" ]; then
  rm -rf "$STAGING_PATH"
fi
mkdir "$STAGING_PATH"
cp -R "$SOURCE/." "$STAGING_PATH/"
validate_plugin "$STAGING_PATH"
[ "$(manifest_field "$STAGING_PATH" version)" = "$VERSION" ] || fail "Staged version does not match the release package."
compute_hashes "$STAGING_PATH" "$STAGING_HASH_FILE"
assert_hashes_match "$HASH_FILE" "$STAGING_HASH_FILE" "Staging"

"$CODEX_COMMAND" plugin list --json > "$LIST_FILE"
PREVIOUS_VERSION="$(plugin_version_from_list "$LIST_FILE")"
if [ -n "$PREVIOUS_VERSION" ]; then
  INSTALLED_BEFORE=1
  "$CODEX_COMMAND" plugin remove "$PLUGIN_SELECTOR" --json >/dev/null
fi

if [ -d "$TARGET_PATH" ]; then
  BACKUP_LEAF="$PLUGIN_NAME.backup-$(date +%Y%m%d%H%M%S)-$$"
  BACKUP_PATH="$DESTINATION_ROOT/$BACKUP_LEAF"
  assert_safe_managed_path "$BACKUP_PATH" "$DESTINATION_ROOT" "$BACKUP_LEAF"
  mv "$TARGET_PATH" "$BACKUP_PATH"
  TARGET_MOVED=1
fi

mv "$STAGING_PATH" "$TARGET_PATH"
NEW_TARGET_PLACED=1
compute_hashes "$TARGET_PATH" "$TARGET_HASH_FILE"
assert_hashes_match "$HASH_FILE" "$TARGET_HASH_FILE" "Personal plugin source"

if [ "$BOOTSTRAP_MARKETPLACE" -eq 1 ]; then
  write_local_marketplace "$LOCAL_MARKETPLACE_ROOT/.agents/plugins/marketplace.json"
  if [ "$NEEDS_MARKETPLACE_ADD" -eq 1 ]; then
    "$CODEX_COMMAND" plugin marketplace add "$LOCAL_MARKETPLACE_ROOT" --json >/dev/null
    MARKETPLACE_ADDED=1
  fi
fi

"$CODEX_COMMAND" plugin add "$PLUGIN_SELECTOR" --json >/dev/null
"$CODEX_COMMAND" plugin list --json > "$LIST_FILE"
INSTALLED_VERSION="$(plugin_version_from_list "$LIST_FILE")"
[ -n "$INSTALLED_VERSION" ] || fail "Codex did not report the plugin as installed."
[ "$INSTALLED_VERSION" = "$VERSION" ] || fail "Codex reported version $INSTALLED_VERSION; expected $VERSION."

CACHE_PATH="$HOME/.codex/plugins/cache/$MARKETPLACE/$PLUGIN_NAME/$VERSION"
[ -d "$CACHE_PATH" ] || fail "New runtime cache was not found: $CACHE_PATH"
validate_plugin "$CACHE_PATH"
[ "$(manifest_field "$CACHE_PATH" version)" = "$VERSION" ] || fail "Runtime cache version does not match the release package."
compute_hashes "$CACHE_PATH" "$CACHE_HASH_FILE"
assert_hashes_match "$HASH_FILE" "$CACHE_HASH_FILE" "Codex runtime cache"

write_report "installed" "false" "$TARGET_PATH" "$CACHE_PATH" "$BACKUP_PATH" "$PREVIOUS_VERSION"
if [ "$BOOTSTRAP_MARKETPLACE" -eq 1 ] && [ -f "$LOCAL_MARKETPLACE_ROOT/marketplace.json" ]; then
  rm -f "$LOCAL_MARKETPLACE_ROOT/marketplace.json"
fi
trap - ERR INT TERM
rm -rf "$TEMP_DIRECTORY"

printf '\nInstalled Codex Design Bridge %s\n' "$VERSION"
printf 'Runtime cache: %s\n' "$CACHE_PATH"
printf 'Install report: %s\n' "$REPORT_PATH"
printf 'Reopen Codex and start a new task.\n'
