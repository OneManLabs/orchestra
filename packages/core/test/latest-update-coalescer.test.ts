import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestUpdateCoalescer } from '../src/latest-update-coalescer.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('LatestUpdateCoalescer', () => {
  it('publishes the latest state once per interval during a stream', () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const coalescer = new LatestUpdateCoalescer(60);

    coalescer.schedule('session', () => published.push('first'));
    vi.advanceTimersByTime(20);
    coalescer.schedule('session', () => published.push('latest'));
    vi.advanceTimersByTime(39);
    expect(published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(published).toEqual(['latest']);

    coalescer.schedule('session', () => published.push('next'));
    vi.advanceTimersByTime(60);
    expect(published).toEqual(['latest', 'next']);
  });

  it('flushes final state immediately and cancels the trailing update', () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const coalescer = new LatestUpdateCoalescer(60);

    coalescer.schedule('session', () => published.push('delta'));
    vi.advanceTimersByTime(20);
    coalescer.publishNow('session', () => published.push('completed'));
    expect(published).toEqual(['completed']);
    vi.advanceTimersByTime(100);
    expect(published).toEqual(['completed']);
  });

  it('keeps session streams independent and clears timers on shutdown', () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const coalescer = new LatestUpdateCoalescer(60);

    coalescer.schedule('codex', () => published.push('codex'));
    coalescer.schedule('system', () => published.push('system'));
    coalescer.clear();
    vi.advanceTimersByTime(100);
    expect(published).toEqual([]);
  });
});
