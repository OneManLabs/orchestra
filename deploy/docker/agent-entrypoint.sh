#!/bin/sh
set -eu

umask 077

read_secret() {
  variable="$1"
  file="$2"
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    echo "Fleet Canvas secret file for $variable is not a readable regular file." >&2
    exit 78
  fi
  value=$(sed -e 's/[[:space:]]*$//' "$file")
  if [ -z "$value" ]; then
    echo "Fleet Canvas secret file for $variable is empty." >&2
    exit 78
  fi
  case "$variable" in
    FLEET_TOKEN) FLEET_TOKEN="$value"; export FLEET_TOKEN ;;
    FLEET_ENROLLMENT_TOKEN) FLEET_ENROLLMENT_TOKEN="$value"; export FLEET_ENROLLMENT_TOKEN ;;
    *) echo "Unsupported Fleet Canvas secret variable." >&2; exit 78 ;;
  esac
}

if [ -n "${FLEET_TOKEN_FILE:-}" ]; then
  [ -z "${FLEET_TOKEN:-}" ] || { echo "Set only FLEET_TOKEN or FLEET_TOKEN_FILE, not both." >&2; exit 78; }
  read_secret FLEET_TOKEN "$FLEET_TOKEN_FILE"
fi
if [ -n "${FLEET_ENROLLMENT_TOKEN_FILE:-}" ]; then
  [ -z "${FLEET_ENROLLMENT_TOKEN:-}" ] || { echo "Set only FLEET_ENROLLMENT_TOKEN or FLEET_ENROLLMENT_TOKEN_FILE, not both." >&2; exit 78; }
  read_secret FLEET_ENROLLMENT_TOKEN "$FLEET_ENROLLMENT_TOKEN_FILE"
fi

exec "$@"
