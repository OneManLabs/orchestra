#!/bin/bash
set -euo pipefail
PURGE=false
INSTALL_DIR="/opt/fleet-canvas/agent"
SERVICE_USER="fleet-agent"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=true; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "Run this uninstaller as root." >&2; exit 1; }
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != / && "$INSTALL_DIR" != /usr && "$INSTALL_DIR" != /opt ]] || { echo "Unsafe --install-dir." >&2; exit 1; }
systemctl disable --now fleet-canvas-agent.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/fleet-canvas-agent.service
systemctl daemon-reload
rm -rf "$INSTALL_DIR"
rm -f /usr/local/sbin/fleet-agent-configure
if [[ "$PURGE" == true ]]; then
  created_user=false
  [[ -f /etc/fleet-canvas/.standalone-created-user ]] && created_user=true
  rm -rf /etc/fleet-canvas /var/lib/fleet-canvas-agent
  [[ "$created_user" == true ]] && userdel "$SERVICE_USER" >/dev/null 2>&1 || true
fi
echo "Fleet Agent removed."
