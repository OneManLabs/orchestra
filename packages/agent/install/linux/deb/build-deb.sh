#!/bin/bash
set -euo pipefail
BUNDLE="${1:-}"
OUTPUT="${2:-fleet-canvas-agent_2.0.0_$(dpkg --print-architecture).deb}"
[[ -n "$BUNDLE" && -f "$BUNDLE/dist/cli.js" ]] || { echo "Usage: $0 <runtime-bundle> [output.deb]" >&2; exit 2; }
[[ -f "$BUNDLE/node_modules/ws/package.json" ]] || { echo "Bundle is incomplete; rebuild it on this OS/architecture with build-bundle.mjs." >&2; exit 2; }
if [[ ! -f "$BUNDLE/node_modules/node-pty/package.json" ]]; then
  [[ -f "$BUNDLE/.fleet-agent-omit-pty" && "$(<"$BUNDLE/.fleet-agent-omit-pty")" == "fleet-agent-omit-pty-v1" ]] || { echo "Bundle is missing node-pty without the appliance-mode marker." >&2; exit 2; }
fi
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
ASSET_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/DEBIAN" "$ROOT/opt/fleet-canvas/agent" "$ROOT/lib/systemd/system" "$ROOT/usr/sbin" "$ROOT/usr/share/doc/fleet-canvas-agent"
cp -pR "$(dirname "$0")/DEBIAN"/. "$ROOT/DEBIAN"/
cp -pR "$BUNDLE"/. "$ROOT/opt/fleet-canvas/agent"/
cp "$ASSET_ROOT/configure.mjs" "$ROOT/usr/sbin/fleet-agent-configure"
cp "$ASSET_ROOT/package-install.example.json" "$ROOT/usr/share/doc/fleet-canvas-agent/package-install.example.json"
sed -i "s/^Architecture:.*/Architecture: $(dpkg --print-architecture)/" "$ROOT/DEBIAN/control"
sed -e 's|__INSTALL_DIR__|/opt/fleet-canvas/agent|g' -e 's|__ENV_FILE__|/etc/fleet-canvas/agent.env|g' -e 's|__SERVICE_USER__|fleet-agent|g' -e 's|__SERVICE_GROUP__|fleet-agent|g' \
  "$ASSET_ROOT/systemd/fleet-canvas-agent.service" > "$ROOT/lib/systemd/system/fleet-canvas-agent.service"
chmod 0755 "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/prerm" "$ROOT/DEBIAN/postrm" "$ROOT/usr/sbin/fleet-agent-configure"
dpkg-deb --build --root-owner-group "$ROOT" "$OUTPUT"
echo "Built unsigned DEB package: $OUTPUT"
