#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/.build"
TARGET_TRIPLE="$(uname -m)-apple-macos13.0"

mkdir -p "$BUILD_DIR"

xcrun swiftc \
  -target "$TARGET_TRIPLE" \
  -swift-version 5 \
  -warnings-as-errors \
  "$PROJECT_DIR/Sources/FleetMenuModel.swift" \
  "$PROJECT_DIR/Tests/FleetMenuModelTests.swift" \
  -o "$BUILD_DIR/FleetMenuModelTests"

"$BUILD_DIR/FleetMenuModelTests"

xcrun swiftc \
  -target "$TARGET_TRIPLE" \
  -swift-version 5 \
  -warnings-as-errors \
  -O \
  -whole-module-optimization \
  -framework AppKit \
  -framework Foundation \
  "$PROJECT_DIR/Sources/FleetMenuModel.swift" \
  "$PROJECT_DIR/Sources/FleetCanvasMenuApp.swift" \
  -o "$BUILD_DIR/Orchestra Menu"

echo "Orchestra Menu native app compile passed"
