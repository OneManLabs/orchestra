# Orchestra development

## Verify the repository

```bash
npm install
npm run typecheck
npm test
npm run build
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests -v
```

## Start local services

Start Core, one local Agent, and the web client:

```bash
npm run dev:web
```

Start synthetic devices:

```bash
npm run dev:simulator -- --count 12 --latency 250 --failure-rate 0.05
```

Simulator devices have the `simulator` label and the `Orchestra Simulator` operating-system name. The simulator cannot do real file, power, desktop, or Codex operations.

## Test faults

The simulator can add latency and response failures. Stop the simulator to test offline behavior.

Pipeline tests must include these conditions:

- Cycle rejection
- Parallel ready nodes
- Failure edges
- Approval gates
- Retry limit
- Cancellation
- Resume from a failed node

Do not run real power tests on a development computer. Keep `FLEET_ALLOW_POWER_ACTIONS` off.

Test Wake-on-LAN with a packet listener or an isolated device.

## Protocol compatibility

V2 reports schema and protocol versions. New fields must remain compatible with the supported protocol range.

A breaking command or response requires a new protocol version. Core must check this version before an update.

Use one update test device for each supported operating system and architecture.

## SDKs and API

- `packages/sdk` contains the TypeScript REST client.
- `sdks/python` contains the Python REST client.
- `packages/plugin-sdk` contains plugin contracts.
- `docs/openapi.yaml` contains the OpenAPI 3.1 description.
- `@fleet/shared` contains WebSocket frames and compatibility types.

Core validates all requests. SDK types do not replace server validation.

## Containers

Check Compose before you start it:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker build -f deploy/docker/core.Dockerfile -t fleet-canvas/core:dev .
docker build -f deploy/docker/agent.Dockerfile -t fleet-canvas/agent:dev .
```

Container entry points support `FLEET_TOKEN_FILE`, `FLEET_MASTER_KEY_FILE`, and `FLEET_ENROLLMENT_TOKEN_FILE`.

Do not set a direct value and its file value at the same time.
