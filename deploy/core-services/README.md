# Core background services

These service files run the compiled `fleet-core` command. They do not install Node.js or build the repository.

## macOS launchd

1. Install `fleet-core` in `/usr/local/fleet-canvas/bin/`.
2. Install `fleet-core-launchd` in the same directory.
3. Set mode `0755` on `fleet-core-launchd`.
4. Copy the plist to `/Library/LaunchDaemons/com.fleetcanvas.core.plist`.
5. Make `/Library/Application Support/Fleet Canvas/core.env`.
6. Set owner `root` and mode `0600` on the file.

Put these settings in `core.env`:

```bash
FLEET_TOKEN='<recovery-token>'
FLEET_MASTER_KEY='<vault-key>'
FLEET_PUBLIC_URL='https://fleet-core.example.ts.net'
FLEET_BACKUP_INTERVAL_HOURS=24
FLEET_BACKUP_RETENTION_COUNT=14
```

The wrapper rejects an unsafe environment file. It rejects a symbolic link, a non-root owner, or group and world read access.

Make sure that `/Library/Logs/Fleet Canvas` exists. Make sure that root can write to it.

Check the plist with `plutil -lint`. Then, load it with `launchctl bootstrap system`.

## Linux systemd

1. Install `fleet-core` in `/opt/fleet-canvas/bin/`.
2. Make the `fleet` user and group.
3. Make `/etc/fleet-canvas/core.env`.
4. Set owner `root` and mode `0600` on the file.
5. Install `fleet-core.service`.
6. Run `systemctl daemon-reload`.
7. Enable the service.

The service can write only to `/var/lib/fleet-canvas`.

If Core needs another write path, add a specific `ReadWritePaths=` value in a systemd drop-in. Do not disable the service sandbox.
