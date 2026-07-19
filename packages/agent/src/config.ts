import os from 'node:os';
import path from 'node:path';
import type { DeviceRole } from '@fleet/shared';
import { DEFAULT_CORE_URL, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_MAX_FILE_CHUNK_BYTES, DEFAULT_MAX_UPDATE_BYTES, MAX_HEARTBEAT_INTERVAL_MS, MIN_HEARTBEAT_INTERVAL_MS } from './constants.js';
import type { FleetLogger } from './logger.js';
import { consoleLogger } from './logger.js';

export interface FleetAgentOptions {
  coreUrl?: string;
  token?: string;
  enrollmentToken?: string;
  credentialFile?: string;
  deviceId?: string;
  deviceName?: string;
  role?: DeviceRole;
  projectRoots?: string[];
  heartbeatIntervalMs?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  dataDir?: string;
  shell?: string;
  codexCommand?: string;
  codexHome?: string;
  allowPowerActions?: boolean;
  preventSleepDuringJobs?: boolean;
  updatePublicKey?: string;
  requireSignedUpdates?: boolean;
  maxFileChunkBytes?: number;
  maxUpdateBytes?: number;
  wolPort?: number;
  logger?: FleetLogger;
}

export interface ResolvedFleetAgentOptions {
  coreUrl: string;
  token: string;
  tokenIsExplicit: boolean;
  enrollmentToken?: string;
  credentialFile: string;
  deviceId?: string;
  deviceName: string;
  role: DeviceRole;
  projectRoots: string[];
  heartbeatIntervalMs: number;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  dataDir: string;
  shell?: string;
  codexCommand: string;
  codexHome: string;
  allowPowerActions: boolean;
  preventSleepDuringJobs: boolean;
  updatePublicKey?: string;
  requireSignedUpdates: boolean;
  maxFileChunkBytes: number;
  maxUpdateBytes: number;
  wolPort: number;
  logger: FleetLogger;
}

const ROLES = new Set<DeviceRole>(['core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown']);

export function resolveOptions(options: FleetAgentOptions = {}): ResolvedFleetAgentOptions {
  const coreUrl = options.coreUrl ?? process.env.FLEET_CORE_URL ?? DEFAULT_CORE_URL;
  validateCoreUrl(coreUrl);
  const explicitToken = options.token ?? process.env.FLEET_TOKEN ?? process.env.FLEET_AGENT_TOKEN;
  const token = explicitToken ?? '';
  const roleValue = options.role ?? (process.env.FLEET_DEVICE_ROLE ? parseRole(process.env.FLEET_DEVICE_ROLE) : 'workstation');
  const configuredRoots = options.projectRoots ?? parseProjectRoots(process.env.FLEET_PROJECT_ROOTS);
  const roots = configuredRoots.length > 0 ? configuredRoots : [process.env.INIT_CWD ?? process.cwd()];
  const heartbeatIntervalMs = clampInterval(
    options.heartbeatIntervalMs ?? parsePositiveInteger(process.env.FLEET_HEARTBEAT_INTERVAL_MS) ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const reconnectMinDelayMs = Math.max(250, options.reconnectMinDelayMs ?? 1_000);
  const reconnectMaxDelayMs = Math.max(reconnectMinDelayMs, options.reconnectMaxDelayMs ?? 30_000);
  const dataDir = path.resolve(options.dataDir ?? process.env.FLEET_AGENT_DATA_DIR ?? process.env.FLEET_DATA_DIR ?? defaultDataDirectory());

  return {
    coreUrl,
    token,
    tokenIsExplicit: explicitToken !== undefined,
    enrollmentToken: options.enrollmentToken ?? process.env.FLEET_ENROLLMENT_TOKEN,
    credentialFile: path.resolve(options.credentialFile ?? process.env.FLEET_CREDENTIAL_FILE ?? path.join(dataDir, 'device-credential.json')),
    deviceId: options.deviceId ?? process.env.FLEET_DEVICE_ID,
    deviceName: options.deviceName ?? process.env.FLEET_DEVICE_NAME ?? os.hostname(),
    role: roleValue,
    projectRoots: normalizeProjectRoots(roots),
    heartbeatIntervalMs,
    reconnectMinDelayMs,
    reconnectMaxDelayMs,
    dataDir,
    shell: options.shell ?? process.env.FLEET_SHELL,
    codexCommand: options.codexCommand ?? process.env.FLEET_CODEX_COMMAND ?? 'codex',
    codexHome: path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')),
    allowPowerActions: options.allowPowerActions ?? parseBoolean(process.env.FLEET_ALLOW_POWER_ACTIONS, false),
    preventSleepDuringJobs: options.preventSleepDuringJobs ?? parseBoolean(process.env.FLEET_PREVENT_SLEEP_DURING_JOBS, false),
    updatePublicKey: options.updatePublicKey ?? process.env.FLEET_UPDATE_PUBLIC_KEY,
    requireSignedUpdates: options.requireSignedUpdates ?? parseBoolean(process.env.FLEET_REQUIRE_SIGNED_UPDATES, true),
    maxFileChunkBytes: clampBytes(options.maxFileChunkBytes ?? parsePositiveInteger(process.env.FLEET_MAX_FILE_CHUNK_BYTES) ?? DEFAULT_MAX_FILE_CHUNK_BYTES, 64 * 1024, 8 * 1024 * 1024),
    maxUpdateBytes: clampBytes(options.maxUpdateBytes ?? parsePositiveInteger(process.env.FLEET_MAX_UPDATE_BYTES) ?? DEFAULT_MAX_UPDATE_BYTES, 1024 * 1024, 16 * 1024 * 1024 * 1024),
    wolPort: clampPort(options.wolPort ?? parsePositiveInteger(process.env.FLEET_WOL_PORT) ?? 9),
    logger: options.logger ?? consoleLogger,
  };
}

export function parseProjectRoots(value: string | undefined): string[] {
  if (!value) return [];
  const separators = process.platform === 'win32' ? /[;,]/ : /[:,]/;
  return value.split(separators).map((root) => root.trim()).filter(Boolean);
}

export function normalizeProjectRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(expandHome(root))))];
}

export function parseRole(value: string | undefined): DeviceRole {
  return value && ROLES.has(value as DeviceRole) ? value as DeviceRole : 'unknown';
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  return fallback;
}

export function buildAgentWebSocketUrl(coreUrl: string): string {
  const url = new URL(coreUrl);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/ws/agent')) {
    url.pathname = `${pathname}/ws/agent`;
  } else {
    url.pathname = pathname;
  }
  return url.toString();
}

function validateCoreUrl(coreUrl: string): void {
  let url: URL;
  try {
    url = new URL(coreUrl);
  } catch {
    throw new Error(`Invalid Fleet Core URL: ${coreUrl}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Fleet Core URL must use http, https, ws, or wss.');
  }
}

function isLoopbackCoreUrl(coreUrl: string): boolean {
  const hostname = new URL(coreUrl).hostname;
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function clampInterval(value: number): number {
  return Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.max(MIN_HEARTBEAT_INTERVAL_MS, value));
}

function clampBytes(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('Wake-on-LAN port must be between 1 and 65535.');
  return value;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function defaultDataDirectory(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Fleet Canvas', 'agent');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Fleet Canvas', 'agent');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'fleet-canvas', 'agent');
}
