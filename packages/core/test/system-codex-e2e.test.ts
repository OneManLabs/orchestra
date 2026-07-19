import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startFleetAgent, type FleetAgent } from '../../agent/src/index.js';
import { startFleetCore, type FleetCore } from '../src/server.js';

describe('Fleet System Codex conversation', () => {
  const cores: FleetCore[] = [];
  const agents: FleetAgent[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop()));
    await Promise.all(cores.splice(0).map((core) => core.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('keeps one hidden Core-hosted thread and uses it for contextual follow-ups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-system-codex-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const fakeCodex = join(root, 'fake-codex.cjs');
    await writeFile(fakeCodex, FAKE_CODEX, 'utf8');
    await chmod(fakeCodex, 0o755);

    const port = await availablePort();
    const coreUrl = `http://127.0.0.1:${port}`;
    const core = await startFleetCore({
      host: '127.0.0.1',
      port,
      coreUrl,
      token: 'fleet-system-codex-token',
      dataDir: join(root, 'core'),
      allowUnauthenticatedLoopback: true,
    });
    cores.push(core);
    const enrollment = await core.app.inject({
      method: 'POST',
      url: '/api/v2/enrollment-tokens',
      payload: { label: 'System host', role: 'core', maxUses: 1 },
    });
    expect(enrollment.statusCode).toBe(201);

    const agent = await startFleetAgent({
      coreUrl,
      enrollmentToken: enrollment.json().token as string,
      dataDir: join(root, 'agent'),
      credentialFile: join(root, 'agent', 'credential.json'),
      deviceId: 'core-device',
      deviceName: 'Mac mini 64 GB',
      role: 'core',
      projectRoots: [workspace],
      codexCommand: fakeCodex,
      codexHome: workspace,
      heartbeatIntervalMs: 60_000,
      reconnectMinDelayMs: 100,
      reconnectMaxDelayMs: 500,
      preventSleepDuringJobs: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    agents.push(agent);
    await waitUntil(() => core.store.state.devices.some((device) => device.id === 'core-device' && device.status !== 'offline' && device.capabilities.codex));
    const device = core.store.state.devices.find((candidate) => candidate.id === 'core-device')!;
    device.metrics.gpus = [{
      vendor: 'NVIDIA',
      model: 'NVIDIA GeForce RTX 5070 Ti',
      usagePercent: 2,
      temperatureCelsius: 67,
      vramTotalBytes: 16 * 1024 ** 3,
      vramUsedBytes: 512 * 1024 ** 2,
    }];

    const first = await core.app.inject({
      method: 'POST',
      url: '/api/system/messages',
      payload: { text: 'check gpu temps on @core-device', client: { clientId: 'mbp', name: 'Nick', deviceName: 'MacBook Pro' } },
    });
    expect(first.statusCode, JSON.stringify(first.json())).toBe(201);
    await waitUntil(() => core.store.state.systemConversation.messages.at(-1)?.text === 'GPU temperature: 67°C.');
    const systemSession = core.store.state.sessions.find((session) => session.kind === 'fleet-system');
    expect(systemSession).toMatchObject({
      deviceId: 'core-device',
      status: 'completed',
      approvalPolicy: 'never',
      permissionMode: 'read-only',
    });
    expect(systemSession?.developerInstructions).toContain('natural follow-ups');
    expect(systemSession?.developerInstructions).toContain('operator-facing surface is Fleet Canvas');
    expect(systemSession?.developerInstructions).toContain('Website/View Site control');
    expect(core.store.state.systemConversation).toMatchObject({
      codexSessionId: systemSession?.id,
      status: 'completed',
      activeResponseMessageId: undefined,
    });
    expect((await core.app.inject({ method: 'GET', url: '/api/snapshot' })).json().sessions).toEqual([]);

    const second = await core.app.inject({
      method: 'POST',
      url: '/api/system/messages',
      payload: { text: 'no, only the gpu temperature', client: { clientId: 'mbp', name: 'Nick', deviceName: 'MacBook Pro' } },
    });
    expect(second.statusCode, JSON.stringify(second.json())).toBe(201);
    await waitUntil(() => core.store.state.systemConversation.messages.at(-1)?.text === 'Only the GPU temperature: 67°C.');
    expect(core.store.state.systemConversation.codexSessionId).toBe(systemSession?.id);
    expect(core.store.state.sessions.filter((session) => session.kind === 'fleet-system')).toHaveLength(1);

    const fresh = await core.app.inject({
      method: 'POST',
      url: '/api/system/new',
      payload: { client: { clientId: 'mbp', name: 'Nick', deviceName: 'MacBook Pro' } },
    });
    expect(fresh.statusCode, JSON.stringify(fresh.json())).toBe(201);
    expect(fresh.json()).toMatchObject({ title: 'Fleet System' });
    expect(fresh.json().codexSessionId).toBeUndefined();
    expect(fresh.json().id).not.toBe('fleet-system');
    expect(fresh.json().messages).toHaveLength(1);
    expect(core.store.state.systemConversationHistory).toHaveLength(1);
    expect(core.store.state.systemConversationHistory[0]?.messages.some((message) => message.text === 'Only the GPU temperature: 67°C.')).toBe(true);
    expect(core.store.state.sessions.filter((session) => session.kind === 'fleet-system')).toHaveLength(0);

    const third = await core.app.inject({
      method: 'POST',
      url: '/api/system/messages',
      payload: { text: 'check gpu temperatures again on @core-device', client: { clientId: 'mbp', name: 'Nick', deviceName: 'MacBook Pro' } },
    });
    expect(third.statusCode, JSON.stringify(third.json())).toBe(201);
    await waitUntil(() => core.store.state.systemConversation.messages.at(-1)?.text === 'GPU temperature: 67°C.');
    const freshSystemSession = core.store.state.sessions.find((session) => session.kind === 'fleet-system');
    expect(freshSystemSession?.id).not.toBe(systemSession?.id);

    const requests = (await readFile(join(workspace, 'requests.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const starts = requests.filter((request) => request.method === 'thread/start');
    const started = starts[0];
    expect(started?.params.developerInstructions).toContain('Fleet System');
    const turns = requests.filter((request) => request.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(turns).toHaveLength(3);
    expect(JSON.stringify(turns[1]?.params)).toContain('check gpu temps on @core-device');
    expect(JSON.stringify(turns[1]?.params)).toContain('67°C');
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Fleet System Codex state.');
}

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli fake\\n'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') { process.stdout.write('Logged in using test credentials\\n'); process.exit(0); }
const log = path.join(process.cwd(), 'requests.jsonl');
const rollout = path.join(process.cwd(), 'system-rollout.jsonl');
if (!fs.existsSync(rollout)) fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'system-thread' } }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) return;
  fs.appendFileSync(log, JSON.stringify({ method: message.method, params: message.params || {} }) + '\\n');
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'fake' };
  if (message.method === 'thread/start') result = { thread: { id: 'system-thread', path: rollout, forkedFromId: null } };
  if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId, path: rollout, forkedFromId: null } };
  if (message.method === 'turn/start') result = { turn: { id: 'system-turn' } };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  if (message.method === 'turn/start') {
    const prompt = message.params.input?.[0]?.text || '';
    const answer = prompt.includes('no, only the gpu temperature') ? 'Only the GPU temperature: 67°C.' : 'GPU temperature: 67°C.';
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'system-turn' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: answer } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'system-turn', status: 'completed' } } }) + '\\n');
    }, 5);
  }
});
`;
