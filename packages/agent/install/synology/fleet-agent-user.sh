#!/bin/sh
set -eu

# This helper is intentionally POSIX sh: Synology DSM ships BusyBox ash even
# when bash is not installed. It is copied to <install-root>/bin and derives
# every other path from that location, so DSM Task Scheduler does not need a
# correctly populated HOME.
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
BASE_DIR=$(CDPATH= cd -P "$SCRIPT_DIR/.." && pwd)
RUNTIME_DIR="$BASE_DIR/runtime"
CONFIG_DIR="$BASE_DIR/config"
DATA_DIR="$BASE_DIR/data"
RUN_DIR="$BASE_DIR/run"
LOG_DIR="$BASE_DIR/logs"
NODE_BIN="$BASE_DIR/bin/node"
PID_FILE="$RUN_DIR/agent.pid"
LOCK_DIR="$RUN_DIR/start.lock"
LOG_FILE="$LOG_DIR/agent.log"

usage() {
  cat <<'EOF'
Usage: fleet-agent-user {start|stop|restart|status|logs|uninstall}

  start                 Start Fleet Agent with nohup
  stop                  Stop Fleet Agent (TERM, then KILL after 20 seconds)
  restart               Stop and start Fleet Agent
  status                Report status; exits 0 when running, 3 when stopped
  logs [lines]           Print the most recent log lines (default: 100)
  uninstall [--purge]   Remove runtime/config; --purge also deletes state/logs

Reboot persistence is not provided by nohup. Add the absolute `start` command
to Synology DSM Control Panel > Task Scheduler as a boot-up task for this user.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

read_value() {
  value_file="$CONFIG_DIR/$1"
  [ -f "$value_file" ] || return 1
  IFS= read -r value < "$value_file" || [ -n "$value" ]
  printf '%s' "$value"
}

read_pid() {
  [ -f "$PID_FILE" ] || return 1
  IFS= read -r pid < "$PID_FILE" || return 1
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$pid" -gt 1 ] || return 1
  printf '%s' "$pid"
}

owns_pid() {
  owned_pid=$1
  kill -0 "$owned_pid" 2>/dev/null || return 1

  # Linux/DSM exposes the complete argv without depending on a particular ps
  # implementation. Never signal a reused PID that is not our Agent process.
  if [ -r "/proc/$owned_pid/cmdline" ]; then
    tr '\000' '\n' < "/proc/$owned_pid/cmdline" 2>/dev/null |
      grep -F -x "$RUNTIME_DIR/dist/cli.js" >/dev/null 2>&1
    return $?
  fi

  # Conservative fallback for non-DSM development environments.
  command_line=$(ps -p "$owned_pid" -o command= 2>/dev/null || true)
  case "$command_line" in
    *"$RUNTIME_DIR/dist/cli.js"*) return 0 ;;
    *) return 1 ;;
  esac
}

running_pid() {
  current_pid=$(read_pid) || return 1
  if owns_pid "$current_pid"; then
    printf '%s' "$current_pid"
    return 0
  fi
  rm -f "$PID_FILE"
  return 1
}

acquire_lock() {
  mkdir -p "$RUN_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT HUP INT TERM
    return 0
  fi

  # A lock older than five minutes is stale (for example after a hard reset).
  if [ -d "$LOCK_DIR" ]; then
    now=$(date +%s)
    modified=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || printf '0')
    case "$modified" in ''|*[!0-9]*) modified=0 ;; esac
    if [ $((now - modified)) -gt 300 ]; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT HUP INT TERM
        return 0
      fi
    fi
  fi
  die "Another Fleet Agent lifecycle command is running."
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  trap - EXIT HUP INT TERM
}

