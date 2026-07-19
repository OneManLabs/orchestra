#!/bin/zsh
set -euo pipefail

NODE_BIN=${FLEET_NODE_BIN:?FLEET_NODE_BIN is required}
RUNTIME_DIR=${FLEET_RUNTIME_DIR:?FLEET_RUNTIME_DIR is required}
NODE_DIR=${NODE_BIN%/*}

# launchd starts user agents with a deliberately small PATH. Keep the runtime's
# Node directory visible so npm-installed tools (including Codex) continue to
# work when the interactive shell is not running.
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ -z "${FLEET_CODEX_COMMAND:-}" && -x "$NODE_DIR/codex" ]]; then
  export FLEET_CODEX_COMMAND="$NODE_DIR/codex"
fi

unset FLEET_TOKEN FLEET_ENROLLMENT_TOKEN
exec "$NODE_BIN" "$RUNTIME_DIR/dist/cli.js"
