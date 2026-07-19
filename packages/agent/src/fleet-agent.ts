import type { AgentRegistration, AgentToCoreMessage, CoreToAgentCommand, DeviceMetrics } from '@fleet/shared';
import WebSocket, { type RawData } from 'ws';
import { detectCapabilities } from './capabilities.js';
import { buildAgentWebSocketUrl, resolveOptions, type FleetAgentOptions, type ResolvedFleetAgentOptions } from './config.js';
import { AGENT_VERSION, PROTOCOL_VERSION } from './constants.js';
import { CodexSessionManager } from './codex-app-server.js';
import { resolveAgentCredential } from './credential-store.js';
import { getOrCreateDeviceId } from './device-id.js';
import { DiagnosticRunner } from './diagnostics.js';
import { FleetFileManager } from './file-manager.js';
import { JobManager } from './job-manager.js';
import { PowerController } from './power-controller.js';
import { PreviewManager } from './preview-manager.js';
import { RemoteDesktopManager } from './remote-desktop.js';
import { resolveAllowedDirectory } from './security.js';
import { SleepInhibitor } from './sleep-inhibitor.js';
import { collectMetrics, getHostInformation } from './telemetry.js';
import { terminalCapabilityLabels, TerminalManager } from './terminal-manager.js';
import { UpdateManager } from './update-manager.js';

export class FleetAgent {
  readonly deviceId: string;
  readonly registration: AgentRegistration;

  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private started = false;
  private stopped = false;
  private metricsInFlight = false;
  private lastMetrics: DeviceMetrics;
  private readonly terminals: TerminalManager;
  private readonly codex: CodexSessionManager;
  private readonly jobs: JobManager;
  private readonly files: FleetFileManager;
  private readonly power: PowerController;
  private readonly diagnostics: DiagnosticRunner;
  private readonly previews: PreviewManager;
  private readonly desktop: RemoteDesktopManager;
  private readonly updates: UpdateManager;
  private readonly sleepInhibitor: SleepInhibitor;

  private constructor(
    private readonly options: ResolvedFleetAgentOptions,
    registration: AgentRegistration,
    metrics: DeviceMetrics,
  ) {
    this.deviceId = registration.id;
    this.registration = registration;
    this.lastMetrics = metrics;
    const send = (message: AgentToCoreMessage): void => this.send(message);
    this.sleepInhibitor = new SleepInhibitor(options.preventSleepDuringJobs, options.logger);
    this.terminals = new TerminalManager(send, options.shell);
    if (!this.terminals.available) options.logger.info('Interactive terminal capability is disabled.', this.terminals.unavailableReason);
    this.codex = new CodexSessionManager(options.codexCommand, send, options.dataDir, options.codexHome);
    this.jobs = new JobManager(options.codexCommand, options.shell, send, () => this.sleepInhibitor.acquire(), () => this.sleepInhibitor.release());
    this.files = new FleetFileManager(options.projectRoots, options.maxFileChunkBytes);
    this.power = new PowerController(options.allowPowerActions, options.wolPort);
    this.diagnostics = new DiagnosticRunner(options);
    this.previews = new PreviewManager(this.deviceId, send, options.shell, undefined, () => this.sleepInhibitor.acquire(), () => this.sleepInhibitor.release());
    this.desktop = new RemoteDesktopManager(send);
    this.updates = new UpdateManager(options.dataDir, options.maxUpdateBytes, options.updatePublicKey, options.requireSignedUpdates, send);
  }

  static async create(agentOptions: FleetAgentOptions = {}): Promise<FleetAgent> {
    const options = resolveOptions(agentOptions);
    const [deviceId, host, capabilities, metrics] = await Promise.all([
      getOrCreateDeviceId(options.dataDir, options.deviceId),
      getHostInformation(),
      detectCapabilities(options.codexCommand, options.shell),
      collectMetrics(),
    ]);
    options.token = await resolveAgentCredential(options, {
      id: deviceId,
      name: options.deviceName,
      hostname: host.hostname,
      platform: host.platform,
      arch: host.arch,
    });
    capabilities.wakeOnLan = true;
    capabilities.labels = [...new Set([
      ...capabilities.labels,
      `role:${options.role}`,
      `protocol:${PROTOCOL_VERSION}`,
      'feature:file-transfer',
      'feature:diagnostics',
      'feature:remote-desktop',
      'feature:updates',
      'feature:wol-relay',
      ...terminalCapabilityLabels(),
      ...(capabilities.codex ? ['feature:codex-session-mobility', 'feature:codex-ui-rpc'] : []),
      ...(capabilities.tailscale && capabilities.node ? ['feature:shared-preview'] : []),
      ...(options.allowPowerActions ? ['feature:power-actions'] : []),
      ...(options.preventSleepDuringJobs ? ['feature:prevent-sleep'] : []),
    ])];
    const registration: AgentRegistration = {
      id: deviceId,
      name: options.deviceName,
      hostname: host.hostname,
      role: options.role,
      platform: host.platform,
      arch: host.arch,
      osName: host.osName,
      osVersion: host.osVersion,
      agentVersion: AGENT_VERSION,
      capabilities,
      projectRoots: options.projectRoots,
    };
    (registration as AgentRegistration & { protocolVersion: number }).protocolVersion = PROTOCOL_VERSION;
    return new FleetAgent(options, registration, metrics);
  }

