import { describe, expect, it, vi } from 'vitest';
import type { MenuBarCodexSession } from '@fleet/shared';
import { CodexMicroController, codexMicroDialDirection } from '../src/main/codex-micro.js';

function session(id: string, status: MenuBarCodexSession['status'], updatedAt: string, pendingApprovalCount = 0): MenuBarCodexSession {
  return {
    id,
    deviceId: `device-${id}`,
    deviceName: `Device ${id}`,
    title: `Session ${id}`,
    cwd: '/workspace',
    status,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt,
    pendingApprovalCount,
  };
}

function controller(): CodexMicroController {
  return new CodexMicroController(undefined, {
    onStateChanged: vi.fn(),
    onSessionSelected: vi.fn(),
    onAction: vi.fn(),
    onDial: vi.fn(),
  });
}

describe('CodexMicroController session lights', () => {
  it('never treats directional encoder packets as knob presses', () => {
    expect(codexMicroDialDirection({ key: 'ENC_CW', act: 2 })).toBe('clockwise');
    expect(codexMicroDialDirection({ key: 'ENC_CC', act: 2 })).toBe('counterclockwise');
    expect(codexMicroDialDirection({ key: 'ENC_CW', act: 1 })).toBeNull();
    expect(codexMicroDialDirection({ key: 'ENC_CC', act: 0 })).toBeNull();
    expect(codexMicroDialDirection({ key: 'ENC_PUSH', act: 1 })).toBe('press');
    expect(codexMicroDialDirection({ key: 'ENC_PUSH', act: 0 })).toBe('release');
  });

  it('acknowledges historical terminal sessions on the first snapshot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T12:05:00.000Z'));
    try {
      const micro = controller();
      micro.updateSessions([
        session('approval', 'awaiting-approval', '2026-07-18T12:03:00.000Z', 1),
        session('working', 'thinking', '2026-07-18T12:02:00.000Z'),
        session('error', 'error', '2026-07-18T12:01:00.000Z'),
        session('complete', 'completed', '2026-07-18T12:00:00.000Z'),
      ]);

      expect(micro.getState().slots.slice(0, 4).map((slot) => slot.lightStatus)).toEqual([
        'awaiting-approval',
        'working',
        'idle',
        'idle',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lights a newly completed or failed turn after startup', () => {
    const micro = controller();
    micro.updateSessions([
      session('one', 'thinking', '2026-07-18T12:00:00.000Z'),
      session('two', 'ready', '2026-07-18T12:00:00.000Z'),
    ]);
    micro.updateSessions([
      session('one', 'completed', '2026-07-18T12:01:00.000Z'),
      session('two', 'error', '2026-07-18T12:01:00.000Z'),
    ]);

    expect(micro.getState().slots.slice(0, 2).map((slot) => slot.lightStatus)).toEqual(['unread', 'error']);
  });

  it('keeps unread terminal sessions until viewed, then removes them after the grace period', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T13:00:00.000Z'));
    try {
      const micro = controller();
      micro.updateSessions([session('one', 'thinking', '2026-07-18T13:00:00.000Z')]);
      micro.updateSessions([session('one', 'completed', '2026-07-18T13:01:00.000Z')]);

      vi.setSystemTime(new Date('2026-07-18T16:00:00.000Z'));
      micro.updateSessions([session('one', 'completed', '2026-07-18T13:01:00.000Z')]);
      expect(micro.getState().slots[0]?.lightStatus).toBe('unread');

      micro.setActiveSession('one');
      expect(micro.getState().activeSessionId).toBe('one');
      expect(micro.getState().slots[0]?.lightStatus).toBe('idle');

      vi.setSystemTime(new Date('2026-07-18T16:31:00.000Z'));
      micro.updateSessions([session('one', 'completed', '2026-07-18T13:01:00.000Z')]);
      expect(micro.getState().slots.every((slot) => slot.sessionId !== 'one')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves occupied slot positions while filling a vacated attention slot', () => {
    const micro = controller();
    micro.updateSessions([
      session('one', 'thinking', '2026-07-18T12:03:00.000Z'),
      session('two', 'ready', '2026-07-18T12:02:00.000Z'),
      session('three', 'ready', '2026-07-18T12:01:00.000Z'),
    ]);
    const original = micro.getState().slots.slice(0, 3).map((slot) => slot.sessionId);

    micro.updateSessions([
      session('one', 'thinking', '2026-07-18T12:04:00.000Z'),
      session('three', 'ready', '2026-07-18T12:01:00.000Z'),
      session('four', 'awaiting-approval', '2026-07-18T12:05:00.000Z', 1),
    ]);

    expect(original).toEqual(['one', 'two', 'three']);
    expect(micro.getState().slots.slice(0, 3).map((slot) => slot.sessionId)).toEqual(['one', 'four', 'three']);
  });
});
