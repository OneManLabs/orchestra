import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexMicroVoiceState } from '@fleet/shared';

export interface NativeVoiceCaptureOptions {
  onState(state: CodexMicroVoiceState): void;
}

export class NativeVoiceCapture {
  readonly #options: NativeVoiceCaptureOptions;
  #process: ChildProcessWithoutNullStreams | null = null;
  #sessionId: string | null = null;
  #buffer = '';
  #state: CodexMicroVoiceState = { state: 'idle', sessionId: null };

  constructor(options: NativeVoiceCaptureOptions) { this.#options = options; }

  getState(): CodexMicroVoiceState { return this.#state; }

  async start(sessionId: string | null): Promise<CodexMicroVoiceState> {
    if (process.platform !== 'darwin') return this.#setState({ state: 'error', sessionId, code: 'unavailable', error: 'Native voice capture is only available on macOS.' });
    if (!sessionId) return this.#setState({ state: 'error', sessionId: null, code: 'unavailable', error: 'Open a Codex chat before starting voice capture.' });
    if (this.#process) return this.#state;
    const executable = join(__dirname, '../native/Codex Micro Voice.app/Contents/MacOS/Codex Micro Voice');
    try { await access(executable); }
    catch { return this.#setState({ state: 'error', sessionId, code: 'unavailable', error: 'The signed native voice helper is missing. Rebuild or reinstall Orchestra Canvas.' }); }

    this.#sessionId = sessionId;
    this.#buffer = '';
    this.#setState({ state: 'requesting-permission', sessionId });
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#consume(chunk));
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once('error', (error) => {
      if (this.#process !== child) return;
      this.#process = null;
      this.#setState({ state: 'error', sessionId, code: 'capture-failed', error: error.message });
    });
    child.once('exit', (code) => {
      if (this.#process !== child) return;
      this.#process = null;
      if (this.#state.state !== 'idle' && this.#state.state !== 'error') {
        this.#setState({ state: 'error', sessionId, code: 'capture-failed', error: stderr.trim() || `Voice helper exited before transcription completed (${code ?? 'signal'}).` });
      }
    });
    return this.#state;
  }

  async stop(): Promise<CodexMicroVoiceState> {
    const child = this.#process;
    if (!child) return this.#state;
    if (!child.stdin.destroyed) child.stdin.write('stop\n');
    return this.#setState({ state: 'transcribing', sessionId: this.#sessionId });
  }

  dispose(): void {
    const child = this.#process;
    this.#process = null;
    child?.kill('SIGTERM');
    this.#sessionId = null;
    this.#setState({ state: 'idle', sessionId: null });
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#consumeLine(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #consumeLine(line: string): void {
    try {
      const value = JSON.parse(line) as Partial<CodexMicroVoiceState>;
      if (!['idle', 'requesting-permission', 'listening', 'transcribing', 'error'].includes(String(value.state))) return;
      this.#setState({
        state: value.state!,
        sessionId: this.#sessionId,
        ...(typeof value.transcript === 'string' ? { transcript: value.transcript } : {}),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...(value.code ? { code: value.code } : {}),
      });
    } catch { /* Ignore non-protocol helper output. */ }
  }

  #setState(state: CodexMicroVoiceState): CodexMicroVoiceState {
    this.#state = state;
    this.#options.onState(state);
    return state;
  }
}
