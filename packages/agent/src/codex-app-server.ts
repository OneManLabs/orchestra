import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentToCoreMessage, CodexSession, CodexUiRpcMethod, PermissionMode } from '@fleet/shared';
import { AGENT_VERSION } from './constants.js';
import { JsonLineDecoder } from './json-lines.js';

type SendMessage = (message: AgentToCoreMessage) => void;
type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export type CodexLaunchMode =
  | { mode: 'start' }
  | { mode: 'resume'; threadId: string; path?: string }
  | { mode: 'fork'; threadId: string; lastTurnId?: string; path?: string };

export interface CodexLaunchResult {
  threadId: string;
  threadPath?: string;
  forkedFromThreadId?: string;
}

interface HandoffFile {
  path: string;
  sizeBytes: number;
  checksumSha256: string;
}

interface StagedHandoff extends HandoffFile {
  receivedBytes: number;
}

const MAX_HANDOFF_BYTES = 256 * 1024 * 1024;
const MAX_HANDOFF_CHUNK_BYTES = 1024 * 1024;
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024;
const GRACEFUL_TURN_INTERRUPT_MS = 1_500;
const PROCESS_EXIT_GRACE_MS = 3_000;

interface ActiveTurn {
  threadId: string;
  turnId: string;
}

export interface RolloutRepairResult {
  repairedCallIds: string[];
  backupPath?: string;
}

export class CodexAppServerSession {
  private child?: ChildProcessWithoutNullStreams;
  private decoder?: JsonLineDecoder;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private threadId?: string;
  private stopped = false;
  private exitSent = false;
  private activeTurn?: ActiveTurn;
  private stopPromise?: Promise<void>;
  private finalizationPromise?: Promise<void>;
  private finalizationError?: Error;
  private readonly turnIdleWaiters = new Set<() => void>();
  private transportError?: string;

  constructor(
    readonly session: CodexSession,
    private readonly codexCommand: string,
    private readonly send: SendMessage,
    private readonly codexHome: string,
    private readonly allowedRolloutRoots: readonly string[] = [codexHome],
    private readonly onExit?: () => void,
  ) {}

