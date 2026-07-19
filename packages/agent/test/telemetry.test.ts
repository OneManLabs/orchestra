import { describe, expect, it } from 'vitest';
import { collectMetrics, normalizeBattery, normalizeFans, normalizeGpus, normalizeServiceHealth, sumGpuPowerDraw } from '../src/telemetry.js';

describe('extended device telemetry', () => {
  it('omits battery telemetry when the platform reports no battery', () => {
    expect(normalizeBattery({ hasBattery: false, percent: 0 } as never)).toBeUndefined();
  });

  it('normalizes only real battery fields and omits unsupported time/cycle values', () => {
    expect(normalizeBattery({
      hasBattery: true,
      percent: 72.34,
      isCharging: true,
      acConnected: true,
      timeRemaining: 48,
      cycleCount: 231,
    } as never)).toEqual({
      state: 'charging', percent: 72.3, isCharging: true, acConnected: true,
      timeRemainingMinutes: 48, cycleCount: 231,
    });
    expect(normalizeBattery({
      hasBattery: true,
      percent: 100,
      isCharging: false,
      acConnected: true,
      timeRemaining: null,
      cycleCount: 0,
    } as never)).toEqual({ state: 'full', percent: 100, isCharging: false, acConnected: true });
  });

  it('preserves GPU-provided fan and power readings without inventing system-wide power', () => {
    const gpus = normalizeGpus([
      { vendor: 'NVIDIA', model: 'RTX', bus: 'PCI', vram: 16_384, vramDynamic: false, fanSpeed: 41, powerDraw: 122.45, powerLimit: 285 },
      { vendor: 'Apple', model: 'Integrated', bus: 'SOC', vram: null, vramDynamic: true },
    ] as never);
    expect(gpus[0]).toMatchObject({ fanSpeedPercent: 41, powerDrawWatts: 122.5, powerLimitWatts: 285 });
    expect(gpus[1]?.fanSpeedPercent).toBeUndefined();
    expect(normalizeFans(gpus)).toEqual([{ label: 'RTX', speedPercent: 41 }]);
    expect(sumGpuPowerDraw(gpus)).toBe(122.5);
    expect(sumGpuPowerDraw([gpus[1]!])).toBeUndefined();
  });

  it('counts service health only when the provider returns service records', () => {
    expect(normalizeServiceHealth(undefined)).toBeUndefined();
    expect(normalizeServiceHealth([])).toBeUndefined();
    expect(normalizeServiceHealth([{ running: true }, { running: false }, { running: true }] as never)).toEqual({ total: 3, running: 2, stopped: 1 });
  });

  it('collects real process telemetry and keeps every optional reading internally consistent', async () => {
    const metrics = await collectMetrics();
    expect(metrics.processCount).toBeGreaterThan(0);
    expect(metrics.runningProcessCount).toBeGreaterThanOrEqual(0);
    if (metrics.battery) expect(metrics.battery.percent).toBeGreaterThanOrEqual(0);
    if (metrics.powerDrawWatts !== undefined) expect(metrics.powerDrawSource).toBe('gpu');
    if (metrics.serviceHealth) expect(metrics.serviceHealth.running + metrics.serviceHealth.stopped).toBe(metrics.serviceHealth.total);
  });
});
