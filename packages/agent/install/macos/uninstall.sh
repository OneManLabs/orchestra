#!/bin/bash
set -euo pipefail
PURGE=false
[[ "${1:-}" == "--purge" ]] && PURGE=true
[[ $EUID -eq 0 ]] || { echo "Run this uninstaller as root." >&2; exit 1; }
launchctl bootout system/com.fleetcanvas.agent >/dev/null 2>&1 || true
rm -f /Library/LaunchDaemons/com.fleetcanvas.agent.plist
rm -rf /usr/local/lib/fleet-canvas/agent
if [[ "$PURGE" == true ]]; then rm -rf "/Library/Application Support/Fleet Canvas"; fi
if [[ "$PURGE" == true ]]; then echo "Fleet Agent and local state removed."; else echo "Fleet Agent removed; local state retained."; fi
