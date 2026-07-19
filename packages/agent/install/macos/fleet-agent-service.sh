#!/bin/bash
set -euo pipefail
ENV_FILE="${FLEET_SERVICE_ENV_FILE:-/Library/Application Support/Fleet Canvas/agent.env}"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && -r "$ENV_FILE" ]] || { echo "Fleet Agent environment file is unavailable or unsafe." >&2; exit 78; }
set -a
# The file is root-owned mode 0600 with a read ACL for the service identity.
source "$ENV_FILE"
set +a
[[ -n "${FLEET_NODE_BIN:-}" && -x "$FLEET_NODE_BIN" ]] || { echo "Configured Node.js executable is unavailable." >&2; exit 78; }
exec "$FLEET_NODE_BIN" "$(cd "$(dirname "$0")" && pwd)/dist/cli.js"