  async start(cwd: string, launch: CodexLaunchMode = { mode: 'start' }): Promise<CodexLaunchResult> {
    if (this.child) throw new Error(`Codex session already started: ${this.session.id}`);
    this.child = spawn(this.codexCommand, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.decoder = new JsonLineDecoder(
      (value) => this.handleMessage(value),
      (raw) => this.sendEvent({ method: 'fleet/protocolError', params: { message: 'Non-JSON output from Codex app-server', raw } }),
    );
    this.child.stdout.on('data', (chunk: Buffer) => this.decoder?.push(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) this.sendEvent({ method: 'fleet/stderr', params: { text } });
    });
    this.child.once('error', (error) => {
      this.transportError = error.message;
      // A failed spawn does not always emit close. At that point no process can
      // still be writing a rollout, so it is safe to finalize immediately.
      if (!this.child?.pid) void this.finalizeAfterExit(undefined, error.message);
    });
    this.child.once('close', (exitCode) => {
      this.decoder?.flush();
      void this.finalizeAfterExit(
        exitCode ?? undefined,
        this.stopped ? undefined : this.transportError ?? (exitCode === 0 ? undefined : `Codex app-server exited with code ${exitCode ?? 'unknown'}`),
      );
    });

    await this.request('initialize', {
      clientInfo: { name: 'fleet_canvas', title: 'Fleet Canvas', version: AGENT_VERSION },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    const model = typeof this.session.model === 'string' ? this.session.model.trim() : '';
    const configuration = {
      cwd,
      approvalPolicy: this.session.approvalPolicy,
      sandbox: sandboxFor(this.session.permissionMode),
      ...(model ? { model } : {}),
      ...(this.session.developerInstructions ? { developerInstructions: this.session.developerInstructions } : {}),
    };
    const method = launch.mode === 'start' ? 'thread/start' : launch.mode === 'resume' ? 'thread/resume' : 'thread/fork';
    const params = launch.mode === 'start'
      ? configuration
      : {
          threadId: launch.threadId,
          ...configuration,
          ...(launch.path ? { path: launch.path } : {}),
          ...(launch.mode === 'fork' && launch.lastTurnId ? { lastTurnId: launch.lastTurnId } : {}),
        };
    type ThreadLaunchResult = { thread?: { id?: string; path?: string | null; forkedFromId?: string | null } };
    let result: ThreadLaunchResult;
    try {
      result = await this.request(method, params) as ThreadLaunchResult;
    } catch (error) {
      // Codex may not persist a rollout until the first turn. In that narrow
      // case there is no conversation to recover, so transparently replace the
      // missing empty thread while keeping the Fleet session itself intact.
      if (launch.mode !== 'resume' || launch.path || hasCodexTurnHistory(this.session) || !isMissingCodexRolloutError(error)) throw error;
      result = await this.request('thread/start', configuration) as ThreadLaunchResult;
    }
    const threadId = result.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread ID.');
    this.threadId = threadId;
    const threadPath = typeof result.thread?.path === 'string' && result.thread.path ? result.thread.path : undefined;
    this.threadPath = threadPath;
    const forkedFromThreadId = typeof result.thread?.forkedFromId === 'string' ? result.thread.forkedFromId : undefined;
    this.sendEvent({ method: 'fleet/thread-context', params: { threadId, launchMode: launch.mode, ...(forkedFromThreadId ? { forkedFromThreadId } : {}) } });
    return { threadId, ...(threadPath ? { threadPath } : {}), ...(forkedFromThreadId ? { forkedFromThreadId } : {}) };
  }

  private threadPath?: string;

  currentLaunchResult(expectedThreadId?: string): CodexLaunchResult {
    if (!this.threadId) throw new Error('Codex session is not ready.');
    if (expectedThreadId && this.threadId !== expectedThreadId) {
      throw new Error(`Codex session ${this.session.id} is already attached to a different thread.`);
    }
    return {
      threadId: this.threadId,
      ...(this.threadPath ? { threadPath: this.threadPath } : {}),
    };
  }

  async getHandoffSource(): Promise<{ threadId: string; path: string }> {
    if (!this.threadId) throw new Error('Codex session is not ready.');
    if (!this.threadPath) {
      const result = await this.request('thread/read', { threadId: this.threadId, includeTurns: false }) as { thread?: { path?: string | null } };
      if (typeof result.thread?.path === 'string' && result.thread.path) this.threadPath = result.thread.path;
    }
    if (!this.threadPath) throw new Error('Codex did not provide a persisted rollout path for this session.');
    return { threadId: this.threadId, path: this.threadPath };
  }

  async sendTurn(text: string): Promise<{ threadId: string; turnId?: string }> {
    if (!this.threadId) throw new Error('Codex session is not ready.');
    if (!text.trim()) throw new Error('Codex message cannot be empty.');
    const result = await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }) as { turn?: { id?: string } };
    const turnId = result.turn?.id;
    if (turnId) this.setActiveTurn({ threadId: this.threadId, turnId });
    this.sendEvent({ method: 'fleet/turn-context', params: { threadId: this.threadId, ...(turnId ? { turnId } : {}) } });
    return { threadId: this.threadId, turnId };
  }

  rpc(method: CodexUiRpcMethod, params?: unknown): Promise<unknown> {
    if (!this.threadId) throw new Error('Codex session is not ready.');
    return this.request(method, params ?? {});
  }

  respond(requestId: JsonRpcId, result: unknown): void {
    this.write({ id: requestId, result });
  }

