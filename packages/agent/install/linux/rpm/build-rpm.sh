#!/bin/bash
set -euo pipefail
BUNDLE="${1:-}"
OUTPUT_DIR="${2:-$PWD}"
[[ -n "$BUNDLE" && -f "$BUNDLE/dist/cli.js" && -f "$BUNDLE/node_modules/ws/package.json" ]] || { echo "Usage: $0 <runtime-bundle> [output-directory]" >&2; exit 2; }
if [[ ! -f "$BUNDLE/node_modules/node-pty/package.json" ]]; then
  [[ -f "$BUNDLE/.fleet-agent-omit-pty" && "$(<"$BUNDLE/.fleet-agent-omit-pty")" == "fleet-agent-omit-pty-v1" ]] || { echo "Bundle is missing node-pty without the appliance-mode marker." >&2; exit 2; }
fi
command -v rpmbuild >/dev/null || { echo "rpmbuild is required." >&2; exit 1; }
TOP="$(mktemp -d)"
trap 'rm -rf "$TOP"' EXIT
ASSET_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$TOP"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS} "$TOP/SOURCES/bundle"
cp -pR "$BUNDLE"/. "$TOP/SOURCES/bundle"/
cp "$ASSET_ROOT/systemd/fleet-canvas-agent.service" "$TOP/SOURCES/fleet-canvas-agent.service"
cp "$ASSET_ROOT/configure.mjs" "$TOP/SOURCES/fleet-agent-configure"
cp "$ASSET_ROOT/package-install.example.json" "$TOP/SOURCES/package-install.example.json"
cp "$(dirname "$0")/fleet-canvas-agent.spec" "$TOP/SPECS/"
rpmbuild --define "_topdir $TOP" -bb "$TOP/SPECS/fleet-canvas-agent.spec"
mkdir -p "$OUTPUT_DIR"
find "$TOP/RPMS" -type f -name '*.rpm' -exec cp {} "$OUTPUT_DIR"/ \;
echo "Built unsigned RPM package in $OUTPUT_DIR"
