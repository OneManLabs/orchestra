import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fileConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ActivityEvent, AgentTeam, AlertRule, ApiTokenMetadata, ArtifactLocation, ArtifactTransfer, AuditRecord, BackupRecord,
  ClientEvent, CoreToAgentCommand, Device, DeviceGroup, DevicePowerAction, DiagnosticReport, FleetAlert,
  FleetArtifact, FleetJob, FleetNotification, FleetPolicy, FleetSite, ManagedDeviceProfile, MetricHistoryPoint,
  NotificationChannel, PipelineDefinition, PipelineNodeDefinition, PipelineNodeRun, PipelineRun,
  RemoteDesktopSession, SchedulingDecision, SchedulingPolicy, SecretMetadata, StorageConnection,
  WebhookRegistration,
} from '@fleet/shared';
import { validatePersistedState, type FleetStore } from '../store.js';
import { appendAudit, appendAuditRecord, decryptValue, encryptValue, evaluateFleetPolicies, hashCredential, issueCredential, verifyAudit, verifyCredential } from './security.js';
import { registerFleetMcp } from './mcp.js';
import { buildMenuBarSnapshot } from './menu-bar.js';
import {
  agentStoragePath, artifactTransferDeviceIds, browseAgentStorage, browseMountedStorage, createMountedStorageDirectory,
  ensureMountedStorageDirectory, filesystemStorageKinds, normalizedStoragePath, testAgentStorage, testMountedStorage,
} from './storage.js';

export interface V2RouteContext {
  store: FleetStore;
  token: string;
  coreUrl: string;
  loopback: boolean;
  dispatch(deviceId: string, command: Omit<CoreToAgentCommand, 'requestId'>, timeoutMs?: number): Promise<unknown>;
  broadcast(event: ClientEvent): void;
  activity(input: Omit<ActivityEvent, 'id' | 'at'>): ActivityEvent;
  isOnline(deviceId: string): boolean;
  disconnectDevice(deviceId: string, reason: string): void;
  currentAuditActor(): Pick<AuditRecord, 'actorType' | 'actorId' | 'sourceIp'>;
  createJob(input: Pick<FleetJob, 'name' | 'kind' | 'prompt' | 'permissionMode' | 'approvalPolicy' | 'requiredLabels'> & Partial<Pick<FleetJob, 'command' | 'projectId' | 'deviceId' | 'cwd'>> & { environment?: Record<string, string> }): Promise<FleetJob>;
  cancelJob(jobId: string): Promise<FleetJob>;
}

export interface V2Runtime {
  recordTelemetry(device: Device): void;
  evaluateDeviceAlerts(device: Device): void;
  recordAlertEvent(metric: AlertRule['metric'], input: { deviceId?: string; jobId?: string; identity?: string; actual?: number | string; active?: boolean; detail?: string }): FleetAlert[];
  handleJobUpdate(job: FleetJob): void;
  authenticateDeviceCredential(value: string): string | undefined;
  authenticateApiToken(value: string): ApiTokenMetadata | undefined;
  selectDevice(input: { requiredLabels: string[]; preferredDeviceIds?: string[]; projectId?: string; jobId?: string }): SchedulingDecision;
  authorizeJobTarget(job: FleetJob): void;
  wakeForJob(deviceId: string, jobId: string): Promise<{ state: 'requested' | 'pending' | 'blocked'; detail: string }>;
  stop(): void;
}

const idSchema = z.string().min(1).max(256);
const nameSchema = z.string().trim().min(1).max(200);
const recordSchema = z.record(z.string(), z.unknown());
const encryptedEnvelopeSchema = z.object({ iv: z.string().min(1), authTag: z.string().min(1), ciphertext: z.string().min(1) }).strict();
const powerActions: DevicePowerAction[] = ['wake', 'sleep', 'restart', 'shutdown', 'lock', 'logout'];
const alertRuleBodySchema = z.object({ name: nameSchema, enabled: z.boolean().default(true), metric: z.enum(['offline', 'cpu', 'memory', 'gpu', 'temperature', 'disk', 'battery', 'job-failure', 'job-stuck', 'agent-version', 'nas', 'authentication', 'custom']), operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'not-eq']), threshold: z.union([z.number(), z.string().max(256)]).optional(), durationSeconds: z.number().int().nonnegative().max(31_536_000).default(0), severity: z.enum(['info', 'warning', 'critical']), deviceIds: z.array(idSchema).max(1_000).default([]), groupIds: z.array(idSchema).max(1_000).default([]), notificationChannelIds: z.array(idSchema).max(1_000).default([]), cooldownSeconds: z.number().int().nonnegative().max(31_536_000).default(300) });
const artifactKindSchema = z.enum(['model', 'build', 'report', 'image', 'video', 'dataset', 'log', 'git-diff', 'document', 'test-result', 'metric', 'binary', 'archive', 'other']);
const classificationSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
const storageKindSchema = z.enum(['local', 'smb', 'nfs', 's3', 'minio', 'synology', 'qnap']);
const storageCreateSchema = z.object({
  name: nameSchema,
  kind: storageKindSchema,
  deviceId: idSchema.optional(),
  endpoint: z.string().max(2_000).optional(),
  rootPath: z.string().max(4_096).optional(),
  bucket: z.string().max(1_000).optional(),
  region: z.string().max(100).optional(),
  secretId: idSchema.optional(),
  readOnly: z.boolean().default(false),
  quotaBytes: z.number().nonnegative().optional(),
}).strict().superRefine(validateStorageConfiguration);
const storagePatchSchema = z.object({
  name: nameSchema.optional(),
  kind: storageKindSchema.optional(),
  deviceId: idSchema.nullable().optional(),
  endpoint: z.string().max(2_000).nullable().optional(),
  rootPath: z.string().max(4_096).nullable().optional(),
  bucket: z.string().max(1_000).nullable().optional(),
  region: z.string().max(100).nullable().optional(),
  secretId: idSchema.nullable().optional(),
  readOnly: z.boolean().optional(),
  quotaBytes: z.number().nonnegative().nullable().optional(),
}).strict();
const storageConfigurationSchema = z.object({
  kind: storageKindSchema,
  deviceId: idSchema.optional(),
  rootPath: z.string().max(4_096).optional(),
}).strict().superRefine(validateStorageConfiguration);
const artifactLocationSchema = z.object({
  id: idSchema.optional(),
  providerId: idSchema.optional(),
  deviceId: idSchema.optional(),
  path: z.string().trim().min(1).max(4_096),
  status: z.enum(['pending', 'available', 'transferring', 'offline', 'missing']).default('available'),
  cached: z.boolean().default(false),
  lastVerifiedAt: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.providerId && value.deviceId) context.addIssue({ code: 'custom', message: 'A location cannot target both a device and a storage provider.' });
});
const finalStates = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const execFileAsync = promisify(execFile);

function httpError(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function timestamp(): string { return new Date().toISOString(); }
function required<T extends { id: string }>(items: T[], id: string, label: string): T { const item = items.find((candidate) => candidate.id === id); if (!item) throw httpError(404, `${label} not found.`); return item; }
function changed(context: V2RouteContext): void { context.store.markDirty(); context.broadcast({ type: 'v2.updated', payload: { at: timestamp() } }); }
function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw httpError(400, 'Transfer data must be canonical base64.');
  return Buffer.from(value, 'base64');
}
async function writeAll(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Transfer destination accepted a zero-byte write.');
    written += result.bytesWritten;
  }
}
function audit(context: V2RouteContext, action: string, resourceType: string, resourceId?: string, detail: Record<string, unknown> = {}): AuditRecord {
  const actor = context.currentAuditActor();
  return appendAudit(context.store, { ...actor, action, resourceType, resourceId, outcome: 'success', detail });
}
function cleanPatch(body: Record<string, unknown>): Record<string, unknown> { const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>; for (const [key, value] of Object.entries(body)) if (!['id', 'createdAt', '__proto__', 'prototype', 'constructor'].includes(key)) clean[key] = value; return clean; }

function validateStorageConfiguration(
  value: { kind: StorageConnection['kind']; deviceId?: string; rootPath?: string },
  refinement: z.RefinementCtx,
): void {
  if (value.deviceId && !filesystemStorageKinds.has(value.kind)) {
    refinement.addIssue({ code: 'custom', message: 'Device backing is supported only for filesystem storage providers.', path: ['deviceId'] });
  }
  if (value.deviceId && !value.rootPath?.trim()) {
    refinement.addIssue({ code: 'custom', message: 'Device-backed storage requires rootPath.', path: ['rootPath'] });
  }
}

type StorageConnectionPatch = z.infer<typeof storagePatchSchema>;

function applyStorageConnectionPatch(target: StorageConnection, patch: StorageConnectionPatch): void {
  if (patch.name !== undefined) target.name = patch.name;
  if (patch.kind !== undefined) target.kind = patch.kind;
  if (patch.readOnly !== undefined) target.readOnly = patch.readOnly;
  if (patch.deviceId === null) delete target.deviceId; else if (patch.deviceId !== undefined) target.deviceId = patch.deviceId;
  if (patch.endpoint === null) delete target.endpoint; else if (patch.endpoint !== undefined) target.endpoint = patch.endpoint;
  if (patch.rootPath === null) delete target.rootPath; else if (patch.rootPath !== undefined) target.rootPath = patch.rootPath;
  if (patch.bucket === null) delete target.bucket; else if (patch.bucket !== undefined) target.bucket = patch.bucket;
  if (patch.region === null) delete target.region; else if (patch.region !== undefined) target.region = patch.region;
  if (patch.secretId === null) delete target.secretId; else if (patch.secretId !== undefined) target.secretId = patch.secretId;
  if (patch.quotaBytes === null) delete target.quotaBytes; else if (patch.quotaBytes !== undefined) target.quotaBytes = patch.quotaBytes;
}

function storageBackingChanged(current: StorageConnection, candidate: StorageConnection): boolean {
  return current.kind !== candidate.kind
    || current.deviceId !== candidate.deviceId
    || current.rootPath !== candidate.rootPath
    || current.endpoint !== candidate.endpoint
    || current.bucket !== candidate.bucket
    || current.region !== candidate.region
    || current.secretId !== candidate.secretId;
}

