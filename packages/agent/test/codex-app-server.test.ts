import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentToCoreMessage, CodexSession } from '@fleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionManager, repairInterruptedCustomToolCalls } from '../src/codex-app-server.js';

const directories: string[] = [];
const managers: CodexSessionManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex app-server session mobility', () => {
  it('treats stopping an already-absent session as an idempotent success', async () => {
    const fixture = await createFixture('idempotent-stop');
    const manager = createManager(fixture.command, fixture.dataDir);

    await expect(manager.stop('missing-session')).resolves.toBeUndefined();
  });

  it('omits blank models and trims valid model overrides before launch', async () => {
    const fixture = await createFixture('models');
    const manager = createManager(fixture.command, fixture.dataDir);
    const blank = codexSession('blank-model', fixture.workspace);
    blank.model = '   ';
    const selected = codexSession('selected-model', fixture.workspace);
    selected.model = '  gpt-model  ';

    await manager.start(blank, fixture.workspace);
    await manager.start(selected, fixture.workspace);

    const starts = (await requestLog(fixture.workspace)).filter((entry) => entry.method === 'thread/start');
    expect(starts).toHaveLength(2);
    expect(starts[0]!.params).not.toHaveProperty('model');
    expect(starts[1]!.params).toMatchObject({ model: 'gpt-model' });
  });

  it('uses the native thread/resume and thread/fork methods with current parameters', async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture.command, fixture.dataDir);
    const session = codexSession('fleet-session', fixture.workspace);
    session.developerInstructions = 'Act as the Fleet System orchestrator.';

    const started = await manager.start(session, fixture.workspace);
    expect(started).toMatchObject({ threadId: 'thread-start' });
    await expect(manager.resume(session, fixture.workspace, 'thread-start')).resolves.toMatchObject({ threadId: 'thread-start' });
    await manager.stop(session.id);

    const resumed = await manager.resume(session, fixture.workspace, 'thread-start');
    expect(resumed.threadId).toBe('thread-start');
    const forked = await manager.fork(codexSession('fleet-fork', fixture.workspace), fixture.workspace, 'thread-start', 'turn-7');
    expect(forked).toMatchObject({ threadId: 'thread-fork', forkedFromThreadId: 'thread-start' });

    const requests = await requestLog(fixture.workspace);
    expect(requests.find((entry) => entry.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'Act as the Fleet System orchestrator.',
    });
    expect(requests.find((entry) => entry.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-start', cwd: fixture.workspace, approvalPolicy: 'on-request', sandbox: 'workspace-write',
      developerInstructions: 'Act as the Fleet System orchestrator.',
    });
    expect(requests.find((entry) => entry.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'thread-start', lastTurnId: 'turn-7', cwd: fixture.workspace,
    });
    expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
  });

  it('recreates a stopped thread that Codex never persisted before its first turn', async () => {
    const fixture = await createFixture('empty-resume');
    const manager = createManager(fixture.command, fixture.dataDir);
    const session = codexSession('empty-session', fixture.workspace);
    session.events.push({
      id: 'startup-stderr', at: new Date().toISOString(), type: 'error', method: 'fleet/stderr',
      text: 'A non-fatal model-cache warning emitted before the first turn.',
    });

    await expect(manager.resume(session, fixture.workspace, 'missing-rollout')).resolves.toMatchObject({ threadId: 'thread-start' });

    const requests = await requestLog(fixture.workspace);
    expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
    expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
  });

  it('does not replace a missing rollout when the Fleet session contains turn history', async () => {
    const fixture = await createFixture('history-resume');
    const manager = createManager(fixture.command, fixture.dataDir);
    const session = codexSession('history-session', fixture.workspace);
    session.events.push({
      id: 'user-message', at: new Date().toISOString(), type: 'user', text: 'Keep this conversation.',
    });

    await expect(manager.resume(session, fixture.workspace, 'missing-rollout')).rejects.toThrow('no rollout found for thread id');

    const requests = await requestLog(fixture.workspace);
    expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
    expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(0);
  });

  it('forwards Fleet UI commands through the active app-server session', async () => {
    const fixture = await createFixture('rpc');
    const manager = createManager(fixture.command, fixture.dataDir);
    const session = codexSession('rpc-session', fixture.workspace);
    await manager.start(session, fixture.workspace);

    const result = await manager.rpc(session.id, 'model/list', { limit: 25 });

    expect(result).toEqual({ data: [{ id: 'model-test', model: 'model-test', displayName: 'Test model' }] });
    expect((await requestLog(fixture.workspace)).find((entry) => entry.method === 'model/list')?.params).toEqual({ limit: 25 });
  });

  it('gracefully interrupts an active turn and atomically closes only its orphaned custom tool call', async () => {
    const fixture = await createFixture('interrupted-tool');
    const events: AgentToCoreMessage[] = [];
    const manager = createManager(fixture.command, fixture.dataDir, (message) => events.push(message));
    const session = codexSession('interrupted-session', fixture.workspace);
    await manager.start(session, fixture.workspace);
    await manager.sendTurn(session.id, 'Run the build.');

    await manager.stop(session.id);

    const requests = await requestLog(fixture.workspace);
    expect(requests.some((entry) => entry.method === 'turn/interrupt')).toBe(true);
    const rolloutPath = path.join(fixture.workspace, 'source-rollout.jsonl');
    const text = await readFile(rolloutPath, 'utf8');
    const records = text.trim().split('\n').map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const outputs = records.filter((record) => record.type === 'response_item' && record.payload.type === 'custom_tool_call_output');
    expect(outputs.filter((record) => record.payload.call_id === 'call-interrupted')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ output: 'aborted' }) }),
    ]);
    expect(outputs.find((record) => record.payload.call_id === 'call-complete')?.payload.output).toBe('real-result');
    const callIndex = records.findIndex((record) => record.payload.call_id === 'call-interrupted' && record.payload.type === 'custom_tool_call');
    expect(records[callIndex + 1]?.payload).toMatchObject({ type: 'custom_tool_call_output', call_id: 'call-interrupted', output: 'aborted' });
    const backups = (await readdir(fixture.workspace)).filter((name) => name.includes('.fleet-backup-') && name.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(fixture.workspace, backups[0]!), 'utf8')).not.toContain('"call_id":"call-interrupted","output":"aborted"');
    expect(events.some((event) => event.type === 'codex.event'
      && (event.payload.message as { method?: string }).method === 'fleet/rolloutRepaired')).toBe(true);
  });

  it('refuses to repair a rollout outside its allowed root or with mismatched session metadata', async () => {
    const fixture = await createFixture('repair-security');
    const rolloutPath = path.join(fixture.workspace, 'manual.jsonl');
    await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'another-thread' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-orphan' } })}\n`, 'utf8');

    await expect(repairInterruptedCustomToolCalls(rolloutPath, 'expected-thread', [fixture.workspace]))
      .rejects.toThrow('does not match the active thread');
    await expect(repairInterruptedCustomToolCalls(rolloutPath, 'another-thread', [fixture.dataDir]))
      .rejects.toThrow('outside the configured Codex data directory');
    expect((await readdir(fixture.workspace)).some((name) => name.includes('.fleet-backup-'))).toBe(false);
  });

  it('moves a checksummed rollout in bounded chunks and forks it on the destination', async () => {
    const source = await createFixture('source');
    const destination = await createFixture('destination', source.command);
    const sourceManager = createManager(source.command, source.dataDir);
    const destinationManager = createManager(destination.command, destination.dataDir);
    const sourceSession = codexSession('source-session', source.workspace);
    await sourceManager.start(sourceSession, source.workspace);

    const prepared = await sourceManager.prepareHandoff(sourceSession.id);
    expect(prepared).toMatchObject({ threadId: 'thread-start' });
    expect(prepared.sizeBytes).toBeGreaterThan(0);
    expect(prepared.checksumSha256).toMatch(/^[a-f0-9]{64}$/);

    await destinationManager.beginHandoff(prepared.handoffId, prepared.sizeBytes, prepared.checksumSha256);
    let offset = 0;
    while (offset < prepared.sizeBytes) {
      const chunk = await sourceManager.readHandoff(prepared.handoffId, offset, Math.min(17, prepared.sizeBytes - offset));
      const progress = await destinationManager.writeHandoff(prepared.handoffId, offset, chunk.dataBase64);
      offset += chunk.bytesRead;
      expect(progress.receivedBytes).toBe(offset);
    }
    const moved = await destinationManager.finishHandoff({
      handoffId: prepared.handoffId,
      session: codexSession('destination-session', destination.workspace),
      cwd: destination.workspace,
      sourceThreadId: prepared.threadId,
      mode: 'fork',
      lastTurnId: 'turn-2',
    });
    expect(moved).toMatchObject({ threadId: 'thread-fork', forkedFromThreadId: 'thread-start' });
    const request = (await requestLog(destination.workspace)).find((entry) => entry.method === 'thread/fork');
    expect(request?.params).toMatchObject({ threadId: 'thread-start', lastTurnId: 'turn-2', cwd: destination.workspace });
    expect(typeof request?.params.path).toBe('string');
    await sourceManager.discardHandoff(prepared.handoffId);
  });

  it('rejects a corrupted destination handoff before Codex is launched', async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture.command, fixture.dataDir);
    await manager.beginHandoff('corrupt', 4, '0'.repeat(64));
    await manager.writeHandoff('corrupt', 0, Buffer.from('oops').toString('base64'));
    await expect(manager.finishHandoff({
      handoffId: 'corrupt', session: codexSession('never-started', fixture.workspace), cwd: fixture.workspace,
      sourceThreadId: 'source', mode: 'resume',
    })).rejects.toThrow('checksum verification failed');
  });

  it('refuses an app-server rollout path that is a symlink to another host file', async () => {
    const fixture = await createFixture('symlink');
    const secret = path.join(fixture.workspace, 'credentials.jsonl');
    await writeFile(secret, JSON.stringify({ access_token: 'must-not-leave-device' }), 'utf8');
    await symlink(secret, path.join(fixture.workspace, 'source-rollout.jsonl'));
    const manager = createManager(fixture.command, fixture.dataDir);
    const session = codexSession('symlink-session', fixture.workspace);
    await manager.start(session, fixture.workspace);
    await expect(manager.prepareHandoff(session.id)).rejects.toThrow('non-symlink regular file');
  });

  it('refuses a JSONL file whose Codex session metadata does not match the active thread', async () => {
    const fixture = await createFixture('mismatch');
    await writeFile(path.join(fixture.workspace, 'source-rollout.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'different-thread' } })}\n`, 'utf8');
    const manager = createManager(fixture.command, fixture.dataDir);
    const session = codexSession('mismatch-session', fixture.workspace);
    await manager.start(session, fixture.workspace);
    await expect(manager.prepareHandoff(session.id)).rejects.toThrow('does not match the active thread');
  });
});

