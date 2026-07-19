import type { CodexSessionStatus } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import {
  canMessageCodexSession,
  codexSessionDisplayTitle,
  codexSessionUnavailableMessage,
  groupedCodexSessions,
  isTerminalCodexSession,
  preferredCodexSession,
  rankedCodexSessions,
  shouldApplyInitialCodexSessionTarget,
} from '../src/renderer/lib/codex-session-state.js';

function session(id: string, status: CodexSessionStatus) {
  return { id, status };
}

describe('Codex session UI state', () => {
  it('allows messages only in statuses accepted by Fleet Core', () => {
    expect(canMessageCodexSession(session('ready', 'ready'))).toBe(true);
    expect(canMessageCodexSession(session('thinking', 'thinking'))).toBe(true);
    expect(canMessageCodexSession(session('completed', 'completed'))).toBe(true);
    for (const status of ['starting', 'awaiting-approval', 'stopped', 'error'] as const) {
      expect(canMessageCodexSession(session(status, status))).toBe(false);
    }
  });

  it('prefers a live session over newer stopped or failed history', () => {
    expect(preferredCodexSession([
      session('stopped', 'stopped'),
      session('failed', 'error'),
      session('ready', 'ready'),
    ])?.id).toBe('ready');
  });

  it('keeps archived history viewable when no live session exists', () => {
    const archived = [session('stopped', 'stopped'), session('failed', 'error')];
    expect(preferredCodexSession(archived)?.id).toBe('stopped');
    expect(archived.every(isTerminalCodexSession)).toBe(true);
  });

  it('gives stopped and failed sessions actionable explanations', () => {
    expect(codexSessionUnavailableMessage('stopped')).toContain('Resume');
    expect(codexSessionUnavailableMessage('error')).toContain('failed');
  });

  it('ranks attention and working sessions above completed and archived history', () => {
    expect(rankedCodexSessions([
      { id: 'stopped', status: 'stopped', updatedAt: '2026-07-16T12:05:00Z' },
      { id: 'completed', status: 'completed', updatedAt: '2026-07-16T12:04:00Z' },
      { id: 'ready', status: 'ready', updatedAt: '2026-07-16T12:03:00Z' },
      { id: 'working', status: 'thinking', updatedAt: '2026-07-16T12:02:00Z' },
      { id: 'approval', status: 'awaiting-approval', updatedAt: '2026-07-16T12:01:00Z' },
    ]).map((item) => item.id)).toEqual(['approval', 'working', 'ready', 'completed', 'stopped']);
  });

  it('groups stopped and failed sessions as history after completed sessions', () => {
    const groups = groupedCodexSessions([
      session('stopped', 'stopped'),
      session('completed', 'completed'),
      session('working', 'thinking'),
      session('failed', 'error'),
    ]);

    expect(groups.map((group) => [group.id, group.sessions.map((item) => item.id)])).toEqual([
      ['active', ['working']],
      ['completed', ['completed']],
      ['history', ['stopped', 'failed']],
    ]);
  });

  it('generates a concise title for generically named sessions', () => {
    expect(codexSessionDisplayTitle({
      title: 'Fleet session',
      titleSource: 'generated',
      cwd: '/work/fleet',
      events: [{ id: 'event', at: '2026-07-16T12:00:00Z', type: 'user', text: 'Fix the device inspector session ordering and labels' }],
    })).toBe('Fix Device Inspector Session Ordering Labels');
  });

  it('evolves generated titles with the broader session context', () => {
    expect(codexSessionDisplayTitle({
      title: 'Fleet Canvas Sidebar Resizing',
      titleSource: 'generated',
      cwd: '/work/fleet',
      events: [
        { id: '1', at: '2026-07-16T12:00:00Z', type: 'user', text: 'Make the Fleet Canvas right sidebar draggable and responsive.' },
        { id: '2', at: '2026-07-16T12:01:00Z', type: 'assistant', text: 'Implemented responsive sidebar resizing.' },
        { id: '3', at: '2026-07-16T12:02:00Z', type: 'user', text: 'Keep Markdown message formatting inside the narrow sidebar.' },
        { id: '4', at: '2026-07-16T12:03:00Z', type: 'user', text: 'Improve the Codex session picker and session naming.' },
      ],
    })).toBe('Fleet Device Sidebar UX');
  });

  it('keeps an explicitly renamed title pinned', () => {
    expect(codexSessionDisplayTitle({
      title: 'My release room',
      titleSource: 'manual',
      cwd: '/work/fleet',
      events: [{ id: 'event', at: '2026-07-16T12:00:00Z', type: 'user', text: 'Fix the device inspector session ordering and labels' }],
    })).toBe('My release room');
  });

  it('consumes a deep-linked session once instead of reapplying it on every snapshot', () => {
    const target = { id: 'session-a', sequence: 1 };
    expect(shouldApplyInitialCodexSessionTarget(target, undefined, ['session-a', 'session-b'])).toBe(true);

    // A heartbeat creates a new sessions array, but the operator can stay on B
    // or in the New Session launcher because the external request was consumed.
    expect(shouldApplyInitialCodexSessionTarget(target, target, ['session-a', 'session-b'])).toBe(false);
    expect(shouldApplyInitialCodexSessionTarget(target, target, ['session-b', 'session-a'])).toBe(false);

    // Selecting the same hardware slot again is a new command object.
    expect(shouldApplyInitialCodexSessionTarget({ id: 'session-a', sequence: 2 }, target, ['session-a'])).toBe(true);
  });

  it('waits to consume a deep link until its session appears', () => {
    const target = { id: 'delayed-session', sequence: 1 };
    expect(shouldApplyInitialCodexSessionTarget(target, undefined, [])).toBe(false);
    expect(shouldApplyInitialCodexSessionTarget(target, undefined, ['delayed-session'])).toBe(true);
  });

  it('consumes a sequenced New Session command exactly once', () => {
    const target = { id: null, sequence: 3 };
    expect(shouldApplyInitialCodexSessionTarget(target, undefined, [])).toBe(true);
    expect(shouldApplyInitialCodexSessionTarget(target, target, [])).toBe(false);
  });
});
