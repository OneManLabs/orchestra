export type DeviceRole = 'core' | 'gpu' | 'worker' | 'gateway' | 'storage' | 'workstation' | 'phone' | 'unknown';
export type DeviceStatus = 'online' | 'busy' | 'degraded' | 'offline';
export type JobStatus = 'queued' | 'dispatching' | 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'codex' | 'shell';
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CpuMetrics {
  model: string;
  cores: number;
  usagePercent: number;
  temperatureCelsius?: number;
}

export interface MemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  usagePercent: number;
}

export interface StorageMetrics {
  totalBytes: number;
  usedBytes: number;
  usagePercent: number;
  mount: string;
}

export interface GpuMetrics {
  vendor: string;
  model: string;
  vramTotalBytes?: number;
  vramUsedBytes?: number;
  usagePercent?: number;
  temperatureCelsius?: number;
  fanSpeedPercent?: number;
  powerDrawWatts?: number;
  powerLimitWatts?: number;
}

export interface NetworkMetrics {
  rxBytesPerSecond: number;
  txBytesPerSecond: number;
  tailscaleIp?: string;
  tailscaleDnsName?: string;
}

export interface BatteryMetrics {
  state: 'charging' | 'discharging' | 'full' | 'connected' | 'unknown';
  percent: number;
  isCharging: boolean;
  acConnected: boolean;
  timeRemainingMinutes?: number;
  cycleCount?: number;
}

export interface FanMetrics {
  label: string;
  speedPercent?: number;
  speedRpm?: number;
}

export interface ServiceHealthMetrics {
  total: number;
  running: number;
  stopped: number;
}

export interface DeviceCapabilities {
  codex: boolean;
  git: boolean;
  docker: boolean;
  tailscale: boolean;
  cuda: boolean;
  mlx: boolean;
  node: boolean;
  wakeOnLan: boolean;
  shell: string;
  labels: string[];
}

export interface DeviceMetrics {
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  storage: StorageMetrics[];
  gpus: GpuMetrics[];
  network: NetworkMetrics;
  battery?: BatteryMetrics;
  powerDrawWatts?: number;
  powerDrawSource?: 'gpu';
  fans?: FanMetrics[];
  processCount?: number;
  runningProcessCount?: number;
  serviceHealth?: ServiceHealthMetrics;
  uptimeSeconds: number;
  sampledAt: string;
}

export type DevicePresenceLayerState = 'reachable' | 'unreachable' | 'stale' | 'unknown' | 'not-configured';
export type DevicePresenceSummary = 'operational' | 'degraded' | 'agent-offline' | 'host-unreachable' | 'unknown';

export interface DevicePresenceLayer {
  state: DevicePresenceLayerState;
  checkedAt: string;
  detail: string;
}

/**
 * Evidence-backed reachability projection. `status` remains the scheduling
 * state; presence explains which layer is actually healthy or missing.
 */
export interface DevicePresence {
  summary: DevicePresenceSummary;
  label: string;
  detail: string;
  updatedAt: string;
  agent: DevicePresenceLayer;
  tailscale: DevicePresenceLayer;
  lan: DevicePresenceLayer;
  services: DevicePresenceLayer;
}

export interface Device {
  id: string;
  name: string;
  hostname: string;
  role: DeviceRole;
  status: DeviceStatus;
  platform: NodeJS.Platform | string;
  arch: string;
  osName: string;
  osVersion: string;
  agentVersion: string;
  capabilities: DeviceCapabilities;
  metrics: DeviceMetrics;
  projectRoots: string[];
  position: { x: number; y: number };
  lastSeenAt: string;
  connectedAt: string;
  activeJobIds: string[];
  activeSessionIds: string[];
  presence?: DevicePresence;
}

export interface ProjectPath {
  deviceId: string;
  path: string;
}

export type ProjectPreviewStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'offline' | 'error';
export type ProjectPreviewVisibility = 'tailnet' | 'public';
export type ProjectPreviewTransport = 'tailscale-serve' | 'tailscale-funnel' | 'direct-tailnet';

export interface ProjectPreviewLog {
  id: string;
  at: string;
  stream: 'system' | 'stdout' | 'stderr';
  text: string;
}

export interface ProjectPreviewHealth {
  state: 'starting' | 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  checkedAt: string;
  latencyMs?: number;
  statusCode?: number;
  consecutiveFailures: number;
  detail: string;
}

export interface ProjectPreview {
  projectId: string;
  deviceId: string;
  cwd: string;
  status: ProjectPreviewStatus;
  visibility: ProjectPreviewVisibility;
  framework: string;
  command: string;
  port: number;
  servePort: number;
  url?: string;
  tailscaleDnsName?: string;
  transport?: ProjectPreviewTransport;
  desiredState?: 'running' | 'stopped';
  autoStartWithCodex: boolean;
  stopAfterMinutes?: number;
  restartCount: number;
  startedAt?: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastHealthyAt?: string;
  health?: ProjectPreviewHealth;
  error?: string;
  logs: ProjectPreviewLog[];
}

export interface FleetProject {
  id: string;
  workspaceId?: string;
  name: string;
  description: string;
  repository?: string;
  defaultBranch: string;
  paths: ProjectPath[];
  preferredDeviceIds: string[];
  commands: { build?: string; test?: string; start?: string };
  artifactPaths: string[];
  preview?: ProjectPreview;
  createdAt: string;
  updatedAt: string;
}

