import { describe, expect, it } from 'vitest';
import type { Device } from '../src/types.js';
import {
  activeDeviceMention,
  deviceMentionSuggestions,
  preferredDeviceAlias,
  resolveDeviceMentions,
} from '../src/device-mentions.js';

function device(input: Pick<Device, 'id' | 'name' | 'hostname' | 'role'> & { memoryGb: number; gpu?: string; status?: Device['status'] }): Device {
  const now = new Date().toISOString();
  return {
    ...input,
    status: input.status ?? 'online',
    platform: 'darwin',
    arch: 'arm64',
    osName: 'Test',
    osVersion: '1',
    agentVersion: '2',
    capabilities: { codex: true, git: true, docker: false, tailscale: true, cuda: Boolean(input.gpu), mlx: false, node: true, wakeOnLan: true, shell: '/bin/zsh', labels: [] },
    metrics: {
      cpu: { model: 'CPU', cores: 8, usagePercent: 10 },
      memory: { totalBytes: input.memoryGb * 1024 ** 3, usedBytes: 1, usagePercent: 1 },
      storage: [],
      gpus: input.gpu ? [{ vendor: 'NVIDIA', model: input.gpu }] : [],
      network: { rxBytesPerSecond: 0, txBytesPerSecond: 0 },
      uptimeSeconds: 1,
      sampledAt: now,
    },
    projectRoots: ['/workspace'],
    position: { x: 0, y: 0 },
    lastSeenAt: now,
    connectedAt: now,
    activeJobIds: [],
    activeSessionIds: [],
  };
}

const devices = [
  device({ id: 'mbp', name: 'MacBook Pro', hostname: 'Nicks-MacBook-Pro.local', role: 'workstation', memoryGb: 36 }),
  device({ id: 'gpu', name: '5070 Ti GPU', hostname: 'DESKTOP-TNBPMMI', role: 'gpu', memoryGb: 32, gpu: 'NVIDIA GeForce RTX 5070 Ti' }),
  device({ id: 'nas', name: 'Synology NAS', hostname: 'NAS', role: 'storage', memoryGb: 4 }),
  device({ id: 'core', name: 'Mac mini 64 GB', hostname: 'Whimzyys-Mac-mini.local', role: 'core', memoryGb: 64 }),
];

describe('Fleet device mentions', () => {
  it('provides stable human aliases for the live fleet topology', () => {
    expect(devices.map(preferredDeviceAlias)).toEqual(['mbp', '5070', 'nas', 'mini64']);
  });

  it('resolves multiple @device mentions without guessing unknown aliases', () => {
    expect(resolveDeviceMentions('check @5070 and @nas, then compare @missing', devices)).toMatchObject([
      { token: '@5070', deviceIds: ['gpu'], status: 'resolved' },
      { token: '@nas', deviceIds: ['nas'], status: 'resolved' },
      { token: '@missing', deviceIds: [], status: 'unknown' },
    ]);
  });

  it('filters composer suggestions and identifies the active token', () => {
    expect(activeDeviceMention('status of @mi')).toMatchObject({ query: 'mi' });
    expect(deviceMentionSuggestions(devices, 'mi').map((item) => item.alias)).toEqual(['mini64']);
    expect(activeDeviceMention('ask @mbp to review\nnext line')).toBeUndefined();
  });

  it('prefers the one live device when a retired record shares its short alias', () => {
    const retired = device({ id: 'retired', name: 'Retired MacBook Agent', hostname: 'Old-MacBook-Pro.local', role: 'workstation', memoryGb: 16, status: 'offline' });
    expect(resolveDeviceMentions('run this on @mbp', [retired, devices[0]!])).toMatchObject([
      { token: '@mbp', deviceIds: ['mbp'], status: 'resolved' },
    ]);
    expect(deviceMentionSuggestions([retired, devices[0]!]).map((item) => item.alias)).toEqual(['mbp', 'retiredmacbookagent']);
  });
});
