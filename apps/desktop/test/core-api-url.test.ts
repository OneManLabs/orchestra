import { describe, expect, it } from 'vitest';
import { resolveFleetCoreApiUrl } from '../src/main/core-api-url';

describe('Fleet Core desktop request URLs', () => {
  it('allows encoded workspace query paths without weakening the API pathname boundary', () => {
    const result = resolveFleetCoreApiUrl(
      'http://100.64.0.10:4780',
      '/api/devices/mbp/workspace?path=%2FUsers%2Fexample%2FProjects&cursor=250',
    );
    const url = new URL(result);
    expect(url.origin).toBe('http://100.64.0.10:4780');
    expect(url.pathname).toBe('/api/devices/mbp/workspace');
    expect(url.searchParams.get('path')).toBe('/Users/example/Projects');
    expect(url.searchParams.get('cursor')).toBe('250');
  });

  it('allows Windows and NAS paths in query values', () => {
    const result = resolveFleetCoreApiUrl(
      'https://fleet.example.ts.net',
      `/api/devices/gpu/workspace?path=${encodeURIComponent('D:\\Projects\\fleet')}`,
    );
    expect(new URL(result).searchParams.get('path')).toBe('D:\\Projects\\fleet');
  });

  it('rejects non-API, cross-origin, traversal, malformed, and fragment paths', () => {
    for (const path of [
      '/health',
      '//evil.example/api/devices',
      'https://evil.example/api/devices',
      '/api/../health',
      '/api/%2e%2e/health',
      '/api/devices\\escape',
      '/api/devices#outside',
      '/api/%zz',
    ]) {
      expect(() => resolveFleetCoreApiUrl('http://127.0.0.1:4780', path)).toThrow();
    }
  });
});
