import type {
  MenuBarApproval,
  MenuBarCodexApproval,
  MenuBarDevice,
  MenuBarJob,
  MenuBarSnapshot
} from '@fleet/shared';

type UnknownRecord = Record<string, unknown>;

const HIGH_RISK_TERMS = /\b(sudo|su\s|rm\s+-rf|shutdown|restart|reboot|erase|delete|destroy|drop\s+(database|table)|production|deploy|secret|credential|password|token|private key|full access|danger[- ]full|external network|outside approved|policy exception|agent update)\b/i;

export function parseMenuBarSnapshot(value: unknown): MenuBarSnapshot {
  const source = record(value, 'menu bar response');
  const core = record(source.core, 'core');
  const summary = record(source.summary, 'summary');
  const status = text(summary.status, 'summary.status');
  if (!['healthy', 'degraded', 'critical'].includes(status)) throw new Error('Orchestra Core returned an unknown menu bar health status.');

  return {
    generatedAt: text(source.generatedAt, 'generatedAt'),
    core: {
      status: literal(core.status, ['healthy'], 'core.status'),
      connected: literal(core.connected, [true], 'core.connected'),
      fleetName: text(core.fleetName, 'core.fleetName'),
      version: text(core.version, 'core.version'),
      schemaVersion: finite(core.schemaVersion, 'core.schemaVersion'),
      protocolVersion: finite(core.protocolVersion, 'core.protocolVersion'),
      url: text(core.url, 'core.url')
    },
    summary: {
      status: status as MenuBarSnapshot['summary']['status'],
      totalDevices: count(summary.totalDevices, 'summary.totalDevices'),
      onlineDevices: count(summary.onlineDevices, 'summary.onlineDevices'),
      busyDevices: count(summary.busyDevices, 'summary.busyDevices'),
      degradedDevices: count(summary.degradedDevices, 'summary.degradedDevices'),
      sleepingDevices: count(summary.sleepingDevices, 'summary.sleepingDevices'),
      offlineDevices: count(summary.offlineDevices, 'summary.offlineDevices'),
      activeJobs: count(summary.activeJobs, 'summary.activeJobs'),
      queuedJobs: count(summary.queuedJobs, 'summary.queuedJobs'),
      failedJobs: count(summary.failedJobs, 'summary.failedJobs'),
      pendingApprovals: count(summary.pendingApprovals, 'summary.pendingApprovals'),
      openWarnings: count(summary.openWarnings, 'summary.openWarnings'),
      openCriticalAlerts: count(summary.openCriticalAlerts, 'summary.openCriticalAlerts')
    },
    jobs: list(source.jobs, 'jobs').map(parseJob),
    devices: list(source.devices, 'devices').map(parseDevice),
    approvals: list(source.approvals, 'approvals').map(parseApproval),
    alerts: list(source.alerts, 'alerts').map((entry, index) => {
      const item = record(entry, `alerts[${index}]`);
      return {
        id: text(item.id, `alerts[${index}].id`),
        severity: literal(item.severity, ['warning', 'critical'] as const, `alerts[${index}].severity`),
        status: literal(item.status, ['open', 'acknowledged'] as const, `alerts[${index}].status`),
        title: text(item.title, `alerts[${index}].title`),
        detail: text(item.detail, `alerts[${index}].detail`),
        openedAt: text(item.openedAt, `alerts[${index}].openedAt`),
        ...optionalTextFields(item, ['deviceId', 'deviceName', 'jobId', 'jobName'])
      };
    }),
    recent: list(source.recent, 'recent').map((entry, index) => {
      const item = record(entry, `recent[${index}]`);
      const jobStatus = item.jobStatus === undefined ? undefined : literal(item.jobStatus, ['completed', 'failed', 'cancelled'] as const, `recent[${index}].jobStatus`);
      return {
        id: text(item.id, `recent[${index}].id`),
        kind: literal(item.kind, ['activity', 'job'] as const, `recent[${index}].kind`),
        at: text(item.at, `recent[${index}].at`),
        severity: literal(item.severity, ['info', 'success', 'warning', 'error'] as const, `recent[${index}].severity`),
        title: text(item.title, `recent[${index}].title`),
        detail: text(item.detail, `recent[${index}].detail`),
        ...optionalTextFields(item, ['deviceId', 'deviceName', 'entityId']),
        ...(jobStatus ? { jobStatus } : {})
      };
    }),
    codexSessions: list(source.codexSessions, 'codexSessions').map((entry, index) => {
      const item = record(entry, `codexSessions[${index}]`);
      return {
        id: text(item.id, `codexSessions[${index}].id`),
        deviceId: text(item.deviceId, `codexSessions[${index}].deviceId`),
        ...optionalTextFields(item, ['deviceName', 'projectId', 'threadId', 'model']),
        title: text(item.title, `codexSessions[${index}].title`),
        cwd: text(item.cwd, `codexSessions[${index}].cwd`),
        status: literal(item.status, ['starting', 'ready', 'thinking', 'awaiting-approval', 'completed', 'error', 'stopped'] as const, `codexSessions[${index}].status`),
        createdAt: text(item.createdAt, `codexSessions[${index}].createdAt`),
        updatedAt: text(item.updatedAt, `codexSessions[${index}].updatedAt`),
        pendingApprovalCount: count(item.pendingApprovalCount, `codexSessions[${index}].pendingApprovalCount`),
      };
    })
  };
}

