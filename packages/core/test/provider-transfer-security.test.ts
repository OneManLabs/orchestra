import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetCore, type FleetCore } from '../src/server.js';

const TOKEN = 'provider-transfer-security-token';

describe('provider-backed transfer security', () => {
  const instances: FleetCore[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('applies backing-device deny policies to REST, pipeline, and MCP transfer starts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fleet-provider-policy-'));
    directories.push(dataDir);
    const port = await availablePort();
    const instance = await startFleetCore({ host: '127.0.0.1', port, coreUrl: `http://127.0.0.1:${port}`, token: TOKEN, dataDir, allowUnauthenticatedLoopback: true });
    instances.push(instance);

    const at = new Date().toISOString();
    instance.store.state.v2.storageConnections.push({
      id: 'nas-provider', name: 'Agent-backed NAS', kind: 'synology', deviceId: 'nas-device', rootPath: '/volume1/fleet',
      readOnly: false, status: 'connected', createdAt: at, updatedAt: at,
    });
    instance.store.state.v2.groups.push({
      id: 'protected-storage', name: 'Protected storage', description: '', color: '#334155', deviceIds: ['nas-device'], createdAt: at, updatedAt: at,
    });
    instance.store.state.v2.transfers.push({
      id: 'provider-transfer',
      source: { providerId: 'nas-provider', path: 'source.bin', status: 'available' },
      destination: { path: 'destination.bin', status: 'pending' },
      status: 'pending', totalBytes: 1, transferredBytes: 0, chunkSizeBytes: 65_536,
      compressed: false, encrypted: false, priority: 0, attempts: 0, maxAttempts: 3, createdAt: at,
    });
    instance.store.markDirty();

    const policy = await instance.app.inject({
      method: 'POST', url: '/api/v2/policies',
      payload: {
        name: 'Protect NAS transfers', description: '', scope: 'device-group', scopeId: 'protected-storage', enabled: true,
        priority: 100, effect: 'deny', actions: ['artifacts.transfer', 'artifacts:transfer'], conditions: {},
      },
    });
    expect(policy.statusCode).toBe(201);

    const deniedCreate = await instance.app.inject({
      method: 'POST', url: '/api/v2/transfers',
      payload: {
        source: { providerId: 'nas-provider', path: 'another.bin', status: 'available' },
        destination: { path: 'another-copy.bin', status: 'pending' }, totalBytes: 1,
      },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedStart = await instance.app.inject({ method: 'POST', url: '/api/v2/transfers/provider-transfer/start' });
    expect(deniedStart.statusCode).toBe(403);
    expect(instance.store.state.v2.transfers[0]!.status).toBe('pending');

    const baseNode = {
      position: { x: 0, y: 0 }, requiredLabels: [], preferredDeviceIds: [], retries: 0,
      retryDelaySeconds: 0, continueOnFailure: false, approvalRequired: false,
    };
    const pipeline = await instance.app.inject({
      method: 'POST', url: '/api/v2/pipelines',
      payload: { name: 'Protected transfer pipeline', nodes: [{ ...baseNode, id: 'copy', type: 'transfer', name: 'Copy', config: { transferId: 'provider-transfer' } }], edges: [] },
    });
    expect(pipeline.statusCode).toBe(201);
    const run = await instance.app.inject({ method: 'POST', url: `/api/v2/pipelines/${pipeline.json().id as string}/run`, payload: {} });
    expect(run.statusCode).toBe(202);
    await waitUntil(() => instance.store.state.v2.pipelineRuns.find((candidate) => candidate.id === run.json().id)?.state === 'failed');
    expect(instance.store.state.v2.pipelineRuns.find((candidate) => candidate.id === run.json().id)?.nodeRuns[0]).toMatchObject({
      state: 'failed', error: expect.stringContaining('denies artifacts.transfer'),
    });
    expect(instance.store.state.v2.transfers[0]!.status).toBe('pending');

    const client = new Client({ name: 'provider-policy-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${instance.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    try {
      await client.connect(transport);
      await client.callTool({ name: 'fleet_transfer_artifact', arguments: { transferId: 'provider-transfer' } }).catch(() => undefined);
    } finally {
      await client.close();
    }

    expect(instance.store.state.v2.audit).toContainEqual(expect.objectContaining({
      actorType: 'mcp', action: 'artifacts:transfer', resourceType: 'artifact-transfer', resourceId: 'provider-transfer', outcome: 'denied',
      detail: expect.objectContaining({ deviceId: 'nas-device', policyId: policy.json().id }),
    }));
    expect(instance.store.state.v2.transfers[0]!.status).toBe('pending');
  }, 15_000);
});

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a test port.')); return; }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for state transition.');
}
