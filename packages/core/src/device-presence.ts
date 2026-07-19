import type { Device, DevicePresence, DevicePresenceLayer, DevicePresenceLayerState } from '@fleet/shared';

export interface TailscalePresencePeer {
  hostname?: string;
  dnsName?: string;
  ips: string[];
  online: boolean;
}

export interface DevicePresenceEvidence {
  agentConnected: boolean;
  sourceIp?: string;
  tailscaleOnline?: boolean;
  tailscaleCheckedAt?: string;
  now?: string;
  offlineAfterMs: number;
}

export function tailscalePeerStateForDevice(device: Device, peers: TailscalePresencePeer[]): boolean | undefined {
  const hostname = normalizeHost(device.hostname);
  const dnsName = normalizeDns(device.metrics.network.tailscaleDnsName);
  const ip = device.metrics.network.tailscaleIp;
  const peer = peers.find((candidate) =>
    (ip && candidate.ips.includes(ip))
    || (dnsName && normalizeDns(candidate.dnsName) === dnsName)
    || (hostname && normalizeHost(candidate.hostname) === hostname)
    || (hostname && normalizeHost(candidate.dnsName?.split('.')[0]) === hostname)
  );
  return peer?.online;
}

export function deriveDevicePresence(device: Device, evidence: DevicePresenceEvidence): DevicePresence {
  const now = evidence.now ?? new Date().toISOString();
  const lastSeenAge = Math.max(0, new Date(now).getTime() - new Date(device.lastSeenAt).getTime());
  const sourceIp = normalizeIp(evidence.sourceIp);
  const sourceIsTailnet = Boolean(sourceIp && isTailnetAddress(sourceIp));
  const sourceIsLan = Boolean(sourceIp && isPrivateLanAddress(sourceIp) && !sourceIsTailnet);

  const agent = evidence.agentConnected
    ? layer('reachable', now, `Agent heartbeat connected${sourceIp ? ` from ${sourceIp}` : ''}.`)
    : lastSeenAge < evidence.offlineAfterMs
      ? layer('stale', now, `Agent connection dropped; last heartbeat ${ageLabel(lastSeenAge)} ago.`)
      : layer('unreachable', now, `No Agent heartbeat for ${ageLabel(lastSeenAge)}.`);

  const tailscaleCheckedAt = evidence.tailscaleCheckedAt ?? now;
  const tailscale = evidence.tailscaleOnline === true
    ? layer('reachable', tailscaleCheckedAt, 'Tailscale reports this host online.')
    : evidence.tailscaleOnline === false
      ? layer('unreachable', tailscaleCheckedAt, 'Tailscale reports this host offline.')
      : sourceIsTailnet && evidence.agentConnected
        ? layer('reachable', now, `Agent is connected through tailnet address ${sourceIp}.`)
        : !device.capabilities.tailscale
          ? layer('not-configured', now, 'Tailscale is not reported by this device.')
          : layer('unknown', tailscaleCheckedAt, 'No current Tailscale peer result is available.')
  ;

  const previousLan = device.presence?.lan;
  const lan = sourceIsLan && evidence.agentConnected
    ? layer('reachable', now, `Agent connection arrived over LAN address ${sourceIp}.`)
    : evidence.agentConnected
      ? layer('unknown', now, sourceIsTailnet
        ? 'Agent is connected through Tailscale; LAN reachability was not independently tested.'
        : 'Agent is connected, but its transport is not identified as a private LAN address.')
      : previousLan?.state === 'reachable' || previousLan?.state === 'stale'
        ? layer('stale', now, `LAN was last observed through the Agent; it is not independently probed while the Agent is disconnected.`)
        : layer('unknown', now, 'LAN reachability has not been independently observed.')
  ;

  const serviceHealth = device.metrics.serviceHealth;
  const services = !evidence.agentConnected
    ? layer('stale', now, 'Service health is stale because the Agent is disconnected.')
    : serviceHealth && serviceHealth.total > 0
      ? serviceHealth.running > 0
        ? layer('reachable', device.metrics.sampledAt, `${serviceHealth.running} services are running; ${serviceHealth.stopped} are inactive. No required-service failure is configured.`)
        : layer('unknown', device.metrics.sampledAt, `${serviceHealth.stopped} inventoried services are inactive. No required-service policy is configured.`)
      : layer('unknown', device.metrics.sampledAt, 'This Agent does not report monitored service health.')
  ;

  let summary: DevicePresence['summary'];
  let label: string;
  let detail: string;
  if (evidence.agentConnected && (device.status === 'degraded' || services.state === 'unreachable')) {
    summary = 'degraded';
    label = 'Connected · Degraded';
    detail = services.state === 'unreachable' ? services.detail : 'The Agent is connected but device health is degraded.';
  } else if (evidence.agentConnected) {
    summary = 'operational';
    label = 'Operational';
    detail = tailscale.state === 'reachable' ? 'Agent and Tailscale are reachable.' : 'Agent heartbeat is live.';
  } else if (tailscale.state === 'reachable') {
    summary = 'agent-offline';
    label = 'Reachable · Agent offline';
    detail = 'The host is visible on Tailscale, but Orchestra is not receiving an Agent heartbeat.';
  } else if (tailscale.state === 'unreachable') {
    summary = 'host-unreachable';
    label = 'Host unreachable';
    detail = 'Neither an Agent heartbeat nor a live Tailscale peer is available.';
  } else {
    summary = 'unknown';
    label = 'Presence unknown';
    detail = 'The Agent is offline and no independent network result is available.';
  }

  return { summary, label, detail, updatedAt: now, agent, tailscale, lan, services };
}

function layer(state: DevicePresenceLayerState, checkedAt: string, detail: string): DevicePresenceLayer {
  return { state, checkedAt, detail };
}

function normalizeDns(value: string | undefined): string | undefined {
  return value?.trim().replace(/\.+$/, '').toLowerCase() || undefined;
}

function normalizeHost(value: string | undefined): string | undefined {
  return normalizeDns(value)?.split('.')[0];
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0]?.trim().replace(/^::ffff:/, '');
  return first || undefined;
}

function isTailnetAddress(value: string): boolean {
  const octets = ipv4(value);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 100 && second! >= 64 && second! <= 127;
}

function isPrivateLanAddress(value: string): boolean {
  const octets = ipv4(value);
  if (octets) {
    const [first, second] = octets;
    return first === 10
      || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254);
  }
  const normalized = value.toLowerCase();
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function ipv4(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : undefined;
}

function ageLabel(milliseconds: number): string {
  if (milliseconds < 1_000) return 'less than a second';
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000) return `${Math.floor(milliseconds / 3_600_000)}h`;
  return `${Math.floor(milliseconds / 86_400_000)}d`;
}
