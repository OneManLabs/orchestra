import type { CodexSession, CodexSessionEventUpdate, FleetSnapshot } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { applyCodexSessionEventUpdate, mergeCodexSession, mergeLiveSnapshot } from '../src/renderer/lib/codex-live-update.js';

function session(events: CodexSession['events']): CodexSession {
  return {
    id: 'session', deviceId: 'device', cwd: '/fleet', title: 'Fleet', permissionMode: 'workspace-write',
    approvalPolicy: 'on-request', status: 'thinking', createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z', events, pendingApprovals: [], turnId: 'turn',
  };
}

describe('compact Codex live updates', () => {
  it('updates a streaming event without replacing prior history', () => {
    const current = session([
      { id: 'old', at: '2026-07-16T00:00:00.000Z', type: 'user', text: 'Build it' },
      { id: 'answer', at: '2026-07-16T00:00:01.000Z', type: 'assistant', text: 'Work' },
    ]);
    const update: CodexSessionEventUpdate = {
      sessionId: 'session', status: 'thinking', updatedAt: '2026-07-16T00:00:02.000Z', turnId: 'turn',
      event: { id: 'answer', at: '2026-07-16T00:00:02.000Z', type: 'assistant', text: 'Working now' },
    };

    expect(applyCodexSessionEventUpdate(current, update).events.map((event) => event.text)).toEqual(['Build it', 'Working now']);
  });

  it('merges compact session projections into complete local history', () => {
    const current = session([
      { id: 'old', at: '2026-07-16T00:00:00.000Z', type: 'user', text: 'Old history' },
      { id: 'answer', at: '2026-07-16T00:00:01.000Z', type: 'assistant', text: 'Partial' },
    ]);
    const incoming = { ...current, events: [
      { id: 'answer', at: '2026-07-16T00:00:02.000Z', type: 'assistant' as const, text: 'Complete' },
      { id: 'status', at: '2026-07-16T00:00:03.000Z', type: 'status' as const, text: 'Done' },
    ] };

    expect(mergeCodexSession(current, incoming).events.map((event) => event.text)).toEqual(['Old history', 'Complete', 'Done']);
  });

  it('does not let a stale REST projection erase a streamed response or regress completion', () => {
    const user = { id: 'user', at: '2026-07-16T00:00:01.000Z', type: 'user' as const, text: 'Hello' };
    const stale = { ...session([user]), updatedAt: '2026-07-16T00:00:01.000Z' };
    const current = {
      ...session([
        user,
        { id: 'answer', at: '2026-07-16T00:00:02.000Z', type: 'assistant' as const, text: 'Hi' },
        { id: 'done', at: '2026-07-16T00:00:03.000Z', type: 'status' as const, text: 'Done' },
      ]),
      status: 'completed' as const,
      turnId: undefined,
      updatedAt: '2026-07-16T00:00:03.000Z',
    };
    const currentSnapshot = { sessions: [current] } as FleetSnapshot;
    const staleSnapshot = { sessions: [stale] } as FleetSnapshot;

    const merged = mergeLiveSnapshot(currentSnapshot, staleSnapshot).sessions[0]!;
    expect(merged.status).toBe('completed');
    expect(merged.turnId).toBeUndefined();
    expect(merged.events.map((event) => event.text)).toEqual(['Hello', 'Hi', 'Done']);
  });

  it('does not let a delayed delta regress a completed session', () => {
    const current = {
      ...session([]), status: 'completed' as const, turnId: undefined,
      updatedAt: '2026-07-16T00:00:03.000Z',
    };
    const update: CodexSessionEventUpdate = {
      sessionId: 'session', status: 'thinking', updatedAt: '2026-07-16T00:00:02.000Z', turnId: 'old-turn',
      event: { id: 'answer', at: '2026-07-16T00:00:02.000Z', type: 'assistant', text: 'Hi' },
    };

    const merged = applyCodexSessionEventUpdate(current, update);
    expect(merged.status).toBe('completed');
    expect(merged.turnId).toBeUndefined();
    expect(merged.events[0]?.text).toBe('Hi');
  });
});
