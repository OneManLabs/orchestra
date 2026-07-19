import { describe, expect, it } from 'vitest';
import { FleetSimulator, syntheticMetrics } from '../src/simulator.js';

describe('Fleet simulator', () => {
  it('generates valid bounded telemetry', () => {
    const metrics = syntheticMetrics(0, 1_700_000_000_000);
    expect(metrics.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(metrics.gpus).toHaveLength(1);
    expect(metrics.sampledAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('rejects unsafe simulation sizes and failure rates', () => {
    expect(() => new FleetSimulator({ coreUrl: 'http://localhost', token: 'x', count: 0, intervalMs: 1_000, latencyMs: 0, failureRate: 0, prefix: 'x' })).toThrow('count');
    expect(() => new FleetSimulator({ coreUrl: 'http://localhost', token: 'x', count: 1, intervalMs: 1_000, latencyMs: 0, failureRate: 2, prefix: 'x' })).toThrow('Failure rate');
    expect(() => new FleetSimulator({ coreUrl: 'ftp://localhost', token: 'x', count: 1, intervalMs: 1_000, latencyMs: 0, failureRate: 0, prefix: 'x' })).toThrow('Core URL');
    expect(() => new FleetSimulator({ coreUrl: 'http://localhost', token: 'x', count: 1, intervalMs: Number.NaN, latencyMs: 0, failureRate: 0, prefix: 'x' })).toThrow('interval');
  });
});
