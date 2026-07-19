import type { AgentToCoreMessage, CoreToAgentCommand, DeviceMetrics, DeviceRole } from '@fleet/shared';
import WebSocket from 'ws';

export interface SimulatorOptions {
  coreUrl: string;
  token: string;
  count: number;
  intervalMs: number;
  latencyMs: number;
  failureRate: number;
  prefix: string;
  codexUi?: boolean;
}

export class FleetSimulator {
  private readonly devices: VirtualDevice[];

  constructor(readonly options: SimulatorOptions) {
    if (options.count < 1 || options.count > 1_000) throw new Error('Simulator count must be between 1 and 1,000.');
    if (options.failureRate < 0 || options.failureRate > 1) throw new Error('Failure rate must be between 0 and 1.');
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 250) throw new Error('Simulator interval must be at least 250 milliseconds.');
    if (!Number.isFinite(options.latencyMs) || options.latencyMs < 0 || options.latencyMs > 300_000) throw new Error('Simulator latency must be between 0 and 300000 milliseconds.');
    if (!options.token || /[\r\n]/.test(options.token)) throw new Error('Simulator token is required and must not contain control characters.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(options.prefix)) throw new Error('Simulator prefix must be a short hostname-safe label.');
    const core = new URL(options.coreUrl);
    if (!['http:', 'https:'].includes(core.protocol) || core.username || core.password) throw new Error('Simulator Core URL must be HTTP(S) without embedded credentials.');
    this.devices = Array.from({ length: options.count }, (_, index) => new VirtualDevice(options, index));
  }

  start(): void {
    for (const device of this.devices) device.start();
  }

  async stop(): Promise<void> {
    await Promise.all(this.devices.map((device) => device.stop()));
  }
}

class VirtualDevice {
  private socket?: WebSocket;
  private metricsTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly id: string;
  private readonly name: string;
  private readonly role: DeviceRole;

  constructor(private readonly options: SimulatorOptions, private readonly index: number) {
    this.id = `sim-${options.prefix}-${String(index + 1).padStart(3, '0')}`;
    this.name = options.codexUi && index === 0 ? 'demo-gpu' : `${options.prefix}-${index + 1}`;
    this.role = index % 5 === 0 ? 'gpu' : index % 5 === 1 ? 'worker' : index % 5 === 2 ? 'gateway' : index % 5 === 3 ? 'storage' : 'workstation';
  }

  start(): void {
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'Simulator stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(this.options.coreUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/agent`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.options.token}` } });
    this.socket = socket;
    socket.on('open', () => {
      this.register();
      this.metricsTimer = setInterval(() => this.send({ type: 'agent.metrics', payload: { deviceId: this.id, metrics: syntheticMetrics(this.index) } }), this.options.intervalMs);
      this.metricsTimer.unref();
    });
    socket.on('message', (data) => void this.command(data.toString()));
    socket.on('error', () => { /* close triggers the bounded reconnect path */ });
    socket.on('close', () => {
      if (this.metricsTimer) clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1_000 + Math.random() * 2_000);
        this.reconnectTimer.unref();
      }
    });
  }

  private register(): void {
    const registration = {
      id: this.id,
      name: this.name,
      hostname: this.name,
      role: this.role,
      platform: this.role === 'gpu' ? 'win32' : 'linux',
      arch: this.role === 'gateway' ? 'arm64' : 'x64',
      osName: 'Orchestra Simulator',
      osVersion: '2.0',
      agentVersion: '2.0.0-simulator',
      protocolVersion: 2,
      capabilities: {
        codex: this.options.codexUi === true, git: true, docker: this.role !== 'gateway', tailscale: true, cuda: this.role === 'gpu', mlx: false,
        node: true, wakeOnLan: true, shell: '/bin/sh', labels: [
          'simulator', `role:${this.role}`,
          ...(this.options.codexUi ? ['codex:installed', 'codex:authenticated', 'codex:ready', 'codex:true'] : []),
          ...(this.role === 'gpu' ? ['gpu:nvidia', 'cuda'] : []),
        ],
      },
      projectRoots: ['/Users/example/Projects/demo'],
      metrics: syntheticMetrics(this.index),
    };
    this.send({
      type: 'agent.register',
      payload: registration,
    });
  }

  private async command(raw: string): Promise<void> {
    let command: CoreToAgentCommand;
    try { command = JSON.parse(raw) as CoreToAgentCommand; } catch { return; }
    await delay(this.options.latencyMs);
    if (Math.random() < this.options.failureRate) {
      this.send({ type: 'agent.response', requestId: command.requestId, error: 'Injected simulator failure.' });
      return;
    }
    if (command.type === 'job.start') {
      this.send({ type: 'agent.response', requestId: command.requestId, payload: { jobId: command.payload.job.id, simulated: true } });
      this.send({ type: 'job.status', payload: { jobId: command.payload.job.id, status: 'running' } });
      this.send({ type: 'job.output', payload: { jobId: command.payload.job.id, stream: 'stdout', text: '[simulator] Deterministic development job executed.\n' } });
      await delay(Math.max(150, this.options.latencyMs));
      this.send({ type: 'job.status', payload: { jobId: command.payload.job.id, status: 'completed', exitCode: 0 } });
      return;
    }
    if (command.type === 'codex.start' && this.options.codexUi) {
      this.send({ type: 'agent.response', requestId: command.requestId, payload: { threadId: `demo-thread-${this.id}` } });
      return;
    }
    this.send({ type: 'agent.response', requestId: command.requestId, payload: { simulated: true, type: command.type, deviceId: this.id } });
  }

  private send(message: AgentToCoreMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

export function syntheticMetrics(index: number, now = Date.now()): DeviceMetrics {
  const phase = now / 10_000 + index;
  const cpu = 32 + Math.sin(phase) * 20;
  const memory = 45 + Math.cos(phase * 0.6) * 12;
  const totalMemory = (index % 3 === 0 ? 64 : index % 3 === 1 ? 32 : 16) * 1024 ** 3;
  const isGpu = index % 5 === 0;
  return {
    cpu: { model: 'Simulated CPU', cores: 8 + (index % 3) * 4, usagePercent: clamp(cpu), temperatureCelsius: 48 + clamp(cpu) * 0.25 },
    memory: { totalBytes: totalMemory, usedBytes: Math.round(totalMemory * memory / 100), usagePercent: clamp(memory) },
    storage: [{ mount: '/', totalBytes: 1024 ** 4, usedBytes: 420 * 1024 ** 3, usagePercent: 42 }],
    gpus: isGpu ? [{ vendor: 'NVIDIA', model: 'Simulated CUDA GPU', vramTotalBytes: 16 * 1024 ** 3, vramUsedBytes: 7 * 1024 ** 3, usagePercent: clamp(60 + Math.sin(phase * 1.2) * 30), temperatureCelsius: 67 }] : [],
    network: { rxBytesPerSecond: Math.round(2_000_000 + Math.sin(phase) * 1_000_000), txBytesPerSecond: Math.round(1_000_000 + Math.cos(phase) * 500_000), tailscaleIp: `100.64.${Math.floor(index / 254)}.${index % 254 + 1}`, tailscaleDnsName: `sim-${index + 1}.example.ts.net` },
    uptimeSeconds: Math.floor(now / 1_000),
    sampledAt: new Date(now).toISOString(),
  };
}

function clamp(value: number): number { return Math.max(0, Math.min(100, Math.round(value * 10) / 10)); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
