import { createRequire } from 'node:module';
import type { AgentToCoreMessage, TerminalSession } from '@fleet/shared';
import { defaultInteractiveShell } from './capabilities.js';

type SendMessage = (message: AgentToCoreMessage) => void;
interface PtyProcess {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface PtyModule {
  spawn(file: string, args: string[], options: {
    name?: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }): PtyProcess;
}

export interface TerminalRuntime {
  module?: PtyModule;
  unavailableReason?: string;
}

export const TERMINAL_UNAVAILABLE_MESSAGE = 'Interactive terminal commands are unavailable because this Fleet Agent does not have a working node-pty runtime.';

const require = createRequire(import.meta.url);
const detectedRuntime = loadTerminalRuntime();

export class TerminalManager {
  private readonly terminals = new Map<string, PtyProcess>();

  constructor(
    private readonly send: SendMessage,
    private readonly configuredShell?: string,
    private readonly runtime: TerminalRuntime = detectedRuntime,
  ) {}

  get available(): boolean {
    return this.runtime.module !== undefined;
  }

  get unavailableReason(): string | undefined {
    return this.runtime.unavailableReason;
  }

  assertAvailable(): void {
    if (!this.runtime.module) throw new Error(TERMINAL_UNAVAILABLE_MESSAGE);
  }

  start(terminal: TerminalSession, env: Record<string, string> | undefined, cwd: string): void {
    const runtime = this.requireRuntime();
    if (this.terminals.has(terminal.id)) throw new Error(`Terminal already exists: ${terminal.id}`);
    const shell = terminal.shell || this.configuredShell || defaultInteractiveShell();
    const args = interactiveShellArgs(shell);
    const processEnvironment = stringEnvironment({ ...process.env, ...env, TERM: process.env.TERM ?? 'xterm-256color' });
    const instance = runtime.spawn(shell, args, {
      name: processEnvironment.TERM,
      cols: clampDimension(terminal.cols),
      rows: clampDimension(terminal.rows),
      cwd,
      env: processEnvironment,
    });
    this.terminals.set(terminal.id, instance);
    instance.onData((data) => this.send({ type: 'terminal.data', payload: { terminalId: terminal.id, data } }));
    instance.onExit(({ exitCode, signal }) => {
      this.terminals.delete(terminal.id);
      this.send({ type: 'terminal.exit', payload: { terminalId: terminal.id, exitCode, signal } });
    });
  }

  input(terminalId: string, data: string): void {
    this.get(terminalId).write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.get(terminalId).resize(clampDimension(cols), clampDimension(rows));
  }

  stop(terminalId: string): void {
    this.get(terminalId).kill();
  }

  shutdown(): void {
    for (const terminal of this.terminals.values()) terminal.kill();
    this.terminals.clear();
  }

  private get(terminalId: string): PtyProcess {
    this.assertAvailable();
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
    return terminal;
  }

  private requireRuntime(): PtyModule {
    this.assertAvailable();
    return this.runtime.module as PtyModule;
  }
}

export function isTerminalRuntimeAvailable(): boolean {
  return detectedRuntime.module !== undefined;
}

export function terminalCapabilityLabels(runtime: TerminalRuntime = detectedRuntime): string[] {
  return runtime.module ? ['feature:terminal'] : [];
}

export function loadTerminalRuntime(loader: () => unknown = () => require('node-pty')): TerminalRuntime {
  try {
    const candidate = loader();
    if (!candidate || typeof candidate !== 'object' || typeof (candidate as { spawn?: unknown }).spawn !== 'function') {
      return { unavailableReason: 'The node-pty module did not provide a spawn function.' };
    }
    return { module: candidate as PtyModule };
  } catch (error) {
    return { unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

export function interactiveShellArgs(shell: string): string[] {
  const name = shell.toLowerCase();
  if (process.platform === 'win32') {
    return name.includes('powershell') || name.includes('pwsh') ? ['-NoLogo'] : [];
  }
  return ['-l'];
}

function clampDimension(value: number): number {
  return Math.min(1_000, Math.max(2, Math.floor(value)));
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
