import type {
  AgentTeam,
  AlertRule,
  ArtifactTransfer,
  ArtifactVersion,
  BackupRecord,
  CodexSession,
  CodexParticipant,
  CodexUiRpcMethod,
  DataClassification,
  Device,
  DeviceGroup,
  DevicePowerAction,
  DiagnosticReport,
  FleetAlert,
  FleetArtifact,
  FleetJob,
  FleetPlugin,
  FleetPolicy,
  FleetProject,
  FleetSettings,
  FleetSnapshot,
  FleetSystemConversation,
  NotificationChannel,
  PermissionMode,
  PipelineDefinition,
  PipelineRun,
  RemoteDesktopSession,
  SecretMetadata,
  StorageConnection,
  TerminalSession
} from '@fleet/shared';
import type { StorageBrowserPage } from './storage-browser-state.js';
import { fleetCoreRequestError } from '../../core-request-error.js';

export type ApiOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown };
export interface CodexClientIdentity { clientId: string; name: string; deviceName: string }
export interface DeviceWorkspaceEntry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  sizeBytes: number;
  modifiedAt: string;
}
export interface DeviceWorkspacePage {
  path: string;
  entries: DeviceWorkspaceEntry[];
  nextCursor?: string;
  total: number;
}

const defaultBrowserCoreUrl = (() => {
  const configured = import.meta.env.VITE_FLEET_CORE_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin;
  return 'http://127.0.0.1:4780';
})();
let browserCoreUrl = typeof sessionStorage === 'undefined' ? defaultBrowserCoreUrl : (sessionStorage.getItem('fleet.coreUrl') ?? defaultBrowserCoreUrl);
let browserToken: string | undefined;
let identityPromise: Promise<CodexClientIdentity> | undefined;