function createManager(command: string, dataDir: string, send: (message: AgentToCoreMessage) => void = () => undefined): CodexSessionManager {
  // The fixture keeps its fake Codex rollout beside the fake workspace. Real
  // Agents default this root to CODEX_HOME (normally ~/.codex).
  const manager = new CodexSessionManager(command, send, dataDir, path.dirname(dataDir));
  managers.push(manager);
  return manager;
}

async function createFixture(name = 'fixture', sharedCommand?: string): Promise<{ command: string; workspace: string; dataDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `fleet-codex-${name}-`)); directories.push(root);
  const workspace = path.join(root, 'workspace'); const dataDir = path.join(root, 'data');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(dataDir, { recursive: true })]);
  const command = sharedCommand ?? path.join(root, 'fake-codex.cjs');
  if (!sharedCommand) {
    await writeFile(command, FAKE_CODEX, 'utf8');
    await chmod(command, 0o755);
  }
  return { command, workspace, dataDir };
}

function codexSession(id: string, cwd: string): CodexSession {
  const now = new Date().toISOString();
  return {
    id, deviceId: 'device', cwd, title: id, permissionMode: 'workspace-write', approvalPolicy: 'on-request',
    status: 'starting', createdAt: now, updatedAt: now, events: [], pendingApprovals: [],
  };
}

