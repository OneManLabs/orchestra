# Orchestra security design

Orchestra controls shells, Codex, files, power, and deployments. A compromise of Core or an Agent can have a high effect.

Use private networking, application credentials, restricted commands, file-root limits, approvals, encryption, and audit records.

## Trust boundaries

- The Desktop renderer is an untrusted interface.
- Electron context isolation and sandboxing stay on.
- A small preload bridge handles privileged requests.
- Core makes policy decisions and coordinates work.
- An Agent executes work on one device.
- A Codex or job process uses its selected sandbox and secret scope.
- Plugin data is registration data only.
- A NAS or artifact provider is a separate data layer.

Orchestra does not control all child-process network traffic. Codex, the host, or the container must supply that control.

## Authentication

Use `FLEET_TOKEN` only for initial setup and emergency administration.

Use a one-use enrollment token to enroll an Agent. Core stores only a hash of the enrollment token. The Agent gets a device credential and stores it with owner-only access.

API tokens have scopes. They can also have an expiration time. Core returns a new token only one time.

Use a specific scope for a sensitive function. Examples include policy, secret, power, enrollment, and token administration.

Core requires authentication on loopback and remote interfaces. If no loopback recovery token is present, Core makes an owner-only token file.

Use `--allow-unauthenticated-loopback` only for isolated tests. Do not use it behind a proxy or port forward.

Native clients send WebSocket credentials in the Authorization header. Browser clients use the `fleet-token.*` subprotocol. Do not put a credential in a URL.

## Authorization

Core includes these roles:

- Owner
- Fleet administrator
- Operator
- Approver
- Auditor
- Read-only user

Policy can use organization, workspace, project, device group, environment, and data classification. An unknown condition fails closed.

Core applies policy to REST, MCP, scheduling, pipelines, automatic power, and updates.

Use an approval for these high-risk operations:

- Shutdown or restart
- Device removal
- Secret read or change
- Unrestricted Codex or shell access
- Production deployment
- Recursive file removal
- Update or rollback
- Policy, role, plugin, or token change

A `require-approval` result blocks the operation. It does not approve the operation.

Two-person approval requires separate authenticated user identities and an approval service.

## Encryption

- Use TLS for traffic that leaves loopback.
- Use a separate `FLEET_MASTER_KEY` for the AES-256-GCM vault.
- Core stores device and API credentials as one-way hashes.
- Agent credential files use owner-only access.
- Encrypt Core, NAS, and backup storage.
- Test the key-change procedure before production use.

## Audit records

Each audit event has a sequence, time, actor, action, resource, result, previous hash, and current hash.

The hash chain makes deletion or order changes visible. It does not make the data immutable when an attacker controls the Core host.

Send audit events to a separately controlled system for stronger retention.

Do not put these items in audit data:

- Secrets
- Bearer tokens
- Raw file chunks
- Codex authentication data

## File and artifact safety

An Agent resolves each requested path. The final path must stay below a permitted project root.

File transfer uses ordered chunks, bounded offsets, retry limits, SHA-256 checks, size checks, and final-path checks.

The API rejects transfer compression, encryption, and bandwidth limits because these functions are not implemented.

Orchestra does not examine arbitrary file content. It is not a data-loss-prevention system.

## Codex thread transfer

A thread transfer uses an authenticated Agent connection. The destination checks chunk order, size, SHA-256, file permissions, thread ID, and project path.

Orchestra does not copy the source Codex credential store.

A thread file contains conversation and tool history. Give it only to a destination with the same project trust and data class.

## MCP

Core and the standalone MCP gateway use bearer authentication and typed tools.

Core applies policy and writes mutation decisions to the audit chain. The gateway can also apply a local read-only tool list.

`fleet_request_approval` makes a warning notification. It does not give a permission.

## Plugins

Plugins declare scopes, network domains, file roots, and secret names. Core stores plugin registration data. It does not run plugin entry points.

A future plugin host must check signatures and isolate each plugin. Do not import untrusted plugin code into Core.

## Compliance statement

The repository contains technical control foundations. It does not have SOC 2, ISO 27001, HIPAA, FedRAMP, CMMC, or ITAR certification.

Certification also requires organization procedures, evidence, identity systems, key systems, infrastructure controls, independent assessment, and continuous operation.
