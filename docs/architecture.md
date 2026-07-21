# Orchestra architecture

## Topology

```text
Orchestra client ── HTTPS/WS ── Orchestra Core ── authenticated WS ── Orchestra Agent
      │                              │                                      │
 user interface                 persistent state                     local processes
 narrow bridge                  schedule and events             Codex, PTY, telemetry
```

Core is the connection point. Agents make outbound connections. Thus, managed devices do not need a public listener.

A client sends a request to Core. Core validates the request and the target. Core records the work and sends a typed command to the Agent. Core sends result events to connected clients.

## State ownership

| State | Owner | Storage |
| --- | --- | --- |
| Device identity and capability data | Agent | Agent credential and latest Core sample |
| Canvas position and labels | Core | Atomic JSON store |
| Projects and device paths | Core | Atomic JSON store |
| Job and session data | Core | Atomic JSON store |
| Terminal process | Agent | Runtime only |
| Codex process and credentials | Agent | Runtime and local Codex home |
| Repositories and artifact bytes | Device or NAS | Outside Core |

## Device enrollment

1. An administrator makes a short-life enrollment token.
2. The Agent exchanges the token for a device credential.
3. The Agent stores the credential in its private state directory.
4. The Agent opens `/ws/agent` with the credential in the Authorization header.
5. The Agent sends identity, protocol, platform, capability, root, and telemetry data.
6. Core validates the protocol and credential binding.
7. Core adds operator data and marks the device online.
8. The Agent sends measured heartbeat data.
9. Core marks the device offline when heartbeat data stops.

Browser clients use the `fleet-token.*` WebSocket subprotocol. Browser WebSocket APIs cannot set the Authorization header. Core rejects credentials in URL query data.

## Terminal session

1. The client requests a terminal on an online device.
2. Core makes a terminal record.
3. Core sends `terminal.start` to the Agent.
4. The Agent starts the platform shell in a pseudo-terminal.
5. Core transfers input, size, output, and exit events.

The renderer does not get direct shell access.

## Codex session

1. The client selects a device and a permitted directory.
2. The client selects the project, approval policy, and sandbox.
3. The Agent starts the local Codex app-server.
4. The Agent completes the initialization handshake.
5. The Agent starts a thread in the selected directory.
6. Core transfers structured JSON-RPC events.
7. Core stores approval requests.
8. The client sends the operator decision with the original request ID.

Core permits a restricted set of app-server interface requests. Core rejects cross-workspace targets and host escape requests.

## Session transfer

A same-device resume or fork uses the native Codex thread operation.

For a transfer to another device, Orchestra does these steps:

1. The source Agent exports one bounded thread file.
2. Core transfers ordered chunks.
3. The destination Agent checks the size and SHA-256 digest.
4. The destination Agent maps the destination project path.
5. The destination Codex app-server resumes or forks the thread.

A move stops the source only after the destination starts. A fork keeps the source active. Orchestra does not copy Codex authentication data.

## Job

1. Core validates the target device.
2. Core resolves the project path.
3. Core stores the queued job.
4. The Agent runs the Codex job or shell command.
5. The Agent sends output events.
6. Core stores final status and a bounded event history.

Large artifacts stay in project or NAS paths.

## Trust boundaries

- The renderer is an untrusted user-interface layer.
- Electron main is a trusted local proxy.
- Core is the trusted policy and coordination point.
- An Agent is the trusted executor for one device.
- Codex uses the selected sandbox and approval policy.
- Tailscale supplies network identity and access.
- Orchestra authentication is still necessary on a tailnet.

## Persistence

Core writes JSON state with mode `0600`. It uses write, `fsync`, and atomic rename operations.

After a restart, Core does these operations:

- Marks devices offline.
- Closes runtime terminals.
- Stops interactive session data.
- Fails active jobs, pipelines, and teams.
- Sets incomplete transfers to a restartable state.
- Pauses active update operations.

Core keeps completed data, projects, settings, and Canvas positions.

## Extension rule

Use this pattern for a new Agent operation:

1. Declare the capability.
2. Validate the request at Core.
3. Send one restricted command.
4. Send an auditable result.

Camera streaming, automatic NAS mounts, privileged package activation, device attestation, and arbitrary plugin execution are not current protocol operations.
