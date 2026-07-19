import { describe, expect, it } from 'vitest';
import { isTailscaleHttpHost, validatedExternalUrl } from '../src/main/external-url.js';

describe('external URL validation', () => {
  it('allows private Tailscale HTTP previews', () => {
    expect(validatedExternalUrl('http://100.64.0.10:33664/')).toBe('http://100.64.0.10:33664/');
    expect(validatedExternalUrl('http://[fd7a:115c:a1e0::1]:3000/')).toBe('http://[fd7a:115c:a1e0::1]:3000/');
    expect(isTailscaleHttpHost('100.64.0.1')).toBe(true);
    expect(isTailscaleHttpHost('100.127.255.254')).toBe(true);
  });

  it('rejects ordinary insecure websites and lookalike addresses', () => {
    expect(() => validatedExternalUrl('http://example.com/')).toThrow();
    expect(() => validatedExternalUrl('http://192.168.1.5:3000/')).toThrow();
    expect(() => validatedExternalUrl('http://100.128.0.1:3000/')).toThrow();
    expect(() => validatedExternalUrl('http://100.64.0.10.example.com/')).toThrow();
  });

  it('preserves the existing secure and native protocol allowlist', () => {
    expect(validatedExternalUrl('https://example.com/')).toBe('https://example.com/');
    expect(validatedExternalUrl('vnc://fleet-host/')).toBe('vnc://fleet-host/');
    expect(() => validatedExternalUrl('file:///tmp/fleet')).toThrow();
  });
});
