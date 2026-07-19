import type { AgentToCoreMessage, RemoteDesktopSession } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { RemoteDesktopManager } from '../src/remote-desktop.js';

describe('remote desktop metadata', () => {
  it('creates and closes a credential-free external session', async () => {
    const events: AgentToCoreMessage[] = [];
    const manager = new RemoteDesktopManager((event) => events.push(event));
    const now = new Date().toISOString();
    const session: RemoteDesktopSession = {
      id: 'desktop-1', deviceId: 'device-1', protocol: 'external', status: 'starting',
      viewOnly: false, recording: false, createdAt: now,
    };
    expect(await manager.start(session, { url: 'vnc://worker.example.test' })).toMatchObject({ connectionUrl: 'vnc://worker.example.test' });
    manager.stop(session.id);
    expect(events.map((event) => event.type)).toEqual(['desktop.event', 'desktop.event']);
  });

  it('rejects embedded credentials and unapproved URL schemes', async () => {
    const manager = new RemoteDesktopManager(() => {});
    const session: RemoteDesktopSession = {
      id: 'desktop-2', deviceId: 'device-1', protocol: 'external', status: 'starting',
      viewOnly: false, recording: false, createdAt: new Date().toISOString(),
    };
    await expect(manager.start(session, { url: 'https://user:secret@example.test' })).rejects.toThrow(/credentials/);
    await expect(manager.start(session, { url: 'file:///etc/passwd' })).rejects.toThrow(/scheme/);
  });
});
