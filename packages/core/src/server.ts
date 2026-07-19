import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type {
  ActivityEvent,
  AuditRecord,
  AgentRegistration,
  AgentToCoreMessage,
  AdvancedCodexSession,
  CodexActor,
  CodexEvent,
  CodexParticipant,
  CodexParticipantPermission,
  ClientEvent,
  CodexSessionLineageOperation,
  CodexSession,
  CoreToAgentCommand,
  Device,
  DevicePowerAction,
  DeviceRole,
  FleetDeviceMention,
  FleetConductorPlan,
  FleetJob,
  FleetProject,
  FleetSettings,
  FleetSystemConversation,
  FleetSystemMessage,
  FleetSystemPendingAction,
  FleetSystemReference,
  PermissionMode,
  ProjectPreview,
  TerminalSession,
} from '@fleet/shared';
import type { WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { applyCodexMessage } from './codex-events.js';
import { buildConductorPlan } from './conductor-plan.js';
import { fleetCodexDeveloperInstructions, fleetCodexTurnContext } from './codex-fleet-context.js';
import { contextualCodexSessionTitleFromEvents, isGenericCodexSessionTitle } from './codex-session-title.js';
import { CORE_CODEX_UI_RPC_METHODS } from './codex-ui-rpc.js';
import { preferredDeviceAlias, resolveDeviceMentions } from './device-mentions.js';
import { deriveDevicePresence, tailscalePeerStateForDevice, type TailscalePresencePeer } from './device-presence.js';
import { CORE_RESTART_SESSION_RECOVERY_ERROR, FleetStore } from './store.js';
import { LatestUpdateCoalescer } from './latest-update-coalescer.js';
import { registerV2Routes, type V2Runtime } from './v2/routes.js';
import { appendAudit, evaluateFleetPolicies } from './v2/security.js';
import { artifactLocationDeviceIds, artifactTransferDeviceIds } from './v2/storage.js';

const VERSION = '2.0.0';
const DEFAULT_PORT = 4780;
const REQUEST_TIMEOUT_MS = 15_000;
const CODEX_HANDOFF_CHUNK_BYTES = 512 * 1024;
const MAX_CODEX_HANDOFF_BYTES = 256 * 1024 * 1024;
const CODEX_STREAM_BROADCAST_INTERVAL_MS = 60;
const MAX_CLIENT_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;
const AGENT_DISCONNECT_SESSION_RECOVERY_ERROR = 'Execution Agent disconnected; waiting to recover the Codex session.';
const RECENT_CODEX_EXIT_WINDOW_MS = 10_000;
const execFileAsync = promisify(execFile);

interface TailscaleStatusNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
}

export interface FleetCoreOptions {
  host?: string;
  port?: number;
  token?: string;
  dataDir?: string;
  filePath?: string;
  coreUrl?: string;
  logger?: boolean;
  listen?: boolean;
  /** Development/test-only escape hatch. Never enable behind a reverse proxy. */
  allowUnauthenticatedLoopback?: boolean;
  /** Documentation-only synthetic transcript. Use only with isolated temporary state. */
  readmeDemo?: boolean;
  allowedOrigins?: string[];
}

export interface FleetCore {
  app: FastifyInstance;
  store: FleetStore;
  host: string;
  port: number;
  url: string;
  recoveryTokenPath?: string;
  close(): Promise<void>;
  stop(): Promise<void>;
}

interface PendingDispatch {
  deviceId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface CreateCodexSessionOptions {
  kind?: CodexSession['kind'];
  developerInstructions?: string;
}

const roleSchema = z.enum(['core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown']);
const permissionSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
const approvalSchema = z.enum(['untrusted', 'on-request', 'never']);
const identifierSchema = z.string().min(1).max(256);
const codexUiRpcMethodSchema = z.enum(CORE_CODEX_UI_RPC_METHODS);

const workspaceEntrySchema = z.object({
  name: z.string().min(1).max(1_024),
  path: z.string().min(1).max(4_096),
  type: z.enum(['directory', 'file', 'symlink', 'other']),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.string().datetime(),
});

const workspacePageSchema = z.object({
  path: z.string().min(1).max(4_096),
  entries: z.array(workspaceEntrySchema).max(500),
  nextCursor: z.string().regex(/^\d+$/).optional(),
  total: z.number().int().nonnegative(),
});

const registrationSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(160),
  hostname: z.string().min(1).max(255),
  role: roleSchema,
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  osName: z.string().max(160),
  osVersion: z.string().max(160),
  agentVersion: z.string().max(64),
  protocolVersion: z.number().int().min(1).max(100),
  capabilities: z.object({
    codex: z.boolean(), git: z.boolean(), docker: z.boolean(), tailscale: z.boolean(), cuda: z.boolean(), mlx: z.boolean(), node: z.boolean(), wakeOnLan: z.boolean(),
    shell: z.string().max(1_024), labels: z.array(z.string().max(128)).max(256),
  }).passthrough(),
  projectRoots: z.array(z.string().max(4_096)).max(128),
  metrics: z.object({ sampledAt: z.string() }).passthrough(),
}).passthrough();

const projectBodySchema = z.object({
  workspaceId: identifierSchema.optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4_000).default(''),
  repository: z.string().max(2_048).optional(),
  defaultBranch: z.string().min(1).max(256).default('main'),
  paths: z.array(z.object({ deviceId: identifierSchema, path: z.string().min(1).max(4_096) })).max(256).default([]),
  preferredDeviceIds: z.array(identifierSchema).max(256).default([]),
  commands: z.object({ build: z.string().max(4_096).optional(), test: z.string().max(4_096).optional(), start: z.string().max(4_096).optional() }).default({}),
  artifactPaths: z.array(z.string().max(4_096)).max(256).default([]),
});

const previewStartBodySchema = z.object({
  deviceId: identifierSchema.optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  visibility: z.enum(['tailnet', 'public']).default('tailnet'),
  confirmPublic: z.boolean().optional(),
  autoStartWithCodex: z.boolean().default(true),
  stopAfterMinutes: z.number().int().min(5).max(10_080).optional(),
}).superRefine((value, context) => {
  if (value.visibility === 'public' && value.confirmPublic !== true) {
    context.addIssue({ code: 'custom', message: 'Public previews require explicit confirmation.', path: ['confirmPublic'] });
  }
});

const codexClientSchema = z.object({
  clientId: identifierSchema,
  name: z.string().trim().min(1).max(160),
  deviceName: z.string().trim().min(1).max(160),
});

const codexPresenceSchema = codexClientSchema.extend({
  typing: z.boolean().default(false),
});

const jobBodySchema = z.object({
  name: z.string().trim().min(1).max(240),
  kind: z.enum(['codex', 'shell']),
  prompt: z.string().max(250_000).optional(),
  command: z.string().max(65_536).optional(),
  projectId: identifierSchema.optional(),
  deviceId: identifierSchema.optional(),
  cwd: z.string().max(4_096).optional(),
  permissionMode: permissionSchema.default('workspace-write'),
  approvalPolicy: approvalSchema.default('on-request'),
  requiredLabels: z.array(z.string().max(128)).max(128).default([]),
}).superRefine((value, context) => {
  if (value.kind === 'codex' && !value.prompt?.trim()) context.addIssue({ code: 'custom', message: 'Codex jobs require instructions.', path: ['prompt'] });
  if (value.kind === 'shell' && !(value.command?.trim() || value.prompt?.trim())) context.addIssue({ code: 'custom', message: 'Shell jobs require a command.', path: ['command'] });
});

const terminalBodySchema = z.object({
  deviceId: identifierSchema,
  cwd: z.string().max(4_096).default(''),
  cols: z.number().int().min(2).max(1_000).default(100),
  rows: z.number().int().min(2).max(1_000).default(32),
});

const optionalCodexModelSchema = z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  z.string().trim().min(1).max(240).optional(),
);

const sessionBodySchema = z.object({
  deviceId: identifierSchema,
  projectId: identifierSchema.optional(),
  cwd: z.string().max(4_096).default(''),
  title: z.string().trim().min(1).max(240).default('Codex session'),
  model: optionalCodexModelSchema,
  permissionMode: permissionSchema.default('workspace-write'),
  approvalPolicy: approvalSchema.default('on-request'),
});

const sessionPermissionBodySchema = z.object({
  permissionMode: permissionSchema,
  client: codexClientSchema.optional(),
});

const sessionForkBodySchema = z.object({
  deviceId: identifierSchema.optional(),
  cwd: z.string().max(4_096).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  lastTurnId: identifierSchema.optional(),
});

const sessionMoveBodySchema = z.object({
  deviceId: identifierSchema,
  cwd: z.string().max(4_096).optional(),
});

const systemMessageBodySchema = z.object({
  text: z.string().trim().min(1).max(250_000),
  mode: z.enum(['chat', 'conductor']).default('chat'),
  client: codexClientSchema.optional(),
});

const systemConversationActionSchema = z.object({
  client: codexClientSchema.optional(),
});

const systemPowerConfirmationSchema = z.object({
  deviceIds: z.array(identifierSchema).min(1).max(500),
  action: z.enum(['wake', 'sleep', 'restart', 'shutdown', 'lock', 'logout']),
  client: codexClientSchema.optional(),
});

function seedReadmeDemoConversation(conversation: FleetSystemConversation): void {
  const now = Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const mention: FleetDeviceMention = {
    token: '@demo-gpu', alias: 'demo-gpu', deviceIds: ['sim-demo-node-001'], label: 'Demo GPU Node', status: 'resolved',
  };
  conversation.title = 'Orchestra System';
  conversation.messages = [
    {
      id: randomUUID(), at: at(-12_000), role: 'assistant',
      text: 'Orchestra System is ready. Mention a synthetic device such as @demo-gpu or @demo-node-2 to inspect it, manage it, or open a demonstration Codex view.',
      mentions: [], references: [],
    },
    {
      id: randomUUID(), at: at(-6_000), role: 'user', text: 'temperatures on @demo-gpu',
      actor: { clientId: 'demo-operator', name: 'Demo Operator', deviceName: 'Demo Client' },
      mentions: [mention], references: [],
    },
    {
      id: randomUUID(), at: at(-2_000), role: 'assistant',
      text: '@demo-gpu temperatures:\n\n- CPU: 24°C\n- Demo GPU: 38°C\n\nBoth are running cool. This is synthetic telemetry generated for documentation.',
      mentions: [mention],
      references: [{
        id: 'demo-gpu-reference', kind: 'device', label: 'Demo GPU Node',
        detail: 'Operational · gpu · synthetic device', status: 'online', deviceId: 'sim-demo-node-001',
      }],
    },
  ];
  conversation.pendingActions = [];
  conversation.conductorPlans = [];
  conversation.updatedAt = at(0);
}

