# README image procedure

Use only an isolated Core with synthetic devices. Do not capture a real fleet for public documentation.

## Start the demo

```bash
npm run demo:readme
```

The command does these operations:

1. Makes a temporary state directory.
2. Selects unused loopback ports.
3. Makes a temporary token.
4. Starts Core, the simulator, and the web client.
5. Shows the local address.

Press `Ctrl+C` to stop the demo. The command stops the child processes and removes the temporary state.

The Orchestra System conversation uses synthetic data for `Demo Operator` and `@demo-gpu`.

## Image files

Put these PNG files in `docs/images/`:

1. `fleet-canvas.png` shows six to eight synthetic devices.
2. `orchestra-system.png` shows the synthetic system conversation.
3. `codex-command-center.png` shows a synthetic device and workspace.
4. `codex-device-mentions.png` shows `@` device selection.
5. `codex-slash-commands.png` shows the `/` command list.

Use `Demo Operator` for the public identity. Crop or blur a real user name, address, or local path.

## Permitted demo data

- Device names: `demo-node-1`, `demo-node-2`, and similar names
- DNS names: `*.example.ts.net`
- Tailscale examples: synthetic values that start at `100.64.0.10`
- Workspaces: `/Users/example/Projects/demo`, `/home/example/projects/demo`, or `C:\Users\example\Projects\demo`
- Jobs: `demo-build`, `sample-inference`, or `docs-preview`

## Check each image

1. Use temporary Core state.
2. Connect only the simulator.
3. Use a token that has no other use.
4. Close notifications and unrelated windows.
5. Check all names, paths, addresses, projects, sessions, terminals, and URLs.
6. Remove author and location metadata.
7. Make sure that no credential is visible.
8. Run the publication audit.

The demo can show presentation-only Codex controls. It does not start Codex or read Codex credentials.
