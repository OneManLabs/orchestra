# Orchestra Menu for macOS

This is the native AppKit status-item companion for Orchestra. It has no Dock
icon or ordinary windows. Its variable-width menu bar title reflects live Orchestra
Core state:

- `◆` — healthy
- `◆ 3` — three active jobs
- `◆ !` — warning, failure, approval, or critical alert
- `◇` — Orchestra Core disconnected

The app reads the existing connection from:

```text
~/Library/Application Support/Fleet Canvas/desktop-connection.json
```

The legacy `Fleet Canvas` support-directory name is intentionally retained for upgrade compatibility; the product and interface are branded Orchestra.

It polls `GET /api/v2/menu-bar` every five seconds. The Orchestra token is sent only
as the request Authorization header and is never logged.

Left-clicking the status item opens a second `Orchestra Canvas.app` process with
`--toggle-menubar`, allowing Electron's single-instance handler to toggle the
full Orchestra popover. Right-clicking offers **Open Orchestra Canvas** and
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

- `~/Applications/Orchestra Menu.app`
- `~/Library/LaunchAgents/com.fleetcanvas.menubar.plist`

Use `--no-launch` to install without loading the LaunchAgent:

```bash
./apps/menubar-macos/scripts/install.sh --no-launch
```

The installer is idempotent. It uses an available Apple Development
code-signing identity and falls back to ad hoc signing.
