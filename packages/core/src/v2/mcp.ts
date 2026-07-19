import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import type { ApiTokenMetadata, ArtifactTransfer, FleetJob } from '@fleet/shared';
import type { V2RouteContext } from './routes.js';
import { appendAudit, evaluateFleetPolicies } from './security.js';
import { artifactTransferDeviceIds } from './storage.js';

interface McpOptions {
  authenticateApiToken(token: string): ApiTokenMetadata | undefined;
  startTransfer(transfer: ArtifactTransfer): Promise<void>;
}

function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function text(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }; }
function error(message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode: 403 }); }

export function registerFleetMcp(app: FastifyInstance, context: V2RouteContext, options: McpOptions): void {
  function authorize(value: string, scope: string): boolean { if (safeEqual(value, context.token)) return true; const token = options.authenticateApiToken(value); return Boolean(token && (token.scopes.includes('*') || token.scopes.includes('mcp:*') || token.scopes.includes(scope))); }
  function deviceGroups(deviceId: string): string[] {
    const profileIds = context.store.state.v2.deviceProfiles.find((profile) => profile.deviceId === deviceId)?.groupIds ?? [];
    const declaredIds = context.store.state.v2.groups.filter((group) => group.deviceIds.includes(deviceId)).map((group) => group.id);
    return [...new Set([...profileIds, ...declaredIds])];
  }
  function enforce(action: string, resourceType: string, resourceId?: string, supplied: { deviceIds?: string[]; projectId?: string; dataClassification?: string } = {}): void {
    let projectId = supplied.projectId;
    let dataClassification = supplied.dataClassification;
    const deviceIds = new Set(supplied.deviceIds ?? []);
    if (resourceType === 'device' && resourceId) deviceIds.add(resourceId);
    if (resourceType === 'job' && resourceId) {
      const job = context.store.state.jobs.find((item) => item.id === resourceId);
      if (job?.deviceId) deviceIds.add(job.deviceId);
      projectId ??= job?.projectId;
    }
    if (resourceType === 'artifact-transfer' && resourceId) {
      const transfer = context.store.state.v2.transfers.find((item) => item.id === resourceId);
      if (transfer) for (const deviceId of artifactTransferDeviceIds(transfer, context.store.state.v2.storageConnections)) deviceIds.add(deviceId);
      const artifact = transfer?.artifactId ? context.store.state.v2.artifacts.find((item) => item.id === transfer.artifactId) : undefined;
      projectId ??= artifact?.projectId;
      dataClassification ??= artifact?.classification;
    }
    const targets = deviceIds.size ? [...deviceIds] : [undefined];
    const workspaceId = projectId
      ? context.store.state.projects.find((item) => item.id === projectId)?.workspaceId ?? context.store.state.v2.workspaces[0]?.id
      : undefined;
    for (const deviceId of targets) {
      const profile = deviceId ? context.store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId) : undefined;
      const decision = evaluateFleetPolicies(context.store.state.v2.policies, {
        action, actorType: 'mcp', actorId: 'mcp-client', projectId, workspaceId, deviceId,
        deviceGroupIds: deviceId ? deviceGroups(deviceId) : undefined,
        dataClassification: dataClassification ?? profile?.dataClassification,
      });
      if (decision.effect === 'deny' || decision.effect === 'require-approval') {
        appendAudit(context.store, { actorType: 'mcp', actorId: 'mcp-client', action, resourceType, resourceId, outcome: 'denied', detail: { policyId: decision.policy?.id, effect: decision.effect, deviceId, projectId } });
        throw error(`Policy ${decision.policy?.name ?? 'decision'} ${decision.effect === 'deny' ? 'denies' : 'requires approval for'} this action.`);
      }
      appendAudit(context.store, { actorType: 'mcp', actorId: 'mcp-client', action, resourceType, resourceId, outcome: 'success', detail: { policyId: decision.policy?.id, deviceId, projectId } });
    }
  }
  function server(): McpServer {
    const mcp = new McpServer({ name: 'Orchestra', version: '2.0.0' }, { instructions: 'Operate the private Orchestra compute fleet. Read state before acting. Use the least-privileged target and explicit IDs. Power, cancellation, deployment, transfer, and job tools change real systems. Policy checks and hash-chained audit records apply to every mutating call.' });
    mcp.registerTool('fleet_list_devices', { description: 'List registered fleet devices with live status and capabilities.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async () => { enforce('devices:read', 'device'); return text(context.store.state.devices); });
    mcp.registerTool('fleet_get_device_status', { description: 'Get one device profile, health metrics, groups, and alerts.', inputSchema: { deviceId: z.string().min(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ deviceId }) => { enforce('devices:read', 'device', deviceId); const device = context.store.state.devices.find((item) => item.id === deviceId); if (!device) throw new Error('Device not found.'); return text({ device, profile: context.store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId), alerts: context.store.state.v2.alerts.filter((item) => item.deviceId === deviceId && item.status !== 'resolved') }); });
    mcp.registerTool('fleet_wake_device', { description: 'Wake a configured device through its trusted Wake-on-LAN relay.', inputSchema: { deviceId: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ deviceId }) => { enforce('devices:power', 'device', deviceId); const profile = context.store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId); if (!profile?.wakeRelayDeviceId || !profile.wakeMacAddress) throw new Error('Wake relay and MAC are not configured.'); const result = await context.dispatch(profile.wakeRelayDeviceId, { type: 'device.power', payload: { action: 'wake', macAddress: profile.wakeMacAddress, broadcastAddress: profile.wakeBroadcastAddress } }); return text({ deviceId, relayDeviceId: profile.wakeRelayDeviceId, result }); });
    mcp.registerTool('fleet_create_job', { description: 'Create and dispatch a shell or Codex job using Fleet scheduling.', inputSchema: { name: z.string().min(1), kind: z.enum(['shell', 'codex']), prompt: z.string().min(1), command: z.string().optional(), projectId: z.string().optional(), deviceId: z.string().optional(), requiredLabels: z.array(z.string()).default([]), permissionMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write') }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async (input) => { enforce('jobs:execute', 'job', undefined, { deviceIds: input.deviceId ? [input.deviceId] : undefined, projectId: input.projectId }); const job = await context.createJob({ ...input, approvalPolicy: 'on-request' }); return text(job); });
    mcp.registerTool('fleet_cancel_job', { description: 'Cancel an active or queued fleet job.', inputSchema: { jobId: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ jobId }) => { enforce('jobs:cancel', 'job', jobId); return text(await context.cancelJob(jobId)); });
    mcp.registerTool('fleet_transfer_artifact', { description: 'Start a registered resumable, checksum-verified artifact transfer.', inputSchema: { transferId: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ transferId }) => { enforce('artifacts:transfer', 'artifact-transfer', transferId); const transfer = context.store.state.v2.transfers.find((item) => item.id === transferId); if (!transfer) throw new Error('Transfer not found.'); void options.startTransfer(transfer); return text(transfer); });
    mcp.registerTool('fleet_get_job_logs', { description: 'Read the bounded output history of a fleet job.', inputSchema: { jobId: z.string().min(1), limit: z.number().int().min(1).max(1000).default(200) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ jobId, limit }) => { enforce('jobs:read', 'job', jobId); const job = context.store.state.jobs.find((item) => item.id === jobId); if (!job) throw new Error('Job not found.'); return text({ id: job.id, name: job.name, status: job.status, output: job.output.slice(-limit) }); });
    mcp.registerTool('fleet_compare_runs', { description: 'Compare status, duration, target, exit code, and output tails for multiple job runs.', inputSchema: { jobIds: z.array(z.string()).min(2).max(20) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ jobIds }) => { for (const jobId of jobIds) enforce('jobs:read', 'job', jobId); const runs = jobIds.map((id) => context.store.state.jobs.find((item) => item.id === id)).filter((item): item is FleetJob => Boolean(item)).map((job) => ({ id: job.id, name: job.name, status: job.status, deviceId: job.deviceId, exitCode: job.exitCode, durationMs: job.startedAt && job.completedAt ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime() : undefined, outputTail: job.output.slice(-20) })); return text(runs); });
    mcp.registerTool('fleet_deploy_service', { description: 'Dispatch an explicitly supplied deployment command to a selected device and project.', inputSchema: { name: z.string().min(1), command: z.string().min(1), deviceId: z.string().min(1), projectId: z.string().optional(), cwd: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async (input) => { const target = { deviceIds: [input.deviceId], projectId: input.projectId }; enforce('deployments:create', 'deployment', undefined, target); enforce('jobs:execute', 'job', undefined, target); const job = await context.createJob({ name: input.name, kind: 'shell', prompt: input.command, command: input.command, deviceId: input.deviceId, projectId: input.projectId, cwd: input.cwd, permissionMode: 'danger-full-access', approvalPolicy: 'on-request', requiredLabels: [] }); return text(job); });
    return mcp;
  }

  app.all('/mcp', async (request, reply) => {
    const authorization = request.headers.authorization; const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!bearer || !authorize(bearer, 'mcp:tools')) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'A Fleet MCP bearer token with mcp scope is required.' });
    const mcp = server(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); reply.hijack(); await mcp.connect(transport); await transport.handleRequest(request.raw, reply.raw, request.body); reply.raw.once('close', () => { void transport.close(); void mcp.close(); });
  });
}
