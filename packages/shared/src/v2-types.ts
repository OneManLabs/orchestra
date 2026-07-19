import type { CodexSessionLineageEvent, DeviceRole, JobStatus, PermissionMode } from './types.js';

export type V2EntityStatus = 'active' | 'disabled' | 'archived';
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';
export type UpdateChannel = 'stable' | 'beta' | 'development';
export type DevicePowerAction = 'wake' | 'sleep' | 'restart' | 'shutdown' | 'lock' | 'logout';
export type ExecutionState = 'pending' | 'queued' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface DeviceGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  deviceIds: string[];
  siteId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetSite {
  id: string;
  name: string;
  description: string;
  timezone: string;
  latitude?: number;
  longitude?: number;
  securityZone?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  weekdays: number[];
}

export interface DevicePowerPolicy {
  wakeForJobs: boolean;
  sleepAfterIdleMinutes?: number;
  shutdownAfterIdleMinutes?: number;
  preventSleepDuringJobs: boolean;
  minimumBatteryPercent?: number;
  maximumTemperatureCelsius?: number;
  quietHours?: QuietHours;
  estimatedWattsIdle?: number;
  estimatedWattsBusy?: number;
  electricityCostPerKwh?: number;
}

export interface ManagedDeviceProfile {
  deviceId: string;
  displayName?: string;
  role?: DeviceRole;
  groupIds: string[];
  siteId?: string;
  wakeMacAddress?: string;
  wakeBroadcastAddress?: string;
  wakeRelayDeviceId?: string;
  powerPolicy: DevicePowerPolicy;
  updateChannel: UpdateChannel;
  maintenanceMode: boolean;
  maintenanceWindow?: { start: string; end: string; timezone: string };
  dataClassification: DataClassification;
  securityZone?: string;
  trusted: boolean;
  quarantined: boolean;
  quarantineReason?: string;
  hourlyCost?: number;
  reservedFor?: string;
  notes?: string;
  /** Last power state positively observed or accepted by Fleet. */
  powerState?: 'awake' | 'sleeping' | 'waking' | 'restarting' | 'powered-off';
  powerStateUpdatedAt?: string;
  updatedAt: string;
}

