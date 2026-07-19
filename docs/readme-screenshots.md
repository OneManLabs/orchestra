# README screenshot workflow

README screenshots must be captured from an isolated development Core populated only with synthetic simulator devices. Never capture a real fleet for public documentation.

Start the complete isolated environment with:

```bash
npm run demo:readme
```

The launcher creates a fresh temporary state directory, selects unused loopback ports, generates a throwaway token, starts only Core, the simulator, and the web client, and prints the local URL. Press `Ctrl+C` when finished; the launcher stops its child processes and removes the temporary state.

The Orchestra System page is seeded with a fully synthetic `Demo Operator` conversation about `@demo-gpu`. Its device name, client name, temperatures, reference card, and timestamps are generated exclusively for the temporary documentation environment.

## Required images

Create PNG files in `docs/images/`:

1. `fleet-canvas.png` — the main Canvas with six to eight synthetic devices.
2. `orchestra-system.png` — the synthetic Core-owned system conversation.
3. `codex-command-center.png` — the Codex command interface using a synthetic device and generic workspace.

## Safe demo data

- Device names: `demo-node-1`, `demo-node-2`, and so on.
- Tailnet DNS: `*.example.ts.net` or another clearly reserved example domain.
- Tailscale-range examples: use simple synthetic values beginning at `100.64.0.10`.
- Workspaces: `/Users/example/Projects/demo`, `/home/example/projects/demo`, or `C:\\Users\\example\\Projects\\demo`.
- Jobs and projects: `demo-build`, `sample-inference`, `docs-preview`.

## Capture checklist

- Start Core with a temporary, isolated data directory.
- Connect only the development simulator; do not start a real Agent.
- Use a throwaway development token that has never been used elsewhere.
- Close browser tabs, notifications, menus, and system overlays that may expose personal information.
- Inspect every visible hostname, username, path, IP address, project name, session title, terminal line, notification, and URL.
- Inspect image metadata before committing and strip location or author metadata if present.
- Confirm no token or credential is visible, including partially masked values that could identify a real secret.
- Run the repository publication audit again after adding the files.

The README launcher enables the simulator's presentation-only Codex UI capability. It makes screenshot controls available and returns a synthetic thread identifier, but it never launches Codex, reads Codex credentials, or enables real file, power, or desktop operations.
