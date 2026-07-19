#!/bin/bash
set -euo pipefail

INSTALL_DIR="/usr/local/lib/fleet-canvas/agent"
ENV_FILE="/Library/Application Support/Fleet Canvas/agent.env"
PLIST="/Library/LaunchDaemons/com.fleetcanvas.agent.plist"
SERVICE_USER="${FLEET_SERVICE_USER:-${SUDO_USER:-$(id -un)}}"
BUNDLE=""
CORE_URL="${FLEET_CORE_URL:-http://127.0.0.1:4780}"
ENROLLMENT_TOKEN="${FLEET_ENROLLMENT_TOKEN:-}"
TOKEN="${FLEET_TOKEN:-}"
PROJECT_ROOTS="${FLEET_PROJECT_ROOTS:-}"
ROLE="${FLEET_DEVICE_ROLE:-workstation}"
ALLOW_POWER="${FLEET_ALLOW_POWER_ACTIONS:-false}"
PREVENT_SLEEP="${FLEET_PREVENT_SLEEP_DURING_JOBS:-false}"
SILENT=false
REQUIRE_SIGNED_UPDATES="${FLEET_REQUIRE_SIGNED_UPDATES:-true}"
UPDATE_PUBLIC_KEY="${FLEET_UPDATE_PUBLIC_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --core-url) CORE_URL="$2"; shift 2 ;;
    --enrollment-token) ENROLLMENT_TOKEN="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --project-roots) PROJECT_ROOTS="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --allow-power-actions) ALLOW_POWER=true; shift ;;
    --prevent-sleep-during-jobs) PREVENT_SLEEP=true; shift ;;
    --update-public-key) UPDATE_PUBLIC_KEY="$2"; shift 2 ;;
    --allow-unsigned-development-updates) REQUIRE_SIGNED_UPDATES=false; shift ;;
    --silent|--headless) SILENT=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run this installer as root." >&2; exit 1; }
[[ "$SERVICE_USER" != "root" ]] || { echo "Specify a non-root --service-user for the agent." >&2; exit 1; }
[[ -n "$BUNDLE" && -d "$BUNDLE/dist" ]] || { echo "--bundle must point to a bundle created by build-bundle.mjs." >&2; exit 1; }
[[ -f "$BUNDLE/node_modules/ws/package.json" ]] || { echo "Bundle is incomplete; rebuild it on this OS/architecture with build-bundle.mjs." >&2; exit 1; }
if [[ ! -f "$BUNDLE/node_modules/node-pty/package.json" ]]; then
  [[ -f "$BUNDLE/.fleet-agent-omit-pty" && "$(<"$BUNDLE/.fleet-agent-omit-pty")" == "fleet-agent-omit-pty-v1" ]] || { echo "Bundle is missing node-pty without the appliance-mode marker." >&2; exit 1; }
fi
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != / && "$INSTALL_DIR" != /usr && "$INSTALL_DIR" != "/usr/local" && "$INSTALL_DIR" != *'|'* ]] || { echo "Unsafe --install-dir." >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service user does not exist: $SERVICE_USER" >&2; exit 1; }
[[ "$ROLE" =~ ^(core|gpu|worker|gateway|storage|workstation|phone|unknown)$ ]] || { echo "Invalid --role." >&2; exit 1; }
for value in "$CORE_URL" "$ENROLLMENT_TOKEN" "$TOKEN" "$PROJECT_ROOTS" "$UPDATE_PUBLIC_KEY"; do [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "Installer values must be single-line." >&2; exit 1; }; done
command -v node >/dev/null || { echo "Node.js 22 or newer is required." >&2; exit 1; }
[[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -ge 22 ]] || { echo "Node.js 22 or newer is required." >&2; exit 1; }
NODE_BIN="$(command -v node)"
node -e "const u=new URL(process.argv[1]); if(!['http:','https:','ws:','wss:'].includes(u.protocol)||u.username||u.password)process.exit(1)" "$CORE_URL" || { echo "Invalid --core-url." >&2; exit 1; }

launchctl bootout system/com.fleetcanvas.agent >/dev/null 2>&1 || true
rm -rf "$INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
cp -pR "$BUNDLE"/. "$INSTALL_DIR"/
cp "$(cd "$(dirname "$0")" && pwd)/fleet-agent-service.sh" "$INSTALL_DIR/fleet-agent-service.sh"
chmod 0755 "$INSTALL_DIR/fleet-agent-service.sh"

SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
BASE_STATE_DIR="$(dirname "$ENV_FILE")"
STATE_DIR="$BASE_STATE_DIR/state"
install -d -m 0700 -o root -g wheel "$BASE_STATE_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
{
  printf 'FLEET_CORE_URL=%q\n' "$CORE_URL"
  printf 'FLEET_DEVICE_ROLE=%q\n' "$ROLE"
  printf 'FLEET_AGENT_DATA_DIR=%q\n' "$STATE_DIR"
  printf 'FLEET_NODE_BIN=%q\n' "$NODE_BIN"
  printf 'FLEET_ALLOW_POWER_ACTIONS=%q\n' "$ALLOW_POWER"
  printf 'FLEET_PREVENT_SLEEP_DURING_JOBS=%q\n' "$PREVENT_SLEEP"
  printf 'FLEET_REQUIRE_SIGNED_UPDATES=%q\n' "$REQUIRE_SIGNED_UPDATES"
  [[ -n "$UPDATE_PUBLIC_KEY" ]] && printf 'FLEET_UPDATE_PUBLIC_KEY=%q\n' "$UPDATE_PUBLIC_KEY"
  [[ -n "$PROJECT_ROOTS" ]] && printf 'FLEET_PROJECT_ROOTS=%q\n' "$PROJECT_ROOTS"
  [[ -n "$ENROLLMENT_TOKEN" ]] && printf 'FLEET_ENROLLMENT_TOKEN=%q\n' "$ENROLLMENT_TOKEN"
  [[ -n "$TOKEN" ]] && printf 'FLEET_TOKEN=%q\n' "$TOKEN"
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
chown root:wheel "$ENV_FILE"
chmod +a "$SERVICE_USER allow read" "$ENV_FILE"
chmod +a "$SERVICE_USER allow search" "$BASE_STATE_DIR"
chown -R root:wheel "$INSTALL_DIR"

sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__ENV_FILE__|$ENV_FILE|g" -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
  "$(cd "$(dirname "$0")" && pwd)/com.fleetcanvas.agent.plist" > "$PLIST"
chown root:wheel "$PLIST"
chmod 0644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap system "$PLIST"
launchctl enable system/com.fleetcanvas.agent
[[ "$SILENT" == true ]] || echo "Fleet Agent installed. Remove FLEET_ENROLLMENT_TOKEN from $ENV_FILE after enrollment."
