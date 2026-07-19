import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ActivityEvent,
  CodexEvent,
  CodexSession,
  Device,
  FleetJob,
  FleetProject,
  FleetSettings,
  FleetSnapshot,
  FleetSystemConversation,
  FleetV2Snapshot,
  JobOutputEvent,
  TerminalSession,
} from '@fleet/shared';

export const MAX_ACTIVITY_EVENTS = 1_000;
export const MAX_JOB_OUTPUT_EVENTS = 1_000;
export const MAX_CODEX_EVENTS = 1_000;
export const MAX_SYSTEM_MESSAGES = 2_000;
export const MAX_SYSTEM_CONVERSATIONS = 50;
export const MAX_EVENT_TEXT_LENGTH = 65_536;
export const MAX_LIVE_CODEX_EVENTS = 200;
export const MAX_LIVE_CODEX_EVENT_BYTES = 512 * 1_024;
export const CORE_RESTART_SESSION_RECOVERY_ERROR = 'Fleet Core restarted; waiting for the execution Agent to reconnect.';

export interface FleetPrivateState {
  enrollmentTokenHashes: Record<string, string>;
  deviceCredentialHashes: Record<string, string>;
  apiTokenHashes: Record<string, string>;
  encryptedSecrets: Record<string, { iv: string; authTag: string; ciphertext: string }>;
}

export interface PersistedState {
  version: string;
  devices: Device[];
  projects: FleetProject[];
  jobs: FleetJob[];
  sessions: CodexSession[];
  terminals: TerminalSession[];
  activity: ActivityEvent[];
  settings: FleetSettings;
  systemConversation: FleetSystemConversation;
  systemConversationHistory: FleetSystemConversation[];
  v2: FleetV2Snapshot;
  private: FleetPrivateState;
}

import { createV2State, hydrateV2 } from './v2/defaults.js';

export interface FleetStoreOptions {
  filePath: string;
  coreUrl?: string;
  persistDelayMs?: number;
}

const PENDING_RESTORE_SUFFIX = '.restore-pending';
const CURRENT_STATE_VERSION = '2.0.0';
const V2_ARRAY_KEYS = [
  'sites', 'groups', 'deviceProfiles', 'enrollmentTokens', 'deviceCredentials', 'agentReleases', 'updateRollouts',
  'metricHistory', 'alertRules', 'alerts', 'audit', 'secrets', 'backups', 'artifacts', 'transfers',
  'storageConnections', 'pipelines', 'pipelineRuns', 'schedulingPolicies', 'schedulingDecisions',
  'notificationChannels', 'notifications', 'apiTokens', 'webhooks', 'plugins', 'desktopSessions', 'diagnostics',
  'policies', 'organizations', 'workspaces', 'roles', 'members', 'advancedSessions', 'agentTeams', 'jobHistory',
] as const;

const defaultSettings = (coreUrl = 'http://127.0.0.1:4780'): FleetSettings => ({
  fleetName: 'My Fleet',
  coreUrl,
  heartbeatIntervalMs: 5_000,
  offlineAfterMs: 20_000,
  retainActivityDays: 30,
  autoStartLocalAgent: true,
});

function createSystemConversation(includeWelcome = true, id = 'fleet-system'): FleetSystemConversation {
  const now = new Date().toISOString();
  return {
    id,
    title: 'Fleet System',
    messages: includeWelcome ? [{
      id: randomUUID(),
      at: now,
      role: 'assistant',
      text: 'Fleet System is ready. Mention a device such as @mini64, @mbp, @5070, or @nas to inspect it, manage it, or start a Codex conversation there.',
      mentions: [],
      references: [],
    }] : [],
    pendingActions: [],
    conductorPlans: [],
    updatedAt: now,
  };
}

function isSystemConversation(value: unknown): value is FleetSystemConversation {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.id === 'fleet-system' || value.id.startsWith('fleet-system-'))
    && typeof value.title === 'string'
    && Array.isArray(value.messages)
    && Array.isArray(value.pendingActions)
    && typeof value.updatedAt === 'string';
}

