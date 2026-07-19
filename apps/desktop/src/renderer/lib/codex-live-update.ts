import type { CodexSession, CodexSessionEventUpdate, FleetSnapshot } from '@fleet/shared';

const MAX_CLIENT_CODEX_EVENTS = 1_000;

export function mergeCodexSession(current: CodexSession, incoming: CodexSession): CodexSession {
  const incomingEvents = new Map(incoming.events.map((event) => [event.id, event]));
  const currentIds = new Set(current.events.map((event) => event.id));
  const events = [
    ...current.events.map((event) => incomingEvents.get(event.id) ?? event),
    ...incoming.events.filter((event) => !currentIds.has(event.id)),
  ].slice(-MAX_CLIENT_CODEX_EVENTS);
  // A REST refresh can start before a streamed event and finish after it. Keep
  // metadata from the newest projection so that late HTTP responses cannot
  // put a completed session back into "thinking" or restore an old turn ID.
  const newest = incoming.updatedAt >= current.updatedAt ? incoming : current;
  return { ...newest, events };
}

export function applyCodexSessionEventUpdate(session: CodexSession, update: CodexSessionEventUpdate): CodexSession {
  if (session.id !== update.sessionId) return session;
  const index = session.events.findIndex((event) => event.id === update.event.id);
  const events = index < 0
    ? [...session.events, update.event].slice(-MAX_CLIENT_CODEX_EVENTS)
    : session.events.map((event, eventIndex) => eventIndex === index ? update.event : event);
  if (update.updatedAt < session.updatedAt) return { ...session, events };
  return { ...session, events, status: update.status, updatedAt: update.updatedAt, turnId: update.turnId ?? session.turnId, error: update.error };
}

export function mergeLiveSnapshot(current: FleetSnapshot | null, incoming: FleetSnapshot): FleetSnapshot {
  if (!current) return incoming;
  const existing = new Map(current.sessions.map((session) => [session.id, session]));
  const incomingIds = new Set(incoming.sessions.map((session) => session.id));
  return {
    ...incoming,
    sessions: [
      ...incoming.sessions.map((session) => {
        const prior = existing.get(session.id);
        return prior ? mergeCodexSession(prior, session) : session;
      }),
      ...current.sessions.filter((session) => !incomingIds.has(session.id)),
    ],
  };
}
