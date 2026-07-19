import type { TerminalSession } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { isLiveTerminalSession, preferredTerminalSession } from '../src/renderer/lib/terminal-session-state.js';

function terminal(id: string, status: TerminalSession['status']) {
  return { id, status };
}

describe('terminal session UI state', () => {
  it('prefers an open terminal and ignores closed or failed history', () => {
    const selected = preferredTerminalSession([
      terminal('closed', 'closed'),
      terminal('error', 'error'),
      terminal('starting', 'starting'),
      terminal('open', 'open'),
    ]);
    expect(selected?.id).toBe('open');
  });

  it('does not treat old closed or error sessions as active', () => {
    const history = [terminal('closed', 'closed'), terminal('error', 'error'), terminal('starting', 'starting')];
    expect(preferredTerminalSession(history)).toBeUndefined();
    expect(history.some(isLiveTerminalSession)).toBe(false);
  });
});
