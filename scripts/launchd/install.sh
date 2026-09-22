#!/usr/bin/env bash
# Prep-only helper. Does NOT install or start the launchd job — it never
# calls `launchctl bootstrap`/`load`/`kickstart`. It only does the two
# things that are safe to automate and easy to get wrong by hand:
#
#   1. `mkdir -p logs/scheduled` — launchd opens StandardOutPath/
#      StandardErrorPath before the job's own script runs, so a fresh
#      install fails to launch if this directory doesn't already exist.
#   2. Confirms `node`/`npm` actually resolve under the PATH this repo's
#      plist template ships with, so a PATH mismatch is caught here
#      instead of silently inside an unattended launchd job.
#
# Run this, read its output, then follow the printed next steps yourself.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_PATH="$(pwd)"

mkdir -p "$REPO_PATH/logs/scheduled"
echo "OK: $REPO_PATH/logs/scheduled exists"

CHECK_PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
node_path="$(env -i HOME="$HOME" PATH="$CHECK_PATH" command -v node || true)"
npm_path="$(env -i HOME="$HOME" PATH="$CHECK_PATH" command -v npm || true)"

if [ -z "$node_path" ] || [ -z "$npm_path" ]; then
  echo "!!! node/npm not found under PATH=$CHECK_PATH !!!"
  echo "    (this repo uses tsx directly, not npm, at runtime — but confirm your"
  echo "    actual node manager's shim/bin dir and adjust the plist's PATH to match;"
  echo "    do not source a shell init file such as ~/.zshrc or 'mise activate')"
  exit 1
fi
echo "OK: node -> $node_path"
echo "OK: npm  -> $npm_path"

cat <<EOF

Prerequisites are ready. Nothing has been installed. To actually install
(this repo's task list intentionally stops before this step until you
decide to do it):

  mkdir -p ~/Library/LaunchAgents
  cp scripts/launchd/com.seo-tryanderror.mechanical-check.plist \\
     ~/Library/LaunchAgents/com.seo-tryanderror.mechanical-check.plist
  # then edit ~/Library/LaunchAgents/com.seo-tryanderror.mechanical-check.plist:
  #   REPO_PATH -> $REPO_PATH
  #   HOME_PATH -> $HOME
  #   GSC_SERVICE_ACCOUNT_JSON_PATH -> your actual credential file path

  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.seo-tryanderror.mechanical-check.plist
  launchctl kickstart -k gui/\$(id -u)/com.seo-tryanderror.mechanical-check

To uninstall later:
  launchctl bootout gui/\$(id -u) ~/Library/LaunchAgents/com.seo-tryanderror.mechanical-check.plist
EOF
