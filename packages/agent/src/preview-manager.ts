import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AgentToCoreMessage, ProjectPreview, ProjectPreviewHealth, ProjectPreviewLog } from '@fleet/shared';
import { shellInvocation } from './process-utils.js';
import { configureTailscaleWebProxy, disableTailscaleWebProxy } from './tailscale.js';

type SendMessage = (message: AgentToCoreMessage) => void;
type PreviewChild = ChildProcessByStdio<null, Readable, Readable>;

export interface PreviewStartInput {
  projectId: string;
  projectName: string;
  cwd: string;
  configuredCommand?: string;
  port?: number;
  servePort: number;
  visibility: ProjectPreview['visibility'];
  autoStartWithCodex: boolean;
  stopAfterMinutes?: number;
}

export interface PreviewInvocation {
  command: string;
  args: string[];
  display: string;
  framework: string;
  defaultPort: number;
  env?: NodeJS.ProcessEnv;
}

interface RunningPreview {
  preview: ProjectPreview;
  invocation: PreviewInvocation;
  child?: PreviewChild;
  stopping: boolean;
  ready: boolean;
  restartTimer?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
}

interface TailscalePreviewAdapter {
  configure(input: { visibility: ProjectPreview['visibility']; servePort: number; targetPort: number }): Promise<{
    url: string;
    dnsName: string;
    transport?: ProjectPreview['transport'];
    warning?: string;
  }>;
  disable(input: { visibility: ProjectPreview['visibility']; servePort: number }): Promise<void>;
}

const MAX_LOGS = 250;
const MAX_LOG_TEXT = 8_192;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_FAILURE_THRESHOLD = 3;
const PORT_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{2,5}))?/i;

export class PreviewManager {
  private readonly previews = new Map<string, RunningPreview>();

  constructor(
    private readonly deviceId: string,
    private readonly send: SendMessage,
    private readonly configuredShell?: string,
    private readonly tailscale: TailscalePreviewAdapter = {
      configure: configureTailscaleWebProxy,
      disable: disableTailscaleWebProxy,
    },
    private readonly onStart: () => void = () => {},
    private readonly onStop: () => void = () => {},
  ) {}

  async start(input: PreviewStartInput): Promise<ProjectPreview> {
    if (this.previews.has(input.projectId)) await this.stop(input.projectId);
    const invocation = await detectPreviewInvocation(input.cwd, input.configuredCommand, this.configuredShell);
    const preferredPort = input.port ?? invocation.defaultPort;
    const existingServer = await responds(preferredPort);
    const port = existingServer ? preferredPort : input.port ?? await availablePort(invocation.defaultPort);
    const now = new Date().toISOString();
    const preview: ProjectPreview = {
      projectId: input.projectId,
      deviceId: this.deviceId,
      cwd: input.cwd,
      status: 'starting',
      visibility: input.visibility,
      framework: invocation.framework,
      command: invocation.display,
      port,
      servePort: input.servePort,
      desiredState: 'running',
      autoStartWithCodex: input.autoStartWithCodex,
      stopAfterMinutes: input.stopAfterMinutes,
      restartCount: 0,
      updatedAt: now,
      lastActivityAt: now,
      health: {
        state: 'starting',
        checkedAt: now,
        consecutiveFailures: 0,
        detail: 'Waiting for the development server to answer HTTP checks.',
      },
      logs: [],
    };
    const running: RunningPreview = { preview, invocation, stopping: false, ready: false };
    this.previews.set(input.projectId, running);
    this.onStart();
    this.log(running, 'system', `Starting ${invocation.framework} preview for ${input.projectName} on port ${port}.`);
    this.emit(running);

    try {
      if (!existingServer) this.launch(running);
      else this.log(running, 'system', `Using an existing development server on port ${port}.`);
      const initialHealth = await waitForHttp(running, 60_000);
      const endpoint = await this.tailscale.configure({
        visibility: preview.visibility,
        servePort: preview.servePort,
        targetPort: preview.port,
      });
      preview.url = endpoint.url;
      preview.tailscaleDnsName = endpoint.dnsName;
      preview.transport = endpoint.transport;
      preview.status = 'running';
      preview.startedAt = new Date().toISOString();
      preview.updatedAt = preview.startedAt;
      preview.lastHealthyAt = initialHealth.checkedAt;
      preview.health = initialHealth;
      running.ready = true;
      this.startHealthMonitor(running);
      if (endpoint.warning) this.log(running, 'system', endpoint.warning);
      const endpointName = preview.transport === 'direct-tailnet'
        ? 'Private direct tailnet endpoint'
        : preview.visibility === 'public' ? 'Public Funnel' : 'Private Tailscale Serve';
      this.log(running, 'system', `${endpointName} available at ${preview.url}`);
      this.emit(running);
      return clonePreview(preview);
    } catch (error) {
      running.stopping = true;
      if (running.healthTimer) clearInterval(running.healthTimer);
      terminate(running.child, 'SIGTERM');
      preview.status = 'error';
      preview.error = error instanceof Error ? error.message : String(error);
      preview.updatedAt = new Date().toISOString();
      this.log(running, 'stderr', preview.error);
      this.emit(running);
      this.previews.delete(input.projectId);
      this.onStop();
      throw error;
    }
  }

