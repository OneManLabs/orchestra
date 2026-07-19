# NAS deployment

Fleet Core runs on any NAS that supports Docker Compose and an `amd64` or `arm64` Node 22 image. Copy `deploy/compose.yaml` and `deploy/.env.example`, set secrets, and mount a NAS dataset at `/storage`.

## Synology Container Manager / QNAP Container Station

1. Create dedicated `fleet-core`, `fleet-artifacts`, and `fleet-backups` shared folders.
2. Grant the container identity access only to those folders.
3. Copy `deploy/.env.example` to `deploy/.env`, replace the recovery/vault secrets, set `FLEET_PUBLIC_URL`, and point `FLEET_STORAGE_ROOT` at the mounted artifact share. Compose exposes those values to containers through secret files.
4. Bind port 4780 to the NAS Tailscale address or firewall it to the tailnet; never expose it through router port forwarding.
5. Mount SMB/NFS datasets on the NAS host first, then register their container-visible root paths in Storage. V2 validates provider metadata and local roots; it does not invoke privileged host mount commands.
6. Configure automatic encrypted Core backups and snapshot/replicate both the Core data volume and artifact share off-site. Core backups contain control-plane state, not artifact bytes.

Containerized Agents are useful for repository and NAS jobs, but cannot safely provide host sleep, desktop, GPU, or complete hardware telemetry. Install the native Agent on compute devices for those features.
