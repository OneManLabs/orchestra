export type MenuBarVisualState = 'healthy' | 'activity' | 'warning' | 'critical' | 'disconnected';

export interface RectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface OpenMainTarget {
  page?: string;
  deviceId?: string;
  tab?: string;
  entityId?: string;
}

export interface ExitNodeInput {
  id: string | null;
  allowLan?: boolean;
}

export interface ExitNodeOption {
  id: string;
  name: string;
  online: boolean;
  addresses: string[];
}

export interface ExitNodeStatus {
  available: boolean;
  connected: boolean;
  selectedId?: string;
  selectedName?: string;
  allowLan: boolean;
  backendState?: string;
  error?: string;
  options: ExitNodeOption[];
}

export interface TrayPresentation {
  state: MenuBarVisualState;
  title: string;
  tooltip: string;
}

const allowedPages = new Set([
  'overview', 'canvas', 'projects', 'jobs', 'pipelines', 'artifacts', 'telemetry',
  'automation', 'security', 'teams', 'integrations', 'diagnostics', 'activity', 'settings'
]);

const allowedTabs = new Set([
  'overview', 'codex', 'terminal', 'desktop', 'files', 'jobs', 'metrics', 'logs',
  'active', 'queued', 'completed', 'failed', 'approvals', 'alerts', 'history'
]);

const safeIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const safeExitNode = /^[a-zA-Z0-9][a-zA-Z0-9._:%-]{0,254}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function trayPresentation(snapshot: unknown, connected: boolean): TrayPresentation {
  if (!connected) return { state: 'disconnected', title: '◇', tooltip: 'Orchestra Canvas — Core disconnected' };

  const root = record(snapshot);
  const summary = record(root?.summary);
  const core = record(root?.core);
  const activeJobs = finiteNonNegative(summary?.activeJobs);
  const pendingApprovals = finiteNonNegative(summary?.pendingApprovals);
  const criticalAlerts = finiteNonNegative(summary?.openCriticalAlerts);
  const warnings = finiteNonNegative(summary?.openWarnings);
  const failedJobs = finiteNonNegative(summary?.failedJobs);
  const degradedDevices = finiteNonNegative(summary?.degradedDevices);
  const rootState = String(summary?.status ?? core?.status ?? 'healthy');

  if (rootState === 'critical' || pendingApprovals > 0 || criticalAlerts > 0) {
    return {
      state: 'critical',
      title: '◆ !',
      tooltip: `Orchestra Canvas — attention required${pendingApprovals ? ` (${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'})` : ''}`
    };
  }
  if (rootState === 'degraded' || warnings > 0 || failedJobs > 0 || degradedDevices > 0) {
    return { state: 'warning', title: activeJobs ? `◆ ${activeJobs}` : '◆', tooltip: 'Orchestra Canvas — system degraded' };
  }
  if (activeJobs > 0) {
    return { state: 'activity', title: `◆ ${activeJobs}`, tooltip: `Orchestra Canvas — ${activeJobs} active job${activeJobs === 1 ? '' : 's'}` };
  }
  return { state: 'healthy', title: '◆', tooltip: 'Orchestra Canvas — system healthy' };
}

export function menuBarPulseSignature(snapshot: unknown, connected: boolean): string {
  if (!connected) return 'disconnected';
  const root = record(snapshot);
  const summary = record(root?.summary);
  const recent = Array.isArray(root?.recent) ? root.recent : [];
  const jobs = Array.isArray(root?.jobs) ? root.jobs : [];
  const devices = Array.isArray(root?.devices) ? root.devices : [];
  const firstRecent = record(recent[0]);
  return JSON.stringify({
    status: summary?.status,
    activeJobs: finiteNonNegative(summary?.activeJobs),
    failedJobs: finiteNonNegative(summary?.failedJobs),
    approvals: finiteNonNegative(summary?.pendingApprovals),
    warnings: finiteNonNegative(summary?.openWarnings),
    critical: finiteNonNegative(summary?.openCriticalAlerts),
    recent: firstRecent?.id ?? firstRecent?.createdAt ?? null,
    jobs: jobs.map((item) => { const value = record(item); return [value?.id, value?.status]; }),
    devices: devices.map((item) => { const value = record(item); return [value?.id, value?.status]; })
  });
}

/**
 * Build a monochrome BGRA bitmap for Electron's macOS template-image path.
 * NativeImage does not decode SVG on macOS, so drawing the 2x representation
 * directly keeps the tray asset crisp without bundling platform raster files.
 */
export function trayIconBitmap(state: MenuBarVisualState, scaleFactor = 2): Uint8Array {
  if (!Number.isInteger(scaleFactor) || scaleFactor < 1 || scaleFactor > 4) throw new Error('Invalid tray icon scale factor');
  const width = 19 * scaleFactor;
  const bytes = new Uint8Array(width * width * 4);
  const baseAlpha = state === 'disconnected' ? 0.42 : 1;

  const setAlpha = (x: number, y: number, alpha: number, clear = false) => {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= width) return;
    const index = (py * width + px) * 4 + 3;
    const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    bytes[index] = clear ? Math.min(bytes[index]!, 255 - value) : Math.max(bytes[index]!, value);
  };
  const line = (from: [number, number], to: [number, number], stroke = 1.55, alpha = 1, clear = false) => {
    const [x1, y1] = from.map((value) => value * scaleFactor) as [number, number];
    const [x2, y2] = to.map((value) => value * scaleFactor) as [number, number];
    const radius = stroke * scaleFactor / 2;
    const minX = Math.floor(Math.min(x1, x2) - radius - 1), maxX = Math.ceil(Math.max(x1, x2) + radius + 1);
    const minY = Math.floor(Math.min(y1, y2) - radius - 1), maxY = Math.ceil(Math.max(y1, y2) + radius + 1);
    const dx = x2 - x1, dy = y2 - y1, lengthSquared = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const t = lengthSquared ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (coverage) setAlpha(x, y, coverage * alpha, clear);
    }
  };
  const disc = (cx: number, cy: number, radius: number, alpha = 1, clear = false) => {
    const centerX = cx * scaleFactor, centerY = cy * scaleFactor, scaledRadius = radius * scaleFactor;
    for (let y = Math.floor(centerY - scaledRadius - 1); y <= Math.ceil(centerY + scaledRadius + 1); y += 1) {
      for (let x = Math.floor(centerX - scaledRadius - 1); x <= Math.ceil(centerX + scaledRadius + 1); x += 1) {
        const coverage = Math.max(0, Math.min(1, scaledRadius + 0.5 - Math.hypot(x - centerX, y - centerY)));
        if (coverage) setAlpha(x, y, coverage * alpha, clear);
      }
    }
  };
  const triangle = (points: [[number, number], [number, number], [number, number]]) => {
    const a: [number, number] = [points[0][0] * scaleFactor, points[0][1] * scaleFactor];
    const b: [number, number] = [points[1][0] * scaleFactor, points[1][1] * scaleFactor];
    const c: [number, number] = [points[2][0] * scaleFactor, points[2][1] * scaleFactor];
    const sign = (p: [number, number], v1: [number, number], v2: [number, number]) => (p[0] - v2[0]) * (v1[1] - v2[1]) - (v1[0] - v2[0]) * (p[1] - v2[1]);
    for (let y = Math.floor(Math.min(a[1], b[1], c[1])); y <= Math.ceil(Math.max(a[1], b[1], c[1])); y += 1) {
      for (let x = Math.floor(Math.min(a[0], b[0], c[0])); x <= Math.ceil(Math.max(a[0], b[0], c[0])); x += 1) {
        const p: [number, number] = [x, y];
        const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) setAlpha(x, y, 1);
      }
    }
  };

  const hex: Array<[number, number]> = [[5, 5.25], [9, 2.8], [13, 5.25], [13, 9.85], [9, 12.3], [5, 9.85], [5, 5.25]];
  for (let index = 1; index < hex.length; index += 1) line(hex[index - 1]!, hex[index]!, 1.55, baseAlpha);
  line([9, 12.3], [9, 15.45], 1.55, baseAlpha);
  line([5, 9.85], [2.6, 11.35], 1.55, baseAlpha);
  line([2.6, 11.35], [2.6, 14.15], 1.55, baseAlpha);
  line([13, 9.85], [15.4, 11.35], 1.55, baseAlpha);
  line([15.4, 11.35], [15.4, 14.15], 1.55, baseAlpha);
  disc(2.6, 15.1, 1.25, baseAlpha);
  disc(9, 16.25, 1.25, baseAlpha);
  disc(15.4, 15.1, 1.25, baseAlpha);

  if (state === 'activity') disc(15.4, 3.1, 2.15);
  else if (state === 'warning') {
    triangle([[15.4, 1.15], [18, 5.65], [12.8, 5.65]]);
    line([15.4, 2.45], [15.4, 4], 0.65, 1, true);
  } else if (state === 'critical') {
    disc(15.4, 3.25, 2.5);
    line([15.4, 1.8], [15.4, 3.55], 0.72, 1, true);
    disc(15.4, 4.58, 0.34, 1, true);
  } else if (state === 'disconnected') line([2.2, 2.2], [16.8, 16.8], 1.65);
  return bytes;
}

export function positionMenuBarWindow(tray: RectangleLike, windowSize: SizeLike, workArea: RectangleLike): { x: number; y: number } {
  const desiredX = Math.round(tray.x + tray.width / 2 - windowSize.width / 2);
  const maximumX = workArea.x + workArea.width - windowSize.width;
  const x = Math.max(workArea.x, Math.min(desiredX, maximumX));
  const spaceBelow = workArea.y + workArea.height - (tray.y + tray.height);
  const belowY = Math.round(tray.y + tray.height + 6);
  const aboveY = Math.round(tray.y - windowSize.height - 6);
  const y = spaceBelow >= windowSize.height + 6
    ? belowY
    : Math.max(workArea.y, aboveY);
  return { x, y };
}

