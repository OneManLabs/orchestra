#!/bin/sh
set -eu

# User-mode boot supervisor for Synology DSM. It is intentionally POSIX sh so
# it works with BusyBox ash. The script is copied below <install-root>/bin and
# never relies on HOME or DSM Task Scheduler's minimal PATH.
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
SCRIPT_PATH="$SCRIPT_DIR/$(basename "$0")"
BASE_DIR=$(CDPATH= cd -P "$SCRIPT_DIR/.." && pwd)
CONFIG_DIR="$BASE_DIR/config"
RUN_DIR="$BASE_DIR/run"
LOG_DIR="$BASE_DIR/logs"
NODE_BIN="$BASE_DIR/bin/node"
AGENT_CONTROL="$BASE_DIR/bin/fleet-agent-user"
MONITOR_PID_FILE="$RUN_DIR/boot-stack-monitor.pid"
TUNNEL_PID_FILE="$RUN_DIR/ssh-tunnel.pid"
LOCK_DIR="$RUN_DIR/boot-stack.lock"
MONITOR_LOG="$LOG_DIR/boot-stack.log"
TUNNEL_LOG="$LOG_DIR/ssh-tunnel.log"
TUNNEL_CONTROL_PATH="$RUN_DIR/ssh-tunnel-control"

usage() {
  cat <<'EOF'
Usage: fleet-boot-stack-user COMMAND [options]

  start                       Start tunnel (when configured), Agent, monitor
  stop                        Stop monitor, Agent, and managed tunnel
  restart                     Stop and start the complete boot stack
  status                      Report health; exits 0 healthy, 3 otherwise
  logs [lines]                Print recent supervisor and SSH tunnel logs
  configure-tunnel OPTIONS    Store protected SSH tunnel configuration
  disable-tunnel              Disable and remove managed tunnel configuration

configure-tunnel options:
  --ssh-host HOST             SSH relay host name or IPv4 address
  --ssh-user USER             SSH relay account
  --identity-file PATH        Owner-only private key copied into install root
  --known-hosts-file PATH     Pinned known_hosts copied into install root
  --local-port PORT           Loopback port exposed to the Agent
  --target-host HOST          Host reached from the SSH relay
  --target-port PORT          Fleet Core port reached from the SSH relay
  --ssh-command PATH          Absolute ssh executable (default: auto-detect)
  --ssh-port PORT             SSH server port (default: 22)
  --monitor-interval SECONDS  Repair check interval, 2-300 (default: 15)
  --start-timeout SECONDS     Tunnel startup timeout, 2-60 (default: 15)

The private key and pinned host keys are copied with mode 0600. Configuration
and key contents are never emitted by status or logs commands.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || die "Missing value for $1."
}