export async function startFleetCore(options: FleetCoreOptions = {}): Promise<FleetCore> {
  const host = options.host ?? process.env.FLEET_HOST ?? '127.0.0.1';
  const port = options.port ?? integer(process.env.FLEET_PORT) ?? DEFAULT_PORT;
  const dataDir = path.resolve(options.dataDir ?? process.env.FLEET_DATA_DIR ?? defaultDataDirectory());
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configuredToken = options.token ?? process.env.FLEET_TOKEN;
  if (!isLoopbackHost(host) && !configuredToken) throw new Error('FLEET_TOKEN is required when Fleet Core listens beyond loopback.');
  if (!isLoopbackHost(host) && configuredToken && Buffer.byteLength(configuredToken, 'utf8') < 32) {
    throw new Error('FLEET_TOKEN must contain at least 32 bytes when Fleet Core listens beyond loopback.');
  }
  if (!isLoopbackHost(host)) {
    const configuredMasterKey = process.env.FLEET_MASTER_KEY ?? process.env.FLEET_VAULT_KEY;
    if (!configuredMasterKey) throw new Error('FLEET_MASTER_KEY is required when Fleet Core listens beyond loopback.');
    if (!isBase64Key(configuredMasterKey, 32)) throw new Error('FLEET_MASTER_KEY must be a base64-encoded 32-byte key.');
  }
  const localCredential = configuredToken ? { token: configuredToken, path: undefined } : await loadOrCreateLocalRecoveryToken(dataDir);
  const token = localCredential.token;
  // Authentication is never disabled implicitly. `listen: false` is also used
  // by embedders that may call `app.listen()` themselves after registration,
  // so treating it as a test-mode signal could accidentally expose an
  // unauthenticated control plane.
  const allowUnauthenticatedLoopback = options.allowUnauthenticatedLoopback ?? false;
  const advertisedHost = isLoopbackHost(host) ? '127.0.0.1' : host;
  const coreUrl = (options.coreUrl ?? process.env.FLEET_PUBLIC_URL ?? `http://${advertisedHost}:${port}`).replace(/\/+$/, '');
  let parsedCoreUrl: URL; try { parsedCoreUrl = new URL(coreUrl); } catch { throw new Error('Fleet Core public URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsedCoreUrl.protocol)) throw new Error('Fleet Core public URL must use HTTP or HTTPS.');
  const store = await FleetStore.open({ filePath: options.filePath ?? path.join(dataDir, 'fleet-state.json'), coreUrl });
  store.state.settings.coreUrl = coreUrl;
  if (options.readmeDemo) seedReadmeDemoConversation(store.state.systemConversation);
  backfillCodexSessionTitles(store);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  const agentSockets = new Map<string, WebSocket>();
  const clientSockets = new Set<WebSocket>();
  const pending = new Map<string, PendingDispatch>();
  const codexRecoveries = new Map<string, Promise<void>>();
  const codexOperationQueues = new Map<string, Promise<void>>();
  const codexApprovalClaims = new Set<string>();
  const recentCodexExits = new Map<string, { deviceId: string; at: number }>();
  const codexUpdateCoalescer = new LatestUpdateCoalescer(CODEX_STREAM_BROADCAST_INTERVAL_MS);
  const previewStarts = new Map<string, Promise<ProjectPreview>>();
  const agentSourceIps = new Map<string, string>();
  let tailscalePresencePeers: TailscalePresencePeer[] = [];
  let tailscalePresenceCheckedAt: string | undefined;
  let tailscalePresenceRefresh: Promise<void> | undefined;
  const jobEnvironments = new Map<string, Record<string, string>>();
  const enrollmentAttempts = new Map<string, { count: number; resetAt: number }>();
  let v2Runtime: V2Runtime | undefined;
  const requestActor = new AsyncLocalStorage<Pick<AuditRecord, 'actorType' | 'actorId' | 'sourceIp'>>();
  let closed = false;

  const configuredOrigins = new Set([
    ...(options.allowedOrigins ?? []),
    ...(process.env.FLEET_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  ]);
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || isLoopbackOrigin(origin) || configuredOrigins.has(origin)) callback(null, true);
      else callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false } });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url.split('?')[0] === '/api/v2/enrollment/exchange') {
      const now = Date.now(); let attempt = enrollmentAttempts.get(request.ip); if (!attempt || attempt.resetAt <= now) { attempt = { count: 0, resetAt: now + 60_000 }; enrollmentAttempts.set(request.ip, attempt); }
      attempt.count += 1; if (enrollmentAttempts.size > 10_000) for (const [ip, value] of enrollmentAttempts) if (value.resetAt <= now) enrollmentAttempts.delete(ip);
      if (attempt.count > 10) { appendAudit(store, { actorType: 'system', actorId: 'enrollment-rate-limiter', action: 'enrollment.exchange', resourceType: 'source-ip', outcome: 'denied', sourceIp: request.ip, detail: { reason: 'rate-limit' } }); v2Runtime?.recordAlertEvent('authentication', { identity: request.ip, actual: 1, detail: 'Enrollment exchange rate limit exceeded.' }); return reply.code(429).header('retry-after', String(Math.ceil((attempt.resetAt - now) / 1_000))).send({ error: 'Too many enrollment attempts.' }); }
      return;
    }
    if (allowUnauthenticatedLoopback && isLoopbackAddress(request.ip)) return;
    const supplied = suppliedToken(request); const apiToken = supplied ? v2Runtime?.authenticateApiToken(supplied) : undefined;
    if (!authorized(request, token) && !(apiToken && apiScopeAllowed(apiToken.scopes, request.method, request.url))) {
      const reason = apiToken ? 'API token scope denied.' : 'Missing or invalid Fleet credential.';
      appendAudit(store, { actorType: 'system', actorId: 'authentication-gateway', action: 'authentication.denied', resourceType: 'http-request', outcome: 'denied', sourceIp: request.ip, detail: { method: request.method, path: request.url.split('?')[0], reason } });
      v2Runtime?.recordAlertEvent('authentication', { identity: request.ip, actual: 1, detail: reason });
      return reply.code(apiToken ? 403 : 401).send({ error: apiToken ? 'API token scope does not allow this request.' : 'Fleet authentication required.' });
    }
  });

  app.addHook('onRequest', (request, _reply, done) => {
    const supplied = suppliedToken(request);
    const apiToken = supplied ? v2Runtime?.authenticateApiToken(supplied) : undefined;
    const identity: Pick<AuditRecord, 'actorType' | 'actorId' | 'sourceIp'> = apiToken
      ? { actorType: 'api', actorId: apiToken.id, sourceIp: request.ip }
      : { actorType: 'user', actorId: authorized(request, token) ? 'recovery-admin' : 'local-operator', sourceIp: request.ip };
    requestActor.run(identity, done);
  });

  app.addHook('preHandler', async (request, reply) => {
    const policyAction = policyActionForRequest(request.method, request.url.split('?')[0] ?? request.url);
    if (!policyAction || (request.url.startsWith('/api/v2/policies') && authorized(request, token))) return;
    // Actor identity is derived from the authenticated transport. Client
    // headers are never trusted to select a policy identity; MCP tools apply
    // their own `mcp` context inside the authenticated /mcp transport.
    const identity = requestActor.getStore() ?? { actorType: 'system' as const, actorId: 'authentication-context', sourceIp: request.ip };
    const { actorType, actorId } = identity;
    const evaluations = policyResourceContexts(store, request, policyAction.resourceType).map((details) => ({
      details,
      decision: evaluateFleetPolicies(store.state.v2.policies, {
        action: policyAction.action, actorType, actorId, method: request.method, sourceIp: request.ip,
        projectId: details.projectId, deviceId: details.deviceId, deviceGroupIds: details.deviceGroupIds,
        workspaceId: details.workspaceId, environment: details.environment, dataClassification: details.dataClassification,
      }),
    }));
    const blocked = evaluations.find(({ decision }) => decision.effect === 'deny') ?? evaluations.find(({ decision }) => decision.effect === 'require-approval');
    if (!blocked) return;
    const { details, decision } = blocked;
    appendAudit(store, { actorType, actorId, action: policyAction.action, resourceType: policyAction.resourceType, resourceId: details.resourceId, outcome: 'denied', sourceIp: request.ip, detail: { policyId: decision.policy?.id, effect: decision.effect } });
    const message = decision.effect === 'require-approval'
      ? `Policy ${decision.policy?.name ?? 'rule'} requires approval for ${policyAction.action}.`
      : `Policy ${decision.policy?.name ?? 'rule'} denies ${policyAction.action}.`;
    return reply.code(decision.effect === 'require-approval' ? 409 : 403).send({ error: message, policyId: decision.policy?.id, approvalRequired: decision.effect === 'require-approval' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') });
      return;
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (statusCode >= 500) app.log.error(error);
    void reply.code(statusCode).send({ error: error instanceof Error && error.message ? error.message : 'Fleet Core request failed.' });
  });

  function broadcast(event: ClientEvent): void {
    const frame = JSON.stringify(event);
    for (const socket of clientSockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > MAX_CLIENT_SOCKET_BUFFER_BYTES) {
        socket.close(1013, 'Fleet client fell behind live updates');
        continue;
      }
      socket.send(frame);
    }
  }

  function activity(input: Omit<ActivityEvent, 'id' | 'at'>): ActivityEvent {
    const event = store.activity(input);
    broadcast({ type: 'activity.created', payload: event });
    return event;
  }

  function dispatch(deviceId: string, command: Omit<CoreToAgentCommand, 'requestId'>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const socket = agentSockets.get(deviceId);
    if (!socket || socket.readyState !== socket.OPEN) throw httpError(409, `Device is offline: ${deviceId}`);
    const requestId = randomUUID();
    const message = { ...command, requestId } as CoreToAgentCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(httpError(504, `Device did not acknowledge ${command.type}.`));
      }, timeoutMs);
      timer.unref();
      pending.set(requestId, { deviceId, resolve, reject, timer });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(requestId);
        reject(httpError(502, error.message));
      });
    });
  }

  function disconnectDevice(deviceId: string, reason: string): void {
    const socket = agentSockets.get(deviceId);
    if (socket) socket.close(1008, reason.slice(0, 120));
  }

  function updateDeviceStatus(device: Device): void {
    if (device.status === 'offline' || device.status === 'degraded') return;
    device.status = device.activeJobIds.length || device.activeSessionIds.length ? 'busy' : 'online';
  }

  function updateDevicePresence(device: Device, notify = false): boolean {
    const previousFingerprint = presenceFingerprint(device.presence);
    device.presence = deriveDevicePresence(device, {
      agentConnected: agentSockets.has(device.id),
      sourceIp: agentSourceIps.get(device.id),
      tailscaleOnline: tailscalePeerStateForDevice(device, tailscalePresencePeers),
      tailscaleCheckedAt: tailscalePresenceCheckedAt,
      offlineAfterMs: store.state.settings.offlineAfterMs,
    });
    const changed = previousFingerprint !== presenceFingerprint(device.presence);
    if (changed) store.markDirty();
    if (changed && notify) broadcast({ type: 'device.updated', payload: device });
    return changed;
  }

  async function refreshTailscalePresence(): Promise<void> {
    if (tailscalePresenceRefresh) return tailscalePresenceRefresh;
    tailscalePresenceRefresh = (async () => {
      try {
        const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
        });
        const document = JSON.parse(stdout) as {
          Self?: TailscaleStatusNode;
          Peer?: Record<string, TailscaleStatusNode>;
        };
        tailscalePresencePeers = [document.Self, ...Object.values(document.Peer ?? {})]
          .filter((peer): peer is TailscaleStatusNode => Boolean(peer))
          .map((peer) => ({
            hostname: peer.HostName,
            dnsName: peer.DNSName,
            ips: peer.TailscaleIPs ?? [],
            online: peer.Online !== false,
          }));
        tailscalePresenceCheckedAt = new Date().toISOString();
        for (const device of store.state.devices) updateDevicePresence(device, true);
      } catch {
        // Preserve the last successful peer evidence. If Core has never read
        // Tailscale status, the UI truthfully reports that layer as unknown.
      }
    })().finally(() => { tailscalePresenceRefresh = undefined; });
    return tailscalePresenceRefresh;
  }

  function broadcastProject(project: FleetProject): void {
    project.updatedAt = new Date().toISOString();
    store.markDirty();
    broadcast({ type: 'project.updated', payload: project });
  }

  async function enqueueCodexOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = codexOperationQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    codexOperationQueues.set(sessionId, tail);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (codexOperationQueues.get(sessionId) === tail) codexOperationQueues.delete(sessionId);
    }
  }

  function participant(session: CodexSession, actor: z.infer<typeof codexClientSchema> | undefined): CodexParticipant | undefined {
    if (!actor) return undefined;
    session.participants ??= [];
    const now = new Date().toISOString();
    let item = session.participants.find((candidate) => candidate.clientId === actor.clientId);
    if (!item) {
      item = {
        ...actor,
        permissions: ['view', 'message', 'approve', 'interrupt', 'control'],
        typing: false,
        connectedAt: now,
        lastSeenAt: now,
      };
      session.participants.push(item);
    } else {
      item.name = actor.name;
      item.deviceName = actor.deviceName;
      item.lastSeenAt = now;
    }
    ensureSessionController(session);
    return item;
  }

  function ensureSessionController(session: CodexSession): void {
    session.participants ??= [];
    const active = session.participants.filter((item) => Date.now() - new Date(item.lastSeenAt).getTime() < 45_000);
    const controller = active.find((item) => item.clientId === session.controllerClientId && item.permissions.includes('control'));
    if (controller) return;
    const next = active.find((item) => item.permissions.includes('control'));
    session.controllerClientId = next?.clientId;
    session.controllerUpdatedAt = next ? new Date().toISOString() : undefined;
  }

  function requireParticipantPermission(item: CodexParticipant | undefined, permission: CodexParticipantPermission): void {
    if (item && !item.permissions.includes(permission)) throw httpError(403, `This participant cannot ${permission} in this Codex session.`);
  }

  function actorValue(item: CodexParticipant | undefined): CodexActor | undefined {
    return item ? { clientId: item.clientId, name: item.name, deviceName: item.deviceName } : undefined;
  }

  function projectPreviewDevice(project: FleetProject, requestedDeviceId?: string): Device {
    const candidates = store.state.devices
      .filter((device) => !requestedDeviceId || device.id === requestedDeviceId)
      .filter((device) => project.paths.some((mapping) => mapping.deviceId === device.id))
      .filter((device) => agentSockets.has(device.id) && device.status !== 'offline' && device.status !== 'degraded')
      .filter((device) => device.capabilities.labels.includes('feature:shared-preview'))
      .sort((left, right) => Number(project.preferredDeviceIds.includes(right.id)) - Number(project.preferredDeviceIds.includes(left.id))
        || left.activeJobIds.length + left.activeSessionIds.length - right.activeJobIds.length - right.activeSessionIds.length);
    const device = candidates[0];
    if (!device) throw httpError(409, requestedDeviceId
      ? 'The selected device is not online with this project mapped and shared-preview support enabled.'
      : 'No online project device supports shared previews.');
    return device;
  }

  function previewServePort(project: FleetProject, deviceId: string, visibility: ProjectPreview['visibility']): number {
    if (project.preview?.deviceId === deviceId && project.preview.visibility === visibility) return project.preview.servePort;
    if (visibility === 'public') {
      const allowed = [8443, 10_000, 443];
      const available = allowed.find((port) => !store.state.projects.some((candidate) => candidate.id !== project.id && candidate.preview?.deviceId === deviceId && candidate.preview.status !== 'stopped' && candidate.preview.servePort === port));
      if (!available) throw httpError(409, 'This device already uses every Tailscale Funnel port supported by Fleet.');
      return available;
    }
    let port = 20_000 + stableHash(project.id) % 40_000;
    while (store.state.projects.some((candidate) => candidate.id !== project.id && candidate.preview?.deviceId === deviceId && candidate.preview.status !== 'stopped' && candidate.preview.servePort === port)) {
      port = port >= 59_999 ? 20_000 : port + 1;
    }
    return port;
  }

  async function startProjectPreview(project: FleetProject, input: z.infer<typeof previewStartBodySchema>): Promise<ProjectPreview> {
    const existingStart = previewStarts.get(project.id);
    if (existingStart) return existingStart;
    const operation = (async () => {
      const device = projectPreviewDevice(project, input.deviceId ?? project.preview?.deviceId);
      const cwd = project.paths.find((mapping) => mapping.deviceId === device.id)?.path;
      if (!cwd) throw httpError(409, `${device.name} has no path mapping for ${project.name}.`);
      if (project.preview && project.preview.deviceId !== device.id && ['starting', 'running', 'restarting'].includes(project.preview.status) && agentSockets.has(project.preview.deviceId)) {
        try { await dispatch(project.preview.deviceId, { type: 'preview.stop', payload: { projectId: project.id } }, 30_000); }
        catch { /* The destination launch remains authoritative. */ }
      }
      const now = new Date().toISOString();
      const pendingPreview: ProjectPreview = {
        projectId: project.id,
        deviceId: device.id,
        cwd,
        status: 'starting',
        visibility: input.visibility,
        framework: project.preview?.framework ?? 'Detecting',
        command: project.commands.start ?? 'Auto-detect',
        port: input.port ?? project.preview?.port ?? 0,
        servePort: previewServePort(project, device.id, input.visibility),
        desiredState: 'running',
        autoStartWithCodex: input.autoStartWithCodex,
        stopAfterMinutes: input.stopAfterMinutes,
        restartCount: project.preview?.restartCount ?? 0,
        updatedAt: now,
        lastActivityAt: now,
        health: {
          state: 'starting',
          checkedAt: now,
          consecutiveFailures: 0,
          detail: 'Waiting for the preview host to report HTTP health.',
        },
        logs: project.preview?.logs ?? [],
      };
      project.preview = pendingPreview;
      broadcastProject(project);
      try {
        const result = await dispatch(device.id, {
          type: 'preview.start',
          payload: {
            projectId: project.id,
            projectName: project.name,
            cwd,
            configuredCommand: project.commands.start,
            port: input.port,
            servePort: pendingPreview.servePort,
            visibility: input.visibility,
            autoStartWithCodex: input.autoStartWithCodex,
            stopAfterMinutes: input.stopAfterMinutes,
          },
        }, 90_000) as ProjectPreview;
        project.preview = { ...pendingPreview, ...result, deviceId: device.id, desiredState: 'running' };
        broadcastProject(project);
        activity({ type: 'project', severity: 'success', title: input.visibility === 'public' ? 'Public preview available' : 'Shared preview available', detail: `${project.name} is hosted by ${device.name} at ${result.url}.`, deviceId: device.id, entityId: project.id });
        return project.preview;
      } catch (error) {
        pendingPreview.status = 'error';
        pendingPreview.error = error instanceof Error ? error.message : String(error);
        pendingPreview.updatedAt = new Date().toISOString();
        broadcastProject(project);
        throw error;
      }
    })();
    previewStarts.set(project.id, operation);
    try { return await operation; }
    finally {
      if (previewStarts.get(project.id) === operation) previewStarts.delete(project.id);
    }
  }

  async function stopProjectPreview(project: FleetProject, reason = 'operator'): Promise<ProjectPreview | undefined> {
    const preview = project.preview;
    if (!preview) return undefined;
    if (agentSockets.has(preview.deviceId) && preview.status !== 'stopped') {
      try { project.preview = await dispatch(preview.deviceId, { type: 'preview.stop', payload: { projectId: project.id } }, 45_000) as ProjectPreview; }
      catch (error) {
        preview.status = 'stopped';
        preview.error = error instanceof Error ? error.message : String(error);
      }
    } else preview.status = 'stopped';
    const stoppedPreview = project.preview ?? preview;
    stoppedPreview.desiredState = 'stopped';
    stoppedPreview.health = {
      state: 'unknown',
      checkedAt: new Date().toISOString(),
      consecutiveFailures: 0,
      detail: 'Preview was stopped by policy or an operator.',
    };
    stoppedPreview.updatedAt = new Date().toISOString();
    project.preview = stoppedPreview;
    broadcastProject(project);
    activity({ type: 'project', severity: 'info', title: 'Shared preview stopped', detail: `${project.name} preview stopped${reason === 'inactivity' ? ' after inactivity' : ''}.`, deviceId: preview.deviceId, entityId: project.id });
    return project.preview;
  }

  function markDevicePreviewsOffline(deviceId: string, reason: string): void {
    for (const project of store.state.projects) {
      const preview = project.preview;
      if (!preview || preview.deviceId !== deviceId || !['starting', 'running', 'restarting'].includes(preview.status)) continue;
      preview.status = 'offline';
      preview.error = reason;
      preview.updatedAt = new Date().toISOString();
      broadcastProject(project);
    }
  }

  async function dispatchJob(job: FleetJob): Promise<void> {
    if (!job.deviceId) job.deviceId = v2Runtime
      ? v2Runtime.selectDevice({ requiredLabels: job.requiredLabels, projectId: job.projectId, jobId: job.id }).selectedDeviceId
      : chooseDevice(job)?.id;
    if (!job.deviceId) {
      job.status = 'queued';
      job.phase = 'Waiting for a compatible online device';
      store.markDirty();
      broadcast({ type: 'job.updated', payload: job });
      v2Runtime?.handleJobUpdate(job);
      return;
    }
    const device = store.state.devices.find((item) => item.id === job.deviceId);
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === job.deviceId);
    try { v2Runtime?.authorizeJobTarget(job); }
    catch (error) {
      job.status = 'failed'; job.phase = 'Blocked by fleet policy'; job.error = error instanceof Error ? error.message : String(error); job.completedAt = new Date().toISOString();
      store.markDirty(); broadcast({ type: 'job.updated', payload: job }); v2Runtime?.handleJobUpdate(job); return;
    }
    if (profile?.quarantined || profile?.maintenanceMode) {
      job.status = profile.quarantined ? 'failed' : 'queued';
      job.phase = profile.quarantined ? 'Blocked: device quarantined' : 'Waiting for maintenance mode to end';
      job.error = profile.quarantined ? (profile.quarantineReason ?? 'Target device is quarantined by fleet policy.') : undefined;
      if (profile.quarantined) job.completedAt = new Date().toISOString();
      store.markDirty(); broadcast({ type: 'job.updated', payload: job }); v2Runtime?.handleJobUpdate(job); return;
    }
    if (!device || !agentSockets.has(device.id)) {
      job.status = 'queued';
      if (device && v2Runtime) {
        const wake = await v2Runtime.wakeForJob(device.id, job.id);
        job.phase = wake.state === 'requested' || wake.state === 'pending'
          ? `Waking target device — ${wake.detail}`
          : `Waiting for target device — ${wake.detail}`;
      } else job.phase = 'Waiting for target device';
      store.markDirty();
      broadcast({ type: 'job.updated', payload: job });
      return;
    }
    job.cwd = resolveCwd(job.cwd, job.projectId, device);
    job.status = 'dispatching';
    job.phase = 'Dispatching to agent';
    if (!device.activeJobIds.includes(job.id)) device.activeJobIds.push(job.id);
    updateDeviceStatus(device);
    store.markDirty();
    broadcast({ type: 'job.updated', payload: job });
    broadcast({ type: 'device.updated', payload: device });
    try {
      await dispatch(device.id, { type: 'job.start', payload: { job, ...(jobEnvironments.has(job.id) ? { environment: jobEnvironments.get(job.id)! } : {}) } });
      if (job.status === 'dispatching') {
        job.status = 'running';
        job.phase = 'Running';
        job.startedAt = new Date().toISOString();
      }
      store.markDirty();
      broadcast({ type: 'job.updated', payload: job });
      activity({ type: 'job', severity: 'info', title: 'Job started', detail: `${job.name} is running on ${device.name}.`, deviceId: device.id, entityId: job.id });
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.phase = 'Dispatch failed';
      job.completedAt = new Date().toISOString();
      jobEnvironments.delete(job.id);
      device.activeJobIds = device.activeJobIds.filter((id) => id !== job.id);
      updateDeviceStatus(device);
      store.markDirty();
      broadcast({ type: 'job.updated', payload: job });
      broadcast({ type: 'device.updated', payload: device });
      activity({ type: 'job', severity: 'error', title: 'Job failed to start', detail: job.error, deviceId: device.id, entityId: job.id });
    }
  }

  async function cancelFleetJob(job: FleetJob): Promise<FleetJob> {
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (job.status === 'queued' || !job.deviceId || !agentSockets.has(job.deviceId)) {
      job.status = 'cancelled';
      job.phase = 'Cancelled';
      job.completedAt = new Date().toISOString();
      jobEnvironments.delete(job.id);
      const device = job.deviceId ? store.state.devices.find((item) => item.id === job.deviceId) : undefined;
      if (device) {
        device.activeJobIds = device.activeJobIds.filter((id) => id !== job.id);
        updateDeviceStatus(device);
        broadcast({ type: 'device.updated', payload: device });
      }
      store.markDirty();
      broadcast({ type: 'job.updated', payload: job });
      v2Runtime?.handleJobUpdate(job);
      return job;
    }
    await dispatch(job.deviceId, { type: 'job.cancel', payload: { jobId: job.id } });
    return job;
  }

  function chooseDevice(job: FleetJob): Device | undefined {
    return store.state.devices
      .filter((device) => agentSockets.has(device.id) && device.status !== 'offline' && device.status !== 'degraded')
      .filter((device) => { const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === device.id); return !profile?.maintenanceMode && !profile?.quarantined; })
      .filter((device) => job.requiredLabels.every((label) => device.capabilities.labels.includes(label)))
      .filter((device) => !job.projectId || Boolean(projectPath(job.projectId, device.id)))
      .sort((a, b) => a.activeJobIds.length - b.activeJobIds.length || b.metrics.memory.totalBytes - a.metrics.memory.totalBytes)[0];
  }

  function resolveCwd(requested: string | undefined, projectId: string | undefined, device: Device): string {
    const mapped = projectId ? projectPath(projectId, device.id) : undefined;
    const cwd = requested?.trim() || mapped || device.projectRoots[0];
    if (!cwd) throw httpError(400, `No working directory is configured for ${device.name}.`);
    return cwd;
  }

  function codexTargetCwd(session: CodexSession, device: Device, requested?: string): string {
    if (session.projectId) {
      const mapped = projectPath(session.projectId, device.id);
      if (!mapped) throw httpError(409, `${device.name} has no path mapping for this session's project.`);
      // A project-backed session always resumes at the destination's registered
      // logical-project path. This prevents a source-machine path from being
      // accidentally reused on a different operating system.
      return mapped;
    }
    return resolveCwd(requested, undefined, device);
  }

  function requireCodexTarget(deviceId: string): Device {
    const device = requireOnlineDevice(store, agentSockets, deviceId);
    if (!device.capabilities.codex) throw httpError(409, `${device.name} has not reported Codex as authenticated and ready.`);
    if (!device.capabilities.labels.includes('feature:codex-session-mobility')) throw httpError(409, `${device.name} requires an Agent update before it can resume, fork, or move Codex sessions.`);
    const profile = store.state.v2.deviceProfiles.find((item) => item.deviceId === device.id);
    if (profile?.quarantined || profile?.trusted === false) throw httpError(409, `${device.name} is not trusted for Codex sessions.`);
    if (profile?.maintenanceMode) throw httpError(409, `${device.name} is in maintenance mode.`);
    return device;
  }

  function advancedCodexSession(session: CodexSession): AdvancedCodexSession {
    let item = store.state.v2.advancedSessions.find((entry) => entry.sessionId === session.id);
    if (!item) {
      item = { sessionId: session.id, bookmarks: [], ...(session.model ? { model: session.model } : {}), lineage: [] };
      store.state.v2.advancedSessions.push(item);
    }
    item.lineage ??= [];
    return item;
  }

  function appendCodexLineage(session: CodexSession, operation: CodexSessionLineageOperation, input: {
    fromSessionId?: string;
    fromDeviceId?: string;
    sourceThreadId?: string;
    threadId?: string;
  } = {}): void {
    const advanced = advancedCodexSession(session);
    advanced.lineage!.push({ id: randomUUID(), operation, at: new Date().toISOString(), toDeviceId: session.deviceId, ...input });
    if (operation === 'forked') advanced.parentSessionId = input.fromSessionId;
    if (operation === 'moved') advanced.movedFromDeviceId = input.fromDeviceId;
    if (advanced.lineage!.length > 256) advanced.lineage!.splice(0, advanced.lineage!.length - 256);
    store.markDirty();
  }

  function setDeviceSessionActive(device: Device, sessionId: string, active: boolean): void {
    device.activeSessionIds = active
      ? [...new Set([...device.activeSessionIds, sessionId])]
      : device.activeSessionIds.filter((id) => id !== sessionId);
    updateDeviceStatus(device);
    broadcast({ type: 'device.updated', payload: device });
  }

  async function recoverCodexSession(session: CodexSession): Promise<void> {
    const pendingRecovery = codexRecoveries.get(session.id);
    if (pendingRecovery) return pendingRecovery;
    const recovery = (async () => {
      if (!session.threadId) throw httpError(409, 'This session has no Codex thread to recover.');
      const device = requireCodexTarget(session.deviceId);
      const sourceThreadId = session.threadId;
      const activeTurnId = session.turnId;
      session.cwd = codexTargetCwd(session, device, session.cwd);
      session.status = 'starting'; session.error = undefined; session.updatedAt = new Date().toISOString();
      store.markDirty(); publishCodexSession(session);
      try {
        const result = await dispatch(device.id, {
          type: 'codex.resume', payload: { session, threadId: sourceThreadId },
        }, 60_000) as { threadId?: string };
        if (!result.threadId) throw httpError(502, 'Codex app-server did not return a recovered thread ID.');
        session.threadId = result.threadId; session.turnId = activeTurnId; session.pendingApprovals = [];
        session.status = activeTurnId ? 'thinking' : 'ready'; session.error = undefined; session.updatedAt = new Date().toISOString();
        if (session.kind !== 'fleet-system') setDeviceSessionActive(device, session.id, true);
        // Recovery is operational metadata, not a conversation boundary. In
        // particular, never place a status event between two deltas from the
        // same active turn; doing so renders one response as two chat bubbles.
        if (!activeTurnId) store.appendCodexEvent(session, { type: 'status', text: `Session recovered on ${device.name}.`, method: 'fleet/session-recovered' });
        if (session.kind !== 'fleet-system') appendCodexLineage(session, 'resumed', { fromDeviceId: device.id, sourceThreadId, threadId: result.threadId });
        appendAudit(store, { actorType: 'system', actorId: 'fleet-core', action: 'codex.session.recover', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { deviceId: device.id, sourceThreadId, threadId: result.threadId } });
        store.markDirty(); publishCodexSession(session);
        if (session.kind !== 'fleet-system') {
          activity({ type: 'session', severity: 'success', title: 'Codex session recovered', detail: `${session.title} resumed automatically on ${device.name}.`, deviceId: device.id, entityId: session.id });
        }
      } catch (error) {
        session.status = 'stopped'; session.error = error instanceof Error ? error.message : String(error); session.updatedAt = new Date().toISOString();
        if (session.kind !== 'fleet-system') setDeviceSessionActive(device, session.id, false);
        appendAudit(store, { actorType: 'system', actorId: 'fleet-core', action: 'codex.session.recover', resourceType: 'codex-session', resourceId: session.id, outcome: 'failed', detail: { deviceId: device.id, sourceThreadId, error: session.error } });
        store.markDirty(); publishCodexSession(session);
        if (session.kind !== 'fleet-system') {
          activity({ type: 'session', severity: 'warning', title: 'Codex recovery failed', detail: `${session.title} must be resumed manually on ${device.name}.`, deviceId: device.id, entityId: session.id });
        }
        throw error;
      }
    })();
    codexRecoveries.set(session.id, recovery);
    try { await recovery; }
    finally {
      if (codexRecoveries.get(session.id) === recovery) codexRecoveries.delete(session.id);
    }
  }

  async function dispatchCodexUiRpc(session: CodexSession, method: z.infer<typeof codexUiRpcMethodSchema>, params?: unknown): Promise<unknown> {
    const command = (): Promise<unknown> => dispatch(session.deviceId, {
      type: 'codex.rpc', payload: { sessionId: session.id, method, params },
    }, 45_000);
    try {
      return await command();
    } catch (error) {
      if (!isUnknownCodexSessionError(error)) throw error;
      await recoverCodexSession(session);
      return command();
    }
  }

  async function copyCodexHandoff(sourceDeviceId: string, targetDeviceId: string, sourceSessionId: string, destinationSession: CodexSession, mode: 'resume' | 'fork', lastTurnId?: string): Promise<{ threadId: string; forkedFromThreadId?: string }> {
    const prepared = await dispatch(sourceDeviceId, { type: 'codex.handoff.prepare', payload: { sessionId: sourceSessionId } }, 60_000) as {
      handoffId?: string;
      threadId?: string;
      sizeBytes?: number;
      checksumSha256?: string;
    };
    if (!prepared.handoffId || !prepared.threadId || !Number.isSafeInteger(prepared.sizeBytes) || !prepared.sizeBytes || prepared.sizeBytes > MAX_CODEX_HANDOFF_BYTES || !prepared.checksumSha256?.match(/^[a-f0-9]{64}$/i)) {
      throw httpError(502, 'Source Agent returned invalid Codex handoff metadata.');
    }
    const handoffId = prepared.handoffId;
    const sourceThreadId = prepared.threadId;
    const sizeBytes = prepared.sizeBytes;
    const checksumSha256 = prepared.checksumSha256;
    let destinationReady = false;
    try {
      await dispatch(targetDeviceId, { type: 'codex.handoff.begin', payload: { handoffId, sizeBytes, checksumSha256 } }, 45_000);
      let offset = 0;
      while (offset < sizeBytes) {
        const chunk = await dispatch(sourceDeviceId, { type: 'codex.handoff.read', payload: { handoffId, offset, length: Math.min(CODEX_HANDOFF_CHUNK_BYTES, sizeBytes - offset) } }, 45_000) as { dataBase64?: string; bytesRead?: number };
        if (!chunk.dataBase64 || !Number.isSafeInteger(chunk.bytesRead) || !chunk.bytesRead || chunk.bytesRead > CODEX_HANDOFF_CHUNK_BYTES) throw httpError(502, 'Source Agent returned an invalid Codex handoff chunk.');
        const decoded = Buffer.from(chunk.dataBase64, 'base64');
        if (decoded.length !== chunk.bytesRead || offset + chunk.bytesRead > sizeBytes) throw httpError(502, 'Source Agent returned inconsistent Codex handoff bytes.');
        const write = await dispatch(targetDeviceId, { type: 'codex.handoff.write', payload: { handoffId, offset, dataBase64: chunk.dataBase64 } }, 45_000) as { receivedBytes?: number };
        offset += chunk.bytesRead;
        if (write.receivedBytes !== offset) throw httpError(502, 'Destination Agent did not acknowledge the complete Codex handoff chunk.');
      }
      const result = await dispatch(targetDeviceId, { type: 'codex.handoff.finish', payload: {
        handoffId,
        session: destinationSession,
        sourceThreadId,
        mode,
        ...(lastTurnId ? { lastTurnId } : {}),
      } }, 90_000) as { threadId?: string; forkedFromThreadId?: string };
      if (!result.threadId) throw httpError(502, 'Destination Codex app-server did not return a thread ID.');
      destinationReady = true;
      return { threadId: result.threadId, ...(result.forkedFromThreadId ? { forkedFromThreadId: result.forkedFromThreadId } : {}) };
    } finally {
      const discard = async (deviceId: string): Promise<void> => {
        try { await dispatch(deviceId, { type: 'codex.handoff.discard', payload: { handoffId } }); } catch { /* best-effort private staging cleanup */ }
      };
      await Promise.all([discard(sourceDeviceId), ...(!destinationReady ? [discard(targetDeviceId)] : [])]);
    }
  }

  function projectPath(projectId: string, deviceId: string): string | undefined {
    return store.state.projects.find((project) => project.id === projectId)?.paths.find((entry) => entry.deviceId === deviceId)?.path;
  }

  function normalizedFleetLocation(value: string): string {
    let normalized = value.trim().replaceAll('\\', '/').toLowerCase();
    while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
  }

  function projectForCodexRuntime(session: Pick<CodexSession, 'projectId' | 'deviceId' | 'cwd'>): FleetProject | undefined {
    if (session.projectId) {
      const exact = store.state.projects.find((project) => project.id === session.projectId);
      if (exact) return exact;
    }
    const cwd = normalizedFleetLocation(session.cwd);
    return store.state.projects
      .flatMap((project) => project.paths
        .filter((mapping) => mapping.deviceId === session.deviceId)
        .map((mapping) => ({ project, path: normalizedFleetLocation(mapping.path) }))
        .filter(({ path: projectLocation }) => cwd === projectLocation || cwd.startsWith(`${projectLocation}/`)))
      .sort((left, right) => right.path.length - left.path.length)[0]?.project;
  }

  function fleetCodexContext(session: Pick<CodexSession, 'projectId' | 'deviceId' | 'cwd'>) {
    const device = requireDevice(store, session.deviceId);
    return {
      fleetName: store.state.settings.fleetName,
      device,
      session,
      project: projectForCodexRuntime(session),
    };
  }

  async function scheduleQueued(device?: Device): Promise<void> {
    for (const job of store.state.jobs.filter((item) => item.status === 'queued')) {
      if (job.deviceId && device && job.deviceId !== device.id) continue;
      if (!job.deviceId) {
        const selectedDeviceId = v2Runtime
          ? v2Runtime.selectDevice({ requiredLabels: job.requiredLabels, projectId: job.projectId, jobId: job.id }).selectedDeviceId
          : chooseDevice(job)?.id;
        if (!selectedDeviceId || (device && selectedDeviceId !== device.id)) continue;
        job.deviceId = selectedDeviceId;
      }
      await dispatchJob(job);
    }
  }

  function handleAgentMessage(socket: WebSocket, raw: unknown, state: { deviceId?: string; credentialDeviceId?: string; sourceIp?: string }): void {
    let message: AgentToCoreMessage;
    try { message = JSON.parse(String(raw)) as AgentToCoreMessage; } catch { socket.close(1003, 'JSON required'); return; }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

    if (message.type === 'agent.register') {
      const incoming = registrationSchema.parse(message.payload) as unknown as AgentRegistration & { metrics: Device['metrics']; protocolVersion: number };
      if (incoming.protocolVersion !== store.state.v2.protocolVersion) { socket.close(1002, `Protocol mismatch; Core requires ${store.state.v2.protocolVersion}`); return; }
      if (state.credentialDeviceId && state.credentialDeviceId !== incoming.id) { socket.close(1008, 'Credential does not belong to this device'); return; }
      const managedProfile = store.state.v2.deviceProfiles.find((profile) => profile.deviceId === incoming.id);
      if (managedProfile?.quarantined || managedProfile?.trusted === false) { socket.close(1008, managedProfile.quarantined ? 'Device is quarantined' : 'Device trust has been revoked'); return; }
      const existing = store.state.devices.find((device) => device.id === incoming.id);
      const now = new Date().toISOString();
      const wasOffline = !existing || existing.status === 'offline';
      const device: Device = {
        id: incoming.id,
        name: existing?.name ?? incoming.name,
        hostname: incoming.hostname,
        role: existing?.role ?? incoming.role,
        status: existing?.activeJobIds.length || existing?.activeSessionIds.length ? 'busy' : 'online',
        platform: incoming.platform,
        arch: incoming.arch,
        osName: incoming.osName,
        osVersion: incoming.osVersion,
        agentVersion: incoming.agentVersion,
        capabilities: incoming.capabilities,
        metrics: incoming.metrics,
        projectRoots: incoming.projectRoots,
        position: existing?.position ?? defaultPosition(store.state.devices.length),
        lastSeenAt: now,
        connectedAt: now,
        activeJobIds: existing?.activeJobIds ?? [],
        activeSessionIds: existing?.activeSessionIds ?? [],
      };
      if (managedProfile) {
        managedProfile.powerState = 'awake';
        managedProfile.powerStateUpdatedAt = now;
        managedProfile.updatedAt = now;
      }
      if (existing) store.state.devices.splice(store.state.devices.indexOf(existing), 1, device);
      else store.state.devices.push(device);
      const previousSocket = agentSockets.get(device.id);
      if (previousSocket && previousSocket !== socket) previousSocket.close(1012, 'Replaced by a newer agent connection');
      state.deviceId = device.id;
      agentSockets.set(device.id, socket);
      if (state.sourceIp) agentSourceIps.set(device.id, state.sourceIp);
      updateDevicePresence(device);
      store.markDirty();
      v2Runtime?.recordTelemetry(device);
      broadcast({ type: 'device.updated', payload: device });
      if (wasOffline) activity({ type: 'device', severity: 'success', title: existing ? 'Device reconnected' : 'Device joined the fleet', detail: `${device.name} is online and reporting live telemetry.`, deviceId: device.id });
      void scheduleQueued(device);
      for (const session of store.state.sessions.filter((item) =>
        item.deviceId === device.id
        && Boolean(item.threadId)
        && (item.error === CORE_RESTART_SESSION_RECOVERY_ERROR
          || item.error === AGENT_DISCONNECT_SESSION_RECOVERY_ERROR
          || Boolean(existing?.activeSessionIds.includes(item.id) && ['ready', 'thinking', 'awaiting-approval', 'completed'].includes(item.status)))
      )) {
        void recoverCodexSession(session).catch(() => undefined);
      }
      for (const project of store.state.projects.filter((item) => item.preview?.deviceId === device.id && item.preview.desiredState !== 'stopped' && item.preview.status === 'offline')) {
        const preview = project.preview!;
        void startProjectPreview(project, {
          deviceId: device.id,
          visibility: preview.visibility,
          confirmPublic: preview.visibility === 'public',
          autoStartWithCodex: true,
          stopAfterMinutes: preview.stopAfterMinutes,
        }).catch(() => undefined);
      }
      return;
    }
    if (!state.deviceId) { socket.close(1008, 'Register before sending events'); return; }

    if (message.type === 'agent.metrics') {
      if (message.payload.deviceId !== state.deviceId) return;
      const device = store.state.devices.find((item) => item.id === state.deviceId);
      if (!device) return;
      device.metrics = message.payload.metrics;
      device.lastSeenAt = new Date().toISOString();
      updateDeviceStatus(device);
      updateDevicePresence(device);
      store.markDirty();
      v2Runtime?.recordTelemetry(device);
      broadcast({ type: 'device.updated', payload: device });
      return;
    }
    if (message.type === 'agent.response') {
      const request = pending.get(message.requestId);
      if (!request || request.deviceId !== state.deviceId) return;
      clearTimeout(request.timer);
      pending.delete(message.requestId);
      if (message.error) request.reject(httpError(502, message.error));
      else request.resolve(message.payload);
      return;
    }
    if (message.type === 'terminal.data') {
      const terminal = store.state.terminals.find((item) => item.id === message.payload.terminalId && item.deviceId === state.deviceId);
      if (terminal) broadcast({ type: 'terminal.data', payload: message.payload });
      return;
    }
    if (message.type === 'terminal.exit') {
      const terminal = store.state.terminals.find((item) => item.id === message.payload.terminalId && item.deviceId === state.deviceId);
      if (!terminal) return;
      terminal.status = 'closed';
      terminal.exitCode = message.payload.exitCode;
      store.markDirty();
      broadcast({ type: 'terminal.updated', payload: terminal });
      activity({ type: 'terminal', severity: 'info', title: 'Terminal closed', detail: `Remote shell exited${terminal.exitCode === undefined ? '' : ` with code ${terminal.exitCode}`}.`, deviceId: terminal.deviceId, entityId: terminal.id });
      return;
    }
    if (message.type === 'job.output') {
      const job = store.state.jobs.find((item) => item.id === message.payload.jobId && item.deviceId === state.deviceId);
      if (!job) return;
      const environment = jobEnvironments.get(job.id); const secrets = environment ? Object.values(environment).filter(Boolean) : [];
      const text = secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), message.payload.text);
      store.appendJobOutput(job, { stream: message.payload.stream, text, raw: secrets.length ? undefined : message.payload.raw });
      broadcast({ type: 'job.updated', payload: job });
      return;
    }
    if (message.type === 'job.status') {
      const job = store.state.jobs.find((item) => item.id === message.payload.jobId && item.deviceId === state.deviceId);
      if (!job) return;
      job.status = message.payload.status;
      job.exitCode = message.payload.exitCode;
      job.error = message.payload.error;
      if (message.payload.status === 'running' && !job.startedAt) job.startedAt = new Date().toISOString();
      if (['completed', 'failed', 'cancelled'].includes(message.payload.status)) { job.completedAt = new Date().toISOString(); jobEnvironments.delete(job.id); }
      job.phase = statusPhase(message.payload.status);
      const device = store.state.devices.find((item) => item.id === state.deviceId);
      if (device && ['completed', 'failed', 'cancelled'].includes(job.status)) {
        device.activeJobIds = device.activeJobIds.filter((id) => id !== job.id);
        updateDeviceStatus(device);
        broadcast({ type: 'device.updated', payload: device });
      }
      store.markDirty();
      broadcast({ type: 'job.updated', payload: job });
      v2Runtime?.handleJobUpdate(job);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        activity({ type: 'job', severity: job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'warning', title: `Job ${job.status}`, detail: `${job.name} ${job.status}${job.error ? `: ${job.error}` : '.'}`, deviceId: job.deviceId, entityId: job.id });
      }
      return;
    }
    if (message.type === 'codex.event') {
      const session = store.state.sessions.find((item) => item.id === message.payload.sessionId && item.deviceId === state.deviceId);
      if (!session) return;
      const result = applyCodexMessage(store, session, message.payload.message);
      if (session.kind !== 'fleet-system' && result.significant === 'turn-completed') refreshGeneratedCodexSessionTitle(session);
      publishCodexSession(session, { streamingDelta: result.streamingDelta, significant: result.significant });
      if (session.kind === 'fleet-system') return;
      if (result.significant === 'turn-completed') activity({ type: 'session', severity: 'success', title: 'Codex turn completed', detail: `${session.title} finished a turn on ${deviceName(session.deviceId)}.`, deviceId: session.deviceId, entityId: session.id });
      if (result.significant === 'error') activity({ type: 'session', severity: 'error', title: 'Codex session error', detail: session.error ?? 'Codex reported an error.', deviceId: session.deviceId, entityId: session.id });
      return;
    }
    if (message.type === 'codex.exit') {
      const session = store.state.sessions.find((item) => item.id === message.payload.sessionId && item.deviceId === state.deviceId);
      if (!session) return;
      if (session.status !== 'stopped') session.status = message.payload.error ? 'error' : 'stopped';
      session.error = message.payload.error;
      session.updatedAt = new Date().toISOString();
      recentCodexExits.set(session.id, { deviceId: session.deviceId, at: Date.now() });
      if (session.kind === 'fleet-system') {
        publishCodexSession(session, { significant: session.error ? 'error' : undefined });
        return;
      }
      const device = store.state.devices.find((item) => item.id === session.deviceId);
      if (device) {
        device.activeSessionIds = device.activeSessionIds.filter((id) => id !== session.id);
        updateDeviceStatus(device);
        broadcast({ type: 'device.updated', payload: device });
      }
      store.markDirty();
      publishCodexSession(session);
      return;
    }
    if (message.type === 'preview.updated') {
      const project = store.state.projects.find((item) => item.id === message.payload.projectId);
      if (!project || message.payload.preview.deviceId !== state.deviceId) return;
      if (project.preview && project.preview.deviceId !== state.deviceId && ['starting', 'running', 'restarting'].includes(project.preview.status)) return;
      project.preview = message.payload.preview;
      broadcastProject(project);
      return;
    }
    if (message.type === 'transfer.progress') {
      const transfer = store.state.v2.transfers.find((item) => item.id === message.payload.transferId);
      if (!transfer || (transfer.source.deviceId !== state.deviceId && transfer.destination.deviceId !== state.deviceId)) return;
      transfer.transferredBytes = Math.min(message.payload.totalBytes, message.payload.transferredBytes); transfer.totalBytes = message.payload.totalBytes; transfer.checksumSha256 = message.payload.checksumSha256 ?? transfer.checksumSha256; transfer.status = transfer.transferredBytes >= transfer.totalBytes ? 'verifying' : 'running'; store.markDirty(); broadcast({ type: 'transfer.updated', payload: transfer });
      return;
    }
    if (message.type === 'desktop.event') {
      const session = store.state.v2.desktopSessions.find((item) => item.id === message.payload.sessionId && item.deviceId === state.deviceId); if (!session) return;
      session.status = message.payload.status; session.connectionUrl = message.payload.connectionUrl ?? session.connectionUrl; session.error = message.payload.error; if (session.status === 'closed') session.closedAt = new Date().toISOString(); store.markDirty(); broadcast({ type: 'v2.updated', payload: { entity: 'desktop-session', value: session } });
    }
  }

  function deviceName(id: string): string {
    return store.state.devices.find((device) => device.id === id)?.name ?? id;
  }

  function systemOrchestrator(): Device | undefined {
    const available = store.state.devices.filter((device) =>
      agentSockets.has(device.id)
      && device.status !== 'offline'
      && device.status !== 'degraded'
      && device.capabilities.codex
    );
    const configured = store.state.settings.systemOrchestratorDeviceId
      ? available.find((device) => device.id === store.state.settings.systemOrchestratorDeviceId)
      : undefined;
    return configured
      ?? available.find((device) => device.role === 'core')
      ?? available.find((device) => /mini.*64|64.*mini/i.test(`${device.name} ${device.hostname}`))
      ?? available[0];
  }

  function systemCodexSession(): CodexSession | undefined {
    const configuredId = store.state.systemConversation.codexSessionId;
    return configuredId ? store.state.sessions.find((session) => session.id === configuredId) : undefined;
  }

  function broadcastSystem(): FleetSystemConversation {
    const conversation = store.state.systemConversation;
    conversation.orchestratorDeviceId = systemOrchestrator()?.id;
    const session = systemCodexSession();
    conversation.codexSessionId = session?.id;
    conversation.status = session?.status;
    conversation.error = session?.error;
    conversation.updatedAt = new Date().toISOString();
    store.prune();
    store.markDirty();
    broadcast({ type: 'system.updated', payload: conversation });
    return conversation;
  }

  function publishCodexSession(session: CodexSession, options: {
    streamingDelta?: boolean;
    significant?: 'turn-started' | 'turn-completed' | 'error';
  } = {}): void {
    const publish = session.kind === 'fleet-system'
      ? () => syncSystemCodexResponse(session, options.significant)
      : options.streamingDelta
        ? () => {
          const event = session.events.at(-1);
          if (!event) return;
          broadcast({
            type: 'session.event.updated',
            payload: {
              sessionId: session.id,
              event,
              status: session.status,
              updatedAt: session.updatedAt,
              ...(session.turnId ? { turnId: session.turnId } : {}),
              ...(session.error ? { error: session.error } : {}),
            },
          });
        }
        : () => broadcast({ type: 'session.updated', payload: store.liveCodexSession(session) });
    if (options.streamingDelta) codexUpdateCoalescer.schedule(session.id, publish);
    else codexUpdateCoalescer.publishNow(session.id, publish);
  }

  function syncSystemCodexResponse(
    session: CodexSession,
    significant?: 'turn-started' | 'turn-completed' | 'error',
  ): void {
    const conversation = store.state.systemConversation;
    if (conversation.codexSessionId && conversation.codexSessionId !== session.id) return;
    conversation.codexSessionId = session.id;
    conversation.status = session.status;
    conversation.error = session.error;
    const active = conversation.activeResponseMessageId
      ? conversation.messages.find((message) => message.id === conversation.activeResponseMessageId)
      : undefined;
    if (active) {
      const assistant = [...session.events].reverse().find((event) =>
        event.type === 'assistant' && new Date(event.at).getTime() >= new Date(active.at).getTime()
      );
      if (assistant?.text) active.text = assistant.text;
      if (significant === 'error' && (!active.text || active.text === 'Thinking…')) active.text = session.error ?? 'Orchestra System Codex could not complete this response.';
      if (significant === 'turn-completed') {
        if (!active.text || active.text === 'Thinking…') active.text = 'Orchestra System Codex completed the turn without returning a message.';
        conversation.activeResponseMessageId = undefined;
      }
    }
    broadcastSystem();
  }

  function appendSystemMessage(input: Omit<FleetSystemMessage, 'id' | 'at' | 'mentions' | 'references'> & {
    mentions?: FleetDeviceMention[];
    references?: FleetSystemReference[];
  }): FleetSystemMessage {
    const message: FleetSystemMessage = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
      mentions: input.mentions ?? [],
      references: input.references ?? [],
    };
    store.state.systemConversation.messages.push(message);
    broadcastSystem();
    return message;
  }

  function deviceReference(device: Device, kind: FleetSystemReference['kind'] = 'device', detail?: string): FleetSystemReference {
    return {
      id: randomUUID(),
      kind,
      label: device.name,
      detail: detail ?? `${device.presence?.label ?? device.status} · ${device.role} · ${device.hostname}`,
      status: device.presence?.summary ?? device.status,
      deviceId: device.id,
    };
  }

  function mentionedDevices(mentions: FleetDeviceMention[]): Device[] {
    const ids = new Set(mentions.filter((mention) => mention.status === 'resolved').flatMap((mention) => mention.deviceIds));
    return store.state.devices.filter((device) => ids.has(device.id));
  }

  function formatBytes(bytes: number | undefined): string {
    if (!Number.isFinite(bytes)) return 'unavailable';
    const value = Number(bytes);
    if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.round(value)} B`;
  }

  function formatRate(bytes: number): string {
    return `${formatBytes(bytes)}/s`;
  }

  function formatDuration(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const days = Math.floor(whole / 86_400);
    const hours = Math.floor((whole % 86_400) / 3_600);
    const minutes = Math.floor((whole % 3_600) / 60);
    return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ');
  }

  function deviceTelemetry(device: Device): string {
    const metrics = device.metrics;
    const cpuTemperature = metrics.cpu.temperatureCelsius === undefined ? '' : ` · ${metrics.cpu.temperatureCelsius.toFixed(0)}°C`;
    const lines = [
      `${device.name} (@${preferredDeviceAlias(device)}) — ${device.presence?.label ?? device.status}`,
      `CPU: ${metrics.cpu.usagePercent.toFixed(0)}%${cpuTemperature} · ${metrics.cpu.model}`,
      `Memory: ${metrics.memory.usagePercent.toFixed(0)}% · ${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}`,
    ];
    if (metrics.gpus.length) {
      for (const gpu of metrics.gpus) {
        lines.push(`GPU: ${gpu.model} · ${gpu.usagePercent?.toFixed(0) ?? '—'}%${gpu.temperatureCelsius === undefined ? '' : ` · ${gpu.temperatureCelsius.toFixed(0)}°C`}${gpu.vramUsedBytes === undefined ? '' : ` · VRAM ${formatBytes(gpu.vramUsedBytes)} / ${formatBytes(gpu.vramTotalBytes)}`}`);
      }
    } else lines.push('GPU: none reported');
    for (const storage of metrics.storage.slice(0, 3)) {
      lines.push(`Storage ${storage.mount}: ${storage.usagePercent.toFixed(0)}% · ${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)}`);
    }
    lines.push(`Network: ↓ ${formatRate(metrics.network.rxBytesPerSecond)} · ↑ ${formatRate(metrics.network.txBytesPerSecond)}`);
    if (metrics.battery) lines.push(`Battery: ${metrics.battery.percent.toFixed(0)}% · ${metrics.battery.state}`);
    if (device.presence) {
      lines.push(`Presence: Agent ${device.presence.agent.state} · Tailscale ${device.presence.tailscale.state} · LAN ${device.presence.lan.state} · Services ${device.presence.services.state}`);
    }
    lines.push(`Uptime: ${formatDuration(metrics.uptimeSeconds)} · sampled ${metrics.sampledAt}`);
    return lines.join('\n');
  }

  function fleetArchitecture(): string {
    const orchestrator = systemOrchestrator();
    const deviceLines = store.state.devices.map((device) =>
      `- @${systemDeviceAlias(device)}: ${device.name} · ${device.presence?.label ?? device.status} · ${device.role} · ${device.platform}/${device.arch} · Codex ${device.capabilities.codex ? 'ready' : 'unavailable'} · Tailscale ${device.presence?.tailscale.state ?? (device.capabilities.tailscale ? 'configured' : 'unavailable')}`
    );
    return [
      `${store.state.settings.fleetName} is coordinated by Orchestra Core${orchestrator ? ` on ${orchestrator.name}` : ''}.`,
      'Architecture:',
      '- Authorized Orchestra Canvas clients (desktop, phone, or browser) connect to Orchestra Core.',
      '- Orchestra Core owns fleet identity, live state, routing, projects, sessions, approvals, and preview orchestration.',
      '- Orchestra Core routes Codex work to the Orchestra Agent on the selected execution device; that Agent runs Codex app-server against its local workspace.',
      '- Shared web previews run on the execution device and reach Fleet clients through Tailscale Serve, Funnel, or Fleet’s private direct-tailnet fallback; Fleet exposes the resulting URL as Website/View Site.',
      '- The Orchestra System conversation and its history belong to Core; ordinary Codex execution and files remain on each selected device.',
      `Devices (${store.state.devices.length}):`,
      ...deviceLines,
      `Projects: ${store.state.projects.length} · Codex sessions: ${store.state.sessions.filter((session) => session.kind !== 'fleet-system').length} · Active previews: ${store.state.projects.filter((project) => project.preview?.status === 'running').length}`,
    ].join('\n');
  }

  function systemDeviceAlias(device: Device): string {
    const preferred = preferredDeviceAlias(device);
    const collisions = store.state.devices.filter((candidate) => preferredDeviceAlias(candidate) === preferred);
    if (collisions.length <= 1) return preferred;
    const available = collisions.filter((candidate) => candidate.status !== 'offline');
    if (available.length === 1 && available[0]!.id === device.id) return preferred;
    return device.name.toLowerCase().replace(/[^a-z0-9]+/g, '') || device.id;
  }

  function systemDeveloperInstructions(): string {
    return [
      'You are Orchestra System, the conversational control plane for this user’s Orchestra installation.',
      'This thread is owned by Orchestra Core and hosted by the configured Core device, but the operator may be speaking from a MacBook, iPhone, PC, or another authorized client.',
      'The operator-facing surface is Orchestra Canvas, not the Codex CLI UI, ChatGPT web, or the ChatGPT desktop app. Do not redirect the operator to UI capabilities that belong to those other surfaces.',
      'Orchestra’s Website/View Site control is driven by a registered project with a running Orchestra shared preview. Treat injected preview state and its Tailscale URL as authoritative; never substitute localhost as the operator-facing result.',
      'Understand natural follow-ups, corrections, pronouns, and terse fragments using the preceding conversation. A correction should refine the prior answer instead of resetting the conversation.',
      'Answer the exact question first. Do not dump the entire fleet architecture or all telemetry unless the operator explicitly asks for it.',
      'Orchestra Core injects authoritative live architecture, device mention resolution, telemetry, project, preview, and child-session context into every turn. Prefer that context over assumptions or stale thread details.',
      '@aliases identify Orchestra devices. Treat them as device identities, never as shell syntax or social-media mentions.',
      'Be concise but operationally useful. Include timestamps only when freshness matters.',
      'Never claim that a device action, power operation, approval, or child Codex session happened unless the injected context says Orchestra Core performed it.',
      'Orchestra Core itself intercepts explicit destructive power actions for confirmation and explicit child-Codex delegation requests. Your role is to understand and explain everything else conversationally.',
      'Do not edit the Orchestra Core host workspace from this system thread. Coding work belongs in a child Codex session on the device and project selected by Orchestra Core.',
    ].join('\n');
  }

  function recentSystemDeviceContext(currentMentions: FleetDeviceMention[]): Device[] {
    const current = mentionedDevices(currentMentions);
    if (current.length) return current;
    for (const message of [...store.state.systemConversation.messages].reverse()) {
      if (message.role !== 'user') continue;
      const devices = mentionedDevices(message.mentions);
      if (devices.length) return devices;
    }
    return [];
  }

  function systemTurnPrompt(text: string, mentions: FleetDeviceMention[]): string {
    const conversation = store.state.systemConversation;
    const focusedDevices = recentSystemDeviceContext(mentions);
    const transcript = conversation.messages.slice(-12).map((message) => {
      const actor = message.role === 'user' ? message.actor?.name ?? 'Operator' : 'Orchestra System';
      return `${actor}: ${message.text || '[response in progress]'}`;
    });
    return [
      `[Orchestra Core authoritative runtime context · ${new Date().toISOString()}]`,
      fleetArchitecture(),
      '',
      mentions.length ? 'Mention resolution:' : 'No new @device mention appeared in this turn.',
      ...mentions.map((mention) => `${mention.token}: ${mention.status}${mention.deviceIds.length ? ` → ${mention.deviceIds.map(deviceName).join(', ')}` : ''}`),
      '',
      focusedDevices.length ? 'Focused live device telemetry:' : 'No device telemetry was selected for this turn.',
      ...focusedDevices.map(deviceTelemetry),
      '',
      'Recent visible Orchestra System transcript, including any actions handled directly by Orchestra Core:',
      ...transcript,
      '',
      '[Operator message]',
      text,
    ].join('\n');
  }

  async function ensureSystemCodexSession(): Promise<CodexSession> {
    const orchestrator = systemOrchestrator();
    if (!orchestrator) throw httpError(409, 'No online Codex-capable Orchestra System host is available.');
    let session = systemCodexSession();
    if (session && session.deviceId === orchestrator.id) {
      if (['ready', 'thinking', 'completed'].includes(session.status)) return session;
      if (session.status === 'stopped' && session.threadId) {
        try {
          await recoverCodexSession(session);
          return session;
        } catch {
          session = undefined;
        }
      }
    }
    const created = await createCodexSession({
      deviceId: orchestrator.id,
      cwd: orchestrator.projectRoots[0] ?? '',
      title: 'Orchestra System Orchestrator',
      permissionMode: 'read-only',
      approvalPolicy: 'never',
    }, {
      kind: 'fleet-system',
      developerInstructions: systemDeveloperInstructions(),
    });
    store.state.systemConversation.codexSessionId = created.id;
    store.state.systemConversation.error = undefined;
    broadcastSystem();
    return created;
  }

  async function retireSystemCodexSession(): Promise<void> {
    const session = systemCodexSession();
    if (!session) return;
    if (session.status !== 'stopped' && agentSockets.has(session.deviceId)) {
      await dispatch(session.deviceId, { type: 'codex.stop', payload: { sessionId: session.id } }, 5_000).catch(() => undefined);
    }
    const device = store.state.devices.find((candidate) => candidate.id === session.deviceId);
    if (device) {
      device.activeSessionIds = device.activeSessionIds.filter((id) => id !== session.id);
      updateDeviceStatus(device);
      broadcast({ type: 'device.updated', payload: device });
    }
    store.state.sessions = store.state.sessions.filter((candidate) => candidate.id !== session.id);
    store.markDirty();
  }

  function codexMessageWithFleetContext(session: CodexSession, text: string): { text: string; mentions: FleetDeviceMention[] } {
    const mentions = resolveDeviceMentions(text, store.state.devices);
    const resolved = mentionedDevices(mentions);
    const unresolved = mentions.filter((mention) => mention.status !== 'resolved');
    const context = [
      fleetCodexTurnContext(fleetCodexContext(session)),
      '',
      '[Orchestra Core live device inventory and system architecture]',
      fleetArchitecture(),
      ...(mentions.length ? [
        '',
        '[Orchestra Core resolved device mentions]',
        'Treat these as Fleet device identities, not shell syntax.',
        ...resolved.map((device) => deviceTelemetry(device)),
        ...unresolved.map((mention) => `${mention.token}: ${mention.status === 'ambiguous' ? `ambiguous (${mention.label})` : 'not found in the current fleet'}`),
      ] : []),
      '',
      '[User message]',
      text,
    ].filter((line, index, lines) => line || lines[index - 1]).join('\n');
    return { text: context, mentions };
  }

  async function createCodexSession(
    body: z.infer<typeof sessionBodySchema>,
    options: CreateCodexSessionOptions = {},
  ): Promise<CodexSession> {
    const device = requireOnlineDevice(store, agentSockets, body.deviceId);
    if (!device.capabilities.codex) throw httpError(409, `${device.name} has not reported Codex as authenticated and ready.`);
    if (body.projectId) requireProject(store, body.projectId);
    const now = new Date().toISOString();
    const session: CodexSession = {
      id: randomUUID(), deviceId: device.id, projectId: body.projectId, cwd: resolveCwd(body.cwd, body.projectId, device), title: body.title,
      titleSource: isGenericCodexSessionTitle(body.title) ? 'generated' : 'manual',
      ...(options.kind ? { kind: options.kind } : {}),
      model: body.model, permissionMode: body.permissionMode, approvalPolicy: body.approvalPolicy, status: 'starting', createdAt: now, updatedAt: now,
      events: [], pendingApprovals: [], participants: [],
    };
    session.developerInstructions = options.developerInstructions ?? fleetCodexDeveloperInstructions(fleetCodexContext(session));
    store.state.sessions.unshift(session);
    if (session.kind !== 'fleet-system') {
      appendCodexLineage(session, 'created');
      if (!device.activeSessionIds.includes(session.id)) device.activeSessionIds.push(session.id);
      updateDeviceStatus(device);
      broadcast({ type: 'device.updated', payload: device });
    }
    store.markDirty();
    publishCodexSession(session);
    try {
      const result = await dispatch(device.id, { type: 'codex.start', payload: { session } }, 45_000) as { threadId?: string };
      session.threadId = result.threadId; session.status = 'ready'; session.updatedAt = new Date().toISOString(); store.markDirty();
      publishCodexSession(session);
      if (session.kind !== 'fleet-system') {
        activity({ type: 'session', severity: 'success', title: 'Codex session ready', detail: `${session.title} is running on ${device.name}.`, deviceId: device.id, entityId: session.id });
      }
      const project = session.projectId ? store.state.projects.find((item) => item.id === session.projectId) : undefined;
      if (project && (project.preview?.autoStartWithCodex ?? true) && !['starting', 'running', 'restarting'].includes(project.preview?.status ?? 'stopped')) {
        void startProjectPreview(project, {
          deviceId: device.id,
          visibility: project.preview?.visibility ?? 'tailnet',
          confirmPublic: project.preview?.visibility === 'public',
          autoStartWithCodex: true,
          stopAfterMinutes: project.preview?.stopAfterMinutes,
        }).catch((error) => activity({
          type: 'project',
          severity: 'warning',
          title: 'Shared preview did not start',
          detail: error instanceof Error ? error.message : String(error),
          deviceId: device.id,
          entityId: project.id,
        }));
      }
      return session;
    } catch (error) {
      session.status = 'error'; session.error = error instanceof Error ? error.message : String(error); session.updatedAt = new Date().toISOString();
      if (session.kind !== 'fleet-system') {
        device.activeSessionIds = device.activeSessionIds.filter((id) => id !== session.id);
        updateDeviceStatus(device);
        broadcast({ type: 'device.updated', payload: device });
      }
      store.markDirty();
      publishCodexSession(session);
      throw error;
    }
  }

  function refreshGeneratedCodexSessionTitle(session: CodexSession): boolean {
    if (session.kind === 'fleet-system' || session.titleSource === 'manual') return false;
    if (session.titleSource === undefined && !isGenericCodexSessionTitle(session.title)) return false;
    const title = contextualCodexSessionTitleFromEvents(session.events, session.title);
    session.titleSource = 'generated';
    if (!title || title === session.title) return false;
    session.title = title;
    store.markDirty();
    return true;
  }

  async function sendCodexMessage(session: CodexSession, text: string, options: {
    client?: z.infer<typeof codexClientSchema>;
    actor?: CodexActor;
    agentText?: string;
  } = {}): Promise<CodexSession> {
    const item = participant(session, options.client);
    requireParticipantPermission(item, 'message');
    if (session.kind !== 'fleet-system' && !session.developerInstructions) {
      session.developerInstructions = fleetCodexDeveloperInstructions(fleetCodexContext(session));
      store.markDirty();
    }
    if (item) { item.typing = false; item.lastSeenAt = new Date().toISOString(); }
    const actor = actorValue(item) ?? options.actor;
    const enriched = options.agentText
      ? { text: options.agentText, mentions: resolveDeviceMentions(text, store.state.devices) }
      : codexMessageWithFleetContext(session, text);
    return enqueueCodexOperation(session.id, async () => {
      await codexRecoveries.get(session.id);
      if (!['ready', 'thinking', 'completed'].includes(session.status)) throw httpError(409, `Session cannot accept a message while ${session.status}.`);
      const steering = session.status === 'thinking';
      store.appendCodexEvent(session, {
        type: 'user',
        text,
        actor,
        ...(enriched.mentions.length ? { data: { fleetDeviceMentions: enriched.mentions } } : {}),
        ...(steering ? { method: 'fleet/turn-steer' } : {}),
      });
      session.status = 'thinking';
      session.error = undefined;
      publishCodexSession(session);
      try {
        if (steering && (!session.threadId || !session.turnId)) throw httpError(409, 'This session has no active turn to steer.');
        const command = steering
          ? { type: 'codex.rpc', payload: { sessionId: session.id, method: 'turn/steer', params: { threadId: session.threadId, expectedTurnId: session.turnId, input: [{ type: 'text', text: enriched.text, text_elements: [] }] } } } as const
          : { type: 'codex.send', payload: { sessionId: session.id, text: enriched.text } } as const;
        let result: { threadId?: string; turnId?: string };
        try {
          result = await dispatch(session.deviceId, command, 45_000) as { threadId?: string; turnId?: string };
        } catch (error) {
          const reconciledTurnId = steering ? codexActiveTurnIdFromMismatch(error) : undefined;
          if (reconciledTurnId && session.threadId) {
            session.turnId = reconciledTurnId;
            store.markDirty();
            result = await dispatch(session.deviceId, {
              type: 'codex.rpc',
              payload: { sessionId: session.id, method: 'turn/steer', params: { threadId: session.threadId, expectedTurnId: reconciledTurnId, input: [{ type: 'text', text: enriched.text, text_elements: [] }] } },
            }, 45_000) as { threadId?: string; turnId?: string };
          } else {
            if (!isUnknownCodexSessionError(error)) throw error;
            await recoverCodexSession(session);
            session.status = 'thinking';
            session.error = undefined;
            publishCodexSession(session);
            result = await dispatch(session.deviceId, {
              type: 'codex.send',
              payload: { sessionId: session.id, text: enriched.text },
            }, 45_000) as { threadId?: string; turnId?: string };
          }
        }
        session.threadId = result.threadId ?? session.threadId; session.turnId = result.turnId ?? session.turnId; store.markDirty(); publishCodexSession(session);
        appendAudit(store, { actorType: 'user', actorId: actor?.clientId ?? 'local-operator', action: steering ? 'codex.turn.steer' : 'codex.message.send', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { deviceId: session.deviceId, actor, fleetDeviceIds: mentionedDevices(enriched.mentions).map((device) => device.id) } });
        return session;
      } catch (error) {
        session.status = 'error'; session.error = error instanceof Error ? error.message : String(error); store.markDirty(); publishCodexSession(session); throw error;
      }
    });
  }

  function projectForDelegation(text: string, device: Device): FleetProject | undefined {
    const mapped = store.state.projects.filter((project) => project.paths.some((entry) => entry.deviceId === device.id));
    const query = text.toLowerCase();
    return mapped.find((project) => query.includes(project.name.toLowerCase())) ?? (mapped.length === 1 ? mapped[0] : undefined);
  }

  function delegationTitle(text: string, device: Device): string {
    const task = text.replace(/@[A-Za-z0-9._-]+/g, '').replace(/\s+/g, ' ').trim();
    return `Orchestra System · ${device.name} · ${task || 'Codex task'}`.slice(0, 240);
  }

  function powerActionFromText(text: string): DevicePowerAction | undefined {
    const query = text.toLowerCase().trim();
    return (['shutdown', 'restart', 'sleep', 'wake', 'lock', 'logout'] as const).find((action) =>
      new RegExp(`^(?:please\\s+)?(?:(?:can|could|would)\\s+you\\s+)?${action}\\b`).test(query)
      || new RegExp(`\\b(?:please|go ahead and|tell\\s+\\S+\\s+to)\\s+${action}\\b`).test(query)
    );
  }

  function isDelegationRequest(text: string): boolean {
    return /\b(?:codex|start (?:a )?(?:chat|session)|spin up|delegate|have .* (?:fix|build|review|investigate|run|work)|fix|build|review|investigate|work on)\b/i.test(text);
  }

  function proposeConductorPlan(
    objective: string,
    mentions: FleetDeviceMention[],
    actor?: CodexActor,
  ): FleetConductorPlan {
    const plan = buildConductorPlan({
      objective,
      devices: store.state.devices,
      projects: store.state.projects,
      explicitDeviceIds: mentionedDevices(mentions).map((device) => device.id),
      actor,
    });
    store.state.systemConversation.conductorPlans.unshift(plan);
    const blocked = plan.steps.filter((step) => step.status === 'blocked').length;
    appendSystemMessage({
      role: 'assistant',
      text: blocked
        ? `I drafted a Conductor plan with ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}. ${blocked} step${blocked === 1 ? ' is' : 's are'} blocked by current presence or project mapping evidence; review the details before running it.`
        : `I drafted a Conductor plan with ${plan.steps.length} reviewable step${plan.steps.length === 1 ? '' : 's'}. Nothing will execute until you approve it.`,
      mentions,
      references: plan.steps.flatMap((step) => {
        const device = step.deviceId ? store.state.devices.find((candidate) => candidate.id === step.deviceId) : undefined;
        return device ? [deviceReference(device)] : [];
      }),
      conductorPlanId: plan.id,
    });
    return plan;
  }

  async function executeConductorPlan(plan: FleetConductorPlan, actor?: CodexActor): Promise<FleetConductorPlan> {
    if (plan.status !== 'proposed') throw httpError(409, `This Conductor plan is already ${plan.status}.`);
    plan.status = 'running';
    plan.updatedAt = new Date().toISOString();
    broadcastSystem();
    const references: FleetSystemReference[] = [];

    for (const step of plan.steps) {
      if (step.status === 'blocked') continue;
      const dependencyFailed = step.dependsOn.some((id) => {
        const dependency = plan.steps.find((candidate) => candidate.id === id);
        return !dependency || !['completed'].includes(dependency.status);
      });
      if (dependencyFailed) {
        step.status = 'skipped';
        step.error = 'A required earlier step did not complete.';
        continue;
      }

      step.status = 'running';
      plan.updatedAt = new Date().toISOString();
      broadcastSystem();
      try {
        if (step.kind === 'codex') {
          if (!step.deviceId) throw new Error('Conductor Codex step has no execution device.');
          const device = requireOnlineDevice(store, agentSockets, step.deviceId);
          const session = await createCodexSession({
            deviceId: device.id,
            projectId: step.projectId,
            cwd: '',
            title: `Conductor · ${plan.title}`.slice(0, 240),
            permissionMode: step.permissionMode ?? 'workspace-write',
            approvalPolicy: 'on-request',
          });
          await sendCodexMessage(session, [
            `You are executing an approved Orchestra Conductor plan.`,
            `Plan: ${plan.title}`,
            `Objective: ${plan.objective}`,
            `Assigned device: ${device.name} (@${preferredDeviceAlias(device)}).`,
            `Complete the objective in the selected workspace and report concrete verification.`,
          ].join('\n'), { actor });
          step.sessionId = session.id;
          references.push({
            id: randomUUID(), kind: 'codex-session', label: session.title,
            detail: `${device.name} · ${session.status}`, status: session.status,
            deviceId: device.id, sessionId: session.id, projectId: session.projectId,
          });
        } else {
          if (!step.projectId) throw new Error('Conductor preview step has no project.');
          const project = requireProject(store, step.projectId);
          const preview = project.preview?.status === 'running' && project.preview.url
            ? project.preview
            : await startProjectPreview(project, {
              deviceId: step.deviceId,
              visibility: project.preview?.visibility ?? 'tailnet',
              confirmPublic: project.preview?.visibility === 'public',
              autoStartWithCodex: true,
              stopAfterMinutes: undefined,
            });
          step.previewUrl = preview.url;
          references.push({
            id: randomUUID(), kind: 'preview', label: `${project.name} website`,
            detail: preview.url ?? preview.status, status: preview.status,
            deviceId: preview.deviceId, projectId: project.id,
          });
        }
        step.status = 'completed';
        step.error = undefined;
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
      }
      plan.updatedAt = new Date().toISOString();
      broadcastSystem();
    }

    const completed = plan.steps.filter((step) => step.status === 'completed').length;
    const incomplete = plan.steps.filter((step) => ['blocked', 'failed', 'skipped'].includes(step.status)).length;
    plan.status = incomplete === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed';
    plan.updatedAt = new Date().toISOString();
    appendSystemMessage({
      role: 'assistant',
      text: plan.status === 'completed'
        ? `Conductor dispatched every step in “${plan.title}”. Open the linked sessions or website to follow the live work.`
        : `Conductor finished dispatching “${plan.title}” with status ${plan.status}. Review the blocked or failed steps before retrying.`,
      actor,
      references,
      conductorPlanId: plan.id,
    });
    return plan;
  }

  async function handleSystemMessage(body: z.infer<typeof systemMessageBodySchema>): Promise<FleetSystemConversation> {
    const mentions = resolveDeviceMentions(body.text, store.state.devices);
    appendSystemMessage({ role: 'user', text: body.text, actor: body.client, mentions });
    const invalid = mentions.filter((mention) => mention.status !== 'resolved');
    if (invalid.length) {
      appendSystemMessage({
        role: 'assistant',
        text: invalid.map((mention) => mention.status === 'ambiguous'
          ? `${mention.token} matches more than one device: ${mention.label}. Choose a more specific alias.`
          : `${mention.token} is not a device in this fleet. Type @ to choose from the live device list.`).join('\n'),
        mentions,
      });
      return store.state.systemConversation;
    }

    if (body.mode === 'conductor') {
      proposeConductorPlan(body.text, mentions, body.client);
      return store.state.systemConversation;
    }

    const devices = mentionedDevices(mentions);
    const action = powerActionFromText(body.text);
    if (action && devices.length) {
      const pending: FleetSystemPendingAction = {
        id: randomUUID(),
        kind: 'power',
        action,
        deviceIds: devices.map((device) => device.id),
        status: 'pending',
        requestedAt: new Date().toISOString(),
      };
      store.state.systemConversation.pendingActions.unshift(pending);
      appendSystemMessage({
        role: 'assistant',
        text: `Confirm ${action} for ${devices.map((device) => `${device.name} (@${preferredDeviceAlias(device)})`).join(', ')}. Orchestra Core will execute this once and record the result.`,
        mentions,
        references: devices.map((device) => deviceReference(device)),
        pendingActionId: pending.id,
      });
      return store.state.systemConversation;
    }

    if (devices.length && isDelegationRequest(body.text)) {
      const references: FleetSystemReference[] = [];
      const reports: string[] = [];
      for (const device of devices) {
        if (!agentSockets.has(device.id) || device.status === 'offline' || device.status === 'degraded') {
          reports.push(`${device.name} is offline, so Orchestra Core could not start Codex there.`);
          references.push(deviceReference(device));
          continue;
        }
        if (!device.capabilities.codex) {
          reports.push(`${device.name} does not provide Codex execution.`);
          references.push(deviceReference(device));
          continue;
        }
        try {
          const project = projectForDelegation(body.text, device);
          const session = await createCodexSession({
            deviceId: device.id,
            projectId: project?.id,
            cwd: '',
            title: delegationTitle(body.text, device),
            permissionMode: 'workspace-write',
            approvalPolicy: 'on-request',
          });
          const delegatedPrompt = [
            `Delegated by the Orchestra System conversation owned by Orchestra Core.`,
            `Target execution device: ${device.name} (@${preferredDeviceAlias(device)}, ${device.id}).`,
            project ? `Project: ${project.name}.` : 'No Fleet project was explicitly selected; use the session working directory.',
            '',
            fleetArchitecture(),
            '',
            `Operator request: ${body.text}`,
            '',
            'Work on the operator request from this device. Report concrete progress and ask for approval normally when required.',
          ].join('\n');
          void sendCodexMessage(session, body.text, {
            actor: { clientId: 'fleet-system', name: 'Orchestra System', deviceName: 'Orchestra Core' },
            agentText: delegatedPrompt,
          }).catch((error) => appendSystemMessage({
            role: 'assistant',
            text: `Codex started on ${device.name}, but Orchestra Core could not deliver the delegated task: ${error instanceof Error ? error.message : String(error)}`,
            references: [{
              id: randomUUID(),
              kind: 'codex-session',
              label: session.title,
              detail: device.name,
              status: session.status,
              deviceId: device.id,
              sessionId: session.id,
              projectId: project?.id,
            }],
          }));
          reports.push(`Started ${session.title} on ${device.name}.`);
          references.push({
            id: randomUUID(),
            kind: 'codex-session',
            label: session.title,
            detail: `${device.name}${project ? ` · ${project.name}` : ''}`,
            status: session.status,
            deviceId: device.id,
            sessionId: session.id,
            projectId: project?.id,
          });
        } catch (error) {
          reports.push(`Could not start Codex on ${device.name}: ${error instanceof Error ? error.message : String(error)}`);
          references.push(deviceReference(device));
        }
      }
      appendSystemMessage({ role: 'assistant', text: reports.join('\n'), mentions, references });
      return store.state.systemConversation;
    }

    const agentText = systemTurnPrompt(body.text, mentions);
    const response = appendSystemMessage({
      role: 'assistant',
      text: 'Thinking…',
      mentions,
      references: devices.map((device) => deviceReference(device)),
    });
    store.state.systemConversation.activeResponseMessageId = response.id;
    store.state.systemConversation.error = undefined;
    broadcastSystem();
    try {
      const session = await ensureSystemCodexSession();
      await sendCodexMessage(session, body.text, {
        actor: body.client,
        agentText,
      });
    } catch (error) {
      response.text = `Orchestra System Codex is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      store.state.systemConversation.activeResponseMessageId = undefined;
      store.state.systemConversation.error = error instanceof Error ? error.message : String(error);
      broadcastSystem();
    }
    return store.state.systemConversation;
  }

  async function executeSystemPowerAction(pendingAction: FleetSystemPendingAction): Promise<Array<{ deviceId: string; targetId?: string; error?: string }>> {
    const results: Array<{ deviceId: string; targetId?: string; error?: string }> = [];
    for (const deviceId of pendingAction.deviceIds) {
      const device = store.state.devices.find((candidate) => candidate.id === deviceId);
      if (!device) { results.push({ deviceId, error: 'Device not found.' }); continue; }
      try {
        const profile = store.state.v2.deviceProfiles.find((candidate) => candidate.deviceId === deviceId);
        const targetId = pendingAction.action === 'wake' ? profile?.wakeRelayDeviceId : deviceId;
        if (!targetId || !agentSockets.has(targetId)) throw new Error('Power target or wake relay is offline.');
        if (pendingAction.action === 'wake' && !profile?.wakeMacAddress) throw new Error('Wake MAC address is not configured.');
        await dispatch(targetId, {
          type: 'device.power',
          payload: pendingAction.action === 'wake'
            ? { action: 'wake', macAddress: profile?.wakeMacAddress, broadcastAddress: profile?.wakeBroadcastAddress }
            : { action: pendingAction.action },
        });
        if (profile && ['wake', 'sleep', 'restart', 'shutdown'].includes(pendingAction.action)) {
          profile.powerState = pendingAction.action === 'wake' ? 'waking'
            : pendingAction.action === 'sleep' ? 'sleeping'
              : pendingAction.action === 'restart' ? 'restarting'
                : 'powered-off';
          profile.powerStateUpdatedAt = new Date().toISOString();
          profile.updatedAt = profile.powerStateUpdatedAt;
        }
        results.push({ deviceId, targetId });
      } catch (error) {
        results.push({ deviceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    store.markDirty();
    broadcast({ type: 'v2.updated', payload: { entity: 'system-power-action', value: pendingAction } });
    return results;
  }

  app.get('/api/health', async () => ({ ok: true, version: VERSION, now: new Date().toISOString() }));
  app.get('/api/snapshot', async () => store.liveSnapshot());
  app.get('/api/devices', async () => store.state.devices);
  app.get('/api/devices/:deviceId/workspace', async (request) => {
    const { deviceId } = request.params as { deviceId: string };
    const query = z.object({
      path: z.string().min(1).max(4_096),
      cursor: z.string().regex(/^\d+$/).optional(),
    }).parse(request.query);
    const device = requireOnlineDevice(store, agentSockets, deviceId);
    if (!device.capabilities.labels.includes('feature:file-transfer')) {
      throw httpError(409, `${device.name} requires an Agent update before Fleet can browse its workspaces.`);
    }
    let result: unknown;
    try {
      result = await dispatch(device.id, {
        type: 'file.list',
        payload: { path: query.path, cursor: query.cursor, limit: 250 },
      });
    } catch (error) {
      throw workspaceAgentError(error);
    }
    return workspacePageSchema.parse(result);
  });
  app.post('/api/devices/:deviceId/workspace/directories', async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const body = z.object({ path: z.string().min(1).max(4_096) }).parse(request.body);
    const device = requireOnlineDevice(store, agentSockets, deviceId);
    if (!device.capabilities.labels.includes('feature:file-transfer')) {
      throw httpError(409, `${device.name} requires an Agent update before Fleet can create workspace folders.`);
    }
    let dispatched: unknown;
    try {
      dispatched = await dispatch(device.id, {
        type: 'file.mkdir',
        payload: { path: body.path, recursive: false },
      });
    } catch (error) {
      throw workspaceAgentError(error);
    }
    const result = z.object({ path: z.string().min(1).max(4_096), created: z.literal(true) }).parse(dispatched);
    const actor = requestActor.getStore();
    appendAudit(store, {
      actorType: actor?.actorType ?? 'user',
      actorId: actor?.actorId ?? 'local-operator',
      action: 'codex.workspace.directory.create',
      resourceType: 'device',
      resourceId: device.id,
      outcome: 'success',
      sourceIp: request.ip,
      detail: { path: result.path },
    });
    activity({ type: 'device', severity: 'info', title: 'Workspace folder created', detail: `${result.path} was created on ${device.name}.`, deviceId: device.id });
    return reply.code(201).send(result);
  });
  app.get('/api/projects', async () => store.state.projects);
  app.get('/api/jobs', async () => store.state.jobs);
  app.get('/api/terminals', async () => store.state.terminals);
  app.get('/api/sessions', async () => store.state.sessions.filter((session) => session.kind !== 'fleet-system'));
  app.get('/api/activity', async () => store.state.activity);
  app.get('/api/settings', async () => store.state.settings);
  app.get('/api/system', async () => broadcastSystem());

  app.post('/api/system/new', async (request, reply) => {
    const body = systemConversationActionSchema.parse(request.body ?? {});
    if (store.state.systemConversation.activeResponseMessageId) throw httpError(409, 'Wait for Orchestra System to finish before starting a new conversation.');
    await retireSystemCodexSession();
    const conversation = store.startNewSystemConversation();
    broadcastSystem();
    appendAudit(store, { actorType: 'user', actorId: body.client?.clientId ?? 'local-operator', action: 'system.conversation.create', resourceType: 'system-conversation', resourceId: conversation.id, outcome: 'success', detail: { actor: body.client } });
    activity({ type: 'system', severity: 'info', title: 'New Orchestra System conversation', detail: `${body.client?.name ?? 'An operator'} started a fresh Core-owned system conversation.` });
    return reply.code(201).send(conversation);
  });

  app.post('/api/system/clear', async (request) => {
    const body = systemConversationActionSchema.parse(request.body ?? {});
    if (store.state.systemConversation.activeResponseMessageId) throw httpError(409, 'Wait for Orchestra System to finish before clearing the conversation.');
    await retireSystemCodexSession();
    const conversation = store.clearSystemConversation();
    broadcastSystem();
    appendAudit(store, { actorType: 'user', actorId: body.client?.clientId ?? 'local-operator', action: 'system.conversation.clear', resourceType: 'system-conversation', resourceId: conversation.id, outcome: 'success', detail: { actor: body.client } });
    activity({ type: 'system', severity: 'info', title: 'Orchestra System conversation cleared', detail: `${body.client?.name ?? 'An operator'} cleared the active Core-owned system conversation and reset its Codex context.` });
    return conversation;
  });

  app.post('/api/system/messages', async (request, reply) => {
    const body = systemMessageBodySchema.parse(request.body);
    const conversation = await handleSystemMessage(body);
    appendAudit(store, { actorType: 'user', actorId: body.client?.clientId ?? 'local-operator', action: 'system.message.send', resourceType: 'system-conversation', resourceId: conversation.id, outcome: 'success', detail: { actor: body.client, deviceIds: mentionedDevices(resolveDeviceMentions(body.text, store.state.devices)).map((device) => device.id) } });
    return reply.code(201).send(conversation);
  });

  app.post('/api/system/conductor/plans/:id/execute', async (request) => {
    const body = systemConversationActionSchema.parse(request.body ?? {});
    const plan = store.state.systemConversation.conductorPlans.find((candidate) => candidate.id === (request.params as { id: string }).id);
    if (!plan) throw httpError(404, 'Conductor plan not found in the active conversation.');
    const result = await executeConductorPlan(plan, body.client);
    appendAudit(store, {
      actorType: 'user', actorId: body.client?.clientId ?? 'local-operator',
      action: 'conductor.plan.execute', resourceType: 'conductor-plan', resourceId: plan.id, outcome: result.status === 'failed' ? 'failed' : 'success',
      detail: { actor: body.client, status: result.status, stepCount: result.steps.length },
    });
    activity({ type: 'system', severity: result.status === 'completed' ? 'success' : 'warning', title: 'Conductor plan dispatched', detail: `${plan.title} finished dispatch with status ${result.status}.`, entityId: plan.id });
    return result;
  });

  app.post('/api/system/conductor/plans/:id/cancel', async (request) => {
    const body = systemConversationActionSchema.parse(request.body ?? {});
    const plan = store.state.systemConversation.conductorPlans.find((candidate) => candidate.id === (request.params as { id: string }).id);
    if (!plan) throw httpError(404, 'Conductor plan not found in the active conversation.');
    if (plan.status !== 'proposed') throw httpError(409, `This Conductor plan is already ${plan.status}.`);
    plan.status = 'cancelled';
    plan.updatedAt = new Date().toISOString();
    for (const step of plan.steps) if (step.status === 'pending') step.status = 'skipped';
    appendSystemMessage({ role: 'assistant', text: `Cancelled Conductor plan “${plan.title}”. No steps were executed.`, conductorPlanId: plan.id });
    appendAudit(store, { actorType: 'user', actorId: body.client?.clientId ?? 'local-operator', action: 'conductor.plan.cancel', resourceType: 'conductor-plan', resourceId: plan.id, outcome: 'success', detail: { actor: body.client } });
    return plan;
  });

  app.post('/api/system/power-actions/:id/confirm', async (request) => {
    const body = systemPowerConfirmationSchema.parse(request.body);
    const pendingAction = store.state.systemConversation.pendingActions.find((candidate) => candidate.id === (request.params as { id: string }).id);
    if (!pendingAction) throw httpError(404, 'Orchestra System power action not found.');
    if (pendingAction.status !== 'pending') throw httpError(409, `This power action is already ${pendingAction.status}.`);
    if (pendingAction.action !== body.action || [...pendingAction.deviceIds].sort().join('\0') !== [...body.deviceIds].sort().join('\0')) {
      throw httpError(409, 'Power confirmation no longer matches the pending Orchestra System action.');
    }
    pendingAction.status = 'running';
    broadcastSystem();
    const results = await executeSystemPowerAction(pendingAction);
    const failed = results.filter((result) => result.error);
    pendingAction.status = failed.length ? 'failed' : 'completed';
    pendingAction.completedAt = new Date().toISOString();
    pendingAction.error = failed.length ? failed.map((result) => `${deviceName(result.deviceId)}: ${result.error}`).join('; ') : undefined;
    appendSystemMessage({
      role: 'assistant',
      text: failed.length
        ? `${pendingAction.action} completed with errors:\n${pendingAction.error}`
        : `${pendingAction.action} was accepted for ${pendingAction.deviceIds.map(deviceName).join(', ')}.`,
      actor: body.client,
      references: pendingAction.deviceIds.map((deviceId) => {
        const device = store.state.devices.find((candidate) => candidate.id === deviceId);
        return device ? deviceReference(device) : { id: randomUUID(), kind: 'device' as const, label: deviceId, deviceId };
      }),
    });
    appendAudit(store, { actorType: 'user', actorId: body.client?.clientId ?? 'local-operator', action: `devices.power.${pendingAction.action}`, resourceType: 'device-batch', resourceId: pendingAction.id, outcome: failed.length ? 'failed' : 'success', detail: { deviceIds: pendingAction.deviceIds, results, actor: body.client } });
    activity({ type: 'system', severity: failed.length ? 'warning' : 'success', title: `Orchestra System ${pendingAction.action}`, detail: pendingAction.error ?? `Accepted for ${pendingAction.deviceIds.map(deviceName).join(', ')}.` });
    return { action: pendingAction, results };
  });

  app.patch('/api/devices/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(160).optional(), role: roleSchema.optional(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional() }).parse(request.body);
    const device = requireDevice(store, id);
    Object.assign(device, body);
    store.markDirty();
    broadcast({ type: 'device.updated', payload: device });
    return device;
  });

  app.post('/api/projects', async (request) => {
    const body = projectBodySchema.parse(request.body);
    const workspaceId = body.workspaceId ?? store.state.v2.workspaces[0]?.id;
    if (workspaceId && !store.state.v2.workspaces.some((workspace) => workspace.id === workspaceId)) throw httpError(404, 'Workspace not found.');
    const now = new Date().toISOString();
    const project: FleetProject = { id: randomUUID(), ...body, workspaceId, createdAt: now, updatedAt: now };
    store.state.projects.unshift(project);
    broadcastProject(project);
    activity({ type: 'project', severity: 'success', title: 'Project registered', detail: `${project.name} is available to Fleet.`, entityId: project.id });
    return project;
  });
  app.patch('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = projectBodySchema.partial().parse(request.body);
    if (body.workspaceId && !store.state.v2.workspaces.some((workspace) => workspace.id === body.workspaceId)) throw httpError(404, 'Workspace not found.');
    const project = requireProject(store, id);
    Object.assign(project, body, { updatedAt: new Date().toISOString() });
    broadcastProject(project);
    activity({ type: 'project', severity: 'info', title: 'Project updated', detail: `${project.name} configuration changed.`, entityId: project.id });
    return project;
  });
  app.post('/api/projects/:id/preview/start', async (request, reply) => {
    const project = requireProject(store, (request.params as { id: string }).id);
    const body = previewStartBodySchema.parse(request.body ?? {});
    const preview = await startProjectPreview(project, body);
    return reply.code(201).send(preview);
  });
  app.post('/api/projects/:id/preview/stop', async (request) => {
    const project = requireProject(store, (request.params as { id: string }).id);
    const preview = await stopProjectPreview(project);
    if (!preview) throw httpError(404, 'This project has no shared preview.');
    return preview;
  });
  app.post('/api/projects/:id/preview/activity', async (request) => {
    const project = requireProject(store, (request.params as { id: string }).id);
    if (!project.preview) throw httpError(404, 'This project has no shared preview.');
    project.preview.lastActivityAt = new Date().toISOString();
    project.preview.updatedAt = project.preview.lastActivityAt;
    broadcastProject(project);
    return project.preview;
  });
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const index = store.state.projects.findIndex((project) => project.id === id);
    if (index === -1) throw httpError(404, 'Project not found.');
    const project = store.state.projects[index];
    if (project?.preview && project.preview.status !== 'stopped') await stopProjectPreview(project);
    store.state.projects.splice(index, 1);
    store.markDirty();
    activity({ type: 'project', severity: 'warning', title: 'Project removed', detail: `${project?.name ?? id} was removed from the registry.`, entityId: id });
    return reply.code(204).send();
  });

  app.post('/api/jobs', async (request, reply) => {
    const body = jobBodySchema.parse(request.body);
    if (body.projectId) requireProject(store, body.projectId);
    if (body.deviceId) requireDevice(store, body.deviceId);
    const now = new Date().toISOString();
    const job: FleetJob = {
      id: randomUUID(), name: body.name, kind: body.kind, prompt: body.prompt ?? body.command ?? '', command: body.command,
      projectId: body.projectId, deviceId: body.deviceId, cwd: body.cwd, status: 'queued', permissionMode: body.permissionMode,
      approvalPolicy: body.approvalPolicy, requiredLabels: body.requiredLabels, phase: 'Queued', createdAt: now, output: [],
    };
    store.state.jobs.unshift(job);
    store.markDirty();
    activity({ type: 'job', severity: 'info', title: 'Job created', detail: `${job.name} entered the queue.`, deviceId: job.deviceId, entityId: job.id });
    void dispatchJob(job);
    return reply.code(201).send(job);
  });
  app.post('/api/jobs/:id/assign', async (request) => {
    const { id } = request.params as { id: string };
    const { deviceId } = z.object({ deviceId: identifierSchema }).parse(request.body);
    const job = requireJob(store, id);
    if (job.status !== 'queued') throw httpError(409, 'Only queued jobs can be reassigned.');
    const device = requireDevice(store, deviceId);
    if (!job.requiredLabels.every((label) => device.capabilities.labels.includes(label))) throw httpError(409, 'Device does not satisfy this job’s required capabilities.');
    job.deviceId = deviceId;
    job.phase = 'Assigned';
    store.markDirty();
    void dispatchJob(job);
    return job;
  });
  app.post('/api/jobs/:id/start', async (request) => {
    const { id } = request.params as { id: string };
    const job = requireJob(store, id);
    if (!['queued', 'failed', 'cancelled'].includes(job.status)) throw httpError(409, `Job cannot be started while ${job.status}.`);
    job.status = 'queued';
    job.phase = 'Queued for retry';
    job.error = undefined;
    job.exitCode = undefined;
    job.startedAt = undefined;
    job.completedAt = undefined;
    store.appendJobOutput(job, { stream: 'system', text: '\n— Job retried —\n' });
    store.markDirty();
    void dispatchJob(job);
    return job;
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return cancelFleetJob(requireJob(store, id));
  });

  app.post('/api/terminals', async (request, reply) => {
    const body = terminalBodySchema.parse(request.body);
    const device = requireOnlineDevice(store, agentSockets, body.deviceId);
    const terminal: TerminalSession = {
      id: randomUUID(), deviceId: device.id, cwd: resolveCwd(body.cwd, undefined, device), shell: device.capabilities.shell,
      cols: body.cols, rows: body.rows, createdAt: new Date().toISOString(), status: 'starting',
    };
    store.state.terminals.unshift(terminal); store.markDirty(); broadcast({ type: 'terminal.updated', payload: terminal });
    try {
      await dispatch(device.id, { type: 'terminal.start', payload: { terminal } });
      terminal.status = 'open'; store.markDirty(); broadcast({ type: 'terminal.updated', payload: terminal });
      activity({ type: 'terminal', severity: 'success', title: 'Terminal opened', detail: `Remote shell opened on ${device.name}.`, deviceId: device.id, entityId: terminal.id });
      return reply.code(201).send(terminal);
    } catch (error) {
      terminal.status = 'error'; store.markDirty(); broadcast({ type: 'terminal.updated', payload: terminal }); throw error;
    }
  });
  app.post('/api/terminals/:id/input', async (request, reply) => {
    const terminal = requireTerminal(store, (request.params as { id: string }).id);
    const { data } = z.object({ data: z.string().max(1_000_000) }).parse(request.body);
    await dispatch(terminal.deviceId, { type: 'terminal.input', payload: { terminalId: terminal.id, data } });
    return reply.code(204).send();
  });
  app.post('/api/terminals/:id/resize', async (request, reply) => {
    const terminal = requireTerminal(store, (request.params as { id: string }).id);
    const body = z.object({ cols: z.number().int().min(2).max(1_000), rows: z.number().int().min(2).max(1_000) }).parse(request.body);
    await dispatch(terminal.deviceId, { type: 'terminal.resize', payload: { terminalId: terminal.id, ...body } });
    Object.assign(terminal, body); store.markDirty();
    return reply.code(204).send();
  });
  app.post('/api/terminals/:id/stop', async (request, reply) => {
    const terminal = requireTerminal(store, (request.params as { id: string }).id);
    if (terminal.status === 'open') await dispatch(terminal.deviceId, { type: 'terminal.stop', payload: { terminalId: terminal.id } });
    terminal.status = 'closed'; store.markDirty(); broadcast({ type: 'terminal.updated', payload: terminal });
    return reply.code(204).send();
  });

  app.post('/api/sessions', async (request, reply) => {
    const body = sessionBodySchema.parse(request.body);
    return reply.code(201).send(await createCodexSession(body));
  });
  app.patch('/api/sessions/:id/permissions', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = sessionPermissionBodySchema.parse(request.body);
    const item = participant(session, body.client);
    requireParticipantPermission(item, 'control');
    if (item && session.controllerClientId !== item.clientId) {
      const controller = (session.participants ?? []).find((candidate) => candidate.clientId === session.controllerClientId);
      throw httpError(409, `${controller?.name ?? 'Another participant'} currently controls this session.`);
    }
    if (!session.threadId) throw httpError(409, 'This session has no Codex thread to update.');
    if (session.permissionMode === body.permissionMode) return session;

    return enqueueCodexOperation(session.id, async () => {
      await codexRecoveries.get(session.id);
      if (item) {
        ensureSessionController(session);
        if (session.controllerClientId !== item.clientId) {
          const controller = (session.participants ?? []).find((candidate) => candidate.clientId === session.controllerClientId);
          throw httpError(409, `${controller?.name ?? 'Another participant'} currently controls this session.`);
        }
      }
      const previousMode = session.permissionMode;
      if (session.status !== 'stopped') {
        if (!['ready', 'thinking', 'awaiting-approval', 'completed'].includes(session.status)) {
          throw httpError(409, `Session permissions cannot change while ${session.status}.`);
        }
        const device = requireOnlineDevice(store, agentSockets, session.deviceId);
        if (!device.capabilities.labels.includes('feature:codex-ui-rpc')) {
          throw httpError(409, `${device.name} requires a Fleet Agent update before session permissions can change.`);
        }
        await dispatchCodexUiRpc(session, 'thread/settings/update', {
          threadId: session.threadId,
          approvalPolicy: session.approvalPolicy,
          sandboxPolicy: codexSandboxPolicy(body.permissionMode, session.cwd),
        });
      }

      session.permissionMode = body.permissionMode;
      session.updatedAt = new Date().toISOString();
      store.markDirty();
      publishCodexSession(session);
      appendAudit(store, {
        actorType: 'user',
        actorId: item?.clientId ?? 'local-operator',
        action: 'codex.session.permissions.update',
        resourceType: 'codex-session',
        resourceId: session.id,
        outcome: 'success',
        detail: { deviceId: session.deviceId, previousMode, permissionMode: body.permissionMode, actor: actorValue(item) },
      });
      activity({
        type: 'session',
        severity: body.permissionMode === 'danger-full-access' ? 'warning' : 'info',
        title: 'Codex permissions changed',
        detail: `${session.title} now uses ${permissionModeLabel(body.permissionMode)} permissions.`,
        deviceId: session.deviceId,
        entityId: session.id,
      });
      return session;
    });
  });
  app.post('/api/sessions/:id/resume', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = z.object({ model: optionalCodexModelSchema }).parse(request.body ?? {});
    if (session.status !== 'stopped') throw httpError(409, `Only stopped sessions can be resumed; this session is ${session.status}.`);
    if (!session.threadId) throw httpError(409, 'This session has no Codex thread to resume.');
    const device = requireCodexTarget(session.deviceId);
    if (body.model) session.model = body.model;
    session.cwd = codexTargetCwd(session, device, session.cwd);
    session.status = 'starting'; session.error = undefined; session.updatedAt = new Date().toISOString();
    setDeviceSessionActive(device, session.id, true); store.markDirty(); publishCodexSession(session);
    try {
      const sourceThreadId = session.threadId;
      const result = await dispatch(device.id, { type: 'codex.resume', payload: { session, threadId: sourceThreadId } }, 60_000) as { threadId?: string };
      if (!result.threadId) throw httpError(502, 'Codex app-server did not return a resumed thread ID.');
      session.threadId = result.threadId; session.turnId = undefined; session.status = 'ready'; session.updatedAt = new Date().toISOString();
      store.appendCodexEvent(session, { type: 'status', text: `Session resumed on ${device.name}.`, method: 'fleet/session-resumed' });
      appendCodexLineage(session, 'resumed', { fromDeviceId: device.id, sourceThreadId, threadId: result.threadId });
      appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: 'codex.session.resume', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { deviceId: device.id, sourceThreadId, threadId: result.threadId } });
      store.markDirty(); publishCodexSession(session);
      activity({ type: 'session', severity: 'success', title: 'Codex session resumed', detail: `${session.title} resumed on ${device.name}.`, deviceId: device.id, entityId: session.id });
      return session;
    } catch (error) {
      session.status = 'error'; session.error = error instanceof Error ? error.message : String(error); session.updatedAt = new Date().toISOString();
      setDeviceSessionActive(device, session.id, false); store.markDirty(); publishCodexSession(session);
      appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: 'codex.session.resume', resourceType: 'codex-session', resourceId: session.id, outcome: 'failed', detail: { deviceId: device.id, error: session.error } });
      throw error;
    }
  });
  app.post('/api/sessions/:id/fork', async (request, reply) => {
    const source = requireSession(store, (request.params as { id: string }).id);
    const body = sessionForkBodySchema.parse(request.body ?? {});
    if (!source.threadId) throw httpError(409, 'This session has no Codex thread to fork.');
    if (!['ready', 'completed', 'stopped'].includes(source.status)) throw httpError(409, `Session cannot be forked while ${source.status}.`);
    const target = requireCodexTarget(body.deviceId ?? source.deviceId);
    const crossDevice = target.id !== source.deviceId;
    if (crossDevice && source.status === 'stopped') throw httpError(409, 'Start the source session before forking it to another device.');
    const cwd = codexTargetCwd(source, target, body.cwd);
    const now = new Date().toISOString();
    const defaultForkTitle = `${source.title} (fork)`;
    const forkTitle = body.title ?? defaultForkTitle;
    const sourceEvents = body.lastTurnId ? codexEventsThroughTurn(source.events, body.lastTurnId) : source.events;
    const fork: CodexSession = {
      ...source,
      id: randomUUID(),
      deviceId: target.id,
      cwd,
      title: forkTitle,
      titleSource: body.title && body.title !== defaultForkTitle ? 'manual' : source.titleSource,
      threadId: undefined,
      turnId: undefined,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      events: sourceEvents.map((event) => ({ ...event, id: randomUUID() })),
      pendingApprovals: [],
      error: undefined,
    };
    store.state.sessions.unshift(fork); setDeviceSessionActive(target, fork.id, true); store.markDirty(); publishCodexSession(fork);
    const sourceStatus = source.status;
    if (source.status !== 'stopped') { source.status = 'starting'; source.updatedAt = now; publishCodexSession(source); }
    try {
      const result = crossDevice
        ? await copyCodexHandoff(source.deviceId, target.id, source.id, fork, 'fork', body.lastTurnId)
        : await dispatch(target.id, { type: 'codex.fork', payload: { session: fork, threadId: source.threadId, ...(body.lastTurnId ? { lastTurnId: body.lastTurnId } : {}) } }, 60_000) as { threadId?: string; forkedFromThreadId?: string };
      if (!result.threadId) throw httpError(502, 'Codex app-server did not return a forked thread ID.');
      fork.threadId = result.threadId; fork.status = 'ready'; fork.updatedAt = new Date().toISOString();
      source.status = sourceStatus; source.updatedAt = fork.updatedAt;
      store.appendCodexEvent(fork, { type: 'status', text: `Forked from ${source.title} on ${target.name}.`, method: 'fleet/session-forked', data: { sourceSessionId: source.id, sourceThreadId: source.threadId } });
      const sourceAdvanced = advancedCodexSession(source); const forkAdvanced = advancedCodexSession(fork);
      forkAdvanced.model = sourceAdvanced.model ?? source.model; forkAdvanced.reasoningLevel = sourceAdvanced.reasoningLevel;
      appendCodexLineage(fork, 'forked', { fromSessionId: source.id, fromDeviceId: source.deviceId, sourceThreadId: source.threadId, threadId: result.threadId });
      appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: 'codex.session.fork', resourceType: 'codex-session', resourceId: fork.id, outcome: 'success', detail: { sourceSessionId: source.id, sourceDeviceId: source.deviceId, targetDeviceId: target.id, sourceThreadId: source.threadId, threadId: result.threadId } });
      store.markDirty(); publishCodexSession(source); publishCodexSession(fork);
      activity({ type: 'session', severity: 'success', title: 'Codex session forked', detail: `${source.title} was forked to ${target.name}.`, deviceId: target.id, entityId: fork.id });
      return reply.code(201).send(fork);
    } catch (error) {
      source.status = sourceStatus; source.updatedAt = new Date().toISOString();
      fork.status = 'error'; fork.error = error instanceof Error ? error.message : String(error); fork.updatedAt = source.updatedAt;
      setDeviceSessionActive(target, fork.id, false); store.markDirty(); publishCodexSession(source); publishCodexSession(fork);
      appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: 'codex.session.fork', resourceType: 'codex-session', resourceId: fork.id, outcome: 'failed', detail: { sourceSessionId: source.id, targetDeviceId: target.id, error: fork.error } });
      throw error;
    }
  });
  app.post('/api/sessions/:id/move', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = sessionMoveBodySchema.parse(request.body);
    if (!session.threadId) throw httpError(409, 'This session has no Codex thread to move.');
    if (!['ready', 'completed'].includes(session.status)) throw httpError(409, `Session cannot be moved while ${session.status}.`);
    if (body.deviceId === session.deviceId) throw httpError(409, 'Session is already on that device.');
    const source = requireCodexTarget(session.deviceId);
    const target = requireCodexTarget(body.deviceId);
    const targetCwd = codexTargetCwd(session, target, body.cwd);
    const sourceStatus = session.status; const sourceDeviceId = source.id; const sourceThreadId = session.threadId;
    const destinationSession = { ...session, deviceId: target.id, cwd: targetCwd, status: 'starting' as const, turnId: undefined, pendingApprovals: [] };
    session.status = 'starting'; session.updatedAt = new Date().toISOString(); store.markDirty(); publishCodexSession(session);
    try {
      const result = await copyCodexHandoff(source.id, target.id, session.id, destinationSession, 'resume');
      // The destination is now live. Only after that success do we stop the
      // source process; a stop failure cannot invalidate the resumed thread.
      let sourceStopError: string | undefined;
      try { await dispatch(source.id, { type: 'codex.stop', payload: { sessionId: session.id } }, 30_000); }
      catch (error) { sourceStopError = error instanceof Error ? error.message : String(error); }
      setDeviceSessionActive(source, session.id, false);
      session.deviceId = target.id; session.cwd = targetCwd; session.threadId = result.threadId; session.turnId = undefined; session.pendingApprovals = [];
      session.status = 'ready'; session.error = undefined; session.updatedAt = new Date().toISOString(); setDeviceSessionActive(target, session.id, true);
      store.appendCodexEvent(session, { type: 'status', text: `Session moved from ${source.name} to ${target.name}.`, method: 'fleet/session-moved', data: { fromDeviceId: source.id, toDeviceId: target.id, sourceThreadId, threadId: result.threadId } });
      appendCodexLineage(session, 'moved', { fromSessionId: session.id, fromDeviceId: source.id, sourceThreadId, threadId: result.threadId });
      appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: 'codex.session.move', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { sourceDeviceId: source.id, targetDeviceId: target.id, sourceThreadId, threadId: result.threadId, ...(sourceStopError ? { sourceStopError } : {}) } });
      store.markDirty(); publishCodexSession(session);
      activity({ type: 'session', severity: sourceStopError ? 'warning' : 'success', title: 'Codex session moved', detail: sourceStopError ? `${session.title} resumed on ${target.name}, but the source Agent could not confirm shutdown.` : `${session.title} moved from ${source.name} to ${target.name}.`, deviceId: target.id, entityId: session.id });
      return session;
    } catch (error) {
      session.status = sourceStatus; session.error = undefined; session.updatedAt = new Date().toISOString(); store.markDirty(); publishCodexSession(session);
      appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: 'codex.session.move', resourceType: 'codex-session', resourceId: session.id, outcome: 'failed', detail: { sourceDeviceId, targetDeviceId: target.id, error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  });
  app.post('/api/sessions/:id/presence', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = codexPresenceSchema.parse(request.body);
    const item = participant(session, body)!;
    item.typing = body.typing;
    item.lastSeenAt = new Date().toISOString();
    ensureSessionController(session);
    publishCodexSession(session);
    return { participant: item, controllerClientId: session.controllerClientId };
  });
  app.delete('/api/sessions/:id/presence', async (request, reply) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = codexClientSchema.pick({ clientId: true }).parse(request.body);
    session.participants = (session.participants ?? []).filter((item) => item.clientId !== body.clientId);
    if (session.controllerClientId === body.clientId) {
      session.controllerClientId = undefined;
      session.controllerUpdatedAt = undefined;
    }
    ensureSessionController(session);
    publishCodexSession(session);
    return reply.code(204).send();
  });
  app.post('/api/sessions/:id/control', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = codexClientSchema.extend({ force: z.boolean().default(false) }).parse(request.body);
    const item = participant(session, body)!;
    requireParticipantPermission(item, 'control');
    const current = (session.participants ?? []).find((candidate) => candidate.clientId === session.controllerClientId);
    const inactive = !current || Date.now() - new Date(current.lastSeenAt).getTime() > 120_000;
    const actor = requestActor.getStore();
    if (!inactive && current?.clientId !== item.clientId && !(body.force && actor?.actorId === 'recovery-admin')) {
      throw httpError(409, `${current?.name ?? 'Another participant'} currently controls this session.`);
    }
    session.controllerClientId = item.clientId;
    session.controllerUpdatedAt = new Date().toISOString();
    publishCodexSession(session);
    appendAudit(store, { actorType: 'user', actorId: item.clientId, action: 'codex.session.control', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { actor: actorValue(item) } });
    return session;
  });
  app.post('/api/sessions/:id/messages', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = z.object({ text: z.string().trim().min(1).max(250_000), client: codexClientSchema.optional() }).parse(request.body);
    return sendCodexMessage(session, body.text, { client: body.client });
  });
  app.post('/api/sessions/:id/rpc', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = z.object({ method: codexUiRpcMethodSchema, params: z.unknown().optional() }).parse(request.body);
    await codexRecoveries.get(session.id);
    if (!session.threadId) throw httpError(409, 'This session has no active Codex thread.');
    if (!['ready', 'thinking', 'awaiting-approval', 'completed'].includes(session.status)) throw httpError(409, `Session cannot run a Codex command while ${session.status}.`);
    const device = requireOnlineDevice(store, agentSockets, session.deviceId);
    if (!device.capabilities.labels.includes('feature:codex-ui-rpc')) {
      throw httpError(409, `${device.name} requires a Fleet Agent update before slash commands can run.`);
    }
    const normalizedParams = normalizeCodexUiRpcParams(body.method, body.params);
    const rpcParams = recordValue(normalizedParams);
    if ('threadId' in rpcParams && rpcParams.threadId !== session.threadId) throw httpError(403, 'A Codex UI command cannot target a different thread.');
    for (const candidate of [rpcParams.cwd, ...stringValues(rpcParams.cwds), ...stringValues(rpcParams.roots)]) {
      if (typeof candidate === 'string' && path.resolve(candidate) !== path.resolve(session.cwd)) throw httpError(403, 'A Codex UI command cannot inspect a different workspace.');
    }
    const result = await dispatchCodexUiRpc(session, body.method, normalizedParams);
    if (body.method === 'thread/name/set') {
      const name = recordValue(body.params).name;
      if (typeof name === 'string' && name.trim()) {
        session.title = name.trim().slice(0, 240);
        session.titleSource = 'manual';
      }
    }
    if (body.method === 'thread/settings/update') {
      const params = recordValue(normalizedParams);
      const collaborationSettings = recordValue(recordValue(params.collaborationMode).settings);
      const model = typeof params.model === 'string' ? params.model : collaborationSettings.model;
      const effort = typeof params.effort === 'string' ? params.effort
        : typeof params.reasoning_effort === 'string' ? params.reasoning_effort
          : collaborationSettings.reasoning_effort;
      const advanced = advancedCodexSession(session);
      if (typeof model === 'string') { session.model = model; advanced.model = model; }
      if (typeof effort === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) advanced.reasoningLevel = effort as AdvancedCodexSession['reasoningLevel'];
      if (typeof params.approvalPolicy === 'string' && approvalSchema.safeParse(params.approvalPolicy).success) session.approvalPolicy = params.approvalPolicy as CodexSession['approvalPolicy'];
      const sandbox = recordValue(params.sandboxPolicy).type;
      if (sandbox === 'readOnly') session.permissionMode = 'read-only';
      if (sandbox === 'workspaceWrite') session.permissionMode = 'workspace-write';
      if (sandbox === 'dangerFullAccess') session.permissionMode = 'danger-full-access';
    }
    session.updatedAt = new Date().toISOString(); store.markDirty(); publishCodexSession(session);
    appendAudit(store, { actorType: 'user', actorId: 'local-operator', action: `codex.rpc.${body.method}`, resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { deviceId: session.deviceId, method: body.method } });
    return { result, session };
  });
  app.post('/api/sessions/:id/respond', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = z.object({ requestId: z.union([z.string(), z.number()]), result: z.unknown(), client: codexClientSchema.optional() }).parse(request.body);
    const item = participant(session, body.client);
    requireParticipantPermission(item, 'approve');
    const approval = session.pendingApprovals.find((item) => String(item.requestId) === String(body.requestId));
    if (!approval) throw httpError(404, 'Approval request not found.');
    const claim = `${session.id}:${String(body.requestId)}`;
    if (codexApprovalClaims.has(claim)) throw httpError(409, 'This approval is already being answered by another participant.');
    codexApprovalClaims.add(claim);
    session.pendingApprovals = session.pendingApprovals.filter((item) => item.id !== approval.id);
    publishCodexSession(session);
    try {
      await dispatch(session.deviceId, { type: 'codex.respond', payload: { sessionId: session.id, codexRequestId: body.requestId, result: body.result } });
      session.status = 'thinking'; session.updatedAt = new Date().toISOString(); store.markDirty(); publishCodexSession(session);
      activity({ type: 'security', severity: 'info', title: 'Codex approval answered', detail: `${approval.title} was answered by ${item?.name ?? 'the operator'}.`, deviceId: session.deviceId, entityId: session.id });
      appendAudit(store, { actorType: 'user', actorId: item?.clientId ?? 'local-operator', action: 'codex.approval.respond', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { requestId: String(body.requestId), actor: actorValue(item) } });
      return session;
    } catch (error) {
      if (!session.pendingApprovals.some((candidate) => candidate.id === approval.id)) session.pendingApprovals.push(approval);
      session.pendingApprovals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      publishCodexSession(session);
      throw error;
    } finally {
      codexApprovalClaims.delete(claim);
    }
  });
  app.post('/api/sessions/:id/interrupt', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    const body = z.object({ client: codexClientSchema.optional() }).parse(request.body ?? {});
    const item = participant(session, body.client);
    requireParticipantPermission(item, 'interrupt');
    if (!session.threadId || !session.turnId) throw httpError(409, 'This session has no active turn to interrupt.');
    await dispatch(session.deviceId, { type: 'codex.interrupt', payload: { sessionId: session.id, threadId: session.threadId, turnId: session.turnId } });
    session.status = 'ready'; session.updatedAt = new Date().toISOString(); store.markDirty(); publishCodexSession(session);
    appendAudit(store, { actorType: 'user', actorId: item?.clientId ?? 'local-operator', action: 'codex.session.interrupt', resourceType: 'codex-session', resourceId: session.id, outcome: 'success', detail: { actor: actorValue(item) } });
    return session;
  });
  app.post('/api/sessions/:id/stop', async (request) => {
    const session = requireSession(store, (request.params as { id: string }).id);
    if (session.status !== 'stopped' && agentSockets.has(session.deviceId)) await dispatch(session.deviceId, { type: 'codex.stop', payload: { sessionId: session.id } });
    session.status = 'stopped'; session.updatedAt = new Date().toISOString();
    const device = store.state.devices.find((item) => item.id === session.deviceId);
    if (device) { device.activeSessionIds = device.activeSessionIds.filter((id) => id !== session.id); updateDeviceStatus(device); broadcast({ type: 'device.updated', payload: device }); }
    store.markDirty(); publishCodexSession(session);
    return session;
  });

  app.patch('/api/settings', async (request) => {
    const body = z.object({
      fleetName: z.string().trim().min(1).max(160).optional(),
      heartbeatIntervalMs: z.number().int().min(1_000).max(300_000).optional(),
      offlineAfterMs: z.number().int().min(3_000).max(3_600_000).optional(),
      retainActivityDays: z.number().int().min(1).max(3_650).optional(),
      autoStartLocalAgent: z.boolean().optional(),
      systemOrchestratorDeviceId: identifierSchema.nullable().optional(),
    }).parse(request.body);
    const { systemOrchestratorDeviceId, ...settings } = body;
    Object.assign(store.state.settings, settings);
    if (systemOrchestratorDeviceId === null) delete store.state.settings.systemOrchestratorDeviceId;
    else if (systemOrchestratorDeviceId !== undefined) {
      requireDevice(store, systemOrchestratorDeviceId);
      store.state.settings.systemOrchestratorDeviceId = systemOrchestratorDeviceId;
    }
    broadcastSystem(); store.prune(); store.markDirty();
    activity({ type: 'system', severity: 'info', title: 'Fleet settings updated', detail: 'Control-plane settings were changed.' });
    return store.state.settings;
  });

  async function createV2Job(input: Pick<FleetJob, 'name' | 'kind' | 'prompt' | 'permissionMode' | 'approvalPolicy' | 'requiredLabels'> & Partial<Pick<FleetJob, 'command' | 'projectId' | 'deviceId' | 'cwd'>> & { environment?: Record<string, string> }): Promise<FleetJob> {
    if (input.projectId) requireProject(store, input.projectId);
    if (input.deviceId) requireDevice(store, input.deviceId);
    const { environment, ...persistedInput } = input; const job: FleetJob = { id: randomUUID(), ...persistedInput, status: 'queued', phase: 'Queued', createdAt: new Date().toISOString(), output: [] };
    if (environment && Object.keys(environment).length) jobEnvironments.set(job.id, environment);
    store.state.jobs.unshift(job); store.markDirty();
    activity({ type: 'job', severity: 'info', title: 'Job created', detail: `${job.name} entered the queue.`, deviceId: job.deviceId, entityId: job.id });
    await dispatchJob(job); return job;
  }

  v2Runtime = registerV2Routes(app, {
    store, token, coreUrl, loopback: isLoopbackHost(host), dispatch, broadcast, activity,
    isOnline: (deviceId) => agentSockets.has(deviceId) && store.state.devices.find((device) => device.id === deviceId)?.status !== 'offline', disconnectDevice,
    currentAuditActor: () => requestActor.getStore() ?? { actorType: 'system', actorId: 'fleet-core' },
    createJob: createV2Job,
    cancelJob: async (jobId) => cancelFleetJob(requireJob(store, jobId)),
  });

  app.get('/ws/client', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !isLoopbackOrigin(origin) && !configuredOrigins.has(origin)) { socket.close(1008, 'WebSocket origin is not allowed'); return; }
    const supplied = suppliedToken(request); const apiToken = supplied ? v2Runtime?.authenticateApiToken(supplied) : undefined;
    if (!(allowUnauthenticatedLoopback && isLoopbackAddress(request.ip)) && !authorized(request, token) && !(apiToken && apiScopeAllowed(apiToken.scopes, 'GET', '/api/snapshot'))) { socket.close(1008, 'Fleet read authentication required'); return; }
    clientSockets.add(socket);
    socket.send(JSON.stringify({ type: 'snapshot', payload: store.liveSnapshot() } satisfies ClientEvent));
    socket.on('close', () => clientSockets.delete(socket));
    socket.on('error', () => clientSockets.delete(socket));
  });

  app.get('/ws/agent', { websocket: true }, (socket, request) => {
    const agentCredential = suppliedToken(request);
    const credentialDeviceId = !authorized(request, token) && agentCredential ? v2Runtime?.authenticateDeviceCredential(agentCredential) : undefined;
    if (!(allowUnauthenticatedLoopback && isLoopbackAddress(request.ip)) && (!token || !authorized(request, token)) && !credentialDeviceId) { socket.close(1008, 'Agent authentication required'); return; }
    const state: { deviceId?: string; credentialDeviceId?: string; sourceIp?: string } = { credentialDeviceId, sourceIp: request.ip };
    socket.on('message', (raw) => {
      try { handleAgentMessage(socket, raw, state); } catch (error) { socket.send(JSON.stringify({ type: 'core.error', error: error instanceof Error ? error.message : String(error) })); }
    });
    socket.on('close', () => {
      if (!state.deviceId || agentSockets.get(state.deviceId) !== socket) return;
      agentSockets.delete(state.deviceId);
      const device = store.state.devices.find((item) => item.id === state.deviceId);
      if (device) {
        const now = Date.now();
        for (const session of store.state.sessions.filter((item) => item.deviceId === device.id && item.threadId && item.status === 'stopped')) {
          const recentExit = recentCodexExits.get(session.id);
          if (!recentExit || recentExit.deviceId !== device.id || now - recentExit.at > RECENT_CODEX_EXIT_WINDOW_MS) continue;
          session.error = AGENT_DISCONNECT_SESSION_RECOVERY_ERROR;
          session.updatedAt = new Date(now).toISOString();
          device.activeSessionIds = [...new Set([...device.activeSessionIds, session.id])];
        }
        device.status = 'offline'; device.lastSeenAt = new Date().toISOString(); updateDevicePresence(device); store.markDirty(); broadcast({ type: 'device.updated', payload: device });
        markDevicePreviewsOffline(device.id, 'The preview host disconnected. It will restart when the Agent reconnects.');
        v2Runtime?.evaluateDeviceAlerts(device);
        activity({ type: 'device', severity: 'warning', title: 'Device disconnected', detail: `${device.name} stopped reporting to Fleet Core.`, deviceId: device.id });
      }
      for (const [sessionId, exit] of recentCodexExits) if (Date.now() - exit.at > RECENT_CODEX_EXIT_WINDOW_MS) recentCodexExits.delete(sessionId);
      for (const [id, request] of pending) if (request.deviceId === state.deviceId) { clearTimeout(request.timer); request.reject(httpError(502, 'Agent disconnected.')); pending.delete(id); }
    });
  });

  const offlineTimer = setInterval(() => {
    const cutoff = Date.now() - store.state.settings.offlineAfterMs;
    for (const device of store.state.devices) {
      if (device.status !== 'offline' && new Date(device.lastSeenAt).getTime() < cutoff) {
        device.status = 'offline'; updateDevicePresence(device); store.markDirty(); broadcast({ type: 'device.updated', payload: device });
        markDevicePreviewsOffline(device.id, 'The preview host stopped reporting to Fleet Core.');
        v2Runtime?.evaluateDeviceAlerts(device);
        activity({ type: 'device', severity: 'warning', title: 'Device heartbeat expired', detail: `${device.name} has not reported within the configured window.`, deviceId: device.id });
      } else if (device.status === 'offline') {
        updateDevicePresence(device, true);
        v2Runtime?.evaluateDeviceAlerts(device);
      }
    }
  }, 2_000);
  offlineTimer.unref();

  for (const device of store.state.devices) updateDevicePresence(device);
  const presenceTimer = options.listen === false ? undefined : setInterval(() => void refreshTailscalePresence(), 15_000);
  presenceTimer?.unref();
  if (options.listen !== false) void refreshTailscalePresence();

  const collaborationTimer = setInterval(() => {
    const participantCutoff = Date.now() - 45_000;
    for (const session of store.state.sessions) {
      const previousCount = session.participants?.length ?? 0;
      session.participants = (session.participants ?? []).filter((item) => new Date(item.lastSeenAt).getTime() >= participantCutoff);
      const previousController = session.controllerClientId;
      ensureSessionController(session);
      if (session.participants.length !== previousCount || session.controllerClientId !== previousController) {
        publishCodexSession(session);
      }
    }
    for (const project of store.state.projects) {
      const preview = project.preview;
      if (!preview?.stopAfterMinutes || preview.status !== 'running' || !preview.lastActivityAt) continue;
      if (Date.now() - new Date(preview.lastActivityAt).getTime() < preview.stopAfterMinutes * 60_000) continue;
      void stopProjectPreview(project, 'inactivity').catch(() => undefined);
    }
  }, 10_000);
  collaborationTimer.unref();

  if (options.listen !== false) await app.listen({ host, port });

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(offlineTimer);
    clearInterval(collaborationTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    codexUpdateCoalescer.clear();
    v2Runtime?.stop();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fleet Core stopped.')); }
    pending.clear();
    for (const socket of [...clientSockets, ...agentSockets.values()]) socket.close(1001, 'Fleet Core shutdown');
    await app.close();
    await store.close();
  }

  return { app, store, host, port, url: coreUrl, ...(localCredential.path ? { recoveryTokenPath: localCredential.path } : {}), close, stop: close };
}

