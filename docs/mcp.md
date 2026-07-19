# Orchestra MCP server

`@fleet/mcp` lets Codex operate Orchestra through narrow, typed tools. It is a separate gateway to Core, so it can run beside Codex over stdio or behind an authenticated Streamable HTTP endpoint.

## Tools

The server exposes device inventory/health/selection, power control, job creation/cancel/retry/move, pipeline creation/execution/status, job logs, artifact search/transfer/deployment, project mapping, Codex session startup, approval/notification requests, active alerts, and diagnostics.

Tool annotations mark read-only and destructive behavior. Power and artifact-promotion tools require an explicit `confirm: true`; Core policy remains authoritative. Artifact promotion records verified version metadata—the actual deployment command belongs in a reviewed pipeline. `fleet_request_approval` creates an informational operator notification, not an enforceable approval grant.

## Local stdio setup

Build and start once for a smoke test:

```bash
npm run build -w @fleet/mcp
FLEET_CORE_URL=http://127.0.0.1:4780 \
FLEET_TOKEN="$FLEET_TOKEN" \
FLEET_MCP_READ_ONLY=true \
node packages/mcp/dist/cli.js
```

Codex configuration:

```toml
[mcp_servers.fleet]
command = "node"
args = ["/absolute/path/to/fleet/packages/mcp/dist/cli.js"]
env = { FLEET_CORE_URL = "http://core-name:4780", FLEET_TOKEN = "replace-me", FLEET_MCP_READ_ONLY = "true" }
```

Codex CLI, IDE, and app share the same MCP configuration. Keep the first setup read-only and restrict tools further with `FLEET_MCP_ALLOWED_TOOLS`.

## Streamable HTTP

```bash
FLEET_MCP_TRANSPORT=http \
FLEET_MCP_HOST=127.0.0.1 \
FLEET_MCP_PORT=4790 \
FLEET_MCP_TOKEN="$(openssl rand -hex 32)" \
npm run start:mcp
```

Remote binding requires a `FLEET_MCP_TOKEN` of at least 32 bytes. Put the endpoint behind Tailscale and an HTTPS reverse proxy, set `FLEET_MCP_ALLOWED_HOSTS` to the expected Host names, and use a separate, short-lived MCP token rather than the Core recovery token. Failed bearer attempts are rate limited. HTTP requests use stateless transports that are closed after each response.

```toml
[mcp_servers.fleet]
url = "https://fleet-mcp.example.ts.net/mcp"
bearer_token_env_var = "FLEET_MCP_TOKEN"
```

## Permission profiles

Read-only operations profile:

```bash
FLEET_MCP_READ_ONLY=true \
FLEET_MCP_ALLOWED_TOOLS=fleet_list_devices,fleet_get_device,fleet_get_health,fleet_get_job_logs,fleet_list_artifacts,fleet_get_alerts \
node packages/mcp/dist/cli.js
```

`fleet_find_capable_device` calls Core's scheduler and persists a scheduling decision, so it is intentionally unavailable in strict read-only mode. An automation profile should use a scoped Core API token and only the tools required by that project. Do not give a background Codex agent unrestricted power, secret, transfer, and promotion tools together.
