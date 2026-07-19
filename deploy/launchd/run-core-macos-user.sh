#!/bin/zsh
set -euo pipefail

NODE_BIN=${FLEET_NODE_BIN:?FLEET_NODE_BIN is required}
RUNTIME_DIR=${FLEET_RUNTIME_DIR:?FLEET_RUNTIME_DIR is required}
NODE_DIR=${NODE_BIN%/*}

# User launch agents do not inherit the interactive shell PATH. Keep native
# package tools available so Core can discover and import real Tailscale peers.
export PATH="$NODE_DIR:/Applications/Tailscale.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

read_protected_secret() {
  local secret_file=$1
  local label=$2
  [[ -f "$secret_file" && ! -L "$secret_file" ]] || {
    print -u2 "$label file must be a regular, non-symlink file: $secret_file"
    return 78
  }
  local owner mode
  owner=$(/usr/bin/stat -f '%Su' "$secret_file")
  mode=$(/usr/bin/stat -f '%Lp' "$secret_file")
  [[ "$owner" == "$USER" && "$mode" -le 600 ]] || {
    print -u2 "$label file must be owned by $USER and have mode 0600 or stricter."
    return 78
  }
  local value
  IFS= read -r value < "$secret_file"
  [[ -n "$value" ]] || {
    print -u2 "$label file is empty: $secret_file"
    return 78
  }
  print -r -- "$value"
}

if [[ -n "${FLEET_TOKEN_FILE:-}" ]]; then
  export FLEET_TOKEN=$(read_protected_secret "$FLEET_TOKEN_FILE" 'Fleet recovery token')
else
  export FLEET_TOKEN=$(/usr/bin/security find-generic-password \
    -a recovery-token \
    -s com.fleetcanvas.core \
    -w)
fi

if [[ -n "${FLEET_MASTER_KEY_FILE:-}" ]]; then
  export FLEET_MASTER_KEY=$(read_protected_secret "$FLEET_MASTER_KEY_FILE" 'Fleet master key')
else
  export FLEET_MASTER_KEY=$(/usr/bin/security find-generic-password \
    -a master-key \
    -s com.fleetcanvas.core \
    -w)
fi

exec "$NODE_BIN" "$RUNTIME_DIR/dist/cli.js"