function policyActionForRequest(method: string, pathName: string): { action: string; resourceType: string } | undefined {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) || !pathName.startsWith('/api/')) return undefined;
  if (pathName === '/api/v2/enrollment/exchange' || pathName === '/api/v2/telemetry' || pathName === '/api/v2/alert-events') return undefined;
  const path = pathName.toLowerCase();
  if (path.includes('/power')) return { action: 'devices.power', resourceType: 'device' };
  if (path.includes('/device-profiles/')) return { action: 'devices.manage', resourceType: 'device' };
  if (path.includes('/secrets/')) {
    if (/\/(?:read|reveal)$/.test(path)) return { action: 'secrets.read', resourceType: 'secret' };
    return { action: method === 'DELETE' ? 'secrets.delete' : 'secrets.manage', resourceType: 'secret' };
  }
  if (path === '/api/v2/secrets') return { action: 'secrets.manage', resourceType: 'secret' };
  if (path.startsWith('/api/jobs')) {
    if (path.endsWith('/cancel')) return { action: 'jobs.cancel', resourceType: 'job' };
    if (path.endsWith('/assign')) return { action: 'jobs.assign', resourceType: 'job' };
    return { action: 'jobs.execute', resourceType: 'job' };
  }
  if (path.includes('/pipeline')) {
    if (path.endsWith('/approve')) return { action: 'pipelines.approve', resourceType: 'pipeline' };
    if (path.endsWith('/cancel')) return { action: 'pipelines.cancel', resourceType: 'pipeline' };
    if (path.endsWith('/run') || path.endsWith('/resume') || path.endsWith('/retry') || path.endsWith('/fire')) return { action: 'pipelines.execute', resourceType: 'pipeline' };
  }
  if (path.includes('/transfers')) return { action: path.endsWith('/cancel') ? 'artifacts.transfer.cancel' : 'artifacts.transfer', resourceType: 'artifact-transfer' };
  if (path.includes('/artifacts') && (path.endsWith('/promote') || path.endsWith('/archive'))) return { action: 'artifacts.promote', resourceType: 'artifact' };
  if (path.includes('/desktop-sessions')) return { action: path.endsWith('/close') ? 'desktops.close' : 'desktops.open', resourceType: 'desktop-session' };
  if (path.startsWith('/api/terminals')) return { action: path === '/api/terminals' ? 'terminals.open' : 'terminals.control', resourceType: 'terminal' };
  if (path.includes('/workspace/directories')) return { action: 'codex.sessions.start', resourceType: 'codex-session' };
  if (path.startsWith('/api/sessions')) return { action: path === '/api/sessions' ? 'codex.sessions.start' : 'codex.sessions.control', resourceType: 'codex-session' };
  if (path.includes('/backups') && path.endsWith('/restore')) return { action: 'backups.restore', resourceType: 'backup' };
  if (path.includes('/update-rollouts')) return { action: 'agents.update', resourceType: 'update-rollout' };
  if (path.includes('/device-credentials') || path.includes('/enrollment')) return { action: 'devices.enroll', resourceType: 'device' };
  if (path.includes('/decommission')) return { action: 'devices.decommission', resourceType: 'device' };
  if (path.includes('/agent-teams')) return { action: 'agents.orchestrate', resourceType: 'agent-team' };
  if (path.includes('/notifications')) return { action: 'notifications.send', resourceType: 'notification' };
  const segments = pathName.split('/').filter(Boolean);
  const family = (segments[1] === 'v2' ? segments[2] : segments[1])?.replace(/[^A-Za-z0-9-]/g, '') || 'fleet';
  const operation = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
  return { action: `${family}.${operation}`, resourceType: family.replace(/s$/, '') };
}

