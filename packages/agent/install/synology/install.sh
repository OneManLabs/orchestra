#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
BUNDLE=
NODE_SOURCE=
CORE_URL=
ROLE=storage
TOKEN_FILE=
PROJECT_ROOTS=
DEVICE_NAME=
ALLOW_POWER=false
PREVENT_SLEEP=false
INSTALL_ROOT=${FLEET_SYNOLOGY_INSTALL_ROOT:-"$HOME/.fleet-canvas-agent"}
ENROLLMENT_TIMEOUT=45
SILENT=false

usage() {
  cat <<'EOF'
Usage: install.sh --bundle PATH --node PATH --core-url URL [options]

Required for first enrollment:
  --enrollment-token-file PATH  Owner-only (mode 0600) one-line token file

Options:
  --role ROLE                   Device role (default: storage)
  --project-roots PATHS         Colon/comma-separated Agent project roots
  --device-name NAME            Fleet display name (default: DSM hostname)
  --allow-power-actions         Enable Agent-side power action gate
  --prevent-sleep-during-jobs   Ask the Agent to inhibit sleep during jobs
  --install-root PATH           Private path below HOME
  --enrollment-timeout SECONDS  First-enrollment wait (default: 45)
  --silent | --headless         Suppress non-error installation guidance

The installer copies the runtime and selected Node.js executable beneath the
user's home. It does not require sudo, systemd, or a DSM package. Node.js 22+
and the runtime bundle must match the Synology CPU/OS. Use an --omit-pty bundle
when node-pty cannot be built for DSM.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || die "Missing value for $1."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) require_value "$@"; BUNDLE=$2; shift 2 ;;
    --node) require_value "$@"; NODE_SOURCE=$2; shift 2 ;;
    --core-url) require_value "$@"; CORE_URL=$2; shift 2 ;;
    --role) require_value "$@"; ROLE=$2; shift 2 ;;
    --enrollment-token-file) require_value "$@"; TOKEN_FILE=$2; shift 2 ;;
    --project-roots) require_value "$@"; PROJECT_ROOTS=$2; shift 2 ;;
    --device-name) require_value "$@"; DEVICE_NAME=$2; shift 2 ;;
    --install-root) require_value "$@"; INSTALL_ROOT=$2; shift 2 ;;
    --enrollment-timeout) require_value "$@"; ENROLLMENT_TIMEOUT=$2; shift 2 ;;
    --allow-power-actions) ALLOW_POWER=true; shift ;;
    --prevent-sleep-during-jobs) PREVENT_SLEEP=true; shift ;;
    --silent|--headless) SILENT=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[ -n "${HOME:-}" ] && [ "$HOME" != / ] || die "A non-root user HOME is required."
[ "$(id -u)" -ne 0 ] || die "Run this installer as the DSM user that will own the Agent, not as root."
[ -n "$BUNDLE" ] && [ -f "$BUNDLE/dist/cli.js" ] || die "--bundle must point to a Fleet Agent runtime bundle."
[ -f "$BUNDLE/node_modules/ws/package.json" ] || die "Runtime bundle is incomplete (node_modules/ws is missing)."
if [ ! -f "$BUNDLE/node_modules/node-pty/package.json" ]; then
  [ -f "$BUNDLE/.fleet-agent-omit-pty" ] &&
    [ "$(sed -n '1p' "$BUNDLE/.fleet-agent-omit-pty")" = fleet-agent-omit-pty-v1 ] ||
    die "Runtime is missing node-pty and the supported appliance marker. Rebuild with --omit-pty."
fi
[ -n "$NODE_SOURCE" ] && [ -x "$NODE_SOURCE" ] || die "--node must be an executable Node.js path."
[ -n "$CORE_URL" ] || die "--core-url is required."
case "$ROLE" in core|gpu|worker|gateway|storage|workstation|phone|unknown) ;; *) die "Invalid --role: $ROLE" ;; esac
case "$ENROLLMENT_TIMEOUT" in ''|*[!0-9]*) die "--enrollment-timeout must be an integer." ;; esac
[ "$ENROLLMENT_TIMEOUT" -ge 5 ] && [ "$ENROLLMENT_TIMEOUT" -le 300 ] || die "--enrollment-timeout must be between 5 and 300 seconds."

NODE_MAJOR=$(
  "$NODE_SOURCE" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null
) || die "Unable to execute Node.js at $NODE_SOURCE."
case "$NODE_MAJOR" in ''|*[!0-9]*) die "Unable to determine Node.js version." ;; esac
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or newer is required (found major $NODE_MAJOR)."

