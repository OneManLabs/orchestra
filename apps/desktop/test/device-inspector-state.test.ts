import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEVICE_INSPECTOR_WIDTH,
  MIN_DEVICE_INSPECTOR_WIDTH,
  clampDeviceInspectorWidth,
  maximumDeviceInspectorWidth,
  readDeviceInspectorWidth,
  writeDeviceInspectorWidth,
} from '../src/renderer/lib/device-inspector-state.js';

describe('device inspector width state', () => {
  it('clamps resizing to usable desktop bounds', () => {
    expect(clampDeviceInspectorWidth(120, 1440)).toBe(MIN_DEVICE_INSPECTOR_WIDTH);
    expect(clampDeviceInspectorWidth(2_000, 1440)).toBe(1_222);
    expect(maximumDeviceInspectorWidth(900)).toBe(828);
    expect(clampDeviceInspectorWidth(900, 900)).toBe(828);
  });

  it('expands to the left navigation edge at both desktop navigation sizes', () => {
    expect(maximumDeviceInspectorWidth(1_440)).toBe(1_440 - 218);
    expect(maximumDeviceInspectorWidth(1_180)).toBe(1_180 - 72);
  });

  it('allows the responsive mobile panel to fill a narrow viewport', () => {
    expect(maximumDeviceInspectorWidth(320)).toBe(320);
    expect(clampDeviceInspectorWidth(DEFAULT_DEVICE_INSPECTOR_WIDTH, 320)).toBe(320);
  });

  it('reads and writes a persisted preferred width safely', () => {
    const setItem = vi.fn();
    expect(readDeviceInspectorWidth({ getItem: () => '712' })).toBe(712);
    expect(readDeviceInspectorWidth({ getItem: () => 'not-a-number' })).toBe(DEFAULT_DEVICE_INSPECTOR_WIDTH);

    writeDeviceInspectorWidth({ setItem }, 711.7);
    expect(setItem).toHaveBeenCalledWith('fleet.device-inspector-width', '712');
  });
});