interface PolicyResourceDetails {
  resourceId?: string;
  projectId?: string;
  deviceId?: string;
  deviceGroupIds?: string[];
  workspaceId?: string;
  environment?: string;
  dataClassification?: string;
}

function policyResourceContexts(store: FleetStore, request: FastifyRequest, resourceType: string): PolicyResourceDetails[] {
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
  const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};
  const routeId = typeof params.id === 'string' ? params.id : typeof params.deviceId === 'string' ? params.deviceId : undefined;
  let projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
  const deviceIds = new Set<string>();
  if (typeof body.deviceId === 'string') deviceIds.add(body.deviceId);
  if (Array.isArray(body.deviceIds)) for (const id of body.deviceIds) if (typeof id === 'string') deviceIds.add(id);
  for (const location of [body.source, body.destination]) {
    if (!location || typeof location !== 'object') continue;
    const candidate = location as Record<string, unknown>;
    for (const deviceId of artifactLocationDeviceIds({
      deviceId: typeof candidate.deviceId === 'string' ? candidate.deviceId : undefined,
      providerId: typeof candidate.providerId === 'string' ? candidate.providerId : undefined,
    }, store.state.v2.storageConnections)) deviceIds.add(deviceId);
  }
  if (resourceType === 'device' && routeId) deviceIds.add(routeId);
  if (resourceType === 'job' && routeId) {
    const job = store.state.jobs.find((candidate) => candidate.id === routeId);
    if (job?.deviceId) deviceIds.add(job.deviceId);
    projectId ??= job?.projectId;
  }
  if (resourceType === 'codex-session' && routeId) {
    const session = store.state.sessions.find((candidate) => candidate.id === routeId);
    if (session?.deviceId) deviceIds.add(session.deviceId);
    projectId ??= session?.projectId;
  }
  if (resourceType === 'terminal' && routeId) {
    const terminal = store.state.terminals.find((candidate) => candidate.id === routeId);
    if (terminal?.deviceId) deviceIds.add(terminal.deviceId);
  }
  if (resourceType === 'desktop-session' && routeId) {
    const session = store.state.v2.desktopSessions.find((candidate) => candidate.id === routeId);
    if (session?.deviceId) deviceIds.add(session.deviceId);
  }
  if (resourceType === 'pipeline' && routeId) {
    const direct = store.state.v2.pipelines.find((candidate) => candidate.id === routeId);
    const run = direct ? undefined : store.state.v2.pipelineRuns.find((candidate) => candidate.id === routeId);
    const pipeline = direct ?? (run ? store.state.v2.pipelines.find((candidate) => candidate.id === run.pipelineId) : undefined);
    projectId ??= pipeline?.projectId;
  }
  if (resourceType === 'project') {
    if (routeId) projectId ??= routeId;
  }
  let resourceClassification: string | undefined;
  if (resourceType === 'artifact-transfer' && routeId) {
    const transfer = store.state.v2.transfers.find((candidate) => candidate.id === routeId);
    if (transfer) for (const deviceId of artifactTransferDeviceIds(transfer, store.state.v2.storageConnections)) deviceIds.add(deviceId);
    const artifact = transfer?.artifactId ? store.state.v2.artifacts.find((candidate) => candidate.id === transfer.artifactId) : undefined;
    projectId ??= artifact?.projectId;
    resourceClassification = artifact?.classification;
  }
  if (resourceType === 'update-rollout' && routeId) {
    const rollout = store.state.v2.updateRollouts.find((candidate) => candidate.id === routeId);
    for (const id of rollout?.deviceIds ?? []) deviceIds.add(id);
    for (const groupId of rollout?.groupIds ?? []) for (const id of store.state.v2.groups.find((group) => group.id === groupId)?.deviceIds ?? []) deviceIds.add(id);
  }
  if (resourceType === 'artifact' && routeId) { const artifact = store.state.v2.artifacts.find((candidate) => candidate.id === routeId); projectId ??= artifact?.projectId; resourceClassification = artifact?.classification; }
  if (resourceType === 'artifact' && !routeId && typeof body.classification === 'string') resourceClassification = body.classification;
  const resourceGroupIds = resourceType === 'group' && routeId ? [routeId] : [];
  const project = projectId ? store.state.projects.find((candidate) => candidate.id === projectId) : undefined;
  const requestedWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const workspaceId = requestedWorkspaceId ?? project?.workspaceId ?? (projectId ? store.state.v2.workspaces[0]?.id : undefined);
  const environment = typeof body.environment === 'string' ? body.environment : undefined;
  const base = { resourceId: routeId, projectId, workspaceId, environment, dataClassification: resourceClassification, deviceGroupIds: resourceGroupIds.length ? resourceGroupIds : undefined };
  if (!deviceIds.size) return [base];
  return [...deviceIds].map((deviceId) => {
    const profile = store.state.v2.deviceProfiles.find((candidate) => candidate.deviceId === deviceId);
    return { ...base, deviceId, deviceGroupIds: [...new Set([...deviceGroupIdsFor(store, deviceId), ...resourceGroupIds])], dataClassification: resourceClassification ?? profile?.dataClassification };
  });
}