assert_private_layout() {
  [ -x "$NODE_BIN" ] || die "Bundled Node.js is missing or not executable: $NODE_BIN"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    for (const target of process.argv.slice(1)) {
      try {
        fs.mkdirSync(target, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const entry = fs.lstatSync(target);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe directory");
      if (uid !== undefined && entry.uid !== uid) throw new Error("directory owner mismatch");
      fs.chmodSync(target, 0o700);
      const after = fs.lstatSync(target);
      if (after.dev !== entry.dev || after.ino !== entry.ino || (after.mode & 0o077) !== 0) {
        throw new Error("directory changed during validation");
      }
    }
  ' "$CONFIG_DIR" "$RUN_DIR" "$LOG_DIR" >/dev/null 2>&1 ||
    die "Fleet boot stack directories must be non-symlink, current-user-owned mode-0700 directories."
}

read_config() {
  config_file="$CONFIG_DIR/$1"
  [ -f "$config_file" ] || return 1
  [ ! -L "$config_file" ] || return 1
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const target = process.argv[1];
    const entry = fs.lstatSync(target);
    if (!entry.isFile() || entry.isSymbolicLink()) process.exit(1);
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) process.exit(1);
    if ((entry.mode & 0o077) !== 0) process.exit(1);
    const value = fs.readFileSync(target, "utf8");
    if (!/^[^\r\n]+\n?$/.test(value)) process.exit(1);
    process.stdout.write(value.replace(/\n$/, ""));
  ' "$config_file"
}

write_config() {
  destination="$CONFIG_DIR/$1"
  value=$2
  case "$value" in *"
"*) die "Configuration values must be single-line." ;; esac
  temporary="$destination.$$.tmp"
  umask 077
  printf '%s\n' "$value" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

copy_protected_file() {
  source_file=$1
  destination_file=$2
  private_mode=$3
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [source, destination, privateMode] = process.argv.slice(1);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const before = fs.lstatSync(source);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
    if (uid !== undefined && before.uid !== uid) throw new Error("owner mismatch");
    const forbidden = privateMode === "true" ? 0o077 : 0o022;
    if ((before.mode & forbidden) !== 0) throw new Error("unsafe permissions");
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const input = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    try {
      const opened = fs.fstatSync(input);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("source changed");
      const temporary = `${destination}.${process.pid}.tmp`;
      const output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        const contents = fs.readFileSync(input);
        fs.writeFileSync(output, contents);
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    } finally {
      fs.closeSync(input);
    }
  ' "$source_file" "$destination_file" "$private_mode" >/dev/null 2>&1 ||
    die "Tunnel key inputs must be regular, current-user-owned files with safe permissions."
}

validate_host() {
  case "$2" in
    ''|-*|*[!A-Za-z0-9._-]*) die "$1 must be a host name or IPv4 address." ;;
  esac
}

validate_user() {
  case "$1" in ''|-*|*[!A-Za-z0-9._-]*) die "--ssh-user contains unsupported characters." ;; esac
}

validate_port() {
  name=$1
  port=$2
  case "$port" in ''|*[!0-9]*) die "$name must be an integer from 1 to 65535." ;; esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "$name must be an integer from 1 to 65535."
}

validate_interval() {
  name=$1
  value=$2
  minimum=$3
  maximum=$4
  case "$value" in ''|*[!0-9]*) die "$name must be an integer from $minimum to $maximum." ;; esac
  [ "$value" -ge "$minimum" ] && [ "$value" -le "$maximum" ] ||
    die "$name must be an integer from $minimum to $maximum."
}

read_pid() {
  pid_file=$1
  [ -f "$pid_file" ] && [ ! -L "$pid_file" ] || return 1
  IFS= read -r pid < "$pid_file" || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 1 ] || return 1
  printf '%s' "$pid"
}

pid_is_current_user() {
  checked_pid=$1
  expected_uid=$(id -u)
  if [ -r "/proc/$checked_pid/status" ]; then
    # The process can exit between the readability check and open. Treat that
    # normal lifecycle race as a failed ownership check without noisy stderr.
    process_uid=$(sed -n 's/^Uid:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "/proc/$checked_pid/status" 2>/dev/null | sed -n '1p')
  else
    process_uid=$(ps -p "$checked_pid" -o uid= 2>/dev/null | tr -d '[:space:]')
  fi
  [ "$process_uid" = "$expected_uid" ]
}

process_has_exact_arg() {
  checked_pid=$1
  expected_arg=$2
  if [ -r "/proc/$checked_pid/cmdline" ]; then
    tr '\000' '\n' < "/proc/$checked_pid/cmdline" 2>/dev/null | grep -F -x "$expected_arg" >/dev/null 2>&1
    return $?
  fi
  command_line=$(ps -p "$checked_pid" -o command= 2>/dev/null || true)
  case "$command_line" in *"$expected_arg"*) return 0 ;; *) return 1 ;; esac
}

owns_monitor_pid() {
  checked_pid=$1
  kill -0 "$checked_pid" 2>/dev/null || return 1
  pid_is_current_user "$checked_pid" || return 1
  process_has_exact_arg "$checked_pid" "$SCRIPT_PATH" || return 1
  process_has_exact_arg "$checked_pid" "__monitor"
}

running_monitor() {
  monitor_pid=$(read_pid "$MONITOR_PID_FILE") || return 1
  if owns_monitor_pid "$monitor_pid"; then
    printf '%s' "$monitor_pid"
    return 0
  fi
  rm -f "$MONITOR_PID_FILE"
  return 1
}

