import { describe, expect, it } from 'vitest';
import type { Device } from '@fleet/shared';
import { deriveDevicePresence, tailscalePeerStateForDevice } from '../src/device-presence.js';

const now = '2026-07-17T18:00:00.000Z';

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'nas', name: 'Synology NAS', hostname: 'nas', role: 'storage', status: 'offline',
    platform: 'linux', arch: 'x64', osName: 'DSM', osVersion: '7', agentVersion: '2.0.0',
    capabilities: { codex: false, git: false, docker: true, tailscale: true, cuda: false, mlx: false, node: true, wakeOnLan: false, shell: '/bin/sh', labels: [] },
    metrics: {
      cpu: { model: 'AMD', cores: 4, usagePercent: 3 }, memory: { totalBytes: 4, usedBytes: 2, usagePercent: 50 },
      storage: [], gpus: [], network: { rxBytesPerSecond: 0, txBytesPerSecond: 0, tailscaleIp: '100.64.0.20', tailscaleDnsName: 'nas.example.ts.net' },
      uptimeSeconds: 100, sampledAt: '2026-07-17T17:59:30.000Z',
    },
    projectRoots: [], position: { x: 0, y: 0 }, lastSeenAt: '2026-07-17T17:59:30.000Z', connectedAt: now,
    activeJobIds: [], activeSessionIds: [], ...overrides,
  };
}

describe('truthful device presence', () => {
  it('distinguishes a reachable host from a missing Agent heartbeat', () => {
    const presence = deriveDevicePresence(device(), { agentConnected: false, tailscaleOnline: true, tailscaleCheckedAt: now, now, offlineAfterMs: 20_000 });
    expect(presence.summary).toBe('agent-offline');
    expect(presence.label).toBe('Reachable · Agent offline');
    expect(presence.agent.state).toBe('unreachable');
    expect(presence.tailscale.state).toBe('reachable');
  });

  it('reports live LAN evidence without claiming an independent LAN probe', () => {
    const presence = deriveDevicePresence(device({ status: 'online' }), { agentConnected: true, sourceIp: '192.168.4.33', now, offlineAfterMs: 20_000 });
    expect(presence.summary).toBe('operational');
    expect(presence.lan.state).toBe('reachable');
    expect(presence.tailscale.state).toBe('unknown');
  });

  it('does not call a host degraded merely because optional OS services are inactive', () => {
    const value = device({
      status: 'online',
      metrics: {
        ...device().metrics,
        serviceHealth: { total: 332, running: 143, stopped: 189 },
      },
    });
    const presence = deriveDevicePresence(value, { agentConnected: true, now, offlineAfterMs: 20_000 });
    expect(presence.summary).toBe('operational');
    expect(presence.services.state).toBe('reachable');
    expect(presence.services.detail).toMatch(/No required-service failure/i);
  });

  it('matches Tailscale peers by IP, DNS name, or hostname', () => {
    const peers = [{ hostname: 'nas', dnsName: 'nas.example.ts.net.', ips: ['100.64.0.20'], online: true }];
    expect(tailscalePeerStateForDevice(device(), peers)).toBe(true);
  });
});
