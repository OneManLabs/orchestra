import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetCore, type FleetCore } from '../src/server.js';
import { decryptValue } from '../src/v2/security.js';

describe('Fleet Core V2', () => {
  const instances: FleetCore[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function core(): Promise<FleetCore> {
    const dataDir = await mkdtemp(join(tmpdir(), 'fleet-v2-'));
    directories.push(dataDir);
    const instance = await startFleetCore({ dataDir, token: 'test-master-token', listen: false, allowUnauthenticatedLoopback: true });
    instances.push(instance);
    return instance;
  }

  function addStorageDevice(instance: FleetCore, id = 'nas-agent'): void {
    const at = new Date().toISOString();
    instance.store.state.devices.push({
      id,
      name: 'Synology NAS',
      hostname: 'synology.local',
      role: 'storage',
      status: 'online',
      platform: 'linux',
      arch: 'x64',
      osName: 'Synology DSM',
      osVersion: '7',
      agentVersion: '2.0.0',
      capabilities: { codex: false, git: false, docker: false, tailscale: true, cuda: false, mlx: false, node: true, wakeOnLan: false, shell: '/bin/sh', labels: ['storage'] },
      metrics: { cpu: { model: 'NAS CPU', cores: 4, usagePercent: 0 }, memory: { totalBytes: 1, usedBytes: 0, usagePercent: 0 }, storage: [], gpus: [], network: { rxBytesPerSecond: 0, txBytesPerSecond: 0 }, uptimeSeconds: 1, sampledAt: at },
      projectRoots: ['/volume1/homes/Whimzyy'],
      position: { x: 0, y: 0 },
      lastSeenAt: at,
      connectedAt: at,
      activeJobIds: [],
      activeSessionIds: [],
    });
  }

  it('exchanges one-time enrollment tokens and stores only hashes', async () => {
    const instance = await core();
    const issued = await instance.app.inject({ method: 'POST', url: '/api/v2/enrollment-tokens', payload: { label: 'GPU enrollment', maxUses: 1 } });
    expect(issued.statusCode).toBe(201);
    const token = issued.json().token as string;

    const incompatible = await instance.app.inject({ method: 'POST', url: '/api/v2/enrollment/exchange', payload: { token, device: { id: 'old-agent', name: 'Old', hostname: 'old.local', platform: 'linux', arch: 'x64', agentVersion: '1.0.0', protocolVersion: 1 } } });
    expect(incompatible.statusCode).toBe(409);

    const exchange = await instance.app.inject({ method: 'POST', url: '/api/v2/enrollment/exchange', payload: { token, device: { id: 'gpu-1', name: 'GPU', hostname: 'gpu.local', platform: 'linux', arch: 'x64', agentVersion: '2.0.0', protocolVersion: 2 } } });
    expect(exchange.statusCode).toBe(201);
    expect(exchange.json()).toMatchObject({ deviceId: 'gpu-1', protocolVersion: 2 });
    expect(exchange.json().credential).toMatch(/^flc_/);

    const reused = await instance.app.inject({ method: 'POST', url: '/api/v2/enrollment/exchange', payload: { token, device: { id: 'gpu-2', name: 'GPU 2', hostname: 'gpu2.local', platform: 'linux', arch: 'x64', agentVersion: '2.0.0', protocolVersion: 2 } } });
    expect(reused.statusCode).toBe(401);
    await instance.store.flush();
    const persisted = await readFile(join(instance.store.filePath), 'utf8');
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(exchange.json().credential);
  });

  it('encrypts vault values and maintains a verifiable audit chain', async () => {
    const instance = await core();
    const created = await instance.app.inject({ method: 'POST', url: '/api/v2/secrets', payload: { name: 'NAS key', value: 'very-secret-value' } });
    expect(created.statusCode).toBe(201);
    const secretId = created.json().id as string;
    expect(JSON.stringify((await instance.app.inject({ method: 'GET', url: '/api/snapshot' })).json())).not.toContain('very-secret-value');
    const revealed = await instance.app.inject({ method: 'POST', url: `/api/v2/secrets/${secretId}/read` });
    expect(revealed.json().value).toBe('very-secret-value');
    const verification = await instance.app.inject({ method: 'GET', url: '/api/v2/audit/verify' });
    expect(verification.json()).toEqual({ valid: true });
  });

  it('validates storage PATCH references and merged device/root invariants', async () => {
    const instance = await core();
    addStorageDevice(instance);
    const created = await instance.app.inject({ method: 'POST', url: '/api/v2/storage-connections', payload: { name: 'Core storage', kind: 'local' } });
    expect(created.statusCode).toBe(201);
    const url = `/api/v2/storage-connections/${created.json().id as string}`;

    expect((await instance.app.inject({ method: 'PATCH', url, payload: { deviceId: 42 } })).statusCode).toBe(400);
    expect((await instance.app.inject({ method: 'PATCH', url, payload: { deviceId: 'missing-agent', rootPath: '/volume1/data' } })).statusCode).toBe(404);
    expect((await instance.app.inject({ method: 'PATCH', url, payload: { deviceId: 'nas-agent', rootPath: null } })).statusCode).toBe(400);
    expect((await instance.app.inject({ method: 'PATCH', url, payload: { kind: 's3', deviceId: 'nas-agent', rootPath: '/volume1/data' } })).statusCode).toBe(400);
    expect((await instance.app.inject({ method: 'PATCH', url, payload: { secretId: 'missing-secret' } })).statusCode).toBe(404);
    expect(instance.store.state.v2.storageConnections[0]).toMatchObject({ name: 'Core storage', kind: 'local', status: 'unconfigured' });
    expect(instance.store.state.v2.storageConnections[0]?.deviceId).toBeUndefined();
  });

  it('rejects unknown, prototype, and telemetry fields in storage PATCH requests', async () => {
    const instance = await core();
    const created = await instance.app.inject({ method: 'POST', url: '/api/v2/storage-connections', payload: { name: 'Protected storage', kind: 'local', rootPath: '/Volumes/NAS/test' } });
    const url = `/api/v2/storage-connections/${created.json().id as string}`;

    expect((await instance.app.inject({ method: 'PATCH', url, payload: { status: 'connected', capacityBytes: 1 } })).statusCode).toBe(400);
    const prototypePayload = JSON.parse('{"__proto__":{"status":"connected"}}') as Record<string, unknown>;
    expect((await instance.app.inject({ method: 'PATCH', url, payload: prototypePayload })).statusCode).toBe(400);
    expect(instance.store.state.v2.storageConnections[0]).toMatchObject({ name: 'Protected storage', kind: 'local', status: 'unconfigured' });
    expect(instance.store.state.v2.storageConnections[0]?.capacityBytes).toBeUndefined();
  });

  it('atomically migrates Core-mounted storage and invalidates stale backing telemetry', async () => {
    const instance = await core();
    addStorageDevice(instance);
    const secret = await instance.app.inject({ method: 'POST', url: '/api/v2/secrets', payload: { name: 'NAS secret', value: 'not-returned' } });
    const created = await instance.app.inject({
      method: 'POST',
      url: '/api/v2/storage-connections',
      payload: { name: 'Core NAS', kind: 'local', rootPath: '/Volumes/NAS/test', endpoint: 'https://legacy.invalid', bucket: 'legacy', region: 'local', secretId: secret.json().id, quotaBytes: 4_096 },
    });
    expect(created.statusCode).toBe(201);
    const item = instance.store.state.v2.storageConnections[0]!;
    const immutable = { id: item.id, createdAt: item.createdAt };
    item.status = 'connected';
    item.capacityBytes = 10_000;
    item.usedBytes = 2_500;
    item.lastCheckedAt = '2026-07-16T00:00:00.000Z';

    const updated = await instance.app.inject({
      method: 'PATCH',
      url: `/api/v2/storage-connections/${item.id}`,
      payload: {
        name: 'Synology NAS',
        kind: 'synology',
        deviceId: 'nas-agent',
        rootPath: '/volume1/homes/Whimzyy/NAS',
        endpoint: null,
        bucket: null,
        region: null,
        secretId: null,
        quotaBytes: null,
        readOnly: false,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      ...immutable,
      name: 'Synology NAS',
      kind: 'synology',
      deviceId: 'nas-agent',
      rootPath: '/volume1/homes/Whimzyy/NAS',
      readOnly: false,
      status: 'unconfigured',
    });
    expect(updated.json()).not.toHaveProperty('capacityBytes');
    expect(updated.json()).not.toHaveProperty('usedBytes');
    expect(updated.json()).not.toHaveProperty('lastCheckedAt');
    expect(updated.json()).not.toHaveProperty('endpoint');
    expect(updated.json()).not.toHaveProperty('bucket');
    expect(updated.json()).not.toHaveProperty('region');
    expect(updated.json()).not.toHaveProperty('secretId');
    expect(updated.json()).not.toHaveProperty('quotaBytes');

    item.status = 'connected';
    item.capacityBytes = 20_000;
    item.usedBytes = 5_000;
    item.lastCheckedAt = '2026-07-16T01:00:00.000Z';
    const metadataOnly = await instance.app.inject({
      method: 'PATCH',
      url: `/api/v2/storage-connections/${item.id}`,
      payload: { name: 'Synology NAS read-only', readOnly: true, quotaBytes: 16_384 },
    });
    expect(metadataOnly.statusCode).toBe(200);
    expect(metadataOnly.json()).toMatchObject({
      name: 'Synology NAS read-only',
      readOnly: true,
      quotaBytes: 16_384,
      status: 'connected',
      capacityBytes: 20_000,
      usedBytes: 5_000,
      lastCheckedAt: '2026-07-16T01:00:00.000Z',
    });
  });

  it('rejects cyclic pipeline graphs', async () => {
    const instance = await core();
    const node = (id: string) => ({ id, type: 'wait', name: id, position: { x: 0, y: 0 }, config: { seconds: 0 }, requiredLabels: [], preferredDeviceIds: [], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: false });
    const response = await instance.app.inject({ method: 'POST', url: '/api/v2/pipelines', payload: { name: 'Cycle', nodes: [node('a'), node('b')], edges: [{ id: 'ab', source: 'a', target: 'b', condition: 'success' }, { id: 'ba', source: 'b', target: 'a', condition: 'success' }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('cycle');
  });

  it('runs independent pipeline branches concurrently', async () => {
    const instance = await core();
    const waitNode = (id: string) => ({ id, type: 'wait', name: id, position: { x: 0, y: 0 }, config: { milliseconds: 200 }, requiredLabels: [], preferredDeviceIds: [], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: false });
    const pipeline = await instance.app.inject({ method: 'POST', url: '/api/v2/pipelines', payload: { name: 'Parallel waits', concurrencyLimit: 2, nodes: [waitNode('a'), waitNode('b')], edges: [] } });
    const started = Date.now();
    const response = await instance.app.inject({ method: 'POST', url: `/api/v2/pipelines/${pipeline.json().id}/run`, payload: {} });
    const runId = response.json().id as string;
    while (!['succeeded', 'failed'].includes(instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)!.state)) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)!.state).toBe('succeeded');
    expect(Date.now() - started).toBeLessThan(350);
  });

  it('resumes an approved action instead of treating approval as the action', async () => {
    const instance = await core();
    const pipeline = await instance.app.inject({ method: 'POST', url: '/api/v2/pipelines', payload: { name: 'Approved wait', nodes: [{ id: 'guarded', type: 'wait', name: 'Guarded action', position: { x: 0, y: 0 }, config: { milliseconds: 1 }, requiredLabels: [], preferredDeviceIds: [], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: true }], edges: [] } });
    const started = await instance.app.inject({ method: 'POST', url: `/api/v2/pipelines/${pipeline.json().id}/run`, payload: {} });
    const runId = started.json().id as string;
    await waitUntil(() => instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)?.state === 'awaiting-approval');
    const nodeRun = instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)!.nodeRuns[0]!;
    const approved = await instance.app.inject({ method: 'POST', url: `/api/v2/pipeline-runs/${runId}/approve`, payload: { nodeRunId: nodeRun.id, approved: true } });
    expect(approved.statusCode).toBe(200);
    await waitUntil(() => instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)?.state === 'succeeded');
    expect(instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)!.nodeRuns[0]).toMatchObject({ state: 'succeeded', attempt: 1, output: { waitedMilliseconds: 1 } });
  });

  it('evaluates conditional edges with a safe expression language', async () => {
    const instance = await core();
    const node = (id: string) => ({ id, type: 'wait', name: id, position: { x: 0, y: 0 }, config: { milliseconds: 0 }, requiredLabels: [], preferredDeviceIds: [], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: false });
    const pipeline = await instance.app.inject({ method: 'POST', url: '/api/v2/pipelines', payload: { name: 'Conditions', concurrencyLimit: 2, nodes: [node('source'), node('yes'), node('no')], edges: [{ id: 'yes-edge', source: 'source', target: 'yes', condition: 'expression', expression: 'output.waitedMilliseconds == 0' }, { id: 'no-edge', source: 'source', target: 'no', condition: 'expression', expression: 'output.waitedMilliseconds == 1' }] } });
    expect(pipeline.statusCode).toBe(201);
    const started = await instance.app.inject({ method: 'POST', url: `/api/v2/pipelines/${pipeline.json().id}/run`, payload: {} });
    const runId = started.json().id as string;
    await waitUntil(() => instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)?.state === 'succeeded');
    const runs = Object.fromEntries(instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)!.nodeRuns.map((run) => [run.nodeId, run.state]));
    expect(runs).toEqual({ source: 'succeeded', yes: 'succeeded', no: 'skipped' });
  });

  it('executes explicit failure branches before finalizing a failed pipeline', async () => {
    const instance = await core();
    const base = { position: { x: 0, y: 0 }, requiredLabels: [], preferredDeviceIds: [], retries: 0, retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: false };
    const pipeline = await instance.app.inject({ method: 'POST', url: '/api/v2/pipelines', payload: { name: 'Failure route', nodes: [{ ...base, id: 'fail', type: 'http', name: 'Expected failure', config: { url: 'not-a-url' } }, { ...base, id: 'recover', type: 'wait', name: 'Failure handler', config: { milliseconds: 1 } }], edges: [{ id: 'failure-edge', source: 'fail', target: 'recover', condition: 'failure' }] } });
    const started = await instance.app.inject({ method: 'POST', url: `/api/v2/pipelines/${pipeline.json().id}/run`, payload: {} });
    const runId = started.json().id as string;
    await waitUntil(() => instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)?.state === 'failed');
    const states = Object.fromEntries(instance.store.state.v2.pipelineRuns.find((run) => run.id === runId)!.nodeRuns.map((run) => [run.nodeId, run.state]));
    expect(states).toEqual({ fail: 'failed', recover: 'succeeded' });
  });

  it('blocks loopback and metadata webhook targets', async () => {
    const instance = await core();
    for (const url of ['http://127.0.0.1:9/hook', 'http://169.254.169.254/latest/meta-data']) {
      const created = await instance.app.inject({ method: 'POST', url: '/api/v2/webhooks', payload: { name: 'Unsafe', url } });
      const tested = await instance.app.inject({ method: 'POST', url: `/api/v2/webhooks/${created.json().id}/test` });
      expect(tested.statusCode).toBe(403);
    }
  });

  it('bounds history in client snapshots while retaining full persisted telemetry', async () => {
    const instance = await core();
    for (let index = 0; index < 2_100; index += 1) instance.store.state.v2.metricHistory.push({ id: String(index), deviceId: 'device', sampledAt: new Date(index * 1_000).toISOString(), cpuPercent: 0, memoryPercent: 0, rxBytesPerSecond: 0, txBytesPerSecond: 0 });
    const snapshot = (await instance.app.inject({ method: 'GET', url: '/api/snapshot' })).json();
    expect(snapshot.v2.metricHistory).toHaveLength(2_000);
    expect(instance.store.state.v2.metricHistory).toHaveLength(2_100);
  });

  it('keeps artifact versions append-only and records exact promotion lineage', async () => {
    const instance = await core();
    const created = await instance.app.inject({ method: 'POST', url: '/api/v2/artifacts', payload: { name: 'Release bundle', description: 'Signed output', kind: 'build', tags: ['release'], classification: 'internal' } });
    expect(created.statusCode).toBe(201);
    const artifactId = created.json().id as string;
    const checksum = 'AB'.repeat(32);
    const version = await instance.app.inject({ method: 'POST', url: `/api/v2/artifacts/${artifactId}/versions`, payload: { sizeBytes: 42, checksumSha256: checksum, mimeType: 'application/octet-stream', locations: [{ path: 'releases/bundle.tar', status: 'available', cached: false }], metadata: { branch: 'main' } } });
    expect(version.statusCode).toBe(201);
    expect(version.json()).toMatchObject({ version: 1, checksumSha256: checksum.toLowerCase(), locations: [{ path: 'releases/bundle.tar', status: 'available', cached: false }] });
    expect(version.json().locations[0].id).toBeTruthy();

    const promoted = await instance.app.inject({ method: 'POST', url: `/api/v2/artifacts/${artifactId}/promote`, payload: { environment: 'production', versionId: version.json().id, confirm: true } });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ promotedEnvironment: 'production', promotedVersionId: version.json().id });
    expect(promoted.json().promotedAt).toBeTruthy();

    const overwrite = await instance.app.inject({ method: 'PATCH', url: `/api/v2/artifacts/${artifactId}`, payload: { versions: [] } });
    expect(overwrite.statusCode).toBe(400);
    expect(instance.store.state.v2.artifacts[0]?.versions).toHaveLength(1);
    const invalidLocation = await instance.app.inject({ method: 'POST', url: `/api/v2/artifacts/${artifactId}/versions`, payload: { sizeBytes: 1, checksumSha256: '0'.repeat(64), locations: [{ path: '/tmp/file', deviceId: 'device', providerId: 'provider' }] } });
    expect(invalidLocation.statusCode).toBe(400);
  });

  it('refuses mounted directory creation through a symlink without mutating outside content', async () => {
    const instance = await core();
    const storageRoot = join(instance.store.filePath, '..', 'directory-storage');
    const outsideDirectory = join(instance.store.filePath, '..', 'directory-outside');
    await mkdir(storageRoot, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, 'sentinel.txt'), 'unchanged');
    await symlink(outsideDirectory, join(storageRoot, 'link'));
    const provider = await instance.app.inject({ method: 'POST', url: '/api/v2/storage-connections', payload: { name: 'Mounted directory storage', kind: 'local', rootPath: storageRoot } });

    const response = await instance.app.inject({
      method: 'POST',
      url: `/api/v2/storage-connections/${provider.json().id as string}/directories`,
      payload: { path: 'link/new/deep' },
    });

    expect(response.statusCode).toBe(403);
    expect(await readFile(join(outsideDirectory, 'sentinel.txt'), 'utf8')).toBe('unchanged');
    await expect(stat(join(outsideDirectory, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed transfer chunks and unsafe mounted destinations without outside mutations', async () => {
    const instance = await core();
    const manual = await instance.app.inject({
      method: 'POST', url: '/api/v2/transfers',
      payload: { source: { path: 'upload-source' }, destination: { path: 'upload-destination' }, totalBytes: 3, chunkSizeBytes: 65_536 },
    });
    const malformed = await instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${manual.json().id}/chunks`, payload: { offset: 0, data: '!!!!' } });
    expect(malformed.statusCode).toBe(400);
    expect(manual.json().transferredBytes).toBe(0);
    const concurrent = await Promise.all([
      instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${manual.json().id}/chunks`, payload: { offset: 0, data: Buffer.from('abc').toString('base64') } }),
      instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${manual.json().id}/chunks`, payload: { offset: 0, data: Buffer.from('abc').toString('base64') } }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(instance.store.state.v2.transfers.find((item) => item.id === manual.json().id)?.transferredBytes).toBe(3);
    expect((await instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${manual.json().id}/complete` })).statusCode).toBe(200);
    const unsafeSize = await instance.app.inject({
      method: 'POST', url: '/api/v2/transfers',
      payload: { source: { path: 'source' }, destination: { path: 'destination' }, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
    });
    expect(unsafeSize.statusCode).toBe(400);

    const storageRoot = join(instance.store.filePath, '..', 'mounted-storage');
    const sourcePath = join(storageRoot, 'source.bin');
    const outsidePath = join(instance.store.filePath, '..', 'must-not-change.bin');
    await mkdir(storageRoot, { recursive: true });
    await writeFile(sourcePath, 'trusted source');
    await writeFile(outsidePath, 'outside');
    await symlink(outsidePath, join(storageRoot, 'destination.bin'));
    const provider = await instance.app.inject({ method: 'POST', url: '/api/v2/storage-connections', payload: { name: 'Mounted test storage', kind: 'local', rootPath: storageRoot } });
    const transfer = await instance.app.inject({
      method: 'POST', url: '/api/v2/transfers',
      payload: {
        source: { providerId: provider.json().id, path: 'source.bin' },
        destination: { providerId: provider.json().id, path: 'destination.bin' },
        totalBytes: 14,
        chunkSizeBytes: 65_536,
        maxAttempts: 1,
      },
    });
    expect((await instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${transfer.json().id}/start` })).statusCode).toBe(202);
    await waitUntil(() => instance.store.state.v2.transfers.find((item) => item.id === transfer.json().id)?.status === 'failed');
    expect(await readFile(outsidePath, 'utf8')).toBe('outside');

    const outsideDirectory = join(instance.store.filePath, '..', 'outside-directory');
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, 'sentinel.txt'), 'unchanged');
    await symlink(outsideDirectory, join(storageRoot, 'link'));
    const nestedTransfer = await instance.app.inject({
      method: 'POST', url: '/api/v2/transfers',
      payload: {
        source: { providerId: provider.json().id, path: 'source.bin' },
        destination: { providerId: provider.json().id, path: 'link/created/deep/destination.bin' },
        totalBytes: 14,
        chunkSizeBytes: 65_536,
        maxAttempts: 1,
      },
    });
    expect((await instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${nestedTransfer.json().id}/start` })).statusCode).toBe(202);
    await waitUntil(() => instance.store.state.v2.transfers.find((item) => item.id === nestedTransfer.json().id)?.status === 'failed');
    expect(await readFile(join(outsideDirectory, 'sentinel.txt'), 'utf8')).toBe('unchanged');
    await expect(stat(join(outsideDirectory, 'created'))).rejects.toMatchObject({ code: 'ENOENT' });

    const hardlinkDestination = join(storageRoot, 'hardlink-destination.bin');
    await link(outsidePath, hardlinkDestination);
    const hardlinkTransfer = await instance.app.inject({
      method: 'POST', url: '/api/v2/transfers',
      payload: {
        source: { providerId: provider.json().id, path: 'source.bin' },
        destination: { providerId: provider.json().id, path: 'hardlink-destination.bin' },
        totalBytes: 14,
        chunkSizeBytes: 65_536,
        maxAttempts: 1,
      },
    });
    expect((await instance.app.inject({ method: 'POST', url: `/api/v2/transfers/${hardlinkTransfer.json().id}/start` })).statusCode).toBe(202);
    await waitUntil(() => instance.store.state.v2.transfers.find((item) => item.id === hardlinkTransfer.json().id)?.status === 'failed');
    expect(await readFile(outsidePath, 'utf8')).toBe('outside');
  });

  it('writes completed backup metadata into the encrypted snapshot', async () => {
    const instance = await core();
    const response = await instance.app.inject({ method: 'POST', url: '/api/v2/backups', payload: { kind: 'manual' } });
    expect(response.statusCode).toBe(201);
    const backup = response.json() as { id: string; destination: string; status: string };
    expect(backup.status).toBe('succeeded');
    const envelope = JSON.parse(await readFile(backup.destination, 'utf8')) as { iv: string; authTag: string; ciphertext: string };
    const snapshot = JSON.parse(decryptValue(envelope, 'test-master-token')) as { v2: { backups: Array<{ id: string; status: string; completedAt?: string }> } };
    expect(snapshot.v2.backups.find((item) => item.id === backup.id)).toMatchObject({ status: 'succeeded' });
    expect(snapshot.v2.backups.some((item) => ['queued', 'running'].includes(item.status))).toBe(false);
  });

  it('stages a restore without mutating live state and applies it atomically on restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fleet-v2-restore-'));
    directories.push(dataDir);
    const instance = await startFleetCore({ dataDir, token: 'test-master-token', listen: false, allowUnauthenticatedLoopback: true });
    instances.push(instance);

    instance.store.state.settings.fleetName = 'Backed up fleet';
    instance.store.markDirty();
    const created = await instance.app.inject({ method: 'POST', url: '/api/v2/backups', payload: { kind: 'manual' } });
    expect(created.statusCode).toBe(201);
    const backup = created.json() as { id: string };

    instance.store.state.settings.fleetName = 'Live fleet after backup';
    instance.store.markDirty();
    await instance.store.flush();
    const liveSettings = instance.store.state.settings;
    const liveV2 = instance.store.state.v2;
    const restored = await instance.app.inject({ method: 'POST', url: `/api/v2/backups/${backup.id}/restore`, payload: { confirm: true } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ restoreStaged: true, restartRequired: true, backupId: backup.id });
    expect(instance.store.state.settings).toBe(liveSettings);
    expect(instance.store.state.v2).toBe(liveV2);
    expect(instance.store.state.settings.fleetName).toBe('Live fleet after backup');

    const { preRestoreBackupId } = restored.json() as { preRestoreBackupId: string };
    instances.splice(instances.indexOf(instance), 1);
    await instance.close();
    const restarted = await startFleetCore({ dataDir, token: 'test-master-token', listen: false, allowUnauthenticatedLoopback: true });
    instances.push(restarted);

    expect(restarted.store.state.settings.fleetName).toBe('Backed up fleet');
    expect(restarted.store.state.v2.backups.find((item) => item.id === backup.id)).toMatchObject({ status: 'succeeded' });
    expect(restarted.store.state.v2.backups.find((item) => item.id === preRestoreBackupId)).toMatchObject({ kind: 'pre-migration', status: 'succeeded' });
    expect(restarted.store.state.v2.backups.some((item) => ['queued', 'running'].includes(item.status))).toBe(false);
    expect(restarted.store.state.v2.audit.some((entry) => entry.action === 'backup.restore' && entry.resourceId === backup.id)).toBe(true);
    expect((await restarted.app.inject({ method: 'GET', url: '/api/v2/audit/verify' })).json()).toEqual({ valid: true });
  });

  it('enforces API-token read, write, and sensitive-family scopes', async () => {
    const instance = await core();
    const issue = async (name: string, scopes: string[]) => (await instance.app.inject({ method: 'POST', url: '/api/v2/api-tokens', payload: { name, scopes } })).json().token as string;
    const readToken = await issue('Reader', ['read']);
    const writeToken = await issue('Writer', ['write']);
    const secret = (await instance.app.inject({ method: 'POST', url: '/api/v2/secrets', payload: { name: 'Scoped secret', value: 'hidden' } })).json();
    const remote = { remoteAddress: '203.0.113.10' };
    expect((await instance.app.inject({ ...remote, method: 'GET', url: '/api/v2', headers: { authorization: `Bearer ${readToken}` } })).statusCode).toBe(200);
    expect((await instance.app.inject({ ...remote, method: 'POST', url: '/api/v2/groups', headers: { authorization: `Bearer ${readToken}` }, payload: { name: 'No', description: '', color: '#000000', deviceIds: [] } })).statusCode).toBe(403);
    expect((await instance.app.inject({ ...remote, method: 'POST', url: '/api/v2/groups', headers: { authorization: `Bearer ${writeToken}` }, payload: { name: 'Allowed', description: '', color: '#000000', deviceIds: [] } })).statusCode).toBe(201);
    expect(instance.store.state.v2.audit.some((entry) => entry.actorType === 'api' && entry.action === 'group.create' && entry.sourceIp === remote.remoteAddress)).toBe(true);
    expect((await instance.app.inject({ ...remote, method: 'POST', url: '/api/v2/devices/power', headers: { authorization: `Bearer ${readToken}` }, payload: { deviceIds: ['none'], action: 'wake' } })).statusCode).toBe(403);
    expect((await instance.app.inject({ ...remote, method: 'POST', url: `/api/v2/secrets/${secret.id}/read`, headers: { authorization: `Bearer ${writeToken}` } })).statusCode).toBe(403);
    expect((await instance.app.inject({ ...remote, method: 'POST', url: '/api/v2/policies', headers: { authorization: `Bearer ${writeToken}` }, payload: { name: 'Unauthorized guard', description: '', scope: 'organization', enabled: true, priority: 1, effect: 'deny', actions: ['*'], conditions: {} } })).statusCode).toBe(403);
    const policyToken = await issue('Policy administrator', ['write', 'policies:write']);
    expect((await instance.app.inject({ ...remote, method: 'POST', url: '/api/v2/policies', headers: { authorization: `Bearer ${policyToken}` }, payload: { name: 'Authorized guard', description: '', scope: 'organization', enabled: false, priority: 1, effect: 'deny', actions: ['*'], conditions: {} } })).statusCode).toBe(201);
  });

  it('enforces deny and approval policies on ordinary REST and standalone MCP requests', async () => {
    const instance = await core();
    const policy = (await instance.app.inject({
      method: 'POST', url: '/api/v2/policies',
      payload: { name: 'Guard execution', description: '', scope: 'organization', enabled: true, priority: 100, effect: 'deny', actions: ['jobs:execute'], conditions: {} },
    })).json();
    const request = { method: 'POST' as const, url: '/api/jobs', payload: { name: 'Blocked', kind: 'shell', command: 'echo blocked' } };
    const blocked = await instance.app.inject(request);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ policyId: policy.id });

    await instance.app.inject({ method: 'PATCH', url: `/api/v2/policies/${policy.id}`, payload: { effect: 'require-approval' } });
    const approval = await instance.app.inject(request);
    expect(approval.statusCode).toBe(409);
    expect(approval.json()).toMatchObject({ policyId: policy.id, approvalRequired: true });
    expect(instance.store.state.v2.audit.some((entry) => entry.actorType === 'user' && entry.action === 'jobs.execute' && entry.outcome === 'denied')).toBe(true);
  });

  it('derives policy actors from credentials and enforces workspace and group scopes', async () => {
    const instance = await core();
    const issued = await instance.app.inject({ method: 'POST', url: '/api/v2/api-tokens', payload: { name: 'API writer', scopes: ['write'] } });
    const apiToken = issued.json().token as string;
    await instance.app.inject({ method: 'POST', url: '/api/v2/policies', payload: { name: 'Block API jobs', description: '', scope: 'organization', enabled: true, priority: 100, effect: 'deny', actions: ['jobs.execute'], conditions: { actorType: 'api' } } });
    const spoofed = await instance.app.inject({
      method: 'POST', url: '/api/jobs', remoteAddress: '203.0.113.20',
      headers: { authorization: `Bearer ${apiToken}`, 'x-fleet-actor-type': 'mcp' },
      payload: { name: 'Must remain blocked', kind: 'shell', command: 'echo blocked' },
    });
    expect(spoofed.statusCode).toBe(403);

    instance.store.state.v2.policies = [];
    const project = await instance.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Workspace project' } });
    expect(project.json().workspaceId).toBe('workspace-default');
    await instance.app.inject({ method: 'POST', url: '/api/v2/policies', payload: { name: 'Workspace job guard', description: '', scope: 'workspace', scopeId: 'workspace-default', enabled: true, priority: 100, effect: 'deny', actions: ['jobs.execute'], conditions: {} } });
    expect((await instance.app.inject({ method: 'POST', url: '/api/jobs', payload: { name: 'Workspace blocked', kind: 'shell', command: 'echo blocked', projectId: project.json().id } })).statusCode).toBe(403);

    instance.store.state.v2.policies = [];
    const group = await instance.app.inject({ method: 'POST', url: '/api/v2/groups', payload: { name: 'Protected group', description: '', color: '#000000', deviceIds: [] } });
    await instance.app.inject({ method: 'POST', url: '/api/v2/policies', payload: { name: 'Group guard', description: '', scope: 'device-group', scopeId: group.json().id, enabled: true, priority: 100, effect: 'deny', actions: ['groups.update'], conditions: {} } });
    expect((await instance.app.inject({ method: 'PATCH', url: `/api/v2/groups/${group.json().id}`, payload: { name: 'Forbidden rename' } })).statusCode).toBe(403);
  });

  it('rejects cyclic agent teams and enforces their token budget before dispatch', async () => {
    const instance = await core();
    const cyclic = await instance.app.inject({ method: 'POST', url: '/api/v2/agent-teams', payload: { name: 'Cycle', objective: 'Never run', tasks: [{ id: 'a', title: 'A', description: '', role: 'planner', dependsOn: ['b'] }, { id: 'b', title: 'B', description: '', role: 'reviewer', dependsOn: ['a'] }] } });
    expect(cyclic.statusCode).toBe(400);
    expect(cyclic.json().error).toContain('cycle');

    const created = await instance.app.inject({ method: 'POST', url: '/api/v2/agent-teams', payload: { name: 'Budgeted', objective: 'This objective is intentionally longer than the tiny token budget.', budgetTokens: 1, tasks: [{ id: 'only', title: 'Only', description: 'Do work', role: 'implementer', dependsOn: [] }] } });
    const run = await instance.app.inject({ method: 'POST', url: `/api/v2/agent-teams/${created.json().id}/run` });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ state: 'cancelled', tasks: [{ state: 'cancelled', error: 'Insufficient team token budget to start this task.' }] });
    expect(instance.store.state.jobs).toHaveLength(0);
  });

  it('audits authentication failures and evaluates authentication alert rules', async () => {
    const instance = await core();
    const rule = await instance.app.inject({ method: 'POST', url: '/api/v2/alert-rules', payload: { name: 'Authentication failures', metric: 'authentication', operator: 'gt', threshold: 0, severity: 'critical', enabled: true, deviceIds: [], groupIds: [], notificationChannelIds: [], durationSeconds: 0, cooldownSeconds: 0 } });
    expect(rule.statusCode).toBe(201);
    const denied = await instance.app.inject({ method: 'GET', url: '/api/v2', remoteAddress: '203.0.113.42' });
    expect(denied.statusCode).toBe(401);
    expect(instance.store.state.v2.audit.some((entry) => entry.action === 'authentication.denied' && entry.sourceIp === '203.0.113.42')).toBe(true);
    expect(instance.store.state.v2.alerts.some((alert) => alert.ruleId === rule.json().id && alert.status === 'open')).toBe(true);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for pipeline state.');
}