export function codexClientIdentity(): Promise<CodexClientIdentity> {
  identityPromise ??= (async () => {
    const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
    let clientId = storage?.getItem('fleet.codexClientId');
    if (!clientId) {
      clientId = globalThis.crypto?.randomUUID?.() ?? `fleet-client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      storage?.setItem('fleet.codexClientId', clientId);
    }
    const deviceName = window.fleetDesktop
      ? await window.fleetDesktop.clientDeviceName()
      : `${navigator.platform || 'Browser'} web app`;
    const name = storage?.getItem('fleet.participantName')?.trim() || 'Nick';
    return { clientId, name, deviceName };
  })();
  return identityPromise;
}

export function configureBrowserConnection(coreUrl: string, token: string): void {
  const parsed = new URL(coreUrl.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Core URL must be an HTTP(S) origin without embedded credentials.');
  browserCoreUrl = parsed.origin;
  browserToken = token.trim() || undefined;
  sessionStorage.setItem('fleet.coreUrl', browserCoreUrl);
}

export function browserConnectionDefaults(): { coreUrl: string } { return { coreUrl: browserCoreUrl }; }

async function browserRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(`${browserCoreUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(browserToken ? { authorization: `Bearer ${browserToken}` } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) {
    throw new Error(fleetCoreRequestError(path, response.status, payload));
  }
  return payload as T;
}

export function request<T>(path: string, options?: ApiOptions): Promise<T> {
  return window.fleetDesktop?.request<T>(path, options) ?? browserRequest<T>(path, options);
}

export async function connectClientEvents(
  onMessage: (value: string) => void,
  onConnection: (online: boolean) => void
): Promise<() => void> {
  if (window.fleetDesktop) {
    const offEvent = window.fleetDesktop.onEvent(onMessage);
    const offConnection = window.fleetDesktop.onConnection(onConnection);
    onConnection(await window.fleetDesktop.connectionState());
    return () => { offEvent(); offConnection(); };
  }

  let stopped = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(`${browserCoreUrl.replace(/^http/, 'ws')}/ws/client`, browserToken ? [websocketTokenProtocol(browserToken)] : []);
    socket.onopen = () => onConnection(true);
    socket.onmessage = (event) => onMessage(String(event.data));
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      onConnection(false);
      if (!stopped) timer = setTimeout(connect, 1_500);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}

function websocketTokenProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `fleet-token.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

export const api = {
  snapshot: () => request<FleetSnapshot>('/api/snapshot'),
  systemConversation: () => request<FleetSystemConversation>('/api/system'),
  sendSystemMessage: async (text: string, mode: 'chat' | 'conductor' = 'chat') =>
    request<FleetSystemConversation>('/api/system/messages', { method: 'POST', body: { text, mode, client: await codexClientIdentity() } }),
  newSystemConversation: async () =>
    request<FleetSystemConversation>('/api/system/new', { method: 'POST', body: { client: await codexClientIdentity() } }),
  clearSystemConversation: async () =>
    request<FleetSystemConversation>('/api/system/clear', { method: 'POST', body: { client: await codexClientIdentity() } }),
  confirmSystemPowerAction: async (id: string, action: DevicePowerAction, deviceIds: string[]) =>
    request<{ action: FleetSystemConversation['pendingActions'][number]; results: Array<{ deviceId: string; targetId?: string; error?: string }> }>(
      `/api/system/power-actions/${encodeURIComponent(id)}/confirm`,
      { method: 'POST', body: { action, deviceIds, client: await codexClientIdentity() } }
    ),
  executeConductorPlan: async (id: string) =>
    request<FleetSystemConversation['conductorPlans'][number]>(`/api/system/conductor/plans/${encodeURIComponent(id)}/execute`, { method: 'POST', body: { client: await codexClientIdentity() } }),
  cancelConductorPlan: async (id: string) =>
    request<FleetSystemConversation['conductorPlans'][number]>(`/api/system/conductor/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { client: await codexClientIdentity() } }),
  updateDevice: (id: string, patch: Partial<Pick<Device, 'name' | 'role' | 'position'>>) =>
    request<Device>(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  listDeviceWorkspace: (deviceId: string, path: string, cursor?: string) =>
    request<DeviceWorkspacePage>(`/api/devices/${encodeURIComponent(deviceId)}/workspace?path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  createDeviceWorkspaceDirectory: (deviceId: string, path: string) =>
    request<{ path: string; created: true }>(`/api/devices/${encodeURIComponent(deviceId)}/workspace/directories`, { method: 'POST', body: { path } }),
  createProject: (project: Partial<FleetProject>) => request<FleetProject>('/api/projects', { method: 'POST', body: project }),
  updateProject: (id: string, project: Partial<FleetProject>) => request<FleetProject>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: project }),
  deleteProject: (id: string) => request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  startProjectPreview: (id: string, input: { deviceId?: string; port?: number; visibility?: 'tailnet' | 'public'; confirmPublic?: boolean; autoStartWithCodex?: boolean; stopAfterMinutes?: number } = {}) =>
    request<FleetProject['preview']>(`/api/projects/${encodeURIComponent(id)}/preview/start`, { method: 'POST', body: input }),
  stopProjectPreview: (id: string) => request<FleetProject['preview']>(`/api/projects/${encodeURIComponent(id)}/preview/stop`, { method: 'POST', body: {} }),
  touchProjectPreview: (id: string) => request<FleetProject['preview']>(`/api/projects/${encodeURIComponent(id)}/preview/activity`, { method: 'POST', body: {} }),
  createJob: (job: {
    name: string; kind: 'codex' | 'shell'; prompt?: string; command?: string; deviceId?: string;
    projectId?: string; cwd?: string; permissionMode: PermissionMode; approvalPolicy: 'untrusted' | 'on-request' | 'never'; requiredLabels?: string[];
  }) => request<FleetJob>('/api/jobs', { method: 'POST', body: job }),
  startJob: (id: string) => request<FleetJob>(`/api/jobs/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  assignJob: (id: string, deviceId: string) => request<FleetJob>(`/api/jobs/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { deviceId } }),
  cancelJob: (id: string) => request<FleetJob>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  createTerminal: (data: { deviceId: string; cwd: string; cols: number; rows: number }) =>
    request<TerminalSession>('/api/terminals', { method: 'POST', body: data }),
  terminalInput: (id: string, data: string) => request<void>(`/api/terminals/${encodeURIComponent(id)}/input`, { method: 'POST', body: { data } }),
  terminalResize: (id: string, cols: number, rows: number) => request<void>(`/api/terminals/${encodeURIComponent(id)}/resize`, { method: 'POST', body: { cols, rows } }),
  stopTerminal: (id: string) => request<void>(`/api/terminals/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  createSession: (data: {
    deviceId: string; projectId?: string; cwd: string; title: string;
    permissionMode: PermissionMode; approvalPolicy: 'untrusted' | 'on-request' | 'never';
  }) => request<CodexSession>('/api/sessions', { method: 'POST', body: data }),
  updateSessionPermission: async (id: string, permissionMode: PermissionMode) =>
    request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/permissions`, {
      method: 'PATCH',
      body: { permissionMode, client: await codexClientIdentity() },
    }),
  updatePresence: async (id: string, typing = false) => request<{ participant: CodexParticipant; controllerClientId?: string }>(`/api/sessions/${encodeURIComponent(id)}/presence`, { method: 'POST', body: { ...(await codexClientIdentity()), typing } }),
  leavePresence: async (id: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}/presence`, { method: 'DELETE', body: { clientId: (await codexClientIdentity()).clientId } }),
  requestControl: async (id: string, force = false) => request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/control`, { method: 'POST', body: { ...(await codexClientIdentity()), force } }),
  sendMessage: async (id: string, text: string) => request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text, client: await codexClientIdentity() } }),
  codexRpc: <T = unknown>(id: string, method: CodexUiRpcMethod, params?: unknown) =>
    request<{ result: T; session: CodexSession }>(`/api/sessions/${encodeURIComponent(id)}/rpc`, { method: 'POST', body: { method, params } }),
  respondApproval: async (id: string, requestId: string | number, result: unknown) =>
    request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/respond`, { method: 'POST', body: { requestId, result, client: await codexClientIdentity() } }),
  resumeSession: (id: string) => request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }),
  forkSession: (id: string, data: { deviceId?: string; title?: string; lastTurnId?: string }) =>
    request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: 'POST', body: data }),
  moveSession: (id: string, deviceId: string) =>
    request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/move`, { method: 'POST', body: { deviceId } }),
  interruptSession: async (id: string) => request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST', body: { client: await codexClientIdentity() } }),
  stopSession: (id: string) => request<CodexSession>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  updateSettings: (settings: Partial<FleetSettings>) => request<FleetSettings>('/api/settings', { method: 'PATCH', body: settings })
};

type V2Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const v2 = <T>(path: string, method: V2Method = 'GET', body?: unknown) => request<T>(`/api/v2${path}`, { method, body });

export const apiV2 = {
  powerDevices: (deviceIds: string[], action: DevicePowerAction) => v2<{ action: DevicePowerAction; results: Array<{ deviceId: string; targetId?: string; result?: unknown; error?: string }> }>('/devices/power', 'POST', { deviceIds, action }),
  createEnrollmentToken: ({ expiresInHours, ...body }: { label: string; role?: string; groupIds: string[]; updateChannel: string; expiresInHours: number; maxUses: number }) => v2<{ token: string; enrollmentUrl: string; record: unknown }>('/enrollment/tokens', 'POST', { ...body, expiresInSeconds: expiresInHours * 3_600 }),
  revokeEnrollmentToken: (id: string) => v2<void>(`/enrollment/tokens/${encodeURIComponent(id)}`, 'DELETE'),
  createGroup: (body: Pick<DeviceGroup, 'name' | 'description' | 'color' | 'deviceIds'>) => v2<DeviceGroup>('/groups', 'POST', body),
  updateGroup: (id: string, body: Partial<DeviceGroup>) => v2<DeviceGroup>(`/groups/${encodeURIComponent(id)}`, 'PATCH', body),
  deleteGroup: (id: string) => v2<void>(`/groups/${encodeURIComponent(id)}`, 'DELETE'),
  updateDeviceProfile: (deviceId: string, body: Record<string, unknown>) => v2(`/device-profiles/${encodeURIComponent(deviceId)}`, 'PUT', body),
  createRollout: (body: Record<string, unknown>) => v2('/update-rollouts', 'POST', body),
  rolloutAction: (id: string, action: 'run' | 'pause' | 'resume' | 'rollback') => v2(`/update-rollouts/${encodeURIComponent(id)}/${action}`, 'POST'),
  createArtifact: (body: { name: string; description: string; kind: string; projectId?: string; tags: string[]; classification: DataClassification }) => v2<FleetArtifact>('/artifacts', 'POST', body),
  updateArtifact: (id: string, body: Partial<FleetArtifact>) => v2<FleetArtifact>(`/artifacts/${encodeURIComponent(id)}`, 'PATCH', body),
  registerArtifactVersion: (id: string, body: {
    sizeBytes: number;
    checksumSha256: string;
    mimeType?: string;
    locations: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
    createdBy?: string;
  }) => v2<ArtifactVersion>(`/artifacts/${encodeURIComponent(id)}/versions`, 'POST', body),
  promoteArtifact: (id: string, body: { environment: string; versionId?: string; confirm: true }) => v2<FleetArtifact>(`/artifacts/${encodeURIComponent(id)}/promote`, 'POST', body),
  deleteArtifact: (id: string) => v2<void>(`/artifacts/${encodeURIComponent(id)}`, 'DELETE'),
  createTransfer: (body: Record<string, unknown>) => v2<ArtifactTransfer>('/transfers', 'POST', body),
  startTransfer: (id: string) => v2<ArtifactTransfer>(`/transfers/${encodeURIComponent(id)}/start`, 'POST'),
  cancelTransfer: (id: string) => v2<ArtifactTransfer>(`/transfers/${encodeURIComponent(id)}/cancel`, 'POST'),
  createStorage: (body: Record<string, unknown>) => v2<StorageConnection>('/storage-connections', 'POST', body),
  updateStorage: (id: string, body: Partial<StorageConnection>) => v2<StorageConnection>(`/storage-connections/${encodeURIComponent(id)}`, 'PATCH', body),
  testStorage: (id: string) => v2<StorageConnection>(`/storage-connections/${encodeURIComponent(id)}/test`, 'POST'),
  listStorageFiles: (id: string, path = '', cursor = 0) => v2<StorageBrowserPage>(`/storage-connections/${encodeURIComponent(id)}/files`, 'POST', { path, cursor, limit: 200 }),
  createStorageDirectory: (id: string, path: string) => v2<{ providerId: string; path: string; created: true }>(`/storage-connections/${encodeURIComponent(id)}/directories`, 'POST', { path }),
  createPipeline: (body: Partial<PipelineDefinition>) => v2<PipelineDefinition>('/pipelines', 'POST', body),
  updatePipeline: (id: string, body: Partial<PipelineDefinition>) => v2<PipelineDefinition>(`/pipelines/${encodeURIComponent(id)}`, 'PATCH', body),
  deletePipeline: (id: string) => v2<void>(`/pipelines/${encodeURIComponent(id)}`, 'DELETE'),
  runPipeline: (id: string, parameters: Record<string, unknown> = {}) => v2<PipelineRun>(`/pipelines/${encodeURIComponent(id)}/run`, 'POST', { parameters }),
  cancelPipelineRun: (id: string) => v2<PipelineRun>(`/pipeline-runs/${encodeURIComponent(id)}/cancel`, 'POST'),
  approvePipelineNode: (runId: string, nodeRunId: string, input: Record<string, unknown> = {}) => v2<PipelineRun>(`/pipeline-runs/${encodeURIComponent(runId)}/approve`, 'POST', { nodeRunId, approved: true, input }),
  rejectPipelineNode: (runId: string, nodeRunId: string, input: Record<string, unknown> = {}) => v2<PipelineRun>(`/pipeline-runs/${encodeURIComponent(runId)}/approve`, 'POST', { nodeRunId, approved: false, input }),
  createAlertRule: (body: Partial<AlertRule>) => v2<AlertRule>('/alert-rules', 'POST', body),
  updateAlertRule: (id: string, body: Partial<AlertRule>) => v2<AlertRule>(`/alert-rules/${encodeURIComponent(id)}`, 'PATCH', body),
  alertAction: (id: string, action: 'acknowledge' | 'resolve') => v2<FleetAlert>(`/alerts/${encodeURIComponent(id)}/${action}`, 'POST'),
  verifyAudit: () => v2<{ valid: boolean; invalidSequence?: number }>('/audit/verify'),
  createSecret: (body: { name: string; description: string; value: string; scope: string; scopeId?: string; tags: string[] }) => v2<SecretMetadata>('/secrets', 'POST', body),
  rotateSecret: (id: string, value: string) => v2<SecretMetadata>(`/secrets/${encodeURIComponent(id)}/rotate`, 'POST', { value }),
  deleteSecret: (id: string) => v2<void>(`/secrets/${encodeURIComponent(id)}`, 'DELETE'),
  createPolicy: (body: Partial<FleetPolicy>) => v2<FleetPolicy>('/policies', 'POST', body),
  updatePolicy: (id: string, body: Partial<FleetPolicy>) => v2<FleetPolicy>(`/policies/${encodeURIComponent(id)}`, 'PATCH', body),
  createChannel: (body: Partial<NotificationChannel>) => v2<NotificationChannel>('/notification-channels', 'POST', body),
  updateChannel: (id: string, body: Partial<NotificationChannel>) => v2<NotificationChannel>(`/notification-channels/${encodeURIComponent(id)}`, 'PATCH', body),
  testChannel: (id: string) => v2(`/notification-channels/${encodeURIComponent(id)}/test`, 'POST'),
  markNotificationRead: (id: string) => v2(`/notifications/${encodeURIComponent(id)}/read`, 'POST'),
  createWebhook: (body: Record<string, unknown>) => v2('/webhooks', 'POST', body),
  testWebhook: (id: string) => v2(`/webhooks/${encodeURIComponent(id)}/test`, 'POST'),
  togglePlugin: (id: string, enabled: boolean) => v2<FleetPlugin>(`/plugins/${encodeURIComponent(id)}`, 'PATCH', { enabled }),
  createTeam: (body: {
    name: string; objective: string; projectId?: string; budgetTokens?: number; maximumRuntimeMinutes?: number; permissionMode: PermissionMode;
    tasks: Array<{ id?: string; title: string; description: string; role: string; deviceId?: string; dependsOn: string[] }>;
  }) => v2<AgentTeam>('/agent-teams', 'POST', body),
  runTeam: (id: string) => v2<AgentTeam>(`/agent-teams/${encodeURIComponent(id)}/run`, 'POST'),
  cancelTeam: (id: string) => v2<AgentTeam>(`/agent-teams/${encodeURIComponent(id)}/cancel`, 'POST'),
  createDiagnostic: ({ redacted, ...body }: { deviceId?: string; kind: DiagnosticReport['kind']; redacted: boolean }) => v2<DiagnosticReport>('/diagnostics', 'POST', { ...body, redact: redacted }),
  createBackup: () => v2<BackupRecord>('/backups', 'POST', { kind: 'manual' }),
  restoreBackup: (id: string) => v2<{ restoreStaged: true; restartRequired: true; backupId: string; preRestoreBackupId: string }>(`/backups/${encodeURIComponent(id)}/restore`, 'POST', { confirm: true }),
  startDesktop: (body: { deviceId: string; protocol?: string; viewOnly: boolean; recording: boolean }) => v2<RemoteDesktopSession>('/desktop-sessions', 'POST', body),
  closeDesktop: (id: string) => v2<RemoteDesktopSession>(`/desktop-sessions/${encodeURIComponent(id)}/close`, 'POST')
};
