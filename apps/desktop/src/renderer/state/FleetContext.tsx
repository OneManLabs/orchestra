import type { ClientEvent, CodexSessionEventUpdate, FleetSnapshot, TerminalSession } from '@fleet/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { api, configureBrowserConnection, connectClientEvents } from '../lib/api';
import { applyCodexSessionEventUpdate, mergeCodexSession, mergeLiveSnapshot } from '../lib/codex-live-update';

type TerminalDataListener = (data: string) => void;

interface FleetContextValue {
  snapshot: FleetSnapshot | null;
  loading: boolean;
  connected: boolean;
  error: string | null;
  refresh(): Promise<void>;
  connectBrowser(coreUrl: string, token: string): Promise<void>;
  request<T>(operation: () => Promise<T>): Promise<T>;
  subscribeTerminal(id: string, listener: TerminalDataListener): () => void;
}

const FleetContext = createContext<FleetContextValue | null>(null);

export function FleetProvider({ children }: PropsWithChildren) {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const terminalListeners = useRef(new Map<string, Set<TerminalDataListener>>());

  const refresh = useCallback(async () => {
    try {
      const next = await api.snapshot();
      // Snapshot requests are large enough that a newer WebSocket event may
      // arrive while one is in flight. Merge instead of replacing live state.
      setSnapshot((current) => mergeLiveSnapshot(current, next));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!window.fleetDesktop && !snapshot) { setConnected(false); return; }
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void connectClientEvents((raw) => {
      try {
        const event = JSON.parse(raw) as ClientEvent;
        if (event.type === 'terminal.data') {
          terminalListeners.current.get(event.payload.terminalId)?.forEach((listener) => listener(event.payload.data));
          return;
        }
        if (event.type === 'snapshot') {
          setSnapshot((current) => mergeLiveSnapshot(current, event.payload as FleetSnapshot));
          setError(null);
          return;
        }
        if (event.type === 'v2.updated') {
          void refresh();
          return;
        }
        setSnapshot((current) => {
          if (!current) return current;
          if (event.type === 'device.updated') return { ...current, devices: replace(current.devices, event.payload as FleetSnapshot['devices'][number]) };
          if (event.type === 'job.updated') return { ...current, jobs: replace(current.jobs, event.payload as FleetSnapshot['jobs'][number]) };
          if (event.type === 'project.updated') return { ...current, projects: replace(current.projects, event.payload as FleetSnapshot['projects'][number]) };
          if (event.type === 'session.updated') {
            const incoming = event.payload as FleetSnapshot['sessions'][number];
            const existing = current.sessions.find((session) => session.id === incoming.id);
            return { ...current, sessions: replace(current.sessions, existing ? mergeCodexSession(existing, incoming) : incoming) };
          }
          if (event.type === 'session.event.updated') {
            const update = event.payload as CodexSessionEventUpdate;
            return { ...current, sessions: current.sessions.map((session) => applyCodexSessionEventUpdate(session, update)) };
          }
          if (event.type === 'terminal.updated') return { ...current, terminals: replace(current.terminals, event.payload as TerminalSession) };
          if (event.type === 'system.updated') {
            const conversation = event.payload as FleetSnapshot['systemConversation'];
            if (conversation.id !== current.systemConversation.id) void refresh();
            return {
              ...current,
              systemConversation: conversation,
              systemConversations: replace(current.systemConversations ?? [current.systemConversation], conversation),
            };
          }
          if (event.type === 'activity.created') return { ...current, activity: [event.payload as FleetSnapshot['activity'][number], ...current.activity].slice(0, 250) };
          return current;
        });
      } catch { /* Ignore malformed socket frames; REST state stays usable. */ }
    }, setConnected).then((value) => {
      if (disposed) value();
      else cleanup = value;
    });
    return () => { disposed = true; cleanup?.(); };
  }, [refresh, connectionRevision, Boolean(snapshot)]);

  const connectBrowser = useCallback(async (coreUrl: string, token: string) => {
    configureBrowserConnection(coreUrl, token);
    setLoading(true);
    setError(null);
    setConnectionRevision((value) => value + 1);
    await refresh();
  }, [refresh]);

  const request = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    try {
      const result = await operation();
      setError(null);
      await refresh();
      return result;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      throw value;
    }
  }, [refresh]);

  const subscribeTerminal = useCallback((id: string, listener: TerminalDataListener) => {
    const listeners = terminalListeners.current.get(id) ?? new Set<TerminalDataListener>();
    listeners.add(listener);
    terminalListeners.current.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) terminalListeners.current.delete(id);
    };
  }, []);

  const value = useMemo(() => ({ snapshot, loading, connected, error, refresh, connectBrowser, request, subscribeTerminal }), [snapshot, loading, connected, error, refresh, connectBrowser, request, subscribeTerminal]);
  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

function replace<T extends { id: string }>(items: T[], incoming: T): T[] {
  return items.some((item) => item.id === incoming.id)
    ? items.map((item) => item.id === incoming.id ? incoming : item)
    : [incoming, ...items];
}

export function useFleet(): FleetContextValue {
  const context = useContext(FleetContext);
  if (!context) throw new Error('useFleet must be used within FleetProvider');
  return context;
}