function deviceGroupIdsFor(store: FleetStore, deviceId: string): string[] {
  const profileIds = store.state.v2.deviceProfiles.find((candidate) => candidate.deviceId === deviceId)?.groupIds ?? [];
  const declaredIds = store.state.v2.groups.filter((group) => group.deviceIds.includes(deviceId)).map((group) => group.id);
  return [...new Set([...profileIds, ...declaredIds])];
}

function authorized(request: FastifyRequest, token: string): boolean {
  if (!token) return false;
  return safeEqual(suppliedToken(request), token);
}

function suppliedToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const protocolHeader = request.headers['sec-websocket-protocol'];
  const encodedProtocol = typeof protocolHeader === 'string'
    ? protocolHeader.split(',').map((value) => value.trim()).find((value) => value.startsWith('fleet-token.'))?.slice('fleet-token.'.length)
    : undefined;
  let protocolToken = '';
  if (encodedProtocol) { try { protocolToken = Buffer.from(encodedProtocol, 'base64url').toString('utf8'); } catch { /* invalid protocol credential */ } }
  return bearer ?? protocolToken;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function apiScopeAllowed(scopes: string[], method: string, url: string): boolean {
  const access = method === 'GET' || method === 'HEAD' ? 'read' : 'write'; const path = url.split('?')[0] ?? url;
  const allows = (family: string, level = access) => scopes.includes('*') || scopes.includes('admin:*') || scopes.includes(`admin:${level}`) || scopes.includes(`${family}:*`) || scopes.includes(`${family}:${level}`);
  if (!(scopes.includes('*') || scopes.includes('admin:*') || scopes.includes('fleet:*') || scopes.includes(`fleet:${access}`) || scopes.includes(access))) return false;
  if (path.includes('/secrets')) { const secretAccess = /\/(read|reveal)$/.test(path) || access === 'read' ? 'read' : 'write'; return allows('secrets', secretAccess); }
  if (path.includes('/power')) return allows('power', 'write');
  if (path.includes('/enrollment') || path.includes('/device-credentials')) return allows('enrollment', access);
  if (path.includes('/api-tokens')) return allows('tokens', access);
  if (path.includes('/policies')) return allows('policies', access);
  return true;
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isBase64Key(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || /\s/.test(value)) return false;
  try { return Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64').length === bytes; }
  catch { return false; }
}

function isLoopbackOrigin(origin: string): boolean {
  try { return isLoopbackHost(new URL(origin).hostname); } catch { return false; }
}

function backfillCodexSessionTitles(store: FleetStore): void {
  let changed = false;
  for (const session of store.state.sessions) {
    if (session.kind === 'fleet-system' || session.titleSource === 'manual') continue;
    if (session.titleSource === undefined && !isGenericCodexSessionTitle(session.title)) {
      session.titleSource = 'manual';
      changed = true;
      continue;
    }
    const hasUserContext = session.events.some((event) => event.type === 'user' && event.text.trim());
    if (!hasUserContext) continue;
    const title = contextualCodexSessionTitleFromEvents(session.events, session.title);
    if (title !== session.title || session.titleSource !== 'generated') {
      session.title = title;
      session.titleSource = 'generated';
      changed = true;
    }
  }
  if (changed) store.markDirty();
}

function defaultDataDirectory(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Fleet Canvas', 'core');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Fleet Canvas', 'core');
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'fleet-canvas', 'core');
}

