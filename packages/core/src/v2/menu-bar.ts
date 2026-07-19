import type {
  Device,
  FleetJob,
  MenuBarAlert,
  MenuBarApproval,
  MenuBarCodexSession,
  MenuBarDevice,
  MenuBarDeviceStatus,
  MenuBarJob,
  MenuBarRecentItem,
  MenuBarSnapshot,
} from '@fleet/shared';
import type { PersistedState } from '../store.js';

const JOB_LIMIT = 3;
const DEVICE_LIMIT = 100;
const APPROVAL_LIMIT = 10;
const ALERT_LIMIT = 10;
const RECENT_LIMIT = 10;
const CODEX_SESSION_LIMIT = 100;
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1_000;

const activeJobStatuses = new Set<FleetJob['status']>(['dispatching', 'running', 'awaiting-approval']);
const terminalJobStatuses = new Set<FleetJob['status']>(['completed', 'failed', 'cancelled']);

function timeValue(value?: string): number {
  if (!value) return 0;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

function latestJobTime(job: FleetJob): number {
  return timeValue(job.completedAt ?? job.startedAt ?? job.createdAt);
}

function definedMaximum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length ? Math.max(...present) : undefined;
}

function definedSum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function deviceStatus(state: PersistedState, device: Device): MenuBarDeviceStatus {
  if (device.status !== 'offline') return device.status;
  const profile = state.v2.deviceProfiles.find((item) => item.deviceId === device.id);
  return profile?.powerState === 'sleeping' ? 'sleeping' : 'offline';
}

function compactDevice(state: PersistedState, device: Device): MenuBarDevice {
  const gpuPercent = definedMaximum(device.metrics.gpus.map((gpu) => gpu.usagePercent));
  const vramUsedBytes = definedSum(device.metrics.gpus.map((gpu) => gpu.vramUsedBytes));
  const vramTotalBytes = definedSum(device.metrics.gpus.map((gpu) => gpu.vramTotalBytes));
  const temperatureCelsius = definedMaximum([
    device.metrics.cpu.temperatureCelsius,
    ...device.metrics.gpus.map((gpu) => gpu.temperatureCelsius),
  ]);
  const storageMaxPercent = definedMaximum(device.metrics.storage.map((storage) => storage.usagePercent));

  return {
    id: device.id,
    name: device.name,
    role: device.role,
    status: deviceStatus(state, device),
    platform: device.platform,
    lastSeenAt: device.lastSeenAt,
    activeJobCount: device.activeJobIds.length,
    metrics: {
      cpuPercent: device.metrics.cpu.usagePercent,
      memoryPercent: device.metrics.memory.usagePercent,
      storageMaxPercent,
      gpuPercent,
      vramUsedBytes,
      vramTotalBytes,
      temperatureCelsius,
      batteryPercent: device.metrics.battery?.percent,
      powerDrawWatts: device.metrics.powerDrawWatts,
      sampledAt: device.metrics.sampledAt,
    },
    capabilities: {
      codex: device.capabilities.codex,
      cuda: device.capabilities.cuda,
      mlx: device.capabilities.mlx,
      tailscale: device.capabilities.tailscale,
      wakeOnLan: device.capabilities.wakeOnLan,
      labels: device.capabilities.labels.slice(0, 32),
    },
  };
}

function compactJob(state: PersistedState, job: FleetJob, generatedAtMs: number): MenuBarJob {
  const startedAtMs = timeValue(job.startedAt);
  const completedAtMs = timeValue(job.completedAt);
  const elapsedMs = startedAtMs && !completedAtMs && activeJobStatuses.has(job.status)
    ? Math.max(0, generatedAtMs - startedAtMs)
    : undefined;
  const durationMs = startedAtMs && completedAtMs
    ? Math.max(0, completedAtMs - startedAtMs)
    : undefined;
  const device = job.deviceId ? state.devices.find((item) => item.id === job.deviceId) : undefined;

  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    status: job.status,
    deviceId: job.deviceId,
    deviceName: device?.name,
    progress: typeof job.progress === 'number' && Number.isFinite(job.progress) ? job.progress : undefined,
    phase: job.phase,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    elapsedMs,
    durationMs,
    error: job.error,
  };
}

function jobPriority(status: FleetJob['status']): number {
  if (status === 'awaiting-approval') return 0;
  if (status === 'running') return 1;
  if (status === 'dispatching') return 2;
  if (status === 'queued') return 3;
  return 4;
}