function parseJob(value: unknown, index: number): MenuBarJob {
  const item = record(value, `jobs[${index}]`);
  return {
    id: text(item.id, `jobs[${index}].id`),
    name: text(item.name, `jobs[${index}].name`),
    kind: literal(item.kind, ['codex', 'shell'] as const, `jobs[${index}].kind`),
    status: literal(item.status, ['queued', 'dispatching', 'running', 'awaiting-approval', 'completed', 'failed', 'cancelled'] as const, `jobs[${index}].status`),
    createdAt: text(item.createdAt, `jobs[${index}].createdAt`),
    ...optionalTextFields(item, ['deviceId', 'deviceName', 'phase', 'startedAt', 'completedAt', 'error']),
    ...optionalNumberFields(item, ['progress', 'elapsedMs', 'durationMs'])
  };
}

function parseDevice(value: unknown, index: number): MenuBarDevice {
  const item = record(value, `devices[${index}]`);
  const metrics = record(item.metrics, `devices[${index}].metrics`);
  const capabilities = record(item.capabilities, `devices[${index}].capabilities`);
  return {
    id: text(item.id, `devices[${index}].id`),
    name: text(item.name, `devices[${index}].name`),
    role: literal(item.role, ['core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown'] as const, `devices[${index}].role`),
    status: literal(item.status, ['online', 'busy', 'degraded', 'sleeping', 'offline'] as const, `devices[${index}].status`),
    platform: text(item.platform, `devices[${index}].platform`),
    lastSeenAt: text(item.lastSeenAt, `devices[${index}].lastSeenAt`),
    activeJobCount: count(item.activeJobCount, `devices[${index}].activeJobCount`),
    metrics: {
      cpuPercent: percentage(metrics.cpuPercent, `devices[${index}].metrics.cpuPercent`),
      memoryPercent: percentage(metrics.memoryPercent, `devices[${index}].metrics.memoryPercent`),
      sampledAt: text(metrics.sampledAt, `devices[${index}].metrics.sampledAt`),
      ...optionalNumberFields(metrics, ['storageMaxPercent', 'gpuPercent', 'vramUsedBytes', 'vramTotalBytes', 'temperatureCelsius', 'batteryPercent', 'powerDrawWatts'])
    },
    capabilities: {
      codex: boolean(capabilities.codex, `devices[${index}].capabilities.codex`),
      cuda: boolean(capabilities.cuda, `devices[${index}].capabilities.cuda`),
      mlx: boolean(capabilities.mlx, `devices[${index}].capabilities.mlx`),
      tailscale: boolean(capabilities.tailscale, `devices[${index}].capabilities.tailscale`),
      wakeOnLan: boolean(capabilities.wakeOnLan, `devices[${index}].capabilities.wakeOnLan`),
      labels: list(capabilities.labels, `devices[${index}].capabilities.labels`).map((label, labelIndex) => text(label, `devices[${index}].capabilities.labels[${labelIndex}]`))
    }
  };
}