"$NODE_SOURCE" -e '
  if (process.argv.slice(1).some((value) => /[\r\n]/.test(value))) process.exit(1);
' "$INSTALL_ROOT" "$CORE_URL" "$PROJECT_ROOTS" "$DEVICE_NAME" || die "Installer paths and configuration values must be single-line."

case "$INSTALL_ROOT" in
  "$HOME"/*) ;;
  *) die "--install-root must be a path beneath HOME ($HOME)." ;;
esac

"$NODE_SOURCE" -e '
  const value = new URL(process.argv[1]);
  if (!["http:", "https:", "ws:", "wss:"].includes(value.protocol) || value.username || value.password) process.exit(1);
' "$CORE_URL" || die "Invalid --core-url."

BASE_PARENT=$(dirname "$INSTALL_ROOT")
mkdir -p "$BASE_PARENT" "$INSTALL_ROOT"
chmod 700 "$INSTALL_ROOT"
INSTALL_ROOT=$(CDPATH= cd -P "$INSTALL_ROOT" && pwd)
HOME_REAL=$(CDPATH= cd -P "$HOME" && pwd)
case "$INSTALL_ROOT" in
  "$HOME_REAL"/*) ;;
  *) die "Resolved --install-root escapes the current user's home." ;;
esac

CONFIG_DIR="$INSTALL_ROOT/config"
DATA_DIR="$INSTALL_ROOT/data"
RUN_DIR="$INSTALL_ROOT/run"
LOG_DIR="$INSTALL_ROOT/logs"
BIN_DIR="$INSTALL_ROOT/bin"
RUNTIME_DIR="$INSTALL_ROOT/runtime"
CREDENTIAL_FILE="$DATA_DIR/device-credential.json"

if [ -f "$CREDENTIAL_FILE" ] && [ -n "$TOKEN_FILE" ]; then
  die "A device credential already exists. Reinstall without --enrollment-token-file, or uninstall --purge before re-enrolling."
fi
if [ ! -f "$CREDENTIAL_FILE" ] && [ -z "$TOKEN_FILE" ]; then
  die "--enrollment-token-file is required for first enrollment."
fi

ENROLLMENT_TOKEN=
if [ -n "$TOKEN_FILE" ]; then
  # lstat, ownership, and mode checks happen before reading the secret. This
  # rejects symlinks and any group/other access, rather than silently chmodding
  # a potentially attacker-controlled path.
  "$NODE_SOURCE" -e '
    const fs = require("node:fs");
    const target = process.argv[1];
    const entry = fs.lstatSync(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a regular file");
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) throw new Error("not owned by current user");
    if ((entry.mode & 0o077) !== 0) throw new Error("group/other permissions are present");
    const token = fs.readFileSync(target, "utf8");
    if (!/^[^\r\n]+\n?$/.test(token)) throw new Error("must contain exactly one non-empty line");
  ' "$TOKEN_FILE" || die "Enrollment token file must be a non-symlink, current-user-owned mode-0600 file containing one line."
  ENROLLMENT_TOKEN=$(
    "$NODE_SOURCE" -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8").replace(/\n$/, ""))' "$TOKEN_FILE"
  )
fi

mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$RUN_DIR" "$LOG_DIR" "$BIN_DIR"
chmod 700 "$CONFIG_DIR" "$DATA_DIR" "$RUN_DIR" "$LOG_DIR" "$BIN_DIR"

if [ -x "$BIN_DIR/fleet-boot-stack-user" ]; then
  "$BIN_DIR/fleet-boot-stack-user" stop >/dev/null 2>&1 ||
    die "Unable to stop the existing Fleet boot stack before upgrade."
elif [ -x "$BIN_DIR/fleet-agent-user" ]; then
  "$BIN_DIR/fleet-agent-user" stop >/dev/null 2>&1 || true
fi

STAGE_DIR="$INSTALL_ROOT/.install.$$"
RUNTIME_OLD="$INSTALL_ROOT/.runtime-old.$$"
cleanup() {
  rm -rf "$STAGE_DIR" "$RUNTIME_OLD"
}
trap cleanup EXIT HUP INT TERM
rm -rf "$STAGE_DIR" "$RUNTIME_OLD"
mkdir -p "$STAGE_DIR/runtime" "$STAGE_DIR/bin"
cp -pR "$BUNDLE"/. "$STAGE_DIR/runtime"/
cp "$NODE_SOURCE" "$STAGE_DIR/bin/node"
cp "$SCRIPT_DIR/fleet-agent-user.sh" "$STAGE_DIR/bin/fleet-agent-user"
cp "$SCRIPT_DIR/fleet-boot-stack-user.sh" "$STAGE_DIR/bin/fleet-boot-stack-user"
chmod 700 "$STAGE_DIR/bin/node" "$STAGE_DIR/bin/fleet-agent-user" "$STAGE_DIR/bin/fleet-boot-stack-user"

if [ -d "$RUNTIME_DIR" ]; then mv "$RUNTIME_DIR" "$RUNTIME_OLD"; fi
mv "$STAGE_DIR/runtime" "$RUNTIME_DIR"
mv "$STAGE_DIR/bin/node" "$BIN_DIR/node"
mv "$STAGE_DIR/bin/fleet-agent-user" "$BIN_DIR/fleet-agent-user"
mv "$STAGE_DIR/bin/fleet-boot-stack-user" "$BIN_DIR/fleet-boot-stack-user"
rm -rf "$RUNTIME_OLD" "$STAGE_DIR"
trap - EXIT HUP INT TERM

write_value() {
  destination="$CONFIG_DIR/$1"
  value=$2
  temporary="$destination.$$.tmp"
  umask 077
  printf '%s\n' "$value" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

write_value core-url "$CORE_URL"
write_value role "$ROLE"
write_value allow-power-actions "$ALLOW_POWER"
write_value prevent-sleep-during-jobs "$PREVENT_SLEEP"
if [ -n "$PROJECT_ROOTS" ]; then write_value project-roots "$PROJECT_ROOTS"; else rm -f "$CONFIG_DIR/project-roots"; fi
if [ -n "$DEVICE_NAME" ]; then write_value device-name "$DEVICE_NAME"; else rm -f "$CONFIG_DIR/device-name"; fi
if [ -n "$ENROLLMENT_TOKEN" ]; then
  write_value enrollment-token "$ENROLLMENT_TOKEN"
else
  # An upgrade that already has a device credential must never resurrect a
  # stale enrollment secret left by an interrupted earlier attempt.
  rm -f "$CONFIG_DIR/enrollment-token"
fi

CONTROL="$BIN_DIR/fleet-agent-user"
STACK_CONTROL="$BIN_DIR/fleet-boot-stack-user"
"$CONTROL" start

if [ -n "$ENROLLMENT_TOKEN" ]; then
  remaining=$ENROLLMENT_TIMEOUT
  while [ "$remaining" -gt 0 ] && [ ! -s "$CREDENTIAL_FILE" ]; do
    if ! "$CONTROL" status >/dev/null 2>&1; then
      "$CONTROL" logs 50 >&2 2>/dev/null || true
      die "Fleet Agent stopped before enrollment completed; the source token file was not consumed."
    fi
    sleep 1
    remaining=$((remaining - 1))
  done
  if [ ! -s "$CREDENTIAL_FILE" ]; then
    "$CONTROL" stop >/dev/null 2>&1 || true
    die "Enrollment did not complete within ${ENROLLMENT_TIMEOUT}s; the source token file was not consumed. Check Core reachability and the Agent log."
  fi

  # Restart after removing the enrollment token so it no longer remains in the
  # long-lived process environment. The device-bound credential is mode 0600.
  "$CONTROL" stop >/dev/null
  rm -f "$CONFIG_DIR/enrollment-token"
  rm -f "$TOKEN_FILE"
  "$CONTROL" start
fi

# Run the detached supervisor immediately, not only after the next NAS reboot.
# With no tunnel configured it simply keeps the Agent alive. When a protected
# tunnel is configured later it also owns and repairs that forwarding process.
"$STACK_CONTROL" start

if [ "$SILENT" != true ]; then
  cat <<EOF
Fleet Agent is installed and running as $(id -un).

Agent control command:
  $CONTROL {start|stop|restart|status|logs|uninstall}

Boot-stack control command:
  $STACK_CONTROL {start|stop|restart|status|logs|configure-tunnel|disable-tunnel}

IMPORTANT: detached processes survive an SSH disconnect, but not a NAS reboot.
In DSM, create a User-defined script in Control Panel > Task Scheduler, run it
as $(id -un), trigger it at Boot-up, and use this exact command:

  '$STACK_CONTROL' start

Do not run that scheduled task as root or another DSM user.
EOF
fi
