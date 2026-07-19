import type { MenuBarApproval, MenuBarDevice, MenuBarSnapshot } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { approvalNeedsReview, bestCodexDevice, canPowerDevice, codexApprovalDecision, jobProgress, parseMenuBarSnapshot } from '../src/renderer/lib/menu-bar-state.js';

function snapshot(): MenuBarSnapshot {
  return {
    generatedAt: '2026-07-16T12:00:00.000Z',
    core: { status: 'healthy', connected: true, fleetName: 'Fleet Canvas', version: '2.0.0', schemaVersion: 2, protocolVersion: 2, url: 'http://100.64.0.10:4780' },
    summary: { status: 'healthy', totalDevices: 1, onlineDevices: 1, busyDevices: 0, degradedDevices: 0, sleepingDevices: 0, offlineDevices: 0, activeJobs: 0, queuedJobs: 0, failedJobs: 0, pendingApprovals: 0, openWarnings: 0, openCriticalAlerts: 0 },
    jobs: [], devices: [device()], approvals: [], alerts: [], recent: [], codexSessions: []
  };
}

function device(patch: Partial<MenuBarDevice> = {}): MenuBarDevice {
  return {
    id: 'device-1', name: 'Core Mini', role: 'core', status: 'online', platform: 'darwin', lastSeenAt: '2026-07-16T12:00:00.000Z', activeJobCount: 0,
    metrics: { cpuPercent: 10, memoryPercent: 20, sampledAt: '2026-07-16T12:00:00.000Z' },
    capabilities: { codex: true, cuda: false, mlx: true, tailscale: true, wakeOnLan: false, labels: ['feature:power-actions'] },
    ...patch
  };
}

describe('menu bar contract parsing', () => {
  it('accepts a complete live menu-bar response without changing values', () => {
    const value = snapshot();
    expect(parseMenuBarSnapshot(structuredClone(value))).toEqual(value);
  });

  it('rejects malformed network payloads instead of rendering fabricated state', () => {
    expect(() => parseMenuBarSnapshot({ ...snapshot(), summary: { ...snapshot().summary, onlineDevices: -1 } })).toThrow(/onlineDevices/);
    expect(() => parseMenuBarSnapshot({ ...snapshot(), devices: [{ ...device(), metrics: { ...device().metrics, cpuPercent: 101 } }] })).toThrow(/cpuPercent/);
    expect(() => parseMenuBarSnapshot({ ...snapshot(), core: { ...snapshot().core, connected: false } })).toThrow(/core.connected/);
  });

  it('clamps only display progress, leaving the network parser strict', () => {
    expect(jobProgress({ ...({} as never), progress: 118 })).toBe(100);
    expect(jobProgress({ ...({} as never), progress: -4 })).toBe(0);
    expect(jobProgress({ ...({} as never), progress: undefined })).toBeUndefined();
  });
});

describe('menu bar guardrails', () => {
  const base = { kind: 'codex', id: 'a', sessionId: 's', requestId: 1, deviceId: 'd', title: 'Run command', detail: 'git status', method: 'item/commandExecution/requestApproval', createdAt: '2026-07-16T12:00:00.000Z' } as const;

  it('keeps destructive, permission, input, and MCP approvals review-only', () => {
    expect(approvalNeedsReview({ ...base, detail: 'sudo rm -rf /tmp/build' })).toBe(true);
    expect(approvalNeedsReview({ ...base, method: 'item/permissions/requestApproval' })).toBe(true);
    expect(approvalNeedsReview({ ...base, method: 'item/tool/requestUserInput' })).toBe(true);
    expect(approvalNeedsReview({ ...base, method: 'mcpServer/elicitation/request' })).toBe(true);
    expect(approvalNeedsReview(base)).toBe(false);
  });

  it('creates a one-turn decision only for a low-risk Codex approval', () => {
    expect(codexApprovalDecision(base, true)).toEqual({ decision: 'accept' });
    expect(() => codexApprovalDecision({ ...base, detail: 'Deploy to production' }, true)).toThrow(/requires review/);
  });

  it('uses each Codex protocol method’s safe decline shape', () => {
    expect(codexApprovalDecision({ ...base, method: 'item/tool/requestUserInput' }, false)).toEqual({ answers: {} });
    expect(codexApprovalDecision({ ...base, method: 'item/permissions/requestApproval' }, false)).toEqual({ permissions: {}, scope: 'turn' });
    expect(codexApprovalDecision({ ...base, method: 'mcpServer/elicitation/request' }, false)).toEqual({ action: 'decline', content: null, _meta: null });
    expect(codexApprovalDecision(base, false)).toEqual({ decision: 'decline' });
  });

  it('does not expose power actions unless the Agent reports the capability', () => {
    expect(canPowerDevice(device(), 'shutdown')).toBe(true);
    expect(canPowerDevice(device({ capabilities: { ...device().capabilities, labels: [] } }), 'shutdown')).toBe(false);
    expect(canPowerDevice(device({ status: 'sleeping', capabilities: { ...device().capabilities, wakeOnLan: true } }), 'wake')).toBe(true);
  });

  it('selects an online authenticated Codex device by project preference and load', () => {
    const busy = device({ id: 'busy', status: 'busy', activeJobCount: 2 });
    const idle = device({ id: 'idle', activeJobCount: 0 });
    const preferred = device({ id: 'preferred', activeJobCount: 1 });
    const offline = device({ id: 'offline', status: 'offline' });
    expect(bestCodexDevice([busy, idle, preferred, offline])?.id).toBe('idle');
    expect(bestCodexDevice([busy, idle, preferred, offline], ['preferred'])?.id).toBe('preferred');
  });

  it('treats high-risk pipeline gates as review-only too', () => {
    const approval: MenuBarApproval = { kind: 'pipeline', id: 'p', pipelineRunId: 'run', pipelineId: 'pipe', nodeRunId: 'node-run', nodeId: 'node', title: 'Production deployment', detail: 'Deploy artifact', createdAt: '2026-07-16T12:00:00.000Z' };
    expect(approvalNeedsReview(approval)).toBe(true);
  });
});
