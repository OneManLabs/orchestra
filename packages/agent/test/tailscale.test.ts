import { describe, expect, it } from 'vitest';
import { isTailscaleAddress, parseTailscaleStatus } from '../src/tailscale.js';

describe('parseTailscaleStatus', () => {
  it('extracts the stable IPv4 address and normalized DNS name', () => {
    expect(parseTailscaleStatus(JSON.stringify({
      Self: { DNSName: 'worker.tailnet-name.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.72.4.9'] },
    }))).toEqual({ ip: '100.72.4.9', dnsName: 'worker.tailnet-name.ts.net' });
  });

  it('returns an empty identity for invalid output', () => {
    expect(parseTailscaleStatus('Tailscale is stopped')).toEqual({});
  });

  it('accepts only addresses inside Tailscale address ranges', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.127.255.254')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0::1234')).toBe(true);
    expect(isTailscaleAddress('100.63.255.255')).toBe(false);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('192.168.1.5')).toBe(false);
  });
});
