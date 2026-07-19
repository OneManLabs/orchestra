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
  device({ id: 'workstation', name: 'Demo Workstation', hostname: 'demo-workstation.local', role: 'workstation', memoryGb: 36 }),
  device({ id: 'gpu', name: 'Demo GPU', hostname: 'demo-gpu.local', role: 'gpu', memoryGb: 32, gpu: 'Synthetic GPU' }),
  device({ id: 'storage', name: 'Demo Storage', hostname: 'demo-storage.local', role: 'storage', memoryGb: 4 }),
  device({ id: 'core', name: 'Demo Core', hostname: 'demo-core.local', role: 'core', memoryGb: 64 }),
];

describe('Orchestra device mentions', () => {
  it('provides stable human aliases for the live fleet topology', () => {
    expect(devices.map(preferredDeviceAlias)).toEqual(['demoworkstation', 'demogpu', 'demostorage', 'core']);
  });

  it('resolves multiple @device mentions without guessing unknown aliases', () => {
    expect(resolveDeviceMentions('check @demogpu and @demostorage, then compare @missing', devices)).toMatchObject([
      { token: '@demogpu', deviceIds: ['gpu'], status: 'resolved' },
      { token: '@demostorage', deviceIds: ['storage'], status: 'resolved' },
      { token: '@missing', deviceIds: [], status: 'unknown' },
    ]);
  });

  it('filters composer suggestions and identifies the active token', () => {
    expect(activeDeviceMention('status of @demo')).toMatchObject({ query: 'demo' });
    expect(deviceMentionSuggestions(devices, 'core').map((item) => item.alias)).toEqual(['core']);
    expect(activeDeviceMention('ask @demoworkstation to review\nnext line')).toBeUndefined();
  });

  it('prefers the one live device when a retired record shares its short alias', () => {
    const retired = device({ id: 'retired', name: 'Retired MacBook Agent', hostname: 'Old-MacBook-Pro.local', role: 'workstation', memoryGb: 16, status: 'offline' });
    expect(resolveDeviceMentions('run this on @demoworkstation', [retired, devices[0]!])).toMatchObject([
      { token: '@demoworkstation', deviceIds: ['workstation'], status: 'resolved' },
    ]);
    expect(deviceMentionSuggestions([retired, devices[0]!]).map((item) => item.alias)).toEqual(['demoworkstation', 'mbp']);
  });
});
