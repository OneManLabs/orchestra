import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, DeviceStatus, FleetJob, MenuBarSnapshot } from '@fleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetCore, type FleetCore } from '../src/server.js';
import { buildMenuBarSnapshot } from '../src/v2/menu-bar.js';

describe('menu-bar fleet snapshot', () => {
  const instances: FleetCore[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function core(allowUnauthenticatedLoopback = true): Promise<FleetCore> {
    const dataDir = await mkdtemp(join(tmpdir(), 'fleet-menu-bar-'));
    directories.push(dataDir);
    const instance = await startFleetCore({
      dataDir,
      token: 'test-master-token-with-at-least-32-bytes',
      listen: false,
      allowUnauthenticatedLoopback,
    });
    instances.push(instance);
    return instance;
  }

  function device(id: string, name: string, status: DeviceStatus, at: string): Device {
    return {
      id,
      name,
      hostname: `${id}.local`,
      role: id.includes('gpu') ? 'gpu' : id.includes('nas') ? 'storage' : 'worker',
      status,
      platform: id.includes('gpu') ? 'win32' : 'darwin',
      arch: 'arm64',
      osName: 'Test OS',
      osVersion: '1',
      agentVersion: '2.0.0',
      capabilities: {
        codex: true,
        git: true,
        docker: false,
        tailscale: true,
        cuda: id.includes('gpu'),
        mlx: !id.includes('gpu'),
        node: true,
        wakeOnLan: true,
        shell: '/bin/zsh',
        labels: ['worker'],
      },
      metrics: {
        cpu: { model: 'Test CPU', cores: 8, usagePercent: 18, temperatureCelsius: 54 },
        memory: { totalBytes: 64_000, usedBytes: 16_000, usagePercent: 25 },
        storage: [{ totalBytes: 1_000, usedBytes: 680, usagePercent: 68, mount: '/' }],
        gpus: id.includes('gpu') ? [{ vendor: 'NVIDIA', model: 'RTX', usagePercent: 84, vramUsedBytes: 12_800, vramTotalBytes: 16_000, temperatureCelsius: 71 }] : [],
        network: { rxBytesPerSecond: 1_000, txBytesPerSecond: 500 },
        uptimeSeconds: 100,
        sampledAt: at,
      },
      projectRoots: [],
      position: { x: 0, y: 0 },
      lastSeenAt: at,
      connectedAt: at,
      activeJobIds: status === 'busy' ? ['running'] : [],
      activeSessionIds: [],
    };
  }

  function job(id: string, status: FleetJob['status'], createdAt: string, overrides: Partial<FleetJob> = {}): FleetJob {
    return {
      id,
      name: id,
      kind: 'shell',
      prompt: id,
      command: 'true',
      status,
      permissionMode: 'read-only',
      approvalPolicy: 'on-request',
      requiredLabels: [],
      createdAt,
      output: [],
      ...overrides,
    };
  }

  it('returns a bounded live aggregate made from persisted fleet state', async () => {
    const instance = await core();
    const now = Date.now();
    const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    instance.store.state.settings.fleetName = 'Minerva Fleet';
    instance.store.state.devices.push(
      device('core', 'Core Mini', 'online', at(-1_000)),
      device('gpu', 'GPU Computer', 'busy', at(-2_000)),
      device('degraded', 'Worker Mini', 'degraded', at(-3_000)),
      device('nas', 'NAS', 'offline', at(-4_000)),
      device('away', 'MacBook', 'offline', at(-5_000)),
    );
    instance.store.state.v2.deviceProfiles.push({
      deviceId: 'nas',
      groupIds: [],
      powerPolicy: { wakeForJobs: true, preventSleepDuringJobs: true },
      updateChannel: 'stable',
      maintenanceMode: false,
      dataClassification: 'internal',
      trusted: true,
      quarantined: false,
      powerState: 'sleeping',
      powerStateUpdatedAt: at(-4_000),
      updatedAt: at(-4_000),
    });
    instance.store.state.jobs.push(
      job('running', 'running', at(-600_000), { deviceId: 'gpu', startedAt: at(-300_000), phase: 'Epoch 72 / 150', progress: 48 }),
      job('queued', 'queued', at(-240_000), { deviceId: 'core', phase: 'Waiting for device' }),
      job('recent-failure', 'failed', at(-180_000), { deviceId: 'gpu', startedAt: at(-150_000), completedAt: at(-120_000), phase: 'Failed', error: 'Process exited 1' }),
      job('old-failure', 'failed', at(-3_000_000), { deviceId: 'gpu', startedAt: at(-2_900_000), completedAt: at(-2_800_000), error: 'Historical failure' }),
      job('completed', 'completed', at(-120_000), { deviceId: 'core', startedAt: at(-90_000), completedAt: at(-60_000), phase: 'Completed' }),
    );
    instance.store.state.sessions.push({
      id: 'session',
      deviceId: 'gpu',
      projectId: 'project',
      cwd: '/work',
      title: 'Training setup',
      permissionMode: 'workspace-write',
      approvalPolicy: 'on-request',
      status: 'awaiting-approval',
      createdAt: at(-120_000),
      updatedAt: at(-30_000),
      events: [],
      pendingApprovals: [{ id: 'approval', requestId: 7, method: 'command/approval', title: 'Run sudo', detail: 'sudo apt update', params: {}, createdAt: at(-30_000) }],
    });
    instance.store.state.sessions.push({
      id: 'stopped-session', deviceId: 'gpu', cwd: '/work', title: 'Stopped', permissionMode: 'read-only', approvalPolicy: 'on-request', status: 'stopped', createdAt: at(-120_000), updatedAt: at(-20_000), events: [],
      pendingApprovals: [{ id: 'stale-approval', requestId: 8, method: 'command/approval', title: 'Stale', detail: 'Cannot be answered', params: {}, createdAt: at(-20_000) }],
    });
    instance.store.state.v2.pipelines.push({
      id: 'pipeline', name: 'Train and evaluate', description: '', version: 1, status: 'active',
      nodes: [{ id: 'gate', type: 'approval', name: 'Promote checkpoint', position: { x: 0, y: 0 }, config: {}, requiredLabels: [], preferredDeviceIds: [], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: true }],
      edges: [], triggers: [], parameters: {}, concurrencyLimit: 1, tags: [], createdAt: at(-100_000), updatedAt: at(-100_000), createdBy: 'operator',
    });
    instance.store.state.v2.pipelineRuns.push({
      id: 'pipeline-run', pipelineId: 'pipeline', pipelineVersion: 1, state: 'awaiting-approval', triggerType: 'manual', parameters: {},
      nodeRuns: [{ id: 'node-run', nodeId: 'gate', state: 'awaiting-approval', deviceId: 'core', attempt: 1, input: {}, output: {}, startedAt: at(-20_000) }],
      createdAt: at(-100_000), startedAt: at(-90_000), createdBy: 'operator',
    });
    instance.store.state.v2.alerts.push(
      { id: 'critical', deviceId: 'nas', severity: 'critical', status: 'open', title: 'NAS unavailable', detail: 'Storage is unavailable.', openedAt: at(-10_000), fingerprint: 'critical' },
      { id: 'warning', deviceId: 'gpu', jobId: 'recent-failure', severity: 'warning', status: 'acknowledged', title: 'GPU warm', detail: 'GPU is warm.', openedAt: at(-20_000), fingerprint: 'warning' },
      { id: 'resolved', severity: 'critical', status: 'resolved', title: 'Old alert', detail: 'Resolved.', openedAt: at(-100_000), resolvedAt: at(-90_000), fingerprint: 'resolved' },
      { id: 'info', severity: 'info', status: 'open', title: 'Informational', detail: 'Not urgent.', openedAt: at(-5_000), fingerprint: 'info' },
    );
    instance.store.state.activity.push(
      { id: 'duplicate-job-event', at: at(-60_000), type: 'job', severity: 'success', title: 'Job completed', detail: 'completed completed.', deviceId: 'core', entityId: 'completed' },
      { id: 'device-event', at: at(-45_000), type: 'device', severity: 'success', title: 'Device reconnected', detail: 'Core Mini is online.', deviceId: 'core' },
    );

    const response = await instance.app.inject({ method: 'GET', url: '/api/v2/menu-bar' });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json<MenuBarSnapshot>();

    expect(snapshot.core).toMatchObject({ status: 'healthy', connected: true, fleetName: 'Minerva Fleet', version: '2.0.0', schemaVersion: 2, protocolVersion: 2 });
    expect(snapshot.summary).toMatchObject({
      status: 'critical', totalDevices: 5, onlineDevices: 3, busyDevices: 1, degradedDevices: 1,
      sleepingDevices: 1, offlineDevices: 1, activeJobs: 1, queuedJobs: 1, failedJobs: 1,
      pendingApprovals: 2, openWarnings: 1, openCriticalAlerts: 1,
    });
    expect(snapshot.jobs).toHaveLength(3);
    expect(snapshot.jobs.map((item) => item.id)).toEqual(['running', 'queued', 'recent-failure']);
    expect(snapshot.jobs[0]).toMatchObject({ deviceName: 'GPU Computer', progress: 48, phase: 'Epoch 72 / 150' });
    expect(snapshot.jobs[0]?.elapsedMs).toBeGreaterThanOrEqual(299_000);
    expect(snapshot.devices).toHaveLength(5);
    expect(snapshot.devices.find((item) => item.id === 'nas')?.status).toBe('sleeping');
    expect(snapshot.devices.find((item) => item.id === 'gpu')).toMatchObject({
      activeJobCount: 1,
      metrics: { gpuPercent: 84, vramUsedBytes: 12_800, vramTotalBytes: 16_000, temperatureCelsius: 71 },
      capabilities: { cuda: true },
    });
    expect(snapshot.approvals.map((item) => item.kind).sort()).toEqual(['codex', 'pipeline']);
    expect(snapshot.alerts.map((item) => item.id)).toEqual(['critical', 'warning']);
    expect(snapshot.alerts[0]).toMatchObject({ deviceName: 'NAS' });
    expect(snapshot.alerts[1]).toMatchObject({ jobName: 'recent-failure' });
    expect(snapshot.recent.filter((item) => item.entityId === 'completed')).toHaveLength(1);
    expect(snapshot.recent.find((item) => item.entityId === 'completed')).toMatchObject({ kind: 'job', jobStatus: 'completed' });
  });

  it('keeps failures in the attention surface for exactly thirty minutes', async () => {
    const instance = await core();
    const now = new Date('2026-07-16T12:00:00.000Z');
    instance.store.state.jobs.push(
      job('boundary', 'failed', '2026-07-16T11:29:59.000Z', { completedAt: '2026-07-16T11:30:00.000Z' }),
      job('expired', 'failed', '2026-07-16T11:29:58.999Z', { completedAt: '2026-07-16T11:29:59.999Z' }),
    );

    const snapshot = buildMenuBarSnapshot(instance.store.state, instance.url, now);
    expect(snapshot.summary.failedJobs).toBe(1);
    expect(snapshot.summary.status).toBe('degraded');
    expect(snapshot.jobs.map((item) => item.id)).toEqual(['boundary']);
    expect(snapshot.recent.map((item) => item.entityId)).toContain('expired');
  });

  it('bounds every high-volume collection while keeping complete summary counts', async () => {
    const instance = await core();
    const now = new Date('2026-07-16T12:00:00.000Z');
    const at = now.toISOString();
    for (let index = 0; index < 105; index += 1) instance.store.state.devices.push(device(`device-${index}`, `Device ${index}`, 'online', at));
    for (let index = 0; index < 5; index += 1) instance.store.state.jobs.push(job(`running-${index}`, 'running', at, { deviceId: `device-${index}`, startedAt: at }));
    instance.store.state.sessions.push({
      id: 'many-approvals', deviceId: 'device-0', cwd: '/work', title: 'Many approvals', permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'awaiting-approval', createdAt: at, updatedAt: at, events: [],
      pendingApprovals: Array.from({ length: 12 }, (_, index) => ({ id: `approval-${index}`, requestId: index, method: 'command/approval', title: `Approval ${index}`, detail: 'Review command', params: {}, createdAt: at })),
    });
    for (let index = 0; index < 12; index += 1) {
      instance.store.state.v2.alerts.push({ id: `alert-${index}`, severity: 'warning', status: 'open', title: `Alert ${index}`, detail: 'Warning', openedAt: at, fingerprint: `alert-${index}` });
      instance.store.state.activity.push({ id: `activity-${index}`, at, type: 'system', severity: 'info', title: `Activity ${index}`, detail: 'Persisted activity' });
    }

    const snapshot = buildMenuBarSnapshot(instance.store.state, instance.url, now);
    expect(snapshot.jobs).toHaveLength(3);
    expect(snapshot.devices).toHaveLength(100);
    expect(snapshot.approvals).toHaveLength(10);
    expect(snapshot.alerts).toHaveLength(10);
    expect(snapshot.recent).toHaveLength(10);
    expect(snapshot.summary).toMatchObject({ totalDevices: 105, onlineDevices: 105, activeJobs: 5, pendingApprovals: 12, openWarnings: 12 });
  });

  it('requires authentication and accepts a read-scoped API token', async () => {
    const instance = await core(false);
    const recovery = { authorization: 'Bearer test-master-token-with-at-least-32-bytes' };
    const readIssued = await instance.app.inject({ method: 'POST', url: '/api/v2/api-tokens', headers: recovery, payload: { name: 'Menu bar reader', scopes: ['read'] } });
    const writeIssued = await instance.app.inject({ method: 'POST', url: '/api/v2/api-tokens', headers: recovery, payload: { name: 'Writer', scopes: ['write'] } });
    expect(readIssued.statusCode).toBe(201);
    expect(writeIssued.statusCode).toBe(201);

    expect((await instance.app.inject({ method: 'GET', url: '/api/v2/menu-bar' })).statusCode).toBe(401);
    expect((await instance.app.inject({ method: 'GET', url: '/api/v2/menu-bar', headers: { authorization: `Bearer ${writeIssued.json().token as string}` } })).statusCode).toBe(403);
    const allowed = await instance.app.inject({ method: 'GET', url: '/api/v2/menu-bar', headers: { authorization: `Bearer ${readIssued.json().token as string}` } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ core: { connected: true }, summary: { totalDevices: 0 } });
  });
});