function collectApprovals(state: PersistedState): MenuBarApproval[] {
  const codex: MenuBarApproval[] = state.sessions.filter((session) => session.status === 'awaiting-approval').flatMap((session) => {
    const deviceName = state.devices.find((device) => device.id === session.deviceId)?.name;
    return session.pendingApprovals.map((approval) => ({
      kind: 'codex' as const,
      id: approval.id,
      sessionId: session.id,
      requestId: approval.requestId,
      deviceId: session.deviceId,
      deviceName,
      projectId: session.projectId,
      threadId: session.threadId,
      model: session.model,
      title: approval.title,
      detail: approval.detail,
      method: approval.method,
      params: approval.params,
      createdAt: approval.createdAt,
    }));
  });

  const pipeline: MenuBarApproval[] = state.v2.pipelineRuns.filter((run) => run.state === 'awaiting-approval').flatMap((run) => {
    const definition = state.v2.pipelines.find((item) => item.id === run.pipelineId);
    return run.nodeRuns.filter((nodeRun) => nodeRun.state === 'awaiting-approval').map((nodeRun) => {
      const node = definition?.nodes.find((item) => item.id === nodeRun.nodeId);
      const deviceName = nodeRun.deviceId ? state.devices.find((device) => device.id === nodeRun.deviceId)?.name : undefined;
      return {
        kind: 'pipeline' as const,
        id: `${run.id}:${nodeRun.id}`,
        pipelineRunId: run.id,
        pipelineId: run.pipelineId,
        pipelineName: definition?.name,
        nodeRunId: nodeRun.id,
        nodeId: nodeRun.nodeId,
        deviceId: nodeRun.deviceId,
        deviceName,
        title: node?.name ?? nodeRun.nodeId,
        detail: node?.type ? `${node.type} approval gate` : 'Pipeline approval gate',
        createdAt: nodeRun.startedAt ?? run.startedAt ?? run.createdAt,
      };
    });
  });

  return [...codex, ...pipeline].sort((left, right) => timeValue(right.createdAt) - timeValue(left.createdAt));
}

function collectAlerts(state: PersistedState): MenuBarAlert[] {
  return state.v2.alerts
    .filter((alert) => alert.status !== 'resolved' && (alert.severity === 'warning' || alert.severity === 'critical'))
    .map((alert) => ({
      id: alert.id,
      severity: alert.severity as 'warning' | 'critical',
      status: alert.status as 'open' | 'acknowledged',
      title: alert.title,
      detail: alert.detail,
      openedAt: alert.openedAt,
      deviceId: alert.deviceId,
      deviceName: alert.deviceId ? state.devices.find((device) => device.id === alert.deviceId)?.name : undefined,
      jobId: alert.jobId,
      jobName: alert.jobId ? state.jobs.find((job) => job.id === alert.jobId)?.name : undefined,
    }))
    .sort((left, right) => {
      const severity = (left.severity === 'critical' ? 0 : 1) - (right.severity === 'critical' ? 0 : 1);
      return severity || timeValue(right.openedAt) - timeValue(left.openedAt);
    });
}

function collectRecent(state: PersistedState): MenuBarRecentItem[] {
  const terminalJobs = state.jobs.filter((job) => terminalJobStatuses.has(job.status) && job.completedAt);
  const terminalJobIds = new Set(terminalJobs.map((job) => job.id));
  const jobs: MenuBarRecentItem[] = terminalJobs.map((job) => {
    const status = job.status as 'completed' | 'failed' | 'cancelled';
    const deviceName = job.deviceId ? state.devices.find((device) => device.id === job.deviceId)?.name : undefined;
    return {
      id: `job:${job.id}`,
      kind: 'job',
      at: job.completedAt!,
      severity: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning',
      title: job.name,
      detail: job.error ?? job.phase ?? `Job ${status}`,
      deviceId: job.deviceId,
      deviceName,
      entityId: job.id,
      jobStatus: status,
    };
  });
  const activity: MenuBarRecentItem[] = state.activity
    .filter((event) => !(event.type === 'job' && event.entityId && terminalJobIds.has(event.entityId)))
    .map((event) => ({
      id: `activity:${event.id}`,
      kind: 'activity',
      at: event.at,
      severity: event.severity,
      title: event.title,
      detail: event.detail,
      deviceId: event.deviceId,
      deviceName: event.deviceId ? state.devices.find((device) => device.id === event.deviceId)?.name : undefined,
      entityId: event.entityId,
    }));
  return [...jobs, ...activity].sort((left, right) => timeValue(right.at) - timeValue(left.at));
}