export interface EnrollmentTokenRecord {
  id: string;
  label: string;
  role?: DeviceRole;
  groupIds: string[];
  updateChannel: UpdateChannel;
  expiresAt: string;
  maxUses: number;
  uses: number;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface DeviceCredentialMetadata {
  id: string;
  deviceId: string;
  fingerprint: string;
  issuedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AgentRelease {
  id: string;
  version: string;
  channel: UpdateChannel;
  platform: string;
  arch: string;
  downloadUrl: string;
  checksumSha256: string;
  signature?: string;
  releaseNotes: string;
  protocolMin: number;
  protocolMax: number;
  createdAt: string;
}

export interface UpdateRollout {
  id: string;
  releaseId: string;
  name: string;
  deviceIds: string[];
  groupIds: string[];
  state: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'rolled-back' | 'failed';
  canaryPercent: number;
  rollbackOnFailure: boolean;
  maintenanceWindowOnly: boolean;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  results: Record<string, { state: ExecutionState; previousVersion?: string; error?: string; updatedAt: string }>;
  createdAt: string;
}

export interface MetricHistoryPoint {
  id: string;
  deviceId: string;
  sampledAt: string;
  cpuPercent: number;
  memoryPercent: number;
  gpuPercent?: number;
  vramPercent?: number;
  temperatureCelsius?: number;
  diskPercent?: number;
  rxBytesPerSecond: number;
  txBytesPerSecond: number;
  batteryPercent?: number;
  powerWatts?: number;
}

export type AlertMetric = 'offline' | 'cpu' | 'memory' | 'gpu' | 'temperature' | 'disk' | 'battery' | 'job-failure' | 'job-stuck' | 'agent-version' | 'nas' | 'authentication' | 'custom';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: AlertMetric;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'not-eq';
  threshold?: number | string;
  durationSeconds: number;
  severity: 'info' | 'warning' | 'critical';
  deviceIds: string[];
  groupIds: string[];
  notificationChannelIds: string[];
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface FleetAlert {
  id: string;
  ruleId?: string;
  deviceId?: string;
  jobId?: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  title: string;
  detail: string;
  openedAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  fingerprint: string;
}

export interface AuditRecord {
  id: string;
  sequence: number;
  at: string;
  actorType: 'user' | 'agent' | 'system' | 'api' | 'mcp';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: 'success' | 'denied' | 'failed';
  sourceIp?: string;
  detail: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface SecretMetadata {
  id: string;
  name: string;
  description: string;
  scope: 'organization' | 'workspace' | 'project' | 'environment' | 'device';
  scopeId?: string;
  provider: 'builtin' | 'environment' | '1password' | 'vault' | 'aws' | 'azure' | 'gcp';
  keyId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  expiresAt?: string;
  lastAccessedAt?: string;
  tags: string[];
}

export interface BackupRecord {
  id: string;
  kind: 'automatic' | 'manual' | 'pre-migration';
  status: ExecutionState;
  destination: string;
  encrypted: boolean;
  checksumSha256?: string;
  sizeBytes?: number;
  version: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export type ArtifactKind = 'model' | 'build' | 'report' | 'image' | 'video' | 'dataset' | 'log' | 'git-diff' | 'document' | 'test-result' | 'metric' | 'binary' | 'archive' | 'other';

export interface ArtifactLocation {
  id: string;
  providerId?: string;
  deviceId?: string;
  path: string;
  status: 'pending' | 'available' | 'transferring' | 'offline' | 'missing';
  cached: boolean;
  lastVerifiedAt?: string;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  sizeBytes: number;
  checksumSha256: string;
  mimeType?: string;
  locations: ArtifactLocation[];
  metadata: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
}

export interface FleetArtifact {
  id: string;
  name: string;
  description: string;
  kind: ArtifactKind;
  projectId?: string;
  jobId?: string;
  pipelineRunId?: string;
  tags: string[];
  favorite: boolean;
  pinned: boolean;
  archived: boolean;
  classification: DataClassification;
  versions: ArtifactVersion[];
  parentArtifactIds: string[];
  promotedEnvironment?: string;
  promotedVersionId?: string;
  promotedAt?: string;
  retentionDays?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactTransfer {
  id: string;
  artifactId?: string;
  source: ArtifactLocation;
  destination: ArtifactLocation;
  status: ExecutionState | 'verifying';
  totalBytes: number;
  transferredBytes: number;
  chunkSizeBytes: number;
  checksumSha256?: string;
  compressed: boolean;
  encrypted: boolean;
  bandwidthLimitBytesPerSecond?: number;
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type StorageProviderKind = 'local' | 'smb' | 'nfs' | 's3' | 'minio' | 'synology' | 'qnap';

export interface StorageConnection {
  id: string;
  name: string;
  kind: StorageProviderKind;
  /** Enrolled Agent that owns rootPath. Omit when rootPath is mounted on Core. */
  deviceId?: string;
  endpoint?: string;
  rootPath?: string;
  bucket?: string;
  region?: string;
  secretId?: string;
  readOnly: boolean;
  status: 'connected' | 'degraded' | 'offline' | 'unconfigured';
  capacityBytes?: number;
  usedBytes?: number;
  quotaBytes?: number;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type PipelineNodeType = 'codex' | 'shell' | 'python' | 'git' | 'docker' | 'http' | 'transfer' | 'approval' | 'human-input' | 'wait' | 'webhook' | 'training' | 'evaluation' | 'test' | 'build' | 'deployment' | 'notification' | 'wake' | 'shutdown' | 'transform' | 'database' | 'plugin';

export interface PipelineNodeDefinition {
  id: string;
  type: PipelineNodeType;
  name: string;
  description?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  requiredLabels: string[];
  preferredDeviceIds: string[];
  timeoutSeconds?: number;
  retries: number;
  retryDelaySeconds: number;
  continueOnFailure: boolean;
  approvalRequired: boolean;
  environment?: string;
}

export interface PipelineEdgeDefinition {
  id: string;
  source: string;
  target: string;
  condition: 'success' | 'failure' | 'always' | 'expression';
  expression?: string;
  label?: string;
}

export interface PipelineTrigger {
  id: string;
  type: 'manual' | 'schedule' | 'webhook' | 'git-push' | 'file' | 'job' | 'device' | 'metric' | 'external';
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  projectId?: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  nodes: PipelineNodeDefinition[];
  edges: PipelineEdgeDefinition[];
  triggers: PipelineTrigger[];
  parameters: Record<string, { type: 'string' | 'number' | 'boolean' | 'secret'; required: boolean; default?: unknown }>;
  concurrencyLimit: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface PipelineNodeRun {
  id: string;
  nodeId: string;
  state: ExecutionState;
  deviceId?: string;
  jobId?: string;
  attempt: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  pipelineVersion: number;
  state: ExecutionState;
  triggerType: PipelineTrigger['type'];
  parameters: Record<string, unknown>;
  nodeRuns: PipelineNodeRun[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  createdBy: string;
  error?: string;
  estimatedCompletionAt?: string;
}

export type SchedulingStrategy = 'fastest' | 'lowest-cost' | 'lowest-power' | 'data-locality' | 'balanced' | 'always-on' | 'dedicated' | 'custom';

export interface SchedulingPolicy {
  id: string;
  name: string;
  strategy: SchedulingStrategy;
  enabled: boolean;
  priority: number;
  projectIds: string[];
  requiredLabels: string[];
  preferredRoles: DeviceRole[];
  excludedDeviceIds: string[];
  avoidLaptops: boolean;
  avoidProduction: boolean;
  maximumTemperatureCelsius?: number;
  minimumBatteryPercent?: number;
  maximumQueueDepth?: number;
  weights: Record<'cpu' | 'memory' | 'gpu' | 'queue' | 'cost' | 'power' | 'locality' | 'reliability', number>;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulingDecision {
  id: string;
  jobId?: string;
  pipelineRunId?: string;
  selectedDeviceId?: string;
  candidateScores: Array<{ deviceId: string; score: number; reasons: string[]; rejected: boolean }>;
  policyId?: string;
  createdAt: string;
}

export interface NotificationChannel {
  id: string;
  name: string;
  kind: 'desktop' | 'webhook' | 'email' | 'slack' | 'teams' | 'pagerduty' | 'sms' | 'push';
  enabled: boolean;
  config: Record<string, unknown>;
  secretId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetNotification {
  id: string;
  channelId?: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'failed' | 'read';
  link?: string;
  createdAt: string;
  sentAt?: string;
  readAt?: string;
  error?: string;
}

export interface ApiTokenMetadata {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: V2EntityStatus;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface WebhookRegistration {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secretId?: string;
  headers: Record<string, string>;
  failureCount: number;
  lastDeliveryAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  entrypoint: string;
  capabilities: Array<'job' | 'pipeline-node' | 'telemetry' | 'artifact-viewer' | 'notification' | 'policy' | 'scheduler' | 'auth'>;
  enabled: boolean;
  signed: boolean;
  checksumSha256?: string;
  configSchema?: Record<string, unknown>;
  installedAt: string;
}

export interface RemoteDesktopSession {
  id: string;
  deviceId: string;
  protocol: 'rdp' | 'vnc' | 'screen-sharing' | 'sunshine' | 'webrtc' | 'external';
  status: 'starting' | 'ready' | 'closed' | 'error';
  viewOnly: boolean;
  recording: boolean;
  connectionUrl?: string;
  expiresAt?: string;
  createdAt: string;
  closedAt?: string;
  error?: string;
}

export interface DiagnosticReport {
  id: string;
  deviceId?: string;
  kind: 'agent' | 'core' | 'network' | 'storage' | 'database' | 'backup' | 'compatibility' | 'support-bundle';
  state: ExecutionState;
  redacted: boolean;
  checks: Array<{ name: string; status: 'pass' | 'warning' | 'fail'; detail: string; remediation?: string }>;
  createdAt: string;
  completedAt?: string;
}

export interface FleetPolicy {
  id: string;
  name: string;
  description: string;
  scope: 'organization' | 'workspace' | 'project' | 'device-group';
  scopeId?: string;
  enabled: boolean;
  priority: number;
  effect: 'allow' | 'deny' | 'require-approval';
  actions: string[];
  conditions: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FleetRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  builtIn: boolean;
}

export interface FleetMember {
  id: string;
  displayName: string;
  email?: string;
  roleIds: string[];
  groupIds: string[];
  status: 'active' | 'invited' | 'disabled';
  createdAt: string;
  lastLoginAt?: string;
}

export interface FleetOrganization {
  id: string;
  name: string;
  slug: string;
  dataRegion?: string;
  createdAt: string;
}

export interface FleetWorkspace {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface AdvancedCodexSession {
  sessionId: string;
  parentSessionId?: string;
  branchName?: string;
  bookmarks: Array<{ id: string; eventId: string; label: string; createdAt: string }>;
  summary?: string;
  model?: string;
  reasoningLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  contextPercent?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  expiresAt?: string;
  archivedAt?: string;
  movedFromDeviceId?: string;
  lineage?: CodexSessionLineageEvent[];
}

export interface AgentTeamTask {
  id: string;
  title: string;
  description: string;
  role: string;
  deviceId?: string;
  sessionId?: string;
  dependsOn: string[];
  state: ExecutionState;
  outputArtifactIds: string[];
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface AgentTeam {
  id: string;
  name: string;
  objective: string;
  projectId?: string;
  state: ExecutionState;
  budgetTokens?: number;
  usedTokens: number;
  maximumRuntimeMinutes?: number;
  permissionMode: PermissionMode;
  tasks: AgentTeamTask[];
  messages: Array<{ id: string; fromTaskId?: string; toTaskId?: string; at: string; body: string }>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobHistorySummary {
  jobId: string;
  finalStatus: JobStatus;
  deviceId?: string;
  durationMs?: number;
  peakMemoryPercent?: number;
  peakGpuPercent?: number;
  createdAt: string;
}

export type MenuBarHealthStatus = 'healthy' | 'degraded' | 'critical';
export type MenuBarDeviceStatus = 'online' | 'busy' | 'degraded' | 'sleeping' | 'offline';

export interface MenuBarJob {
  id: string;
  name: string;
  kind: 'codex' | 'shell';
  status: JobStatus;
  deviceId?: string;
  deviceName?: string;
  progress?: number;
  phase?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  durationMs?: number;
  error?: string;
}

export interface MenuBarDevice {
  id: string;
  name: string;
  role: DeviceRole;
  status: MenuBarDeviceStatus;
  platform: string;
  lastSeenAt: string;
  activeJobCount: number;
  metrics: {
    cpuPercent: number;
    memoryPercent: number;
    storageMaxPercent?: number;
    gpuPercent?: number;
    vramUsedBytes?: number;
    vramTotalBytes?: number;
    temperatureCelsius?: number;
    batteryPercent?: number;
    powerDrawWatts?: number;
    sampledAt: string;
  };
  capabilities: {
    codex: boolean;
    cuda: boolean;
    mlx: boolean;
    tailscale: boolean;
    wakeOnLan: boolean;
    labels: string[];
  };
}

export interface MenuBarCodexApproval {
  kind: 'codex';
  id: string;
  sessionId: string;
  requestId: string | number;
  deviceId: string;
  deviceName?: string;
  projectId?: string;
  title: string;
  detail: string;
  method: string;
  params: unknown;
  createdAt: string;
}

export interface MenuBarPipelineApproval {
  kind: 'pipeline';
  id: string;
  pipelineRunId: string;
  pipelineId: string;
  pipelineName?: string;
  nodeRunId: string;
  nodeId: string;
  deviceId?: string;
  deviceName?: string;
  title: string;
  detail: string;
  createdAt: string;
}

export type MenuBarApproval = MenuBarCodexApproval | MenuBarPipelineApproval;

export interface MenuBarAlert {
  id: string;
  severity: 'warning' | 'critical';
  status: 'open' | 'acknowledged';
  title: string;
  detail: string;
  openedAt: string;
  deviceId?: string;
  deviceName?: string;
  jobId?: string;
  jobName?: string;
}

export interface MenuBarRecentItem {
  id: string;
  kind: 'activity' | 'job';
  at: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
  deviceId?: string;
  deviceName?: string;
  entityId?: string;
  jobStatus?: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>;
}

/** Compact cross-device Codex session metadata used by local control surfaces. */
export interface MenuBarCodexSession {
  id: string;
  deviceId: string;
  deviceName?: string;
  projectId?: string;
  threadId?: string;
  model?: string;
  title: string;
  cwd: string;
  status: import('./types.js').CodexSessionStatus;
  createdAt: string;
  updatedAt: string;
  pendingApprovalCount: number;
}

export interface MenuBarSnapshot {
  generatedAt: string;
  core: {
    status: 'healthy';
    connected: true;
    fleetName: string;
    version: string;
    schemaVersion: number;
    protocolVersion: number;
    url: string;
  };
  summary: {
    status: MenuBarHealthStatus;
    totalDevices: number;
    onlineDevices: number;
    busyDevices: number;
    degradedDevices: number;
    sleepingDevices: number;
    offlineDevices: number;
    activeJobs: number;
    queuedJobs: number;
    /** Failed jobs completed during the last 30 minutes. */
    failedJobs: number;
    pendingApprovals: number;
    openWarnings: number;
    openCriticalAlerts: number;
  };
  /** At most three active, queued, or recently failed jobs, ordered by urgency. */
  jobs: MenuBarJob[];
  /** At most 100 enrolled devices. Summary counts always cover the full state. */
  devices: MenuBarDevice[];
  /** At most ten pending Codex requests and pipeline approval gates. */
  approvals: MenuBarApproval[];
  /** At most ten unresolved warning or critical alerts. */
  alerts: MenuBarAlert[];
  /** At most ten persisted activities and terminal job outcomes. */
  recent: MenuBarRecentItem[];
  /** At most 100 Codex sessions across the fleet, ordered by attention and recency. */
  codexSessions: MenuBarCodexSession[];
}

export interface FleetV2Snapshot {
  schemaVersion: number;
  protocolVersion: number;
  sites: FleetSite[];
  groups: DeviceGroup[];
  deviceProfiles: ManagedDeviceProfile[];
  enrollmentTokens: EnrollmentTokenRecord[];
  deviceCredentials: DeviceCredentialMetadata[];
  agentReleases: AgentRelease[];
  updateRollouts: UpdateRollout[];
  metricHistory: MetricHistoryPoint[];
  alertRules: AlertRule[];
  alerts: FleetAlert[];
  audit: AuditRecord[];
  secrets: SecretMetadata[];
  backups: BackupRecord[];
  artifacts: FleetArtifact[];
  transfers: ArtifactTransfer[];
  storageConnections: StorageConnection[];
  pipelines: PipelineDefinition[];
  pipelineRuns: PipelineRun[];
  schedulingPolicies: SchedulingPolicy[];
  schedulingDecisions: SchedulingDecision[];
  notificationChannels: NotificationChannel[];
  notifications: FleetNotification[];
  apiTokens: ApiTokenMetadata[];
  webhooks: WebhookRegistration[];
  plugins: FleetPlugin[];
  desktopSessions: RemoteDesktopSession[];
  diagnostics: DiagnosticReport[];
  policies: FleetPolicy[];
  organizations: FleetOrganization[];
  workspaces: FleetWorkspace[];
  roles: FleetRole[];
  members: FleetMember[];
  advancedSessions: AdvancedCodexSession[];
  agentTeams: AgentTeam[];
  jobHistory: JobHistorySummary[];
}
