# Fleet architecture

## Runtime topology

```text
Fleet Desktop ── HTTPS/WS ── Fleet Core ── authenticated WS ── Fleet Agent
     │                           │                                  │
 renderer sandbox          persistent state                local processes
 narrow IPC bridge         scheduling/events          Codex / PTY / telemetry
```

Core is the only rendezvous point. Agents establish outbound connections, so managed devices do not need a public listener. Desktop sends intent to Core; Core validates that the target is online, records the requested entity, dispatches a typed command, and relays streaming events back to all connected clients.

## State ownership

| State | Owner | Persistence |
| --- | --- | --- |
| Device identity and capability sample | Agent | Stable Agent ID/device credential; latest sample in Core |
| Canvas position and human labels | Core | Atomic JSON store |
| Projects and per-device paths | Core | Atomic JSON store |
| Job/session metadata and bounded events | Core | Atomic JSON store |
| Terminal process | Agent | Runtime only |
| Codex process and credentials | Agent | Runtime/local Codex home |
| Repositories and artifact bytes | Device/NAS | Outside Fleet Core; metadata/checksums in Core |

## Control flows

### Device registration

1. An administrator issues a short-lived enrollment token. Agent exchanges it over REST for a device-bound credential and stores that credential privately.
2. Agent opens `/ws/agent` with its bearer credential in the Authorization header. Browser clients carry their token in the `fleet-token.*` WebSocket subprotocol because the browser WebSocket API cannot set Authorization; URL query credentials are rejected.
3. Agent sends its stable identity, protocol version, platform, tool capabilities, project roots, and current telemetry. Core rejects an incompatible protocol or a credential bound to another device ID.
4. Core merges operator-owned fields such as canvas position and role, marks the device online, and broadcasts a device update.
5. Agent sends measured heartbeats. Core marks the device offline when samples stop beyond the configured threshold.

### Interactive terminal

1. Desktop requests a terminal on a specific online device and working directory.
2. Core creates a runtime terminal record and dispatches `terminal.start`.
3. Agent launches the platform shell through a pseudo-terminal.
4. Input, resize, output, and exit events travel through Core. Renderer input never receives direct shell privileges.

### Structured Codex session

1. Desktop or iOS chooses a device, browses an Agent-confined folder (or enters a path), and selects the project, approval policy, and sandbox. Folder creation is dispatched to the same Agent; a NAS path is eligible for live editing only when it is mounted and allowed on the execution device.
2. Agent starts the local Codex app-server over stdio and performs the initialize handshake.
3. Agent starts a thread rooted at the selected directory.
4. Turns and notifications stream as structured JSON-RPC. Fleet normalizes important events while retaining bounded raw metadata for forward compatibility.
5. App-server requests that require approval are persisted and shown in Desktop. The explicit operator decision is returned using the original JSON-RPC request ID.
6. Fleet's command center forwards an allowlisted set of official app-server UI requests for model, permissions, collaboration modes, review, compaction, goals, extensions, and account status. Cross-thread/workspace targets and host escape-hatch RPCs are rejected at Core.

### Codex session continuity

Resume and same-device fork call the Codex app-server's native thread operations. A cross-device fork or move asks the source Agent for the selected thread rollout, transfers that bounded file through Core in ordered chunks, verifies its declared size and SHA-256 digest on the destination Agent, and then asks the destination's local Codex app-server to resume or fork it. Project-backed sessions resolve the destination's registered project path instead of reusing a source-machine path. A move stops the source only after the destination is live; a fork leaves the source intact. Fleet never copies Codex authentication state.

### Queued job

1. Core validates the requested device and resolves the project path for that device.
2. Core persists the queued job before dispatch.
3. Agent runs a bounded Codex JSON job or explicit shell command and streams output.
4. Core records terminal status and a bounded history. Large artifacts remain in declared project/NAS paths.

## Trust boundaries

- **Renderer:** untrusted presentation tier. It has no Node APIs and can only call a path/method-limited preload bridge.
- **Electron main:** trusted local client proxy. It attaches remote authorization and owns the Core WebSocket.
- **Core:** trusted coordinator. Treat possession of its recovery token as administrative capability; prefer scoped API tokens and device-bound credentials for routine clients. Loopback is authenticated unless a test/dev process explicitly opts out.
- **Agent:** trusted executor for its host. It validates message shape and only implements named commands; it is not a generic inbound RPC listener.
- **Codex:** isolated according to the selected sandbox and approval policy, using local authentication.
- **Tailscale:** network identity and reachability layer. Fleet application authentication remains required because reachability alone is not authorization.

## Persistence behavior

Core writes a JSON state document with `0600` file permissions using write, fsync, and atomic rename. Client snapshots bound high-volume telemetry and event arrays, while full audit/telemetry retention remains an operator concern. On restart Core marks devices offline, closes runtime-only terminals, stops interactive-session metadata, fails active jobs/pipelines/teams, resets interrupted transfers to resumable pending state, and pauses active rollouts. Completed metadata, projects, settings, and canvas layout remain available.

## Extension points

The typed Agent protocol already covers PTY/Codex/jobs, confined files, verified Codex thread handoffs, power/Wake-on-LAN, diagnostics, signed-update preparation/staging/rollback requests, and remote-desktop launch adapters. New operations should retain the same pattern: declare capability, validate at Core, dispatch a narrow command, and stream an auditable result. Camera streaming, automatic NAS mounting, privileged package activation, device attestation, and arbitrary plugin execution are not protocol operations today.
