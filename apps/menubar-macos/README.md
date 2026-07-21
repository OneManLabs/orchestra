# Orchestra Menu for macOS

Orchestra Menu is a native AppKit status-item application. It has no Dock icon and no standard window.

The menu-bar symbol shows the Core state:

- `◆` means healthy.
- `◆ 3` means that three jobs are active.
- `◆ !` means that an alert or approval needs attention.
- `◇` means that Core is disconnected.

## Connection data

The application reads this file:

```text
~/Library/Application Support/Fleet Canvas/desktop-connection.json
```

The `Fleet Canvas` directory name remains for upgrade compatibility. The product name is Orchestra.

The application requests `GET /api/v2/menu-bar` every five seconds. It sends the token only in the Authorization header. It does not write the token to a log.

## Mouse controls

A left click opens the full Orchestra popover. A right click shows **Open Orchestra Canvas** and **Quit Menu Icon**.

The optional [CodexBar](https://github.com/steipete/CodexBar) command supplies Codex use data. Orchestra keeps quota, reset, source, version, and credit data. It discards identity and credential data.

## Test

```bash
./apps/menubar-macos/scripts/test.sh
```

## Install

```bash
./apps/menubar-macos/scripts/install.sh
```

The script installs these files:

- `~/Applications/Orchestra Menu.app`
- `~/Library/LaunchAgents/com.fleetcanvas.menubar.plist`

To install without starting the LaunchAgent, use this command:

```bash
./apps/menubar-macos/scripts/install.sh --no-launch
```

The script uses an available Apple Development identity. If no identity is available, it uses ad hoc signing.