function codexSessionPriority(status: MenuBarCodexSession['status']): number {
  if (status === 'awaiting-approval') return 0;
  if (status === 'thinking') return 1;
  if (status === 'error') return 2;
  if (status === 'completed') return 3;
  if (status === 'ready' || status === 'starting') return 4;
  return 5;
}

function collectCodexSessions(state: PersistedState): MenuBarCodexSession[] {
  return state.sessions
    .filter((session) => session.kind !== 'fleet-system')
    .map((session) => ({
      id: session.id,
      deviceId: session.deviceId,
      deviceName: state.devices.find((device) => device.id === session.deviceId)?.name,
      projectId: session.projectId,
      threadId: session.threadId,
      model: session.model,
      title: session.title,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pendingApprovalCount: session.pendingApprovals.length,
    }))
    .sort((left, right) => codexSessionPriority(left.status) - codexSessionPriority(right.status)
      || timeValue(right.updatedAt) - timeValue(left.updatedAt))
    .slice(0, CODEX_SESSION_LIMIT);
}

/** Build a bounded menu-bar view exclusively from persisted Fleet state. */
export function buildMenuBarSnapshot(state: PersistedState, coreUrl: string, now = new Date()): MenuBarSnapshot {
  const generatedAt = now.toISOString();
  const generatedAtMs = now.getTime();
  const statuses = state.devices.map((device) => deviceStatus(state, device));
  const approvals = collectApprovals(state);
  const alerts = collectAlerts(state);
  const activeJobs = state.jobs.filter((job) => activeJobStatuses.has(job.status)).length;
  const queuedJobs = state.jobs.filter((job) => job.status === 'queued').length;
  const recentFailureCutoff = generatedAtMs - RECENT_FAILURE_WINDOW_MS;
  const recentFailedJobs = state.jobs.filter((job) => job.status === 'failed' && latestJobTime(job) >= recentFailureCutoff);
  const failedJobs = recentFailedJobs.length;
  const busyDevices = statuses.filter((status) => status === 'busy').length;
  const degradedDevices = statuses.filter((status) => status === 'degraded').length;
  const sleepingDevices = statuses.filter((status) => status === 'sleeping').length;
  const offlineDevices = statuses.filter((status) => status === 'offline').length;
  const onlineDevices = statuses.filter((status) => status === 'online' || status === 'busy' || status === 'degraded').length;
  const openWarnings = alerts.filter((alert) => alert.severity === 'warning').length;
  const openCriticalAlerts = alerts.filter((alert) => alert.severity === 'critical').length;
  const health = openCriticalAlerts > 0
    ? 'critical'
    : openWarnings > 0 || degradedDevices > 0 || approvals.length > 0 || failedJobs > 0
      ? 'degraded'
      : 'healthy';

  const jobs = state.jobs
    .filter((job) => activeJobStatuses.has(job.status) || job.status === 'queued' || recentFailedJobs.includes(job))
    .sort((left, right) => jobPriority(left.status) - jobPriority(right.status) || latestJobTime(right) - latestJobTime(left))
    .slice(0, JOB_LIMIT)
    .map((job) => compactJob(state, job, generatedAtMs));
  const devices = [...state.devices]
    .sort((left, right) => {
      const priority: Record<MenuBarDeviceStatus, number> = { busy: 0, degraded: 1, online: 2, sleeping: 3, offline: 4 };
      return priority[deviceStatus(state, left)] - priority[deviceStatus(state, right)] || left.name.localeCompare(right.name);
    })
    .slice(0, DEVICE_LIMIT)
    .map((device) => compactDevice(state, device));

  return {
    generatedAt,
    core: {
      status: 'healthy',
      connected: true,
      fleetName: state.settings.fleetName,
      version: state.version,
      schemaVersion: state.v2.schemaVersion,
      protocolVersion: state.v2.protocolVersion,
      url: coreUrl,
    },
    summary: {
      status: health,
      totalDevices: state.devices.length,
      onlineDevices,
      busyDevices,
      degradedDevices,
      sleepingDevices,
      offlineDevices,
      activeJobs,
      queuedJobs,
      failedJobs,
      pendingApprovals: approvals.length,
      openWarnings,
      openCriticalAlerts,
    },
    jobs,
    devices,
    approvals: approvals.slice(0, APPROVAL_LIMIT),
    alerts: alerts.slice(0, ALERT_LIMIT),
    recent: collectRecent(state).slice(0, RECENT_LIMIT),
    codexSessions: collectCodexSessions(state),
  };
}
