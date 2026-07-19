import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { AgentToCoreMessage, RemoteDesktopSession } from '@fleet/shared';
import { commandExists, runCommand } from './process-utils.js';
import { getTailscaleIdentity } from './tailscale.js';

type SendMessage = (message: AgentToCoreMessage) => void;

export interface RemoteDesktopAdapter {
  protocol: RemoteDesktopSession['protocol'];
  available: boolean;
  running: boolean;
  name: string;
  detail: string;
  defaultPort?: number;
}

interface ActiveDesktopSession {
  child?: ChildProcess;
  expiration?: NodeJS.Timeout;
}

export class RemoteDesktopManager {
  private readonly sessions = new Map<string, ActiveDesktopSession>();

  constructor(private readonly send: SendMessage) {}

  async discover(): Promise<RemoteDesktopAdapter[]> {
    return discoverRemoteDesktopAdapters();
  }

  async start(session: RemoteDesktopSession, config: Record<string, unknown>): Promise<unknown> {
    if (this.sessions.has(session.id)) throw new Error(`Remote desktop session already exists: ${session.id}`);
    const host = validateHost(typeof config.host === 'string' ? config.host : await defaultHost());
    const adapters = await this.discover();
    const adapter = adapters.find((candidate) => candidate.protocol === session.protocol);
    let child: ChildProcess | undefined;
    let connectionUrl: string;

    if (session.protocol === 'external') {
      if (typeof config.url !== 'string') throw new Error('External desktop sessions require config.url.');
      connectionUrl = validateExternalUrl(config.url);
    } else {
      if (!adapter?.available) throw new Error(`Remote desktop adapter ${session.protocol} is not available on this device.`);
      if (!adapter.running && session.protocol === 'sunshine' && config.launch === true) {
        child = spawn('sunshine', [], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', (error) => this.send({ type: 'desktop.event', payload: { sessionId: session.id, status: 'error', error: error.message } }));
        child.unref();
      } else if (!adapter.running) {
        throw new Error(`${adapter.name} is installed or supported but is not currently running.`);
      }
      connectionUrl = connectionUrlFor(session.protocol, host, integerConfig(config.port, adapter.defaultPort));
    }

    const active: ActiveDesktopSession = { child };
    if (session.expiresAt) {
      const delay = new Date(session.expiresAt).getTime() - Date.now();
      if (delay <= 0) throw new Error('Remote desktop session has already expired.');
      active.expiration = setTimeout(() => this.stop(session.id), Math.min(delay, 2_147_483_647));
      active.expiration.unref();
    }
    this.sessions.set(session.id, active);
    this.send({ type: 'desktop.event', payload: { sessionId: session.id, status: 'ready', connectionUrl } });
    return { sessionId: session.id, protocol: session.protocol, connectionUrl, adapter, viewOnly: session.viewOnly, recording: session.recording };
  }

  stop(sessionId: string): void {
    const active = this.sessions.get(sessionId);
    if (!active) throw new Error(`Unknown remote desktop session: ${sessionId}`);
    if (active.expiration) clearTimeout(active.expiration);
    active.child?.kill('SIGTERM');
    this.sessions.delete(sessionId);
    this.send({ type: 'desktop.event', payload: { sessionId, status: 'closed' } });
  }

  shutdown(): void {
    for (const [sessionId, active] of this.sessions) {
      if (active.expiration) clearTimeout(active.expiration);
      active.child?.kill('SIGTERM');
      this.send({ type: 'desktop.event', payload: { sessionId, status: 'closed' } });
    }
    this.sessions.clear();
  }
}

export async function discoverRemoteDesktopAdapters(): Promise<RemoteDesktopAdapter[]> {
  const [processes, sunshineInstalled, rdpState, screenSharingState] = await Promise.all([
    processList(),
    commandExists('sunshine'),
    process.platform === 'win32' ? safeCommand('sc.exe', ['query', 'TermService']) : Promise.resolve(''),
    process.platform === 'darwin' ? safeCommand('launchctl', ['print', 'system/com.apple.screensharing']) : Promise.resolve(''),
  ]);
  const lower = processes.toLowerCase();
  const sunshineRunning = lower.includes('sunshine');
  const vncRunning = /\b(x11vnc|wayvnc|x0vncserver|vncserver|realvnc|screensharingd)\b/i.test(processes);
  return [
    {
      protocol: 'rdp', name: 'Windows Remote Desktop', defaultPort: 3389,
      available: process.platform === 'win32', running: /running/i.test(rdpState),
      detail: process.platform === 'win32' ? (/running/i.test(rdpState) ? 'Remote Desktop Services is running.' : 'Remote Desktop Services is not running.') : 'RDP host discovery is Windows-only.',
    },
    {
      protocol: 'screen-sharing', name: 'macOS Screen Sharing', defaultPort: 5900,
      available: process.platform === 'darwin', running: process.platform === 'darwin' && (screenSharingState.length > 0 || lower.includes('screensharingd')),
      detail: process.platform === 'darwin' ? (screenSharingState.length > 0 || lower.includes('screensharingd') ? 'Screen Sharing service is active.' : 'Screen Sharing is disabled.') : 'Screen Sharing host discovery is macOS-only.',
    },
    {
      protocol: 'vnc', name: 'VNC', defaultPort: 5900,
      available: vncRunning, running: vncRunning,
      detail: vncRunning ? 'A known VNC server process is running.' : 'No known VNC server process was found.',
    },
    {
      protocol: 'sunshine', name: 'Sunshine / Moonlight', defaultPort: 47989,
      available: sunshineInstalled || sunshineRunning, running: sunshineRunning,
      detail: sunshineRunning ? 'Sunshine is running.' : sunshineInstalled ? 'Sunshine is installed but not running.' : 'Sunshine was not found.',
    },
  ];
}

function connectionUrlFor(protocol: RemoteDesktopSession['protocol'], host: string, port?: number): string {
  switch (protocol) {
    case 'rdp': return `rdp://${host}${port && port !== 3389 ? `:${port}` : ''}`;
    case 'vnc':
    case 'screen-sharing': return `vnc://${host}${port && port !== 5900 ? `:${port}` : ''}`;
    case 'sunshine': return `moonlight://${host}`;
    default: throw new Error(`Unsupported remote desktop protocol: ${protocol}`);
  }
}

async function defaultHost(): Promise<string> {
  const tailscale = await getTailscaleIdentity();
  return tailscale.dnsName ?? tailscale.ip ?? os.hostname();
}

function validateHost(value: string): string {
  const host = value.trim();
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) throw new Error('Remote desktop host contains unsupported characters.');
  return host;
}

function validateExternalUrl(value: string): string {
  const url = new URL(value);
  if (!['rdp:', 'vnc:', 'moonlight:', 'https:'].includes(url.protocol)) throw new Error('External desktop URL uses an unsupported scheme.');
  if (url.username || url.password) throw new Error('Remote desktop URLs must not include embedded credentials.');
  return url.toString();
}

function integerConfig(value: unknown, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) throw new Error('Remote desktop port is invalid.');
  return value as number;
}

async function processList(): Promise<string> {
  return process.platform === 'win32'
    ? safeCommand('tasklist.exe', ['/fo', 'csv', '/nh'])
    : safeCommand('ps', ['-ax', '-o', 'command=']);
}

async function safeCommand(command: string, args: string[]): Promise<string> {
  try {
    const result = await runCommand(command, args, { timeoutMs: 4_000 });
    return result.exitCode === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}
