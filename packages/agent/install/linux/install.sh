#!/bin/bash
set -euo pipefail
INSTALL_DIR="/opt/fleet-canvas/agent"
ENV_FILE="/etc/fleet-canvas/agent.env"
SERVICE_USER="fleet-agent"
SERVICE_GROUP="fleet-agent"
BUNDLE=""
CORE_URL="http://127.0.0.1:4780"
CORE_URL_SET=false
CONFIG_FILE=""
ENROLLMENT_TOKEN=""
ENROLLMENT_TOKEN_FILE=""
TOKEN=""
TOKEN_FILE=""
PROJECT_ROOTS=""
ROLE="worker"
ROLE_SET=false
ALLOW_POWER=false
PREVENT_SLEEP=false
SILENT=false
REQUIRE_SIGNED_UPDATES=true
UPDATE_PUBLIC_KEY=""
CONSUME_INPUTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --config-file) CONFIG_FILE="$2"; shift 2 ;;
    --core-url) CORE_URL="$2"; CORE_URL_SET=true; shift 2 ;;
    --enrollment-token) ENROLLMENT_TOKEN="$2"; shift 2 ;;
    --enrollment-token-file) ENROLLMENT_TOKEN_FILE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --project-roots) PROJECT_ROOTS="$2"; shift 2 ;;
    --role) ROLE="$2"; ROLE_SET=true; shift 2 ;;
    --service-user) SERVICE_USER="$2"; SERVICE_GROUP="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --allow-power-actions) ALLOW_POWER=true; shift ;;
    --prevent-sleep-during-jobs) PREVENT_SLEEP=true; shift ;;
    --update-public-key) UPDATE_PUBLIC_KEY="$2"; shift 2 ;;
    --allow-unsigned-development-updates) REQUIRE_SIGNED_UPDATES=false; shift ;;
    --consume-inputs) CONSUME_INPUTS=true; shift ;;
    --silent|--headless) SILENT=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run this installer as root." >&2; exit 1; }
[[ -n "$BUNDLE" && -f "$BUNDLE/dist/cli.js" ]] || { echo "--bundle must point to a bundle created by build-bundle.mjs." >&2; exit 1; }
[[ -f "$BUNDLE/node_modules/ws/package.json" ]] || { echo "Bundle is incomplete; rebuild it on this OS/architecture with build-bundle.mjs." >&2; exit 1; }
if [[ ! -f "$BUNDLE/node_modules/node-pty/package.json" ]]; then
  [[ -f "$BUNDLE/.fleet-agent-omit-pty" && "$(<"$BUNDLE/.fleet-agent-omit-pty")" == "fleet-agent-omit-pty-v1" ]] || { echo "Bundle is missing node-pty without the appliance-mode marker." >&2; exit 1; }
fi
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != / && "$INSTALL_DIR" != /usr && "$INSTALL_DIR" != /opt && "$INSTALL_DIR" != *'|'* ]] || { echo "Unsafe --install-dir." >&2; exit 1; }
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Invalid --service-user." >&2; exit 1; }
[[ "$ROLE" =~ ^(core|gpu|worker|gateway|storage|workstation|phone|unknown)$ ]] || { echo "Invalid --role." >&2; exit 1; }
for value in "$CORE_URL" "$ENROLLMENT_TOKEN" "$TOKEN" "$PROJECT_ROOTS" "$UPDATE_PUBLIC_KEY"; do [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "Installer values must be single-line." >&2; exit 1; }; done
command -v node >/dev/null || { echo "Node.js 22 or newer is required." >&2; exit 1; }
[[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -ge 22 ]] || { echo "Node.js 22 or newer is required." >&2; exit 1; }
node -e "const u=new URL(process.argv[1]); if(!['http:','https:','ws:','wss:'].includes(u.protocol)||u.username||u.password)process.exit(1)" "$CORE_URL" || { echo "Invalid --core-url." >&2; exit 1; }
created_user=false
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/fleet-canvas-agent --shell /usr/sbin/nologin "$SERVICE_USER"
  created_user=true
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

systemctl stop fleet-canvas-agent.service >/dev/null 2>&1 || true
rm -rf "$INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
cp -pR "$BUNDLE"/. "$INSTALL_DIR"/
chown -R root:root "$INSTALL_DIR"