/** Reject the bottom-left sentinel Electron can report before macOS finishes
 * laying out a newly-created status item. */
export function isUsableMenuBarAnchor(tray: RectangleLike, display: RectangleLike): boolean {
  if (tray.width <= 0 || tray.height <= 0 || display.width <= 0 || display.height <= 0) return false;
  const centerX = tray.x + tray.width / 2;
  const centerY = tray.y + tray.height / 2;
  const menuBandBottom = display.y + Math.min(80, Math.max(44, display.height * 0.08));
  return centerX >= display.x
    && centerX <= display.x + display.width
    && centerY >= display.y - 4
    && centerY <= menuBandBottom;
}

export function sanitizeOpenMainTarget(input: unknown): OpenMainTarget {
  if (input === undefined || input === null) return {};
  const value = record(input);
  if (!value) throw new Error('Invalid Orchestra Canvas target');
  const result: OpenMainTarget = {};
  if (value.page !== undefined) {
    if (typeof value.page !== 'string' || !allowedPages.has(value.page)) throw new Error('Invalid Orchestra Canvas page');
    result.page = value.page;
  }
  if (value.tab !== undefined) {
    if (typeof value.tab !== 'string' || !allowedTabs.has(value.tab)) throw new Error('Invalid Orchestra Canvas tab');
    result.tab = value.tab;
  }
  for (const key of ['deviceId', 'entityId'] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || !safeIdentifier.test(candidate)) throw new Error(`Invalid ${key}`);
    result[key] = candidate;
  }
  if (Object.keys(value).some((key) => !['page', 'deviceId', 'tab', 'entityId'].includes(key))) throw new Error('Unsupported Orchestra Canvas target field');
  return result;
}

export function validateExitNodeInput(input: unknown): ExitNodeInput {
  const value = record(input);
  if (!value || !('id' in value)) throw new Error('Exit-node selection is required');
  if (value.id !== null && (typeof value.id !== 'string' || !safeExitNode.test(value.id) || value.id.startsWith('-'))) {
    throw new Error('Invalid exit-node identifier');
  }
  if (value.allowLan !== undefined && typeof value.allowLan !== 'boolean') throw new Error('Invalid LAN-access preference');
  if (Object.keys(value).some((key) => !['id', 'allowLan'].includes(key))) throw new Error('Unsupported exit-node field');
  return { id: value.id as string | null, ...(value.allowLan === undefined ? {} : { allowLan: value.allowLan }) };
}

export function parseTailscaleStatus(input: unknown): ExitNodeStatus {
  const root = record(input);
  if (!root) throw new Error('Tailscale returned an invalid status document');
  const peersValue = record(root.Peer) ?? {};
  const peers = Object.values(peersValue).map(record).filter((peer): peer is Record<string, unknown> => Boolean(peer));
  const exitOptions = peers.filter((peer) => peer.ExitNodeOption === true || peer.ExitNode === true).map((peer) => {
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((item): item is string => typeof item === 'string') : [];
    const dns = typeof peer.DNSName === 'string' ? peer.DNSName.replace(/\.$/, '') : '';
    // `tailscale set --exit-node` accepts an IP or base name, not the opaque
    // node ID returned by `tailscale status --json`.
    const id = addresses[0] ?? (typeof peer.HostName === 'string' ? peer.HostName : dns);
    return {
      id,
      name: dns || String(peer.HostName ?? id),
      online: peer.Online !== false,
      addresses
    };
  }).filter((option) => safeExitNode.test(option.id));
  const selectedPeer = peers.find((peer) => peer.ExitNode === true);
  const selectedAddress = Array.isArray(selectedPeer?.TailscaleIPs)
    ? selectedPeer.TailscaleIPs.find((item): item is string => typeof item === 'string')
    : undefined;
  const selectedId = selectedAddress ?? (typeof selectedPeer?.HostName === 'string' ? selectedPeer.HostName : undefined);
  const selectedDns = typeof selectedPeer?.DNSName === 'string' ? selectedPeer.DNSName.replace(/\.$/, '') : undefined;
  const selectedName = selectedDns || (typeof selectedPeer?.HostName === 'string' ? selectedPeer.HostName : undefined);
  return {
    available: true,
    connected: Boolean(selectedPeer),
    ...(selectedId ? { selectedId } : {}),
    ...(selectedName ? { selectedName } : {}),
    allowLan: root.ExitNodeAllowLANAccess === true,
    backendState: typeof root.BackendState === 'string' ? root.BackendState : undefined,
    options: exitOptions
  };
}

export function isTrustedSender(senderId: number, mainId: number | undefined, menuBarId: number | undefined, roles: readonly ('main' | 'menu-bar')[]): boolean {
  return (roles.includes('main') && mainId === senderId) || (roles.includes('menu-bar') && menuBarId === senderId);
}

export function shouldStartMenuBarOnly(args: readonly string[], login: { wasOpenedAsHidden?: boolean; wasOpenedAtLogin?: boolean }): boolean {
  return args.includes('--hidden') || login.wasOpenedAsHidden === true || login.wasOpenedAtLogin === true;
}
