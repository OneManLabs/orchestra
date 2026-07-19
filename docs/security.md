# Orchestra V2 security model

Orchestra coordinates shells, Codex, files, power state, and deployments, so compromise of Core or an Agent is high impact. The default design combines private networking, application credentials, narrow commands, workspace confinement, explicit approval, encryption, and tamper-evident records.

## Trust boundaries

- **Desktop renderer:** untrusted UI. Electron context isolation and sandboxing stay enabled; privileged actions pass through a narrow validated bridge.
- **Core:** trusted policy decision and coordination point. Keep it patched, backed up, and reachable only from approved identities.
- **Agent:** trusted executor for one device. It accepts typed commands from Core over an outbound connection and confines file operations to configured roots.
- **Codex/job process:** constrained by its selected sandbox, workspace, approval policy, and injected secret scope. Outbound network control for shell/Codex processes depends on Codex and host/container policy; Orchestra's Core HTTP allowlist does not sandbox arbitrary child-process networking.
- **Plugin:** registration metadata only in this release. Core does not execute plugin entrypoints; a future host must treat every plugin as untrusted even when its manifest is signed.
- **NAS/artifact provider:** separate data plane. Provider credentials are secret references, not fields returned in fleet snapshots.

## Authentication and enrollment

The recovery `FLEET_TOKEN` is supported for bootstrap and emergency administration. Normal Agents should use short-lived enrollment tokens to obtain independent device credentials. Core stores credential hashes and compares supplied values without logging plaintext. Decommissioning revokes the bound credential.

API tokens are scoped, optionally expiring, revocable, and returned once. Sensitive route families require their own scope in addition to ordinary read/write access; policy mutation requires `policies:write`, just as secrets, power, enrollment, and token administration require their corresponding family scope. The recovery token remains a full administrative capability and is the break-glass path for policy repair. Enterprise identity adapters (OIDC/SAML/SCIM) are not included in this repository and require a configured identity provider plus a real multi-user authentication layer.

Core requires application authentication on loopback as well as remote interfaces. When no loopback `FLEET_TOKEN` is supplied, Core creates an owner-only recovery-token file and reports its path. `--allow-unauthenticated-loopback` exists only for isolated development and tests. Never enable it behind a reverse proxy or port forward: the proxy can make remote traffic appear to originate from loopback. WebSocket credentials travel in Authorization (native Agent/Electron clients) or the `fleet-token.*` subprotocol (browser clients), never in URL query parameters.

## Authorization and policy

Built-in role records cover owner, fleet administrator, operator, approver, auditor, and read-only viewer. The policy evaluator selects enabled rules by priority and applies action wildcards plus organization, workspace, project, device-group, environment, and data-classification scopes. Projects are assigned to a workspace (the default Operations workspace when omitted), so workspace rules are enforced through project-backed jobs, sessions, pipelines, artifacts, and automation. Conditions can constrain actor type/identity, HTTP method, source address, project, device, environment, and classification; an unknown condition fails closed for a matching rule. Actor type is derived from the authenticated credential/transport and cannot be selected with a request header. Core applies the same evaluator to REST mutations, embedded/standalone MCP calls, scheduler targets, pipeline power and transfer nodes, scheduled runs, automatic wake/idle power, and update rollouts.

This is local ABAC enforcement, not a substitute for enterprise identity. The recovery token is still a single administrator identity, and an API token is a service capability rather than a human approver. Use independently authenticated users before relying on separation-of-duties policies.

High-risk actions include:

- shutdown/restart and device decommission;
- secret read or rotation;
- unrestricted Codex/shell sessions;
- production deployment/artifact promotion;
- recursive file removal;
- update rollout and rollback;
- policy, role, plugin, or API-token changes.

Production policy should require explicit or two-person approval for these actions. A `require-approval` policy currently blocks the attempted mutation with an auditable `approvalRequired` response. Codex approvals and pipeline approval gates provide enforceable approval workflows in their own execution contexts; arbitrary two-person authorization still requires separate authenticated user identities and an approval service.

## Encryption

- Use TLS for any route that leaves loopback; Tailscale encryption does not remove the value of application TLS.
- The built-in vault uses AES-256-GCM and a separately supplied `FLEET_MASTER_KEY`.
- Device and API credentials are stored as one-way hashes in Core.
- Agent credential files use owner-only permissions and should use Keychain/Credential Manager/TPM adapters where available.
- Encrypt Core, NAS, and backup volumes at rest.
- Rotate keys using an auditable, tested procedure; retain old keys only as long as required to re-encrypt backups.

## Audit integrity

Audit events include sequence, timestamp, actor, action, resource, outcome, redacted detail, previous hash, and current hash. This makes deletion/reordering detectable. It is tamper-evident, not magically immutable if an attacker controls the Core host. Stream audit events to a separately administered SIEM or write-once destination for stronger immutability.

Secrets, bearer tokens, raw file chunks, and private Codex authentication data must never appear in audit detail, activity, notifications, or support bundles.

## File and artifact safety

Agent file commands canonicalize the requested path and require it to remain beneath an allowed project root. Transfers use serialized bounded chunks, safe numeric offsets, complete-write confirmation, retry limits, streamed SHA-256 verification, exact-size checks, and final-path/link confinement. The transfer API rejects advertised compression, encryption, and bandwidth limiting because those streaming controls are not implemented. Classification labels participate in policy evaluation when Core can resolve the artifact/device context, but Orchestra does not inspect arbitrary file contents or provide a DLP engine. NAS snapshots do not replace integrity checks or an off-site backup.

Cross-device Codex continuity transfers only a bounded Codex thread rollout through authenticated Agent connections. The destination enforces ordered chunks, exact size, SHA-256 verification, private staging permissions, thread-ID metadata validation, and destination project-path mapping. Source exports and failed destination stages are discarded; a successful destination keeps the private rollout needed to resume that thread. Orchestra does not copy the source device's Codex credential store. Because a rollout contains conversation and tool history, its destination must be trusted for the same project and data classification.

## MCP safety

Orchestra has an embedded Core MCP endpoint and a standalone gateway. Both use bearer authentication and typed tools. Core applies action-level policy to both paths and writes mutation decisions to the hash-chained audit log; the standalone gateway additionally applies its local read-only/tool allowlist. Gateway connection/read logs belong in the supervising service or reverse proxy. A `require-approval` decision denies an MCP mutation until an operator completes a separate approved workflow—it does not silently approve it. `fleet_request_approval` sends an informational warning notification and does not grant capability.

## Plugins

Plugins declare capabilities, network domains, filesystem roots, secret names, and Orchestra scopes in a strict manifest. Core currently stores plugin registrations but does not load their entrypoints. A future executable plugin host must require signatures from approved publishers and isolate plugins in processes or containers with CPU/memory/time limits; never `import()` arbitrary marketplace code into Core's privileged process.

## Compliance statement

The controls in this repository are implementation foundations, not a SOC 2, ISO 27001, HIPAA, FedRAMP, CMMC, or ITAR certification. Certification requires organizational procedures, evidence, tested identity and key-management integrations, infrastructure configuration, independent assessment, and ongoing operation. Orchestra supplies policy, audit, classification metadata, backup/export functions, and air-gap deployment guidance; it does not claim a DLP system, enforced legal retention, data-residency service, or completed accreditation.
