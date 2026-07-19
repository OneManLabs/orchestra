import { describe, expect, it } from 'vitest';
import { buildAgentWebSocketUrl, normalizeProjectRoots, parseBoolean, parseProjectRoots, parseRole } from '../src/config.js';

describe('agent configuration utilities', () => {
  it('builds an authenticated websocket endpoint from HTTP Core URLs', () => {
    const url = new URL(buildAgentWebSocketUrl('https://fleet.example.test/base/'));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/base/ws/agent');
    expect(url.searchParams.get('token')).toBeNull();
  });

  it('does not duplicate an explicit agent endpoint', () => {
    const url = new URL(buildAgentWebSocketUrl('ws://127.0.0.1:4780/ws/agent/'));
    expect(url.pathname).toBe('/ws/agent');
  });

  it('rejects unknown roles without widening the protocol type', () => {
    expect(parseRole('gpu')).toBe('gpu');
    expect(parseRole('administrator')).toBe('unknown');
  });

  it('normalizes and deduplicates project roots', () => {
    const roots = normalizeProjectRoots(['.', './']);
    expect(roots).toEqual([process.cwd()]);
  });

  it('accepts the documented comma-separated project root format', () => {
    expect(parseProjectRoots('/projects/one,/volumes/nas/projects')).toEqual(['/projects/one', '/volumes/nas/projects']);
  });

  it('requires explicit truthy syntax for dangerous feature flags', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('1', false)).toBe(true);
    expect(parseBoolean('unexpected', false)).toBe(false);
  });
});
