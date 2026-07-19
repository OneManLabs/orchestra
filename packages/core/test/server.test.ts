import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Device } from '@fleet/shared';
import { startFleetCore, type FleetCore } from '../src/server.js';

const cores: FleetCore[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function core(): Promise<FleetCore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-core-'));
  directories.push(directory);
  const instance = await startFleetCore({ listen: false, dataDir: directory, token: 'test-token', allowUnauthenticatedLoopback: true });
  cores.push(instance);
  return instance;
}

function testDevice(): Device {
  const now = new Date().toISOString();
  return {
    id: 'gpu-device',
    name: 'Demo GPU',
    hostname: 'demo-gpu.local',
    role: 'gpu',
    status: 'online',
    platform: 'win32',
    arch: 'x64',
    osName: 'Windows',
    osVersion: '11',
    agentVersion: '2.0.0',
    capabilities: { codex: true, git: true, docker: false, tailscale: true, cuda: true, mlx: false, node: true, wakeOnLan: true, shell: 'cmd.exe', labels: [] },
    metrics: {
      cpu: { model: 'CPU', cores: 16, usagePercent: 22, temperatureCelsius: 55 },
      memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, usagePercent: 25 },
      storage: [{ mount: 'C:', totalBytes: 1024 ** 4, usedBytes: 256 * 1024 ** 3, usagePercent: 25 }],
      gpus: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 5070 Ti', usagePercent: 61, temperatureCelsius: 67, vramTotalBytes: 16 * 1024 ** 3, vramUsedBytes: 4 * 1024 ** 3 }],
      network: { rxBytesPerSecond: 1024, txBytesPerSecond: 512 },
      uptimeSeconds: 3600,
      sampledAt: now,
    },
    projectRoots: ['C:\\Projects'],
    position: { x: 0, y: 0 },
    lastSeenAt: now,
    connectedAt: now,
    activeJobIds: [],
    activeSessionIds: [],
  };
}

