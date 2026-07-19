#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/.build"
APP_PARENT="$HOME/Applications"
APP_PATH="$APP_PARENT/Orchestra Menu.app"
STAGING_PATH="$APP_PARENT/.Orchestra Menu.app.installing.$$"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PATH="$LAUNCH_AGENTS_DIR/com.fleetcanvas.menubar.plist"
LAUNCH_LABEL="com.fleetcanvas.menubar"
SHOULD_LAUNCH=true

if [[ "${1:-}" == "--no-launch" ]]; then
  SHOULD_LAUNCH=false
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--no-launch]" >&2
  exit 64
fi

"$SCRIPT_DIR/test.sh"

mkdir -p "$APP_PARENT" "$LAUNCH_AGENTS_DIR"
rm -rf "$STAGING_PATH"
mkdir -p "$STAGING_PATH/Contents/MacOS"

cp "$BUILD_DIR/Orchestra Menu" "$STAGING_PATH/Contents/MacOS/Orchestra Menu"
chmod 0755 "$STAGING_PATH/Contents/MacOS/Orchestra Menu"

cat > "$STAGING_PATH/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Orchestra Menu</string>
  <key>CFBundleExecutable</key>
  <string>Orchestra Menu</string>
  <key>CFBundleIdentifier</key>
  <string>com.fleetcanvas.menubar</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Orchestra Menu</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.0.0</string>
  <key>CFBundleVersion</key>
  <string>200</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSMultipleInstancesProhibited</key>
  <true/>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

echo -n "APPL????" > "$STAGING_PATH/Contents/PkgInfo"
plutil -lint "$STAGING_PATH/Contents/Info.plist" >/dev/null

SIGNING_IDENTITY="$(
  security find-identity -v -p codesigning 2>/dev/null \
    | awk -F '"' '/Apple Development:/ { print $2; exit }'
)"

if [[ -n "$SIGNING_IDENTITY" ]]; then
  codesign --force --options runtime --timestamp=none --sign "$SIGNING_IDENTITY" "$STAGING_PATH"
  echo "Signed with $SIGNING_IDENTITY"
else
  codesign --force --sign - "$STAGING_PATH"
  echo "No Apple Development identity found; used ad hoc signing"
fi

codesign --verify --deep --strict --verbose=1 "$STAGING_PATH"

rm -rf "$APP_PATH"
mv "$STAGING_PATH" "$APP_PATH"

cat > "$LAUNCH_AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_PATH/Contents/MacOS/Orchestra Menu</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
PLIST

plutil -lint "$LAUNCH_AGENT_PATH" >/dev/null

if "$SHOULD_LAUNCH"; then
  launchctl bootout "gui/$(id -u)/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"
fi

echo "Installed app: $APP_PATH"
echo "Installed login agent: $LAUNCH_AGENT_PATH"
if ! "$SHOULD_LAUNCH"; then
  echo "The menu app was not launched (--no-launch)."
fi