async function loadOrCreateLocalRecoveryToken(dataDir: string): Promise<{ token: string; path: string }> {
  const tokenPath = path.join(dataDir, 'recovery-token');
  try {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    if (token.length >= 32) return { token, path: tokenPath };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const temporary = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, tokenPath);
  return { token, path: tokenPath };
}

function integer(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}

function defaultPosition(index: number): { x: number; y: number } {
  return { x: 80 + (index % 3) * 330, y: 90 + Math.floor(index / 3) * 260 };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function workspaceAgentError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/outside configured project roots|escaped configured project roots|symbolic links? is not allowed/i.test(message)) {
    return httpError(403, message);
  }
  return error instanceof Error ? error : httpError(502, message);
}

function requireDevice(store: FleetStore, id: string): Device {
  const device = store.state.devices.find((item) => item.id === id);
  if (!device) throw httpError(404, 'Device not found.');
  return device;
}

function requireOnlineDevice(store: FleetStore, sockets: Map<string, WebSocket>, id: string): Device {
  const device = requireDevice(store, id);
  if (!sockets.has(id) || device.status === 'offline') throw httpError(409, `Device is offline: ${device.name}`);
  return device;
}

function requireProject(store: FleetStore, id: string): FleetProject {
  const project = store.state.projects.find((item) => item.id === id);
  if (!project) throw httpError(404, 'Project not found.');
  return project;
}