const initialState = (coreUrl?: string): PersistedState => ({
  version: CURRENT_STATE_VERSION,
  devices: [],
  projects: [],
  jobs: [],
  sessions: [],
  terminals: [],
  activity: [],
  settings: defaultSettings(coreUrl),
  systemConversation: createSystemConversation(),
  systemConversationHistory: [],
  v2: createV2State(),
  private: { enrollmentTokenHashes: {}, deviceCredentialHashes: {}, apiTokenHashes: {}, encryptedSecrets: {} },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hydrate(value: unknown, coreUrl?: string): PersistedState {
  const fallback = initialState(coreUrl);
  if (!isRecord(value)) return fallback;
  const settings = isRecord(value.settings)
    ? { ...fallback.settings, ...value.settings } as FleetSettings
    : fallback.settings;
  return {
    version: fallback.version,
    devices: Array.isArray(value.devices) ? value.devices as Device[] : [],
    projects: Array.isArray(value.projects) ? value.projects as FleetProject[] : [],
    jobs: Array.isArray(value.jobs) ? value.jobs as FleetJob[] : [],
    sessions: Array.isArray(value.sessions) ? value.sessions as CodexSession[] : [],
    terminals: Array.isArray(value.terminals) ? value.terminals as TerminalSession[] : [],
    activity: Array.isArray(value.activity) ? value.activity as ActivityEvent[] : [],
    settings,
    systemConversation: isSystemConversation(value.systemConversation)
      ? { ...value.systemConversation, conductorPlans: Array.isArray(value.systemConversation.conductorPlans) ? value.systemConversation.conductorPlans : [] }
      : fallback.systemConversation,
    systemConversationHistory: Array.isArray(value.systemConversationHistory)
      ? value.systemConversationHistory.filter(isSystemConversation).map((conversation) => ({
        ...conversation,
        conductorPlans: Array.isArray(conversation.conductorPlans) ? conversation.conductorPlans : [],
      }))
      : [],
    v2: hydrateV2(value.v2),
    private: isRecord(value.private) ? {
      enrollmentTokenHashes: isRecord(value.private.enrollmentTokenHashes) ? value.private.enrollmentTokenHashes as Record<string, string> : {},
      deviceCredentialHashes: isRecord(value.private.deviceCredentialHashes) ? value.private.deviceCredentialHashes as Record<string, string> : {},
      apiTokenHashes: isRecord(value.private.apiTokenHashes) ? value.private.apiTokenHashes as Record<string, string> : {},
      encryptedSecrets: isRecord(value.private.encryptedSecrets) ? value.private.encryptedSecrets as FleetPrivateState['encryptedSecrets'] : {},
    } : fallback.private,
  };
}

/**
 * Validate a complete restore image before it can be staged. Hydration is
 * intentionally not used here: silently replacing malformed sections with
 * defaults would turn a corrupt backup into a successful, lossy restore.
 */
export function validatePersistedState(value: unknown, expectedVersion = CURRENT_STATE_VERSION): PersistedState {
  if (!isRecord(value)) throw new Error('Restore document must be a JSON object.');
  if (value.version !== expectedVersion) throw new Error(`Restore document version ${String(value.version)} is incompatible with Core ${expectedVersion}.`);
  for (const key of ['devices', 'projects', 'jobs', 'sessions', 'terminals', 'activity'] as const) {
    if (!Array.isArray(value[key])) throw new Error(`Restore document field ${key} must be an array.`);
  }
  if (!isRecord(value.settings)) throw new Error('Restore document settings are invalid.');
  const requiredSettings: Array<[keyof FleetSettings, 'string' | 'number' | 'boolean']> = [
    ['fleetName', 'string'], ['coreUrl', 'string'], ['heartbeatIntervalMs', 'number'], ['offlineAfterMs', 'number'],
    ['retainActivityDays', 'number'], ['autoStartLocalAgent', 'boolean'],
  ];
  for (const [key, type] of requiredSettings) {
    if (typeof value.settings[key] !== type) throw new Error(`Restore document setting ${key} is invalid.`);
  }
  if (!isRecord(value.v2) || typeof value.v2.schemaVersion !== 'number' || typeof value.v2.protocolVersion !== 'number') {
    throw new Error('Restore document V2 metadata is invalid.');
  }
  for (const key of V2_ARRAY_KEYS) {
    if (!Array.isArray(value.v2[key])) throw new Error(`Restore document V2 field ${key} must be an array.`);
  }
  if (!isRecord(value.private)) throw new Error('Restore document private state is invalid.');
  for (const key of ['enrollmentTokenHashes', 'deviceCredentialHashes', 'apiTokenHashes', 'encryptedSecrets'] as const) {
    if (!isRecord(value.private[key])) throw new Error(`Restore document private field ${key} must be an object.`);
  }
  return value as unknown as PersistedState;
}

function pendingRestorePath(filePath: string): string { return `${filePath}${PENDING_RESTORE_SUFFIX}`; }

async function syncDirectory(directory: string): Promise<void> {
  // Best effort directory sync makes an atomic rename durable on POSIX. Some
  // platforms do not permit opening or syncing directory handles.
  try {
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch { /* unsupported on some platforms */ }
}

async function promotePendingRestore(filePath: string): Promise<void> {
  const stagedPath = pendingRestorePath(filePath);
  let document: string;
  try {
    const handle = await open(stagedPath, 'r');
    try { document = await handle.readFile('utf8'); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  // Re-validate after the restart so disk corruption cannot be promoted over
  // the last known-good state document.
  let parsed: unknown;
  try { parsed = JSON.parse(document) as unknown; } catch { throw new Error(`Pending restore ${stagedPath} is not valid JSON; the current state was left untouched.`); }
  try { validatePersistedState(parsed); } catch (error) {
    throw new Error(`Pending restore ${stagedPath} is invalid; the current state was left untouched: ${error instanceof Error ? error.message : String(error)}`);
  }
  await mkdir(dirname(filePath), { recursive: true });
  await rename(stagedPath, filePath);
  await syncDirectory(dirname(filePath));
}

/** In-memory fleet state backed by an atomically replaced JSON document. */
export class FleetStore {
  readonly filePath: string;
  readonly persistDelayMs: number;
  state: PersistedState;
  private saveTimer?: NodeJS.Timeout;
  private savePromise?: Promise<void>;
  private dirty = false;
  private closed = false;

  private constructor(options: FleetStoreOptions, state: PersistedState) {
    this.filePath = options.filePath;
    // Codex deltas and device telemetry can make the store dirty many times a
    // second. Persisting the complete state image for every delta creates a
    // serialization/write loop whose queued JSON strings can exhaust Core's
    // heap. A one-second durability window still keeps recovery current while
    // allowing bursty updates to collapse into one atomic write.
    this.persistDelayMs = options.persistDelayMs ?? 1_000;
    this.state = state;
  }

  static async open(options: FleetStoreOptions): Promise<FleetStore> {
    await promotePendingRestore(options.filePath);
    let state = initialState(options.coreUrl);
    let reconciled = false;
    try {
      const handle = await open(options.filePath, 'r');
      try {
        state = hydrate(JSON.parse(await handle.readFile('utf8')) as unknown, options.coreUrl);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        const backup = `${options.filePath}.corrupt-${Date.now()}`;
        try { await rename(options.filePath, backup); } catch { /* keep original error context out of startup */ }
      }
    }

    // Runtime connections cannot survive a core restart.
    const now = new Date().toISOString();
    for (const device of state.devices) {
      if (device.status !== 'offline' || device.activeJobIds.length || device.activeSessionIds.length) reconciled = true;
      device.status = 'offline';
      device.activeJobIds = [];
      device.activeSessionIds = [];
    }
    for (const terminal of state.terminals) {
      if (terminal.status === 'open' || terminal.status === 'starting') { terminal.status = 'closed'; reconciled = true; }
    }
    for (const session of state.sessions) {
      if (session.participants?.length || session.controllerClientId || session.controllerUpdatedAt) reconciled = true;
      session.participants = [];
      session.controllerClientId = undefined;
      session.controllerUpdatedAt = undefined;
      if (session.status === 'completed' && (session.error || session.turnId)) {
        session.error = undefined;
        session.turnId = undefined;
        reconciled = true;
      }
      if (!['completed', 'error', 'stopped'].includes(session.status)) {
        session.status = 'stopped';
        session.error = CORE_RESTART_SESSION_RECOVERY_ERROR;
        session.updatedAt = now;
        reconciled = true;
      }
    }
    if (state.systemConversation.activeResponseMessageId) {
      const interrupted = state.systemConversation.messages.find((message) => message.id === state.systemConversation.activeResponseMessageId);
      if (interrupted && (!interrupted.text || interrupted.text === 'Thinking…')) {
        interrupted.text = 'Fleet Core restarted before Codex finished this response. Please send the request again.';
      }
      state.systemConversation.activeResponseMessageId = undefined;
      reconciled = true;
    }
    for (const project of state.projects) {
      if (!project.preview) continue;
      project.preview.logs = project.preview.logs?.slice(-250) ?? [];
      project.preview.desiredState ??= project.preview.status === 'stopped' ? 'stopped' : 'running';
      if (['starting', 'running', 'restarting'].includes(project.preview.status)) {
        project.preview.status = 'offline';
        project.preview.error = 'Fleet Core restarted; waiting for the hosting Agent to reconnect.';
        project.preview.updatedAt = now;
        reconciled = true;
      }
    }
    for (const job of state.jobs) {
      if (['dispatching', 'running', 'awaiting-approval'].includes(job.status)) {
        job.status = 'failed';
        job.error = 'Fleet Core restarted while this job was active.';
        job.completedAt = now;
        reconciled = true;
      }
    }
    for (const run of state.v2.pipelineRuns) {
      if (!['queued', 'running'].includes(run.state)) continue;
      run.state = 'failed';
      run.error = 'Fleet Core restarted while this pipeline was active.';
      run.completedAt = now;
      for (const node of run.nodeRuns.filter((item) => ['pending', 'queued', 'running'].includes(item.state))) {
        node.state = node.state === 'pending' ? 'skipped' : 'failed';
        node.error = node.state === 'failed' ? 'Fleet Core restarted while this node was active.' : node.error;
        node.completedAt = now;
      }
      reconciled = true;
    }
    for (const transfer of state.v2.transfers) {
      if (!['queued', 'running', 'verifying'].includes(transfer.status)) continue;
      transfer.status = 'pending';
      transfer.error = 'Fleet Core restarted; resume the transfer from its verified offset.';
      transfer.completedAt = undefined;
      reconciled = true;
    }
    for (const rollout of state.v2.updateRollouts) {
      if (rollout.state !== 'running') continue;
      rollout.state = 'paused';
      reconciled = true;
    }
    for (const team of state.v2.agentTeams) {
      if (team.state !== 'running') continue;
      team.state = 'failed';
      team.completedAt = now;
      for (const task of team.tasks.filter((item) => ['pending', 'queued', 'running'].includes(item.state))) {
        task.state = task.state === 'running' ? 'failed' : 'cancelled';
        task.error = task.state === 'failed' ? 'Fleet Core restarted while this agent task was active.' : task.error;
        task.completedAt = now;
      }
      reconciled = true;
    }
    for (const session of state.v2.desktopSessions) {
      if (!['starting', 'ready'].includes(session.status)) continue;
      session.status = 'closed';
      session.closedAt = now;
      reconciled = true;
    }
    for (const backup of state.v2.backups) {
      if (!['queued', 'running'].includes(backup.status)) continue;
      backup.status = 'failed';
      backup.error = 'Fleet Core restarted while this backup was active.';
      backup.completedAt = now;
      reconciled = true;
    }
    for (const diagnostic of state.v2.diagnostics) {
      if (!['queued', 'running'].includes(diagnostic.state)) continue;
      diagnostic.state = 'failed';
      diagnostic.checks.push({ name: 'Core restart', status: 'fail', detail: 'Fleet Core restarted before this diagnostic completed.', remediation: 'Run the diagnostic again.' });
      diagnostic.completedAt = now;
      reconciled = true;
    }

    const store = new FleetStore(options, state);
    store.prune();
    if (reconciled) store.markDirty();
    return store;
  }

  snapshot(): FleetSnapshot {
    return {
      version: this.state.version,
      now: new Date().toISOString(),
      devices: this.state.devices,
      projects: this.state.projects,
      jobs: this.state.jobs,
      sessions: this.state.sessions.filter((session) => session.kind !== 'fleet-system'),
      terminals: this.state.terminals,
      activity: this.state.activity,
      settings: this.state.settings,
      systemConversation: this.state.systemConversation,
      systemConversations: [this.state.systemConversation, ...this.state.systemConversationHistory],
      v2: this.v2Snapshot(),
    };
  }

  /**
   * WebSocket projections stay small enough for mobile clients and are merged
   * into the complete REST state by each UI. Full conversation history remains
   * available from the regular snapshot/session endpoints.
   */
  liveSnapshot(): FleetSnapshot {
    return {
      ...this.snapshot(),
      sessions: this.state.sessions
        .filter((session) => session.kind !== 'fleet-system')
        .map((session) => this.liveCodexSession(session)),
    };
  }

  liveCodexSession(session: CodexSession): CodexSession {
    return { ...session, events: recentLiveCodexEvents(session.events) };
  }

  startNewSystemConversation(): FleetSystemConversation {
    const now = new Date().toISOString();
    this.state.systemConversationHistory.unshift({
      ...this.state.systemConversation,
      codexSessionId: undefined,
      status: 'stopped',
      activeResponseMessageId: undefined,
      error: undefined,
      updatedAt: now,
    });
    this.state.systemConversation = createSystemConversation(true, `fleet-system-${randomUUID()}`);
    this.prune();
    this.markDirty();
    return this.state.systemConversation;
  }

  clearSystemConversation(): FleetSystemConversation {
    const id = this.state.systemConversation.id;
    this.state.systemConversation = createSystemConversation(false, id);
    this.markDirty();
    return this.state.systemConversation;
  }

  /** Bounded projection for initial UI/WebSocket snapshots; full histories use paginated V2 REST routes. */
  v2Snapshot(): FleetV2Snapshot {
    return {
      ...this.state.v2,
      metricHistory: this.state.v2.metricHistory.slice(-2_000),
      audit: this.state.v2.audit.slice(-1_000),
      notifications: this.state.v2.notifications.slice(0, 1_000),
      schedulingDecisions: this.state.v2.schedulingDecisions.slice(0, 1_000),
      jobHistory: this.state.v2.jobHistory.slice(0, 2_000),
    };
  }

  activity(input: Omit<ActivityEvent, 'id' | 'at'> & Partial<Pick<ActivityEvent, 'id' | 'at'>>): ActivityEvent {
    const event: ActivityEvent = {
      id: input.id ?? randomUUID(),
      at: input.at ?? new Date().toISOString(),
      type: input.type,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
    };
    this.state.activity.unshift(event);
    this.prune();
    this.markDirty();
    return event;
  }

  appendJobOutput(job: FleetJob, input: Omit<JobOutputEvent, 'id' | 'at'>): JobOutputEvent {
    const event: JobOutputEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
      text: input.text.slice(0, MAX_EVENT_TEXT_LENGTH),
      ...(input.raw === undefined ? {} : { raw: boundedJson(input.raw) }),
    };
    job.output.push(event);
    if (job.output.length > MAX_JOB_OUTPUT_EVENTS) job.output.splice(0, job.output.length - MAX_JOB_OUTPUT_EVENTS);
    this.markDirty();
    return event;
  }

  appendCodexEvent(session: CodexSession, input: Omit<CodexEvent, 'id' | 'at'>): CodexEvent {
    const event: CodexEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
      text: input.text.slice(0, MAX_EVENT_TEXT_LENGTH),
      ...(input.data === undefined ? {} : { data: boundedJson(input.data) }),
    };
    session.events.push(event);
    if (session.events.length > MAX_CODEX_EVENTS) session.events.splice(0, session.events.length - MAX_CODEX_EVENTS);
    session.updatedAt = event.at;
    this.markDirty();
    return event;
  }

  prune(): void {
    const cutoff = Date.now() - Math.max(1, this.state.settings.retainActivityDays) * 86_400_000;
    this.state.activity = this.state.activity
      .filter((event) => new Date(event.at).getTime() >= cutoff)
      .slice(0, MAX_ACTIVITY_EVENTS);
    // Bound persisted history even when loading data created by an older version.
    for (const job of this.state.jobs) job.output = job.output.slice(-MAX_JOB_OUTPUT_EVENTS);
    for (const session of this.state.sessions) session.events = session.events.slice(-MAX_CODEX_EVENTS);
    this.state.systemConversation.messages = this.state.systemConversation.messages.slice(-MAX_SYSTEM_MESSAGES);
    this.state.systemConversation.pendingActions = this.state.systemConversation.pendingActions.slice(-250);
    this.state.systemConversationHistory = this.state.systemConversationHistory
      .slice(0, MAX_SYSTEM_CONVERSATIONS)
      .map((conversation) => ({
        ...conversation,
        messages: conversation.messages.slice(-MAX_SYSTEM_MESSAGES),
        pendingActions: conversation.pendingActions.slice(-250),
      }));
    for (const project of this.state.projects) if (project.preview) project.preview.logs = project.preview.logs.slice(-250);
    this.state.v2.metricHistory = this.state.v2.metricHistory.slice(-50_000);
    // Audit records are never truncated: removing the prefix would break the
    // hash-chain anchor and make later records impossible to verify.
    this.state.v2.notifications = this.state.v2.notifications.slice(0, 5_000);
    this.state.v2.schedulingDecisions = this.state.v2.schedulingDecisions.slice(0, 5_000);
    this.state.v2.jobHistory = this.state.v2.jobHistory.slice(0, 10_000);
  }

  markDirty(): void {
    if (this.closed) return;
    this.dirty = true;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.closed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persistOnce();
    }, this.persistDelayMs);
    this.saveTimer.unref?.();
  }

  private async persistOnce(): Promise<void> {
    if (this.savePromise) return this.savePromise;
    if (!this.dirty) return;
    this.dirty = false;
    this.prune();
    const document = `${JSON.stringify(this.state, null, 2)}\n`;
    const saving = this.atomicWrite(document);
    this.savePromise = saving;
    try {
      await saving;
    } catch (error) {
      // Keep the state eligible for a later retry after a transient write
      // failure; callers of flush still receive the original error.
      this.dirty = true;
      throw error;
    } finally {
      if (this.savePromise === saving) this.savePromise = undefined;
      if (this.dirty) this.schedulePersist();
    }
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    // Explicit flushes (tests, backup, shutdown) are durability barriers. The
    // normal timer path intentionally writes only once per debounce window.
    while (this.dirty || this.savePromise) {
      if (this.savePromise) await this.savePromise;
      else await this.persistOnce();
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
      }
    }
  }

  /**
   * Durably stage a validated state image for promotion on the next Core
   * startup. The running store is deliberately not mutated.
   */
  async stageRestore(value: unknown): Promise<{ pendingPath: string }> {
    const restored = validatePersistedState(value, this.state.version);
    const pendingPath = pendingRestorePath(this.filePath);
    await this.atomicWrite(`${JSON.stringify(restored, null, 2)}\n`, pendingPath);
    return { pendingPath };
  }

  private async atomicWrite(document: string, destination = this.filePath): Promise<void> {
    const directory = dirname(destination);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(document, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tempPath, destination);
      await syncDirectory(directory);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  async existsOnDisk(): Promise<boolean> {
    try { await stat(this.filePath); return true; } catch { return false; }
  }
}

export function boundedJson(value: unknown, maxLength = 16_384): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length <= maxLength) return value;
    return { truncated: true, preview: serialized.slice(0, maxLength) };
  } catch {
    return { truncated: true, preview: String(value).slice(0, maxLength) };
  }
}

function recentLiveCodexEvents(events: CodexEvent[]): CodexEvent[] {
  const selected: CodexEvent[] = [];
  let bytes = 0;
  for (let index = events.length - 1; index >= 0 && selected.length < MAX_LIVE_CODEX_EVENTS; index -= 1) {
    const event = events[index]!;
    let eventBytes: number;
    try { eventBytes = Buffer.byteLength(JSON.stringify(event)); }
    catch { eventBytes = MAX_LIVE_CODEX_EVENT_BYTES; }
    if (selected.length > 0 && bytes + eventBytes > MAX_LIVE_CODEX_EVENT_BYTES) break;
    selected.push(event);
    bytes += eventBytes;
  }
  return selected.reverse();
}