const allowedHttpHosts = (process.env.FLEET_HTTP_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
function explicitlyAllowedHost(hostname: string): boolean { const host = hostname.toLowerCase(); return allowedHttpHosts.some((allowed) => allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) && host !== allowed.slice(2) : host === allowed); }
function privateAddress(address: string): boolean {
  if (address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]; const value = mapped ?? address; if (isIP(value) !== 4) return false; const octets = value.split('.').map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) || (octets[0] === 198 && octets[1]! >= 18 && octets[1]! <= 19) || octets[0]! >= 224;
}
async function validateOutboundUrl(input: string | URL): Promise<URL> { const url = input instanceof URL ? input : new URL(input); if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Only HTTP(S) URLs are allowed.'); if (url.username || url.password) throw httpError(400, 'URL credentials are not allowed.'); const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); const allowlisted = explicitlyAllowedHost(host); if (host === 'localhost' || host.endsWith('.localhost')) { if (!allowlisted && process.env.FLEET_HTTP_ALLOW_PRIVATE !== 'true') throw httpError(403, 'Loopback HTTP targets are blocked.'); return url; } const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }); if (!addresses.length) throw httpError(400, 'HTTP target did not resolve.'); if (!allowlisted && process.env.FLEET_HTTP_ALLOW_PRIVATE !== 'true' && addresses.some((entry) => privateAddress(entry.address))) throw httpError(403, 'Private, link-local, and metadata HTTP targets are blocked.'); return url; }
async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> { let url = await validateOutboundUrl(input); const headers = new Headers(init.headers); headers.delete('authorization'); headers.delete('proxy-authorization'); headers.delete('cookie'); for (let redirects = 0; redirects <= 5; redirects += 1) { const response = await fetch(url, { ...init, headers, redirect: 'manual' }); if (![301, 302, 303, 307, 308].includes(response.status)) return response; const location = response.headers.get('location'); if (!location) return response; if (redirects === 5) throw httpError(502, 'Too many HTTP redirects.'); url = await validateOutboundUrl(new URL(location, url)); } throw httpError(502, 'HTTP redirect failed.'); }

function metricValue(point: MetricHistoryPoint, metric: AlertRule['metric'], online = true): number | string | undefined {
  if (metric === 'offline') return online ? 0 : 1;
  if (metric === 'cpu') return point.cpuPercent;
  if (metric === 'memory') return point.memoryPercent;
  if (metric === 'gpu') return point.gpuPercent;
  if (metric === 'temperature') return point.temperatureCelsius;
  if (metric === 'disk') return point.diskPercent;
  if (metric === 'battery') return point.batteryPercent;
  return undefined;
}

function compare(actual: number | string | undefined, operator: AlertRule['operator'], threshold: number | string | undefined): boolean {
  if (actual === undefined || threshold === undefined) return false;
  if (operator === 'eq') return actual === threshold;
  if (operator === 'not-eq') return actual !== threshold;
  const a = Number(actual), b = Number(threshold); if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return operator === 'gt' ? a > b : operator === 'gte' ? a >= b : operator === 'lt' ? a < b : a <= b;
}

type PipelineExpressionOperator = '==' | '!=' | '>' | '>=' | '<' | '<=';
interface ParsedPipelineExpression { path: string; operator?: PipelineExpressionOperator; expected?: unknown }

/** Parse a deliberately small condition language; pipeline expressions are never evaluated as JavaScript. */
function parsePipelineExpression(value: string): ParsedPipelineExpression {
  const expression = value.trim();
  if (!expression) throw new Error('expression condition requires an expression.');
  const match = expression.match(/^(state|(?:parameters|output)(?:\.[A-Za-z0-9_-]+)*)(?:\s*(==|!=|>=|<=|>|<)\s*(.+))?$/);
  if (!match) throw new Error('expression must use state, parameters.<key>, or output.<key> with an optional comparison.');
  const path = match[1]!; const operator = match[2] as PipelineExpressionOperator | undefined;
  if (!operator) return { path };
  const literal = match[3]!.trim();
  if (!literal) throw new Error('expression comparison is missing a value.');
  let expected: unknown;
  if (/^(?:true|false|null|-?(?:\d+(?:\.\d+)?|\.\d+))$/.test(literal)) expected = JSON.parse(literal);
  else if ((literal.startsWith('"') && literal.endsWith('"')) || (literal.startsWith("'") && literal.endsWith("'"))) {
    if (literal.startsWith('"')) { try { expected = JSON.parse(literal); } catch { throw new Error('expression contains an invalid quoted string.'); } }
    else expected = literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  } else expected = literal;
  return { path, operator, expected };
}

function expressionValue(path: string, parent: PipelineNodeRun, run: PipelineRun): unknown {
  if (path === 'state') return parent.state;
  const [root, ...segments] = path.split('.'); let value: unknown = root === 'parameters' ? run.parameters : parent.output;
  for (const segment of segments) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment) || !value || typeof value !== 'object' || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function evaluatePipelineExpression(expression: string, parent: PipelineNodeRun, run: PipelineRun): boolean {
  const parsed = parsePipelineExpression(expression); const actual = expressionValue(parsed.path, parent, run);
  if (!parsed.operator) return Boolean(actual);
  if (parsed.operator === '==') return actual === parsed.expected;
  if (parsed.operator === '!=') return actual !== parsed.expected;
  const left = Number(actual), right = Number(parsed.expected); if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return parsed.operator === '>' ? left > right : parsed.operator === '>=' ? left >= right : parsed.operator === '<' ? left < right : left <= right;
}

function edgeAllowsRun(edge: PipelineDefinition['edges'][number], parent: PipelineNodeRun, run: PipelineRun): boolean {
  if (edge.condition === 'always') return true;
  if (edge.condition === 'success') return parent.state === 'succeeded';
  if (edge.condition === 'failure') return parent.state === 'failed';
  return evaluatePipelineExpression(edge.expression ?? '', parent, run);
}

export function registerV2Routes(app: FastifyInstance, context: V2RouteContext): V2Runtime {
  const { store } = context;
  const vaultKey = process.env.FLEET_MASTER_KEY ?? process.env.FLEET_VAULT_KEY ?? (context.loopback ? context.token : '');
  if (!vaultKey && !context.loopback) throw new Error('FLEET_MASTER_KEY is required when Fleet Core listens beyond loopback.');
  const pipelineTimers = new Set<NodeJS.Timeout>();
  const pipelineRunLocks = new Set<string>();
  const transferLocks = new Map<string, Promise<void>>();
  const wakeRequests = new Map<string, number>();
  const idleShutdownEligible = new Set<string>();
  const idleSince = new Map<string, number>();
  const shutdownRequests = new Map<string, number>();

  function deviceGroupIds(deviceId: string): string[] {
    const profileIds = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId)?.groupIds ?? [];
    const declaredIds = store.state.v2.groups.filter((group) => group.deviceIds.includes(deviceId)).map((group) => group.id);
    return [...new Set([...profileIds, ...declaredIds])];
  }

  function projectWorkspaceId(projectId?: string): string | undefined {
    if (!projectId) return undefined;
    return store.state.projects.find((item) => item.id === projectId)?.workspaceId ?? store.state.v2.workspaces[0]?.id;
  }

  function recordAcceptedPowerAction(deviceId: string, action: DevicePowerAction): void {
    const powerState = action === 'wake' ? 'waking'
      : action === 'sleep' ? 'sleeping'
        : action === 'restart' ? 'restarting'
          : action === 'shutdown' ? 'powered-off'
            : undefined;
    if (!powerState) return;
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId);
    if (!profile) return;
    const at = timestamp();
    profile.powerState = powerState;
    profile.powerStateUpdatedAt = at;
    profile.updatedAt = at;
  }

  function authenticateDeviceCredential(value: string): string | undefined {
    for (const metadata of store.state.v2.deviceCredentials) {
      if (metadata.revokedAt || (metadata.expiresAt && new Date(metadata.expiresAt).getTime() <= Date.now())) continue;
      if (verifyCredential(value, store.state.private.deviceCredentialHashes[metadata.id])) { metadata.lastUsedAt = timestamp(); store.markDirty(); return metadata.deviceId; }
    }
    return undefined;
  }

  function authenticateApiToken(value: string): ApiTokenMetadata | undefined {
    for (const metadata of store.state.v2.apiTokens) {
      if (metadata.status !== 'active' || (metadata.expiresAt && new Date(metadata.expiresAt).getTime() <= Date.now())) continue;
      if (verifyCredential(value, store.state.private.apiTokenHashes[metadata.id])) { metadata.lastUsedAt = timestamp(); store.markDirty(); return metadata; }
    }
    return undefined;
  }

  function enforceInternalPolicy(action: string, actorId: string, input: { resourceType: string; resourceId?: string; projectId?: string; deviceId?: string; environment?: string }): void {
    const profile = input.deviceId ? store.state.v2.deviceProfiles.find((item) => item.deviceId === input.deviceId) : undefined;
    const decision = evaluateFleetPolicies(store.state.v2.policies, { action, actorType: 'system', actorId, projectId: input.projectId, workspaceId: projectWorkspaceId(input.projectId), deviceId: input.deviceId, deviceGroupIds: input.deviceId ? deviceGroupIds(input.deviceId) : undefined, environment: input.environment, dataClassification: profile?.dataClassification });
    if (decision.effect === 'allow') { if (decision.policy) appendAudit(store, { actorType: 'system', actorId, action, resourceType: input.resourceType, resourceId: input.resourceId, outcome: 'success', detail: { policyId: decision.policy.id } }); return; }
    appendAudit(store, { actorType: 'system', actorId, action, resourceType: input.resourceType, resourceId: input.resourceId, outcome: 'denied', detail: { policyId: decision.policy?.id, effect: decision.effect } });
    throw httpError(decision.effect === 'require-approval' ? 409 : 403, `Policy ${decision.policy?.name ?? 'rule'} ${decision.effect === 'require-approval' ? 'requires approval for' : 'denies'} ${action}.`);
  }

  app.get('/api/v2/snapshot', async () => store.v2Snapshot());
  app.get('/api/v2', async () => store.v2Snapshot());
  app.get('/api/v2/menu-bar', async () => buildMenuBarSnapshot(store.state, context.coreUrl));

  interface TailscalePeer { id: string; hostname: string; dnsName?: string; ips: string[]; online: boolean; os?: string; associatedDeviceId?: string }
  async function tailscalePeers(): Promise<TailscalePeer[]> {
    let stdout: string; try { ({ stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })); } catch (error) { throw httpError(503, `Tailscale status is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    const value = JSON.parse(stdout) as { Peer?: Record<string, { ID?: string; HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string }> }; return Object.entries(value.Peer ?? {}).map(([key, peer]) => { const ips = peer.TailscaleIPs ?? []; const hostname = peer.HostName ?? peer.DNSName?.split('.')[0] ?? key; const associated = store.state.devices.find((device) => device.hostname === hostname || device.metrics.network.tailscaleDnsName === peer.DNSName || (device.metrics.network.tailscaleIp && ips.includes(device.metrics.network.tailscaleIp))); return { id: peer.ID ?? key, hostname, dnsName: peer.DNSName, ips, online: Boolean(peer.Online), os: peer.OS, associatedDeviceId: associated?.id }; });
  }
  app.get('/api/v2/tailscale/devices', async () => tailscalePeers());
  app.post('/api/v2/tailscale/import', async (request, reply) => { const { peerIds } = z.object({ peerIds: z.array(idSchema).min(1).max(500) }).parse(request.body); const peers = await tailscalePeers(), selected = peers.filter((peer) => peerIds.includes(peer.id)); if (selected.length !== new Set(peerIds).size) throw httpError(404, 'One or more selected Tailscale peers no longer exist.'); const imported: Device[] = []; for (const peer of selected.filter((item) => !item.associatedDeviceId)) { const at = timestamp(); const device: Device = { id: `tailscale-${createHash('sha256').update(peer.id).digest('hex').slice(0, 24)}`, name: peer.hostname, hostname: peer.hostname, role: 'unknown', status: 'offline', platform: peer.os ?? 'unknown', arch: 'unknown', osName: peer.os ?? 'Unknown', osVersion: '', agentVersion: '', capabilities: { codex: false, git: false, docker: false, tailscale: true, cuda: false, mlx: false, node: false, wakeOnLan: false, shell: '', labels: ['tailscale-import'] }, metrics: { cpu: { model: 'Unknown', cores: 0, usagePercent: 0 }, memory: { totalBytes: 0, usedBytes: 0, usagePercent: 0 }, storage: [], gpus: [], network: { rxBytesPerSecond: 0, txBytesPerSecond: 0, tailscaleIp: peer.ips[0], tailscaleDnsName: peer.dnsName }, uptimeSeconds: 0, sampledAt: at }, projectRoots: [], position: { x: 80 + (store.state.devices.length % 3) * 330, y: 90 + Math.floor(store.state.devices.length / 3) * 260 }, lastSeenAt: at, connectedAt: at, activeJobIds: [], activeSessionIds: [] }; store.state.devices.push(device); store.state.v2.deviceProfiles.push({ deviceId: device.id, displayName: device.name, groupIds: [], powerPolicy: { wakeForJobs: false, preventSleepDuringJobs: true }, updateChannel: 'stable', maintenanceMode: false, dataClassification: 'internal', trusted: false, quarantined: false, updatedAt: at }); imported.push(device); audit(context, 'tailscale.import', 'device', device.id, { tailscalePeerId: peer.id }); } changed(context); return reply.code(201).send({ imported }); });

  const enrollmentSchema = z.object({ label: nameSchema, role: z.enum(['core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown']).optional(), groupIds: z.array(idSchema).max(100).default([]), updateChannel: z.enum(['stable', 'beta', 'development']).default('stable'), expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(), expiresInHours: z.number().positive().max(8_760).default(24), maxUses: z.number().int().min(1).max(10_000).default(1) });
  app.post('/api/v2/enrollment/tokens', async (request, reply) => {
    const body = enrollmentSchema.parse(request.body); const token = issueCredential('fle_'); const id = randomUUID();
    const record = { id, label: body.label, role: body.role, groupIds: body.groupIds, updateChannel: body.updateChannel, expiresAt: new Date(Date.now() + (body.expiresInSeconds ?? body.expiresInHours * 3_600) * 1_000).toISOString(), maxUses: body.maxUses, uses: 0, createdAt: timestamp(), createdBy: context.currentAuditActor().actorId };
    store.state.v2.enrollmentTokens.unshift(record); store.state.private.enrollmentTokenHashes[id] = hashCredential(token); audit(context, 'enrollment-token.create', 'enrollment-token', id); changed(context);
    return reply.code(201).send({ ...record, record, token, enrollmentUrl: `${context.coreUrl}/api/v2/enrollment/exchange` });
  });
  app.delete('/api/v2/enrollment/tokens/:id', async (request, reply) => {
    const record = required(store.state.v2.enrollmentTokens, (request.params as { id: string }).id, 'Enrollment token'); record.revokedAt = timestamp(); delete store.state.private.enrollmentTokenHashes[record.id]; audit(context, 'enrollment-token.revoke', 'enrollment-token', record.id); changed(context); return reply.code(204).send();
  });
  app.post('/api/v2/enrollment/exchange', async (request, reply) => {
    const body = z.object({ token: z.string().min(20).max(500), device: z.object({ id: idSchema, name: nameSchema, hostname: nameSchema, platform: z.string().max(100), arch: z.string().max(100), agentVersion: z.string().max(100), protocolVersion: z.number().int().min(1).max(100) }) }).parse(request.body);
    if (body.device.protocolVersion !== store.state.v2.protocolVersion) throw httpError(409, `Protocol version mismatch: Core requires ${store.state.v2.protocolVersion}, Agent supplied ${body.device.protocolVersion}.`);
    const record = store.state.v2.enrollmentTokens.find((candidate) => !candidate.revokedAt && candidate.uses < candidate.maxUses && new Date(candidate.expiresAt).getTime() > Date.now() && verifyCredential(body.token, store.state.private.enrollmentTokenHashes[candidate.id]));
    if (!record) { appendAudit(store, { actorType: 'agent', actorId: body.device.id, action: 'enrollment.exchange', resourceType: 'device', resourceId: body.device.id, outcome: 'denied', detail: {} }); throw httpError(401, 'Enrollment token is invalid, expired, revoked, or exhausted.'); }
    record.uses += 1; record.lastUsedAt = timestamp(); if (record.uses >= record.maxUses) delete store.state.private.enrollmentTokenHashes[record.id];
    const credential = issueCredential('flc_'); const credentialId = randomUUID(); const issuedAt = timestamp();
    const metadata = { id: credentialId, deviceId: body.device.id, fingerprint: createHash('sha256').update(credential).digest('hex').slice(0, 16), issuedAt };
    store.state.v2.deviceCredentials.unshift(metadata); store.state.private.deviceCredentialHashes[credentialId] = hashCredential(credential);
    const profile: ManagedDeviceProfile = store.state.v2.deviceProfiles.find((item) => item.deviceId === body.device.id) ?? { deviceId: body.device.id, displayName: body.device.name, role: record.role, groupIds: record.groupIds, powerPolicy: { wakeForJobs: true, preventSleepDuringJobs: true }, updateChannel: record.updateChannel, maintenanceMode: false, dataClassification: 'internal', trusted: true, quarantined: false, updatedAt: issuedAt };
    if (!store.state.v2.deviceProfiles.some((item) => item.deviceId === body.device.id)) store.state.v2.deviceProfiles.push(profile);
    appendAudit(store, { actorType: 'agent', actorId: body.device.id, action: 'enrollment.exchange', resourceType: 'device', resourceId: body.device.id, outcome: 'success', detail: { credentialId } }); changed(context);
    return reply.code(201).send({ credential, credentialId, deviceId: body.device.id, coreUrl: context.coreUrl, protocolVersion: store.state.v2.protocolVersion });
  });
  app.post('/api/v2/device-credentials/:id/revoke', async (request) => { const item = required(store.state.v2.deviceCredentials, (request.params as { id: string }).id, 'Device credential'); item.revokedAt = timestamp(); delete store.state.private.deviceCredentialHashes[item.id]; context.disconnectDevice(item.deviceId, 'Device credential revoked'); audit(context, 'credential.revoke', 'device-credential', item.id); changed(context); return item; });
  app.post('/api/v2/devices/:id/decommission', async (request) => {
    const id = (request.params as { id: string }).id; for (const item of store.state.v2.deviceCredentials.filter((candidate) => candidate.deviceId === id)) { item.revokedAt = timestamp(); delete store.state.private.deviceCredentialHashes[item.id]; }
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === id); if (profile) { profile.trusted = false; profile.quarantined = true; profile.quarantineReason = 'Decommissioned'; profile.updatedAt = timestamp(); }
    const device = store.state.devices.find((item) => item.id === id); if (device) device.status = 'offline'; context.disconnectDevice(id, 'Device decommissioned'); audit(context, 'device.decommission', 'device', id); changed(context); return { deviceId: id, decommissionedAt: timestamp() };
  });

  app.get('/api/v2/sites', async () => store.state.v2.sites);
  app.post('/api/v2/sites', async (request, reply) => { const body = z.object({ name: nameSchema, description: z.string().max(4_000).default(''), timezone: z.string().min(1).max(100), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), securityZone: z.string().max(100).optional() }).parse(request.body); const at = timestamp(); const item: FleetSite = { id: randomUUID(), ...body, createdAt: at, updatedAt: at }; store.state.v2.sites.push(item); audit(context, 'site.create', 'site', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/sites/:id', async (request) => { const item = required(store.state.v2.sites, (request.params as { id: string }).id, 'Site'); Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { updatedAt: timestamp() }); audit(context, 'site.update', 'site', item.id); changed(context); return item; });
  app.delete('/api/v2/sites/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.sites, id, 'Site'); store.state.v2.sites = store.state.v2.sites.filter((item) => item.id !== id); for (const profile of store.state.v2.deviceProfiles) if (profile.siteId === id) profile.siteId = undefined; audit(context, 'site.delete', 'site', id); changed(context); return reply.code(204).send(); });

  app.get('/api/v2/groups', async () => store.state.v2.groups);
  app.post('/api/v2/groups', async (request, reply) => { const body = z.object({ name: nameSchema, description: z.string().max(4_000).default(''), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'), deviceIds: z.array(idSchema).default([]), siteId: idSchema.optional() }).parse(request.body); const at = timestamp(); const item: DeviceGroup = { id: randomUUID(), ...body, createdAt: at, updatedAt: at }; store.state.v2.groups.push(item); audit(context, 'group.create', 'device-group', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/groups/:id', async (request) => { const item = required(store.state.v2.groups, (request.params as { id: string }).id, 'Group'); Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { updatedAt: timestamp() }); audit(context, 'group.update', 'device-group', item.id); changed(context); return item; });
  app.delete('/api/v2/groups/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.groups, id, 'Group'); store.state.v2.groups = store.state.v2.groups.filter((item) => item.id !== id); for (const profile of store.state.v2.deviceProfiles) profile.groupIds = profile.groupIds.filter((groupId) => groupId !== id); audit(context, 'group.delete', 'device-group', id); changed(context); return reply.code(204).send(); });

  app.get('/api/v2/device-profiles', async () => store.state.v2.deviceProfiles);
  app.put('/api/v2/device-profiles/:deviceId', async (request) => {
    const deviceId = (request.params as { deviceId: string }).deviceId; if (!store.state.devices.some((device) => device.id === deviceId) && !store.state.v2.deviceCredentials.some((item) => item.deviceId === deviceId)) throw httpError(404, 'Device not found.');
    const body = recordSchema.parse(request.body); let item = store.state.v2.deviceProfiles.find((profile) => profile.deviceId === deviceId);
    if (!item) { item = { deviceId, groupIds: [], powerPolicy: { wakeForJobs: true, preventSleepDuringJobs: true }, updateChannel: 'stable', maintenanceMode: false, dataClassification: 'internal', trusted: true, quarantined: false, updatedAt: timestamp() }; store.state.v2.deviceProfiles.push(item); }
    Object.assign(item, cleanPatch(body), { deviceId, updatedAt: timestamp() }); if (item.quarantined || !item.trusted) context.disconnectDevice(deviceId, item.quarantined ? 'Device quarantined' : 'Device trust revoked'); audit(context, 'device-profile.update', 'device', deviceId); changed(context); return item;
  });
  app.patch('/api/v2/device-profiles/:deviceId', async (request) => { const deviceId = (request.params as { deviceId: string }).deviceId; if (!store.state.devices.some((device) => device.id === deviceId) && !store.state.v2.deviceCredentials.some((item) => item.deviceId === deviceId)) throw httpError(404, 'Device not found.'); let item = store.state.v2.deviceProfiles.find((profile) => profile.deviceId === deviceId); if (!item) { item = { deviceId, groupIds: [], powerPolicy: { wakeForJobs: true, preventSleepDuringJobs: true }, updateChannel: 'stable', maintenanceMode: false, dataClassification: 'internal', trusted: true, quarantined: false, updatedAt: timestamp() }; store.state.v2.deviceProfiles.push(item); } Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { deviceId, updatedAt: timestamp() }); if (item.quarantined || !item.trusted) context.disconnectDevice(deviceId, item.quarantined ? 'Device quarantined' : 'Device trust revoked'); audit(context, 'device-profile.update', 'device', deviceId); changed(context); return item; });
  app.post('/api/v2/devices/:id/power', async (request, reply) => {
    const deviceId = (request.params as { id: string }).id; const { action } = z.object({ action: z.enum(powerActions as [DevicePowerAction, ...DevicePowerAction[]]) }).parse(request.body); const device = store.state.devices.find((item) => item.id === deviceId); if (!device) throw httpError(404, 'Device not found.');
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId); let targetId = deviceId; const payload: { action: DevicePowerAction; macAddress?: string; broadcastAddress?: string } = { action };
    if (action === 'wake') { if (!profile?.wakeMacAddress || !profile.wakeRelayDeviceId) throw httpError(409, 'Wake-on-LAN relay and MAC address are not configured.'); targetId = profile.wakeRelayDeviceId; payload.macAddress = profile.wakeMacAddress; payload.broadcastAddress = profile.wakeBroadcastAddress; }
    if (!context.isOnline(targetId)) throw httpError(409, 'Power action target or wake relay is offline.'); const result = await context.dispatch(targetId, { type: 'device.power', payload }); recordAcceptedPowerAction(deviceId, action); audit(context, `device.power.${action}`, 'device', deviceId, { relayDeviceId: targetId === deviceId ? undefined : targetId }); changed(context); return reply.code(202).send({ action, deviceId, targetId, result });
  });

  function clockParts(at: Date, timezone: string): { weekday: number; minute: number } | undefined {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
      const weekdayName = parts.find((part) => part.type === 'weekday')?.value;
      const hour = Number(parts.find((part) => part.type === 'hour')?.value);
      const minute = Number(parts.find((part) => part.type === 'minute')?.value);
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName ?? '');
      return weekday >= 0 && Number.isFinite(hour) && Number.isFinite(minute) ? { weekday, minute: hour * 60 + minute } : undefined;
    } catch { return undefined; }
  }

  function clockMinute(value: string): number | undefined {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return undefined;
    const hour = Number(match[1]), minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : undefined;
  }

  function dailyWindowActive(start: number, end: number, now: { weekday: number; minute: number }, weekdays?: number[]): boolean {
    const enabledDays = weekdays?.length ? new Set(weekdays) : undefined;
    if (start === end) return Boolean(!enabledDays || enabledDays.has(now.weekday));
    if (start < end) return (!enabledDays || enabledDays.has(now.weekday)) && now.minute >= start && now.minute < end;
    if (now.minute >= start) return !enabledDays || enabledDays.has(now.weekday);
    const previousWeekday = (now.weekday + 6) % 7;
    return now.minute < end && (!enabledDays || enabledDays.has(previousWeekday));
  }

  function quietHoursActive(profile: ManagedDeviceProfile, at = new Date()): boolean {
    const quiet = profile.powerPolicy.quietHours;
    if (!quiet?.enabled) return false;
    const now = clockParts(at, quiet.timezone), start = clockMinute(quiet.start), end = clockMinute(quiet.end);
    return Boolean(now && start !== undefined && end !== undefined && dailyWindowActive(start, end, now, quiet.weekdays));
  }

  function maintenanceActive(profile: ManagedDeviceProfile, at = new Date()): boolean {
    if (profile.maintenanceMode) return true;
    const window = profile.maintenanceWindow;
    if (!window) return false;
    const startMinute = clockMinute(window.start), endMinute = clockMinute(window.end);
    if (startMinute !== undefined && endMinute !== undefined) {
      const now = clockParts(at, window.timezone);
      return Boolean(now && dailyWindowActive(startMinute, endMinute, now));
    }
    const start = Date.parse(window.start), end = Date.parse(window.end), current = at.getTime();
    return Number.isFinite(start) && Number.isFinite(end) && current >= Math.min(start, end) && current < Math.max(start, end);
  }

  function wakeEligibility(deviceId: string): { eligible: boolean; relayId?: string; detail: string } {
    const device = store.state.devices.find((item) => item.id === deviceId);
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId);
    if (!device || !profile) return { eligible: false, detail: 'Device power profile is unavailable.' };
    if (context.isOnline(deviceId)) return { eligible: false, detail: 'Device is already online.' };
    if (!profile.powerPolicy.wakeForJobs) return { eligible: false, detail: 'Wake for jobs is disabled.' };
    if (!profile.trusted || profile.quarantined) return { eligible: false, detail: 'Device trust policy blocks automatic wake.' };
    if (maintenanceActive(profile)) return { eligible: false, detail: 'Device is in a maintenance window.' };
    if (quietHoursActive(profile)) return { eligible: false, detail: 'Device is in quiet hours.' };
    if (!profile.wakeMacAddress || !profile.wakeRelayDeviceId) return { eligible: false, detail: 'Wake relay and MAC address are not configured.' };
    const relay = store.state.devices.find((item) => item.id === profile.wakeRelayDeviceId);
    if (!relay || !context.isOnline(relay.id)) return { eligible: false, detail: 'Configured wake relay is offline.' };
    if (!relay.capabilities.wakeOnLan) return { eligible: false, detail: 'Configured relay does not advertise Wake-on-LAN capability.' };
    const battery = device.metrics.battery;
    if (profile.powerPolicy.minimumBatteryPercent !== undefined && battery && !battery.acConnected && battery.percent < profile.powerPolicy.minimumBatteryPercent) return { eligible: false, detail: 'Device battery is below its power-policy minimum.' };
    const hottest = Math.max(device.metrics.cpu.temperatureCelsius ?? 0, ...device.metrics.gpus.map((gpu) => gpu.temperatureCelsius ?? 0));
    if (profile.powerPolicy.maximumTemperatureCelsius !== undefined && hottest > profile.powerPolicy.maximumTemperatureCelsius) return { eligible: false, detail: 'Device temperature exceeds its power-policy maximum.' };
    return { eligible: true, relayId: relay.id, detail: `Wake-on-LAN is available through ${relay.name}.` };
  }

  async function wakeForJob(deviceId: string, jobId: string): Promise<{ state: 'requested' | 'pending' | 'blocked'; detail: string }> {
    if (context.isOnline(deviceId)) return { state: 'pending', detail: 'Device is online and ready for dispatch.' };
    const eligibility = wakeEligibility(deviceId);
    if (!eligibility.eligible || !eligibility.relayId) return { state: 'blocked', detail: eligibility.detail };
    const previous = wakeRequests.get(deviceId);
    if (previous && Date.now() - previous < 30_000) return { state: 'pending', detail: 'Wake was already requested; waiting for the device to reconnect.' };
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId)!;
    wakeRequests.set(deviceId, Date.now());
    try {
      enforceInternalPolicy('devices.power', 'power-lifecycle', { resourceType: 'device', resourceId: deviceId, deviceId });
      await context.dispatch(eligibility.relayId, { type: 'device.power', payload: { action: 'wake', macAddress: profile.wakeMacAddress, broadcastAddress: profile.wakeBroadcastAddress } });
      appendAudit(store, { actorType: 'system', actorId: 'power-lifecycle', action: 'device.power.wake-for-job', resourceType: 'device', resourceId: deviceId, outcome: 'success', detail: { jobId, relayDeviceId: eligibility.relayId } });
      context.activity({ type: 'device', severity: 'info', title: 'Device wake requested', detail: `Fleet requested Wake-on-LAN for a queued job and is waiting for the device to reconnect.`, deviceId, entityId: jobId });
      changed(context);
      return { state: 'requested', detail: 'Wake-on-LAN sent; waiting for the device to reconnect.' };
    } catch (error) {
      wakeRequests.delete(deviceId);
      const detail = error instanceof Error ? error.message : String(error);
      appendAudit(store, { actorType: 'system', actorId: 'power-lifecycle', action: 'device.power.wake-for-job', resourceType: 'device', resourceId: deviceId, outcome: 'failed', detail: { jobId, relayDeviceId: eligibility.relayId, error: detail } });
      store.markDirty();
      return { state: 'blocked', detail: `Wake request failed: ${detail}` };
    }
  }

  function evaluatePoint(point: MetricHistoryPoint, deviceOnline = true): FleetAlert[] {
    const opened: FleetAlert[] = []; let updated = false;
    for (const rule of store.state.v2.alertRules.filter((item) => { const groupMatch = item.groupIds.some((groupId) => store.state.v2.groups.find((group) => group.id === groupId)?.deviceIds.includes(point.deviceId)); return item.enabled && ((!item.deviceIds.length && !item.groupIds.length) || item.deviceIds.includes(point.deviceId) || groupMatch); })) {
      const fingerprint = `${rule.id}:${point.deviceId}`; let triggered = compare(metricValue(point, rule.metric, deviceOnline), rule.operator, rule.threshold);
      if (triggered && rule.durationSeconds > 0 && rule.metric === 'offline') { const device = store.state.devices.find((item) => item.id === point.deviceId); triggered = !deviceOnline && Boolean(device && Date.now() - new Date(device.lastSeenAt).getTime() >= rule.durationSeconds * 1_000); }
      else if (triggered && rule.durationSeconds > 0) { const cutoff = new Date(point.sampledAt).getTime() - rule.durationSeconds * 1_000; const history = store.state.v2.metricHistory.filter((item) => item.deviceId === point.deviceId && new Date(item.sampledAt).getTime() <= new Date(point.sampledAt).getTime()).sort((a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime()); let start = -1; for (let index = 0; index < history.length; index += 1) if (new Date(history[index]!.sampledAt).getTime() <= cutoff) start = index; triggered = start >= 0 && history.slice(start).every((item) => compare(metricValue(item, rule.metric, deviceOnline), rule.operator, rule.threshold)); }
      const existing = store.state.v2.alerts.find((item) => item.fingerprint === fingerprint && item.status !== 'resolved');
      const latestResolved = store.state.v2.alerts.find((item) => item.fingerprint === fingerprint && item.status === 'resolved'); const coolingDown = Boolean(latestResolved?.resolvedAt && Date.now() - new Date(latestResolved.resolvedAt).getTime() < rule.cooldownSeconds * 1_000);
      if (triggered && !existing && !coolingDown) { const alert: FleetAlert = { id: randomUUID(), ruleId: rule.id, deviceId: point.deviceId, severity: rule.severity, status: 'open', title: rule.name, detail: `${rule.metric} is ${rule.operator} ${String(rule.threshold)}.`, openedAt: timestamp(), fingerprint }; store.state.v2.alerts.unshift(alert); opened.push(alert); void notify(rule.severity === 'critical' ? 'critical' : 'warning', alert.title, alert.detail, rule.notificationChannelIds); void emitFleetEvent('alert.opened', alert); }
      if (!triggered && existing) { existing.status = 'resolved'; existing.resolvedAt = timestamp(); updated = true; }
    }
    if (opened.length || updated) changed(context); return opened;
  }

  function recordTelemetry(device: Device): void {
    const disk = device.metrics.storage.length ? Math.max(...device.metrics.storage.map((item) => item.usagePercent)) : undefined;
    const gpu = device.metrics.gpus[0]; const point: MetricHistoryPoint = { id: randomUUID(), deviceId: device.id, sampledAt: device.metrics.sampledAt, cpuPercent: device.metrics.cpu.usagePercent, memoryPercent: device.metrics.memory.usagePercent, gpuPercent: gpu?.usagePercent, vramPercent: gpu?.vramTotalBytes && gpu.vramUsedBytes ? gpu.vramUsedBytes / gpu.vramTotalBytes * 100 : undefined, temperatureCelsius: gpu?.temperatureCelsius ?? device.metrics.cpu.temperatureCelsius, diskPercent: disk, rxBytesPerSecond: device.metrics.network.rxBytesPerSecond, txBytesPerSecond: device.metrics.network.txBytesPerSecond, batteryPercent: device.metrics.battery?.percent, powerWatts: device.metrics.powerDrawWatts };
    store.state.v2.metricHistory.push(point); evaluatePoint(point, device.status !== 'offline'); evaluateEvent('agent-version', { deviceId: device.id, actual: device.agentVersion, identity: device.id, detail: `Agent ${device.name} reports version ${device.agentVersion}.` }); store.markDirty();
  }

  function evaluateDeviceAlerts(device: Device): void { const previous = [...store.state.v2.metricHistory].reverse().find((point) => point.deviceId === device.id); const point: MetricHistoryPoint = previous ?? { id: randomUUID(), deviceId: device.id, sampledAt: timestamp(), cpuPercent: device.metrics.cpu.usagePercent, memoryPercent: device.metrics.memory.usagePercent, rxBytesPerSecond: 0, txBytesPerSecond: 0 }; evaluatePoint({ ...point, sampledAt: timestamp() }, device.status !== 'offline'); }

  function evaluateEvent(metric: AlertRule['metric'], input: { deviceId?: string; jobId?: string; identity?: string; actual?: number | string; active?: boolean; detail?: string }): FleetAlert[] {
    const opened: FleetAlert[] = []; let updated = false; const identity = input.identity ?? input.jobId ?? input.deviceId ?? 'fleet';
    for (const rule of store.state.v2.alertRules.filter((candidate) => { const groupMatch = Boolean(input.deviceId && candidate.groupIds.some((groupId) => store.state.v2.groups.find((group) => group.id === groupId)?.deviceIds.includes(input.deviceId!))); return candidate.enabled && candidate.metric === metric && ((!candidate.deviceIds.length && !candidate.groupIds.length) || Boolean(input.deviceId && (candidate.deviceIds.includes(input.deviceId) || groupMatch))); })) {
      const fingerprint = `${rule.id}:${identity}`, existing = store.state.v2.alerts.find((alert) => alert.fingerprint === fingerprint && alert.status !== 'resolved'); const latestResolved = store.state.v2.alerts.find((alert) => alert.fingerprint === fingerprint && alert.status === 'resolved'); const coolingDown = Boolean(latestResolved?.resolvedAt && Date.now() - new Date(latestResolved.resolvedAt).getTime() < rule.cooldownSeconds * 1_000); const actual = input.actual ?? 1; const triggered = input.active !== false && compare(actual, rule.operator, rule.threshold ?? (typeof actual === 'string' ? actual : 1));
      if (triggered && !existing && !coolingDown) { const alert: FleetAlert = { id: randomUUID(), ruleId: rule.id, deviceId: input.deviceId, jobId: input.jobId, severity: rule.severity, status: 'open', title: rule.name, detail: input.detail ?? `${metric} event matched ${rule.operator} ${String(rule.threshold ?? 1)}.`, openedAt: timestamp(), fingerprint }; store.state.v2.alerts.unshift(alert); opened.push(alert); void notify(rule.severity === 'critical' ? 'critical' : 'warning', alert.title, alert.detail, rule.notificationChannelIds); void emitFleetEvent('alert.opened', alert); }
      if (!triggered && existing) { existing.status = 'resolved'; existing.resolvedAt = timestamp(); updated = true; }
    }
    if (opened.length || updated) changed(context); return opened;
  }

  app.get('/api/v2/telemetry', async (request) => { const query = request.query as { deviceId?: string; from?: string; to?: string; limit?: string }; const from = query.from ? new Date(query.from).getTime() : -Infinity, to = query.to ? new Date(query.to).getTime() : Infinity, limit = Math.min(10_000, Math.max(1, Number(query.limit) || 1_000)); return store.state.v2.metricHistory.filter((point) => (!query.deviceId || point.deviceId === query.deviceId) && new Date(point.sampledAt).getTime() >= from && new Date(point.sampledAt).getTime() <= to).slice(-limit); });
  app.post('/api/v2/telemetry', async (request, reply) => { const point = z.object({ deviceId: idSchema, sampledAt: z.string().datetime(), cpuPercent: z.number(), memoryPercent: z.number(), gpuPercent: z.number().optional(), vramPercent: z.number().optional(), temperatureCelsius: z.number().optional(), diskPercent: z.number().optional(), rxBytesPerSecond: z.number(), txBytesPerSecond: z.number(), batteryPercent: z.number().optional(), powerWatts: z.number().optional() }).parse(request.body); const record: MetricHistoryPoint = { id: randomUUID(), ...point }; store.state.v2.metricHistory.push(record); const alerts = evaluatePoint(record); store.markDirty(); return reply.code(201).send({ point: record, alerts }); });
  app.post('/api/v2/alert-events', async (request, reply) => { const body = z.object({ metric: z.enum(['job-failure', 'job-stuck', 'agent-version', 'nas', 'authentication', 'custom']), deviceId: idSchema.optional(), jobId: idSchema.optional(), identity: idSchema.optional(), actual: z.union([z.number(), z.string()]).optional(), active: z.boolean().default(true), detail: z.string().max(20_000).optional() }).parse(request.body); return reply.code(201).send({ alerts: evaluateEvent(body.metric, body) }); });
  app.get('/api/v2/alert-rules', async () => store.state.v2.alertRules);
  app.post('/api/v2/alert-rules', async (request, reply) => { const body = alertRuleBodySchema.parse(request.body); const at = timestamp(); const item: AlertRule = { ...body, id: randomUUID(), createdAt: at, updatedAt: at }; store.state.v2.alertRules.push(item); audit(context, 'alert-rule.create', 'alert-rule', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/alert-rules/:id', async (request) => { const item = required(store.state.v2.alertRules, (request.params as { id: string }).id, 'Alert rule'); Object.assign(item, alertRuleBodySchema.partial().parse(request.body), { updatedAt: timestamp() }); audit(context, 'alert-rule.update', 'alert-rule', item.id); changed(context); return item; });
  app.get('/api/v2/alerts', async () => store.state.v2.alerts);
  app.post('/api/v2/alerts/:id/acknowledge', async (request) => { const item = required(store.state.v2.alerts, (request.params as { id: string }).id, 'Alert'); item.status = 'acknowledged'; item.acknowledgedAt = timestamp(); item.acknowledgedBy = context.currentAuditActor().actorId; audit(context, 'alert.acknowledge', 'alert', item.id); changed(context); return item; });
  app.post('/api/v2/alerts/:id/resolve', async (request) => { const item = required(store.state.v2.alerts, (request.params as { id: string }).id, 'Alert'); item.status = 'resolved'; item.resolvedAt = timestamp(); audit(context, 'alert.resolve', 'alert', item.id); changed(context); return item; });

  app.get('/api/v2/audit', async (request) => { const query = request.query as { limit?: string }; return store.state.v2.audit.slice(-(Math.min(10_000, Math.max(1, Number(query.limit) || 1_000)))); });
  app.get('/api/v2/audit/verify', async () => verifyAudit(store.state.v2.audit));

  app.get('/api/v2/secrets', async () => store.state.v2.secrets);
  app.post('/api/v2/secrets', async (request, reply) => { const body = z.object({ name: nameSchema, description: z.string().max(4_000).default(''), value: z.string().min(1).max(1_000_000), scope: z.enum(['organization', 'workspace', 'project', 'environment', 'device']).default('organization'), scopeId: idSchema.optional(), provider: z.enum(['builtin', 'environment', '1password', 'vault', 'aws', 'azure', 'gcp']).default('builtin'), keyId: z.string().optional(), expiresAt: z.string().datetime().optional(), tags: z.array(z.string()).default([]) }).parse(request.body); const at = timestamp(); const id = randomUUID(); const { value, ...safe } = body; const item: SecretMetadata = { id, ...safe, version: 1, createdAt: at, updatedAt: at }; store.state.v2.secrets.push(item); store.state.private.encryptedSecrets[id] = encryptValue(value, vaultKey); audit(context, 'secret.create', 'secret', id); changed(context); return reply.code(201).send(item); });
  app.post('/api/v2/secrets/:id/reveal', async (request) => { const item = required(store.state.v2.secrets, (request.params as { id: string }).id, 'Secret'); const encrypted = store.state.private.encryptedSecrets[item.id]; if (!encrypted) throw httpError(404, 'Encrypted value is unavailable.'); item.lastAccessedAt = timestamp(); audit(context, 'secret.reveal', 'secret', item.id); store.markDirty(); return { id: item.id, value: decryptValue(encrypted, vaultKey) }; });
  app.put('/api/v2/secrets/:id', async (request) => { const item = required(store.state.v2.secrets, (request.params as { id: string }).id, 'Secret'); const { value } = z.object({ value: z.string().min(1).max(1_000_000) }).parse(request.body); store.state.private.encryptedSecrets[item.id] = encryptValue(value, vaultKey); item.version += 1; item.rotatedAt = timestamp(); item.updatedAt = item.rotatedAt; audit(context, 'secret.rotate', 'secret', item.id); changed(context); return item; });
  app.delete('/api/v2/secrets/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.secrets, id, 'Secret'); store.state.v2.secrets = store.state.v2.secrets.filter((item) => item.id !== id); delete store.state.private.encryptedSecrets[id]; audit(context, 'secret.delete', 'secret', id); changed(context); return reply.code(204).send(); });

  const backupDirectory = join(dirname(store.filePath), 'backups');
  async function createBackup(kind: BackupRecord['kind']): Promise<BackupRecord> {
    const id = randomUUID(), destination = join(backupDirectory, `${id}.fleet-backup`);
    const record: BackupRecord = { id, kind, status: 'running', destination, encrypted: true, version: store.state.version, createdAt: timestamp() };
    store.state.v2.backups.unshift(record);
    store.markDirty();
    try {
      await store.flush();
      await mkdir(backupDirectory, { recursive: true });
      const completedAt = timestamp();
      const snapshot = structuredClone(store.state);
      // A backup must never contain a record that will be resurrected as
      // running. Its own final checksum is necessarily calculated after the
      // snapshot is encrypted and is merged back when the restore is staged.
      for (const backup of snapshot.v2.backups) {
        if (backup.id === id) {
          backup.status = 'succeeded';
          backup.completedAt = completedAt;
          delete backup.error;
        } else if (['queued', 'running'].includes(backup.status)) {
          backup.status = 'failed';
          backup.completedAt = completedAt;
          backup.error = 'Backup was active when this snapshot was captured.';
        }
      }
      const data = JSON.stringify(encryptValue(JSON.stringify(snapshot), vaultKey));
      await writeFile(destination, data, { mode: 0o600 });
      record.status = 'succeeded';
      record.completedAt = completedAt;
      record.sizeBytes = Buffer.byteLength(data);
      record.checksumSha256 = createHash('sha256').update(data).digest('hex');
      audit(context, 'backup.create', 'backup', id);
      const retention = Math.max(1, Number(process.env.FLEET_BACKUP_RETENTION_COUNT) || 14);
      const expired = store.state.v2.backups.filter((item) => item.kind === 'automatic').slice(retention);
      for (const item of expired) { await rm(item.destination, { force: true }); store.state.v2.backups = store.state.v2.backups.filter((candidate) => candidate.id !== item.id); }
      changed(context);
      return record;
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = timestamp();
      changed(context);
      throw error;
    }
  }
  app.get('/api/v2/backups', async () => store.state.v2.backups);
  app.post('/api/v2/backups', async (request, reply) => { const body = z.object({ kind: z.enum(['automatic', 'manual', 'pre-migration']).default('manual') }).parse(request.body ?? {}); return reply.code(201).send(await createBackup(body.kind)); });
  app.get('/api/v2/export', async () => ({ exportedAt: timestamp(), version: store.state.version, state: { ...store.state, private: undefined } }));
  app.post('/api/v2/backups/:id/restore', async (request) => {
    const { confirm } = z.object({ confirm: z.literal(true) }).parse(request.body);
    void confirm;
    const item = required(store.state.v2.backups, (request.params as { id: string }).id, 'Backup');
    if (item.status !== 'succeeded') throw httpError(409, 'Only a successfully completed backup can be restored.');
    let data: string;
    try { data = await readFile(item.destination, 'utf8'); } catch { throw httpError(410, 'Backup file is unavailable.'); }
    const checksum = createHash('sha256').update(data).digest('hex');
    if (!item.checksumSha256 || checksum !== item.checksumSha256) throw httpError(409, 'Backup checksum verification failed.');

    let restoredValue: unknown;
    try {
      const encoded = encryptedEnvelopeSchema.parse(JSON.parse(data) as unknown);
      restoredValue = JSON.parse(decryptValue(encoded, vaultKey)) as unknown;
    } catch {
      throw httpError(400, 'Backup could not be decrypted or does not contain valid JSON.');
    }

    let restored: ReturnType<typeof validatePersistedState>;
    try { restored = validatePersistedState(restoredValue, store.state.version); }
    catch (error) { throw httpError(400, error instanceof Error ? error.message : 'Backup document is invalid.'); }
    const auditVerification = verifyAudit(restored.v2.audit);
    if (!auditVerification.valid) throw httpError(409, `Backup audit chain is invalid at sequence ${auditVerification.invalidSequence ?? 'unknown'}.`);

    // Only after the candidate has passed integrity, decryption, shape, version,
    // and audit checks do we capture the current live state as a safety backup.
    const pre = await createBackup('pre-migration');
    const staged = structuredClone(restored);
    const sourceRecord = structuredClone(item);
    staged.v2.backups = staged.v2.backups.filter((backup) => backup.id !== pre.id && backup.id !== sourceRecord.id);
    staged.v2.backups.unshift(pre, sourceRecord);
    for (const backup of staged.v2.backups) {
      if (!['queued', 'running'].includes(backup.status)) continue;
      backup.status = 'failed';
      backup.completedAt = timestamp();
      backup.error = 'Backup was active when the restore image was staged.';
    }
    const restoreActor = context.currentAuditActor();
    appendAuditRecord(staged.v2.audit, {
      ...restoreActor, action: 'backup.restore', resourceType: 'backup', resourceId: item.id,
      outcome: 'success', detail: { preRestoreBackupId: pre.id, restartRequired: true },
    });
    await store.stageRestore(staged);

    appendAudit(store, {
      ...restoreActor, action: 'backup.restore.stage', resourceType: 'backup', resourceId: item.id,
      outcome: 'success', detail: { preRestoreBackupId: pre.id, restartRequired: true },
    });
    changed(context);
    return { restoreStaged: true, restartRequired: true, backupId: item.id, preRestoreBackupId: pre.id };
  });
  const configuredBackupHours = process.env.FLEET_BACKUP_INTERVAL_HOURS === undefined ? (context.loopback ? 0 : 24) : Number(process.env.FLEET_BACKUP_INTERVAL_HOURS); if (Number.isFinite(configuredBackupHours) && configuredBackupHours > 0) { const timer = setInterval(() => { void createBackup('automatic').catch(() => undefined); }, configuredBackupHours * 3_600_000); timer.unref(); pipelineTimers.add(timer); }

  app.get('/api/v2/storage-connections', async () => store.state.v2.storageConnections);
  function requireOnlineStorageDevice(item: StorageConnection): Device {
    if (!item.deviceId) throw httpError(409, 'This storage connection has no backing device.');
    const device = required(store.state.devices, item.deviceId, 'Storage backing device');
    if (!context.isOnline(device.id)) throw httpError(409, 'Storage backing device is offline: ' + device.name + '.');
    return device;
  }
  app.post('/api/v2/storage-connections', async (request, reply) => {
    const body = storageCreateSchema.parse(request.body);
    if (body.deviceId) required(store.state.devices, body.deviceId, 'Storage backing device');
    if (body.secretId) required(store.state.v2.secrets, body.secretId, 'Storage secret');
    const at = timestamp();
    const item: StorageConnection = { id: randomUUID(), ...body, status: 'unconfigured', createdAt: at, updatedAt: at };
    store.state.v2.storageConnections.push(item);
    audit(context, 'storage.create', 'storage-connection', item.id, { deviceId: item.deviceId });
    changed(context);
    return reply.code(201).send(item);
  });
  app.patch('/api/v2/storage-connections/:id', async (request) => {
    const item = required(store.state.v2.storageConnections, (request.params as { id: string }).id, 'Storage connection');
    const body = storagePatchSchema.parse(request.body);
    const candidate = structuredClone(item);
    applyStorageConnectionPatch(candidate, body);
    storageConfigurationSchema.parse({ kind: candidate.kind, deviceId: candidate.deviceId, rootPath: candidate.rootPath });
    if (candidate.deviceId) required(store.state.devices, candidate.deviceId, 'Storage backing device');
    if (candidate.secretId) required(store.state.v2.secrets, candidate.secretId, 'Storage secret');
    const backingChanged = storageBackingChanged(item, candidate);
    applyStorageConnectionPatch(item, body);
    if (backingChanged) {
      item.status = 'unconfigured';
      delete item.lastCheckedAt;
      delete item.capacityBytes;
      delete item.usedBytes;
    }
    item.updatedAt = timestamp();
    audit(context, 'storage.update', 'storage-connection', item.id, { deviceId: item.deviceId, kind: item.kind, backingChanged });
    changed(context);
    return item;
  });
  app.post('/api/v2/storage-connections/:id/test', async (request) => {
    const item = required(store.state.v2.storageConnections, (request.params as { id: string }).id, 'Storage connection');
    try {
      if (filesystemStorageKinds.has(item.kind)) {
        if (item.deviceId) {
          const device = requireOnlineStorageDevice(item);
          await testAgentStorage(item, device.id, context.dispatch);
          item.capacityBytes = undefined;
          item.usedBytes = undefined;
        } else {
          const usage = await testMountedStorage(item);
          item.capacityBytes = usage.capacityBytes;
          item.usedBytes = usage.usedBytes;
        }
        item.status = 'connected';
      } else {
        if (!item.endpoint) throw new Error('endpoint is required.');
        const response = await safeFetch(item.endpoint, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
        item.status = response.ok ? 'connected' : response.status < 500 ? 'degraded' : 'offline';
        if (response.status >= 500) throw new Error('Storage endpoint returned HTTP ' + response.status + '.');
      }
      item.lastCheckedAt = timestamp();
      evaluateEvent('nas', { identity: item.id, actual: 0, active: false, detail: item.name + ' is available.' });
    } catch (error) {
      item.status = 'offline';
      item.lastCheckedAt = timestamp();
      evaluateEvent('nas', { identity: item.id, actual: 1, detail: item.name + ' is unavailable: ' + (error instanceof Error ? error.message : String(error)) });
      changed(context);
      throw httpError((error as { statusCode?: number }).statusCode ?? 409, error instanceof Error ? error.message : String(error));
    }
    changed(context);
    return item;
  });
  app.get('/api/v2/storage-connections/:id/files', async (request) => {
    const item = required(store.state.v2.storageConnections, (request.params as { id: string }).id, 'Storage connection');
    const query = request.query as { path?: string; cursor?: string; limit?: string };
    const requestedPath = String(query.path ?? '');
    const cursor = Number.parseInt(query.cursor ?? '0', 10);
    const limit = Number.parseInt(query.limit ?? '200', 10);
    if (!item.deviceId) return browseMountedStorage(item, requestedPath, cursor, limit);
    const device = requireOnlineStorageDevice(item);
    return browseAgentStorage(item, device.id, context.dispatch, requestedPath, cursor, limit);
  });
  app.post('/api/v2/storage-connections/:id/files', async (request) => {
    const item = required(store.state.v2.storageConnections, (request.params as { id: string }).id, 'Storage connection');
    const body = z.object({ path: z.string().max(4_096).default(''), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(200) }).parse(request.body ?? {});
    if (!item.deviceId) return browseMountedStorage(item, body.path, body.cursor, body.limit);
    const device = requireOnlineStorageDevice(item);
    return browseAgentStorage(item, device.id, context.dispatch, body.path, body.cursor, body.limit);
  });
  app.post('/api/v2/storage-connections/:id/directories', async (request, reply) => {
    const item = required(store.state.v2.storageConnections, (request.params as { id: string }).id, 'Storage connection');
    if (item.readOnly) throw httpError(403, 'Storage connection is read-only.');
    if (!filesystemStorageKinds.has(item.kind)) throw httpError(409, 'Directory creation is available only for filesystem storage providers.');
    if (!item.rootPath) throw httpError(409, 'Storage connection has no rootPath.');
    const body = z.object({ path: z.string().max(4_096) }).parse(request.body);
    const requestedPath = normalizedStoragePath(body.path, { allowEmpty: false, allowLeadingSlash: false });
    if (item.deviceId) {
      const device = requireOnlineStorageDevice(item);
      await context.dispatch(device.id, { type: 'file.mkdir', payload: { path: agentStoragePath(item.rootPath, requestedPath), recursive: true } });
    } else {
      await createMountedStorageDirectory(item, requestedPath);
    }
    audit(context, 'storage.directory.create', 'storage-connection', item.id, { deviceId: item.deviceId, path: requestedPath });
    changed(context);
    return reply.code(201).send({ providerId: item.id, path: requestedPath, created: true });
  });
  app.delete('/api/v2/storage-connections/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.storageConnections, id, 'Storage connection'); store.state.v2.storageConnections = store.state.v2.storageConnections.filter((item) => item.id !== id); audit(context, 'storage.delete', 'storage-connection', id); changed(context); return reply.code(204).send(); });

  function validateArtifactReferences(input: { projectId?: string; jobId?: string; pipelineRunId?: string; parentArtifactIds?: string[] }, artifactId?: string): void {
    if (input.projectId) required(store.state.projects, input.projectId, 'Project');
    if (input.jobId) required(store.state.jobs, input.jobId, 'Job');
    if (input.pipelineRunId) required(store.state.v2.pipelineRuns, input.pipelineRunId, 'Pipeline run');
    for (const parentId of input.parentArtifactIds ?? []) {
      if (parentId === artifactId) throw httpError(400, 'An artifact cannot be its own parent.');
      required(store.state.v2.artifacts, parentId, 'Parent artifact');
    }
  }
  function normalizedArtifactLocations(input: z.infer<typeof artifactLocationSchema>[]): ArtifactLocation[] {
    return input.map((location) => {
      if (location.deviceId) required(store.state.devices, location.deviceId, 'Location device');
      if (location.providerId) required(store.state.v2.storageConnections, location.providerId, 'Location storage provider');
      return { ...location, id: location.id ?? randomUUID() };
    });
  }
  const artifactCreateSchema = z.object({ name: nameSchema, description: z.string().max(10_000).default(''), kind: artifactKindSchema.default('other'), projectId: idSchema.optional(), jobId: idSchema.optional(), pipelineRunId: idSchema.optional(), tags: z.array(z.string().trim().min(1).max(128)).max(256).default([]), classification: classificationSchema.default('internal'), parentArtifactIds: z.array(idSchema).max(256).default([]), retentionDays: z.number().int().positive().max(36_500).optional() }).strict();
  const artifactPatchSchema = z.object({ name: nameSchema.optional(), description: z.string().max(10_000).optional(), kind: artifactKindSchema.optional(), projectId: idSchema.nullable().optional(), jobId: idSchema.nullable().optional(), pipelineRunId: idSchema.nullable().optional(), tags: z.array(z.string().trim().min(1).max(128)).max(256).optional(), favorite: z.boolean().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), classification: classificationSchema.optional(), parentArtifactIds: z.array(idSchema).max(256).optional(), retentionDays: z.number().int().positive().max(36_500).nullable().optional() }).strict();
  app.get('/api/v2/artifacts', async () => store.state.v2.artifacts);
  app.post('/api/v2/artifacts', async (request, reply) => { const body = artifactCreateSchema.parse(request.body); validateArtifactReferences(body); const at = timestamp(); const item: FleetArtifact = { id: randomUUID(), ...body, favorite: false, pinned: false, archived: false, versions: [], createdAt: at, updatedAt: at }; store.state.v2.artifacts.unshift(item); audit(context, 'artifact.create', 'artifact', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/artifacts/:id', async (request) => { const item = required(store.state.v2.artifacts, (request.params as { id: string }).id, 'Artifact'); const body = artifactPatchSchema.parse(request.body); validateArtifactReferences({ projectId: body.projectId ?? undefined, jobId: body.jobId ?? undefined, pipelineRunId: body.pipelineRunId ?? undefined, parentArtifactIds: body.parentArtifactIds }, item.id); Object.assign(item, body, { updatedAt: timestamp() }); if (body.projectId === null) delete item.projectId; if (body.jobId === null) delete item.jobId; if (body.pipelineRunId === null) delete item.pipelineRunId; if (body.retentionDays === null) delete item.retentionDays; audit(context, 'artifact.update', 'artifact', item.id); changed(context); return item; });
  app.post('/api/v2/artifacts/:id/promote', async (request) => { const item = required(store.state.v2.artifacts, (request.params as { id: string }).id, 'Artifact'); const body = z.object({ environment: nameSchema, versionId: idSchema.optional(), confirm: z.literal(true) }).strict().parse(request.body); const version = body.versionId ? item.versions.find((candidate) => candidate.id === body.versionId) : item.versions.at(-1); if (!version) throw httpError(409, 'A registered artifact version is required before promotion.'); if (!/^[a-f0-9]{64}$/i.test(version.checksumSha256)) throw httpError(409, 'Artifact version does not have a valid SHA-256 checksum.'); item.promotedEnvironment = body.environment; item.promotedVersionId = version.id; item.promotedAt = timestamp(); item.updatedAt = item.promotedAt; audit(context, 'artifact.promote', 'artifact', item.id, { environment: body.environment, versionId: version.id, checksumSha256: version.checksumSha256 }); changed(context); return item; });
  app.delete('/api/v2/artifacts/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.artifacts, id, 'Artifact'); store.state.v2.artifacts = store.state.v2.artifacts.filter((item) => item.id !== id); audit(context, 'artifact.delete', 'artifact', id); changed(context); return reply.code(204).send(); });
  app.post('/api/v2/artifacts/:id/versions', async (request, reply) => { const item = required(store.state.v2.artifacts, (request.params as { id: string }).id, 'Artifact'); const body = z.object({ sizeBytes: z.number().int().safe().nonnegative(), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).transform((value) => value.toLowerCase()), mimeType: z.string().trim().min(1).max(256).optional(), locations: z.array(artifactLocationSchema).max(512).default([]), metadata: recordSchema.default({}) }).strict().parse(request.body); const version = { id: randomUUID(), version: (item.versions.at(-1)?.version ?? 0) + 1, ...body, createdBy: context.currentAuditActor().actorId, locations: normalizedArtifactLocations(body.locations), createdAt: timestamp() }; item.versions.push(version); item.updatedAt = timestamp(); audit(context, 'artifact.version.create', 'artifact', item.id, { version: version.version, checksumSha256: version.checksumSha256 }); changed(context); return reply.code(201).send(version); });

  const transferDirectory = join(dirname(store.filePath), 'transfers');
  async function withTransferLock<T>(transferId: string, operation: () => Promise<T>): Promise<T> {
    const previous = transferLocks.get(transferId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.catch(() => undefined).then(() => gate);
    transferLocks.set(transferId, queued);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally { release(); if (transferLocks.get(transferId) === queued) transferLocks.delete(transferId); }
  }
  app.get('/api/v2/transfers', async () => store.state.v2.transfers);
  app.post('/api/v2/transfers', async (request, reply) => { const body = z.object({ artifactId: idSchema.optional(), source: artifactLocationSchema, destination: artifactLocationSchema, totalBytes: z.number().int().safe().nonnegative(), chunkSizeBytes: z.number().int().safe().min(64 * 1024).max(1024 * 1024).default(1024 * 1024), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).transform((value) => value.toLowerCase()).optional(), compressed: z.boolean().default(false), encrypted: z.boolean().default(false), bandwidthLimitBytesPerSecond: z.number().positive().safe().optional(), priority: z.number().int().safe().default(0), maxAttempts: z.number().int().safe().min(1).max(20).default(3) }).strict().parse(request.body); if (body.artifactId) required(store.state.v2.artifacts, body.artifactId, 'Artifact'); if (body.compressed || body.encrypted || body.bandwidthLimitBytesPerSecond) throw httpError(501, 'Compressed, encrypted, and bandwidth-limited transfers require an Agent streaming protocol that is not enabled.'); const [source, destination] = normalizedArtifactLocations([body.source, body.destination]); const item: ArtifactTransfer = { id: randomUUID(), ...body, source: source!, destination: destination!, status: 'pending', transferredBytes: 0, attempts: 0, createdAt: timestamp() }; store.state.v2.transfers.unshift(item); audit(context, 'transfer.create', 'artifact-transfer', item.id); changed(context); return reply.code(201).send(item); });
  app.post('/api/v2/transfers/:id/chunks', async (request) => {
    const item = required(store.state.v2.transfers, (request.params as { id: string }).id, 'Transfer');
    const body = z.object({ offset: z.number().int().safe().nonnegative(), data: z.string().min(4).max(2 * 1024 * 1024) }).strict().parse(request.body);
    return withTransferLock(item.id, async () => {
      if (item.attempts > 0) throw httpError(409, 'This transfer is managed by the fleet transfer runner.');
      if (['succeeded', 'failed', 'cancelled'].includes(item.status)) throw httpError(409, `Transfer is already ${item.status}.`);
      if (body.offset !== item.transferredBytes) throw httpError(409, `Expected chunk offset ${item.transferredBytes}.`);
      const bytes = decodeCanonicalBase64(body.data);
      if (!bytes.length) throw httpError(400, 'Transfer chunks cannot be empty.');
      if (bytes.length > item.chunkSizeBytes || item.transferredBytes + bytes.length > item.totalBytes) throw httpError(413, 'Chunk exceeds transfer bounds.');
      await mkdir(transferDirectory, { recursive: true });
      const noFollow = typeof fileConstants.O_NOFOLLOW === 'number' ? fileConstants.O_NOFOLLOW : 0;
      const flags = body.offset === 0
        ? fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_TRUNC | noFollow
        : fileConstants.O_RDWR | noFollow;
      const file = await open(join(transferDirectory, `${item.id}.part`), flags, 0o600);
      try {
        const information = await file.stat();
        if (!information.isFile() || information.nlink !== 1) throw httpError(400, 'Transfer destination is not a private regular file.');
        await writeAll(file, bytes, body.offset);
        await file.sync();
      } finally { await file.close(); }
      item.transferredBytes += bytes.length; item.status = 'running'; item.startedAt ??= timestamp(); store.markDirty(); return item;
    });
  });
  app.post('/api/v2/transfers/:id/complete', async (request) => { const item = required(store.state.v2.transfers, (request.params as { id: string }).id, 'Transfer'); return withTransferLock(item.id, async () => { if (item.attempts > 0) throw httpError(409, 'This transfer is managed by the fleet transfer runner.'); if (item.status === 'succeeded') return item; if (item.transferredBytes !== item.totalBytes) throw httpError(409, 'Transfer is incomplete.'); await mkdir(transferDirectory, { recursive: true }); const source = join(transferDirectory, `${item.id}.part`); if (item.totalBytes === 0) { const noFollow = typeof fileConstants.O_NOFOLLOW === 'number' ? fileConstants.O_NOFOLLOW : 0; const empty = await open(source, fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_TRUNC | noFollow, 0o600); await empty.close(); } const information = await lstat(source); if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1 || information.size !== item.totalBytes) throw httpError(409, 'Transfer staging file does not match the declared size.'); const checksum = await localChecksum(source); if (item.checksumSha256 && checksum !== item.checksumSha256) { item.status = 'failed'; item.error = 'Checksum mismatch.'; changed(context); throw httpError(409, item.error); } const completed = join(transferDirectory, `${item.id}.data`); await rename(source, completed); item.status = 'succeeded'; item.checksumSha256 = checksum; item.completedAt = timestamp(); item.destination.path = completed; item.destination.status = 'available'; audit(context, 'transfer.complete', 'artifact-transfer', item.id, { checksum }); changed(context); return item; }); });
  app.post('/api/v2/transfers/:id/cancel', async (request) => { const item = required(store.state.v2.transfers, (request.params as { id: string }).id, 'Transfer'); return withTransferLock(item.id, async () => { item.status = 'cancelled'; item.completedAt = timestamp(); await rm(join(transferDirectory, `${item.id}.part`), { force: true }); audit(context, 'transfer.cancel', 'artifact-transfer', item.id); changed(context); return item; }); });

  async function transferLocalPath(location: ArtifactLocation, forWrite = false): Promise<string> {
    const provider = location.providerId ? required(store.state.v2.storageConnections, location.providerId, 'Storage connection') : undefined;
    if (provider?.deviceId) throw httpError(409, `${provider.name} is Agent-backed and cannot be resolved as a Core-local path.`);
    if (provider && !provider.rootPath) throw httpError(409, `${provider.kind.toUpperCase()} storage has no Core-mounted transfer root.`);
    if (forWrite && provider?.readOnly) throw httpError(403, `${provider.name} is read-only.`);
    const configuredRoot = provider?.rootPath ? resolve(provider.rootPath) : resolve(transferDirectory);
    if (!provider) await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const relativePath = normalizedStoragePath(location.path, { allowEmpty: false, allowLeadingSlash: true });
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw httpError(400, 'Transfer path escapes its storage root.');
    if (!forWrite) { const actual = await realpath(target); if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw httpError(403, 'Transfer source resolves outside its storage root.'); return actual; }
    const components = relativePath.split('/');
    const leaf = components.pop()!;
    const actualParent = await ensureMountedStorageDirectory(configuredRoot, components.join('/'));
    const destination = join(actualParent, leaf);
    try {
      const information = await lstat(destination);
      if (information.isSymbolicLink()) throw httpError(403, 'Transfer destination cannot be a symbolic link.');
      if (!information.isFile()) throw httpError(409, 'Transfer destination exists and is not a regular file.');
      if (information.nlink !== 1) throw httpError(403, 'Transfer destination cannot be a multiply-linked file.');
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return destination;
  }

  function resolveTransferLocation(location: ArtifactLocation, forWrite = false): ArtifactLocation {
    if (!location.providerId) return location;
    const provider = required(store.state.v2.storageConnections, location.providerId, 'Storage connection');
    if (forWrite && provider.readOnly) throw httpError(403, `${provider.name} is read-only.`);
    if (!provider.deviceId) return location;
    if (!filesystemStorageKinds.has(provider.kind)) throw httpError(409, `${provider.name} is not a filesystem storage provider.`);
    if (!provider.rootPath) throw httpError(409, `${provider.name} has no backing-device rootPath.`);
    const relativePath = normalizedStoragePath(location.path, { allowEmpty: false, allowLeadingSlash: true });
    return { ...location, deviceId: provider.deviceId, path: agentStoragePath(provider.rootPath, relativePath) };
  }

  async function assertOpenDestinationConfined(location: ArtifactLocation, filePath: string, handle: FileHandle): Promise<void> {
    const provider = location.providerId ? required(store.state.v2.storageConnections, location.providerId, 'Storage connection') : undefined;
    const configuredRoot = provider?.rootPath ? resolve(provider.rootPath) : resolve(transferDirectory);
    const root = await realpath(configuredRoot);
    const actual = await realpath(filePath);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw httpError(403, 'Opened transfer destination escaped its storage root.');
    const [openedInformation, currentInformation] = await Promise.all([handle.stat(), stat(actual)]);
    if (!openedInformation.isFile() || openedInformation.nlink !== 1) throw httpError(400, 'Transfer destination must be a private regular file.');
    if (openedInformation.dev !== currentInformation.dev || openedInformation.ino !== currentInformation.ino) throw httpError(409, 'Transfer destination changed while it was being opened.');
  }

  async function localChecksum(filePath: string): Promise<string> {
    const noFollow = typeof fileConstants.O_NOFOLLOW === 'number' ? fileConstants.O_NOFOLLOW : 0;
    const handle = await open(filePath, fileConstants.O_RDONLY | noFollow); const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
    try { if (!(await handle.stat()).isFile()) throw httpError(400, 'Checksum target is not a regular file.'); while (true) { const result = await handle.read(buffer, 0, buffer.length, offset); if (!result.bytesRead) break; hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead; } } finally { await handle.close(); }
    return hash.digest('hex');
  }

  async function runTransfer(item: ArtifactTransfer): Promise<void> {
    if (item.status === 'running' || item.status === 'succeeded') return;
    item.status = 'running'; item.startedAt ??= timestamp(); item.attempts += 1; changed(context);
    try {
      const sourceLocation = resolveTransferLocation(item.source);
      const destinationLocation = resolveTransferLocation(item.destination, true);
      const sourcePath = sourceLocation.deviceId ? sourceLocation.path : await transferLocalPath(sourceLocation);
      let destinationPath = destinationLocation.deviceId ? destinationLocation.path : await transferLocalPath(destinationLocation, true);
      if (!sourceLocation.deviceId && !destinationLocation.deviceId && sourcePath === destinationPath) throw httpError(409, 'Transfer source and destination resolve to the same file.');
      if (sourceLocation.deviceId && sourceLocation.deviceId === destinationLocation.deviceId) { const platform = store.state.devices.find((device) => device.id === sourceLocation.deviceId)?.platform; const normalizeRemote = (value: string) => { const normalized = value.replace(/\\/g, '/').replace(/\/+$/, ''); return platform === 'win32' ? normalized.toLowerCase() : normalized; }; if (normalizeRemote(sourcePath) === normalizeRemote(destinationPath)) throw httpError(409, 'Transfer source and destination are the same remote file.'); }
      if (sourceLocation.deviceId) {
        const sourceStat = await context.dispatch(sourceLocation.deviceId, { type: 'file.stat', payload: { path: sourcePath } }) as { sizeBytes: number; type?: string };
        if (sourceStat.type !== 'file') throw httpError(400, 'Transfer source is not a regular file.');
        item.totalBytes = sourceStat.sizeBytes;
      } else {
        const sourceStat = await stat(sourcePath);
        if (!sourceStat.isFile()) throw httpError(400, 'Transfer source is not a regular file.');
        item.totalBytes = sourceStat.size;
      }
      if (!Number.isSafeInteger(item.totalBytes) || item.totalBytes < 0) throw new Error('Transfer source reported an invalid size.');
      if (item.transferredBytes > item.totalBytes) item.transferredBytes = 0;
      if (!destinationLocation.deviceId) destinationPath = await transferLocalPath(destinationLocation, true);
      const noFollow = typeof fileConstants.O_NOFOLLOW === 'number' ? fileConstants.O_NOFOLLOW : 0;
      const destinationFlags = item.transferredBytes
        ? fileConstants.O_RDWR | noFollow
        : fileConstants.O_RDWR | fileConstants.O_CREAT | noFollow;
      let sourceHandle: FileHandle | undefined;
      let destinationHandle: FileHandle | undefined;
      try {
        sourceHandle = sourceLocation.deviceId ? undefined : await open(sourcePath, fileConstants.O_RDONLY | noFollow);
        destinationHandle = destinationLocation.deviceId ? undefined : await open(destinationPath, destinationFlags, 0o600);
        if (sourceHandle && !(await sourceHandle.stat()).isFile()) throw httpError(400, 'Transfer source is not a regular file.');
        if (destinationHandle) {
          await assertOpenDestinationConfined(destinationLocation, destinationPath, destinationHandle);
          if (!item.transferredBytes) await destinationHandle.truncate(0);
        }
        while (item.transferredBytes < item.totalBytes) {
          if ((item.status as string) === 'cancelled') return;
          const length = Math.min(item.chunkSizeBytes, item.totalBytes - item.transferredBytes); let dataBase64: string;
          if (sourceLocation.deviceId) { const response = await context.dispatch(sourceLocation.deviceId, { type: 'file.read', payload: { path: sourcePath, offset: item.transferredBytes, length } }) as { dataBase64: string; bytesRead: number }; if (!Number.isSafeInteger(response.bytesRead) || response.bytesRead < 1 || response.bytesRead > length) throw new Error('Source returned an invalid chunk length.'); dataBase64 = response.dataBase64; const decoded = decodeCanonicalBase64(dataBase64); if (decoded.length !== response.bytesRead) throw new Error('Source chunk length does not match its encoded payload.'); }
          else { const buffer = Buffer.alloc(length); const result = await sourceHandle!.read(buffer, 0, length, item.transferredBytes); if (!result.bytesRead) throw new Error('Local source reached EOF early.'); dataBase64 = buffer.subarray(0, result.bytesRead).toString('base64'); }
          const chunk = decodeCanonicalBase64(dataBase64);
          if (!chunk.length || chunk.length > length || item.transferredBytes + chunk.length > item.totalBytes) throw new Error('Source returned a chunk outside transfer bounds.');
          if (destinationLocation.deviceId) { const response = await context.dispatch(destinationLocation.deviceId, { type: 'file.write', payload: { path: destinationPath, offset: item.transferredBytes, dataBase64, truncate: item.transferredBytes === 0 } }) as { bytesWritten?: number }; if (response.bytesWritten !== chunk.length) throw new Error('Destination did not confirm the complete chunk write.'); }
          else await writeAll(destinationHandle!, chunk, item.transferredBytes);
          item.transferredBytes += chunk.length; store.markDirty(); context.broadcast({ type: 'transfer.updated', payload: item });
        }
        await destinationHandle?.sync();
      } finally { await sourceHandle?.close(); await destinationHandle?.close(); }
      const sourceChecksum = sourceLocation.deviceId ? (await context.dispatch(sourceLocation.deviceId, { type: 'file.checksum', payload: { path: sourcePath, algorithm: 'sha256' } }) as { checksum: string }).checksum : await localChecksum(sourcePath);
      const destinationChecksum = destinationLocation.deviceId ? (await context.dispatch(destinationLocation.deviceId, { type: 'file.checksum', payload: { path: destinationPath, algorithm: 'sha256' } }) as { checksum: string }).checksum : await localChecksum(destinationPath);
      if ((item.checksumSha256 && item.checksumSha256 !== sourceChecksum) || sourceChecksum !== destinationChecksum) throw new Error('Transfer checksum verification failed.');
      item.checksumSha256 = sourceChecksum; item.status = 'succeeded'; item.completedAt = timestamp(); item.destination.status = 'available'; audit(context, 'transfer.complete', 'artifact-transfer', item.id, { checksum: sourceChecksum }); void emitFleetEvent('transfer.completed', item); changed(context);
    } catch (error) { item.error = error instanceof Error ? error.message : String(error); if (item.attempts < item.maxAttempts && (item.status as string) !== 'cancelled') { item.status = 'pending'; store.markDirty(); const timer = setTimeout(() => { pipelineTimers.delete(timer); void runTransfer(item); }, Math.min(30_000, item.attempts * 2_000)); timer.unref(); pipelineTimers.add(timer); } else { item.status = 'failed'; item.completedAt = timestamp(); changed(context); } }
  }

  async function waitForTransfer(item: ArtifactTransfer, timeoutSeconds: number): Promise<void> { const deadline = Date.now() + timeoutSeconds * 1_000; while (Date.now() < deadline) { if (item.status === 'succeeded') return; if (['failed', 'cancelled'].includes(item.status)) throw new Error(item.error ?? `Transfer ${item.status}.`); await new Promise<void>((done) => { const timer = setTimeout(() => { pipelineTimers.delete(timer); done(); }, 500); timer.unref(); pipelineTimers.add(timer); }); } throw new Error('Transfer timed out.'); }
  app.post('/api/v2/transfers/:id/start', async (request, reply) => { const item = required(store.state.v2.transfers, (request.params as { id: string }).id, 'Transfer'); if (item.status === 'succeeded') return item; if (item.transferredBytes > 0 && item.attempts === 0) throw httpError(409, 'A manually uploaded transfer cannot be started by the fleet transfer runner.'); const source = resolveTransferLocation(item.source); const destination = resolveTransferLocation(item.destination, true); if (source.deviceId && !context.isOnline(source.deviceId)) throw httpError(409, 'Source device is offline.'); if (destination.deviceId && !context.isOnline(destination.deviceId)) throw httpError(409, 'Destination device is offline.'); void runTransfer(item); return reply.code(202).send(item); });

  function validatePipeline(pipeline: Pick<PipelineDefinition, 'nodes' | 'edges'>): { valid: boolean; errors: string[]; order: string[] } {
    const errors: string[] = [], ids = new Set<string>();
    for (const node of pipeline.nodes) { if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`); ids.add(node.id); }
    const indegree = new Map([...ids].map((id) => [id, 0])); const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
    for (const edge of pipeline.edges) { if (!ids.has(edge.source) || !ids.has(edge.target)) { errors.push(`Edge ${edge.id} references an unknown node.`); continue; } if (edge.condition === 'expression') { try { parsePipelineExpression(edge.expression ?? ''); } catch (error) { errors.push(`Edge ${edge.id}: ${error instanceof Error ? error.message : String(error)}`); } } outgoing.get(edge.source)!.push(edge.target); indegree.set(edge.target, indegree.get(edge.target)! + 1); }
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id), order: string[] = [];
    while (queue.length) { const id = queue.shift()!; order.push(id); for (const target of outgoing.get(id)!) { indegree.set(target, indegree.get(target)! - 1); if (indegree.get(target) === 0) queue.push(target); } }
    if (order.length !== ids.size) errors.push('Pipeline graph contains a cycle.'); return { valid: !errors.length, errors, order };
  }

  function resolvePipelineParameters(pipeline: PipelineDefinition, supplied: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(pipeline.parameters)) {
      const value = supplied[name] ?? definition.default;
      if (definition.required && (value === undefined || value === null || value === '')) throw httpError(400, `Pipeline parameter ${name} is required.`);
      if (value === undefined) continue;
      if (definition.type === 'number' && typeof value !== 'number') throw httpError(400, `Pipeline parameter ${name} must be a number.`);
      if (definition.type === 'boolean' && typeof value !== 'boolean') throw httpError(400, `Pipeline parameter ${name} must be a boolean.`);
      if ((definition.type === 'string' || definition.type === 'secret') && typeof value !== 'string') throw httpError(400, `Pipeline parameter ${name} must be a string.`);
      if (definition.type === 'secret' && !store.state.v2.secrets.some((secret) => secret.id === value || secret.name === value)) throw httpError(400, `Pipeline secret parameter ${name} does not reference a managed secret.`);
      resolved[name] = value;
    }
    for (const [name, value] of Object.entries(supplied)) if (!(name in pipeline.parameters)) resolved[name] = value;
    return resolved;
  }

  function renderPipelineConfig(value: unknown, parameters: Record<string, unknown>, depth = 0): unknown {
    if (depth > 12) throw new Error('Pipeline configuration nesting exceeds the supported depth.');
    if (Array.isArray(value)) return value.map((entry) => renderPipelineConfig(entry, parameters, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, renderPipelineConfig(entry, parameters, depth + 1)]));
    if (typeof value !== 'string') return value;
    if (/\$\{\{\s*secrets\./.test(value)) throw new Error('Managed secrets may only be injected through a pipeline node environment map.');
    const exact = value.match(/^\$\{\{\s*(parameters)\.([A-Za-z0-9_.-]+)\s*\}\}$/);
    const lookup = (_kind: string, name: string): unknown => parameters[name];
    if (exact) return lookup(exact[1]!, exact[2]!);
    return value.replace(/\$\{\{\s*(parameters)\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, kind: string, name: string) => String(lookup(kind, name) ?? ''));
  }

  function resolvePipelineEnvironment(input: unknown, parameters: Record<string, unknown>): Record<string, string> {
    if (input === undefined) return {};
    const source = recordSchema.parse(input), environment: Record<string, string> = {};
    for (const [name, raw] of Object.entries(source)) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof raw !== 'string') throw new Error(`Pipeline environment variable ${name} is invalid.`); const secret = raw.match(/^\$\{\{\s*secrets\.([A-Za-z0-9_.-]+)\s*\}\}$/); if (secret) { const metadata = store.state.v2.secrets.find((item) => item.id === secret[1] || item.name === secret[1]); const encrypted = metadata ? store.state.private.encryptedSecrets[metadata.id] : undefined; if (!encrypted) throw new Error(`Managed secret ${secret[1]} is unavailable.`); environment[name] = decryptValue(encrypted, vaultKey); } else environment[name] = String(renderPipelineConfig(raw, parameters)); }
    return environment;
  }

  app.get('/api/v2/pipelines', async () => store.state.v2.pipelines);
  app.post('/api/v2/pipelines', async (request, reply) => { const body = request.body as Partial<PipelineDefinition>; if (!body?.name || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) throw httpError(400, 'name, nodes, and edges are required.'); const validation = validatePipeline({ nodes: body.nodes, edges: body.edges }); if (!validation.valid) throw httpError(400, validation.errors.join(' ')); const at = timestamp(); const item: PipelineDefinition = { id: randomUUID(), name: body.name, description: body.description ?? '', projectId: body.projectId, version: 1, status: body.status ?? 'draft', nodes: body.nodes, edges: body.edges, triggers: body.triggers ?? [], parameters: body.parameters ?? {}, concurrencyLimit: body.concurrencyLimit ?? 1, tags: body.tags ?? [], createdAt: at, updatedAt: at, createdBy: context.currentAuditActor().actorId }; store.state.v2.pipelines.push(item); schedulePipelineTriggers(item); audit(context, 'pipeline.create', 'pipeline', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/pipelines/:id', async (request) => { const item = required(store.state.v2.pipelines, (request.params as { id: string }).id, 'Pipeline'); if (store.state.v2.pipelineRuns.some((run) => run.pipelineId === item.id && ['queued', 'running', 'awaiting-approval'].includes(run.state))) throw httpError(409, 'Pipeline definitions cannot change while a run is active.'); const body = cleanPatch(recordSchema.parse(request.body)); const nodes = (body.nodes as PipelineNodeDefinition[] | undefined) ?? item.nodes, edges = (body.edges as PipelineDefinition['edges'] | undefined) ?? item.edges; const validation = validatePipeline({ nodes, edges }); if (!validation.valid) throw httpError(400, validation.errors.join(' ')); Object.assign(item, body, { version: item.version + 1, updatedAt: timestamp() }); schedulePipelineTriggers(item); audit(context, 'pipeline.update', 'pipeline', item.id); changed(context); return item; });
  app.delete('/api/v2/pipelines/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.pipelines, id, 'Pipeline'); if (store.state.v2.pipelineRuns.some((run) => run.pipelineId === id && ['running', 'awaiting-approval'].includes(run.state))) throw httpError(409, 'Pipeline has an active run.'); clearPipelineTriggers(id); store.state.v2.pipelines = store.state.v2.pipelines.filter((item) => item.id !== id); audit(context, 'pipeline.delete', 'pipeline', id); changed(context); return reply.code(204).send(); });
  app.post('/api/v2/pipelines/:id/validate', async (request) => { const item = required(store.state.v2.pipelines, (request.params as { id: string }).id, 'Pipeline'); return validatePipeline(item); });
  app.get('/api/v2/pipeline-runs', async () => store.state.v2.pipelineRuns);

  async function waitForJob(job: FleetJob, timeoutSeconds: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) { if (job.status === 'completed') return { jobId: job.id, exitCode: job.exitCode }; if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error ?? `Job ${job.status}.`); await new Promise<void>((resolvePromise) => { const timer = setTimeout(() => { pipelineTimers.delete(timer); resolvePromise(); }, 500); timer.unref(); pipelineTimers.add(timer); }); }
    try { await context.cancelJob(job.id); } catch { /* The timeout remains the primary failure. */ }
    throw new Error('Pipeline node timed out and its remote job was cancelled.');
  }

  async function executeNode(run: PipelineRun, pipeline: PipelineDefinition, nodeRun: PipelineNodeRun): Promise<void> {
    const node = required(pipeline.nodes, nodeRun.nodeId, 'Pipeline node');
    const { environment: environmentInput, ...persistableConfig } = node.config; const config = renderPipelineConfig(persistableConfig, run.parameters) as Record<string, unknown>; const environment = resolvePipelineEnvironment(environmentInput, run.parameters);
    const dedicatedApproval = node.type === 'approval' || node.type === 'human-input';
    if (dedicatedApproval || (node.approvalRequired && nodeRun.output.__approvalGranted !== true)) { nodeRun.state = 'awaiting-approval'; changed(context); return; }
    nodeRun.state = 'running'; nodeRun.attempt += 1; nodeRun.startedAt ??= timestamp(); changed(context);
    try {
      if (node.type === 'wait') { const milliseconds = Math.min(86_400_000, Math.max(0, Number(config.milliseconds ?? Number(config.seconds ?? 1) * 1_000))); await new Promise<void>((resolvePromise) => { const timer = setTimeout(() => { pipelineTimers.delete(timer); resolvePromise(); }, milliseconds); timer.unref(); pipelineTimers.add(timer); }); nodeRun.output = { waitedMilliseconds: milliseconds }; }
      else if (node.type === 'http' || node.type === 'webhook') { const response = await safeFetch(String(config.url ?? ''), { method: String(config.method ?? 'GET'), headers: config.headers as Record<string, string> | undefined, body: config.body === undefined ? undefined : String(config.body), signal: AbortSignal.timeout((node.timeoutSeconds ?? 60) * 1_000) }); const text = (await response.text()).slice(0, 65_536); if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`); nodeRun.output = { status: response.status, body: text }; }
      else if (node.type === 'notification') { const notification = await notify((config.severity as FleetNotification['severity']) ?? 'info', String(config.title ?? node.name), String(config.body ?? ''), config.channelIds as string[] | undefined); nodeRun.output = { notificationIds: notification.map((item) => item.id) }; }
      else if (node.type === 'transfer') { const transfer = config.transferId ? required(store.state.v2.transfers, String(config.transferId), 'Transfer') : undefined; if (!transfer) throw new Error('Transfer node requires transferId.'); const transferDevices = artifactTransferDeviceIds(transfer, store.state.v2.storageConnections); for (const deviceId of transferDevices) enforceInternalPolicy('artifacts.transfer', `pipeline:${run.id}`, { resourceType: 'artifact-transfer', resourceId: transfer.id, projectId: pipeline.projectId, deviceId }); if (!transferDevices.length) enforceInternalPolicy('artifacts.transfer', `pipeline:${run.id}`, { resourceType: 'artifact-transfer', resourceId: transfer.id, projectId: pipeline.projectId }); void runTransfer(transfer); await waitForTransfer(transfer, node.timeoutSeconds ?? 3_600); nodeRun.output = { transferId: transfer.id, status: transfer.status, checksumSha256: transfer.checksumSha256 }; }
      else if (node.type === 'wake' || node.type === 'shutdown') { const deviceId = node.preferredDeviceIds.find(context.isOnline) ?? String(config.deviceId ?? ''); if (!deviceId) throw new Error('Power node has no target device.'); const action = node.type === 'wake' ? 'wake' : 'shutdown'; const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId); const targetId = action === 'wake' ? profile?.wakeRelayDeviceId : deviceId; if (!targetId || !context.isOnline(targetId)) throw new Error('Power target or relay is offline.'); enforceInternalPolicy('devices.power', `pipeline:${run.id}`, { resourceType: 'device', resourceId: deviceId, projectId: pipeline.projectId, deviceId }); const result = await context.dispatch(targetId, { type: 'device.power', payload: { action, macAddress: action === 'wake' ? profile?.wakeMacAddress : undefined, broadcastAddress: action === 'wake' ? profile?.wakeBroadcastAddress : undefined } }); nodeRun.deviceId = targetId; nodeRun.output = { result }; }
      else {
        const codex = node.type === 'codex'; const command = String(config.command ?? config.script ?? ''); const prompt = String(config.prompt ?? command); if (!prompt) throw new Error(`Node ${node.name} has no executable prompt or command.`);
        const job = await context.createJob({ name: `${pipeline.name}: ${node.name}`, kind: codex ? 'codex' : 'shell', prompt, command: codex ? undefined : command || prompt, projectId: pipeline.projectId, deviceId: node.preferredDeviceIds.find(context.isOnline), permissionMode: (config.permissionMode as FleetJob['permissionMode']) ?? 'workspace-write', approvalPolicy: (config.approvalPolicy as FleetJob['approvalPolicy']) ?? 'on-request', requiredLabels: node.requiredLabels, environment }); nodeRun.jobId = job.id; nodeRun.deviceId = job.deviceId; nodeRun.output = await waitForJob(job, node.timeoutSeconds ?? 3_600);
      }
      if (run.state === 'cancelled') { nodeRun.state = 'cancelled'; nodeRun.completedAt = timestamp(); return; } nodeRun.state = 'succeeded'; nodeRun.completedAt = timestamp();
    } catch (error) { if ((run.state as string) === 'cancelled' || (nodeRun.state as string) === 'cancelled') { nodeRun.state = 'cancelled'; nodeRun.completedAt ??= timestamp(); return; } if (nodeRun.attempt <= node.retries) { nodeRun.state = 'queued'; nodeRun.error = error instanceof Error ? error.message : String(error); changed(context); const delay = Math.min(86_400_000, Math.max(0, node.retryDelaySeconds * 1_000)); await new Promise<void>((done) => { const timer = setTimeout(() => { pipelineTimers.delete(timer); done(); }, delay); timer.unref(); pipelineTimers.add(timer); }); if ((run.state as string) === 'cancelled' || (nodeRun.state as string) === 'cancelled') { nodeRun.state = 'cancelled'; nodeRun.completedAt ??= timestamp(); return; } nodeRun.state = 'pending'; return; } nodeRun.state = 'failed'; nodeRun.error = error instanceof Error ? error.message : String(error); nodeRun.completedAt = timestamp(); }
    changed(context);
  }

  async function advanceRun(run: PipelineRun): Promise<void> {
    if (pipelineRunLocks.has(run.id)) return; pipelineRunLocks.add(run.id);
    try {
      const pipeline = required(store.state.v2.pipelines, run.pipelineId, 'Pipeline'); if (run.state === 'cancelled') return; run.state = 'running'; run.startedAt ??= timestamp();
      while (run.state === 'running') {
        let advanced = false; const ready: PipelineNodeRun[] = [];
        for (const nodeRun of run.nodeRuns.filter((item) => item.state === 'pending')) { const incoming = pipeline.edges.filter((edge) => edge.target === nodeRun.nodeId); const parents = incoming.map((edge) => run.nodeRuns.find((item) => item.nodeId === edge.source)!); if (parents.some((parent) => !finalStates.has(parent.state))) continue; const allowed = !incoming.length || incoming.some((edge) => edgeAllowsRun(edge, run.nodeRuns.find((parent) => parent.nodeId === edge.source)!, run)); if (!allowed) { nodeRun.state = 'skipped'; nodeRun.completedAt = timestamp(); advanced = true; } else ready.push(nodeRun); }
        const limit = Math.max(1, pipeline.concurrencyLimit || 1); for (let offset = 0; offset < ready.length; offset += limit) { const batch = ready.slice(offset, offset + limit); await Promise.all(batch.map((nodeRun) => executeNode(run, pipeline, nodeRun))); advanced = true; if ((run.state as string) === 'cancelled') return; const failure = batch.find((nodeRun) => { if (nodeRun.state !== 'failed' || required(pipeline.nodes, nodeRun.nodeId, 'Node').continueOnFailure) return false; return !pipeline.edges.some((edge) => edge.source === nodeRun.nodeId && (edge.condition === 'failure' || edge.condition === 'always' || (edge.condition === 'expression' && edgeAllowsRun(edge, nodeRun, run)))); }); if (failure) { run.state = 'failed'; run.error = failure.error; run.completedAt = timestamp(); void emitFleetEvent('pipeline.failed', run); changed(context); return; } }
        if (run.nodeRuns.some((item) => item.state === 'awaiting-approval')) { run.state = 'awaiting-approval'; changed(context); return; }
        if (run.nodeRuns.every((item) => finalStates.has(item.state))) { run.state = run.nodeRuns.some((item) => item.state === 'failed') ? 'failed' : 'succeeded'; run.completedAt = timestamp(); void emitFleetEvent(run.state === 'succeeded' ? 'pipeline.completed' : 'pipeline.failed', run); changed(context); return; }
        if (!advanced) { run.state = 'failed'; run.error = 'Pipeline is deadlocked.'; run.completedAt = timestamp(); void emitFleetEvent('pipeline.failed', run); changed(context); return; }
      }
    } finally { pipelineRunLocks.delete(run.id); }
  }

  function createPipelineRun(pipeline: PipelineDefinition, supplied: Record<string, unknown>, triggerType: PipelineRun['triggerType']): PipelineRun { const validation = validatePipeline(pipeline); if (!validation.valid) throw httpError(400, validation.errors.join(' ')); if (triggerType !== 'manual') enforceInternalPolicy('pipelines.execute', `trigger:${triggerType}`, { resourceType: 'pipeline', resourceId: pipeline.id, projectId: pipeline.projectId }); const parameters = resolvePipelineParameters(pipeline, supplied); const run: PipelineRun = { id: randomUUID(), pipelineId: pipeline.id, pipelineVersion: pipeline.version, state: 'queued', triggerType, parameters, nodeRuns: pipeline.nodes.map((node) => ({ id: randomUUID(), nodeId: node.id, state: 'pending', attempt: 0, input: Object.fromEntries(Object.entries(parameters).filter(([name]) => pipeline.parameters[name]?.type !== 'secret')), output: {} })), createdAt: timestamp(), createdBy: triggerType === 'manual' ? context.currentAuditActor().actorId : `trigger:${triggerType}` }; store.state.v2.pipelineRuns.unshift(run); audit(context, 'pipeline.run', 'pipeline', pipeline.id, { runId: run.id, triggerType }); void emitFleetEvent('pipeline.started', run); changed(context); void advanceRun(run); return run; }
  const triggerTimers = new Map<string, Set<NodeJS.Timeout>>();
  function clearPipelineTriggers(pipelineId: string): void { for (const timer of triggerTimers.get(pipelineId) ?? []) { clearInterval(timer); pipelineTimers.delete(timer); } triggerTimers.delete(pipelineId); }
  function schedulePipelineTriggers(pipeline: PipelineDefinition): void { clearPipelineTriggers(pipeline.id); if (pipeline.status !== 'active') return; const timers = new Set<NodeJS.Timeout>(); for (const trigger of pipeline.triggers.filter((item) => item.enabled && item.type === 'schedule')) { const seconds = Number(trigger.config.intervalSeconds ?? 0); if (!Number.isFinite(seconds) || seconds < 60) continue; const timer = setInterval(() => { if (!store.state.v2.pipelineRuns.some((run) => run.pipelineId === pipeline.id && ['queued', 'running', 'awaiting-approval'].includes(run.state))) { try { createPipelineRun(pipeline, (trigger.config.parameters as Record<string, unknown> | undefined) ?? {}, 'schedule'); } catch { /* Invalid scheduled inputs remain visible through pipeline validation. */ } } }, seconds * 1_000); timer.unref(); timers.add(timer); pipelineTimers.add(timer); } if (timers.size) triggerTimers.set(pipeline.id, timers); }
  app.post('/api/v2/pipelines/:id/run', async (request, reply) => { const pipeline = required(store.state.v2.pipelines, (request.params as { id: string }).id, 'Pipeline'); const supplied = z.object({ parameters: recordSchema.default({}) }).parse(request.body ?? {}).parameters; return reply.code(202).send(createPipelineRun(pipeline, supplied, 'manual')); });
  app.post('/api/v2/pipelines/:id/triggers/:triggerId/fire', async (request, reply) => { const pipeline = required(store.state.v2.pipelines, (request.params as { id: string }).id, 'Pipeline'); const trigger = required(pipeline.triggers, (request.params as { triggerId: string }).triggerId, 'Pipeline trigger'); if (!trigger.enabled || pipeline.status !== 'active') throw httpError(409, 'Pipeline trigger is not active.'); const supplied = z.object({ parameters: recordSchema.default({}) }).parse(request.body ?? {}).parameters; return reply.code(202).send(createPipelineRun(pipeline, supplied, trigger.type)); });
  app.post('/api/v2/pipeline-runs/:id/approve', async (request) => { const run = required(store.state.v2.pipelineRuns, (request.params as { id: string }).id, 'Pipeline run'); const body = z.object({ nodeId: idSchema.optional(), nodeRunId: idSchema.optional(), approved: z.boolean(), input: recordSchema.optional() }).refine((value) => value.nodeId || value.nodeRunId, 'nodeId or nodeRunId is required.').parse(request.body); const nodeRun = run.nodeRuns.find((item) => (body.nodeRunId ? item.id === body.nodeRunId : item.nodeId === body.nodeId) && item.state === 'awaiting-approval'); if (!nodeRun) throw httpError(404, 'Pending approval not found.'); const pipeline = required(store.state.v2.pipelines, run.pipelineId, 'Pipeline'); const definition = required(pipeline.nodes, nodeRun.nodeId, 'Pipeline node'); const dedicatedApproval = definition.type === 'approval' || definition.type === 'human-input'; nodeRun.output = { approved: body.approved, ...body.input, ...(body.approved && !dedicatedApproval ? { __approvalGranted: true } : {}) }; nodeRun.state = body.approved && !dedicatedApproval ? 'pending' : body.approved ? 'succeeded' : 'failed'; if (nodeRun.state !== 'pending') nodeRun.completedAt = timestamp(); run.state = 'running'; audit(context, 'pipeline.approval', 'pipeline-run', run.id, { nodeId: nodeRun.nodeId, nodeRunId: nodeRun.id, approved: body.approved, resumesAction: body.approved && !dedicatedApproval }); changed(context); void advanceRun(run); return run; });
  app.post('/api/v2/pipeline-runs/:id/cancel', async (request) => { const run = required(store.state.v2.pipelineRuns, (request.params as { id: string }).id, 'Pipeline run'); run.state = 'cancelled'; run.completedAt = timestamp(); const active = run.nodeRuns.filter((item) => ['pending', 'queued', 'running', 'awaiting-approval'].includes(item.state)); for (const node of active) { node.state = 'cancelled'; node.completedAt = timestamp(); } await Promise.allSettled(active.filter((node) => node.jobId).map((node) => context.cancelJob(node.jobId!))); audit(context, 'pipeline.cancel', 'pipeline-run', run.id, { cancelledJobs: active.filter((node) => node.jobId).length }); void emitFleetEvent('pipeline.cancelled', run); changed(context); return run; });
  app.post('/api/v2/pipeline-runs/:id/retry', async (request) => { const run = required(store.state.v2.pipelineRuns, (request.params as { id: string }).id, 'Pipeline run'); for (const node of run.nodeRuns.filter((item) => ['failed', 'cancelled'].includes(item.state))) { node.state = 'pending'; node.error = undefined; node.completedAt = undefined; } run.state = 'queued'; run.error = undefined; run.completedAt = undefined; audit(context, 'pipeline.retry', 'pipeline-run', run.id); changed(context); void advanceRun(run); return run; });

  function schedule(policy: SchedulingPolicy | undefined, input: { requiredLabels: string[]; preferredDeviceIds?: string[]; projectId?: string; jobId?: string }): SchedulingDecision {
    const weights = policy?.weights ?? { cpu: 1, memory: 1, gpu: 1, queue: 1, cost: 0.5, power: 0.25, locality: 1, reliability: 1 };
    const requiredLabels = [...new Set([...input.requiredLabels, ...(policy?.requiredLabels ?? [])])];
    const candidates = store.state.devices.map((device) => {
      const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === device.id); const reasons: string[] = []; let rejected = false;
      const online = context.isOnline(device.id); const wakeable = online ? undefined : wakeEligibility(device.id);
      if (!online && !wakeable?.eligible) { rejected = true; reasons.push(`offline: ${wakeable?.detail ?? 'automatic wake is unavailable'}`); }
      else if (!online) reasons.push('offline but eligible for automatic wake');
      if (requiredLabels.some((label) => !device.capabilities.labels.includes(label))) { rejected = true; reasons.push('missing required labels'); }
      if (policy?.excludedDeviceIds.includes(device.id)) { rejected = true; reasons.push('excluded by policy'); }
      if (profile?.maintenanceMode || profile?.quarantined) { rejected = true; reasons.push(profile.quarantined ? 'quarantined' : 'maintenance mode'); }
      if (policy?.maximumTemperatureCelsius && Math.max(device.metrics.cpu.temperatureCelsius ?? 0, ...device.metrics.gpus.map((gpu) => gpu.temperatureCelsius ?? 0)) > policy.maximumTemperatureCelsius) { rejected = true; reasons.push('temperature threshold'); }
      if (policy?.minimumBatteryPercent !== undefined && device.metrics.battery && device.metrics.battery.percent < policy.minimumBatteryPercent && !device.metrics.battery.acConnected) { rejected = true; reasons.push('battery below policy minimum'); }
      if (policy?.maximumQueueDepth !== undefined && device.activeJobIds.length >= policy.maximumQueueDepth) { rejected = true; reasons.push('queue depth limit'); }
      if (policy?.avoidLaptops && device.metrics.battery) { rejected = true; reasons.push('laptop avoided by policy'); }
      if (policy?.avoidProduction && device.capabilities.labels.some((label) => label === 'production' || label === 'environment:production')) { rejected = true; reasons.push('production device avoided by policy'); }
      const dataLocal = Boolean(input.projectId && store.state.projects.find((project) => project.id === input.projectId)?.paths.some((path) => path.deviceId === device.id));
      if (input.projectId && !dataLocal) { rejected = true; reasons.push('project is not mapped on device'); }
      let score = (100 - device.metrics.cpu.usagePercent) * weights.cpu + (100 - device.metrics.memory.usagePercent) * weights.memory - device.activeJobIds.length * 20 * weights.queue - (profile?.hourlyCost ?? 0) * 10 * weights.cost - (profile?.powerPolicy.estimatedWattsBusy ?? 0) / 10 * weights.power;
      if (!online) score -= 5_000;
      if (device.metrics.gpus.length) score += (100 - (device.metrics.gpus[0]?.usagePercent ?? 0)) * weights.gpu;
      if (input.preferredDeviceIds?.includes(device.id)) { score += 100; reasons.push('preferred device'); }
      if (policy?.preferredRoles.includes(device.role)) { score += 50; reasons.push('preferred role'); }
      if (dataLocal) { score += (policy?.strategy === 'data-locality' ? 500 : 50) * weights.locality; reasons.push('project data local'); }
      if (policy?.strategy === 'lowest-cost') score -= (profile?.hourlyCost ?? 0) * 1_000;
      if (policy?.strategy === 'lowest-power') score -= (profile?.powerPolicy.estimatedWattsBusy ?? device.metrics.powerDrawWatts ?? 0) * 10;
      if (policy?.strategy === 'always-on' && ['core', 'worker', 'gateway', 'storage'].includes(device.role)) { score += 250; reasons.push('always-on role'); }
      if (policy?.strategy === 'dedicated' && (profile?.reservedFor === input.projectId || device.capabilities.labels.includes('dedicated'))) { score += 250; reasons.push('dedicated worker'); }
      return { deviceId: device.id, score: Math.round(score * 100) / 100, reasons, rejected };
    }).sort((a, b) => Number(a.rejected) - Number(b.rejected) || b.score - a.score);
    const decision: SchedulingDecision = { id: randomUUID(), jobId: input.jobId, selectedDeviceId: candidates.find((item) => !item.rejected)?.deviceId, candidateScores: candidates, policyId: policy?.id, createdAt: timestamp() };
    store.state.v2.schedulingDecisions.unshift(decision); store.markDirty(); return decision;
  }

  app.get('/api/v2/scheduling-policies', async () => store.state.v2.schedulingPolicies);
  app.post('/api/v2/scheduling-policies', async (request, reply) => { const body = request.body as Partial<SchedulingPolicy>; if (!body?.name) throw httpError(400, 'name is required.'); const at = timestamp(); const item: SchedulingPolicy = { id: randomUUID(), name: body.name, strategy: body.strategy ?? 'balanced', enabled: body.enabled ?? true, priority: body.priority ?? 0, projectIds: body.projectIds ?? [], requiredLabels: body.requiredLabels ?? [], preferredRoles: body.preferredRoles ?? [], excludedDeviceIds: body.excludedDeviceIds ?? [], avoidLaptops: body.avoidLaptops ?? false, avoidProduction: body.avoidProduction ?? false, maximumTemperatureCelsius: body.maximumTemperatureCelsius, minimumBatteryPercent: body.minimumBatteryPercent, maximumQueueDepth: body.maximumQueueDepth, weights: body.weights ?? { cpu: 1, memory: 1, gpu: 1, queue: 1, cost: 0.5, power: 0.25, locality: 1, reliability: 1 }, createdAt: at, updatedAt: at }; store.state.v2.schedulingPolicies.push(item); audit(context, 'scheduler-policy.create', 'scheduling-policy', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/scheduling-policies/:id', async (request) => { const item = required(store.state.v2.schedulingPolicies, (request.params as { id: string }).id, 'Scheduling policy'); Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { updatedAt: timestamp() }); audit(context, 'scheduler-policy.update', 'scheduling-policy', item.id); changed(context); return item; });
  function applicablePolicy(projectId?: string): SchedulingPolicy | undefined { return store.state.v2.schedulingPolicies.filter((item) => item.enabled && (!item.projectIds.length || Boolean(projectId && item.projectIds.includes(projectId)))).sort((a, b) => b.priority - a.priority)[0]; }
  app.post('/api/v2/scheduling/select', async (request) => { const body = z.object({ policyId: idSchema.optional(), requiredLabels: z.array(z.string()).default([]), preferredDeviceIds: z.array(idSchema).optional(), projectId: idSchema.optional(), jobId: idSchema.optional() }).parse(request.body); const policy = body.policyId ? required(store.state.v2.schedulingPolicies, body.policyId, 'Scheduling policy') : applicablePolicy(body.projectId); const decision = schedule(policy, body); changed(context); return decision; });

  async function deliverWebhook(channel: NotificationChannel, notification: FleetNotification): Promise<void> {
    const url = String(channel.config.url ?? ''); if (!url) throw new Error('Webhook URL is not configured.');
    const response = await safeFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(notification), signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
  }
  async function notify(severity: FleetNotification['severity'], title: string, body: string, channelIds?: string[]): Promise<FleetNotification[]> {
    const channels = store.state.v2.notificationChannels.filter((item) => item.enabled && (!channelIds?.length || channelIds.includes(item.id))); const notifications: FleetNotification[] = [];
    for (const channel of channels.length ? channels : [undefined]) { const supported = !channel || channel.kind === 'desktop' || channel.kind === 'webhook'; const item: FleetNotification = { id: randomUUID(), channelId: channel?.id, severity, title, body, status: channel?.kind === 'desktop' || !channel ? 'sent' : supported ? 'pending' : 'failed', createdAt: timestamp(), sentAt: channel?.kind === 'desktop' || !channel ? timestamp() : undefined, ...(!supported ? { error: `${channel!.kind} delivery requires an external notification adapter.` } : {}) }; store.state.v2.notifications.unshift(item); notifications.push(item); if (channel?.kind === 'webhook') { try { await deliverWebhook(channel, item); item.status = 'sent'; item.sentAt = timestamp(); } catch (error) { item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error); } } void emitFleetEvent('notification.created', item); }
    changed(context); return notifications;
  }

  app.get('/api/v2/notification-channels', async () => store.state.v2.notificationChannels);
  app.post('/api/v2/notification-channels', async (request, reply) => { const body = z.object({ name: nameSchema, kind: z.enum(['desktop', 'webhook']), enabled: z.boolean().default(true), config: recordSchema.default({}), secretId: idSchema.optional() }).parse(request.body); if (body.kind === 'webhook' && typeof body.config.url !== 'string') throw httpError(400, 'Webhook notification channels require config.url.'); const at = timestamp(); const item: NotificationChannel = { id: randomUUID(), ...body, createdAt: at, updatedAt: at }; store.state.v2.notificationChannels.push(item); audit(context, 'notification-channel.create', 'notification-channel', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/notification-channels/:id', async (request) => { const item = required(store.state.v2.notificationChannels, (request.params as { id: string }).id, 'Notification channel'); Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { updatedAt: timestamp() }); changed(context); return item; });
  app.post('/api/v2/notification-channels/:id/test', async (request) => { const item = required(store.state.v2.notificationChannels, (request.params as { id: string }).id, 'Notification channel'); return (await notify('info', 'Fleet test notification', `The ${item.name} channel is working.`, [item.id]))[0]; });
  app.get('/api/v2/notifications', async () => store.state.v2.notifications);
  app.post('/api/v2/notifications', async (request, reply) => { const body = z.object({ severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'), title: nameSchema, body: z.string().max(20_000), channelIds: z.array(idSchema).optional() }).parse(request.body); return reply.code(201).send(await notify(body.severity, body.title, body.body, body.channelIds)); });
  app.post('/api/v2/notifications/:id/read', async (request) => { const item = required(store.state.v2.notifications, (request.params as { id: string }).id, 'Notification'); item.status = 'read'; item.readAt = timestamp(); store.markDirty(); return item; });

  app.get('/api/v2/api-tokens', async () => store.state.v2.apiTokens);
  app.post('/api/v2/api-tokens', async (request, reply) => { const body = z.object({ name: nameSchema, scopes: z.array(z.string()).min(1).max(200), expiresAt: z.string().datetime().optional() }).parse(request.body); const token = issueCredential('flt_'), id = randomUUID(); const item: ApiTokenMetadata = { id, name: body.name, prefix: token.slice(0, 12), scopes: body.scopes, status: 'active', createdBy: context.currentAuditActor().actorId, createdAt: timestamp(), expiresAt: body.expiresAt }; store.state.v2.apiTokens.push(item); store.state.private.apiTokenHashes[id] = hashCredential(token); audit(context, 'api-token.create', 'api-token', id); changed(context); return reply.code(201).send({ ...item, token }); });
  app.post('/api/v2/api-tokens/:id/revoke', async (request) => { const item = required(store.state.v2.apiTokens, (request.params as { id: string }).id, 'API token'); item.status = 'disabled'; delete store.state.private.apiTokenHashes[item.id]; audit(context, 'api-token.revoke', 'api-token', item.id); changed(context); return item; });

  app.get('/api/v2/webhooks', async () => store.state.v2.webhooks);
  app.post('/api/v2/webhooks', async (request, reply) => { const body = z.object({ name: nameSchema, url: z.string().url(), events: z.array(z.string()).default(['*']), enabled: z.boolean().default(true), secretId: idSchema.optional(), headers: z.record(z.string(), z.string()).default({}) }).parse(request.body); const at = timestamp(); const item: WebhookRegistration = { id: randomUUID(), ...body, failureCount: 0, createdAt: at, updatedAt: at }; store.state.v2.webhooks.push(item); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/webhooks/:id', async (request) => { const item = required(store.state.v2.webhooks, (request.params as { id: string }).id, 'Webhook'); Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { updatedAt: timestamp() }); changed(context); return item; });
  async function deliverRegisteredWebhook(item: WebhookRegistration, event: string, data: unknown): Promise<number> { const deliveryId = randomUUID(), at = timestamp(), body = JSON.stringify({ id: deliveryId, event, at, data }); let signature: string | undefined; if (item.secretId) { const encrypted = store.state.private.encryptedSecrets[item.secretId]; if (!encrypted) throw new Error('Webhook signing secret is unavailable.'); signature = createHmac('sha256', decryptValue(encrypted, vaultKey)).update(body).digest('hex'); } const response = await safeFetch(item.url, { method: 'POST', headers: { ...item.headers, 'content-type': 'application/json', 'x-fleet-event': event, 'x-fleet-delivery': deliveryId, ...(signature ? { 'x-fleet-signature-256': `sha256=${signature}` } : {}) }, body, signal: AbortSignal.timeout(15_000) }); item.lastDeliveryAt = at; if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`); return response.status; }
  async function emitFleetEvent(event: string, data: unknown): Promise<void> { for (const item of store.state.v2.webhooks.filter((hook) => hook.enabled && (hook.events.includes('*') || hook.events.includes(event)))) { try { await deliverRegisteredWebhook(item, event, data); item.failureCount = 0; } catch { item.failureCount += 1; } } store.markDirty(); }
  app.post('/api/v2/webhooks/:id/test', async (request) => { const item = required(store.state.v2.webhooks, (request.params as { id: string }).id, 'Webhook'); try { const status = await deliverRegisteredWebhook(item, 'fleet.test', { webhookId: item.id }); item.failureCount = 0; changed(context); return { delivered: true, status }; } catch (error) { item.failureCount += 1; changed(context); throw httpError((error as { statusCode?: number }).statusCode ?? 502, error instanceof Error ? error.message : String(error)); } });

  function genericCrud<T extends { id: string }>(path: string, items: () => T[], create: (body: Record<string, unknown>) => T, label: string): void {
    app.get(`/api/v2/${path}`, async () => items());
    app.post(`/api/v2/${path}`, async (request, reply) => { const item = create(recordSchema.parse(request.body)); items().push(item); audit(context, `${label}.create`, label, item.id); changed(context); return reply.code(201).send(item); });
    app.patch(`/api/v2/${path}/:id`, async (request) => { const item = required(items(), (request.params as { id: string }).id, label); Object.assign(item, cleanPatch(recordSchema.parse(request.body)), 'updatedAt' in item ? { updatedAt: timestamp() } : {}); audit(context, `${label}.update`, label, item.id); changed(context); return item; });
    app.delete(`/api/v2/${path}/:id`, async (request, reply) => { const id = (request.params as { id: string }).id; const list = items(), index = list.findIndex((item) => item.id === id); if (index < 0) throw httpError(404, `${label} not found.`); list.splice(index, 1); audit(context, `${label}.delete`, label, id); changed(context); return reply.code(204).send(); });
  }

  genericCrud('plugins', () => store.state.v2.plugins, (body) => ({ id: randomUUID(), name: String(body.name ?? 'Plugin'), version: String(body.version ?? '0.1.0'), description: String(body.description ?? ''), entrypoint: String(body.entrypoint ?? ''), capabilities: (body.capabilities ?? []) as never[], enabled: Boolean(body.enabled ?? false), signed: Boolean(body.signed ?? false), checksumSha256: body.checksumSha256 as string | undefined, configSchema: body.configSchema as Record<string, unknown> | undefined, installedAt: timestamp() }), 'plugin');
  const policyFieldsSchema = z.object({ name: nameSchema, description: z.string().max(10_000).default(''), scope: z.enum(['organization', 'workspace', 'project', 'device-group']).default('organization'), scopeId: idSchema.optional(), enabled: z.boolean().default(true), priority: z.number().int().min(-1_000_000).max(1_000_000).default(0), effect: z.enum(['allow', 'deny', 'require-approval']), actions: z.array(z.string().trim().min(1).max(256)).min(1).max(1_000), conditions: recordSchema.default({}) });
  const policyBodySchema = policyFieldsSchema.superRefine((value, refinement) => { if (value.scope !== 'organization' && !value.scopeId) refinement.addIssue({ code: 'custom', path: ['scopeId'], message: `${value.scope} policies require scopeId.` }); });
  app.get('/api/v2/policies', async () => store.state.v2.policies);
  app.post('/api/v2/policies', async (request, reply) => { const body = policyBodySchema.parse(request.body); const at = timestamp(); const item: FleetPolicy = { ...body, id: randomUUID(), version: 1, createdAt: at, updatedAt: at }; store.state.v2.policies.push(item); audit(context, 'policy.create', 'policy', item.id); changed(context); return reply.code(201).send(item); });
  app.patch('/api/v2/policies/:id', async (request) => { const item = required(store.state.v2.policies, (request.params as { id: string }).id, 'Policy'); const patch = policyFieldsSchema.partial().parse(request.body); const body = policyBodySchema.parse({ ...item, ...patch }); Object.assign(item, body, { version: item.version + 1, updatedAt: timestamp() }); audit(context, 'policy.update', 'policy', item.id); changed(context); return item; });
  app.delete('/api/v2/policies/:id', async (request, reply) => { const id = (request.params as { id: string }).id; required(store.state.v2.policies, id, 'Policy'); store.state.v2.policies = store.state.v2.policies.filter((item) => item.id !== id); audit(context, 'policy.delete', 'policy', id); changed(context); return reply.code(204).send(); });
  genericCrud('members', () => store.state.v2.members, (body) => ({ id: randomUUID(), displayName: String(body.displayName ?? body.name ?? 'Member'), email: body.email as string | undefined, roleIds: (body.roleIds ?? []) as string[], groupIds: (body.groupIds ?? []) as string[], status: (body.status ?? 'active') as 'active', createdAt: timestamp() }), 'member');
  app.get('/api/v2/roles', async () => store.state.v2.roles);
  app.post('/api/v2/policies/evaluate', async (request) => { const body = z.object({ action: z.string(), resource: z.string(), memberId: idSchema.optional(), context: recordSchema.default({}) }).parse(request.body); const member = body.memberId ? required(store.state.v2.members, body.memberId, 'Member') : undefined; const permissions = member ? new Set(store.state.v2.roles.filter((role) => member.roleIds.includes(role.id)).flatMap((role) => role.permissions)) : new Set(['*']); const permission = permissions.has('*') || permissions.has(body.action) || permissions.has(`${body.resource}:*`); const supplied = body.context; const evaluated = evaluateFleetPolicies(store.state.v2.policies, { action: body.action, actorType: member ? 'user' : 'system', actorId: member?.id ?? 'policy-simulator', method: typeof supplied.method === 'string' ? supplied.method : undefined, sourceIp: typeof supplied.sourceIp === 'string' ? supplied.sourceIp : undefined, projectId: typeof supplied.projectId === 'string' ? supplied.projectId : undefined, deviceId: typeof supplied.deviceId === 'string' ? supplied.deviceId : undefined, deviceGroupIds: Array.isArray(supplied.deviceGroupIds) ? supplied.deviceGroupIds.filter((value): value is string => typeof value === 'string') : undefined, workspaceId: typeof supplied.workspaceId === 'string' ? supplied.workspaceId : undefined, environment: typeof supplied.environment === 'string' ? supplied.environment : undefined, dataClassification: typeof supplied.dataClassification === 'string' ? supplied.dataClassification : undefined }); const decision = evaluated.policy ? evaluated.effect : permission ? 'allow' : 'deny'; const actor = context.currentAuditActor(); appendAudit(store, { ...actor, action: 'policy.evaluate', resourceType: body.resource, outcome: decision === 'allow' ? 'success' : 'denied', detail: { simulatedAction: body.action, simulatedMemberId: member?.id, policyId: evaluated.policy?.id, decision } }); changed(context); return { decision, policyId: evaluated.policy?.id, permissionMatched: permission }; });

  app.get('/api/v2/desktop-sessions', async () => store.state.v2.desktopSessions);
  app.post('/api/v2/desktop-sessions', async (request, reply) => { const body = z.object({ deviceId: idSchema, protocol: z.enum(['rdp', 'vnc', 'screen-sharing', 'sunshine', 'webrtc', 'external']).default('screen-sharing'), viewOnly: z.boolean().default(false), recording: z.boolean().default(false), connectionUrl: z.string().url().optional(), expiresInSeconds: z.number().int().positive().max(86_400).optional(), config: recordSchema.default({}) }).parse(request.body); if (!context.isOnline(body.deviceId) && body.protocol !== 'external') throw httpError(409, 'Device is offline.'); if (body.protocol === 'external' && !body.connectionUrl) throw httpError(400, 'External desktop sessions require connectionUrl.'); const item: RemoteDesktopSession = { id: randomUUID(), deviceId: body.deviceId, protocol: body.protocol, status: body.connectionUrl ? 'ready' : 'starting', viewOnly: body.viewOnly, recording: body.recording, connectionUrl: body.connectionUrl, expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1_000).toISOString() : undefined, createdAt: timestamp() }; store.state.v2.desktopSessions.unshift(item); if (body.protocol !== 'external') { try { const result = await context.dispatch(body.deviceId, { type: 'desktop.start', payload: { session: item, config: body.config } }, 30_000) as { connectionUrl?: string }; item.connectionUrl = result.connectionUrl ?? item.connectionUrl; item.status = 'ready'; } catch (error) { item.status = 'error'; item.error = error instanceof Error ? error.message : String(error); } } audit(context, 'desktop-session.create', 'desktop-session', item.id); changed(context); return reply.code(201).send(item); });
  app.post('/api/v2/desktop-sessions/:id/close', async (request) => { const item = required(store.state.v2.desktopSessions, (request.params as { id: string }).id, 'Desktop session'); if (item.protocol !== 'external' && context.isOnline(item.deviceId)) await context.dispatch(item.deviceId, { type: 'desktop.stop', payload: { sessionId: item.id } }); item.status = 'closed'; item.closedAt = timestamp(); audit(context, 'desktop-session.close', 'desktop-session', item.id); changed(context); return item; });

  app.get('/api/v2/diagnostics', async () => store.state.v2.diagnostics);
  app.post('/api/v2/diagnostics', async (request, reply) => { const body = z.object({ deviceId: idSchema.optional(), kind: z.enum(['agent', 'core', 'network', 'storage', 'database', 'backup', 'compatibility', 'support-bundle']).default('core'), redact: z.boolean().default(true) }).parse(request.body ?? {}); const checks: DiagnosticReport['checks'] = [];
    if (body.deviceId) { const device = store.state.devices.find((item) => item.id === body.deviceId); checks.push({ name: 'Device registry', status: device ? 'pass' : 'fail', detail: device ? `${device.name} is registered.` : 'Device is not registered.' }); checks.push({ name: 'Agent connection', status: body.deviceId && context.isOnline(body.deviceId) ? 'pass' : 'fail', detail: context.isOnline(body.deviceId) ? 'Agent is online.' : 'Agent is offline.', remediation: context.isOnline(body.deviceId) ? undefined : 'Start the Fleet Agent and verify its credential.' }); if (context.isOnline(body.deviceId) && ['agent', 'network', 'storage', 'compatibility'].includes(body.kind)) { try { const result = await context.dispatch(body.deviceId, { type: 'diagnostics.run', payload: { kind: body.kind as 'agent' | 'network' | 'storage' | 'compatibility', redact: body.redact } }, 60_000) as { checks?: DiagnosticReport['checks'] }; if (Array.isArray(result.checks)) checks.push(...result.checks.slice(0, 200).map((check) => ({ name: String(check.name).slice(0, 200), status: ['pass', 'warning', 'fail'].includes(check.status) ? check.status : 'warning', detail: String(check.detail).slice(0, 8_000), remediation: check.remediation ? String(check.remediation).slice(0, 4_000) : undefined })) as DiagnosticReport['checks']); } catch (error) { checks.push({ name: 'Agent diagnostics', status: 'fail', detail: error instanceof Error ? error.message.slice(0, 8_000) : String(error).slice(0, 8_000), remediation: 'Check Agent logs and connectivity.' }); } } }
    checks.push({ name: 'State persistence', status: await store.existsOnDisk() ? 'pass' : 'warning', detail: await store.existsOnDisk() ? 'State file exists.' : 'State has not yet been flushed.' }); checks.push({ name: 'Audit chain', status: verifyAudit(store.state.v2.audit).valid ? 'pass' : 'fail', detail: verifyAudit(store.state.v2.audit).valid ? 'Audit chain verified.' : 'Audit chain verification failed.' });
    const at = timestamp(); const item: DiagnosticReport = { id: randomUUID(), deviceId: body.deviceId, kind: body.kind, state: checks.some((check) => check.status === 'fail') ? 'failed' : 'succeeded', redacted: body.redact, checks: checks.slice(0, 250), createdAt: at, completedAt: at }; store.state.v2.diagnostics.unshift(item); audit(context, 'diagnostic.run', 'diagnostic', item.id); changed(context); return reply.code(201).send(item); });

  app.get('/api/v2/advanced-sessions', async () => store.state.v2.advancedSessions);
  app.put('/api/v2/advanced-sessions/:sessionId', async (request) => { const sessionId = (request.params as { sessionId: string }).sessionId; if (!store.state.sessions.some((session) => session.id === sessionId)) throw httpError(404, 'Codex session not found.'); let item = store.state.v2.advancedSessions.find((entry) => entry.sessionId === sessionId); if (!item) { item = { sessionId, bookmarks: [] }; store.state.v2.advancedSessions.push(item); } Object.assign(item, cleanPatch(recordSchema.parse(request.body)), { sessionId }); audit(context, 'advanced-session.update', 'codex-session', sessionId); changed(context); return item; });
  app.post('/api/v2/advanced-sessions/:sessionId/bookmarks', async (request, reply) => { const item = store.state.v2.advancedSessions.find((entry) => entry.sessionId === (request.params as { sessionId: string }).sessionId); if (!item) throw httpError(404, 'Advanced session metadata not found.'); const body = z.object({ eventId: idSchema, label: nameSchema }).parse(request.body); const bookmark = { id: randomUUID(), ...body, createdAt: timestamp() }; item.bookmarks.push(bookmark); changed(context); return reply.code(201).send(bookmark); });

  app.get('/api/v2/agent-teams', async () => store.state.v2.agentTeams);
  app.post('/api/v2/agent-teams', async (request, reply) => {
    const body = z.object({ name: nameSchema, objective: z.string().min(1).max(100_000), projectId: idSchema.optional(), budgetTokens: z.number().int().positive().optional(), maximumRuntimeMinutes: z.number().int().positive().optional(), permissionMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'), tasks: z.array(z.object({ id: idSchema.optional(), title: nameSchema, description: z.string().max(100_000), role: z.string().max(200), deviceId: idSchema.optional(), dependsOn: z.array(idSchema).default([]) })).min(1).max(100) }).parse(request.body);
    const normalized = body.tasks.map((task) => ({ ...task, id: task.id ?? task.title })); const ids = new Set(normalized.map((task) => task.id));
    if (ids.size !== normalized.length) throw httpError(400, 'Agent-team task IDs or titles must be unique.');
    for (const task of normalized) if (task.dependsOn.some((id) => !ids.has(id))) throw httpError(400, `Task ${task.title} has an unknown dependency.`);
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): boolean => { if (visiting.has(id)) return false; if (visited.has(id)) return true; visiting.add(id); const task = normalized.find((candidate) => candidate.id === id)!; if (task.dependsOn.some((dependency) => !visit(dependency))) return false; visiting.delete(id); visited.add(id); return true; };
    if (normalized.some((task) => !visit(task.id))) throw httpError(400, 'Agent-team dependencies contain a cycle.');
    const item: AgentTeam = { id: randomUUID(), name: body.name, objective: body.objective, projectId: body.projectId, state: 'pending', budgetTokens: body.budgetTokens, usedTokens: 0, maximumRuntimeMinutes: body.maximumRuntimeMinutes, permissionMode: body.permissionMode, tasks: normalized.map((task) => ({ ...task, state: 'pending', outputArtifactIds: [], createdAt: timestamp() })), messages: [], createdAt: timestamp() };
    store.state.v2.agentTeams.unshift(item); audit(context, 'agent-team.create', 'agent-team', item.id); changed(context); return reply.code(201).send(item);
  });
  const teamLocks = new Set<string>();
  function estimatedJobTokens(job: Pick<FleetJob, 'prompt' | 'output'>): number {
    let reported = 0;
    for (const event of job.output) {
      const raw = event.raw && typeof event.raw === 'object' ? event.raw as Record<string, unknown> : undefined;
      const usage = raw && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : raw;
      if (!usage) continue;
      const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0), output = Number(usage.output_tokens ?? usage.outputTokens ?? 0), total = Number(usage.total_tokens ?? usage.totalTokens ?? input + output);
      if (Number.isFinite(total)) reported = Math.max(reported, total);
    }
    return Math.max(reported, Math.ceil((job.prompt.length + job.output.reduce((sum, event) => sum + event.text.length, 0)) / 4));
  }
  async function cancelTeamWork(team: AgentTeam, reason: string): Promise<void> {
    const active = team.tasks.filter((item) => ['pending', 'queued', 'running', 'awaiting-approval'].includes(item.state));
    for (const task of active) { task.state = 'cancelled'; task.error = reason; task.completedAt = timestamp(); }
    await Promise.allSettled(active.filter((task) => task.sessionId).map((task) => context.cancelJob(task.sessionId!)));
    team.state = 'cancelled'; team.completedAt = timestamp();
  }
  async function advanceTeam(team: AgentTeam): Promise<void> {
    if (teamLocks.has(team.id) || ['cancelled', 'failed', 'succeeded'].includes(team.state)) return; teamLocks.add(team.id);
    try {
      const started = team.startedAt ? new Date(team.startedAt).getTime() : Date.now();
      if (team.maximumRuntimeMinutes && Date.now() - started >= team.maximumRuntimeMinutes * 60_000) { await cancelTeamWork(team, 'Team maximum runtime exceeded.'); changed(context); return; }
      for (const task of team.tasks.filter((item) => item.state === 'running' && item.sessionId)) { const job = store.state.jobs.find((candidate) => candidate.id === task.sessionId); if (job?.status === 'completed') { task.state = 'succeeded'; task.completedAt = timestamp(); } else if (job && ['failed', 'cancelled'].includes(job.status)) { task.state = job.status === 'cancelled' ? 'cancelled' : 'failed'; task.error = job.error; task.completedAt = timestamp(); } }
      team.usedTokens = team.tasks.reduce((sum, task) => sum + (task.sessionId ? estimatedJobTokens(store.state.jobs.find((job) => job.id === task.sessionId) ?? { prompt: '', output: [] }) : 0), 0);
      if (team.budgetTokens && team.usedTokens >= team.budgetTokens && team.tasks.some((task) => ['pending', 'running', 'queued', 'awaiting-approval'].includes(task.state))) { await cancelTeamWork(team, 'Team token budget exhausted.'); changed(context); return; }
      const ready = team.tasks.filter((item) => item.state === 'pending' && item.dependsOn.every((dependency) => team.tasks.find((candidate) => candidate.id === dependency)?.state === 'succeeded'));
      for (const task of ready) {
        try {
          const handoffs = task.dependsOn.map((dependency) => { const source = team.tasks.find((candidate) => candidate.id === dependency); const job = source?.sessionId ? store.state.jobs.find((candidate) => candidate.id === source.sessionId) : undefined; const output = job?.output.slice(-20).map((event) => event.text).join('').slice(-12_000); return source ? `From ${source.role} (${source.title}):\n${output || 'Task completed without text output.'}` : ''; }).filter(Boolean);
          const messages = team.messages.filter((message) => !message.toTaskId || message.toTaskId === task.id).map((message) => `Team message${message.fromTaskId ? ` from ${message.fromTaskId}` : ''}: ${message.body}`).slice(-20);
          const prompt = [team.objective, `Your role: ${task.role}`, `Task: ${task.description}`, ...handoffs, ...messages].join('\n\n');
          if (team.budgetTokens && team.usedTokens + Math.ceil(prompt.length / 4) > team.budgetTokens) { task.state = 'cancelled'; task.error = 'Insufficient team token budget to start this task.'; task.completedAt = timestamp(); continue; }
          const job = await context.createJob({ name: `${team.name}: ${task.title}`, kind: 'codex', prompt, projectId: team.projectId, deviceId: task.deviceId, permissionMode: team.permissionMode, approvalPolicy: 'on-request', requiredLabels: [] }); task.state = 'running'; task.deviceId = job.deviceId; task.sessionId = job.id;
        } catch (error) { task.state = 'failed'; task.error = error instanceof Error ? error.message : String(error); task.completedAt = timestamp(); }
      }
      if (team.tasks.every((task) => finalStates.has(task.state))) { team.state = team.tasks.some((task) => task.state === 'failed') ? 'failed' : team.tasks.some((task) => task.state === 'cancelled') ? 'cancelled' : 'succeeded'; team.completedAt = timestamp(); }
      else if (team.tasks.some((task) => task.state === 'failed' && team.tasks.some((candidate) => candidate.dependsOn.includes(task.id)))) { team.state = 'failed'; team.completedAt = timestamp(); }
      else team.state = 'running';
      changed(context);
    } finally { teamLocks.delete(team.id); }
  }
  const teamTimer = setInterval(() => { for (const team of store.state.v2.agentTeams.filter((item) => item.state === 'running')) void advanceTeam(team); }, 5_000); teamTimer.unref(); pipelineTimers.add(teamTimer);
  app.post('/api/v2/agent-teams/:id/run', async (request) => { const team = required(store.state.v2.agentTeams, (request.params as { id: string }).id, 'Agent team'); if (team.state !== 'pending') throw httpError(409, `Team cannot start while ${team.state}.`); team.state = 'running'; team.startedAt = timestamp(); await advanceTeam(team); audit(context, 'agent-team.run', 'agent-team', team.id); changed(context); return team; });
  app.post('/api/v2/agent-teams/:id/messages', async (request, reply) => { const team = required(store.state.v2.agentTeams, (request.params as { id: string }).id, 'Agent team'); const body = z.object({ fromTaskId: idSchema.optional(), toTaskId: idSchema.optional(), body: z.string().min(1).max(100_000) }).parse(request.body); if (body.fromTaskId && !team.tasks.some((task) => task.id === body.fromTaskId)) throw httpError(404, 'Source team task not found.'); if (body.toTaskId && !team.tasks.some((task) => task.id === body.toTaskId)) throw httpError(404, 'Target team task not found.'); if (body.toTaskId && team.tasks.find((task) => task.id === body.toTaskId)?.state === 'running') throw httpError(409, 'Messages can be delivered to pending tasks; this one is already running.'); const message = { id: randomUUID(), ...body, at: timestamp() }; team.messages.push(message); changed(context); return reply.code(201).send(message); });
  app.post('/api/v2/agent-teams/:id/cancel', async (request) => { const team = required(store.state.v2.agentTeams, (request.params as { id: string }).id, 'Agent team'); team.state = 'cancelled'; team.completedAt = timestamp(); const active = team.tasks.filter((item) => ['pending', 'running'].includes(item.state)); for (const task of active) { task.state = 'cancelled'; task.completedAt = timestamp(); } await Promise.allSettled(active.filter((task) => task.sessionId).map((task) => context.cancelJob(task.sessionId!))); audit(context, 'agent-team.cancel', 'agent-team', team.id, { cancelledJobs: active.filter((task) => task.sessionId).length }); changed(context); return team; });

  // Route aliases retained for clients built against the final V2 naming convention.
  app.get('/api/v2/enrollment-tokens', async () => store.state.v2.enrollmentTokens);
  app.post('/api/v2/enrollment-tokens', async (request, reply) => {
    const body = enrollmentSchema.parse(request.body); const token = issueCredential('fle_'); const id = randomUUID();
    const record = { id, label: body.label, role: body.role, groupIds: body.groupIds, updateChannel: body.updateChannel, expiresAt: new Date(Date.now() + (body.expiresInSeconds ?? body.expiresInHours * 3_600) * 1_000).toISOString(), maxUses: body.maxUses, uses: 0, createdAt: timestamp(), createdBy: context.currentAuditActor().actorId };
    store.state.v2.enrollmentTokens.unshift(record); store.state.private.enrollmentTokenHashes[id] = hashCredential(token); audit(context, 'enrollment-token.create', 'enrollment-token', id); changed(context); return reply.code(201).send({ ...record, record, token, enrollmentUrl: `${context.coreUrl}/api/v2/enrollment/exchange` });
  });
  app.post('/api/v2/enrollment-tokens/:id/revoke', async (request) => { const record = required(store.state.v2.enrollmentTokens, (request.params as { id: string }).id, 'Enrollment token'); record.revokedAt = timestamp(); delete store.state.private.enrollmentTokenHashes[record.id]; audit(context, 'enrollment-token.revoke', 'enrollment-token', record.id); changed(context); return record; });
  app.post('/api/v2/enrollment/tokens/:id/revoke', async (request) => { const record = required(store.state.v2.enrollmentTokens, (request.params as { id: string }).id, 'Enrollment token'); record.revokedAt = timestamp(); delete store.state.private.enrollmentTokenHashes[record.id]; audit(context, 'enrollment-token.revoke', 'enrollment-token', record.id); changed(context); return record; });
  app.get('/api/v2/device-credentials', async () => store.state.v2.deviceCredentials);
  app.get('/api/v2/scheduling-decisions', async () => store.state.v2.schedulingDecisions);
  app.post('/api/v2/secrets/:id/read', async (request) => { const item = required(store.state.v2.secrets, (request.params as { id: string }).id, 'Secret'); const encrypted = store.state.private.encryptedSecrets[item.id]; if (!encrypted) throw httpError(404, 'Encrypted value is unavailable.'); item.lastAccessedAt = timestamp(); audit(context, 'secret.reveal', 'secret', item.id); return { id: item.id, value: decryptValue(encrypted, vaultKey) }; });
  app.post('/api/v2/secrets/:id/rotate', async (request) => { const item = required(store.state.v2.secrets, (request.params as { id: string }).id, 'Secret'); const { value } = z.object({ value: z.string().min(1).max(1_000_000) }).parse(request.body); store.state.private.encryptedSecrets[item.id] = encryptValue(value, vaultKey); item.version += 1; item.rotatedAt = timestamp(); item.updatedAt = item.rotatedAt; audit(context, 'secret.rotate', 'secret', item.id); changed(context); return item; });
  app.post('/api/v2/devices/power', async (request, reply) => {
    const body = z.object({ deviceIds: z.array(idSchema).min(1).max(500), action: z.enum(powerActions as [DevicePowerAction, ...DevicePowerAction[]]), force: z.boolean().default(false) }).parse(request.body);
    const results: Array<{ deviceId: string; targetId?: string; result?: unknown; error?: string }> = [];
    for (const deviceId of body.deviceIds) {
      const device = store.state.devices.find((item) => item.id === deviceId);
      if (!device) { results.push({ deviceId, error: 'Device not found.' }); continue; }
      try {
        const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId);
        const targetId = body.action === 'wake' ? profile?.wakeRelayDeviceId : deviceId;
        if (!targetId || !context.isOnline(targetId)) throw new Error('Power target or wake relay is offline.');
        const payload = body.action === 'wake'
          ? { action: body.action, macAddress: profile?.wakeMacAddress, broadcastAddress: profile?.wakeBroadcastAddress, force: body.force }
          : { action: body.action, force: body.force };
        if (body.action === 'wake' && !payload.macAddress) throw new Error('Wake MAC address is not configured.');
        const result = await context.dispatch(targetId, { type: 'device.power', payload });
        recordAcceptedPowerAction(deviceId, body.action);
        results.push({ deviceId, targetId, result });
      } catch (error) {
        results.push({ deviceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const accepted = results.filter((item) => !item.error).map((item) => item.deviceId);
    const rejected = results.filter((item) => item.error).map((item) => ({ deviceId: item.deviceId, reason: item.error }));
    audit(context, `devices.power.${body.action}`, 'device-batch', undefined, { deviceIds: body.deviceIds, accepted, rejected });
    changed(context);
    return reply.code(202).send({ action: body.action, results, accepted, rejected });
  });

  genericCrud('agent-releases', () => store.state.v2.agentReleases, (body) => ({ id: randomUUID(), version: String(body.version ?? '0.0.0'), channel: (body.channel ?? 'stable') as 'stable', platform: String(body.platform ?? ''), arch: String(body.arch ?? ''), downloadUrl: String(body.downloadUrl ?? ''), checksumSha256: String(body.checksumSha256 ?? ''), signature: body.signature as string | undefined, releaseNotes: String(body.releaseNotes ?? ''), protocolMin: Number(body.protocolMin ?? 1), protocolMax: Number(body.protocolMax ?? store.state.v2.protocolVersion), createdAt: timestamp() }), 'agent-release');
  genericCrud('update-rollouts', () => store.state.v2.updateRollouts, (body) => ({ id: randomUUID(), releaseId: String(body.releaseId ?? ''), name: String(body.name ?? 'Rollout'), deviceIds: (body.deviceIds ?? []) as string[], groupIds: (body.groupIds ?? []) as string[], state: 'draft' as const, canaryPercent: Number(body.canaryPercent ?? 10), rollbackOnFailure: Boolean(body.rollbackOnFailure ?? true), maintenanceWindowOnly: Boolean(body.maintenanceWindowOnly ?? false), scheduledAt: body.scheduledAt as string | undefined, results: {}, createdAt: timestamp() }), 'update-rollout');
  async function runRollout(item: typeof store.state.v2.updateRollouts[number]): Promise<void> {
    const release = required(store.state.v2.agentReleases, item.releaseId, 'Agent release');
    if (release.protocolMin > store.state.v2.protocolVersion || release.protocolMax < store.state.v2.protocolVersion) { item.state = 'failed'; item.completedAt = timestamp(); audit(context, 'rollout.protocol-mismatch', 'update-rollout', item.id); changed(context); return; }
    if (item.scheduledAt && new Date(item.scheduledAt).getTime() > Date.now()) { item.state = 'scheduled'; const delay = Math.min(2_147_000_000, new Date(item.scheduledAt).getTime() - Date.now()); const timer = setTimeout(() => { pipelineTimers.delete(timer); void runRollout(item); }, delay); timer.unref(); pipelineTimers.add(timer); changed(context); return; }
    const groupDevices = item.groupIds.flatMap((groupId) => store.state.v2.groups.find((group) => group.id === groupId)?.deviceIds ?? []);
    const deviceIds = [...new Set([...item.deviceIds, ...groupDevices])].sort();
    if (!deviceIds.length) { item.state = 'failed'; item.completedAt = timestamp(); audit(context, 'rollout.empty', 'update-rollout', item.id); changed(context); return; }
    for (const deviceId of deviceIds) { const device = store.state.devices.find((candidate) => candidate.id === deviceId); if (device?.agentVersion === release.version) item.results[deviceId] = { ...item.results[deviceId], state: 'succeeded', updatedAt: timestamp() }; }
    const untouched = deviceIds.filter((deviceId) => item.results[deviceId] === undefined);
    const canarySize = Math.max(1, Math.ceil(deviceIds.length * Math.min(100, Math.max(1, item.canaryPercent)) / 100));
    const targets = Object.keys(item.results).length === 0 && item.canaryPercent < 100 ? untouched.slice(0, canarySize) : untouched;
    item.state = 'running'; item.startedAt ??= timestamp(); item.completedAt = undefined; changed(context);
    let installerHandoff = false;
    for (const deviceId of targets) {
      if (item.state !== 'running') return;
      const device = store.state.devices.find((candidate) => candidate.id === deviceId); const profile = store.state.v2.deviceProfiles.find((candidate) => candidate.deviceId === deviceId);
      const error = !device ? 'Device not found.' : !context.isOnline(deviceId) ? 'Device offline.' : (release.platform && release.platform !== device.platform) || (release.arch && release.arch !== device.arch) ? 'Release platform or architecture mismatch.' : item.maintenanceWindowOnly && !profile?.maintenanceMode ? 'Waiting for device maintenance mode.' : undefined;
      if (error) { item.results[deviceId] = { state: error.startsWith('Waiting') ? 'pending' : 'failed', error, previousVersion: device?.agentVersion, updatedAt: timestamp() }; changed(context); if (item.rollbackOnFailure && !error.startsWith('Waiting')) { item.state = 'failed'; item.completedAt = timestamp(); return; } continue; }
      if (!device) continue;
      try {
        enforceInternalPolicy('agents.update', `rollout:${item.id}`, { resourceType: 'device', resourceId: deviceId, deviceId });
        item.results[deviceId] = { state: 'running', previousVersion: device.agentVersion, updatedAt: timestamp() }; changed(context);
        await context.dispatch(deviceId, { type: 'update.prepare', payload: { version: release.version, url: release.downloadUrl, checksumSha256: release.checksumSha256, signature: release.signature, channel: release.channel } }, 120_000);
        const applied = await context.dispatch(deviceId, { type: 'update.apply', payload: { version: release.version, restart: true } }, 120_000) as Record<string, unknown>;
        if (applied.state !== 'applied') { installerHandoff = true; item.results[deviceId] = { state: 'awaiting-approval', previousVersion: device.agentVersion, error: String(applied.detail ?? 'Verified update is staged; the platform service installer must activate it.'), updatedAt: timestamp() }; }
        else item.results[deviceId] = { state: 'succeeded', previousVersion: device.agentVersion, updatedAt: timestamp() };
      } catch (errorValue) { item.results[deviceId] = { state: 'failed', previousVersion: device.agentVersion, error: errorValue instanceof Error ? errorValue.message : String(errorValue), updatedAt: timestamp() }; if (item.rollbackOnFailure) { item.state = 'failed'; item.completedAt = timestamp(); changed(context); return; } }
      changed(context);
    }
    const remaining = deviceIds.filter((deviceId) => !item.results[deviceId]);
    const waiting = Object.values(item.results).some((result) => ['pending', 'awaiting-approval'].includes(result.state));
    if (installerHandoff || waiting || (remaining.length > 0 && item.canaryPercent < 100)) { item.state = 'paused'; audit(context, remaining.length ? 'rollout.canary-paused' : 'rollout.installer-handoff', 'update-rollout', item.id, { remainingDevices: remaining.length }); changed(context); return; }
    item.state = Object.values(item.results).some((result) => result.state === 'failed') ? 'failed' : 'completed'; item.completedAt = timestamp(); audit(context, 'rollout.complete', 'update-rollout', item.id, { state: item.state }); changed(context);
  }
  app.post('/api/v2/update-rollouts/:id/run', async (request, reply) => { const item = required(store.state.v2.updateRollouts, (request.params as { id: string }).id, 'Update rollout'); void runRollout(item); return reply.code(202).send(item); });
  app.post('/api/v2/update-rollouts/:id/start', async (request, reply) => { const item = required(store.state.v2.updateRollouts, (request.params as { id: string }).id, 'Update rollout'); void runRollout(item); return reply.code(202).send(item); });
  app.post('/api/v2/update-rollouts/:id/pause', async (request) => { const item = required(store.state.v2.updateRollouts, (request.params as { id: string }).id, 'Update rollout'); item.state = 'paused'; changed(context); return item; });
  app.post('/api/v2/update-rollouts/:id/resume', async (request) => { const item = required(store.state.v2.updateRollouts, (request.params as { id: string }).id, 'Update rollout'); void runRollout(item); return item; });
  app.post('/api/v2/update-rollouts/:id/rollback', async (request) => { const item = required(store.state.v2.updateRollouts, (request.params as { id: string }).id, 'Update rollout'); const results = await Promise.all(Object.entries(item.results).filter(([, result]) => result.state === 'succeeded' && result.previousVersion).map(async ([deviceId, result]) => { try { await context.dispatch(deviceId, { type: 'update.rollback', payload: { version: result.previousVersion! } }, 120_000); return { deviceId, rolledBack: true }; } catch (error) { return { deviceId, rolledBack: false, error: error instanceof Error ? error.message : String(error) }; } })); item.state = results.every((result) => result.rolledBack) ? 'rolled-back' : 'failed'; item.completedAt = timestamp(); audit(context, 'rollout.rollback', 'update-rollout', item.id, { results }); changed(context); return item; });
  app.post('/api/v2/update-rollouts/:id/cancel', async (request) => { const item = required(store.state.v2.updateRollouts, (request.params as { id: string }).id, 'Update rollout'); item.state = 'failed'; item.completedAt = timestamp(); audit(context, 'rollout.cancel', 'update-rollout', item.id); changed(context); return item; });

  function hasActiveDeviceWork(deviceId: string): boolean {
    const device = store.state.devices.find((item) => item.id === deviceId);
    if (device?.activeJobIds.length || device?.activeSessionIds.length) return true;
    if (store.state.jobs.some((job) => job.deviceId === deviceId && ['queued', 'dispatching', 'running', 'awaiting-approval'].includes(job.status))) return true;
    if (store.state.sessions.some((session) => session.deviceId === deviceId && !['stopped', 'error'].includes(session.status))) return true;
    if (store.state.terminals.some((terminal) => terminal.deviceId === deviceId && ['starting', 'open'].includes(terminal.status))) return true;
    if (store.state.v2.transfers.some((transfer) => artifactTransferDeviceIds(transfer, store.state.v2.storageConnections).includes(deviceId) && ['pending', 'queued', 'running', 'verifying', 'awaiting-approval'].includes(transfer.status))) return true;
    if (store.state.v2.desktopSessions.some((session) => session.deviceId === deviceId && ['starting', 'ready'].includes(session.status))) return true;
    if (store.state.v2.updateRollouts.some((rollout) => rollout.state === 'running' && (rollout.deviceIds.includes(deviceId) || Object.entries(rollout.results).some(([targetId, result]) => targetId === deviceId && ['pending', 'queued', 'running', 'awaiting-approval'].includes(result.state))))) return true;
    return store.state.v2.pipelineRuns.some((run) => {
      if (!['queued', 'running', 'awaiting-approval'].includes(run.state)) return false;
      const pipeline = store.state.v2.pipelines.find((item) => item.id === run.pipelineId);
      return run.nodeRuns.some((nodeRun) => {
        if (!['pending', 'queued', 'running', 'awaiting-approval'].includes(nodeRun.state)) return false;
        if (nodeRun.deviceId === deviceId) return true;
        if (nodeRun.jobId && store.state.jobs.find((job) => job.id === nodeRun.jobId)?.deviceId === deviceId) return true;
        const node = pipeline?.nodes.find((item) => item.id === nodeRun.nodeId);
        return Boolean(node?.preferredDeviceIds.includes(deviceId) || node?.config.deviceId === deviceId);
      });
    });
  }

  function idlePowerPolicy(profile: ManagedDeviceProfile): { action: 'shutdown' | 'sleep'; delayMs: number } | undefined {
    const shutdownMinutes = profile.powerPolicy.shutdownAfterIdleMinutes;
    if (shutdownMinutes !== undefined && Number.isFinite(shutdownMinutes) && shutdownMinutes > 0) return { action: 'shutdown', delayMs: shutdownMinutes * 60_000 };
    const sleepMinutes = profile.powerPolicy.sleepAfterIdleMinutes;
    if (sleepMinutes !== undefined && Number.isFinite(sleepMinutes) && sleepMinutes > 0) return { action: 'sleep', delayMs: sleepMinutes * 60_000 };
    return undefined;
  }

  let lifecycleTickRunning = false;
  async function runPowerLifecycle(): Promise<void> {
    if (lifecycleTickRunning) return;
    lifecycleTickRunning = true;
    try {
      for (const deviceId of [...idleShutdownEligible]) {
        const device = store.state.devices.find((item) => item.id === deviceId);
        const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === deviceId);
        const policy = profile ? idlePowerPolicy(profile) : undefined;
        if (!device || !profile || !policy) { idleShutdownEligible.delete(deviceId); idleSince.delete(deviceId); continue; }
        if (!context.isOnline(deviceId)) { idleSince.delete(deviceId); continue; }
        // Maintenance and quiet hours are operator-controlled states: automatic power actions must never interrupt them.
        if (maintenanceActive(profile) || quietHoursActive(profile) || hasActiveDeviceWork(deviceId)) { idleSince.delete(deviceId); continue; }
        const started = idleSince.get(deviceId);
        if (!started) { idleSince.set(deviceId, Date.now()); continue; }
        if (Date.now() - started < policy.delayMs) continue;
        const previous = shutdownRequests.get(deviceId);
        if (previous && Date.now() - previous < 300_000) continue;
        shutdownRequests.set(deviceId, Date.now());
        try {
          enforceInternalPolicy('devices.power', 'power-lifecycle', { resourceType: 'device', resourceId: deviceId, deviceId });
          await context.dispatch(deviceId, { type: 'device.power', payload: { action: policy.action, force: false } }, 30_000);
          idleShutdownEligible.delete(deviceId); idleSince.delete(deviceId);
          appendAudit(store, { actorType: 'system', actorId: 'power-lifecycle', action: `device.power.idle-${policy.action}`, resourceType: 'device', resourceId: deviceId, outcome: 'success', detail: { idleMinutes: policy.delayMs / 60_000 } });
          context.activity({ type: 'device', severity: 'info', title: policy.action === 'shutdown' ? 'Idle shutdown requested' : 'Idle sleep requested', detail: `${device.name} completed its work and remained idle for ${policy.delayMs / 60_000} minute(s).`, deviceId });
          changed(context);
        } catch (error) {
          const policyStatus = (error as { statusCode?: number }).statusCode;
          if (policyStatus === 403 || policyStatus === 409) { idleShutdownEligible.delete(deviceId); idleSince.delete(deviceId); shutdownRequests.delete(deviceId); context.activity({ type: 'security', severity: 'warning', title: 'Idle power action blocked', detail: error instanceof Error ? error.message : String(error), deviceId }); changed(context); continue; }
          shutdownRequests.delete(deviceId); idleSince.set(deviceId, Date.now());
          appendAudit(store, { actorType: 'system', actorId: 'power-lifecycle', action: `device.power.idle-${policy.action}`, resourceType: 'device', resourceId: deviceId, outcome: 'failed', detail: { error: error instanceof Error ? error.message : String(error) } });
          store.markDirty();
        }
      }
    } finally { lifecycleTickRunning = false; }
  }

  for (const pipeline of store.state.v2.pipelines) schedulePipelineTriggers(pipeline);
  const stuckJobTimer = setInterval(() => { for (const job of store.state.jobs) { if (job.status === 'running' && job.startedAt) evaluateEvent('job-stuck', { deviceId: job.deviceId, jobId: job.id, identity: job.id, actual: Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1_000), detail: `${job.name} has been running longer than its alert threshold.` }); } }, 15_000); stuckJobTimer.unref(); pipelineTimers.add(stuckJobTimer);
  const powerLifecycleTimer = setInterval(() => void runPowerLifecycle(), 1_000); powerLifecycleTimer.unref(); pipelineTimers.add(powerLifecycleTimer);
  registerFleetMcp(app, context, { authenticateApiToken, startTransfer: runTransfer });

  return { recordTelemetry, evaluateDeviceAlerts, recordAlertEvent: evaluateEvent, handleJobUpdate(job) { if (job.status === 'failed') evaluateEvent('job-failure', { deviceId: job.deviceId, jobId: job.id, identity: job.id, actual: 1, detail: `${job.name} failed${job.error ? `: ${job.error}` : '.'}` }); if (['completed', 'failed', 'cancelled'].includes(job.status)) { evaluateEvent('job-stuck', { deviceId: job.deviceId, jobId: job.id, identity: job.id, actual: 0, active: false }); if (job.deviceId && job.startedAt && store.state.v2.deviceProfiles.find((profile) => profile.deviceId === job.deviceId && idlePowerPolicy(profile))) { idleShutdownEligible.add(job.deviceId); idleSince.delete(job.deviceId); } } void emitFleetEvent(`job.${job.status}`, job); for (const team of store.state.v2.agentTeams.filter((item) => item.tasks.some((task) => task.sessionId === job.id))) void advanceTeam(team); }, authenticateDeviceCredential, authenticateApiToken, selectDevice(input) { return schedule(applicablePolicy(input.projectId), input); }, authorizeJobTarget(job) { enforceInternalPolicy('jobs.execute', 'fleet-scheduler', { resourceType: 'job', resourceId: job.id, projectId: job.projectId, deviceId: job.deviceId }); }, wakeForJob, stop() { for (const timer of pipelineTimers) clearTimeout(timer); pipelineTimers.clear(); } };
}