function parseApproval(value: unknown, index: number): MenuBarApproval {
  const item = record(value, `approvals[${index}]`);
  const common = {
    id: text(item.id, `approvals[${index}].id`),
    title: text(item.title, `approvals[${index}].title`),
    detail: text(item.detail, `approvals[${index}].detail`),
    createdAt: text(item.createdAt, `approvals[${index}].createdAt`),
    ...optionalTextFields(item, ['deviceId', 'deviceName'])
  };
  const kind = literal(item.kind, ['codex', 'pipeline'] as const, `approvals[${index}].kind`);
  if (kind === 'codex') return {
    ...common,
    kind,
    deviceId: text(item.deviceId, `approvals[${index}].deviceId`),
    sessionId: text(item.sessionId, `approvals[${index}].sessionId`),
    requestId: typeof item.requestId === 'number' ? item.requestId : text(item.requestId, `approvals[${index}].requestId`),
    method: text(item.method, `approvals[${index}].method`),
    params: item.params,
    ...optionalTextFields(item, ['projectId'])
  };
  return {
    ...common,
    kind,
    pipelineRunId: text(item.pipelineRunId, `approvals[${index}].pipelineRunId`),
    pipelineId: text(item.pipelineId, `approvals[${index}].pipelineId`),
    nodeRunId: text(item.nodeRunId, `approvals[${index}].nodeRunId`),
    nodeId: text(item.nodeId, `approvals[${index}].nodeId`),
    ...optionalTextFields(item, ['pipelineName'])
  };
}

export function approvalNeedsReview(approval: MenuBarApproval): boolean {
  if (approval.kind === 'codex') {
    if (approval.method === 'item/tool/requestUserInput' || approval.method === 'item/permissions/requestApproval' || approval.method === 'mcpServer/elicitation/request') return true;
  }
  return HIGH_RISK_TERMS.test(`${approval.title}\n${approval.detail}`);
}

export function isDeviceInteractive(device: MenuBarDevice): boolean {
  return ['online', 'busy', 'degraded'].includes(device.status);
}

export function canPowerDevice(device: MenuBarDevice, action: 'wake' | 'sleep' | 'restart' | 'shutdown'): boolean {
  if (action === 'wake') return ['sleeping', 'offline'].includes(device.status) && device.capabilities.wakeOnLan;
  return isDeviceInteractive(device) && device.capabilities.labels.includes('feature:power-actions');
}

export function bestCodexDevice(devices: MenuBarDevice[], preferredProjectDeviceIds: string[] = []): MenuBarDevice | undefined {
  return [...devices]
    .filter((device) => device.capabilities.codex && isDeviceInteractive(device))
    .sort((left, right) => {
      const preferred = Number(preferredProjectDeviceIds.includes(right.id)) - Number(preferredProjectDeviceIds.includes(left.id));
      if (preferred) return preferred;
      const statusRank = (status: MenuBarDevice['status']) => status === 'online' ? 0 : status === 'degraded' ? 1 : 2;
      return statusRank(left.status) - statusRank(right.status) || left.activeJobCount - right.activeJobCount || left.metrics.cpuPercent - right.metrics.cpuPercent;
    })[0];
}

export function jobProgress(job: MenuBarJob): number | undefined {
  return job.progress === undefined ? undefined : Math.max(0, Math.min(100, job.progress));
}

function record(value: unknown, name: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return value as UnknownRecord;
}

function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Orchestra Core returned an invalid ${name} list.`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return value;
}

function count(value: unknown, name: string): number {
  const result = finite(value, name);
  if (result < 0 || !Number.isInteger(result)) throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return result;
}

function percentage(value: unknown, name: string): number {
  const result = finite(value, name);
  if (result < 0 || result > 100) throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return result;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return value;
}

function literal<const T extends readonly unknown[]>(value: unknown, allowed: T, name: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`Orchestra Core returned an invalid ${name}.`);
  return value as T[number];
}

function optionalTextFields<T extends string>(source: UnknownRecord, names: readonly T[]): Partial<Record<T, string>> {
  return Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, text(source[name], name)]])) as Partial<Record<T, string>>;
}

function optionalNumberFields<T extends string>(source: UnknownRecord, names: readonly T[]): Partial<Record<T, number>> {
  return Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, finite(source[name], name)]])) as Partial<Record<T, number>>;
}

export function codexApprovalDecision(approval: MenuBarCodexApproval, accepted: boolean): unknown {
  if (!accepted) {
    if (approval.method === 'item/tool/requestUserInput') return { answers: {} };
    if (approval.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (approval.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
    return { decision: 'decline' };
  }
  if (approvalNeedsReview(approval)) throw new Error('This approval requires review in Orchestra Canvas.');
  return { decision: 'accept' };
}
