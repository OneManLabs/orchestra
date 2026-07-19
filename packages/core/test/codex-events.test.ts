import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexSession } from '@fleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCodexMessage } from '../src/codex-events.js';
import { FleetStore } from '../src/store.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture(): Promise<{ store: FleetStore; session: CodexSession }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-codex-'));
  directories.push(directory);
  const store = await FleetStore.open({ filePath: path.join(directory, 'state.json') });
  const now = new Date().toISOString();
  const session: CodexSession = {
    id: 'session', deviceId: 'device', cwd: directory, title: 'Test', permissionMode: 'workspace-write', approvalPolicy: 'on-request',
    status: 'ready', createdAt: now, updatedAt: now, events: [], pendingApprovals: [],
  };
  return { store, session };
}

describe('Codex event normalization', () => {
  it('merges assistant deltas and tracks thread context', async () => {
    const { store, session } = await fixture();
    applyCodexMessage(store, session, { method: 'fleet/thread-context', params: { threadId: 'thread-1' } });
    const firstDelta = applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: 'Fleet ' } });
    const secondDelta = applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: 'ready' } });
    expect(session.threadId).toBe('thread-1');
    expect(session.events).toHaveLength(1);
    expect(session.events[0]?.text).toBe('Fleet ready');
    expect(firstDelta.streamingDelta).toBe(true);
    expect(secondDelta.streamingDelta).toBe(true);
    await store.close();
  });

  it('keeps one assistant event when the same turn resumes after a recovery boundary', async () => {
    const { store, session } = await fixture();
    applyCodexMessage(store, session, { method: 'turn/started', params: { turn: { id: 'turn-recovered' } } });
    applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: 'First half. ' } });
    store.appendCodexEvent(session, {
      type: 'status',
      text: 'Transport recovered.',
      method: 'fleet/session-recovered',
      data: { turnId: 'turn-recovered' },
    });
    applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: 'Second half.' } });

    const assistant = session.events.filter((event) => event.type === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe('First half. Second half.');
    expect(assistant[0]?.data).toMatchObject({ turnId: 'turn-recovered' });
    await store.close();
  });

  it('keeps the active turn boundary on assistant and web-search events', async () => {
    const { store, session } = await fixture();
    applyCodexMessage(store, session, { method: 'turn/started', params: { turn: { id: 'turn-web' } } });
    applyCodexMessage(store, session, { method: 'item/completed', params: { item: { id: 'search', type: 'webSearch', query: 'Fleet docs' } } });
    applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: 'Found it' } });

    expect(session.events.find((event) => event.type === 'tool')?.data).toMatchObject({ turnId: 'turn-web' });
    expect(session.events.find((event) => event.type === 'assistant')?.data).toMatchObject({ turnId: 'turn-web' });
    await store.close();
  });

  it('only classifies assistant and reasoning deltas as coalescible', async () => {
    const { store, session } = await fixture();
    const reasoning = applyCodexMessage(store, session, { method: 'item/reasoning/textDelta', params: { delta: 'Checking' } });
    const summary = applyCodexMessage(store, session, { method: 'item/reasoning/summary', params: { text: 'Checked' } });
    const approval = applyCodexMessage(store, session, { id: 4, method: 'item/fileChange/requestApproval', params: { path: 'app.ts' } });
    const completed = applyCodexMessage(store, session, { method: 'turn/completed', params: { turn: { status: 'completed' } } });
    expect(reasoning.streamingDelta).toBe(true);
    expect(summary.streamingDelta).toBe(false);
    expect(approval.streamingDelta).toBeUndefined();
    expect(completed.streamingDelta).toBeUndefined();
    await store.close();
  });

  it('bounds replacement metadata instead of growing persisted sessions with command output', async () => {
    const { store, session } = await fixture();
    applyCodexMessage(store, session, { method: 'item/started', params: { item: { id: 'command', type: 'commandExecution', command: 'npm test' } } });
    applyCodexMessage(store, session, {
      method: 'item/completed',
      params: { item: { id: 'command', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'x'.repeat(200_000) } },
    });
    const command = session.events.find((event) => event.type === 'command');
    expect(JSON.stringify(command?.data).length).toBeLessThan(17_000);

    applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: 'Done', metadata: 'y'.repeat(200_000) } });
    applyCodexMessage(store, session, { method: 'item/agentMessage/delta', params: { delta: '.', metadata: 'z'.repeat(200_000) } });
    const assistant = session.events.find((event) => event.type === 'assistant');
    expect(assistant?.text).toBe('Done.');
    expect(JSON.stringify(assistant?.data).length).toBeLessThan(17_000);
    await store.close();
  });

  it('turns app-server requests into pending approvals', async () => {
    const { store, session } = await fixture();
    applyCodexMessage(store, session, { id: 9, method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run tests' } });
    expect(session.status).toBe('awaiting-approval');
    expect(session.pendingApprovals[0]).toMatchObject({ requestId: 9, detail: 'Run tests' });
    await store.close();
  });

  it('normalizes current item lifecycle events and failed turn statuses', async () => {
    const { store, session } = await fixture();
    applyCodexMessage(store, session, { method: 'item/started', params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', status: 'inProgress' } } });
    applyCodexMessage(store, session, { method: 'item/completed', params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', status: 'failed', exitCode: 1 } } });
    applyCodexMessage(store, session, { method: 'item/completed', params: { item: { id: 'file-1', type: 'fileChange', changes: [{ path: 'src/app.ts', kind: 'update', diff: '@@' }], status: 'completed' } } });
    applyCodexMessage(store, session, { method: 'item/completed', params: { item: { id: 'mcp-1', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed' } } });
    applyCodexMessage(store, session, { method: 'item/completed', params: { item: { id: 'plan-1', type: 'plan', text: 'Implement parity' } } });
    expect(session.events.filter((event) => event.type === 'command')).toHaveLength(1);
    expect(session.events.find((event) => event.type === 'file')?.text).toBe('src/app.ts');
    expect(session.events.find((event) => event.type === 'tool')?.text).toContain('docs · search');
    expect(session.events.find((event) => event.type === 'plan')?.text).toBe('Implement parity');
    const result = applyCodexMessage(store, session, { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed', error: { message: 'Tests failed' } } } });
    expect(result.significant).toBe('error');
    expect(session.status).toBe('error');
    expect(session.error).toBe('Tests failed');
    await store.close();
  });

  it('does not let a sub-agent turn overwrite the main session turn', async () => {
    const { store, session } = await fixture();
    session.threadId = 'thread-main';
    session.turnId = 'turn-main';
    session.status = 'thinking';

    const childStarted = applyCodexMessage(store, session, {
      method: 'turn/started',
      params: { threadId: 'thread-child', turn: { id: 'turn-child' } },
    });
    const childCompleted = applyCodexMessage(store, session, {
      method: 'turn/completed',
      params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed' } },
    });

    expect(childStarted).toEqual({});
    expect(childCompleted).toEqual({});
    expect(session).toMatchObject({ status: 'thinking', threadId: 'thread-main', turnId: 'turn-main' });
    expect(session.events).toHaveLength(0);

    const mainCompleted = applyCodexMessage(store, session, {
      method: 'turn/completed',
      params: { threadId: 'thread-main', turn: { id: 'turn-main', status: 'completed' } },
    });
    expect(mainCompleted.significant).toBe('turn-completed');
    expect(session.status).toBe('completed');
    expect(session.turnId).toBeUndefined();
    await store.close();
  });
});