start_agent() {
  acquire_lock
  if agent_pid=$(running_pid); then
    release_lock
    printf 'Fleet Agent is already running (PID %s).\n' "$agent_pid"
    return 0
  fi

  [ -x "$NODE_BIN" ] || die "Bundled Node.js is missing or not executable: $NODE_BIN"
  [ -f "$RUNTIME_DIR/dist/cli.js" ] || die "Fleet Agent runtime is missing: $RUNTIME_DIR/dist/cli.js"

  core_url=$(read_value core-url) || die "Fleet Core URL is not configured."
  role=$(read_value role) || die "Fleet device role is not configured."
  mkdir -p "$DATA_DIR" "$RUN_DIR" "$LOG_DIR"
  chmod 700 "$DATA_DIR" "$RUN_DIR" "$LOG_DIR"

  set -- env \
    "FLEET_CORE_URL=$core_url" \
    "FLEET_DEVICE_ROLE=$role" \
    "FLEET_AGENT_DATA_DIR=$DATA_DIR"

  # DSM package binaries are not included in the minimal PATH used by Task
  # Scheduler and non-interactive SSH sessions. Give the Agent the verified
  # package path explicitly so Tailscale identity and peer telemetry work.
  for tailscale_command in \
    /usr/local/bin/tailscale \
    /var/packages/Tailscale/target/bin/tailscale
  do
    if [ -x "$tailscale_command" ]; then
      set -- "$@" "FLEET_TAILSCALE_COMMAND=$tailscale_command"
      break
    fi
  done

  if project_roots=$(read_value project-roots); then
    set -- "$@" "FLEET_PROJECT_ROOTS=$project_roots"
  fi
  if device_name=$(read_value device-name); then
    set -- "$@" "FLEET_DEVICE_NAME=$device_name"
  fi
  if enrollment_token=$(read_value enrollment-token); then
    set -- "$@" "FLEET_ENROLLMENT_TOKEN=$enrollment_token"
  fi
  if allow_power=$(read_value allow-power-actions); then
    set -- "$@" "FLEET_ALLOW_POWER_ACTIONS=$allow_power"
  fi
  if prevent_sleep=$(read_value prevent-sleep-during-jobs); then
    set -- "$@" "FLEET_PREVENT_SLEEP_DURING_JOBS=$prevent_sleep"
  fi

  # Restrictive creation mode applies to the PID, logs, and Agent credential.
  umask 077
  nohup "$@" "$NODE_BIN" "$RUNTIME_DIR/dist/cli.js" >> "$LOG_FILE" 2>&1 </dev/null &
  agent_pid=$!
  pid_tmp="$PID_FILE.$agent_pid.tmp"
  printf '%s\n' "$agent_pid" > "$pid_tmp"
  mv "$pid_tmp" "$PID_FILE"

  # Catch immediate loader/configuration failures without claiming success.
  sleep 1
  if ! owns_pid "$agent_pid"; then
    rm -f "$PID_FILE"
    release_lock
    printf 'Fleet Agent exited during startup. Recent log output:\n' >&2
    tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
    return 1
  fi

  release_lock
  printf 'Fleet Agent started (PID %s). Log: %s\n' "$agent_pid" "$LOG_FILE"
}

stop_agent() {
  acquire_lock
  if ! agent_pid=$(running_pid); then
    release_lock
    printf 'Fleet Agent is not running.\n'
    return 0
  fi

  kill "$agent_pid" 2>/dev/null || true
  remaining=20
  while [ "$remaining" -gt 0 ] && owns_pid "$agent_pid"; do
    sleep 1
    remaining=$((remaining - 1))
  done
  if owns_pid "$agent_pid"; then
    printf 'Fleet Agent did not stop after 20 seconds; sending KILL.\n' >&2
    kill -9 "$agent_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  release_lock
  printf 'Fleet Agent stopped.\n'
}

status_agent() {
  if agent_pid=$(running_pid); then
    printf 'Fleet Agent is running (PID %s).\n' "$agent_pid"
    printf 'Runtime: %s\nLog: %s\n' "$RUNTIME_DIR" "$LOG_FILE"
    return 0
  fi
  printf 'Fleet Agent is stopped.\n'
  return 3
}

show_logs() {
  lines=${1:-100}
  case "$lines" in ''|*[!0-9]*) die "Log line count must be a positive integer." ;; esac
  [ "$lines" -gt 0 ] || die "Log line count must be a positive integer."
  [ -f "$LOG_FILE" ] || die "No Fleet Agent log exists yet: $LOG_FILE"
  tail -n "$lines" "$LOG_FILE"
}

uninstall_agent() {
  purge=false
  case "${1:-}" in
    '') ;;
    --purge) purge=true ;;
    *) die "Usage: fleet-agent-user uninstall [--purge]" ;;
  esac

  boot_stack="$BASE_DIR/bin/fleet-boot-stack-user"
  if [ -x "$boot_stack" ]; then
    "$boot_stack" stop >/dev/null 2>&1 ||
      die "Unable to stop the Fleet boot stack. Stop it before uninstalling the Agent."
  fi
  stop_agent
  rm -rf "$RUNTIME_DIR" "$CONFIG_DIR"
  rm -f "$NODE_BIN"

  if [ "$purge" = true ]; then
    rm -rf "$DATA_DIR" "$LOG_DIR" "$RUN_DIR"
  else
    rm -rf "$RUN_DIR"
    printf 'Device credential, state, and logs were preserved under %s.\n' "$BASE_DIR"
    printf 'Remove that directory manually if the retained state is no longer needed.\n'
  fi

  printf 'Remove any DSM Task Scheduler boot task that invokes this helper.\n'
  rm -f "$BASE_DIR/bin/fleet-boot-stack-user"
  rm -f "$BASE_DIR/bin/fleet-agent-user"
  rmdir "$BASE_DIR/bin" "$BASE_DIR" 2>/dev/null || true
  printf 'Fleet Agent runtime and user service helper were uninstalled.\n'
}

command=${1:-}
case "$command" in
  start) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; start_agent ;;
  stop) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; stop_agent ;;
  restart) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; stop_agent; start_agent ;;
  status) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; status_agent ;;
  logs) [ "$#" -le 2 ] || { usage >&2; exit 2; }; show_logs "${2:-100}" ;;
  uninstall) [ "$#" -le 2 ] || { usage >&2; exit 2; }; uninstall_agent "${2:-}" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