describe('Fleet Core HTTP API', () => {
  it('backfills evolving titles for legacy sessions while preserving deliberate names', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-core-session-titles-'));
    directories.push(directory);
    const original = await startFleetCore({ listen: false, dataDir: directory, token: 'test-token', allowUnauthenticatedLoopback: true });
    cores.push(original);
    const now = new Date().toISOString();
    original.store.state.sessions.push(
      {
        id: 'legacy-generated', deviceId: 'device', cwd: '/projects/fleet', title: 'Session on MacBook Pro',
        permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'stopped', createdAt: now, updatedAt: now,
        events: [{ id: 'event', at: now, type: 'user', text: 'Fix the API connection on macOS' }], pendingApprovals: [],
      },
      {
        id: 'legacy-manual', deviceId: 'device', cwd: '/projects/fleet', title: 'Release control room',
        permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'stopped', createdAt: now, updatedAt: now,
        events: [{ id: 'event-2', at: now, type: 'user', text: 'Fix the API connection on macOS' }], pendingApprovals: [],
      },
      {
        id: 'legacy-follow-up', deviceId: 'device', cwd: '/projects/fleet', title: 'Run', titleSource: 'generated',
        permissionMode: 'workspace-write', approvalPolicy: 'on-request', status: 'stopped', createdAt: now, updatedAt: now,
        events: [
          { id: 'event-3', at: now, type: 'user', text: 'Build a landing page for Fleet Canvas.' },
          { id: 'event-4', at: now, type: 'user', text: 'You run it' },
        ], pendingApprovals: [],
      },
    );
    original.store.markDirty();
    await original.close();

    const reopened = await startFleetCore({ listen: false, dataDir: directory, token: 'test-token', allowUnauthenticatedLoopback: true });
    cores.push(reopened);
    expect(reopened.store.state.sessions.find((session) => session.id === 'legacy-generated')).toMatchObject({
      title: 'Fix API Connection macOS', titleSource: 'generated',
    });
    expect(reopened.store.state.sessions.find((session) => session.id === 'legacy-manual')).toMatchObject({
      title: 'Release control room', titleSource: 'manual',
    });
    expect(reopened.store.state.sessions.find((session) => session.id === 'legacy-follow-up')).toMatchObject({
      title: 'Orchestra Landing Page', titleSource: 'generated',
    });
  });

  it('rejects weak recovery credentials on non-loopback listeners', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-core-'));
    directories.push(directory);
    await expect(startFleetCore({ listen: false, host: '0.0.0.0', dataDir: directory, token: 'short' })).rejects.toThrow('at least 32 bytes');
  });

  it('requires authentication on loopback unless the development bypass is explicitly enabled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-core-auth-'));
    directories.push(directory);
    const token = 'loopback-production-recovery-token-32-bytes';
    const instance = await startFleetCore({ listen: false, dataDir: directory, token, allowUnauthenticatedLoopback: false });
    cores.push(instance);
    const denied = await instance.app.inject({ method: 'GET', url: '/api/snapshot' });
    expect(denied.statusCode).toBe(401);
    const allowed = await instance.app.inject({ method: 'GET', url: '/api/snapshot', headers: { authorization: `Bearer ${token}` } });
    expect(allowed.statusCode).toBe(200);
  });

  it('does not infer the unauthenticated development bypass from listen=false', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-core-auth-default-'));
    directories.push(directory);
    const token = 'loopback-production-recovery-token-default';
    const instance = await startFleetCore({ listen: false, dataDir: directory, token });
    cores.push(instance);
    expect((await instance.app.inject({ method: 'GET', url: '/api/snapshot' })).statusCode).toBe(401);
    expect((await instance.app.inject({ method: 'GET', url: '/api/snapshot', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it('returns a real empty snapshot and persists projects', async () => {
    const instance = await core();
    const snapshot = await instance.app.inject({ method: 'GET', url: '/api/snapshot' });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ version: '2.0.0', devices: [], projects: [], systemConversation: { id: 'fleet-system' }, systemConversations: [{ id: 'fleet-system' }], v2: { schemaVersion: 2 } });

    const created = await instance.app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'Fleet', description: 'Control plane', defaultBranch: 'main', paths: [], preferredDeviceIds: [], commands: {}, artifactPaths: [] },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Fleet', defaultBranch: 'main' });
    expect(instance.store.state.projects).toHaveLength(1);
  });

  it('validates unsafe or incomplete job requests', async () => {
    const instance = await core();
    const response = await instance.app.inject({ method: 'POST', url: '/api/jobs', payload: { name: 'Empty', kind: 'shell' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Shell jobs require a command');
  });

  it('coordinates Codex participant presence, controller transfer, and scoped messaging', async () => {
    const instance = await core();
    const now = new Date().toISOString();
    instance.store.state.sessions.push({
      id: 'shared-session',
      deviceId: 'execution-device',
      cwd: '/projects/fleet',
      title: 'Shared Fleet session',
      permissionMode: 'workspace-write',
      approvalPolicy: 'on-request',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      events: [],
      pendingApprovals: [],
      participants: [],
    });
    const operator = { clientId: 'client-desktop', name: 'Demo Operator', deviceName: 'Demo Desktop' };
    const phone = { clientId: 'client-phone', name: 'Demo Operator', deviceName: 'Demo Phone' };

    const joined = await instance.app.inject({
      method: 'POST',
      url: '/api/sessions/shared-session/presence',
      payload: { ...operator, typing: true },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      participant: { ...operator, typing: true },
      controllerClientId: operator.clientId,
    });
    await instance.app.inject({
      method: 'POST',
      url: '/api/sessions/shared-session/presence',
      payload: { ...phone, typing: false },
    });

    const blocked = await instance.app.inject({
      method: 'POST',
      url: '/api/sessions/shared-session/control',
      payload: phone,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain('currently controls');

    const session = instance.store.state.sessions[0]!;
    session.participants!.find((participant) => participant.clientId === operator.clientId)!.lastSeenAt =
      new Date(Date.now() - 180_000).toISOString();
    const transferred = await instance.app.inject({
      method: 'POST',
      url: '/api/sessions/shared-session/control',
      payload: phone,
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().controllerClientId).toBe(phone.clientId);
    expect(instance.store.state.v2.audit.at(-1)).toMatchObject({
      actorId: phone.clientId,
      action: 'codex.session.control',
      resourceId: 'shared-session',
    });

    session.participants!.find((participant) => participant.clientId === phone.clientId)!.permissions = ['view'];
    const denied = await instance.app.inject({
      method: 'POST',
      url: '/api/sessions/shared-session/messages',
      payload: { text: 'This must not dispatch.', client: phone },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain('cannot message');
  });

  it('updates stored permissions for a stopped Codex thread before it resumes', async () => {
    const instance = await core();
    const now = new Date().toISOString();
    instance.store.state.sessions.push({
      id: 'stopped-session',
      deviceId: 'offline-device',
      cwd: '/projects/fleet',
      title: 'Stopped Fleet session',
      threadId: 'thread-stopped',
      permissionMode: 'workspace-write',
      approvalPolicy: 'on-request',
      status: 'stopped',
      createdAt: now,
      updatedAt: now,
      events: [],
      pendingApprovals: [],
    });

    const response = await instance.app.inject({
      method: 'PATCH',
      url: '/api/sessions/stopped-session/permissions',
      payload: {
        permissionMode: 'read-only',
        client: { clientId: 'client-desktop', name: 'Demo Operator', deviceName: 'Demo Desktop' },
      },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json()).toMatchObject({ permissionMode: 'read-only', approvalPolicy: 'on-request' });
    expect(instance.store.state.v2.audit.at(-1)).toMatchObject({
      actorId: 'client-desktop',
      action: 'codex.session.permissions.update',
      resourceId: 'stopped-session',
      detail: { previousMode: 'workspace-write', permissionMode: 'read-only' },
    });
  });

  it('preserves Core-resolved device context when the System Codex host is unavailable', async () => {
    const instance = await core();
    instance.store.state.devices.push(testDevice());
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/system/messages',
      payload: { text: 'gpu temps on @demo-gpu', client: { clientId: 'demo-phone', name: 'Demo Operator', deviceName: 'Demo Phone' } },
    });
    expect(response.statusCode).toBe(201);
    const conversation = response.json();
    expect(conversation.messages.at(-1)).toMatchObject({
      role: 'assistant',
      references: [{ kind: 'device', deviceId: 'gpu-device' }],
    });
    expect(conversation.messages.at(-1).text).toContain('Orchestra System Codex is unavailable');
    expect(conversation.messages.at(-2)).toMatchObject({
      role: 'user',
      mentions: [{ token: '@demo-gpu', deviceIds: ['gpu-device'], status: 'resolved' }],
    });
  });

  it('clears the active Fleet System chat and resets its hidden Codex context', async () => {
    const instance = await core();
    const now = new Date().toISOString();
    instance.store.state.systemConversation.messages.push({
      id: 'operator-message',
      at: now,
      role: 'user',
      text: 'status of @demo-storage',
      mentions: [],
      references: [],
    });
    instance.store.state.systemConversation.codexSessionId = 'hidden-system-session';
    instance.store.state.sessions.push({
      id: 'hidden-system-session',
      deviceId: 'core-device',
      cwd: '/tmp',
      title: 'Fleet System Orchestrator',
      kind: 'fleet-system',
      permissionMode: 'read-only',
      approvalPolicy: 'never',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      events: [],
      pendingApprovals: [],
    });

    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/system/clear',
      payload: { client: { clientId: 'demo-desktop', name: 'Demo Operator', deviceName: 'Demo Desktop' } },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json()).toMatchObject({ id: 'fleet-system', messages: [], pendingActions: [] });
    expect(response.json().codexSessionId).toBeUndefined();
    expect(instance.store.state.sessions.some((session) => session.id === 'hidden-system-session')).toBe(false);
    expect(instance.store.state.v2.audit.at(-1)).toMatchObject({
      actorId: 'demo-desktop',
      action: 'system.conversation.clear',
      resourceId: 'fleet-system',
    });
  });

  it('records @device resolution on ordinary Codex messages before dispatch', async () => {
    const instance = await core();
    const device = testDevice();
    instance.store.state.devices.push(device);
    const now = new Date().toISOString();
    instance.store.state.sessions.push({
      id: 'mention-session',
      deviceId: device.id,
      cwd: 'C:\\Projects',
      title: 'Mention context',
      threadId: 'thread',
      permissionMode: 'workspace-write',
      approvalPolicy: 'on-request',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      events: [],
      pendingApprovals: [],
    });
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/sessions/mention-session/messages',
      payload: { text: 'compare gpu temps on @demo-gpu' },
    });
    expect(response.statusCode).toBe(409);
    expect(instance.store.state.sessions[0]!.events[0]).toMatchObject({
      type: 'user',
      text: 'compare gpu temps on @demo-gpu',
      data: { fleetDeviceMentions: [{ token: '@demo-gpu', deviceIds: ['gpu-device'], status: 'resolved' }] },
    });
  });
});
