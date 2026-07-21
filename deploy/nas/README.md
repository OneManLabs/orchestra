# NAS installation

Core can run on a NAS that supports Docker Compose. The NAS must support an `amd64` or `arm64` Node.js 22 image.

Copy `deploy/compose.yaml` and `deploy/.env.example`. Set the secrets. Mount a NAS data set at `/storage`.

## Synology or QNAP

1. Make separate shares for Core, artifacts, and backups.
2. Give the container access only to these shares.
3. Copy `deploy/.env.example` to `deploy/.env`.
4. Set the recovery token, vault key, and `FLEET_PUBLIC_URL`.
5. Set `FLEET_STORAGE_ROOT` to the mounted artifact share.
6. Bind port 4780 to the NAS Tailscale address.
7. Block public access to port 4780.
8. Mount SMB or NFS data sets on the NAS host.
9. Register the container path in Orchestra Storage.
10. Configure encrypted Core backups.
11. Copy Core backups and artifact snapshots to another site.

Core backups contain control-plane state. They do not contain artifact bytes.

A container Agent can run repository and NAS jobs. It cannot give complete host power, desktop, GPU, or telemetry control.

Install a native Agent on compute devices that need these functions.