  start(): this {
    if (this.stopped) throw new Error('A stopped FleetAgent cannot be restarted.');
    if (this.started) return this;
    this.started = true;
    this.connect();
    this.metricsTimer = setInterval(() => void this.sampleAndSendMetrics(), this.options.heartbeatIntervalMs);
    return this;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.terminals.shutdown();
    await this.codex.shutdown();
    await this.previews.shutdown();
    this.jobs.shutdown();
    this.desktop.shutdown();
    this.sleepInhibitor.shutdown();
    const socket = this.socket;
    this.socket = undefined;
    if (socket?.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    } else if (socket?.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1_000);
        timeout.unref();
        socket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.close(1000, 'Agent shutdown');
      });
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = buildAgentWebSocketUrl(this.options.coreUrl);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.reconnectAttempt = 0;
      this.options.logger.info(`Connected to Fleet Core as ${this.deviceId}.`);
      this.sendRegistration();
      void this.sampleAndSendMetrics();
    });
    socket.on('message', (data) => void this.handleRawCommand(data));
    socket.on('error', (error) => {
      if (!this.stopped) this.options.logger.warn('Fleet Core connection error.', error.message);
    });
    socket.on('close', (code, reason) => {
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      this.options.logger.warn(`Disconnected from Fleet Core (${code}${reason.length ? `: ${reason.toString()}` : ''}).`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exponential = Math.min(this.options.reconnectMaxDelayMs, this.options.reconnectMinDelayMs * 2 ** this.reconnectAttempt++);
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private sendRegistration(): void {
    this.send({
      type: 'agent.register',
      payload: { ...this.registration, metrics: this.lastMetrics },
    });
  }

  private async sampleAndSendMetrics(): Promise<void> {
    if (this.metricsInFlight || this.stopped || this.socket?.readyState !== WebSocket.OPEN) return;
    this.metricsInFlight = true;
    try {
      this.lastMetrics = await collectMetrics();
      this.send({ type: 'agent.metrics', payload: { deviceId: this.deviceId, metrics: this.lastMetrics } });
    } catch (error) {
      this.options.logger.warn('Unable to collect device metrics.', error);
    } finally {
      this.metricsInFlight = false;
    }
  }

  private send(message: AgentToCoreMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message), (error) => {
      if (error && !this.stopped) this.options.logger.warn('Unable to send message to Fleet Core.', error.message);
    });
  }

  private async handleRawCommand(data: RawData): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(rawDataToString(data));
    } catch {
      this.options.logger.warn('Ignored non-JSON command from Fleet Core.');
      return;
    }
    if (!isCoreCommand(value)) {
      this.options.logger.warn('Ignored invalid command from Fleet Core.');
      return;
    }

    try {
      const payload = await this.execute(value);
      this.send({ type: 'agent.response', requestId: value.requestId, payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: 'agent.response', requestId: value.requestId, error: message });
    }
  }

  private async execute(command: CoreToAgentCommand): Promise<unknown> {
    switch (command.type) {
      case 'agent.ping':
        return { at: command.payload.at, deviceId: this.deviceId, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, receivedAt: new Date().toISOString() };
      case 'terminal.start': {
        this.terminals.assertAvailable();
        const cwd = await resolveAllowedDirectory(command.payload.terminal.cwd, this.options.projectRoots);
        this.terminals.start(command.payload.terminal, command.payload.env, cwd);
        return { terminalId: command.payload.terminal.id, cwd };
      }
      case 'terminal.input':
        this.terminals.assertAvailable();
        this.terminals.input(command.payload.terminalId, command.payload.data);
        return { terminalId: command.payload.terminalId };
      case 'terminal.resize':
        this.terminals.assertAvailable();
        this.terminals.resize(command.payload.terminalId, command.payload.cols, command.payload.rows);
        return { terminalId: command.payload.terminalId };
      case 'terminal.stop':
        this.terminals.assertAvailable();
        this.terminals.stop(command.payload.terminalId);
        return { terminalId: command.payload.terminalId };
      case 'codex.start': {
        const cwd = await resolveAllowedDirectory(command.payload.session.cwd, this.options.projectRoots);
        return this.codex.start(command.payload.session, cwd);
      }
      case 'codex.resume': {
        const cwd = await resolveAllowedDirectory(command.payload.session.cwd, this.options.projectRoots);
        return this.codex.resume(command.payload.session, cwd, command.payload.threadId);
      }
      case 'codex.fork': {
        const cwd = await resolveAllowedDirectory(command.payload.session.cwd, this.options.projectRoots);
        return this.codex.fork(command.payload.session, cwd, command.payload.threadId, command.payload.lastTurnId);
      }
      case 'codex.send':
        return this.codex.sendTurn(command.payload.sessionId, command.payload.text);
      case 'codex.rpc':
        return this.codex.rpc(command.payload.sessionId, command.payload.method, command.payload.params);
      case 'codex.respond':
        this.codex.respond(command.payload.sessionId, command.payload.codexRequestId, command.payload.result);
        return { sessionId: command.payload.sessionId, requestId: command.payload.codexRequestId };
      case 'codex.interrupt':
        return this.codex.interrupt(command.payload.sessionId, command.payload.threadId, command.payload.turnId);
      case 'codex.stop':
        await this.codex.stop(command.payload.sessionId);
        return { sessionId: command.payload.sessionId };
      case 'codex.handoff.prepare':
        return this.codex.prepareHandoff(command.payload.sessionId);
      case 'preview.start': {
        const cwd = await resolveAllowedDirectory(command.payload.cwd, this.options.projectRoots);
        return this.previews.start({ ...command.payload, cwd });
      }
      case 'preview.stop':
        return this.previews.stop(command.payload.projectId);
      case 'codex.handoff.read':
        return this.codex.readHandoff(command.payload.handoffId, command.payload.offset, command.payload.length);
      case 'codex.handoff.begin':
        return this.codex.beginHandoff(command.payload.handoffId, command.payload.sizeBytes, command.payload.checksumSha256);
      case 'codex.handoff.write':
        return this.codex.writeHandoff(command.payload.handoffId, command.payload.offset, command.payload.dataBase64);
      case 'codex.handoff.finish': {
        const cwd = await resolveAllowedDirectory(command.payload.session.cwd, this.options.projectRoots);
        return this.codex.finishHandoff({ ...command.payload, cwd });
      }
      case 'codex.handoff.discard':
        await this.codex.discardHandoff(command.payload.handoffId);
        return { handoffId: command.payload.handoffId };
      case 'job.start': {
        const cwd = await resolveAllowedDirectory(command.payload.job.cwd || process.cwd(), this.options.projectRoots);
        this.jobs.start(command.payload.job, cwd, command.payload.environment);
        return { jobId: command.payload.job.id, cwd };
      }
      case 'job.cancel':
        this.jobs.cancel(command.payload.jobId);
        return { jobId: command.payload.jobId };
      case 'device.power':
        return this.power.perform(command.payload);
      case 'file.list':
        return this.files.list(command.payload.path, command.payload.cursor, command.payload.limit);
      case 'file.stat':
        return this.files.stat(command.payload.path);
      case 'file.read':
        return this.files.read(command.payload.path, command.payload.offset, command.payload.length);
      case 'file.write':
        return this.files.write(command.payload.path, command.payload.offset, command.payload.dataBase64, command.payload.truncate);
      case 'file.mkdir':
        return this.files.mkdir(command.payload.path, command.payload.recursive);
      case 'file.remove':
        return this.files.remove(command.payload.path, command.payload.recursive);
      case 'file.checksum':
        return this.files.checksum(command.payload.path);
      case 'diagnostics.run':
        return this.diagnostics.run(command.payload.kind, command.payload.redact);
      case 'update.prepare':
        return this.updates.prepare(command.payload);
      case 'update.apply':
        return this.updates.apply(command.payload.version, command.payload.restart);
      case 'update.rollback':
        return this.updates.rollback(command.payload.version);
      case 'desktop.start':
        return this.desktop.start(command.payload.session, command.payload.config);
      case 'desktop.stop':
        this.desktop.stop(command.payload.sessionId);
        return { sessionId: command.payload.sessionId };
    }
  }
}

export async function startFleetAgent(options: FleetAgentOptions = {}): Promise<FleetAgent> {
  const agent = await FleetAgent.create(options);
  return agent.start();
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function isCoreCommand(value: unknown): value is CoreToAgentCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<CoreToAgentCommand>;
  return typeof command.type === 'string'
    && typeof command.requestId === 'string'
    && 'payload' in command
    && CORE_COMMANDS.has(command.type);
}

const CORE_COMMANDS = new Set([
  'terminal.start', 'terminal.input', 'terminal.resize', 'terminal.stop',
  'codex.start', 'codex.resume', 'codex.fork', 'codex.send', 'codex.rpc', 'codex.respond', 'codex.interrupt', 'codex.stop',
  'codex.handoff.prepare', 'codex.handoff.read', 'codex.handoff.begin', 'codex.handoff.write', 'codex.handoff.finish', 'codex.handoff.discard',
  'preview.start', 'preview.stop',
  'job.start', 'job.cancel', 'agent.ping',
  'device.power',
  'file.list', 'file.stat', 'file.read', 'file.write', 'file.mkdir', 'file.remove', 'file.checksum',
  'diagnostics.run',
  'update.prepare', 'update.apply', 'update.rollback',
  'desktop.start', 'desktop.stop',
]);
