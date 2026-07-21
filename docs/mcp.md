# Orchestra MCP server

`@fleet/mcp` lets an MCP client operate Orchestra through typed tools. It connects to Core through standard input and output or Streamable HTTP.

## Tools

The server supplies tools for these functions:

- Device inventory, health, and selection
- Power control
- Job and pipeline control
- Logs
- Artifact search, transfer, and deployment data
- Project maps
- Codex session start
- Notifications and approval requests
- Alerts and diagnostics

Tool annotations identify read-only and destructive operations. Power and artifact-promotion tools require `confirm: true`.

Core policy always has authority. `fleet_request_approval` makes a notification. It does not give approval authority.

## Standard input and output

Build and start the server:

```bash
npm run build -w @fleet/mcp
FLEET_CORE_URL=http://127.0.0.1:4780 \
FLEET_TOKEN="$FLEET_TOKEN" \
FLEET_MCP_READ_ONLY=true \
node packages/mcp/dist/cli.js
```

Add this MCP configuration:

```toml
[mcp_servers.fleet]
command = "node"
args = ["/absolute/path/to/fleet/packages/mcp/dist/cli.js"]
env = { FLEET_CORE_URL = "http://core-name:4780", FLEET_TOKEN = "replace-me", FLEET_MCP_READ_ONLY = "true" }
```

Start with read-only access. Use `FLEET_MCP_ALLOWED_TOOLS` to permit only necessary tools.

## Streamable HTTP

```bash
FLEET_MCP_TRANSPORT=http \
FLEET_MCP_HOST=127.0.0.1 \
FLEET_MCP_PORT=4790 \
FLEET_MCP_TOKEN="$(openssl rand -hex 32)" \
npm run start:mcp
```

A remote listener requires a `FLEET_MCP_TOKEN` of at least 32 bytes.

Keep the endpoint behind Tailscale and an HTTPS proxy. Set `FLEET_MCP_ALLOWED_HOSTS` to the permitted Host values.

Use a separate MCP token. Do not use the Core recovery token.

```toml
[mcp_servers.fleet]
url = "https://fleet-mcp.example.ts.net/mcp"
bearer_token_env_var = "FLEET_MCP_TOKEN"
```

## Read-only profile

```bash
FLEET_MCP_READ_ONLY=true \
FLEET_MCP_ALLOWED_TOOLS=fleet_list_devices,fleet_get_device,fleet_get_health,fleet_get_job_logs,fleet_list_artifacts,fleet_get_alerts \
node packages/mcp/dist/cli.js
```

`fleet_find_capable_device` stores a scheduling decision. Thus, strict read-only mode does not permit it.

For automation, use a scoped Core token. Do not give one background process unrestricted power, secret, transfer, and deployment tools.
