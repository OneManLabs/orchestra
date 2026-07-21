# Orchestra operations

## Production topology

Run one Core on an always-on computer. Install one native Agent on each managed device. Put Core, Agents, and clients behind Tailscale grants or another private network.

Core is the only control-plane listener. Agents make outbound WebSocket connections.

Core uses one active process and one atomic JSON state file. Do not increase the Kubernetes replica count. A multi-replica system requires a transactional database.

## Required secrets

- `FLEET_TOKEN` is the recovery credential.
- `FLEET_MASTER_KEY` is a 32-byte AES key for the vault.
- Each Agent has a device credential.
- Release signing uses credentials from an isolated release system.

Make local secrets with these commands:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Do not use `--allow-unauthenticated-loopback` with a proxy, container port, SSH forward, or shared local session.

Give each API token a base `read` or `write` scope. Add only the necessary sensitive scopes.

## Enroll an Agent

1. Make an enrollment token in Desktop or `POST /api/v2/enrollment/tokens`.
2. Copy the token one time.
3. Start the Agent with `FLEET_ENROLLMENT_TOKEN`.
4. Let the Agent exchange it at `/api/v2/enrollment/exchange`.
5. Make sure that the Agent stores the device credential with mode `0600`.
6. Set the device name, role, site, and group.
7. Check capability and trust data.

Revoke the device credential before you remove a device.

A QR enrollment code contains a credential. Protect it until it expires.

Read [Agent installation](../packages/agent/install/README.md) for unattended setup.

## Updates

An Agent release has platform, architecture, protocol range, SHA-256, URL, and optional signature data.

An update operation does these steps:

1. Selects devices or groups.
2. Checks platform and protocol compatibility.
3. Waits for the configured start time.
4. Updates the canary group.
5. Pauses for operator review.
6. Continues only after approval.

The Agent stages an update. It does not get root or SYSTEM permission.

`update.apply` returns `pending-service-installer`. A separate privileged service must examine and install the package.

Do not mark an update successful until the Agent reconnects with the expected version.

Production packages require external signing:

| Platform | Requirement |
| --- | --- |
| macOS | Developer ID Installer and notarization |
| Windows | Authenticode and timestamp service |
| Debian or Ubuntu | Signed APT repository |
| RPM | Signed RPM repository |
| Offline | Offline key and signed release manifest |

The GitHub workflow makes unsigned development packages. Do not publish them as stable packages.

## Containers and services

Docker Compose uses `deploy/.env` and secret files. It uses a read-only root file system and persistent state volumes.

The launchd and systemd files are in `deploy/core-services`.

The macOS user service reads `recovery-token` and `master-key` from the `com.fleetcanvas.core` Keychain service.

For file-based migration, set `FLEET_TOKEN_FILE` and `FLEET_MASTER_KEY_FILE`. Use regular files with owner-only access.

Do not put secrets in a launchd plist.

Before Kubernetes installation, make these objects:

```bash
kubectl create secret generic fleet-core-secrets \
  --from-file=FLEET_TOKEN=./fleet-token \
  --from-file=FLEET_MASTER_KEY=./fleet-master-key
kubectl create configmap fleet-core-config \
  --from-literal=public-url='https://fleet-core.example.ts.net'
kubectl apply -f deploy/kubernetes/core.yaml
```

## Backups

Core backups contain control-plane state, version data, and an integrity value. They do not contain artifact bytes.

Use this minimum schedule:

- Keep hourly backups for 48 hours.
- Keep daily backups for 30 days.
- Keep weekly encrypted backups at another site.
- Make NAS snapshots for artifacts.
- Test a restore each quarter.

## Restore Core

1. Stop Core.
2. Copy the damaged data directory for analysis.
3. Install the same or a compatible newer Core version.
4. Start Core in an isolated recovery period.
5. Stage the backup with `{ "confirm": true }`.
6. Make sure that the response has `restoreStaged: true` and `restartRequired: true`.
7. Restart Core.
8. Run diagnostics.
9. Check the audit chain.
10. Change keys if a compromise is possible.
11. Revoke unknown credentials.
12. Check storage and artifact hashes.

The restore operation does not replace live runtime objects. It applies the validated state only at the next start.

## Air-gapped use

- Bind Core to an isolated management network.
- Restrict HTTP destinations with `FLEET_HTTP_ALLOWED_HOSTS`.
- Control Agent child-process network access at the host or container.
- Transfer signed packages through the approved offline process.
- Use local model tools when external API calls are not permitted.
- Export audit data through an approved removable-media process.

An air-gapped system needs local certificate, identity, notification, package, and model services when applicable.

## Maintenance

Each day, check alerts, update drift, failed jobs, and backups.

Each week, check device trust, API tokens, enrollment tokens, and policy exceptions.

Change secrets and test restores on the approved schedule.

Set maintenance mode before hardware work. The scheduler does not send new work to a device in maintenance mode.

Redact a support bundle before you share it.

## Power control

Wake-on-LAN requires a target MAC address and an online relay Agent.

Idle power waits until terminals, sessions, jobs, transfers, desktop sessions, pipelines, and updates are clear. Maintenance mode and quiet hours stop idle power.

Sleep, restart, shutdown, lock, and logout require Agent opt-in. Use a pipeline approval before a destructive power operation.

UPS and smart-plug control are not included.
