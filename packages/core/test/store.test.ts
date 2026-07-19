import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_RESTART_SESSION_RECOVERY_ERROR, FleetStore, MAX_LIVE_CODEX_EVENT_BYTES } from '../src/store.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('FleetStore', () => {
  it('persists atomically and hydrates operator settings', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-store-'));
    directories.push(directory);
    const filePath = path.join(directory, 'state.json');
    const store = await FleetStore.open({ filePath, persistDelayMs: 1 });
    store.state.settings.fleetName = 'Test fleet';
    store.state.systemConversation.messages.push({
      id: 'system-message',
      at: new Date().toISOString(),
      role: 'user',
      text: 'status of @nas',
      mentions: [],
      references: [],
    });
    store.activity({ type: 'system', severity: 'success', title: 'Ready', detail: 'Persistence works.' });
    await store.close();

    const document = JSON.parse(await readFile(filePath, 'utf8')) as { settings: { fleetName: string }; activity: unknown[] };
    expect(document.settings.fleetName).toBe('Test fleet');
    expect(document.activity).toHaveLength(1);

    const reopened = await FleetStore.open({ filePath });
    expect(reopened.state.settings.fleetName).toBe('Test fleet');
    expect(reopened.state.systemConversation.messages.at(-1)?.text).toBe('status of @nas');
    await reopened.close();
  });

  it('reconciles V2 work that cannot survive a Core restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-store-restart-')); directories.push(directory); const filePath = path.join(directory, 'state.json');
    const store = await FleetStore.open({ filePath, persistDelayMs: 1 }); const now = new Date().toISOString();
    store.state.v2.pipelineRuns.push({ id: 'run', pipelineId: 'pipeline', pipelineVersion: 1, state: 'running', triggerType: 'manual', parameters: {}, nodeRuns: [{ id: 'node-run', nodeId: 'node', state: 'running', attempt: 1, input: {}, output: {} }], createdAt: now, createdBy: 'test' });
    store.state.v2.transfers.push({ id: 'transfer', source: { path: '/source', status: 'available' }, destination: { path: '/destination', status: 'pending' }, status: 'running', totalBytes: 10, transferredBytes: 5, chunkSizeBytes: 65_536, compressed: false, encrypted: false, priority: 0, attempts: 1, maxAttempts: 3, createdAt: now });
    store.state.v2.updateRollouts.push({ id: 'rollout', releaseId: 'release', name: 'Update', deviceIds: [], groupIds: [], state: 'running', canaryPercent: 10, rollbackOnFailure: true, maintenanceWindowOnly: false, results: {}, createdAt: now });
    store.state.v2.agentTeams.push({ id: 'team', name: 'Team', objective: 'Test', state: 'running', usedTokens: 0, permissionMode: 'workspace-write', tasks: [{ id: 'task', title: 'Task', description: 'Run', role: 'test', dependsOn: [], state: 'running', outputArtifactIds: [], createdAt: now }], messages: [], createdAt: now });
    store.state.sessions.push({ id: 'session', deviceId: 'device', cwd: '/workspace', title: 'Recover me', threadId: 'thread', permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'ready', createdAt: now, updatedAt: now, events: [], pendingApprovals: [] });
    store.state.sessions.push({ id: 'completed-session', deviceId: 'device', cwd: '/workspace', title: 'Completed', threadId: 'completed-thread', turnId: 'stale-turn', permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'completed', error: 'stale turn mismatch', createdAt: now, updatedAt: now, events: [], pendingApprovals: [] });
    store.state.systemConversation.messages.push({ id: 'interrupted-system-response', at: now, role: 'assistant', text: 'Thinking…', mentions: [], references: [] });
    store.state.systemConversation.activeResponseMessageId = 'interrupted-system-response';
    store.markDirty();
    await store.close();
    const reopened = await FleetStore.open({ filePath, persistDelayMs: 1 });
    expect(reopened.state.v2.pipelineRuns[0]).toMatchObject({ state: 'failed', nodeRuns: [{ state: 'failed' }] });
    expect(reopened.state.v2.transfers[0]).toMatchObject({ status: 'pending', transferredBytes: 5 });
    expect(reopened.state.v2.updateRollouts[0]?.state).toBe('paused');
    expect(reopened.state.v2.agentTeams[0]).toMatchObject({ state: 'failed', tasks: [{ state: 'failed' }] });
    expect(reopened.state.sessions[0]).toMatchObject({ status: 'stopped', error: CORE_RESTART_SESSION_RECOVERY_ERROR });
    expect(reopened.state.sessions[1]).toMatchObject({ status: 'completed', error: undefined, turnId: undefined });
    expect(reopened.state.systemConversation.activeResponseMessageId).toBeUndefined();
    expect(reopened.state.systemConversation.messages.at(-1)?.text).toContain('restarted before Codex finished');
    await reopened.close();
  });

  it('keeps live WebSocket snapshots bounded while preserving recent conversation events', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-store-live-')); directories.push(directory);
    const store = await FleetStore.open({ filePath: path.join(directory, 'state.json') });
    const now = new Date().toISOString();
    store.state.sessions.push({
      id: 'large-session', deviceId: 'device', cwd: '/workspace', title: 'Large session', permissionMode: 'workspace-write',
      approvalPolicy: 'on-request', status: 'thinking', createdAt: now, updatedAt: now, pendingApprovals: [],
      events: Array.from({ length: 100 }, (_, index) => ({
        id: `event-${index}`, at: now, type: 'assistant' as const, text: `${index}:${'x'.repeat(65_000)}`,
      })),
    });

    const fullBytes = Buffer.byteLength(JSON.stringify(store.snapshot()));
    const live = store.liveSnapshot();
    const liveBytes = Buffer.byteLength(JSON.stringify(live));
    expect(fullBytes).toBeGreaterThan(6_000_000);
    expect(liveBytes).toBeLessThan(MAX_LIVE_CODEX_EVENT_BYTES + 250_000);
    expect(live.sessions[0]?.events.at(-1)?.id).toBe('event-99');
    expect(live.sessions[0]!.events.length).toBeLessThan(100);
    await store.close();
  });
});