function requireJob(store: FleetStore, id: string): FleetJob {
  const job = store.state.jobs.find((item) => item.id === id);
  if (!job) throw httpError(404, 'Job not found.');
  return job;
}

function requireTerminal(store: FleetStore, id: string): TerminalSession {
  const terminal = store.state.terminals.find((item) => item.id === id);
  if (!terminal) throw httpError(404, 'Terminal not found.');
  return terminal;
}

function requireSession(store: FleetStore, id: string): CodexSession {
  const session = store.state.sessions.find((item) => item.id === id);
  if (!session) throw httpError(404, 'Codex session not found.');
  return session;
}

function codexSandboxPolicy(permissionMode: PermissionMode, cwd: string): Record<string, unknown> {
  if (permissionMode === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (permissionMode === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: 'dangerFullAccess' };
}

function permissionModeLabel(permissionMode: PermissionMode): string {
  if (permissionMode === 'read-only') return 'read-only';
  if (permissionMode === 'workspace-write') return 'workspace-write';
  return 'full-access';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeCodexUiRpcParams(method: z.infer<typeof codexUiRpcMethodSchema>, params: unknown): unknown {
  if (method !== 'thread/settings/update') return params;
  const settings = recordValue(params);
  const collaborationMode = recordValue(settings.collaborationMode);
  const collaborationSettings = recordValue(collaborationMode.settings);
  const directModel = normalizedRpcModel(settings, 'model');
  const collaborationModel = normalizedRpcModel(collaborationSettings, 'model');

  return {
    ...settings,
    ...(directModel ? { model: directModel } : {}),
    ...('collaborationMode' in settings ? {
      collaborationMode: {
        ...collaborationMode,
        ...('settings' in collaborationMode ? {
          settings: {
            ...collaborationSettings,
            ...(collaborationModel ? { model: collaborationModel } : {}),
          },
        } : {}),
      },
    } : {}),
  };
}

function normalizedRpcModel(container: Record<string, unknown>, key: string): string | undefined {
  if (!(key in container)) return undefined;
  const value = container[key];
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'Codex model must be a non-empty model identifier.');
  if (value.trim().length > 240) throw httpError(400, 'Codex model must be 240 characters or fewer.');
  return value.trim();
}

function codexEventsThroughTurn(events: CodexEvent[], turnId: string): CodexEvent[] {
  let boundary = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (codexEventTurnId(events[index]!) === turnId) { boundary = index; break; }
  }
  return boundary < 0 ? events : events.slice(0, boundary + 1);
}