async function requestLog(workspace: string): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const text = await readFile(path.join(workspace, 'requests.jsonl'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli fake\\n'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') { process.stdout.write('Logged in using test credentials\\n'); process.exit(0); }
const log = path.join(process.cwd(), 'requests.jsonl');
const sourceRollout = path.join(process.cwd(), 'source-rollout.jsonl');
if (!fs.existsSync(sourceRollout)) fs.writeFileSync(sourceRollout,
  JSON.stringify({ type: 'session_meta', payload: { id: 'thread-start' } }) + '\\n'
  + JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-complete', name: 'exec', input: '{}' } }) + '\\n'
  + JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-complete', output: 'real-result' } }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) return;
  fs.appendFileSync(log, JSON.stringify({ method: message.method, params: message.params || {} }) + '\\n');
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'fake' };
  if (message.method === 'thread/start') result = { thread: { id: 'thread-start', path: sourceRollout, forkedFromId: null } };
  if (message.method === 'thread/resume' && message.params.threadId === 'missing-rollout') {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'no rollout found for thread id missing-rollout' } }) + '\\n');
    return;
  }
  if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId, path: message.params.path || sourceRollout, forkedFromId: null } };
  if (message.method === 'thread/fork') result = { thread: { id: 'thread-fork', path: path.join(process.cwd(), 'fork-rollout.jsonl'), forkedFromId: message.params.threadId } };
  if (message.method === 'thread/read') result = { thread: { id: message.params.threadId, path: sourceRollout } };
  if (message.method === 'turn/start') {
    fs.appendFileSync(sourceRollout, JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-interrupted', name: 'exec', input: '{}' } }) + '\\n');
    result = { turn: { id: 'turn-fake' } };
  }
  if (message.method === 'turn/interrupt') {
    result = {};
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted' } } }) + '\\n');
  }
  if (message.method === 'model/list') result = { data: [{ id: 'model-test', model: 'model-test', displayName: 'Test model' }] };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`;
