import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from '@fleet/shared';
import { api } from '../lib/api';
import { useFleet } from '../state/FleetContext';

export function TerminalView({ session }: { session: TerminalSession }) {
  const host = useRef<HTMLDivElement>(null);
  const { subscribeTerminal } = useFleet();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.42,
      letterSpacing: 0.15,
      scrollback: 8_000,
      allowTransparency: true,
      theme: {
        background: '#090d12', foreground: '#dce5ef', cursor: '#7dd3fc', selectionBackground: '#1d4ed855',
        black: '#111827', red: '#fb7185', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa',
        magenta: '#c084fc', cyan: '#22d3ee', white: '#d1d5db', brightBlack: '#64748b', brightWhite: '#f8fafc'
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    terminal.focus();

    const input = terminal.onData((data) => { void api.terminalInput(session.id, data); });
    const unsubscribe = subscribeTerminal(session.id, (data) => terminal.write(data));
    let last = `${terminal.cols}x${terminal.rows}`;
    const resize = new ResizeObserver(() => {
      fit.fit();
      const next = `${terminal.cols}x${terminal.rows}`;
      if (next !== last) {
        last = next;
        void api.terminalResize(session.id, terminal.cols, terminal.rows);
      }
    });
    resize.observe(element);

    return () => {
      resize.disconnect();
      unsubscribe();
      input.dispose();
      terminal.dispose();
    };
  }, [session.id, subscribeTerminal]);

  return <div className="terminal-host" ref={host} aria-label="Remote terminal" />;
}