install -d -m 0750 -o root -g "$SERVICE_GROUP" /etc/fleet-canvas
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" /var/lib/fleet-canvas-agent
[[ "$created_user" == true ]] && touch /etc/fleet-canvas/.standalone-created-user
install -m 0755 "$(cd "$(dirname "$0")" && pwd)/configure.mjs" /usr/local/sbin/fleet-agent-configure

if [[ -n "$CONFIG_FILE" || -n "$ENROLLMENT_TOKEN_FILE" || -n "$TOKEN_FILE" ]]; then
  configure_args=()
  configure_args+=(--service-group "$SERVICE_GROUP")
  [[ -n "$CONFIG_FILE" ]] && configure_args+=(--config-file "$CONFIG_FILE")
  [[ "$CORE_URL_SET" == true ]] && configure_args+=(--core-url "$CORE_URL")
  [[ "$ROLE_SET" == true ]] && configure_args+=(--role "$ROLE")
  [[ -n "$PROJECT_ROOTS" ]] && configure_args+=(--project-roots "$PROJECT_ROOTS")
  [[ -n "$ENROLLMENT_TOKEN_FILE" ]] && configure_args+=(--enrollment-token-file "$ENROLLMENT_TOKEN_FILE")
  [[ -n "$TOKEN_FILE" ]] && configure_args+=(--token-file "$TOKEN_FILE")
  [[ -n "$UPDATE_PUBLIC_KEY" ]] && configure_args+=(--update-public-key "$UPDATE_PUBLIC_KEY")
  [[ "$ALLOW_POWER" == true ]] && configure_args+=(--allow-power-actions)
  [[ "$PREVENT_SLEEP" == true ]] && configure_args+=(--prevent-sleep)
  [[ "$REQUIRE_SIGNED_UPDATES" == false ]] && configure_args+=(--allow-unsigned-updates)
  [[ "$CONSUME_INPUTS" == true ]] && configure_args+=(--consume-inputs)
  /usr/local/sbin/fleet-agent-configure "${configure_args[@]}"
else
  escape_env() { local value=${1//\\/\\\\}; value=${value//\"/\\\"}; printf '"%s"' "$value"; }
  {
    printf 'FLEET_CORE_URL='; escape_env "$CORE_URL"; printf '\n'
    printf 'FLEET_DEVICE_ROLE='; escape_env "$ROLE"; printf '\n'
    printf 'FLEET_AGENT_DATA_DIR='; escape_env "/var/lib/fleet-canvas-agent"; printf '\n'
    printf 'FLEET_ALLOW_POWER_ACTIONS='; escape_env "$ALLOW_POWER"; printf '\n'
    printf 'FLEET_PREVENT_SLEEP_DURING_JOBS='; escape_env "$PREVENT_SLEEP"; printf '\n'
    printf 'FLEET_REQUIRE_SIGNED_UPDATES='; escape_env "$REQUIRE_SIGNED_UPDATES"; printf '\n'
    if [[ -n "$UPDATE_PUBLIC_KEY" ]]; then printf 'FLEET_UPDATE_PUBLIC_KEY='; escape_env "$UPDATE_PUBLIC_KEY"; printf '\n'; fi
    if [[ -n "$PROJECT_ROOTS" ]]; then printf 'FLEET_PROJECT_ROOTS='; escape_env "$PROJECT_ROOTS"; printf '\n'; fi
    if [[ -n "$ENROLLMENT_TOKEN" ]]; then printf 'FLEET_ENROLLMENT_TOKEN='; escape_env "$ENROLLMENT_TOKEN"; printf '\n'; fi
    if [[ -n "$TOKEN" ]]; then printf 'FLEET_TOKEN='; escape_env "$TOKEN"; printf '\n'; fi
  } > "$ENV_FILE"
  chown "root:$SERVICE_GROUP" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi

sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__ENV_FILE__|$ENV_FILE|g" -e "s|__SERVICE_USER__|$SERVICE_USER|g" -e "s|__SERVICE_GROUP__|$SERVICE_GROUP|g" \
  "$(cd "$(dirname "$0")" && pwd)/systemd/fleet-canvas-agent.service" > /etc/systemd/system/fleet-canvas-agent.service
systemctl daemon-reload
systemctl enable --now fleet-canvas-agent.service
[[ "$SILENT" == true ]] || echo "Fleet Agent installed. After enrollment run: sudo fleet-agent-configure --remove-enrollment-token --restart"
