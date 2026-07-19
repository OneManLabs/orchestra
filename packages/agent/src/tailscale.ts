import { runCommand } from './process-utils.js';
import { startBoundHttpProxy, type BoundHttpProxy } from './http-proxy.js';

export interface TailscaleIdentity {
  ip?: string;
  dnsName?: string;
}

export type TailscaleWebTransport = 'tailscale-serve' | 'tailscale-funnel' | 'direct-tailnet';

export interface TailscaleWebEndpoint {
  url: string;
  dnsName: string;
  transport: TailscaleWebTransport;
  warning?: string;
}

interface TailscaleStatusJson {
  Self?: {
    DNSName?: unknown;
    TailscaleIPs?: unknown;
  };
}

export function parseTailscaleStatus(value: string | unknown): TailscaleIdentity {
  let status: TailscaleStatusJson;
  try {
    status = (typeof value === 'string' ? JSON.parse(value) : value) as TailscaleStatusJson;
  } catch {
    return {};
  }
  const addresses = Array.isArray(status?.Self?.TailscaleIPs)
    ? status.Self.TailscaleIPs.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const ip = addresses.find((address) => address.includes('.') && isTailscaleAddress(address))
    ?? addresses.find(isTailscaleAddress);
  const rawDnsName = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName : undefined;
  return { ip, dnsName: rawDnsName?.replace(/\.$/, '') };
}

export async function getTailscaleIdentity(): Promise<TailscaleIdentity> {
  for (const command of tailscaleCommandCandidates()) {
    try {
      const result = await runCommand(command, ['status', '--json'], { timeoutMs: 4_000 });
      if (result.exitCode === 0) return parseTailscaleStatus(result.stdout);
    } catch {
      // Try the next platform-specific command location.
    }
  }
  return {};
}

export async function isTailscaleInstalled(): Promise<boolean> {
  for (const command of tailscaleCommandCandidates()) {
    try {
      await runCommand(command, ['version'], { timeoutMs: 3_000 });
      return true;
    } catch {
      // Try the next platform-specific command location.
    }
  }
  return false;
}

export async function configureTailscaleWebProxy(input: {
  visibility: 'tailnet' | 'public';
  servePort: number;
  targetPort: number;
}): Promise<TailscaleWebEndpoint> {
  const identity = await getTailscaleIdentity();
  if (!identity.ip || !identity.dnsName) throw new Error('Tailscale is not connected or has no tailnet identity.');
  const command = input.visibility === 'public' ? 'funnel' : 'serve';
  try {
    const result = await runTailscaleCommand([
      command,
      '--bg',
      '--yes',
      `--https=${input.servePort}`,
      `http://127.0.0.1:${input.targetPort}`,
    ], 20_000);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `tailscale ${command} failed.`);
    const suffix = input.servePort === 443 ? '' : `:${input.servePort}`;
    return {
      url: `https://${identity.dnsName}${suffix}/`,
      dnsName: identity.dnsName,
      transport: input.visibility === 'public' ? 'tailscale-funnel' : 'tailscale-serve',
    };
  } catch (error) {
    if (input.visibility === 'public') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      return await configureDirectTailnetProxy(
        { ip: identity.ip, dnsName: identity.dnsName },
        input,
        reason,
      );
    } catch (fallbackError) {
      throw new Error([
        `Tailscale Serve failed: ${reason}`,
        `Direct tailnet fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      ].join('\n'));
    }
  }
}

export async function disableTailscaleWebProxy(input: {
  visibility: 'tailnet' | 'public';
  servePort: number;
}): Promise<void> {
  const direct = directTailnetProxies.get(input.servePort);
  if (direct) {
    directTailnetProxies.delete(input.servePort);
    await direct.close();
    return;
  }
  const command = input.visibility === 'public' ? 'funnel' : 'serve';
  const result = await runTailscaleCommand([command, '--yes', `--https=${input.servePort}`, 'off'], 15_000);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `tailscale ${command} off failed.`);
}

export function isTailscaleAddress(value: string): boolean {
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255)
      && octets[0] === 100
      && octets[1]! >= 64
      && octets[1]! <= 127;
  }
  return value.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

async function runTailscaleCommand(args: string[], timeoutMs: number) {
  let lastError: unknown;
  for (const command of tailscaleCommandCandidates()) {
    try {
      return await runCommand(command, args, { timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Tailscale CLI is unavailable.');
}

export function tailscaleCommandCandidates(): string[] {
  return [...new Set([
    process.env.FLEET_TAILSCALE_COMMAND,
    'tailscale',
    ...(process.platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : []),
  ].filter((value): value is string => Boolean(value)))];
}

const directTailnetProxies = new Map<number, BoundHttpProxy>();

async function configureDirectTailnetProxy(
  identity: Required<TailscaleIdentity>,
  input: { servePort: number; targetPort: number },
  warning: string,
): Promise<TailscaleWebEndpoint> {
  if (!isTailscaleAddress(identity.ip)) throw new Error('The Agent did not report a valid Tailscale address.');
  const existing = directTailnetProxies.get(input.servePort);
  if (existing) await existing.close();
  const proxy = await startBoundHttpProxy({
    listenHost: identity.ip,
    listenPort: input.servePort,
    targetPort: input.targetPort,
  });
  directTailnetProxies.set(input.servePort, proxy);
  return {
    url: `http://${formatUrlHost(identity.ip)}:${input.servePort}/`,
    dnsName: identity.dnsName,
    transport: 'direct-tailnet',
    warning: `Tailscale Serve is unavailable, so Fleet is using an encrypted tailnet-only direct connection. ${warning}`,
  };
}

function formatUrlHost(value: string): string {
  return value.includes(':') ? `[${value}]` : value;
}
