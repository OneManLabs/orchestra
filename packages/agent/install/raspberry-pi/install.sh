#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINUX_INSTALLER="$SCRIPT_DIR/../linux/install.sh"
ARGS=(--role gateway --prevent-sleep-during-jobs)
while [[ $# -gt 0 ]]; do ARGS+=("$1"); shift; done
exec "$LINUX_INSTALLER" "${ARGS[@]}"
