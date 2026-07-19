import { describe, expect, it } from 'vitest';
import {
  isTrustedSender,
  isUsableMenuBarAnchor,
  menuBarPulseSignature,
  parseTailscaleStatus,
  positionMenuBarWindow,
  sanitizeOpenMainTarget,
  shouldStartMenuBarOnly,
  trayIconBitmap,
  trayPresentation,
  validateExitNodeInput
} from '../src/main/menu-bar.js';

function snapshot(summary: Record<string, unknown> = {}): unknown {
  return {
    summary: {
      status: 'healthy', activeJobs: 0, pendingApprovals: 0, openCriticalAlerts: 0,
      openWarnings: 0, failedJobs: 0, degradedDevices: 0, ...summary
    },
    jobs: [], devices: [], recent: []
  };
}

describe('menu-bar tray presentation', () => {
  it('uses disconnected, critical, warning, activity, and healthy precedence', () => {
    expect(trayPresentation(snapshot(), false).state).toBe('disconnected');
    expect(trayPresentation(snapshot({ activeJobs: 2 }), true)).toMatchObject({ state: 'activity', title: '◆ 2' });
    expect(trayPresentation(snapshot({ activeJobs: 2, failedJobs: 1 }), true).state).toBe('warning');
    expect(trayPresentation(snapshot({ status: 'degraded', pendingApprovals: 1 }), true)).toMatchObject({ state: 'critical', title: '◆ !' });
    expect(trayPresentation(snapshot(), true)).toMatchObject({ state: 'healthy', title: '◆' });
  });

  it('generates distinct, fixed-size monochrome 2x template bitmaps', () => {
    const values = ['healthy', 'activity', 'warning', 'critical', 'disconnected'] as const;
    const icons = values.map((value) => trayIconBitmap(value, 2));
    expect(new Set(icons.map((icon) => Buffer.from(icon).toString('base64'))).size).toBe(values.length);
    for (const icon of icons) {
      expect(icon).toHaveLength(38 * 38 * 4);
      expect(icon.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
      expect(icon.every((value, index) => index % 4 === 3 || value === 0)).toBe(true);
    }
    expect(() => trayIconBitmap('healthy', 0)).toThrow('scale factor');
  });

  it('pulses only for meaningful state changes, not job progress ticks', () => {
    const before = { ...snapshot(), jobs: [{ id: 'job-1', status: 'running', progress: 10 }] };
    const progress = { ...snapshot(), jobs: [{ id: 'job-1', status: 'running', progress: 90 }] };
    const completed = { ...snapshot(), jobs: [{ id: 'job-1', status: 'completed', progress: 100 }] };
    expect(menuBarPulseSignature(before, true)).toBe(menuBarPulseSignature(progress, true));
    expect(menuBarPulseSignature(before, true)).not.toBe(menuBarPulseSignature(completed, true));
  });
});

describe('menu-bar window placement', () => {
  it('centers beneath the tray while clamping to the display work area', () => {
    expect(positionMenuBarWindow(
      { x: 1420, y: 0, width: 20, height: 24 },
      { width: 408, height: 680 },
      { x: 0, y: 24, width: 1440, height: 876 }
    )).toEqual({ x: 1032, y: 30 });
  });

  it('opens above a bottom-mounted tray when there is no room below', () => {
    expect(positionMenuBarWindow(
      { x: 600, y: 876, width: 20, height: 24 },
      { width: 408, height: 680 },
      { x: 0, y: 0, width: 1440, height: 876 }
    )).toEqual({ x: 406, y: 190 });
  });

  it('rejects the bottom-left startup sentinel reported before macOS lays out the tray', () => {
    expect(isUsableMenuBarAnchor(
      { x: 0, y: 982, width: 35, height: 22 },
      { x: 0, y: 0, width: 1512, height: 982 }
    )).toBe(false);
    expect(isUsableMenuBarAnchor(
      { x: 1370, y: 2, width: 35, height: 22 },
      { x: 0, y: 0, width: 1512, height: 982 }
    )).toBe(true);
  });
});

describe('menu-bar launch behavior', () => {
  it('keeps login-item and explicit hidden launches menu-bar-only', () => {
    expect(shouldStartMenuBarOnly(['/Applications/Fleet Canvas', '--hidden'], {})).toBe(true);
    expect(shouldStartMenuBarOnly(['/Applications/Fleet Canvas'], { wasOpenedAsHidden: true })).toBe(true);
    expect(shouldStartMenuBarOnly(['/Applications/Fleet Canvas'], { wasOpenedAtLogin: true })).toBe(true);
    expect(shouldStartMenuBarOnly(['/Applications/Fleet Canvas'], {})).toBe(false);
  });
});

describe('menu-bar privileged input validation', () => {
  it('sanitizes allowlisted deep links and rejects extra or unsafe fields', () => {
    expect(sanitizeOpenMainTarget({ page: 'canvas', deviceId: 'fleet-device:1', tab: 'codex', entityId: 'session-1' }))
      .toEqual({ page: 'canvas', deviceId: 'fleet-device:1', tab: 'codex', entityId: 'session-1' });
    expect(() => sanitizeOpenMainTarget({ page: 'admin' })).toThrow('Invalid Orchestra Canvas page');
    expect(() => sanitizeOpenMainTarget({ page: 'canvas', deviceId: '../escape' })).toThrow('Invalid deviceId');
    expect(() => sanitizeOpenMainTarget({ page: 'canvas', command: 'rm -rf /' })).toThrow('Unsupported');
  });

  it('accepts only inert exit-node identifiers and booleans', () => {
    expect(validateExitNodeInput({ id: '100.64.0.12', allowLan: true })).toEqual({ id: '100.64.0.12', allowLan: true });
    expect(validateExitNodeInput({ id: null })).toEqual({ id: null });
    expect(() => validateExitNodeInput({ id: '--reset' })).toThrow('Invalid exit-node');
    expect(() => validateExitNodeInput({ id: 'home; touch /tmp/pwned' })).toThrow('Invalid exit-node');
    expect(() => validateExitNodeInput({ id: null, extra: true })).toThrow('Unsupported');
  });

  it('restricts IPC senders by native window role', () => {
    expect(isTrustedSender(10, 10, 20, ['main'])).toBe(true);
    expect(isTrustedSender(20, 10, 20, ['menu-bar'])).toBe(true);
    expect(isTrustedSender(20, 10, 20, ['main'])).toBe(false);
    expect(isTrustedSender(99, 10, 20, ['main', 'menu-bar'])).toBe(false);
  });
});

describe('Tailscale status parsing', () => {
  it('reports the selected exit node and only eligible peers', () => {
    const result = parseTailscaleStatus({
      BackendState: 'Running',
      ExitNodeAllowLANAccess: true,
      Peer: {
        a: { ID: 'node-a', DNSName: 'home.tailnet.ts.net.', HostName: 'home', Online: true, ExitNode: true, ExitNodeOption: true, TailscaleIPs: ['100.64.0.1'] },
        b: { ID: 'node-b', HostName: 'worker', Online: true, ExitNodeOption: false, TailscaleIPs: ['100.64.0.2'] }
      }
    });
    expect(result).toMatchObject({ available: true, connected: true, selectedId: '100.64.0.1', selectedName: 'home.tailnet.ts.net', allowLan: true, backendState: 'Running' });
    expect(result.options).toEqual([{ id: '100.64.0.1', name: 'home.tailnet.ts.net', online: true, addresses: ['100.64.0.1'] }]);
  });

  it('rejects malformed status output', () => {
    expect(() => parseTailscaleStatus(null)).toThrow('invalid status');
  });
});