  async interrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.stopGracefully();
    return this.stopPromise;
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server transport is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleMessage(value: unknown): void {
    if (!isJsonRpcMessage(value)) {
      this.sendEvent({ method: 'fleet/protocolError', params: { message: 'Invalid message from Codex app-server', value } });
      return;
    }
    if (value.id !== undefined && value.method === undefined) {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(value.id);
        if (value.error) pending.reject(new Error(value.error.message ?? `Codex app-server error ${value.error.code ?? ''}`.trim()));
        else pending.resolve(value.result);
      }
    }
    this.updateActiveTurn(value);
    this.sendEvent(value as Record<string, unknown>);
  }

  private sendEvent(message: Record<string, unknown>): void {
    this.send({ type: 'codex.event', payload: { sessionId: this.session.id, message } });
  }

  private handleExit(exitCode?: number, error?: string): void {
    if (this.exitSent) return;
    this.exitSent = true;
    this.rejectPending(new Error(error ?? 'Codex app-server exited.'));
    this.send({ type: 'codex.exit', payload: { sessionId: this.session.id, exitCode, error } });
    this.onExit?.();
  }

  private async stopGracefully(): Promise<void> {
    const child = this.child;
    if (!child) return;

    // A rollout path can be null until the first turn is persisted. Resolve it
    // while the app-server is still alive so a later repair never has to guess.
    if (!this.threadPath && this.threadId && child.stdin.writable && child.exitCode === null && child.signalCode === null) {
      try {
        const result = await this.request('thread/read', { threadId: this.threadId, includeTurns: false }, 1_000) as { thread?: { path?: string | null } };
        if (typeof result.thread?.path === 'string' && result.thread.path) this.threadPath = result.thread.path;
      } catch { /* Best effort; an empty thread may not have a rollout yet. */ }
    }

    const active = this.activeTurn;
    if (active && child.stdin.writable && child.exitCode === null && child.signalCode === null) {
      try {
        await this.request('turn/interrupt', active, GRACEFUL_TURN_INTERRUPT_MS);
        await this.waitForTurnToBecomeIdle(GRACEFUL_TURN_INTERRUPT_MS);
      } catch { /* The post-exit repair below closes any interrupted tool call. */ }
    }

    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await this.waitForFinalization(PROCESS_EXIT_GRACE_MS);
    if (!this.finalizationPromise) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await this.waitForFinalization(PROCESS_EXIT_GRACE_MS);
    }
    if (!this.finalizationPromise) throw new Error('Codex app-server did not exit after being stopped.');
    await this.finalizationPromise;
    if (this.finalizationError) throw this.finalizationError;
  }

  private async waitForFinalization(timeoutMs: number): Promise<void> {
    if (this.finalizationPromise) {
      await this.finalizationPromise;
      return;
    }
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const check = (): void => {
        if (this.finalizationPromise || Date.now() - started >= timeoutMs) {
          resolve();
          return;
        }
        const timer = setTimeout(check, 20);
        timer.unref();
      };
      check();
    });
    if (this.finalizationPromise) await this.finalizationPromise;
  }

  private waitForTurnToBecomeIdle(timeoutMs: number): Promise<void> {
    if (!this.activeTurn) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.turnIdleWaiters.delete(done);
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      timeout.unref();
      this.turnIdleWaiters.add(done);
    });
  }

  private updateActiveTurn(message: JsonRpcMessage): void {
    if (typeof message.method !== 'string') return;
    const context = turnContextFromMessage(message);
    if (message.method === 'turn/started' && context) {
      this.setActiveTurn(context);
      return;
    }
    if (/^turn\/(?:completed|cancelled|canceled|failed|interrupted)$/.test(message.method)) {
      if (!context || !this.activeTurn || context.turnId === this.activeTurn.turnId) this.setActiveTurn(undefined);
    }
  }

  private setActiveTurn(active: ActiveTurn | undefined): void {
    this.activeTurn = active;
    if (active) return;
    for (const resolve of this.turnIdleWaiters) resolve();
    this.turnIdleWaiters.clear();
  }

  private finalizeAfterExit(exitCode?: number, error?: string): Promise<void> {
    if (this.finalizationPromise) return this.finalizationPromise;
    this.finalizationPromise = (async () => {
      this.setActiveTurn(undefined);
      this.rejectPending(new Error(error ?? 'Codex app-server exited.'));
      let effectiveError = error;
      if (this.threadId && this.threadPath) {
        try {
          const repair = await repairInterruptedCustomToolCalls(this.threadPath, this.threadId, this.allowedRolloutRoots);
          if (repair.repairedCallIds.length) {
            this.sendEvent({
              method: 'fleet/rolloutRepaired',
              params: { threadId: this.threadId, repairedCallIds: repair.repairedCallIds, backupPath: repair.backupPath },
            });
          }
        } catch (repairError) {
          const normalized = repairError instanceof Error ? repairError : new Error(String(repairError));
          this.finalizationError = normalized;
          effectiveError = effectiveError ? `${effectiveError}; rollout repair failed: ${normalized.message}` : `Rollout repair failed: ${normalized.message}`;
          this.sendEvent({ method: 'fleet/protocolError', params: { message: effectiveError } });
        }
      }
      this.handleExit(exitCode, effectiveError);
    })();
    return this.finalizationPromise;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function hasCodexTurnHistory(session: CodexSession): boolean {
  if (session.turnId || session.pendingApprovals.length) return true;
  return session.events.some((event) => {
    if (['user', 'assistant', 'reasoning', 'command', 'file', 'tool', 'plan', 'raw'].includes(event.type)) return true;
    const method = event.method?.toLowerCase() ?? '';
    return method === 'error' || method.startsWith('turn/') || method.startsWith('item/') || method.endsWith('/error');
  });
}

function isMissingCodexRolloutError(error: unknown): boolean {
  return error instanceof Error && /no rollout found for thread id/i.test(error.message);
}

function turnContextFromMessage(message: JsonRpcMessage): ActiveTurn | undefined {
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return undefined;
  const params = message.params as Record<string, unknown>;
  const turn = params.turn && typeof params.turn === 'object' && !Array.isArray(params.turn) ? params.turn as Record<string, unknown> : undefined;
  const threadId = typeof params.threadId === 'string' ? params.threadId : typeof params.thread_id === 'string' ? params.thread_id : undefined;
  const turnId = typeof turn?.id === 'string'
    ? turn.id
    : typeof params.turnId === 'string'
      ? params.turnId
      : typeof params.turn_id === 'string'
        ? params.turn_id
        : undefined;
  return threadId && turnId ? { threadId, turnId } : undefined;
}

interface ParsedRolloutLine {
  bytes: Buffer;
  callId?: string;
  outputCallId?: string;
}

interface ParsedRollout {
  lines: ParsedRolloutLine[];
  missingCallIds: Set<string>;
}

/**
 * Close custom tool calls left without a response when an app-server process
 * dies between persisting the call and persisting its tool result. This must be
 * called only after that process has exited; callers own that synchronization.
 */
export async function repairInterruptedCustomToolCalls(
  rolloutPath: string,
  expectedThreadId: string,
  allowedRoots: readonly string[],
): Promise<RolloutRepairResult> {
  if (!path.isAbsolute(rolloutPath) || path.extname(rolloutPath).toLowerCase() !== '.jsonl') {
    throw new Error('Codex rollout repair requires an absolute .jsonl path.');
  }
  if (!expectedThreadId.trim()) throw new Error('Codex rollout repair requires a thread ID.');
  await assertRolloutPathConfined(rolloutPath, allowedRoots);

  const sourceLink = await lstat(rolloutPath);
  if (sourceLink.isSymbolicLink() || !sourceLink.isFile()) throw new Error('Codex rollout repair requires a non-symlink regular file.');
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const sourceHandle = await open(rolloutPath, fsConstants.O_RDONLY | noFollow);
  let source: Buffer;
  let opened: Awaited<ReturnType<typeof sourceHandle.stat>>;
  try {
    opened = await sourceHandle.stat();
    if (!opened.isFile() || (sourceLink.ino && opened.ino && (sourceLink.ino !== opened.ino || sourceLink.dev !== opened.dev))) {
      throw new Error('Codex rollout changed while it was being opened for repair.');
    }
    validateHandoffSize(opened.size);
    source = await sourceHandle.readFile();
    const afterRead = await sourceHandle.stat();
    if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
      throw new Error('Codex rollout changed while it was being inspected for repair.');
    }
  } finally {
    await sourceHandle.close();
  }

  const parsed = parseRollout(source, expectedThreadId);
  if (!parsed.missingCallIds.size) return { repairedCallIds: [] };

  const repairedCallIds = [...parsed.missingCallIds];
  const inserted = new Set<string>();
  const repairedChunks: Buffer[] = [];
  for (const line of parsed.lines) {
    repairedChunks.push(line.bytes);
    if (!line.callId || !parsed.missingCallIds.has(line.callId) || inserted.has(line.callId)) continue;
    if (!line.bytes.length || line.bytes[line.bytes.length - 1] !== 0x0a) repairedChunks.push(Buffer.from('\n'));
    repairedChunks.push(Buffer.from(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: line.callId, output: 'aborted' },
    })}\n`, 'utf8'));
    inserted.add(line.callId);
  }
  const repaired = Buffer.concat(repairedChunks);
  const validation = parseRollout(repaired, expectedThreadId);
  if (validation.missingCallIds.size) throw new Error('Codex rollout repair did not close every interrupted custom tool call.');

  const directory = path.dirname(rolloutPath);
  const basename = path.basename(rolloutPath);
  const marker = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = path.join(directory, `${basename}.fleet-backup-${marker}.bak`);
  const backupTempPath = path.join(directory, `.${basename}.${marker}.backup.tmp`);
  const repairTempPath = path.join(directory, `.${basename}.${marker}.repair.tmp`);
  let backupCommitted = false;
  try {
    await writeDurableFile(backupTempPath, source, opened.mode & 0o777);
    await rename(backupTempPath, backupPath);
    backupCommitted = true;
    await syncDirectory(directory);

    await writeDurableFile(repairTempPath, repaired, opened.mode & 0o777);
    const beforeReplace = await lstat(rolloutPath);
    if (beforeReplace.isSymbolicLink()
      || beforeReplace.size !== opened.size
      || beforeReplace.mtimeMs !== opened.mtimeMs
      || (opened.ino && beforeReplace.ino && (opened.ino !== beforeReplace.ino || opened.dev !== beforeReplace.dev))) {
      throw new Error('Codex rollout changed before the atomic repair could be installed.');
    }
    await rename(repairTempPath, rolloutPath);
    await syncDirectory(directory);
    return { repairedCallIds, backupPath };
  } catch (error) {
    await Promise.all([rm(backupTempPath, { force: true }), rm(repairTempPath, { force: true })]);
    if (!backupCommitted) await rm(backupPath, { force: true });
    throw error;
  }
}

function parseRollout(contents: Buffer, expectedThreadId: string): ParsedRollout {
  const lines: ParsedRolloutLine[] = [];
  const calls = new Set<string>();
  const outputs = new Set<string>();
  let lineStart = 0;
  while (lineStart < contents.length) {
    const newline = contents.indexOf(0x0a, lineStart);
    const lineEnd = newline >= 0 ? newline + 1 : contents.length;
    const bytes = contents.subarray(lineStart, lineEnd);
    const jsonEnd = newline >= 0 ? newline : lineEnd;
    const carriageReturn = jsonEnd > lineStart && contents[jsonEnd - 1] === 0x0d ? 1 : 0;
    const text = contents.subarray(lineStart, jsonEnd - carriageReturn).toString('utf8');
    if (!text.trim()) throw new Error('Codex rollout contains an empty JSONL record.');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('Codex rollout contains invalid JSON and was not repaired.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex rollout contains an invalid record and was not repaired.');
    const record = value as Record<string, unknown>;
    if (!lines.length) validateRolloutMetadata(text, expectedThreadId);
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown>
      : undefined;
    let callId: string | undefined;
    let outputCallId: string | undefined;
    if (record.type === 'response_item' && payload?.type === 'custom_tool_call' && typeof payload.call_id === 'string' && payload.call_id) {
      callId = payload.call_id;
      calls.add(callId);
    } else if (record.type === 'response_item' && payload?.type === 'custom_tool_call_output' && typeof payload.call_id === 'string' && payload.call_id) {
      outputCallId = payload.call_id;
      outputs.add(outputCallId);
    }
    lines.push({ bytes, ...(callId ? { callId } : {}), ...(outputCallId ? { outputCallId } : {}) });
    lineStart = lineEnd;
  }
  if (!lines.length) throw new Error('Codex rollout is empty.');
  return { lines, missingCallIds: new Set([...calls].filter((callId) => !outputs.has(callId))) };
}

async function assertRolloutPathConfined(rolloutPath: string, allowedRoots: readonly string[]): Promise<void> {
  const resolvedRollout = await realpath(rolloutPath);
  for (const root of allowedRoots) {
    try {
      const resolvedRoot = await realpath(root);
      const relative = path.relative(resolvedRoot, resolvedRollout);
      if ((!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) && !path.isAbsolute(relative)) return;
    } catch { /* An absent/inaccessible root cannot authorize the path. */ }
  }
  throw new Error('Codex rollout repair path is outside the configured Codex data directory.');
}

async function writeDurableFile(filePath: string, contents: Buffer, mode: number): Promise<void> {
  const handle = await open(filePath, 'wx', mode || 0o600);
  try {
    await writeAll(handle, contents, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* Directory fsync is unavailable on some platforms/filesystems. */ }
}

export class CodexSessionManager {
  private readonly sessions = new Map<string, CodexAppServerSession>();
  private readonly exports = new Map<string, HandoffFile>();
  private readonly imports = new Map<string, StagedHandoff>();
  private readonly handoffDirectory: string;
  private readonly codexDataDirectory: string;

  constructor(private readonly codexCommand: string, private readonly send: SendMessage, dataDir: string, codexDataDirectory = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')) {
    this.handoffDirectory = path.join(dataDir, 'codex-handoffs');
    this.codexDataDirectory = path.resolve(codexDataDirectory);
  }

  start(session: CodexSession, cwd: string): Promise<CodexLaunchResult> {
    return this.launch(session, cwd, { mode: 'start' });
  }

  resume(session: CodexSession, cwd: string, threadId: string): Promise<CodexLaunchResult> {
    const existing = this.sessions.get(session.id);
    if (existing) return Promise.resolve(existing.currentLaunchResult(threadId));
    return this.launch(session, cwd, { mode: 'resume', threadId });
  }

  fork(session: CodexSession, cwd: string, threadId: string, lastTurnId?: string): Promise<CodexLaunchResult> {
    return this.launch(session, cwd, { mode: 'fork', threadId, ...(lastTurnId ? { lastTurnId } : {}) });
  }

  rpc(sessionId: string, method: CodexUiRpcMethod, params?: unknown): Promise<unknown> {
    return this.get(sessionId).rpc(method, params);
  }

  private async launch(session: CodexSession, cwd: string, mode: CodexLaunchMode): Promise<CodexLaunchResult> {
    if (this.sessions.has(session.id)) throw new Error(`Codex session already exists: ${session.id}`);
    let appServer: CodexAppServerSession;
    appServer = new CodexAppServerSession(session, this.codexCommand, this.send, this.codexDataDirectory, [this.codexDataDirectory, this.handoffDirectory], () => {
      if (this.sessions.get(session.id) === appServer) this.sessions.delete(session.id);
    });
    this.sessions.set(session.id, appServer);
    try {
      return await appServer.start(cwd, mode);
    } catch (error) {
      await appServer.stop();
      this.sessions.delete(session.id);
      throw error;
    }
  }

  sendTurn(sessionId: string, text: string): Promise<{ threadId: string; turnId?: string }> {
    return this.get(sessionId).sendTurn(text);
  }

  respond(sessionId: string, requestId: JsonRpcId, result: unknown): void {
    this.get(sessionId).respond(requestId, result);
  }

  interrupt(sessionId: string, threadId: string, turnId: string): Promise<unknown> {
    return this.get(sessionId).interrupt(threadId, turnId);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.stop();
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
  }

  async prepareHandoff(sessionId: string): Promise<{ handoffId: string; threadId: string; sizeBytes: number; checksumSha256: string }> {
    const source = await this.get(sessionId).getHandoffSource();
    if (!path.isAbsolute(source.path) || path.extname(source.path).toLowerCase() !== '.jsonl') throw new Error('Codex rollout path must be an absolute .jsonl file.');
    await mkdir(this.handoffDirectory, { recursive: true, mode: 0o700 });
    await this.assertAllowedRolloutPath(source.path);
    const handoffId = randomUUID();
    const snapshotPath = path.join(this.handoffDirectory, `${randomUUID()}.export.jsonl`);
    const sourceLink = await lstat(source.path);
    if (sourceLink.isSymbolicLink() || !sourceLink.isFile()) throw new Error('Codex rollout must be a non-symlink regular file.');
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const sourceHandle = await open(source.path, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = await sourceHandle.stat();
      if (!opened.isFile() || (sourceLink.ino && opened.ino && (sourceLink.ino !== opened.ino || sourceLink.dev !== opened.dev))) throw new Error('Codex rollout changed while it was being opened.');
      validateHandoffSize(opened.size);
      const snapshotHandle = await open(snapshotPath, 'wx', 0o600);
      const digest = createHash('sha256');
      let copiedBytes = 0;
      let metadataBytes = Buffer.alloc(0);
      let metadataValidated = false;
      const buffer = Buffer.alloc(MAX_HANDOFF_CHUNK_BYTES);
      try {
        while (copiedBytes < opened.size) {
          const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, opened.size - copiedBytes), copiedBytes);
          if (!bytesRead) throw new Error('Codex rollout ended before its declared size.');
          const chunk = buffer.subarray(0, bytesRead);
          if (!metadataValidated) {
            const newline = chunk.indexOf(0x0a);
            const metadataChunk = newline >= 0 ? chunk.subarray(0, newline) : chunk;
            if (metadataBytes.length + metadataChunk.length > MAX_SESSION_META_BYTES) throw new Error('Codex rollout session metadata is unreasonably large.');
            metadataBytes = Buffer.concat([metadataBytes, metadataChunk]);
            if (newline >= 0) {
              validateRolloutMetadata(metadataBytes.toString('utf8'), source.threadId);
              metadataValidated = true;
            }
          }
          await writeAll(snapshotHandle, chunk, copiedBytes);
          digest.update(chunk);
          copiedBytes += bytesRead;
        }
        if (!metadataValidated) validateRolloutMetadata(metadataBytes.toString('utf8'), source.threadId);
        await snapshotHandle.sync();
      } finally { await snapshotHandle.close(); }
      const after = await sourceHandle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('Codex rollout changed during handoff preparation; retry while the session is idle.');
      const checksumSha256 = digest.digest('hex');
      this.exports.set(handoffId, { path: snapshotPath, sizeBytes: copiedBytes, checksumSha256 });
      return { handoffId, threadId: source.threadId, sizeBytes: copiedBytes, checksumSha256 };
    } catch (error) {
      await rm(snapshotPath, { force: true });
      throw error;
    } finally { await sourceHandle.close(); }
  }

  async readHandoff(handoffId: string, offset: number, length: number): Promise<{ dataBase64: string; bytesRead: number }> {
    const item = this.exports.get(handoffId);
    if (!item) throw new Error(`Unknown Codex handoff: ${handoffId}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.sizeBytes) throw new Error('Invalid Codex handoff read offset.');
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_HANDOFF_CHUNK_BYTES) throw new Error(`Codex handoff chunks must be between 1 and ${MAX_HANDOFF_CHUNK_BYTES} bytes.`);
    const bytesToRead = Math.min(length, item.sizeBytes - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await open(item.path, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      return { dataBase64: buffer.subarray(0, bytesRead).toString('base64'), bytesRead };
    } finally { await handle.close(); }
  }

  async beginHandoff(handoffId: string, sizeBytes: number, checksumSha256: string): Promise<{ handoffId: string }> {
    if (this.imports.has(handoffId) || this.exports.has(handoffId)) throw new Error(`Codex handoff already exists: ${handoffId}`);
    validateHandoffSize(sizeBytes);
    if (!/^[a-f0-9]{64}$/i.test(checksumSha256)) throw new Error('Codex handoff checksum must be SHA-256.');
    await mkdir(this.handoffDirectory, { recursive: true, mode: 0o700 });
    const stagedPath = path.join(this.handoffDirectory, `${randomUUID()}.part`);
    const handle = await open(stagedPath, 'wx', 0o600);
    await handle.close();
    this.imports.set(handoffId, { path: stagedPath, sizeBytes, checksumSha256: checksumSha256.toLowerCase(), receivedBytes: 0 });
    return { handoffId };
  }

  async writeHandoff(handoffId: string, offset: number, dataBase64: string): Promise<{ receivedBytes: number }> {
    const item = this.imports.get(handoffId);
    if (!item) throw new Error(`Unknown Codex handoff: ${handoffId}`);
    if (offset !== item.receivedBytes) throw new Error(`Codex handoff write must resume at byte ${item.receivedBytes}.`);
    if (!isCanonicalBase64(dataBase64)) throw new Error('Codex handoff chunk is not valid base64.');
    const data = Buffer.from(dataBase64, 'base64');
    if (!data.length || data.length > MAX_HANDOFF_CHUNK_BYTES) throw new Error(`Codex handoff chunks must be between 1 and ${MAX_HANDOFF_CHUNK_BYTES} bytes.`);
    if (item.receivedBytes + data.length > item.sizeBytes) throw new Error('Codex handoff exceeds its declared size.');
    const handle = await open(item.path, 'r+');
    try {
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('Unable to write Codex handoff chunk.');
        written += result.bytesWritten;
      }
    } finally { await handle.close(); }
    item.receivedBytes += data.length;
    return { receivedBytes: item.receivedBytes };
  }

  async finishHandoff(input: {
    handoffId: string;
    session: CodexSession;
    cwd: string;
    sourceThreadId: string;
    mode: 'resume' | 'fork';
    lastTurnId?: string;
  }): Promise<CodexLaunchResult> {
    const item = this.imports.get(input.handoffId);
    if (!item) throw new Error(`Unknown Codex handoff: ${input.handoffId}`);
    if (item.receivedBytes !== item.sizeBytes) throw new Error(`Codex handoff is incomplete (${item.receivedBytes}/${item.sizeBytes} bytes).`);
    const actualChecksum = await sha256File(item.path);
    if (actualChecksum !== item.checksumSha256) throw new Error('Codex handoff checksum verification failed.');
    await validateRolloutFile(item.path, input.sourceThreadId);
    const rolloutPath = item.path.replace(/\.part$/, '.jsonl');
    await rename(item.path, rolloutPath);
    this.imports.delete(input.handoffId);
    try {
      const result = await this.launch(input.session, input.cwd, input.mode === 'resume'
        ? { mode: 'resume', threadId: input.sourceThreadId, path: rolloutPath }
        : { mode: 'fork', threadId: input.sourceThreadId, path: rolloutPath, ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}) });
      if (input.mode === 'fork' || (result.threadPath && path.resolve(result.threadPath) !== path.resolve(rolloutPath))) void rm(rolloutPath, { force: true });
      return result;
    } catch (error) {
      await rm(rolloutPath, { force: true });
      throw error;
    }
  }

  async discardHandoff(handoffId: string): Promise<void> {
    const item = this.imports.get(handoffId) ?? this.exports.get(handoffId);
    this.imports.delete(handoffId);
    this.exports.delete(handoffId);
    if (item) await rm(item.path, { force: true });
  }

  private async assertAllowedRolloutPath(sourcePath: string): Promise<void> {
    const resolvedSource = await realpath(sourcePath);
    for (const root of [this.codexDataDirectory, this.handoffDirectory]) {
      try {
        const resolvedRoot = await realpath(root);
        const relative = path.relative(resolvedRoot, resolvedSource);
        if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) return;
      } catch { /* root is absent or inaccessible */ }
    }
    throw new Error('Codex rollout path is outside the configured Codex data directory.');
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
    await Promise.all([...this.imports.values(), ...this.exports.values()].map((item) => rm(item.path, { force: true })));
    this.imports.clear();
    this.exports.clear();
  }

  private get(sessionId: string): CodexAppServerSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Codex session: ${sessionId}`);
    return session;
  }
}

function validateHandoffSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_HANDOFF_BYTES) {
    throw new Error(`Codex handoff must be between 1 byte and ${MAX_HANDOFF_BYTES} bytes.`);
  }
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length > Math.ceil(MAX_HANDOFF_CHUNK_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { return Buffer.from(value, 'base64').toString('base64') === value; } catch { return false; }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  const handle = await open(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  return digest.digest('hex');
}

async function validateRolloutFile(filePath: string, expectedThreadId: string): Promise<void> {
  const handle = await open(filePath, 'r');
  const buffer = Buffer.alloc(MAX_SESSION_META_BYTES + 1);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead === buffer.length) throw new Error('Codex rollout session metadata is unreasonably large.');
    validateRolloutMetadata(buffer.subarray(0, newline >= 0 ? newline : bytesRead).toString('utf8'), expectedThreadId);
  } finally { await handle.close(); }
}

function validateRolloutMetadata(line: string, expectedThreadId: string): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('Codex rollout does not begin with valid session metadata.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex rollout does not begin with valid session metadata.');
  const record = value as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : undefined;
  if (record.type !== 'session_meta' || payload?.id !== expectedThreadId) throw new Error('Codex rollout session metadata does not match the active thread.');
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Unable to write Codex rollout snapshot.');
    written += result.bytesWritten;
  }
}

function sandboxFor(permission: PermissionMode): PermissionMode {
  return permission;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as JsonRpcMessage;
  return message.id !== undefined || typeof message.method === 'string';
}