load_tunnel_config() {
  TUNNEL_ENABLED=$(read_config tunnel-enabled 2>/dev/null || printf 'false')
  case "$TUNNEL_ENABLED" in true|false) ;; *) die "Invalid protected tunnel-enabled configuration." ;; esac
  [ "$TUNNEL_ENABLED" = true ] || return 0

  SSH_BIN=$(read_config tunnel-ssh-command) || die "Tunnel ssh command is not configured."
  SSH_HOST=$(read_config tunnel-ssh-host) || die "Tunnel ssh host is not configured."
  SSH_USER=$(read_config tunnel-ssh-user) || die "Tunnel ssh user is not configured."
  SSH_PORT=$(read_config tunnel-ssh-port) || die "Tunnel ssh port is not configured."
  LOCAL_PORT=$(read_config tunnel-local-port) || die "Tunnel local port is not configured."
  TARGET_HOST=$(read_config tunnel-target-host) || die "Tunnel target host is not configured."
  TARGET_PORT=$(read_config tunnel-target-port) || die "Tunnel target port is not configured."
  MONITOR_INTERVAL=$(read_config tunnel-monitor-interval) || die "Tunnel monitor interval is not configured."
  START_TIMEOUT=$(read_config tunnel-start-timeout) || die "Tunnel start timeout is not configured."
  IDENTITY_FILE="$CONFIG_DIR/tunnel-identity"
  KNOWN_HOSTS_FILE="$CONFIG_DIR/tunnel-known-hosts"
  FORWARD_SPEC="127.0.0.1:$LOCAL_PORT:$TARGET_HOST:$TARGET_PORT"
  DESTINATION="$SSH_USER@$SSH_HOST"

  case "$SSH_BIN" in /*) ;; *) die "Tunnel ssh command must be an absolute path." ;; esac
  [ -x "$SSH_BIN" ] || die "Configured ssh command is missing or not executable."
  validate_host "Tunnel ssh host" "$SSH_HOST"
  validate_user "$SSH_USER"
  validate_host "Tunnel target host" "$TARGET_HOST"
  validate_port "Tunnel ssh port" "$SSH_PORT"
  validate_port "Tunnel local port" "$LOCAL_PORT"
  validate_port "Tunnel target port" "$TARGET_PORT"
  validate_interval "Tunnel monitor interval" "$MONITOR_INTERVAL" 2 300
  validate_interval "Tunnel start timeout" "$START_TIMEOUT" 2 60
  [ -f "$IDENTITY_FILE" ] && [ ! -L "$IDENTITY_FILE" ] || die "Protected tunnel identity is missing."
  [ -f "$KNOWN_HOSTS_FILE" ] && [ ! -L "$KNOWN_HOSTS_FILE" ] || die "Protected tunnel known_hosts file is missing."
  # read_config performs the ownership/mode checks without revealing content.
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    for (const target of process.argv.slice(1)) {
      const entry = fs.lstatSync(target);
      if (!entry.isFile() || entry.isSymbolicLink()) process.exit(1);
      if (typeof process.getuid === "function" && entry.uid !== process.getuid()) process.exit(1);
      if ((entry.mode & 0o077) !== 0) process.exit(1);
    }
  ' "$IDENTITY_FILE" "$KNOWN_HOSTS_FILE" >/dev/null 2>&1 || die "Tunnel key files are not owner-only regular files."
}

owns_tunnel_pid() {
  checked_pid=$1
  [ "${TUNNEL_ENABLED:-false}" = true ] || return 1
  kill -0 "$checked_pid" 2>/dev/null || return 1
  pid_is_current_user "$checked_pid" || return 1
  process_has_exact_arg "$checked_pid" "$SSH_BIN" || return 1
  process_has_exact_arg "$checked_pid" "ControlPath=$TUNNEL_CONTROL_PATH" || return 1
  process_has_exact_arg "$checked_pid" "$FORWARD_SPEC" || return 1
  process_has_exact_arg "$checked_pid" "$DESTINATION"
}

running_tunnel() {
  tunnel_pid=$(read_pid "$TUNNEL_PID_FILE") || return 1
  if owns_tunnel_pid "$tunnel_pid"; then
    printf '%s' "$tunnel_pid"
    return 0
  fi
  rm -f "$TUNNEL_PID_FILE"
  return 1
}

probe_tunnel() {
  [ "$TUNNEL_ENABLED" = true ] || return 0
  "$NODE_BIN" -e '
    const net = require("node:net");
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
    const fail = () => { socket.destroy(); process.exit(1); };
    socket.setTimeout(1_000, fail);
    socket.once("error", fail);
    socket.once("connect", () => { socket.end(); process.exit(0); });
  ' "$LOCAL_PORT" >/dev/null 2>&1
}

write_pid() {
  pid_file=$1
  process_pid=$2
  temporary="$pid_file.$process_pid.tmp"
  umask 077
  printf '%s\n' "$process_pid" > "$temporary"
  mv "$temporary" "$pid_file"
}

start_tunnel() {
  [ "$TUNNEL_ENABLED" = true ] || return 0
  if tunnel_pid=$(running_tunnel); then
    probe_tunnel && return 0
    stop_tunnel >/dev/null 2>&1 || true
  fi

  umask 077
  nohup "$SSH_BIN" \
    -F /dev/null -N -T \
    -o BatchMode=yes \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o PreferredAuthentications=publickey \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$KNOWN_HOSTS_FILE" \
    -o GlobalKnownHostsFile=/dev/null \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ControlMaster=no \
    -o "ControlPath=$TUNNEL_CONTROL_PATH" \
    -i "$IDENTITY_FILE" \
    -p "$SSH_PORT" \
    -L "$FORWARD_SPEC" \
    "$DESTINATION" >> "$TUNNEL_LOG" 2>&1 </dev/null &
  tunnel_pid=$!
  write_pid "$TUNNEL_PID_FILE" "$tunnel_pid"

  remaining=$START_TIMEOUT
  while [ "$remaining" -gt 0 ]; do
    owns_tunnel_pid "$tunnel_pid" || break
    if probe_tunnel; then return 0; fi
    sleep 1
    remaining=$((remaining - 1))
  done
  if owns_tunnel_pid "$tunnel_pid"; then kill "$tunnel_pid" 2>/dev/null || true; fi
  rm -f "$TUNNEL_PID_FILE"
  printf 'SSH tunnel failed to become ready; see %s.\n' "$TUNNEL_LOG" >&2
  return 1
}

stop_tunnel() {
  [ "${TUNNEL_ENABLED:-false}" = true ] || { rm -f "$TUNNEL_PID_FILE"; return 0; }
  if ! tunnel_pid=$(running_tunnel); then return 0; fi
  kill "$tunnel_pid" 2>/dev/null || true
  remaining=10
  while [ "$remaining" -gt 0 ] && owns_tunnel_pid "$tunnel_pid"; do
    sleep 1
    remaining=$((remaining - 1))
  done
  if owns_tunnel_pid "$tunnel_pid"; then kill -9 "$tunnel_pid" 2>/dev/null || true; fi
  rm -f "$TUNNEL_PID_FILE" "$TUNNEL_CONTROL_PATH"
}

agent_running() {
  [ -x "$AGENT_CONTROL" ] && "$AGENT_CONTROL" status >/dev/null 2>&1
}

start_agent() {
  [ -x "$AGENT_CONTROL" ] || { printf 'Fleet Agent control helper is missing.\n' >&2; return 1; }
  "$AGENT_CONTROL" start
}

stop_agent() {
  [ -x "$AGENT_CONTROL" ] || return 0
  "$AGENT_CONTROL" stop
}

file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf '0'
}

acquire_lock() {
  mkdir -p "$RUN_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT HUP INT TERM
    return 0
  fi
  now=$(date +%s)
  modified=$(file_mtime "$LOCK_DIR")
  case "$modified" in ''|*[!0-9]*) modified=0 ;; esac
  if [ $((now - modified)) -gt 300 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT HUP INT TERM
      return 0
    fi
  fi
  die "Another Fleet boot-stack lifecycle command is running."
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  trap - EXIT HUP INT TERM
}

rotate_log() {
  log_file=$1
  [ -f "$log_file" ] || return 0
  size=$(wc -c < "$log_file" 2>/dev/null | tr -d '[:space:]')
  case "$size" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$size" -gt 5242880 ]; then
    mv "$log_file" "$log_file.previous"
  fi
}

start_monitor() {
  if monitor_pid=$(running_monitor); then return 0; fi
  rotate_log "$MONITOR_LOG"
  umask 077
  nohup "$SCRIPT_PATH" __monitor >> "$MONITOR_LOG" 2>&1 </dev/null &
  monitor_pid=$!
  write_pid "$MONITOR_PID_FILE" "$monitor_pid"
  sleep 1
  if ! owns_monitor_pid "$monitor_pid"; then
    rm -f "$MONITOR_PID_FILE"
    printf 'Fleet boot-stack monitor exited during startup; see %s.\n' "$MONITOR_LOG" >&2
    return 1
  fi
}

stop_monitor() {
  if ! monitor_pid=$(running_monitor); then return 0; fi
  kill "$monitor_pid" 2>/dev/null || true
  remaining=10
  while [ "$remaining" -gt 0 ] && owns_monitor_pid "$monitor_pid"; do
    sleep 1
    remaining=$((remaining - 1))
  done
  if owns_monitor_pid "$monitor_pid"; then kill -9 "$monitor_pid" 2>/dev/null || true; fi
  rm -f "$MONITOR_PID_FILE"
}

start_stack() {
  assert_private_layout
  load_tunnel_config
  acquire_lock
  if monitor_pid=$(running_monitor); then
    release_lock
    printf 'Fleet boot stack is already monitored (PID %s).\n' "$monitor_pid"
    return 0
  fi
  rotate_log "$TUNNEL_LOG"
  if ! start_tunnel; then release_lock; return 1; fi
  if ! start_agent; then stop_tunnel >/dev/null 2>&1 || true; release_lock; return 1; fi
  if ! start_monitor; then stop_agent >/dev/null 2>&1 || true; stop_tunnel >/dev/null 2>&1 || true; release_lock; return 1; fi
  release_lock
  printf 'Fleet boot stack started (monitor PID %s).\n' "$monitor_pid"
}

stop_stack() {
  assert_private_layout
  load_tunnel_config
  acquire_lock
  stop_monitor
  stop_agent
  stop_tunnel
  release_lock
  printf 'Fleet boot stack stopped.\n'
}

status_stack() {
  assert_private_layout
  load_tunnel_config
  healthy=true
  if monitor_pid=$(running_monitor); then
    printf 'Boot stack monitor: running (PID %s)\n' "$monitor_pid"
  else
    printf 'Boot stack monitor: stopped\n'
    healthy=false
  fi
  if [ "$TUNNEL_ENABLED" = true ]; then
    if tunnel_pid=$(running_tunnel); then
      if probe_tunnel; then
        printf 'SSH tunnel: healthy (PID %s, loopback port %s)\n' "$tunnel_pid" "$LOCAL_PORT"
      else
        printf 'SSH tunnel: process running but loopback probe failed\n'
        healthy=false
      fi
    else
      printf 'SSH tunnel: stopped\n'
      healthy=false
    fi
  else
    printf 'SSH tunnel: disabled\n'
  fi
  if agent_running; then
    printf 'Fleet Agent: running\n'
  else
    printf 'Fleet Agent: stopped\n'
    healthy=false
  fi
  [ "$healthy" = true ] || return 3
}

show_logs() {
  lines=${1:-100}
  case "$lines" in ''|*[!0-9]*) die "Log line count must be a positive integer." ;; esac
  [ "$lines" -gt 0 ] || die "Log line count must be a positive integer."
  printf '%s\n' 'Fleet boot-stack supervisor log:'
  if [ -f "$MONITOR_LOG" ]; then tail -n "$lines" "$MONITOR_LOG"; else printf '%s\n' '(no supervisor log)'; fi
  printf '%s\n' 'SSH tunnel log:'
  if [ -f "$TUNNEL_LOG" ]; then tail -n "$lines" "$TUNNEL_LOG"; else printf '%s\n' '(no tunnel log)'; fi
}

monitor_pause() {
  remaining=$1
  while [ "$remaining" -gt 0 ]; do
    sleep 1
    remaining=$((remaining - 1))
  done
}

monitor_loop() {
  assert_private_layout
  load_tunnel_config
  trap 'exit 0' HUP INT TERM
  while :; do
    if [ "$TUNNEL_ENABLED" = true ]; then
      if ! running_tunnel >/dev/null 2>&1 || ! probe_tunnel; then
        printf '%s Tunnel unhealthy; stopping Agent before repair.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        stop_agent >/dev/null 2>&1 || true
        stop_tunnel >/dev/null 2>&1 || true
        if start_tunnel; then
          printf '%s Tunnel repaired; starting Agent.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
          start_agent >/dev/null 2>&1 || true
        fi
      elif ! agent_running; then
        printf '%s Agent stopped; restarting it.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        start_agent >/dev/null 2>&1 || true
      fi
    elif ! agent_running; then
      printf '%s Agent stopped; restarting it.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      start_agent >/dev/null 2>&1 || true
    fi
    monitor_pause "${MONITOR_INTERVAL:-15}"
  done
}

find_ssh() {
  if [ -n "$1" ]; then
    case "$1" in /*) ;; *) die "--ssh-command must be an absolute path." ;; esac
    [ -x "$1" ] || die "--ssh-command is not executable."
    printf '%s' "$1"
    return 0
  fi
  for candidate in /usr/bin/ssh /bin/ssh; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  die "No ssh executable was found; provide --ssh-command."
}

configure_tunnel() {
  shift
  SSH_HOST_INPUT=
  SSH_USER_INPUT=
  IDENTITY_INPUT=
  KNOWN_HOSTS_INPUT=
  LOCAL_PORT_INPUT=
  TARGET_HOST_INPUT=
  TARGET_PORT_INPUT=
  SSH_COMMAND_INPUT=
  SSH_PORT_INPUT=22
  MONITOR_INTERVAL_INPUT=15
  START_TIMEOUT_INPUT=15
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --ssh-host) require_value "$@"; SSH_HOST_INPUT=$2; shift 2 ;;
      --ssh-user) require_value "$@"; SSH_USER_INPUT=$2; shift 2 ;;
      --identity-file) require_value "$@"; IDENTITY_INPUT=$2; shift 2 ;;
      --known-hosts-file) require_value "$@"; KNOWN_HOSTS_INPUT=$2; shift 2 ;;
      --local-port) require_value "$@"; LOCAL_PORT_INPUT=$2; shift 2 ;;
      --target-host) require_value "$@"; TARGET_HOST_INPUT=$2; shift 2 ;;
      --target-port) require_value "$@"; TARGET_PORT_INPUT=$2; shift 2 ;;
      --ssh-command) require_value "$@"; SSH_COMMAND_INPUT=$2; shift 2 ;;
      --ssh-port) require_value "$@"; SSH_PORT_INPUT=$2; shift 2 ;;
      --monitor-interval) require_value "$@"; MONITOR_INTERVAL_INPUT=$2; shift 2 ;;
      --start-timeout) require_value "$@"; START_TIMEOUT_INPUT=$2; shift 2 ;;
      *) die "Unknown configure-tunnel option: $1" ;;
    esac
  done
  [ -n "$SSH_HOST_INPUT" ] || die "--ssh-host is required."
  [ -n "$SSH_USER_INPUT" ] || die "--ssh-user is required."
  [ -n "$IDENTITY_INPUT" ] || die "--identity-file is required."
  [ -n "$KNOWN_HOSTS_INPUT" ] || die "--known-hosts-file is required."
  [ -n "$LOCAL_PORT_INPUT" ] || die "--local-port is required."
  [ -n "$TARGET_HOST_INPUT" ] || die "--target-host is required."
  [ -n "$TARGET_PORT_INPUT" ] || die "--target-port is required."

  assert_private_layout
  validate_host "--ssh-host" "$SSH_HOST_INPUT"
  validate_user "$SSH_USER_INPUT"
  validate_host "--target-host" "$TARGET_HOST_INPUT"
  validate_port "--ssh-port" "$SSH_PORT_INPUT"
  validate_port "--local-port" "$LOCAL_PORT_INPUT"
  validate_port "--target-port" "$TARGET_PORT_INPUT"
  validate_interval "--monitor-interval" "$MONITOR_INTERVAL_INPUT" 2 300
  validate_interval "--start-timeout" "$START_TIMEOUT_INPUT" 2 60
  SSH_COMMAND_INPUT=$(find_ssh "$SSH_COMMAND_INPUT")

  # Stop the managed processes before replacing their identity or endpoint.
  load_tunnel_config
  acquire_lock
  stop_monitor
  stop_agent >/dev/null 2>&1 || true
  stop_tunnel >/dev/null 2>&1 || true
  # Disable first as well as enabling last, so an interrupted reconfiguration
  # can never advertise a mixture of old and new forwarding values as active.
  write_config tunnel-enabled false
  copy_protected_file "$IDENTITY_INPUT" "$CONFIG_DIR/tunnel-identity" true
  copy_protected_file "$KNOWN_HOSTS_INPUT" "$CONFIG_DIR/tunnel-known-hosts" false
  write_config tunnel-ssh-command "$SSH_COMMAND_INPUT"
  write_config tunnel-ssh-host "$SSH_HOST_INPUT"
  write_config tunnel-ssh-user "$SSH_USER_INPUT"
  write_config tunnel-ssh-port "$SSH_PORT_INPUT"
  write_config tunnel-local-port "$LOCAL_PORT_INPUT"
  write_config tunnel-target-host "$TARGET_HOST_INPUT"
  write_config tunnel-target-port "$TARGET_PORT_INPUT"
  write_config tunnel-monitor-interval "$MONITOR_INTERVAL_INPUT"
  write_config tunnel-start-timeout "$START_TIMEOUT_INPUT"
  # Enable last so an interrupted configuration cannot expose a partial setup.
  write_config tunnel-enabled true
  release_lock
  printf 'Protected SSH tunnel configuration saved. Run start to activate it.\n'
}

disable_tunnel() {
  assert_private_layout
  load_tunnel_config
  acquire_lock
  stop_monitor
  stop_agent >/dev/null 2>&1 || true
  stop_tunnel >/dev/null 2>&1 || true
  write_config tunnel-enabled false
  rm -f \
    "$CONFIG_DIR/tunnel-identity" \
    "$CONFIG_DIR/tunnel-known-hosts" \
    "$CONFIG_DIR/tunnel-ssh-command" \
    "$CONFIG_DIR/tunnel-ssh-host" \
    "$CONFIG_DIR/tunnel-ssh-user" \
    "$CONFIG_DIR/tunnel-ssh-port" \
    "$CONFIG_DIR/tunnel-local-port" \
    "$CONFIG_DIR/tunnel-target-host" \
    "$CONFIG_DIR/tunnel-target-port" \
    "$CONFIG_DIR/tunnel-monitor-interval" \
    "$CONFIG_DIR/tunnel-start-timeout"
  release_lock
  printf 'Managed SSH tunnel disabled. Run start to monitor the Agent without it.\n'
}

command=${1:-}
case "$command" in
  start) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; start_stack ;;
  stop) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; stop_stack ;;
  restart) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; stop_stack; start_stack ;;
  status) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; status_stack ;;
  logs) [ "$#" -le 2 ] || { usage >&2; exit 2; }; assert_private_layout; show_logs "${2:-100}" ;;
  configure-tunnel) configure_tunnel "$@" ;;
  disable-tunnel) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; disable_tunnel ;;
  __monitor) [ "$#" -eq 1 ] || exit 2; monitor_loop ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