function codexEventTurnId(event: CodexEvent): string | undefined {
  return stringForKey(event.data, 'turnId') ?? stringForKey(event.data, 'id', 'turn');
}

function stringForKey(value: unknown, key: string, parentKey?: string, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = stringForKey(entry, key, parentKey, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (!parentKey && typeof object[key] === 'string') return object[key] as string;
  if (parentKey) {
    const parent = recordValue(object[parentKey]);
    if (typeof parent[key] === 'string') return parent[key] as string;
  }
  for (const entry of Object.values(object)) {
    const found = stringForKey(entry, key, parentKey, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function presenceFingerprint(presence: Device['presence']): string {
  if (!presence) return '';
  return [
    presence.summary,
    presence.label,
    presence.agent.state,
    presence.tailscale.state,
    presence.lan.state,
    presence.services.state,
    presence.services.detail,
  ].join('\0');
}

function isUnknownCodexSessionError(error: unknown): boolean {
  return error instanceof Error && /^Unknown Codex session:/.test(error.message);
}

function codexActiveTurnIdFromMismatch(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /expected active turn id `[^`]+` but found `([^`]+)`/i.exec(error.message)?.[1];
}

function statusPhase(status: FleetJob['status']): string {
  return status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : status === 'cancelled' ? 'Cancelled' : status === 'failed' ? 'Failed' : status;
}
