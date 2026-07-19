import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetAgent, type FleetAgent } from '../../agent/src/index.js';
import { startFleetCore, type FleetCore } from '../src/server.js';

describe('Fleet Core and real Agent integration', () => {
  const cores: FleetCore[] = [];
  const agents: FleetAgent[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop()));
    await Promise.all(cores.splice(0).map((core) => core.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('enrolls, runs a host job, transfers a verified file, and executes diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-agent-e2e-'));
    const coreData = join(root, 'core');
    const agentData = join(root, 'agent');
    const workspace = join(root, 'workspace');
    directories.push(root);
    await mkdir(workspace, { recursive: true });

    const port = await availablePort();
    const coreUrl = `http://127.0.0.1:${port}`;
    const core = await startFleetCore({ host: '127.0.0.1', port, coreUrl, token: 'e2e-recovery-token', dataDir: coreData, allowUnauthenticatedLoopback: true });
    cores.push(core);

    const issued = await core.app.inject({
      method: 'POST',
      url: '/api/v2/enrollment-tokens',
      payload: { label: 'E2E Agent', role: 'worker', maxUses: 1 },
    });
    expect(issued.statusCode).toBe(201);

    const agent = await startFleetAgent({
      coreUrl,
      enrollmentToken: issued.json().token as string,
      dataDir: agentData,
      credentialFile: join(agentData, 'credential.json'),
      deviceId: 'e2e-agent',
      deviceName: 'E2E Agent',
      role: 'worker',
      projectRoots: [workspace],
      heartbeatIntervalMs: 1_000,
      reconnectMinDelayMs: 100,
      reconnectMaxDelayMs: 500,
      allowPowerActions: false,
      preventSleepDuringJobs: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    agents.push(agent);
    await waitUntil(() => core.store.state.devices.some((device) => device.id === 'e2e-agent' && device.status === 'online'));

    await writeFile(join(workspace, 'existing.txt'), 'workspace-picker');
    const resolvedWorkspace = await realpath(workspace);
    const workspaceListing = await core.app.inject({
      method: 'GET',
      url: `/api/devices/e2e-agent/workspace?path=${encodeURIComponent(workspace)}`,
    });
    expect(workspaceListing.statusCode).toBe(200);
    expect(workspaceListing.json()).toMatchObject({
      path: resolvedWorkspace,
      entries: expect.arrayContaining([expect.objectContaining({ name: 'existing.txt', type: 'file' })]),
    });

    const workspaceFolder = join(workspace, 'new-codex-folder');
    const createdWorkspaceFolder = await core.app.inject({
      method: 'POST',
      url: '/api/devices/e2e-agent/workspace/directories',
      payload: { path: workspaceFolder },
    });
    expect(createdWorkspaceFolder.statusCode).toBe(201);
    expect(createdWorkspaceFolder.json()).toMatchObject({ path: join(resolvedWorkspace, 'new-codex-folder'), created: true });
    expect((await stat(workspaceFolder)).isDirectory()).toBe(true);

    const escapedWorkspaceFolder = join(root, 'outside-workspace');
    const deniedWorkspaceFolder = await core.app.inject({
      method: 'POST',
      url: '/api/devices/e2e-agent/workspace/directories',
      payload: { path: escapedWorkspaceFolder },
    });
    expect(deniedWorkspaceFolder.statusCode).toBe(403);
    expect(deniedWorkspaceFolder.json().error).toContain('outside configured project roots');
    await expect(stat(escapedWorkspaceFolder)).rejects.toMatchObject({ code: 'ENOENT' });

    const command = `node -e "require('fs').writeFileSync('job-result.txt','fleet-e2e')"`;
    const created = await core.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { name: 'Real Agent Job', kind: 'shell', command, deviceId: 'e2e-agent', cwd: workspace },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    await waitUntil(() => core.store.state.jobs.find((job) => job.id === jobId)?.status === 'completed');
    expect(await readFile(join(workspace, 'job-result.txt'), 'utf8')).toBe('fleet-e2e');

    const sourcePath = join(workspace, 'job-result.txt');
    const transferResponse = await core.app.inject({
      method: 'POST',
      url: '/api/v2/transfers',
      payload: {
        source: { deviceId: 'e2e-agent', path: sourcePath, status: 'available' },
        destination: { path: 'verified/job-result.txt', status: 'pending' },
        totalBytes: 9,
      },
    });
    expect(transferResponse.statusCode).toBe(201);
    const transferId = transferResponse.json().id as string;
    const started = await core.app.inject({ method: 'POST', url: `/api/v2/transfers/${transferId}/start` });
    expect(started.statusCode).toBe(202);
    await waitUntil(() => core.store.state.v2.transfers.find((transfer) => transfer.id === transferId)?.status === 'succeeded');
    const transfer = core.store.state.v2.transfers.find((candidate) => candidate.id === transferId)!;
    expect(transfer.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(coreData, 'transfers', transfer.destination.path), 'utf8')).toBe('fleet-e2e');

    const nasRoot = join(workspace, 'nas-root');
    await mkdir(nasRoot);
    await writeFile(join(nasRoot, 'source.txt'), 'agent-backed-storage');
    const storageResponse = await core.app.inject({
      method: 'POST',
      url: '/api/v2/storage-connections',
      payload: { name: 'E2E Agent NAS', kind: 'synology', deviceId: 'e2e-agent', rootPath: nasRoot, readOnly: false },
    });
    expect(storageResponse.statusCode).toBe(201);
    const storageId = storageResponse.json().id as string;

    const testedStorage = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${storageId}/test` });
    expect(testedStorage.statusCode).toBe(200);
    expect(testedStorage.json()).toMatchObject({ id: storageId, deviceId: 'e2e-agent', status: 'connected' });

    const initialListing = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${storageId}/files`, payload: { path: '' } });
    expect(initialListing.statusCode).toBe(200);
    expect(initialListing.json().entries).toContainEqual(expect.objectContaining({ name: 'source.txt', path: 'source.txt', type: 'file' }));

    const createdDirectory = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${storageId}/directories`, payload: { path: 'models/checkpoints' } });
    expect(createdDirectory.statusCode).toBe(201);
    expect((await stat(join(nasRoot, 'models', 'checkpoints'))).isDirectory()).toBe(true);

    const traversal = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${storageId}/directories`, payload: { path: '../outside' } });
    expect(traversal.statusCode).toBe(403);
    await expect(stat(join(workspace, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });

    const readOnlyResponse = await core.app.inject({
      method: 'POST',
      url: '/api/v2/storage-connections',
      payload: { name: 'Read-only Agent NAS', kind: 'synology', deviceId: 'e2e-agent', rootPath: nasRoot, readOnly: true },
    });
    const deniedDirectory = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${readOnlyResponse.json().id as string}/directories`, payload: { path: 'forbidden' } });
    expect(deniedDirectory.statusCode).toBe(403);
    await expect(stat(join(nasRoot, 'forbidden'))).rejects.toMatchObject({ code: 'ENOENT' });

    const readOnlyTransferResponse = await core.app.inject({
      method: 'POST',
      url: '/api/v2/transfers',
      payload: {
        source: { providerId: storageId, path: 'source.txt', status: 'available' },
        destination: { providerId: readOnlyResponse.json().id as string, path: 'forbidden.txt', status: 'pending' },
        totalBytes: 0,
      },
    });
    const deniedTransferStart = await core.app.inject({ method: 'POST', url: `/api/v2/transfers/${readOnlyTransferResponse.json().id as string}/start` });
    expect(deniedTransferStart.statusCode).toBe(403);
    expect(deniedTransferStart.json().error).toContain('read-only');

    const copiedDirectory = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${storageId}/directories`, payload: { path: 'copies' } });
    expect(copiedDirectory.statusCode).toBe(201);
    const providerTransferResponse = await core.app.inject({
      method: 'POST',
      url: '/api/v2/transfers',
      payload: {
        source: { providerId: storageId, path: 'source.txt', status: 'available' },
        destination: { providerId: storageId, path: 'copies/source.txt', status: 'pending' },
        totalBytes: 0,
      },
    });
    expect(providerTransferResponse.statusCode).toBe(201);
    const providerTransferId = providerTransferResponse.json().id as string;
    const providerTransferStarted = await core.app.inject({ method: 'POST', url: `/api/v2/transfers/${providerTransferId}/start` });
    expect(providerTransferStarted.statusCode).toBe(202);
    await waitUntil(() => core.store.state.v2.transfers.find((candidate) => candidate.id === providerTransferId)?.status === 'succeeded');
    expect(await readFile(join(nasRoot, 'copies', 'source.txt'), 'utf8')).toBe('agent-backed-storage');

    const diagnostics = await core.app.inject({
      method: 'POST',
      url: '/api/v2/diagnostics',
      payload: { deviceId: 'e2e-agent', kind: 'agent', redact: true },
    });
    expect(diagnostics.statusCode).toBe(201);
    expect(diagnostics.json()).toMatchObject({ deviceId: 'e2e-agent', state: 'succeeded', redacted: true });
    expect(diagnostics.json().checks.length).toBeGreaterThan(2);

    const deniedPower = await core.app.inject({
      method: 'POST',
      url: '/api/v2/devices/e2e-agent/power',
      payload: { action: 'lock' },
    });
    expect(deniedPower.statusCode).toBe(502);
    expect(deniedPower.json().error).toContain('disabled');

    await agent.stop();
    await waitUntil(() => core.store.state.devices.find((device) => device.id === 'e2e-agent')?.status === 'offline');
    const offlineStorage = await core.app.inject({ method: 'POST', url: `/api/v2/storage-connections/${storageId}/test` });
    expect(offlineStorage.statusCode).toBe(409);
    expect(offlineStorage.json().error).toContain('offline');
  }, 30_000);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for Fleet integration state.');
}
