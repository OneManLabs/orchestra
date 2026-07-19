export const DEFAULT_DEVICE_INSPECTOR_WIDTH = 476;
export const MIN_DEVICE_INSPECTOR_WIDTH = 360;
export const DEVICE_INSPECTOR_MOBILE_BREAKPOINT = 850;
export const DEVICE_INSPECTOR_COMPACT_NAV_BREAKPOINT = 1180;
export const DEVICE_INSPECTOR_FULL_NAV_WIDTH = 218;
export const DEVICE_INSPECTOR_COMPACT_NAV_WIDTH = 72;

const STORAGE_KEY = 'fleet.device-inspector-width';

export function maximumDeviceInspectorWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return DEFAULT_DEVICE_INSPECTOR_WIDTH;
  if (viewportWidth <= DEVICE_INSPECTOR_MOBILE_BREAKPOINT) return Math.floor(viewportWidth);
  const navigationWidth = viewportWidth <= DEVICE_INSPECTOR_COMPACT_NAV_BREAKPOINT
    ? DEVICE_INSPECTOR_COMPACT_NAV_WIDTH
    : DEVICE_INSPECTOR_FULL_NAV_WIDTH;
  return Math.max(MIN_DEVICE_INSPECTOR_WIDTH, Math.floor(viewportWidth - navigationWidth));
}

export function clampDeviceInspectorWidth(width: number, viewportWidth: number): number {
  const maximum = maximumDeviceInspectorWidth(viewportWidth);
  const minimum = Math.min(MIN_DEVICE_INSPECTOR_WIDTH, maximum);
  const candidate = Number.isFinite(width) ? width : DEFAULT_DEVICE_INSPECTOR_WIDTH;
  return Math.round(Math.min(maximum, Math.max(minimum, candidate)));
}

export function readDeviceInspectorWidth(storage: Pick<Storage, 'getItem'> | undefined): number {
  if (!storage) return DEFAULT_DEVICE_INSPECTOR_WIDTH;
  try {
    const stored = Number(storage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_DEVICE_INSPECTOR_WIDTH;
  } catch {
    return DEFAULT_DEVICE_INSPECTOR_WIDTH;
  }
}

export function writeDeviceInspectorWidth(storage: Pick<Storage, 'setItem'> | undefined, width: number): void {
  if (!storage || !Number.isFinite(width)) return;
  try {
    storage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Resizing should still work when browser storage is unavailable.
  }
}
