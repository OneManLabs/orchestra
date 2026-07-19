# Fleet Canvas V2 development

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests -v
```

Run Core, a real local Agent, and the web renderer:

```bash
npm run dev:web
```

Run opt-in virtual development devices against a local Core:

```bash
npm run dev:simulator -- --count 12 --latency 250 --failure-rate 0.05
```

Simulator devices always advertise the `simulator` label and `Fleet Simulator` OS. The production UI never seeds devices or silently enables simulation.

The simulator sends its token in the WebSocket Authorization header and reports protocol version 2, matching the real Agent's registration hardening. It intentionally cannot execute real file, power, desktop, or Codex operations.

## Fault testing

The simulator supports variable latency and response failure injection. For offline behavior, stop the simulator process; Core will transition nodes after the configured heartbeat timeout. Pipeline tests should cover cycle rejection, parallel ready nodes, failure edges, approval gates, retry exhaustion, cancellation, and resume from failed nodes.

Never run real power-action tests on a development workstation. Agent tests leave `FLEET_ALLOW_POWER_ACTIONS` disabled and validate command selection/denial. Wake-on-LAN can be tested against a packet listener or isolated lab device.

## Protocol compatibility

V2 reports schema and Core/Agent protocol versions. New fields must remain backward compatible within a protocol range. A breaking command or response requires a protocol increment and an explicit Core compatibility check before rollout. Update canaries should include one device from each supported OS/architecture.

## SDKs and API

- `packages/sdk`: typed TypeScript/JavaScript REST client.
- `sdks/python`: dependency-free Python REST client.
- `packages/plugin-sdk`: strict plugin manifest and hook contracts.
- `docs/openapi.yaml`: OpenAPI 3.1 description of selected supported REST collections and key action endpoints. Runtime WebSocket frames and compatibility aliases remain defined by `@fleet/shared` and the server routes.

Core remains the authority for validation and policy. SDK types improve ergonomics but do not substitute for server-side checks.

## Container checks

Validate Compose interpolation before starting it, then build both runtime images:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker build -f deploy/docker/core.Dockerfile -t fleet-canvas/core:dev .
docker build -f deploy/docker/agent.Dockerfile -t fleet-canvas/agent:dev .
```

The Docker entrypoints can read `FLEET_TOKEN_FILE`, `FLEET_MASTER_KEY_FILE`, and `FLEET_ENROLLMENT_TOKEN_FILE`; they reject simultaneously setting a direct value and its file form.
