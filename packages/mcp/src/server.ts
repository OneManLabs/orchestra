import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { FleetClient } from '@fleet/sdk';
import { z } from 'zod';

export interface FleetMcpOptions {
  coreUrl: string;
  token?: string;
  readOnly?: boolean;
  allowedTools?: string[];
}

const INSTRUCTIONS = 'Fleet Canvas controls real computers. Inspect fleet state before acting. Prefer the least-busy compatible device, preserve project/data locality, and use read-only operations when possible. Power, deployment, transfer, and write operations affect real systems and may require Core policy approval. Never bypass approval, classification, maintenance, quarantine, workspace, or secret controls. Report job, pipeline, transfer, and artifact identifiers so the operator can follow progress.';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
type ToolConfig = { title?: string; description?: string; inputSchema?: z.ZodRawShape; annotations?: ToolAnnotations };

export function createFleetMcpServer(options: FleetMcpOptions): McpServer {
  const client = new FleetClient({
    baseUrl: options.coreUrl,
    token: options.token,
    headers: { 'x-fleet-actor-type': 'mcp', 'x-fleet-client': 'fleet-mcp/2.0.0' },
  });
  const allowed = options.allowedTools?.length ? new Set(options.allowedTools) : undefined;
  const server = new McpServer(
    { name: 'fleet-canvas', version: '2.0.0' },
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );

  function register<T = Record<string, never>>(
    name: string,
    config: ToolConfig,
    handler: (input: T) => Promise<unknown>,
  ): void {
    if (allowed && !allowed.has(name)) return;
    server.registerTool(name, config, async (input) => {
      try { return result(await handler(input as T)); }
      catch (error) { return failure(error); }
    });
  }

  function mutate(tool: string): void {
    if (options.readOnly) throw new Error(`${tool} is disabled because this MCP server is in read-only mode.`);
  }

  register('fleet_list_devices', {
    title: 'List fleet devices',
    description: 'List real registered devices, connection state, roles, capabilities, current utilization, and active work.',
    inputSchema: { onlineOnly: z.boolean().default(false) },
    annotations: readOnly(),
  }, async ({ onlineOnly }: { onlineOnly: boolean }) => {
    const snapshot = await client.snapshot();
    return snapshot.devices.filter((device) => !onlineOnly || device.status !== 'offline');
  });

  register('fleet_get_device', {
    title: 'Get a fleet device',
    description: 'Get live device facts plus its V2 profile, groups, alerts, jobs, and sessions.',
    inputSchema: { deviceId: z.string().min(1) },
    annotations: readOnly(),
  }, async ({ deviceId }: { deviceId: string }) => {
    const snapshot = await client.snapshot();
    const device = snapshot.devices.find((item) => item.id === deviceId);
    if (!device) throw new Error('Device not found.');
    return {
      device,
      profile: snapshot.v2.deviceProfiles.find((item) => item.deviceId === deviceId),
      groups: snapshot.v2.groups.filter((item) => item.deviceIds.includes(deviceId)),
      alerts: snapshot.v2.alerts.filter((item) => item.deviceId === deviceId && item.status !== 'resolved'),
      jobs: snapshot.jobs.filter((item) => item.deviceId === deviceId),
      sessions: snapshot.sessions.filter((item) => item.deviceId === deviceId),
    };
  });

  register('fleet_get_health', {
    title: 'Get fleet health',
    description: 'Summarize Core health, online capacity, active alerts, failed work, storage state, and update drift.',
    annotations: readOnly(),
  }, async () => {
    const [health, snapshot] = await Promise.all([client.request<Record<string, unknown>>('/api/health'), client.snapshot()]);
    return {
      core: health,
      devices: { total: snapshot.devices.length, online: snapshot.devices.filter((item) => item.status !== 'offline').length, degraded: snapshot.devices.filter((item) => item.status === 'degraded').length },
      jobs: { active: snapshot.jobs.filter((item) => ['queued', 'dispatching', 'running', 'awaiting-approval'].includes(item.status)).length, failed: snapshot.jobs.filter((item) => item.status === 'failed').length },
      alerts: snapshot.v2.alerts.filter((item) => item.status !== 'resolved'),
      storage: snapshot.v2.storageConnections,
      rollouts: snapshot.v2.updateRollouts.filter((item) => !['completed', 'rolled-back'].includes(item.state)),
    };
  });

  register('fleet_find_capable_device', {
    title: 'Find a capable device',
    description: 'Score online devices with Fleet scheduling policy and explain the selection or rejection reasons.',
    inputSchema: {
      requiredLabels: z.array(z.string()).default([]),
      preferredDeviceIds: z.array(z.string()).default([]),
      projectId: z.string().optional(),
      policyId: z.string().optional(),
    },
    annotations: write(false),
  }, async (input: { requiredLabels: string[]; preferredDeviceIds: string[]; projectId?: string; policyId?: string }) => {
    mutate('fleet_find_capable_device');
    return client.request('/api/v2/scheduling/select', { method: 'POST', body: input });
  });

  register('fleet_wake_device', {
    title: 'Wake a device', description: 'Send Wake-on-LAN using the configured relay and audited device profile.',
    inputSchema: { deviceId: z.string().min(1), confirm: z.literal(true).describe('Explicit operator confirmation is required.') },
    annotations: destructive('Wake changes physical power state.'),
  }, async ({ deviceId }: { deviceId: string; confirm: true }) => { mutate('fleet_wake_device'); return client.power([deviceId], 'wake'); });

  register('fleet_restart_device', {
    title: 'Restart a device', description: 'Gracefully restart a device through its native Agent power controller.',
    inputSchema: { deviceId: z.string().min(1), confirm: z.literal(true).describe('Explicit operator confirmation is required.') },
    annotations: destructive('Restart interrupts work on a real device.'),
  }, async ({ deviceId }: { deviceId: string; confirm: true }) => { mutate('fleet_restart_device'); return client.power([deviceId], 'restart'); });

  register('fleet_create_job', {
    title: 'Create a fleet job', description: 'Create a typed shell or Codex job and let Fleet schedule or target it.',
    inputSchema: {
      name: z.string().min(1), kind: z.enum(['codex', 'shell']), prompt: z.string().min(1), command: z.string().optional(),
      projectId: z.string().optional(), deviceId: z.string().optional(), requiredLabels: z.array(z.string()).default([]),
      permissionMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
      approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).default('on-request'),
    },
    annotations: destructive('The job may execute workspace writes or unrestricted commands, depending on its permission profile.'),
  }, async (input: Record<string, unknown>) => { mutate('fleet_create_job'); return client.request('/api/jobs', { method: 'POST', body: input }); });

  register('fleet_cancel_job', {
    title: 'Cancel a job', description: 'Cancel a queued or running Fleet job.',
    inputSchema: { jobId: z.string().min(1) }, annotations: destructive('Cancels active work.'),
  }, async ({ jobId }: { jobId: string }) => { mutate('fleet_cancel_job'); return client.cancelJob(jobId); });

  register('fleet_retry_job', {
    title: 'Retry a job', description: 'Retry a failed or cancelled job with preserved configuration.',
    inputSchema: { jobId: z.string().min(1) }, annotations: write(false),
  }, async ({ jobId }: { jobId: string }) => { mutate('fleet_retry_job'); return client.request(`/api/jobs/${encodeURIComponent(jobId)}/start`, { method: 'POST', body: {} }); });

  register('fleet_move_job', {
    title: 'Move a queued job', description: 'Assign a queued job to another compatible device.',
    inputSchema: { jobId: z.string().min(1), deviceId: z.string().min(1) }, annotations: write(false),
  }, async ({ jobId, deviceId }: { jobId: string; deviceId: string }) => { mutate('fleet_move_job'); return client.request(`/api/jobs/${encodeURIComponent(jobId)}/assign`, { method: 'POST', body: { deviceId } }); });

  register('fleet_create_pipeline', {
    title: 'Create a pipeline', description: 'Create and validate a versioned DAG of Fleet work.',
    inputSchema: { name: z.string(), description: z.string().default(''), projectId: z.string().optional(), nodes: z.array(z.record(z.unknown())), edges: z.array(z.record(z.unknown())) },
    annotations: write(false),
  }, async (input: Record<string, unknown>) => { mutate('fleet_create_pipeline'); return client.request('/api/v2/pipelines', { method: 'POST', body: input }); });

  register('fleet_run_pipeline', {
    title: 'Run a pipeline', description: 'Start a pipeline with parameters. Approval nodes remain pending for a human decision.',
    inputSchema: { pipelineId: z.string().min(1), parameters: z.record(z.unknown()).default({}) }, annotations: write(false),
  }, async ({ pipelineId, parameters }: { pipelineId: string; parameters: Record<string, unknown> }) => { mutate('fleet_run_pipeline'); return client.runPipeline(pipelineId, parameters); });

  register('fleet_get_pipeline_run', {
    title: 'Get a pipeline run', description: 'Inspect every node, attempt, device, output, and current pipeline state.',
    inputSchema: { runId: z.string().min(1) }, annotations: readOnly(),
  }, async ({ runId }: { runId: string }) => {
    const runs = await client.list<{ id: string } & Record<string, unknown>>('pipeline-runs');
    const run = runs.find((item) => item.id === runId); if (!run) throw new Error('Pipeline run not found.'); return run;
  });

  register('fleet_get_job_logs', {
    title: 'Get job logs', description: 'Read the bounded, persisted stdout/stderr/Codex event history for a job.',
    inputSchema: { jobId: z.string().min(1), tail: z.number().int().min(1).max(1_000).default(200) }, annotations: readOnly(),
  }, async ({ jobId, tail }: { jobId: string; tail: number }) => {
    const job = (await client.jobs()).find((item) => item.id === jobId); if (!job) throw new Error('Job not found.'); return { ...job, output: job.output.slice(-tail) };
  });

  register('fleet_list_artifacts', {
    title: 'List artifacts', description: 'Find real registered artifacts with versions, checksums, locations, tags, lineage, and promotion state.',
    inputSchema: { projectId: z.string().optional(), kind: z.string().optional(), tag: z.string().optional() }, annotations: readOnly(),
  }, async ({ projectId, kind, tag }: { projectId?: string; kind?: string; tag?: string }) =>
    (await client.artifacts()).filter((item) => (!projectId || item.projectId === projectId) && (!kind || item.kind === kind) && (!tag || item.tags.includes(tag))));

  register('fleet_transfer_artifact', {
    title: 'Transfer an artifact', description: 'Create and start a resumable, checksummed artifact transfer between configured locations.',
    inputSchema: {
      artifactId: z.string().min(1).optional(),
      source: z.object({ path: z.string().min(1), deviceId: z.string().min(1).optional(), providerId: z.string().min(1).optional() }),
      destination: z.object({ path: z.string().min(1), deviceId: z.string().min(1).optional(), providerId: z.string().min(1).optional() }),
      totalBytes: z.number().int().nonnegative().default(0),
      checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    },
    annotations: write(false),
  }, async (input: { artifactId?: string; source: { path: string; deviceId?: string; providerId?: string }; destination: { path: string; deviceId?: string; providerId?: string }; totalBytes: number; checksumSha256?: string }) => {
    mutate('fleet_transfer_artifact');
    const transfer = await client.request<{ id: string }>('/api/v2/transfers', { method: 'POST', body: {
      ...input,
      source: { id: randomUUID(), ...input.source, status: 'available', cached: false },
      destination: { id: randomUUID(), ...input.destination, status: 'missing', cached: false },
    } });
    return client.request(`/api/v2/transfers/${encodeURIComponent(transfer.id)}/start`, { method: 'POST', body: {} });
  });

  register('fleet_mount_project', {
    title: 'Map a project path', description: 'Add or update the logical project path mapping for a device.',
    inputSchema: { projectId: z.string().min(1), deviceId: z.string().min(1), path: z.string().min(1) }, annotations: write(false),
  }, async ({ projectId, deviceId, path }: { projectId: string; deviceId: string; path: string }) => {
    mutate('fleet_mount_project'); const snapshot = await client.snapshot(); const project = snapshot.projects.find((item) => item.id === projectId); if (!project) throw new Error('Project not found.');
    const paths = [...project.paths.filter((item) => item.deviceId !== deviceId), { deviceId, path }];
    return client.request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { paths } });
  });

  register('fleet_start_codex_session', {
    title: 'Start Codex on a device', description: 'Start a structured Codex app-server session in a registered project/path on a real device.',
    inputSchema: { deviceId: z.string().min(1), projectId: z.string().min(1).optional(), cwd: z.string().default(''), title: z.string().default('Fleet MCP session'), model: z.string().trim().min(1).max(240).optional(), permissionMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'), approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).default('on-request') },
    annotations: destructive('A session can execute writes or unrestricted commands when configured to do so.'),
  }, async (input: Record<string, unknown>) => { mutate('fleet_start_codex_session'); return client.request('/api/sessions', { method: 'POST', body: input }); });

  register('fleet_request_approval', {
    title: 'Notify an operator of an approval request', description: 'Create a visible warning notification describing a proposed action. This is informational and does not itself grant or enforce approval.',
    inputSchema: { title: z.string(), detail: z.string(), resourceType: z.string(), resourceId: z.string().optional() }, annotations: write(false),
  }, async (input: Record<string, unknown>) => { mutate('fleet_request_approval'); const notifications = await client.request('/api/v2/notifications', { method: 'POST', body: { severity: 'warning', title: input.title, body: `${input.detail}\n\nResource: ${input.resourceType}${input.resourceId ? `/${input.resourceId}` : ''}` } }); return { notifications, approvalEnforced: false }; });

  register('fleet_send_notification', {
    title: 'Send a Fleet notification', description: 'Send an operator notification through selected configured channels.',
    inputSchema: { title: z.string(), body: z.string(), severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'), channelIds: z.array(z.string()).default([]) }, annotations: write(false),
  }, async (input: Record<string, unknown>) => { mutate('fleet_send_notification'); return client.request('/api/v2/notifications', { method: 'POST', body: input }); });

  register('fleet_deploy_artifact', {
    title: 'Promote an artifact record', description: 'Mark a registered, checksummed artifact version as promoted to an environment. This records promotion metadata; deployment execution belongs in a pipeline deployment node.',
    inputSchema: { artifactId: z.string().min(1), environment: z.string().min(1), versionId: z.string().min(1).optional(), confirm: z.literal(true) }, annotations: destructive('Changes artifact promotion state.'),
  }, async ({ artifactId, environment, versionId }: { artifactId: string; environment: string; versionId?: string; confirm: true }) => {
    mutate('fleet_deploy_artifact');
    const artifact = (await client.artifacts()).find((item) => item.id === artifactId);
    if (!artifact) throw new Error('Artifact not found.');
    const version = versionId ? artifact.versions.find((item) => item.id === versionId) : artifact.versions.at(-1);
    if (!version) throw new Error('A registered artifact version is required before promotion.');
    if (!/^[a-f0-9]{64}$/i.test(version.checksumSha256)) throw new Error('Artifact version does not have a valid SHA-256 checksum.');
    return client.request(`/api/v2/artifacts/${encodeURIComponent(artifactId)}/promote`, { method: 'POST', body: { environment, versionId: version.id, confirm: true } });
  });

  register('fleet_get_alerts', {
    title: 'List active alerts', description: 'List active fleet alerts and their device/job context.',
    inputSchema: { severity: z.enum(['info', 'warning', 'critical']).optional() }, annotations: readOnly(),
  }, async ({ severity }: { severity?: string }) => (await client.list<Record<string, unknown> & { severity: string; status: string }>('alerts')).filter((item) => item.status !== 'resolved' && (!severity || item.severity === severity)));

  register('fleet_run_diagnostics', {
    title: 'Run Fleet diagnostics', description: 'Run redacted Core, Agent, network, storage, backup, or compatibility checks.',
    inputSchema: { deviceId: z.string().optional(), kind: z.enum(['agent', 'core', 'network', 'storage', 'database', 'backup', 'compatibility', 'support-bundle']).default('core') }, annotations: write(false),
  }, async (input: Record<string, unknown>) => { mutate('fleet_run_diagnostics'); return client.create('diagnostics', input); });

  return server;
}

function result(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function readOnly() { return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }; }
function write(destructiveHint: boolean) { return { readOnlyHint: false, destructiveHint, idempotentHint: false, openWorldHint: false }; }
function destructive(_reason: string) { return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }; }
