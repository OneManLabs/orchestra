import { contextualCodexSessionTitleFromEvents, isGenericCodexSessionTitle } from '@fleet/shared';
import type { CodexSession, CodexSessionStatus } from '@fleet/shared';

const MESSAGEABLE_STATUSES = new Set<CodexSessionStatus>(['ready', 'thinking', 'completed']);
const TERMINAL_STATUSES = new Set<CodexSessionStatus>(['stopped', 'error']);
const SESSION_STATUS_RANK: Record<CodexSessionStatus, number> = {
  'awaiting-approval': 0,
  thinking: 1,
  starting: 2,
  ready: 3,
  completed: 4,
  stopped: 5,
  error: 6,
};

export type CodexSessionGroupId = 'active' | 'completed' | 'history';

export interface CodexSessionGroup<T> {
  id: CodexSessionGroupId;
  label: string;
  sessions: T[];
}

export interface InitialCodexSessionTarget {
  id: string | null;
  sequence: number;
}

/**
 * Deep links and Codex Micro selections are commands, not persistent selection.
 * The same target object is consumed once so live snapshot updates cannot pull
 * the operator away from a manually selected or newly-created conversation.
 */
export function shouldApplyInitialCodexSessionTarget(
  target: InitialCodexSessionTarget | undefined,
  consumed: InitialCodexSessionTarget | undefined,
  availableSessionIds: readonly string[],
): boolean {
  return Boolean(target && target.sequence !== consumed?.sequence && (target.id === null || availableSessionIds.includes(target.id)));
}

export function canMessageCodexSession(session: Pick<CodexSession, 'status'> | undefined): boolean {
  return Boolean(session && MESSAGEABLE_STATUSES.has(session.status));
}

export function isTerminalCodexSession(session: Pick<CodexSession, 'status'> | undefined): boolean {
  return Boolean(session && TERMINAL_STATUSES.has(session.status));
}

/** Prefer a usable/live session over archived history when opening a device. */
export function preferredCodexSession<T extends Pick<CodexSession, 'status'> & Partial<Pick<CodexSession, 'updatedAt'>>>(sessions: readonly T[]): T | undefined {
  return rankedCodexSessions(sessions)[0];
}

export function rankedCodexSessions<T extends Pick<CodexSession, 'status'> & Partial<Pick<CodexSession, 'updatedAt'>>>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => {
    const rank = SESSION_STATUS_RANK[left.status] - SESSION_STATUS_RANK[right.status];
    if (rank !== 0) return rank;
    return sessionTimestamp(right.updatedAt) - sessionTimestamp(left.updatedAt);
  });
}

export function groupedCodexSessions<T extends Pick<CodexSession, 'status'> & Partial<Pick<CodexSession, 'updatedAt'>>>(sessions: readonly T[]): CodexSessionGroup<T>[] {
  const ranked = rankedCodexSessions(sessions);
  return [
    { id: 'active', label: 'Active sessions', sessions: ranked.filter((session) => !['completed', 'stopped', 'error'].includes(session.status)) },
    { id: 'completed', label: 'Completed · ready to continue', sessions: ranked.filter((session) => session.status === 'completed') },
    { id: 'history', label: 'History · stopped or failed', sessions: ranked.filter((session) => isTerminalCodexSession(session)) },
  ];
}

export function codexSessionStatusLabel(status: CodexSessionStatus): string {
  if (status === 'awaiting-approval') return 'Needs approval';
  if (status === 'thinking') return 'Working';
  if (status === 'error') return 'Failed';
  return status[0]!.toUpperCase() + status.slice(1);
}

export function codexSessionDisplayTitle(session: Pick<CodexSession, 'title' | 'titleSource' | 'cwd' | 'events'>): string {
  const title = session.title.trim();
  const hasUserContext = session.events.some((event) => event.type === 'user' && event.text.trim());
  const canGenerate = session.titleSource === 'generated'
    || (session.titleSource !== 'manual' && isGenericCodexSessionTitle(title));
  if (canGenerate && hasUserContext) return contextualCodexSessionTitleFromEvents(session.events, title || 'Codex session');
  if (title) return title;
  const workspace = session.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  return workspace ? `${workspace} session` : 'Untitled session';
}

export function codexSessionUnavailableMessage(status: CodexSessionStatus): string {
  if (status === 'stopped') return 'This session is stopped. Resume its thread or start a new session before sending another message.';
  if (status === 'error') return 'This session failed and cannot accept more messages. Review its history, then start a new session.';
  if (status === 'starting') return 'Codex is still starting. Messaging will unlock when the session is ready.';
  if (status === 'thinking') return 'Codex is working on the current turn. New messages steer the active turn.';
  if (status === 'awaiting-approval') return 'Codex is waiting for an approval or response before it can accept another message.';
  return 'This session is not ready for another message.';
}

function sessionTimestamp(value: string | undefined): number {
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