  async stop(projectId: string): Promise<ProjectPreview> {
    const running = this.previews.get(projectId);
    if (!running) throw new Error(`Unknown project preview: ${projectId}`);
    running.stopping = true;
    if (running.restartTimer) clearTimeout(running.restartTimer);
    if (running.healthTimer) clearInterval(running.healthTimer);
    terminate(running.child, 'SIGTERM');
    try {
      await this.tailscale.disable({ visibility: running.preview.visibility, servePort: running.preview.servePort });
    } catch (error) {
      this.log(running, 'stderr', `Preview endpoint cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    running.preview.status = 'stopped';
    running.preview.desiredState = 'stopped';
    running.preview.health = {
      state: 'unknown',
      checkedAt: new Date().toISOString(),
      consecutiveFailures: 0,
      detail: 'Preview was stopped by policy or an operator.',
    };
    running.preview.updatedAt = new Date().toISOString();
    this.log(running, 'system', 'Shared preview stopped.');
    this.emit(running);
    this.previews.delete(projectId);
    this.onStop();
    return clonePreview(running.preview);
  }

  async shutdown(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const running of this.previews.values()) {
      running.stopping = true;
      if (running.restartTimer) clearTimeout(running.restartTimer);
      if (running.healthTimer) clearInterval(running.healthTimer);
      terminate(running.child, 'SIGTERM');
      cleanup.push(this.tailscale.disable({
        visibility: running.preview.visibility,
        servePort: running.preview.servePort,
      }).catch(() => undefined));
      this.onStop();
    }
    this.previews.clear();
    await Promise.all(cleanup);
  }

  private launch(running: RunningPreview): void {
    const child = spawn(running.invocation.command, running.invocation.args.map((argument) => argument === '$PORT' ? String(running.preview.port) : argument), {
      cwd: running.preview.cwd,
      env: {
        ...process.env,
        ...running.invocation.env,
        HOST: '127.0.0.1',
        PORT: String(running.preview.port),
        BROWSER: 'none',
        NO_COLOR: '1',
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.handleOutput(running, 'stdout', chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => this.handleOutput(running, 'stderr', chunk.toString()));
    child.once('error', (error) => this.handleExit(running, error.message));
    child.once('close', (exitCode, signal) => {
      const detail = exitCode === null ? `signal ${signal ?? 'unknown'}` : `code ${exitCode}`;
      this.handleExit(running, `Development server exited with ${detail}.`);
    });
  }

  private handleOutput(running: RunningPreview, stream: 'stdout' | 'stderr', text: string): void {
    if (!text) return;
    const match = text.match(PORT_PATTERN);
    const discovered = match?.[1] ? Number(match[1]) : undefined;
    if (discovered && discovered > 0 && discovered <= 65_535 && !running.ready) running.preview.port = discovered;
    this.log(running, stream, text);
    this.emit(running);
  }

  private handleExit(running: RunningPreview, detail: string): void {
    if (running.stopping || running.restartTimer) return;
    terminate(running.child, 'SIGTERM');
    running.child = undefined;
    if (!running.ready) {
      running.preview.error = detail;
      this.log(running, 'stderr', detail);
      return;
    }
    running.preview.status = 'restarting';
    running.preview.error = detail;
    running.preview.health = {
      state: 'unreachable',
      checkedAt: new Date().toISOString(),
      consecutiveFailures: Math.max(HEALTH_FAILURE_THRESHOLD, running.preview.health?.consecutiveFailures ?? 0),
      detail,
    };
    running.preview.restartCount += 1;
    running.preview.updatedAt = new Date().toISOString();
    this.log(running, 'stderr', `${detail} Restarting automatically.`);
    this.emit(running);
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(running.preview.restartCount - 1, 4));
    running.restartTimer = setTimeout(() => {
      running.restartTimer = undefined;
      if (running.stopping) return;
      this.launch(running);
      void waitForHttp(running, 45_000).then((health) => {
        running.preview.status = 'running';
        running.preview.error = undefined;
        running.preview.health = health;
        running.preview.lastHealthyAt = health.checkedAt;
        running.preview.updatedAt = new Date().toISOString();
        this.log(running, 'system', 'Development server restarted.');
        this.emit(running);
      }).catch((error) => this.handleExit(running, error instanceof Error ? error.message : String(error)));
    }, delay);
    running.restartTimer.unref();
  }

  private startHealthMonitor(running: RunningPreview): void {
    if (running.healthTimer) clearInterval(running.healthTimer);
    running.healthTimer = setInterval(() => void this.checkHealth(running), HEALTH_CHECK_INTERVAL_MS);
    running.healthTimer.unref();
  }

  private async checkHealth(running: RunningPreview): Promise<void> {
    if (running.stopping || ['starting', 'restarting', 'stopped'].includes(running.preview.status)) return;
    const result = await probeHttp(running.preview.port);
    const previousFailures = running.preview.health?.consecutiveFailures ?? 0;
    if (result.healthy) {
      const recovered = previousFailures > 0;
      running.preview.health = healthyProjectPreview(result);
      running.preview.lastHealthyAt = running.preview.health.checkedAt;
      running.preview.error = undefined;
      if (recovered) this.log(running, 'system', 'Preview HTTP health recovered.');
      this.emit(running);
      return;
    }

    const failures = previousFailures + 1;
    running.preview.health = {
      state: failures >= HEALTH_FAILURE_THRESHOLD ? 'unreachable' : 'degraded',
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      consecutiveFailures: failures,
      detail: result.detail,
    };
    running.preview.updatedAt = result.checkedAt;
    if (failures < HEALTH_FAILURE_THRESHOLD) {
      this.emit(running);
      return;
    }

    const detail = `Preview failed ${failures} consecutive HTTP health checks: ${result.detail}`;
    this.log(running, 'stderr', detail);
    if (running.child) {
      terminate(running.child, 'SIGTERM');
      return;
    }
    this.handleExit(running, detail);
  }

  private log(running: RunningPreview, stream: ProjectPreviewLog['stream'], text: string): void {
    const normalized = text.trimEnd().slice(0, MAX_LOG_TEXT);
    if (!normalized) return;
    running.preview.logs.push({ id: randomUUID(), at: new Date().toISOString(), stream, text: normalized });
    if (running.preview.logs.length > MAX_LOGS) running.preview.logs.splice(0, running.preview.logs.length - MAX_LOGS);
    running.preview.updatedAt = new Date().toISOString();
  }

  private emit(running: RunningPreview): void {
    this.send({ type: 'preview.updated', payload: { projectId: running.preview.projectId, preview: clonePreview(running.preview) } });
  }
}

export async function detectPreviewInvocation(cwd: string, configuredCommand?: string, configuredShell?: string): Promise<PreviewInvocation> {
  let packageDocument: Record<string, unknown> = {};
  try { packageDocument = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) {
    if (!configuredCommand) throw new Error(`No package.json or configured start command was found in ${cwd}.`);
  }
  const dependencies = {
    ...record(packageDocument.dependencies),
    ...record(packageDocument.devDependencies),
  };
  const scripts = record(packageDocument.scripts);
  const framework = detectFramework(dependencies);
  const defaultPort = framework === 'Vite' ? 5173 : framework === 'Astro' ? 4321 : framework === 'Angular' ? 4200 : 3000;
  if (configuredCommand) {
    const invocation = shellInvocation(configuredCommand, configuredShell);
    return { command: invocation.shell, args: invocation.args, display: configuredCommand, framework, defaultPort };
  }
  const script = typeof scripts.dev === 'string' ? 'dev' : typeof scripts.start === 'string' ? 'start' : undefined;
  if (!script) throw new Error('The project has no dev or start script. Configure a project start command first.');
  const manager = await packageManager(cwd);
  const args = manager === 'npm' ? ['run', script] : ['run', script];
  const flags = previewFlags(framework);
  if (flags.length) {
    if (manager === 'npm' || manager === 'pnpm' || manager === 'bun') args.push('--');
    args.push(...flags);
  }
  return {
    command: manager,
    args,
    display: `${manager} ${args.join(' ')}`,
    framework,
    defaultPort,
  };
}

function detectFramework(dependencies: Record<string, unknown>): string {
  if ('next' in dependencies) return 'Next.js';
  if ('astro' in dependencies) return 'Astro';
  if ('@remix-run/dev' in dependencies) return 'Remix';
  if ('nuxt' in dependencies) return 'Nuxt';
  if ('@sveltejs/kit' in dependencies) return 'SvelteKit';
  if ('@angular/core' in dependencies) return 'Angular';
  if ('vite' in dependencies) return 'Vite';
  return 'Web app';
}

function previewFlags(framework: string): string[] {
  if (framework === 'Next.js') return ['-H', '127.0.0.1', '-p', '$PORT'];
  if (['Vite', 'Astro', 'Remix', 'Nuxt', 'SvelteKit'].includes(framework)) return ['--host', '127.0.0.1', '--port', '$PORT'];
  if (framework === 'Angular') return ['--host', '127.0.0.1', '--port', '$PORT'];
  return [];
}

async function packageManager(cwd: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']] as const) {
    try { await readFile(path.join(cwd, file)); return manager; } catch { /* Try the next lockfile. */ }
  }
  return 'npm';
}

async function availablePort(preferred: number): Promise<number> {
  if (await canListen(preferred)) return preferred;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a preview port.')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function responds(port: number): Promise<boolean> {
  return (await probeHttp(port)).healthy;
}

async function waitForHttp(running: RunningPreview, timeoutMs: number): Promise<ProjectPreviewHealth> {
  const deadline = Date.now() + timeoutMs;
  while (!running.stopping && Date.now() < deadline) {
    if (running.preview.error && !running.child) throw new Error(running.preview.error);
    const result = await probeHttp(running.preview.port);
    if (result.healthy) return healthyProjectPreview(result);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Development server did not become reachable on port ${running.preview.port}.`);
}

interface HttpProbeResult {
  healthy: boolean;
  checkedAt: string;
  latencyMs: number;
  statusCode?: number;
  detail: string;
}

async function probeHttp(port: number): Promise<HttpProbeResult> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_500), redirect: 'manual' });
    const latencyMs = Date.now() - startedAt;
    const healthy = response.status > 0 && response.status < 500;
    return {
      healthy,
      checkedAt,
      latencyMs,
      statusCode: response.status,
      detail: healthy ? `HTTP ${response.status} in ${latencyMs} ms.` : `Development server returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      healthy: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function healthyProjectPreview(result: HttpProbeResult): ProjectPreviewHealth {
  return {
    state: 'healthy',
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode,
    consecutiveFailures: 0,
    detail: result.detail,
  };
}

function terminate(child: PreviewChild | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill(signal));
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clonePreview(preview: ProjectPreview): ProjectPreview {
  return { ...preview, logs: preview.logs.map((log) => ({ ...log })) };
}
