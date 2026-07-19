# Synology DSM user-mode installation

Use this path when you have SSH access to a Synology account but cannot or do
not want to install a root-owned DSM package, `systemd` unit, or `sudo` service.
The Agent makes an outbound connection to Fleet Core, so no inbound NAS port is
opened.

This is a user-mode service helper, not a native DSM package. The boot-stack
supervisor keeps the Agent alive after SSH disconnects and restarts it if it
exits. **DSM Task Scheduler is required to start the supervisor again after the
NAS reboots.**

## Prepare the runtime

The bundle and Node executable must match the NAS architecture and DSM runtime.
Native `node-pty` builds are often unavailable on appliances, so the recommended
Synology bundle intentionally disables only interactive PTY terminals:

```sh
npm run build -w @fleet/agent
node packages/agent/install/build-bundle.mjs \
  --out /tmp/fleet-agent-synology \
  --omit-pty
```

An `--omit-pty` Agent still reports real telemetry, runs queued jobs, transfers
files, connects projects/storage, and receives lifecycle commands. It reports
the terminal feature as unsupported instead of pretending a damaged native PTY
is usable. Build the bundle on a compatible Linux machine or NAS; do not copy a
macOS or Windows bundle to DSM.

Install Node.js 22 or newer from a trusted Synology package or your managed
runtime location and determine its absolute path:

```sh
command -v node
node --version
```

The installer copies that executable and the complete runtime beneath
`~/.fleet-canvas-agent`, so later lifecycle commands do not depend on the
minimal PATH used by DSM Task Scheduler.

## Enroll

In Fleet Canvas, issue a one-use enrollment token for the NAS with the `storage`
role. Place it in an owner-only file without putting it in shell history:

```sh
umask 077
vi "$HOME/fleet-enrollment-token"
chmod 600 "$HOME/fleet-enrollment-token"
```

Run the installer as the same unprivileged DSM user that should own the Agent:

```sh
packages/agent/install/synology/install.sh \
  --bundle /tmp/fleet-agent-synology \
  --node /var/packages/Node.js_v22/target/usr/local/bin/node \
  --core-url 'https://fleet-core.example.ts.net:4780' \
  --role storage \
  --project-roots '/volume1/projects,/volume1/shared' \
  --enrollment-token-file "$HOME/fleet-enrollment-token"
```

The token input must be a regular, non-symlink file owned by the current user
with no group/other permissions (normally mode `0600`). On successful exchange,
the installer stops the first process, deletes both its protected working copy
and the input token file, then restarts using the device-bound credential. If
enrollment fails, it stops the Agent and deliberately leaves the input token in
place so the failure can be diagnosed and retried.

The installer refuses to run as root and refuses an install root outside the
current user's home. Power actions remain disabled by default; in user mode,
enabling the Agent-side gate does not grant the DSM account permission to shut
down the NAS.

## Lifecycle and logs

```sh
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" status
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" logs 200
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" restart
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" stop
```

Runtime state and logs are kept under `~/.fleet-canvas-agent` with a restrictive
umask. Both helpers verify the saved PID's operating-system owner and command
line before signaling it, which prevents a stale or replaced PID file from
terminating an unrelated DSM process.

The lower-level `fleet-agent-user` command remains available when diagnosing
the Agent itself. Normal lifecycle and DSM boot tasks should use
`fleet-boot-stack-user`, which supervises the complete dependency chain.

## Optional managed SSH tunnel

Some DSM installations can join a Tailscale tailnet but do not route connections
from ordinary host applications through the Tailscale interface. In that case,
the boot stack can own a strict local-forward tunnel through a reachable SSH
relay. It establishes and probes the loopback listener before starting the
Agent, stops the Agent if the tunnel fails, then repairs the tunnel and Agent in
dependency order.

Create a dedicated key with no passphrase for unattended boot, restrict that
key on the relay to port forwarding and the exact Fleet Core destination, and
pin the relay host key. Never reuse a personal login key. Configure the stack:

```sh
CONTROL="$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user"

"$CONTROL" configure-tunnel \
  --ssh-host 'fleet-relay.example.ts.net' \
  --ssh-user 'fleet-tunnel' \
  --identity-file "$HOME/.ssh/fleet-core-tunnel" \
  --known-hosts-file "$HOME/.ssh/known_hosts" \
  --local-port 14780 \
  --target-host '100.64.0.10' \
  --target-port 4780

"$CONTROL" start
"$CONTROL" status
```

Set the Agent's Core URL to the matching loopback endpoint, for example
`http://127.0.0.1:14780`, during installation. Host names and IPv4 addresses
are supported for the relay and target. The tunnel binds only to `127.0.0.1`,
uses public-key authentication in batch mode, requires strict host-key
verification, and disables use of ambient SSH configuration.

`configure-tunnel` validates and copies the private key and pinned host keys
into the install-root `config` directory as owner-only files. The input files
are not deleted. Other tunnel values are also stored as mode-0600, single-line
files under that directory; no key or configuration content is printed by
`status` or `logs`. To return to direct Core connectivity:

```sh
"$CONTROL" disable-tunnel
"$CONTROL" start
```

The relay's `authorized_keys` entry should independently constrain what the NAS
key can do. For OpenSSH, use source restrictions where practical together with
`restrict,port-forwarding,permitopen="100.64.0.10:4780"` and a harmless forced
command. The client-side restrictions in Fleet Canvas complement, but do not
replace, that server-side boundary.

## Start after reboot (required)

Open **DSM Control Panel → Task Scheduler → Create → Triggered Task →
User-defined script**:

1. Run as the same DSM user used for installation, never `root`.
2. Select the **Boot-up** event.
3. Enter the absolute command printed by the installer, for example:

   ```sh
   '/volume1/homes/alex/.fleet-canvas-agent/bin/fleet-boot-stack-user' start
   ```

4. Save the task and use **Run** once to verify it; then confirm `status` and the
   device's online state in Fleet Canvas.

The absolute helper path is important because DSM scheduled tasks can have a
minimal PATH and an unexpected HOME.

## Upgrade and uninstall

Re-run `install.sh` with a compatible new bundle and Node executable. If a
device credential already exists, omit `--enrollment-token-file`; the installer
preserves state and restarts the Agent with the new runtime.

Uninstalling preserves the device credential, state, and logs by default. The
Agent helper first stops the boot supervisor and its managed tunnel:

```sh
"$HOME/.fleet-canvas-agent/bin/fleet-agent-user" uninstall
```

Use `--purge` to remove them as well, then revoke/decommission the device in
Fleet Core. In either case, manually remove the DSM Task Scheduler boot task:

```sh
"$HOME/.fleet-canvas-agent/bin/fleet-agent-user" uninstall --purge
```
