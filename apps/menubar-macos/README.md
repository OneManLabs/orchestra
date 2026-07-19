# Fleet Canvas Menu for macOS

This is the native AppKit status-item companion for Fleet Canvas. It has no Dock
icon or ordinary windows. Its variable-width menu bar title reflects live Fleet
Core state:

- `◆` — healthy
- `◆ 3` — three active jobs
- `◆ !` — warning, failure, approval, or critical alert
- `◇` — Fleet Core disconnected

The app reads the existing connection from:

```text
~/Library/Application Support/Fleet Canvas/desktop-connection.json
```

It polls `GET /api/v2/menu-bar` every five seconds. The Fleet token is sent only
as the request Authorization header and is never logged.

Left-clicking the status item opens a second `Fleet Canvas.app` process with
`--toggle-menubar`, allowing Electron's single-instance handler to toggle the
full Fleet Canvas popover. Right-clicking offers **Open Fleet Canvas** and
**Quit Menu Icon**.

## Test

```bash
./apps/menubar-macos/scripts/test.sh
```

## Install

```bash
./apps/menubar-macos/scripts/install.sh
```

This installs:

- `~/Applications/Fleet Canvas Menu.app`
- `~/Library/LaunchAgents/com.fleetcanvas.menubar.plist`

Use `--no-launch` to install without loading the LaunchAgent:

```bash
./apps/menubar-macos/scripts/install.sh --no-launch
```

The installer is idempotent. It uses an available Apple Development
code-signing identity and falls back to ad hoc signing.
