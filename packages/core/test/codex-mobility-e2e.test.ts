import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetAgent, type FleetAgent, type FleetAgentOptions } from '../../agent/src/index.js';
import { startFleetCore, type FleetCore } from '../src/server.js';

describe('Codex session mobility through real Agents', () => {
  const cores: FleetCore[] = [];
  const agents: FleetAgent[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop()));
    await Promise.all(cores.splice(0).map((core) => core.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('recovers after Agent restart, forks across devices, moves only after destination resume, and resumes after stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-codex-mobility-')); directories.push(root);
    const sourceWorkspace = join(root, 'source-workspace'); const targetWorkspace = join(root, 'target-workspace');
    await Promise.all([mkdir(sourceWorkspace, { recursive: true }), mkdir(targetWorkspace, { recursive: true })]);
    const fakeCodex = join(root, 'fake-codex.cjs'); await writeFile(fakeCodex, FAKE_CODEX, 'utf8'); await chmod(fakeCodex, 0o755);
    const port = await availablePort(); const coreUrl = `http://127.0.0.1:${port}`;
    const core = await startFleetCore({ host: '127.0.0.1', port, coreUrl, token: 'codex-mobility-token', dataDir: join(root, 'core'), allowUnauthenticatedLoopback: true }); cores.push(core);
    const enrollment = await core.app.inject({ method: 'POST', url: '/api/v2/enrollment-tokens', payload: { label: 'Codex mobility', role: 'worker', maxUses: 2 } });
    expect(enrollment.statusCode).toBe(201);

    const agentOptions = new Map<string, FleetAgentOptions>();
    for (const [deviceId, workspace] of [['source-device', sourceWorkspace], ['target-device', targetWorkspace]] as const) {
      const options: FleetAgentOptions = {
        coreUrl, enrollmentToken: enrollment.json().token as string, dataDir: join(root, deviceId), credentialFile: join(root, deviceId, 'credential.json'),
        deviceId, deviceName: deviceId, role: 'worker', projectRoots: [workspace], codexCommand: fakeCodex, codexHome: workspace,
        heartbeatIntervalMs: 1_000, reconnectMinDelayMs: 100, reconnectMaxDelayMs: 500, preventSleepDuringJobs: false,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };
      agentOptions.set(deviceId, options);
      const agent = await startFleetAgent(options);
      agents.push(agent);
    }
    await waitUntil(() => core.store.state.devices.filter((device) => device.status === 'online' && device.capabilities.codex).length === 2);
    expect(core.store.state.devices.every((device) => device.capabilities.labels.includes('feature:codex-ui-rpc'))).toBe(true);

    const projectResponse = await core.app.inject({ method: 'POST', url: '/api/projects', payload: {
      name: 'Mobility project', description: '', defaultBranch: 'main', preferredDeviceIds: [], commands: {}, artifactPaths: [],
      paths: [{ deviceId: 'source-device', path: sourceWorkspace }, { deviceId: 'target-device', path: targetWorkspace }],
    } });
    const projectId = projectResponse.json().id as string;
    const created = await core.app.inject({ method: 'POST', url: '/api/sessions', payload: {
      deviceId: 'source-device', projectId, cwd: sourceWorkspace, title: 'Mobile Codex', model: '   ', permissionMode: 'workspace-write', approvalPolicy: 'on-request',
    } });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;
    expect(created.json()).toMatchObject({ deviceId: 'source-device', threadId: 'thread-start', status: 'ready', titleSource: 'manual' });
    expect(created.json().model).toBeUndefined();
    expect(created.json().developerInstructions).toContain('operator-facing surface is Orchestra Canvas');
    expect(created.json().developerInstructions).toContain('not through the Codex CLI UI, ChatGPT web, or the ChatGPT desktop app');
    expect(created.json().developerInstructions).toContain('Orchestra clients connect to the Orchestra Core control plane');
    expect(created.json().developerInstructions).toContain('Orchestra Agent on the selected execution device');
    expect(created.json().developerInstructions).toContain('Mobility project');

    const sourceDevice = core.store.state.devices.find((device) => device.id === 'source-device')!;
    sourceDevice.capabilities.labels = sourceDevice.capabilities.labels.filter((label) => label !== 'feature:codex-ui-rpc');
    const outdatedAgent = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'model/list', params: { limit: 100 },
    } });
    expect(outdatedAgent.statusCode).toBe(409);
    expect(outdatedAgent.json().error).toMatch(/Agent update before slash commands/);
    sourceDevice.capabilities.labels.push('feature:codex-ui-rpc');

    const renamed = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'thread/name/set', params: { threadId: 'thread-start', name: 'Renamed through RPC' },
    } });
    expect(renamed.statusCode, JSON.stringify(renamed.json())).toBe(200);
    expect(renamed.json().session).toMatchObject({ id: sessionId, title: 'Renamed through RPC', titleSource: 'manual' });
    const models = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'model/list', params: { limit: 100 },
    } });
    expect(models.statusCode, JSON.stringify(models.json())).toBe(200);
    expect(models.json().result.data).toEqual([{ id: 'model-test', model: 'model-test', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium' }]);
    const modelChanged = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'thread/settings/update', params: { threadId: 'thread-start', model: 'model-test', effort: 'medium' },
    } });
    expect(modelChanged.statusCode, JSON.stringify(modelChanged.json())).toBe(200);
    expect(modelChanged.json().session).toMatchObject({ id: sessionId, model: 'model-test' });
    expect(core.store.state.v2.advancedSessions.find((item) => item.sessionId === sessionId)).toMatchObject({ model: 'model-test', reasoningLevel: 'medium' });
    for (const params of [
      { threadId: 'thread-start', model: '' },
      { threadId: 'thread-start', model: '   ' },
      { threadId: 'thread-start', collaborationMode: { mode: 'plan', settings: { model: '' } } },
    ]) {
      const rejected = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
        method: 'thread/settings/update', params,
      } });
      expect(rejected.statusCode, JSON.stringify(rejected.json())).toBe(400);
      expect(rejected.json().error).toContain('non-empty model identifier');
    }
    const collaborationChanged = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'thread/settings/update', params: { threadId: 'thread-start', collaborationMode: { mode: 'plan', settings: { model: '  model-test  ', reasoning_effort: 'medium' } } },
    } });
    expect(collaborationChanged.statusCode, JSON.stringify(collaborationChanged.json())).toBe(200);
    expect(collaborationChanged.json().session).toMatchObject({ id: sessionId, model: 'model-test' });
    const permissionChanged = await core.app.inject({ method: 'PATCH', url: `/api/sessions/${sessionId}/permissions`, payload: {
      permissionMode: 'danger-full-access',
      client: { clientId: 'desktop-client', name: 'Demo Operator', deviceName: 'Demo Client' },
    } });
    expect(permissionChanged.statusCode, JSON.stringify(permissionChanged.json())).toBe(200);
    expect(permissionChanged.json()).toMatchObject({
      id: sessionId,
      permissionMode: 'danger-full-access',
      approvalPolicy: 'on-request',
    });

    const sourceAgent = agents.find((agent) => agent.deviceId === 'source-device')!;
    await sourceAgent.stop();
    await waitUntil(() => core.store.state.devices.find((device) => device.id === 'source-device')?.status === 'offline');
    const replacementSourceAgent = await startFleetAgent({ ...agentOptions.get('source-device')!, enrollmentToken: undefined });
    agents.push(replacementSourceAgent);
    await waitUntil(() => {
      const device = core.store.state.devices.find((item) => item.id === 'source-device');
      return Boolean(device && device.status !== 'offline' && device.capabilities.labels.includes('feature:codex-ui-rpc'));
    });
    const recoveredModels = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'model/list', params: { limit: 100 },
    } });
    expect(recoveredModels.statusCode, JSON.stringify(recoveredModels.json())).toBe(200);
    expect(recoveredModels.json().session).toMatchObject({ id: sessionId, status: 'ready', threadId: 'thread-start' });
    expect(core.store.state.v2.audit.filter((record) => record.resourceId === sessionId).map((record) => record.action)).toContain('codex.session.recover');

    const crossThread = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/rpc`, payload: {
      method: 'thread/read', params: { threadId: 'another-thread' },
    } });
    expect(crossThread.statusCode).toBe(403);

    const forked = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/fork`, payload: { deviceId: 'target-device', title: 'Review branch', lastTurnId: 'turn-2' } });
    expect(forked.statusCode, JSON.stringify(forked.json())).toBe(201);
    expect(forked.json()).toMatchObject({ deviceId: 'target-device', cwd: targetWorkspace, threadId: 'thread-fork', status: 'ready', titleSource: 'manual' });
    const forkMetadata = core.store.state.v2.advancedSessions.find((item) => item.sessionId === forked.json().id);
    expect(forkMetadata).toMatchObject({ parentSessionId: sessionId });
    expect(forkMetadata?.lineage?.at(-1)).toMatchObject({ operation: 'forked', fromSessionId: sessionId, fromDeviceId: 'source-device', toDeviceId: 'target-device' });

    const eventCount = core.store.state.sessions.find((session) => session.id === sessionId)!.events.length;
    const failResume = join(targetWorkspace, 'fail-resume'); await writeFile(failResume, '1', 'utf8');
    const failedMove = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/move`, payload: { deviceId: 'target-device' } });
    expect(failedMove.statusCode).toBe(502);
    expect(core.store.state.sessions.find((session) => session.id === sessionId)).toMatchObject({ deviceId: 'source-device', status: 'ready' });
    expect(core.store.state.devices.find((device) => device.id === 'source-device')?.activeSessionIds).toContain(sessionId);
    await rm(failResume, { force: true });

    const moved = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/move`, payload: { deviceId: 'target-device' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: sessionId, deviceId: 'target-device', cwd: targetWorkspace, threadId: 'thread-start', status: 'ready' });
    expect(moved.json().events.length).toBeGreaterThan(eventCount);
    expect(core.store.state.devices.find((device) => device.id === 'source-device')?.activeSessionIds).not.toContain(sessionId);
    expect(core.store.state.devices.find((device) => device.id === 'target-device')?.activeSessionIds).toContain(sessionId);
    const moveMetadata = core.store.state.v2.advancedSessions.find((item) => item.sessionId === sessionId);
    expect(moveMetadata?.lineage?.at(-1)).toMatchObject({ operation: 'moved', fromDeviceId: 'source-device', toDeviceId: 'target-device' });

    const stopped = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/stop` });
    expect(stopped.json().status).toBe('stopped');
    const resumed = await core.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/resume`, payload: { model: '  model-test  ' } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ deviceId: 'target-device', threadId: 'thread-start', status: 'ready', model: 'model-test' });
    expect(core.store.state.v2.advancedSessions.find((item) => item.sessionId === sessionId)?.lineage?.at(-1)).toMatchObject({ operation: 'resumed' });

    expect(core.store.state.v2.audit.filter((record) => record.resourceId === sessionId).map((record) => record.action)).toEqual(expect.arrayContaining(['codex.rpc.thread/name/set', 'codex.session.permissions.update', 'codex.session.move', 'codex.session.resume']));
  }, 60_000);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error('Timed out waiting for Codex mobility integration state.');
}

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli fake\\n'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') { process.stdout.write('Logged in using test credentials\\n'); process.exit(0); }
const rollout = path.join(process.cwd(), 'codex-rollout.jsonl');
if (!fs.existsSync(rollout)) fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-start' } }) + '\\n' + JSON.stringify({ type: 'response_item', payload: { text: 'Preserved history' } }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'fake' };
  if (message.method === 'thread/start') result = { thread: { id: 'thread-start', path: rollout, forkedFromId: null } };
  if (message.method === 'thread/resume' && fs.existsSync(path.join(process.cwd(), 'fail-resume'))) { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'destination resume failed' } }) + '\\n'); return; }
  if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId, path: message.params.path || rollout, forkedFromId: null } };
  if (message.method === 'thread/fork') { const forkRollout = path.join(process.cwd(), 'codex-fork.jsonl'); fs.writeFileSync(forkRollout, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-fork' } }) + '\\n'); result = { thread: { id: 'thread-fork', path: forkRollout, forkedFromId: message.params.threadId } }; }
  if (message.method === 'thread/read') result = { thread: { id: message.params.threadId, path: rollout } };
  if (message.method === 'model/list') result = { data: [{ id: 'model-test', model: 'model-test', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium' }] };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`;
