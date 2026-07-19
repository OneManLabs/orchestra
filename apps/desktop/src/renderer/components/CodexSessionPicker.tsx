import type { CodexSession } from '@fleet/shared';
import { Archive, Bot, Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  codexSessionDisplayTitle,
  codexSessionStatusLabel,
  groupedCodexSessions,
} from '../lib/codex-session-state';
import { relativeTime } from '../lib/format';

export function CodexSessionPicker({ sessions, active, onSelect }: {
  sessions: CodexSession[];
  active: CodexSession;
  onSelect(sessionId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const groups = useMemo(() => groupedCodexSessions(sessions), [sessions]);
  const history = groups.find((group) => group.id === 'history')!;
  const visibleGroups = useMemo(() => groups.map((group) => group.id !== 'history' || showHistory
    ? group
    : { ...group, sessions: group.sessions.filter((session) => session.id === active.id) }), [active.id, groups, showHistory]);
  const visibleSessions = visibleGroups.flatMap((group) => group.sessions);
  const hiddenHistoryCount = history.sessions.filter((session) => session.id !== active.id).length;

  useEffect(() => {
    if (!open) return;
    const activeIndex = visibleSessions.findIndex((session) => session.id === active.id);
    setHighlightedIndex(activeIndex >= 0 ? activeIndex : 0);
  }, [open, active.id, showHistory]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(`[data-session-index="${highlightedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  function choose(session: CodexSession): void {
    onSelect(session.id);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlightedIndex((current) => (current + direction + visibleSessions.length) % visibleSessions.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setHighlightedIndex(event.key === 'Home' ? 0 : visibleSessions.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const selected = visibleSessions[highlightedIndex];
      if (selected) choose(selected);
    }
  }

  return <div className={`session-picker ${open ? 'is-open' : ''}`} ref={root}>
    <button
      ref={trigger}
      type="button"
      className="session-picker__trigger"
      aria-haspopup="listbox"
      aria-controls={menuId}
      aria-expanded={open}
      aria-activedescendant={open ? `${menuId}-${visibleSessions[highlightedIndex]?.id ?? active.id}` : undefined}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={keyDown}
    >
      <span className="session-picker__icon"><Bot size={14} /></span>
      <span className="session-picker__selection"><strong>{codexSessionDisplayTitle(active)}</strong><small><i className={`session-picker__status session-picker__status--${active.status}`} />{sessionMeta(active)}</small></span>
      <ChevronDown size={14} />
    </button>

    {open && <div className="session-picker__menu">
      <header><span><strong>Codex sessions</strong><small>Switch conversations on this device</small></span><kbd>↑↓</kbd></header>
      <div className="session-picker__list" id={menuId} role="listbox" aria-label="Codex sessions">
        {visibleGroups.filter((group) => group.sessions.length > 0).map((group) => <section key={group.id} aria-label={group.label}>
          <header><span>{group.label}</span><i>{group.sessions.length}</i></header>
          {group.sessions.map((session) => {
            const index = visibleSessions.findIndex((candidate) => candidate.id === session.id);
            const selected = session.id === active.id;
            return <button
              type="button"
              role="option"
              id={`${menuId}-${session.id}`}
              key={session.id}
              data-session-index={index}
              aria-selected={selected}
              className={`${selected ? 'is-selected' : ''} ${index === highlightedIndex ? 'is-highlighted' : ''}`.trim()}
              onMouseEnter={() => setHighlightedIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(session)}
            >
              <i className={`session-picker__status session-picker__status--${session.status}`} />
              <span><strong>{codexSessionDisplayTitle(session)}</strong><small>{sessionMeta(session)}</small></span>
              {selected && <Check size={14} />}
            </button>;
          })}
        </section>)}
      </div>
      {history.sessions.length > 0 && <footer><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setShowHistory((current) => !current)}><Archive size={13} /><span>{showHistory ? 'Hide stopped and failed sessions' : `Show session history${hiddenHistoryCount ? ` (${hiddenHistoryCount})` : ''}`}</span></button></footer>}
    </div>}
  </div>;
}

function sessionMeta(session: CodexSession): string {
  const workspace = session.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  return `${codexSessionStatusLabel(session.status)}${workspace ? ` · ${workspace}` : ''} · ${relativeTime(session.updatedAt)}`;
}
