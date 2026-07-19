# Core background services

These definitions run the compiled `fleet-core` CLI as an always-on single Core. They do not install Node or build the repository.

## macOS launchd

Install the executable as `/usr/local/fleet-canvas/bin/fleet-core`, install `fleet-core-launchd` beside it with mode `0755`, and copy the plist to `/Library/LaunchDaemons/com.fleetcanvas.core.plist`.

Create `/Library/Application Support/Fleet Canvas/core.env` as a root-owned `0600` file containing shell-style assignments:

```bash
FLEET_TOKEN='<recovery-token>'
FLEET_MASTER_KEY='<vault-key>'
FLEET_PUBLIC_URL='https://fleet-core.example.ts.net'
FLEET_BACKUP_INTERVAL_HOURS=24
FLEET_BACKUP_RETENTION_COUNT=14
```

The wrapper refuses a symlink, non-root owner, or group/world-readable environment file before sourcing it. Ensure `/Library/Logs/Fleet Canvas` exists and is root writable, validate with `plutil -lint`, then load through `launchctl bootstrap system`.

## Linux systemd

Install the executable at `/opt/fleet-canvas/bin/fleet-core`, create user/group `fleet`, and create `/etc/fleet-canvas/core.env` owned by root with mode `0600`. Install `fleet-core.service`, run `systemctl daemon-reload`, and enable it.

The unit can write only `/var/lib/fleet-canvas`. If Core must access host-mounted artifact roots, add narrowly scoped `ReadWritePaths=` entries through a systemd drop-in; do not disable the full service sandbox.