export interface FleetJob {
  id: string;
  name: string;
  kind: JobKind;
  prompt: string;
  command?: string;
  projectId?: string;
  deviceId?: string;
  cwd?: string;
  status: JobStatus;
  permissionMode: PermissionMode;
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  requiredLabels: string[];
  progress?: number;
  phase?: string;
  exitCode?: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  output: JobOutputEvent[];
}

export interface JobOutputEvent {
  id: string;
  at: string;
  stream: 'system' | 'stdout' | 'stderr' | 'codex';
  text: string;
  raw?: unknown;
}

export type CodexSessionStatus = 'starting' | 'ready' | 'thinking' | 'awaiting-approval' | 'completed' | 'error' | 'stopped';

export type CodexParticipantPermission = 'view' | 'message' | 'approve' | 'interrupt' | 'control';

export interface CodexActor {
  clientId: string;
  name: string;
  deviceName: string;
}

export type FleetDeviceMentionStatus = 'resolved' | 'ambiguous' | 'unknown';

export interface FleetDeviceMention {
  token: string;
  alias: string;
  deviceIds: string[];
  label: string;
  status: FleetDeviceMentionStatus;
}

export type FleetSystemReferenceKind = 'device' | 'codex-session' | 'job' | 'project' | 'preview' | 'telemetry';

export interface FleetSystemReference {
  id: string;
  kind: FleetSystemReferenceKind;
  label: string;
  detail?: string;
  status?: string;
  deviceId?: string;
  sessionId?: string;
  jobId?: string;
  projectId?: string;
}

export interface FleetSystemPendingAction {
  id: string;
  kind: 'power';
  action: import('./v2-types.js').DevicePowerAction;
  deviceIds: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  requestedAt: string;
  completedAt?: string;
  error?: string;
}

export type FleetConductorPlanStatus = 'proposed' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type FleetConductorStepStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'skipped';

export interface FleetConductorStep {
  id: string;
  kind: 'codex' | 'preview';
  title: string;
  detail: string;
  status: FleetConductorStepStatus;
  deviceId?: string;
  projectId?: string;
  dependsOn: string[];
  permissionMode?: PermissionMode;
  selectionReason?: string;
  sessionId?: string;
  previewUrl?: string;
  error?: string;
}

export interface FleetConductorPlan {
  id: string;
  title: string;
  objective: string;
  status: FleetConductorPlanStatus;
  createdAt: string;
  updatedAt: string;
  actor?: CodexActor;
  steps: FleetConductorStep[];
}

export interface FleetSystemMessage {
  id: string;
  at: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  actor?: CodexActor;
  mentions: FleetDeviceMention[];
  references: FleetSystemReference[];
  pendingActionId?: string;
  conductorPlanId?: string;
}

export interface FleetSystemConversation {
  id: string;
  title: string;
  orchestratorDeviceId?: string;
  codexSessionId?: string;
  status?: CodexSessionStatus;
  activeResponseMessageId?: string;
  error?: string;
  messages: FleetSystemMessage[];
  pendingActions: FleetSystemPendingAction[];
  conductorPlans: FleetConductorPlan[];
  updatedAt: string;
}

export interface CodexParticipant extends CodexActor {
  permissions: CodexParticipantPermission[];
  typing: boolean;
  connectedAt: string;
  lastSeenAt: string;
}

export interface CodexSession {
  id: string;
  deviceId: string;
  projectId?: string;
  cwd: string;
  title: string;
  titleSource?: 'generated' | 'manual';
  kind?: 'user' | 'fleet-system';
  developerInstructions?: string;
  threadId?: string;
  turnId?: string;
  model?: string;
  permissionMode: PermissionMode;
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  status: CodexSessionStatus;
  createdAt: string;
  updatedAt: string;
  events: CodexEvent[];
  pendingApprovals: CodexApproval[];
  participants?: CodexParticipant[];
  controllerClientId?: string;
  controllerUpdatedAt?: string;
  error?: string;
}

export type CodexSessionLineageOperation = 'created' | 'resumed' | 'forked' | 'moved';

export interface CodexSessionLineageEvent {
  id: string;
  operation: CodexSessionLineageOperation;
  at: string;
  fromSessionId?: string;
  fromDeviceId?: string;
  toDeviceId: string;
  sourceThreadId?: string;
  threadId?: string;
}

export interface CodexEvent {
  id: string;
  at: string;
  type: 'user' | 'assistant' | 'reasoning' | 'command' | 'file' | 'tool' | 'plan' | 'status' | 'error' | 'raw';
  text: string;
  method?: string;
  data?: unknown;
  actor?: CodexActor;
}

export interface CodexApproval {
  id: string;
  requestId: string | number;
  method: string;
  title: string;
  detail: string;
  params: unknown;
  createdAt: string;
}

export interface TerminalSession {
  id: string;
  deviceId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  status: 'starting' | 'open' | 'closed' | 'error';
  exitCode?: number;
}

export interface ActivityEvent {
  id: string;
  at: string;
  type: 'device' | 'job' | 'session' | 'terminal' | 'project' | 'security' | 'system';
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
  deviceId?: string;
  entityId?: string;
}

export interface FleetSettings {
  fleetName: string;
  coreUrl: string;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  retainActivityDays: number;
  autoStartLocalAgent: boolean;
  systemOrchestratorDeviceId?: string;
}

export interface FleetSnapshot {
  version: string;
  now: string;
  devices: Device[];
  projects: FleetProject[];
  jobs: FleetJob[];
  sessions: CodexSession[];
  terminals: TerminalSession[];
  activity: ActivityEvent[];
  settings: FleetSettings;
  systemConversation: FleetSystemConversation;
  systemConversations?: FleetSystemConversation[];
  v2: import('./v2-types.js').FleetV2Snapshot;
}
