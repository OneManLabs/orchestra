import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { AgentToCoreMessage, FleetJob } from '@fleet/shared';
import { JsonLineDecoder } from './json-lines.js';
import { shellInvocation } from './process-utils.js';

type SendMessage = (message: AgentToCoreMessage) => void;

interface RunningJob {
  child: ChildProcessByStdio<null, Readable, Readable>;
  cancelled: boolean;
  complete: boolean;
}

export class JobManager {
  private readonly jobs = new Map<string, RunningJob>();

  constructor(
    private readonly codexCommand: string,
    private readonly configuredShell: string | undefined,
    private readonly send: SendMessage,
    private readonly onJobStart: () => void = () => {},
    private readonly onJobEnd: () => void = () => {},
  ) {}

  start(job: FleetJob, cwd: string, environment: Record<string, string> = {}): void {
    if (this.jobs.has(job.id)) throw new Error(`Job already running: ${job.id}`);
    const invocation = job.kind === 'codex'
      ? codexInvocation(this.codexCommand, job, cwd)
      : shellInvocation(shellJobCommand(job), this.configuredShell);
    const command = 'command' in invocation ? invocation.command : invocation.shell;
    const { args } = invocation;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment, NO_COLOR: '1' },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const running: RunningJob = { child, cancelled: false, complete: false };
    this.jobs.set(job.id, running);
    this.onJobStart();
    this.status(job.id, 'running');

    if (job.kind === 'codex') {
      const decoder = new JsonLineDecoder(
        (value, raw) => this.send({
          type: 'job.output',
          payload: { jobId: job.id, stream: 'codex', text: extractCodexOutput(value) ?? raw, raw: value },
        }),
        (raw) => this.output(job.id, 'stdout', raw),
      );
      child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk));
      child.stdout.on('end', () => decoder.flush());
    } else {
      child.stdout.on('data', (chunk: Buffer) => this.output(job.id, 'stdout', chunk.toString()));
    }
    child.stderr.on('data', (chunk: Buffer) => this.output(job.id, 'stderr', chunk.toString()));
    child.once('error', (error) => this.finish(job.id, running, undefined, error.message));
    child.once('close', (exitCode, signal) => {
      if (running.cancelled) this.finish(job.id, running, exitCode ?? undefined, undefined, true);
      else if (exitCode === 0) this.finish(job.id, running, 0);
      else this.finish(job.id, running, exitCode ?? undefined, `Process exited with ${exitCode === null ? `signal ${signal ?? 'unknown'}` : `code ${exitCode}`}.`);
    });
  }

  cancel(jobId: string): void {
    const running = this.jobs.get(jobId);
    if (!running) throw new Error(`Unknown running job: ${jobId}`);
    if (running.cancelled || running.complete) return;
    running.cancelled = true;
    terminateProcessTree(running.child, 'SIGTERM');
    const forceKill = setTimeout(() => {
      if (!running.complete && running.child.exitCode === null && running.child.signalCode === null) terminateProcessTree(running.child, 'SIGKILL');
    }, 5_000);
    forceKill.unref();
  }

  shutdown(): void {
    for (const [jobId, running] of this.jobs) {
      running.cancelled = true;
      terminateProcessTree(running.child, 'SIGTERM');
      const forceKill = setTimeout(() => {
        if (running.child.exitCode === null && running.child.signalCode === null) terminateProcessTree(running.child, 'SIGKILL');
      }, 1_000);
      forceKill.unref();
      this.finish(jobId, running, undefined, undefined, true);
    }
    this.jobs.clear();
  }

  private output(jobId: string, stream: 'stdout' | 'stderr', text: string): void {
    if (text) this.send({ type: 'job.output', payload: { jobId, stream, text } });
  }

  private status(jobId: string, status: 'running' | 'completed' | 'failed' | 'cancelled', exitCode?: number, error?: string): void {
    this.send({ type: 'job.status', payload: { jobId, status, exitCode, error } });
  }

  private finish(jobId: string, running: RunningJob, exitCode?: number, error?: string, cancelled = false): void {
    if (running.complete) return;
    running.complete = true;
    this.jobs.delete(jobId);
    this.onJobEnd();
    if (cancelled) this.status(jobId, 'cancelled', exitCode);
    else if (error) this.status(jobId, 'failed', exitCode, error);
    else this.status(jobId, 'completed', exitCode ?? 0);
  }
}

function terminateProcessTree(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { child.kill(signal); });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}

export function codexInvocation(codexCommand: string, job: FleetJob, cwd: string): { command: string; args: string[] } {
  const args = [
    'exec',
    '--json',
    '--color', 'never',
    '--sandbox', job.permissionMode,
    '-C', cwd,
    '-c', `approval_policy=${JSON.stringify(job.approvalPolicy)}`,
    job.prompt,
  ];
  return { command: codexCommand, args };
}

export function extractCodexOutput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  for (const candidate of [event.text, event.message, event.delta]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text) return record.text;
    if (typeof record.message === 'string' && record.message) return record.message;
  }
  return typeof event.type === 'string' ? event.type : undefined;
}

function shellJobCommand(job: FleetJob): string {
  const command = job.command?.trim() || job.prompt.trim();
  if (!command) throw new Error('Shell job requires a command.');
  return command;
}
