import type { TerminalSession } from '@fleet/shared';

export function isLiveTerminalSession(session: Pick<TerminalSession, 'status'>): boolean {
  return session.status === 'open';
}

export function preferredTerminalSession<T extends Pick<TerminalSession, 'status'>>(sessions: readonly T[]): T | undefined {
  return sessions.find((session) => session.status === 'open');
}
