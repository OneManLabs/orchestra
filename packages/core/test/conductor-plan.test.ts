import { describe, expect, it } from 'vitest';
import type { Device, FleetProject } from '@fleet/shared';
import { buildConductorPlan } from '../src/conductor-plan.js';

function device(id: string, input: { gpu?: boolean; status?: Device['status']; load?: number } = {}): Device {
  const now = '2026-07-17T18:00:00.000Z';
  return {
    id, name: id, hostname: id, role: input.gpu ? 'gpu' : 'worker', status: input.status ?? 'online', platform: 'darwin', arch: 'arm64', osName: 'macOS', osVersion: '26', agentVersion: '2',
    capabilities: { codex: true, git: true, docker: false, tailscale: true, cuda: Boolean(input.gpu), mlx: false, node: true, wakeOnLan: false, shell: '/bin/zsh', labels: [] },
    metrics: { cpu: { model: 'CPU', cores: 8, usagePercent: input.load ?? 5 }, memory: { totalBytes: 1, usedBytes: 0, usagePercent: 0 }, storage: [], gpus: [], network: { rxBytesPerSecond: 0, txBytesPerSecond: 0 }, uptimeSeconds: 1, sampledAt: now },
    projectRoots: ['/work'], position: { x: 0, y: 0 }, lastSeenAt: now, connectedAt: now, activeJobIds: [], activeSessionIds: [],
    presence: {
      summary: 'operational', label: 'Operational', detail: 'Agent live.', updatedAt: now,
      agent: { state: 'reachable', checkedAt: now, detail: 'live' }, tailscale: { state: 'reachable', checkedAt: now, detail: 'live' },
      lan: { state: 'unknown', checkedAt: now, detail: 'unknown' }, services: { state: 'unknown', checkedAt: now, detail: 'unknown' },
    },
  };
}

const project: FleetProject = {
  id: 'orchestra', name: 'Orchestra', description: '', defaultBranch: 'main', paths: [{ deviceId: 'gpu', path: '/work' }, { deviceId: 'worker', path: '/work' }],
  preferredDeviceIds: [], commands: { start: 'npm run dev' }, artifactPaths: [], createdAt: '2026-07-17T18:00:00.000Z', updatedAt: '2026-07-17T18:00:00.000Z',
};

describe('Conductor planning', () => {
  it('selects a mapped GPU and adds a dependent persistent preview', () => {
    const plan = buildConductorPlan({ objective: 'Use the GPU to update Orchestra and give me a website preview', devices: [device('worker'), device('gpu', { gpu: true })], projects: [project], explicitDeviceIds: [] });
    expect(plan.steps.map((step) => step.kind)).toEqual(['codex', 'preview']);
    expect(plan.steps[0]?.deviceId).toBe('gpu');
    expect(plan.steps[1]?.dependsOn).toEqual([plan.steps[0]?.id]);
  });

  it('keeps explicitly selected offline devices visible as blocked evidence', () => {
    const plan = buildConductorPlan({ objective: 'Work on Orchestra using @worker', devices: [device('worker', { status: 'offline' })], projects: [project], explicitDeviceIds: ['worker'] });
    expect(plan.steps[0]?.status).toBe('blocked');
    expect(plan.steps[0]?.error).toMatch(/heartbeat/i);
  });
});
