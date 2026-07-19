import { describe, expect, it } from 'vitest';
import { bytes, clamp, relativeTime } from '../src/utils.js';

describe('shared presentation utilities', () => {
  it('formats byte counts and bounds percentages', () => {
    expect(bytes(16 * 1024 ** 3)).toBe('16 GB');
    expect(clamp(180)).toBe(100);
    expect(clamp(-1)).toBe(0);
  });

  it('formats recent relative time deterministically', () => {
    const now = Date.parse('2026-07-15T12:00:00.000Z');
    expect(relativeTime('2026-07-15T11:58:00.000Z', now)).toBe('2m ago');
  });
});
