# Synology DSM user installation

Use this procedure when the DSM account has SSH access but no root access.

The Agent makes an outbound connection to Core. It does not open a NAS port.

This installation is not a native DSM package. DSM Task Scheduler is required. It must start the supervisor after a restart.

## Make the runtime

The bundle and Node.js executable must match the NAS architecture.

For most Synology devices, make a bundle without PTY support:

```sh
npm run build -w @fleet/agent
node packages/agent/install/build-bundle.mjs \
  --out /tmp/fleet-agent-synology \
  --omit-pty
```

This Agent cannot open an interactive terminal. It can report telemetry, run jobs, transfer files, and control its lifecycle.

Do not copy a macOS or Windows bundle to DSM.

Install Node.js 22 or a newer version from a trusted source. Get its full path:

```sh
command -v node
node --version
```

The installer copies Node.js and the runtime below `~/.fleet-canvas-agent`.

## Enroll the Agent

Make a one-use enrollment token with the `storage` role. Put it in an owner-only file:

```sh
umask 077
vi "$HOME/fleet-enrollment-token"
chmod 600 "$HOME/fleet-enrollment-token"
```

Run the installer as the DSM user that will own the Agent:

```sh
packages/agent/install/synology/install.sh \
  --bundle /tmp/fleet-agent-synology \
  --node /var/packages/Node.js_v22/target/usr/local/bin/node \
  --core-url 'https://fleet-core.example.ts.net:4780' \
  --role storage \
  --project-roots '/volume1/projects,/volume1/shared' \
  --enrollment-token-file "$HOME/fleet-enrollment-token"
```

The token file must meet these conditions:

- It is a regular file.
- It is not a symbolic link.
- The current user owns it.
- Group and other users have no access.

After a successful exchange, the installer deletes the token and starts with the device credential.

If enrollment fails, the installer stops the Agent and keeps the input token for analysis.

The installer rejects root and a destination outside the current user home.

## Control and logs

```sh
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" status
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" logs 200
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" restart
"$HOME/.fleet-canvas-agent/bin/fleet-boot-stack-user" stop
```

The helper checks the process owner and command before it sends a signal. This check prevents a stale PID file from stopping a different process.

Use `fleet-boot-stack-user` for normal control. Use `fleet-agent-user` only for Agent analysis.

## Optional SSH tunnel

Use this function only when DSM cannot route normal applications through Tailscale.

Make a dedicated SSH key. Restrict the key to port forwarding and the exact Core destination. Do not use a personal SSH key.

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

Set the Agent Core URL to `http://127.0.0.1:14780` during installation.

The tunnel binds only to `127.0.0.1`. It requires public-key authentication and strict host-key checks.

To disable the tunnel, use these commands:

```sh
"$CONTROL" disable-tunnel
"$CONTROL" start
```

Also restrict the key in the relay `authorized_keys` file. Use `restrict`, `port-forwarding`, and an exact `permitopen` value.

## Start after a NAS restart

Open **DSM Control Panel → Task Scheduler → Create → Triggered Task → User-defined script**.

1. Select the same DSM user that owns the Agent.
2. Do not select `root`.
3. Select **Boot-up**.
4. Enter the full start command.

   ```sh
   '/volume1/homes/example/.fleet-canvas-agent/bin/fleet-boot-stack-user' start
   ```

5. Save the task.
6. Select **Run** one time.
7. Check the local status.
8. Check the device state in Orchestra.

Use a full path because DSM tasks can have a small `PATH` and a different `HOME`.

## Update and remove

Run `install.sh` again with a compatible new bundle and Node.js executable.

If the device credential exists, do not give another enrollment token.

To remove the runtime and keep state, use this command:

```sh
"$HOME/.fleet-canvas-agent/bin/fleet-agent-user" uninstall
```

To delete the credential, state, and logs, use this command:

```sh
"$HOME/.fleet-canvas-agent/bin/fleet-agent-user" uninstall --purge
```

Remove the DSM Task Scheduler task manually. Revoke the device in Core after a purge.
