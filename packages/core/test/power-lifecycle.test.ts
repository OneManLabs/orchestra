import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreToAgentCommand, DeviceMetrics } from '@fleet/shared';
import { startFleetCore, type FleetCore } from '../src/server.js';

const TOKEN = 'power-lifecycle-test-token';

describe('automatic power lifecycle', () => {
  const cores: FleetCore[] = [];
  const sockets: WebSocket[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(cores.splice(0).map((core) => core.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function core(): Promise<FleetCore> {
    const dataDir = await mkdtemp(join(tmpdir(), 'fleet-power-'));
    directories.push(dataDir);
    const port = await availablePort();
    const instance = await startFleetCore({ host: '127.0.0.1', port, coreUrl: `http://127.0.0.1:${port}`, token: TOKEN, dataDir, allowUnauthenticatedLoopback: true });
    cores.push(instance);
    return instance;
  }

  async function connectAgent(instance: FleetCore, id: string, labels: string[], wakeOnLan: boolean): Promise<FakeAgent> {
    const agent = new FakeAgent(instance.url.replace(/^http/, 'ws'), id, labels, wakeOnLan);
    sockets.push(agent.socket);
    await agent.ready();
    await waitUntil(() => instance.store.state.devices.some((device) => device.id === id && device.status !== 'offline'));
    return agent;
  }

  it('selects and wakes an eligible offline worker, dispatches on reconnect, and shuts down only after all work and maintenance end', async () => {
    const instance = await core();
    const relay = await connectAgent(instance, 'relay', ['gateway'], true);
    const originalTarget = await connectAgent(instance, 'gpu', ['cuda'], false);
    originalTarget.socket.close();
    await waitUntil(() => instance.store.state.devices.find((device) => device.id === 'gpu')?.status === 'offline');

    const profile = await instance.app.inject({
      method: 'PUT', url: '/api/v2/device-profiles/gpu', payload: {
        wakeMacAddress: 'AA:BB:CC:DD:EE:FF', wakeBroadcastAddress: '192.168.1.255', wakeRelayDeviceId: 'relay',
        powerPolicy: { wakeForJobs: true, preventSleepDuringJobs: true, shutdownAfterIdleMinutes: 0.001 },
      },
    });
    expect(profile.statusCode).toBe(200);

    const decision = await instance.app.inject({ method: 'POST', url: '/api/v2/scheduling/select', payload: { requiredLabels: ['cuda'] } });
    expect(decision.json().selectedDeviceId).toBe('gpu');
    expect(decision.json().candidateScores.find((candidate: { deviceId: string }) => candidate.deviceId === 'gpu')).toMatchObject({ rejected: false });

    const created = await instance.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { name: 'Wake-managed training', kind: 'shell', command: 'echo trained', cwd: '/tmp', requiredLabels: ['cuda'] },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    const wake = await relay.waitFor((message) => message.type === 'device.power' && message.payload.action === 'wake');
    expect(wake.payload).toMatchObject({ action: 'wake', macAddress: 'AA:BB:CC:DD:EE:FF', broadcastAddress: '192.168.1.255' });
    await waitUntil(() => instance.store.state.jobs.find((job) => job.id === jobId)?.phase?.startsWith('Waking target device') ?? false);
    expect(instance.store.state.jobs.find((job) => job.id === jobId)).toMatchObject({ deviceId: 'gpu', status: 'queued' });

    const target = await connectAgent(instance, 'gpu', ['cuda'], false);
    await target.waitFor((message) => message.type === 'job.start' && message.payload.job.id === jobId);
    await waitUntil(() => instance.store.state.jobs.find((job) => job.id === jobId)?.status === 'running');

    const now = new Date().toISOString();
    instance.store.state.v2.storageConnections.push({ id: 'gpu-storage', name: 'GPU storage', kind: 'local', deviceId: 'gpu', rootPath: '/tmp', readOnly: false, status: 'connected', createdAt: now, updatedAt: now });
    instance.store.state.v2.transfers.push({ id: 'blocking-transfer', source: { providerId: 'gpu-storage', path: 'source', status: 'available' }, destination: { path: '/tmp/destination', status: 'pending' }, status: 'pending', totalBytes: 10, transferredBytes: 0, chunkSizeBytes: 1, compressed: false, encrypted: true, priority: 0, attempts: 0, maxAttempts: 3, createdAt: now });
    instance.store.state.sessions.push({ id: 'blocking-session', deviceId: 'gpu', cwd: '/tmp', title: 'Active session', permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'ready', createdAt: now, updatedAt: now, events: [], pendingApprovals: [] });
    instance.store.state.devices.find((device) => device.id === 'gpu')!.activeSessionIds.push('blocking-session');
    instance.store.state.v2.pipelines.push({ id: 'blocking-pipeline', name: 'Blocking pipeline', description: '', version: 1, status: 'active', nodes: [{ id: 'node', type: 'shell', name: 'Targeted node', position: { x: 0, y: 0 }, config: {}, requiredLabels: [], preferredDeviceIds: ['gpu'], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: false }], edges: [], triggers: [], parameters: {}, concurrencyLimit: 1, tags: [], createdAt: now, updatedAt: now, createdBy: 'test' });
    instance.store.state.v2.pipelineRuns.push({ id: 'blocking-run', pipelineId: 'blocking-pipeline', pipelineVersion: 1, state: 'running', triggerType: 'manual', parameters: {}, nodeRuns: [{ id: 'node-run', nodeId: 'node', state: 'pending', attempt: 0, input: {}, output: {} }], createdAt: now, createdBy: 'test' });
    instance.store.markDirty();

    target.send({ type: 'job.status', payload: { jobId, status: 'completed', exitCode: 0 } });
    await waitUntil(() => instance.store.state.jobs.find((job) => job.id === jobId)?.status === 'completed');
    await delay(1_150);
    expect(target.commandsFor('shutdown')).toHaveLength(0);

    instance.store.state.v2.transfers[0]!.status = 'running';
    await delay(1_050);
    expect(target.commandsFor('shutdown')).toHaveLength(0);

    instance.store.state.v2.transfers[0]!.status = 'succeeded';
    await delay(1_050);
    expect(target.commandsFor('shutdown')).toHaveLength(0);

    instance.store.state.sessions[0]!.status = 'stopped';
    instance.store.state.devices.find((device) => device.id === 'gpu')!.activeSessionIds = [];
    await delay(1_050);
    expect(target.commandsFor('shutdown')).toHaveLength(0);

    instance.store.state.v2.deviceProfiles.find((item) => item.deviceId === 'gpu')!.maintenanceMode = true;
    instance.store.state.v2.pipelineRuns[0]!.state = 'succeeded';
    await delay(1_050);
    expect(target.commandsFor('shutdown')).toHaveLength(0);

    instance.store.state.v2.deviceProfiles.find((item) => item.deviceId === 'gpu')!.maintenanceMode = false;
    await target.waitFor((message) => message.type === 'device.power' && message.payload.action === 'shutdown', 3_000);
    expect(instance.store.state.v2.audit.some((entry) => entry.action === 'device.power.idle-shutdown' && entry.resourceId === 'gpu' && entry.outcome === 'success')).toBe(true);
  }, 20_000);

  it('keeps an explicitly targeted offline job queued during quiet hours, then wakes it when retried after quiet hours', async () => {
    const instance = await core();
    const relay = await connectAgent(instance, 'relay', ['gateway'], true);
    const target = await connectAgent(instance, 'worker', ['worker'], false);
    target.socket.close();
    await waitUntil(() => instance.store.state.devices.find((device) => device.id === 'worker')?.status === 'offline');
    await instance.app.inject({
      method: 'PUT', url: '/api/v2/device-profiles/worker', payload: {
        wakeMacAddress: '11:22:33:44:55:66', wakeRelayDeviceId: 'relay',
        powerPolicy: { wakeForJobs: true, preventSleepDuringJobs: true, quietHours: { enabled: true, start: '00:00', end: '00:00', timezone: 'UTC', weekdays: [0, 1, 2, 3, 4, 5, 6] } },
      },
    });
    const created = await instance.app.inject({ method: 'POST', url: '/api/jobs', payload: { name: 'Quiet job', kind: 'shell', command: 'true', deviceId: 'worker', cwd: '/tmp' } });
    const jobId = created.json().id as string;
    await waitUntil(() => instance.store.state.jobs.find((job) => job.id === jobId)?.phase?.includes('quiet hours') ?? false);
    expect(relay.commandsFor('wake')).toHaveLength(0);

    const profile = instance.store.state.v2.deviceProfiles.find((item) => item.deviceId === 'worker')!;
    profile.powerPolicy.quietHours!.enabled = false;
    const retried = await instance.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/start` });
    expect(retried.statusCode).toBe(200);
    await relay.waitFor((message) => message.type === 'device.power' && message.payload.action === 'wake');
    expect(instance.store.state.jobs.find((job) => job.id === jobId)?.status).toBe('queued');
  }, 10_000);
});

class FakeAgent {
  readonly socket: WebSocket;
  readonly messages: CoreToAgentCommand[] = [];

  constructor(baseUrl: string, private readonly id: string, labels: string[], wakeOnLan: boolean) {
    this.socket = new WebSocket(`${baseUrl}/ws/agent`, { headers: { authorization: `Bearer ${TOKEN}` } });
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as CoreToAgentCommand;
      if (!message || typeof message.type !== 'string' || !('requestId' in message)) return;
      this.messages.push(message);
      this.send({ type: 'agent.response', requestId: message.requestId, payload: message.type === 'job.start' ? { accepted: true } : { ok: true } });
    });
    this.socket.once('open', () => this.send({
      type: 'agent.register', payload: {
        id, name: id, hostname: `${id}.local`, role: labels.includes('gateway') ? 'gateway' : 'worker', platform: 'linux', arch: 'x64', osName: 'Test Linux', osVersion: '1', agentVersion: '2.0.0', protocolVersion: 2,
        capabilities: { codex: true, git: true, docker: false, tailscale: true, cuda: labels.includes('cuda'), mlx: false, node: true, wakeOnLan, shell: '/bin/sh', labels },
        projectRoots: ['/tmp'], metrics: metrics(),
      },
    }));
  }

  async ready(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
  }

  send(value: unknown): void { this.socket.send(JSON.stringify(value)); }

  commandsFor(action: 'wake' | 'shutdown'): CoreToAgentCommand[] {
    return this.messages.filter((message) => message.type === 'device.power' && message.payload.action === action);
  }

  async waitFor(predicate: (message: CoreToAgentCommand) => boolean, timeoutMs = 2_000): Promise<CoreToAgentCommand> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = this.messages.find(predicate);
      if (message) return message;
      await delay(10);
    }
    throw new Error(`Timed out waiting for a command on ${this.id}.`);
  }
}

function metrics(): DeviceMetrics {
  return {
    cpu: { model: 'Test CPU', cores: 8, usagePercent: 5 },
    memory: { totalBytes: 16_000_000_000, usedBytes: 1_000_000_000, usagePercent: 6.25 },
    storage: [], gpus: [], network: { rxBytesPerSecond: 0, txBytesPerSecond: 0 }, uptimeSeconds: 10, sampledAt: new Date().toISOString(),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out waiting for Fleet state.');
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
