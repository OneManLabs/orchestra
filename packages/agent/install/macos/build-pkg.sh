#!/bin/bash
set -euo pipefail
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
VERSION="${VERSION:-2.0.0}"
OUTPUT="${1:-fleet-canvas-agent-$VERSION-unsigned.pkg}"
BUNDLE="${2:-${BUNDLE:-}}"
[[ -n "$BUNDLE" && -f "$BUNDLE/dist/cli.js" ]] || { echo "Usage: $0 [output.pkg] <runtime-bundle>" >&2; exit 2; }
[[ -f "$BUNDLE/node_modules/ws/package.json" ]] || { echo "Runtime bundle is incomplete for macOS." >&2; exit 2; }
if [[ ! -f "$BUNDLE/node_modules/node-pty/package.json" ]]; then
  [[ -f "$BUNDLE/.fleet-agent-omit-pty" && "$(<"$BUNDLE/.fleet-agent-omit-pty")" == "fleet-agent-omit-pty-v1" ]] || { echo "Runtime bundle is missing node-pty without the appliance-mode marker." >&2; exit 2; }
fi
mkdir -p "$ROOT/usr/local/share/fleet-canvas-agent-installer"
cp -pR "$(cd "$(dirname "$0")/.." && pwd)" "$ROOT/usr/local/share/fleet-canvas-agent-installer/install"
cp -pR "$BUNDLE" "$ROOT/usr/local/share/fleet-canvas-agent-installer/bundle"
pkgbuild --root "$ROOT" --scripts "$(cd "$(dirname "$0")" && pwd)/pkg/scripts" --identifier com.fleetcanvas.agent --version "$VERSION" --install-location / "$OUTPUT"
echo "Built unsigned package template: $OUTPUT"
