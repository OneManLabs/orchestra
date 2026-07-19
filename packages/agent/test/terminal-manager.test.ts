import type { AgentToCoreMessage, TerminalSession } from '@fleet/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  loadTerminalRuntime,
  terminalCapabilityLabels,
  TerminalManager,
  TERMINAL_UNAVAILABLE_MESSAGE,
} from '../src/terminal-manager.js';

const terminal: TerminalSession = {
  id: 'terminal-1',
  deviceId: 'device-1',
  cwd: '/workspace',
  shell: '/bin/sh',
  cols: 120,
  rows: 40,
  createdAt: new Date(0).toISOString(),
  status: 'starting',
};

describe('optional terminal runtime', () => {
  it('keeps the manager usable in appliance mode and clearly rejects every terminal command', () => {
    const runtime = loadTerminalRuntime(() => { throw new Error('native binding unavailable'); });
    const manager = new TerminalManager(() => {}, undefined, runtime);

    expect(manager.available).toBe(false);
    expect(runtime.unavailableReason).toBe('native binding unavailable');
    expect(terminalCapabilityLabels(runtime)).toEqual([]);
    expect(() => manager.start(terminal, undefined, terminal.cwd)).toThrow(TERMINAL_UNAVAILABLE_MESSAGE);
    expect(() => manager.input(terminal.id, 'input')).toThrow(TERMINAL_UNAVAILABLE_MESSAGE);
    expect(() => manager.resize(terminal.id, 80, 24)).toThrow(TERMINAL_UNAVAILABLE_MESSAGE);
    expect(() => manager.stop(terminal.id)).toThrow(TERMINAL_UNAVAILABLE_MESSAGE);
    expect(() => manager.shutdown()).not.toThrow();
  });

  it('advertises and drives interactive terminals when a PTY runtime is available', () => {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const write = vi.fn();
    const resize = vi.fn();
    const kill = vi.fn();
    const spawn = vi.fn(() => ({
      write,
      resize,
      kill,
      onData(callback: (data: string) => void) { onData = callback; return { dispose() {} }; },
      onExit(callback: (event: { exitCode: number; signal?: number }) => void) { onExit = callback; return { dispose() {} }; },
    }));
    const runtime = loadTerminalRuntime(() => ({ spawn }));
    const messages: AgentToCoreMessage[] = [];
    const manager = new TerminalManager((message) => messages.push(message), undefined, runtime);

    expect(manager.available).toBe(true);
    expect(terminalCapabilityLabels(runtime)).toEqual(['feature:terminal']);
    manager.start(terminal, { FLEET_TEST: 'true' }, terminal.cwd);
    expect(spawn).toHaveBeenCalledWith('/bin/sh', expect.any(Array), expect.objectContaining({ cwd: terminal.cwd, cols: 120, rows: 40 }));
    manager.input(terminal.id, 'hello');
    manager.resize(terminal.id, 90, 30);
    expect(write).toHaveBeenCalledWith('hello');
    expect(resize).toHaveBeenCalledWith(90, 30);

    onData?.('output');
    onExit?.({ exitCode: 0 });
    expect(messages).toEqual([
      { type: 'terminal.data', payload: { terminalId: terminal.id, data: 'output' } },
      { type: 'terminal.exit', payload: { terminalId: terminal.id, exitCode: 0, signal: undefined } },
    ]);
  });

  it('treats a malformed node-pty module as unavailable', () => {
    const runtime = loadTerminalRuntime(() => ({}));
    expect(runtime.module).toBeUndefined();
    expect(runtime.unavailableReason).toMatch(/spawn function/);
  });
});
