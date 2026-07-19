import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification as SystemNotification,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type NativeImage
} from 'electron';
import { randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { defaultCodexMicroPreferences, type CodexMicroActionId, type CodexMicroDeviceState, type CodexMicroFeedback, type CodexMicroPreferences, type CodexMicroVoiceState, type MenuBarCodexApproval, type MenuBarCodexSession, type MenuBarSnapshot } from '@fleet/shared';
import { fleetCoreRequestError } from '../core-request-error.js';
import {
  isTrustedSender,
  isUsableMenuBarAnchor,
  menuBarPulseSignature,
  parseTailscaleStatus,
  positionMenuBarWindow,
  sanitizeOpenMainTarget,
  shouldStartMenuBarOnly,
  trayPresentation,
  validateExitNodeInput,
  type ExitNodeStatus,
  type MenuBarVisualState,
  type OpenMainTarget,
  type RectangleLike
} from './menu-bar.js';
import { validatedExternalUrl } from './external-url.js';
import { resolveFleetCoreApiUrl } from './core-api-url.js';
import { createTrayIconPngRepresentations } from './tray-icon-png.js';
import { CodexMicroController, normalizeCodexMicroPreferences } from './codex-micro.js';
import { NativeVoiceCapture } from './native-voice.js';
import { codexBarCliCandidates, parseCodexBarUsage, type CodexBarUsage } from './codexbar.js';

if (app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Fleet Canvas'));
  app.setName('Orchestra Canvas');
  process.env.FLEET_AUTO_START_AGENT ??= 'false';
  process.env.FLEET_EMBEDDED_CORE ??= 'false';
}

const DEFAULT_CORE_URL = 'http://127.0.0.1:4780';
const DEFAULT_MENU_BAR_SHORTCUT = 'CommandOrControl+Shift+Space';
const MENU_BAR_TOGGLE_ARG = '--toggle-menubar';
let coreUrl = DEFAULT_CORE_URL;
let isLoopback = true;
let fleetToken = process.env.FLEET_TOKEN ?? '';
let mainWindow: BrowserWindow | null = null;
let mainWindowReady = false;
let mainTargetListenerReady = false;
type RoutedOpenMainTarget = OpenMainTarget & { navigationTarget?: { sessionId: string; sequence: number } };
let pendingOpenMainTarget: RoutedOpenMainTarget | undefined;
let codexNavigationSequence = 0;
let menuBarWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pendingMenuBarToggle = process.argv.includes(MENU_BAR_TOGGLE_ARG);
let websocket: WebSocket | null = null;
let websocketConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
let embeddedCore: unknown;
let localAgentProcess: ChildProcess | null = null;
let menuBarPollTimer: ReturnType<typeof setInterval> | null = null;
let menuBarEventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let menuBarPollInFlight: Promise<MenuBarDesktopState> | null = null;
let menuBarSnapshot: MenuBarSnapshot | null = null;
let menuBarConnected = false;
let menuBarLastUpdatedAt: string | undefined;
let menuBarError: string | undefined;
let menuBarPulseTimer: ReturnType<typeof setTimeout> | null = null;
let lastMenuBarPulseSignature: string | undefined;
let cachedExitNodeStatus: ExitNodeStatus | undefined;
let tailscaleCliPath: string | null | undefined;
let codexBarCliPath: string | undefined;
let cachedCodexBarUsage: CodexBarUsage = { available: false };
let codexBarUpdatedAt = 0;
let codexBarPollInFlight: Promise<void> | null = null;
let quietMode: QuietMode = 'normal';
let codexMicroPreferences: CodexMicroPreferences = defaultCodexMicroPreferences();
let codexMicroReadAt: Record<string, number> | undefined;
let codexMicroController: CodexMicroController | null = null;
let codexMicroActiveSessionId: string | null = null;
let codexMicroDialBurst: { direction: 'clockwise' | 'counterclockwise'; mode: CodexMicroPreferences['dialMode']; sessionId: string | null; deviceId: string | null; steps: number } | null = null;
let codexMicroDialBurstTimer: ReturnType<typeof setTimeout> | null = null;
let nativeVoiceCapture: NativeVoiceCapture | null = null;
const shownNotificationIds = new Set<string>();
const require = createRequire(import.meta.url);
const MENU_BAR_POLL_MS = 5_000;
const MENU_BAR_WIDTH = 408;
const MENU_BAR_HEIGHT = 680;
const MENU_BAR_TRAY_GUID = '7ee7dc7d-90a5-4b55-a743-5dc405a5c8fd';
const MAX_CLIPBOARD_TEXT = 1_048_576;
const CODEX_MICRO_DIAL_BATCH_MS = 16;
const desktopPreferencesPath = () => join(app.getPath('userData'), 'desktop-preferences.json');
const desktopConnectionPath = () => join(app.getPath('userData'), 'desktop-connection.json');

type QuietMode = 'normal' | 'quiet';

interface MenuBarDesktopState {
  snapshot: MenuBarSnapshot | null;
  connected: boolean;
  quietMode: QuietMode;
  launchAtLogin: boolean;
  exitNode?: ExitNodeStatus;
  codexBar: CodexBarUsage;
  lastUpdatedAt?: string;
  error?: string;
}

function normalizeCoreUrl(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Orchestra Core must use HTTP or HTTPS');
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

interface StoredDesktopConnection {
  coreUrl?: unknown;
  token?: unknown;
}

async function resolveDesktopConnection(): Promise<void> {
  let stored: StoredDesktopConnection = {};
  try {
    stored = JSON.parse(await readFile(desktopConnectionPath(), 'utf8')) as StoredDesktopConnection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[fleet] desktop connection could not be read', error);
  }

  coreUrl = normalizeCoreUrl(
    process.env.FLEET_CORE_URL
      ?? process.env.VITE_FLEET_CORE_URL
      ?? (typeof stored.coreUrl === 'string' ? stored.coreUrl : DEFAULT_CORE_URL)
  );
  isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(new URL(coreUrl).hostname);
  if (!fleetToken && typeof stored.token === 'string') fleetToken = stored.token.trim();

  if ((process.env.FLEET_CORE_URL || process.env.VITE_FLEET_CORE_URL) && fleetToken) {
    const path = desktopConnectionPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ coreUrl, token: fleetToken }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }
}

async function coreAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${coreUrl}/api/snapshot`, {
      headers: fleetToken ? { authorization: `Bearer ${fleetToken}` } : undefined,
      signal: AbortSignal.timeout(1_200)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function shouldStartLocalAgent(): Promise<boolean> {
  if (process.env.FLEET_AUTO_START_AGENT === 'false') return false;
  if (process.env.FLEET_AUTO_START_AGENT === 'true') return true;
  // A separately installed launchd/Windows/systemd Agent must be the only
  // Agent for this host. These aliases let native installers explicitly
  // disable Desktop's convenience child process without changing Core state.
  if (process.env.FLEET_EMBEDDED_AGENT === 'false' || process.env.FLEET_STANDALONE_AGENT === 'true') return false;
  try {
    const response = await fetch(`${coreUrl}/api/snapshot`, {
      headers: fleetToken ? { authorization: `Bearer ${fleetToken}` } : undefined,
      signal: AbortSignal.timeout(1_500)
    });
    if (!response.ok) return isLoopback;
    const value = await response.json() as { settings?: { autoStartLocalAgent?: boolean } };
    return value.settings?.autoStartLocalAgent !== false;
  } catch {
    // Never invent a second Agent just because a remote Core is temporarily
    // unreachable. Loopback development retains the convenient default.
    return isLoopback;
  }
}

async function startEmbeddedServices(): Promise<void> {
  let available = await coreAvailable();
  if (!available) {
    if (!isLoopback || process.env.FLEET_EMBEDDED_CORE === 'false') return;
    const corePackageName = '@fleet/core';
    const coreModule = await import(/* @vite-ignore */ corePackageName) as {
      startFleetCore?: (options?: Record<string, unknown>) => Promise<unknown> | unknown;
    };
    if (!coreModule.startFleetCore) throw new Error('@fleet/core does not export startFleetCore');
    const url = new URL(coreUrl);
    embeddedCore = await coreModule.startFleetCore({ host: url.hostname, port: Number(url.port || 80), token: fleetToken, embedded: true });

    for (let attempt = 0; attempt < 20 && !(available = await coreAvailable()); attempt += 1) await delay(100);
    if (!available) throw new Error(`Embedded Orchestra Core did not become available at ${coreUrl}`);
  }

  if (!(await shouldStartLocalAgent())) return;
  startLocalAgentProcess();
}

function startLocalAgentProcess(): void {
  if (localAgentProcess && localAgentProcess.exitCode === null) return;
  const agentEntry = require.resolve('@fleet/agent');
  const cliPath = join(dirname(agentEntry), 'cli.js');
  const nodeBinary = process.env.FLEET_NODE_BINARY || 'node';
  const defaultRoot = process.env.INIT_CWD || (process.env.ELECTRON_RENDERER_URL ? process.cwd() : homedir());
  localAgentProcess = spawn(nodeBinary, [cliPath], {
    cwd: process.env.FLEET_AGENT_CWD || defaultRoot,
    env: {
      ...process.env,
      FLEET_CORE_URL: coreUrl,
      FLEET_TOKEN: fleetToken,
      FLEET_PROJECT_ROOTS: process.env.FLEET_PROJECT_ROOTS || defaultRoot,
      FLEET_AGENT_DATA_DIR: process.env.FLEET_AGENT_DATA_DIR || join(app.getPath('userData'), 'agent')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  localAgentProcess.stdout?.on('data', (chunk: Buffer) => console.info(String(chunk).trimEnd()));
  localAgentProcess.stderr?.on('data', (chunk: Buffer) => console.error(String(chunk).trimEnd()));
  localAgentProcess.on('error', (error) => console.error('[fleet] local Agent failed to start', error));
  localAgentProcess.on('exit', (code, signal) => {
    if (!stopping && code !== 0) console.error(`[fleet] local Agent exited (${signal ?? code ?? 'unknown'})`);
    localAgentProcess = null;
  });
}

function apiUrl(path: string): string {
  return resolveFleetCoreApiUrl(coreUrl, path);
}

function trustedWindowIds(): { main?: number; menuBar?: number } {
  return {
    ...(mainWindow && !mainWindow.isDestroyed() ? { main: mainWindow.webContents.id } : {}),
    ...(menuBarWindow && !menuBarWindow.isDestroyed() ? { menuBar: menuBarWindow.webContents.id } : {})
  };
}

function assertTrustedRenderer(event: IpcMainInvokeEvent, roles: readonly ('main' | 'menu-bar')[] = ['main', 'menu-bar']): void {
  const ids = trustedWindowIds();
  if (!isTrustedSender(event.sender.id, ids.main, ids.menuBar, roles)) throw new Error('Untrusted renderer');
}

function desktopState(): MenuBarDesktopState {
  return {
    snapshot: menuBarSnapshot,
    connected: menuBarConnected,
    quietMode,
    launchAtLogin: app.getLoginItemSettings(loginItemIdentity()).openAtLogin,
    codexBar: cachedCodexBarUsage,
    ...(cachedExitNodeStatus ? { exitNode: cachedExitNodeStatus } : {}),
    ...(menuBarLastUpdatedAt ? { lastUpdatedAt: menuBarLastUpdatedAt } : {}),
    ...(menuBarError ? { error: menuBarError } : {})
  };
}

function loginItemIdentity(): { path: string; args: string[] } {
  return {
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
  };
}

async function loadDesktopPreferences(): Promise<void> {
  try {
    const value = JSON.parse(await readFile(desktopPreferencesPath(), 'utf8')) as { quietMode?: unknown; codexMicro?: unknown; codexMicroReadAt?: unknown };
    if (value.quietMode === 'normal' || value.quietMode === 'quiet') quietMode = value.quietMode;
    codexMicroPreferences = normalizeCodexMicroPreferences(value.codexMicro);
    if (value.codexMicroReadAt && typeof value.codexMicroReadAt === 'object' && !Array.isArray(value.codexMicroReadAt)) {
      codexMicroReadAt = Object.fromEntries(Object.entries(value.codexMicroReadAt as Record<string, unknown>)
        .filter(([id, at]) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id) && typeof at === 'number' && Number.isFinite(at) && at >= 0)
        .slice(0, 500)) as Record<string, number>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[fleet] desktop preferences could not be read', error);
  }
}

async function saveDesktopPreferences(): Promise<void> {
  const path = desktopPreferencesPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ quietMode, codexMicro: codexMicroPreferences, ...(codexMicroReadAt === undefined ? {} : { codexMicroReadAt }) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function emitMenuBarState(): void {
  if (menuBarWindow && !menuBarWindow.isDestroyed()) menuBarWindow.webContents.send('fleet:menu-bar-state', desktopState());
}

const trayImages = new Map<MenuBarVisualState, NativeImage>();

function trayImage(state: MenuBarVisualState): NativeImage {
  const existing = trayImages.get(state);
  if (existing) return existing;
  const image = nativeImage.createEmpty();
  for (const representation of createTrayIconPngRepresentations(state)) {
    image.addRepresentation({ scaleFactor: representation.scaleFactor, dataURL: representation.dataUrl });
  }
  image.setTemplateImage(true);
  trayImages.set(state, image);
  return image;
}

function renderTray(briefPulse = false): void {
  if (!tray || tray.isDestroyed()) return;
  const presentation = trayPresentation(menuBarSnapshot, menuBarConnected);
  if (menuBarPulseTimer) clearTimeout(menuBarPulseTimer);
  tray.setTitle(process.platform === 'darwin' ? presentation.title : '');
  tray.setToolTip(presentation.tooltip);
  tray.setImage(trayImage(presentation.state));
  if (!briefPulse || presentation.state === 'critical' || presentation.state === 'disconnected') return;
  tray.setImage(trayImage(presentation.state === 'activity' ? 'healthy' : 'activity'));
  menuBarPulseTimer = setTimeout(() => {
    menuBarPulseTimer = null;
    if (tray && !tray.isDestroyed()) tray.setImage(trayImage(trayPresentation(menuBarSnapshot, menuBarConnected).state));
  }, 650);
}

async function readBoundedJson(response: Response): Promise<MenuBarSnapshot> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('Orchestra Core menu-bar response exceeded the safety limit');
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Orchestra Core returned an invalid menu-bar response');
  const candidate = value as Partial<MenuBarSnapshot>;
  if (typeof candidate.generatedAt !== 'string' || !candidate.summary || !candidate.core
    || !Array.isArray(candidate.jobs) || !Array.isArray(candidate.devices)
    || !Array.isArray(candidate.approvals) || !Array.isArray(candidate.alerts) || !Array.isArray(candidate.recent)
    || !Array.isArray(candidate.codexSessions)) {
    throw new Error('Orchestra Core returned an incomplete menu-bar response');
  }
  return value as MenuBarSnapshot;
}

async function pollMenuBarSnapshot(): Promise<MenuBarDesktopState> {
  if (menuBarPollInFlight) return menuBarPollInFlight;
  menuBarPollInFlight = (async () => {
    try {
      const response = await fetch(`${coreUrl}/api/v2/menu-bar`, {
        headers: fleetToken ? { authorization: `Bearer ${fleetToken}` } : undefined,
        signal: AbortSignal.timeout(4_000)
      });
      if (!response.ok) throw new Error(`Orchestra Core menu-bar request failed (${response.status})`);
      const next = await readBoundedJson(response);
      const signature = menuBarPulseSignature(next, true);
      const pulse = lastMenuBarPulseSignature !== undefined && signature !== lastMenuBarPulseSignature;
      lastMenuBarPulseSignature = signature;
      menuBarSnapshot = next;
      codexMicroController?.updateSessions(next.codexSessions);
      codexMicroController?.updateFleetAttention(next.summary);
      menuBarConnected = true;
      menuBarError = undefined;
      menuBarLastUpdatedAt = new Date().toISOString();
      renderTray(pulse);
      void refreshCodexBarUsage();
    } catch (error) {
      menuBarConnected = false;
      menuBarError = error instanceof Error ? error.message : 'Orchestra Core is unavailable';
      renderTray(false);
    } finally {
      emitMenuBarState();
    }
    return desktopState();
  })();
  try { return await menuBarPollInFlight; } finally { menuBarPollInFlight = null; }
}

function startMenuBarPolling(): void {
  void pollMenuBarSnapshot();
  if (menuBarPollTimer) clearInterval(menuBarPollTimer);
  menuBarPollTimer = setInterval(() => void pollMenuBarSnapshot(), MENU_BAR_POLL_MS);
  menuBarPollTimer.unref();
}

async function findTailscaleCli(): Promise<string | null> {
  if (tailscaleCliPath !== undefined) return tailscaleCliPath;
  const candidates = [
    process.env.FLEET_TAILSCALE_CLI,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale'
  ].filter((value): value is string => Boolean(value) && isAbsolute(value!));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      tailscaleCliPath = candidate;
      return candidate;
    } catch { /* try the next fixed, absolute executable */ }
  }
  tailscaleCliPath = null;
  return null;
}

async function executeFile(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, args, { timeout: 12_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function findCodexBarCli(): Promise<string | null> {
  if (codexBarCliPath) return codexBarCliPath;
  for (const candidate of codexBarCliCandidates(homedir(), process.env.CODEXBAR_CLI)) {
    try {
      await access(candidate, fsConstants.X_OK);
      codexBarCliPath = candidate;
      return candidate;
    } catch { /* CodexBar is an optional local integration. */ }
  }
  return null;
}

async function refreshCodexBarUsage(force = false): Promise<void> {
  if (!force && Date.now() - codexBarUpdatedAt < 60_000) return;
  if (codexBarPollInFlight) return codexBarPollInFlight;
  codexBarPollInFlight = (async () => {
    const cli = await findCodexBarCli();
    if (!cli) {
      cachedCodexBarUsage = { available: false };
    } else {
      try {
        cachedCodexBarUsage = parseCodexBarUsage(await executeFile(cli, ['usage', '--provider', 'codex', '--format', 'json']));
      } catch (error) {
        cachedCodexBarUsage = { available: true, error: error instanceof Error ? error.message : 'CodexBar usage failed' };
      }
    }
    codexBarUpdatedAt = Date.now();
    emitMenuBarState();
  })();
  try { await codexBarPollInFlight; } finally { codexBarPollInFlight = null; }
}

async function refreshExitNodeStatus(): Promise<ExitNodeStatus> {
  const cli = await findTailscaleCli();
  if (!cli) {
    cachedExitNodeStatus = { available: false, connected: false, allowLan: false, options: [], error: 'Tailscale CLI is not installed.' };
  } else {
    try {
      cachedExitNodeStatus = parseTailscaleStatus(JSON.parse(await executeFile(cli, ['status', '--json'])) as unknown);
      try {
        const preferences = JSON.parse(await executeFile(cli, ['debug', 'prefs'])) as { ExitNodeAllowLANAccess?: unknown };
        if (typeof preferences.ExitNodeAllowLANAccess === 'boolean') {
          cachedExitNodeStatus = { ...cachedExitNodeStatus, allowLan: preferences.ExitNodeAllowLANAccess };
        }
      } catch { /* Older Tailscale clients may not expose structured preferences. */ }
    } catch (error) {
      cachedExitNodeStatus = { available: true, connected: false, allowLan: false, options: [], error: error instanceof Error ? error.message : 'Tailscale status failed.' };
    }
  }
  emitMenuBarState();
  return cachedExitNodeStatus;
}

async function setExitNode(input: unknown): Promise<ExitNodeStatus> {
  const selection = validateExitNodeInput(input);
  const cli = await findTailscaleCli();
  if (!cli) throw new Error('Tailscale CLI is not installed.');
  const allowLan = selection.id ? selection.allowLan === true : false;
  await executeFile(cli, [
    'set',
    `--exit-node=${selection.id ?? ''}`,
    `--exit-node-allow-lan-access=${allowLan ? 'true' : 'false'}`
  ]);
  const result = await refreshExitNodeStatus();
  cachedExitNodeStatus = { ...result, allowLan };
  emitMenuBarState();
  return cachedExitNodeStatus;
}

function routeMainWindow(targetInput: unknown, focusWindow: boolean): void {
  const target = sanitizeOpenMainTarget(targetInput);
  const routedTarget: RoutedOpenMainTarget = target.tab === 'codex' && target.entityId
    ? { ...target, navigationTarget: { sessionId: target.entityId, sequence: ++codexNavigationSequence } }
    : target;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow(focusWindow);
  if (!mainWindow) return;
  if (focusWindow) {
    app.focus({ steal: true });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    menuBarWindow?.hide();
  }
  if (Object.keys(routedTarget).length > 0) {
    if (mainWindowReady && mainTargetListenerReady) mainWindow.webContents.send('fleet:open-main-target', routedTarget);
    else pendingOpenMainTarget = routedTarget;
  }
}

function showMainWindow(targetInput?: unknown): void {
  routeMainWindow(targetInput, true);
}

function codexSessionTarget(session: Pick<MenuBarCodexSession, 'deviceId' | 'id'>): OpenMainTarget {
  return { page: 'canvas', deviceId: session.deviceId, tab: 'codex', entityId: session.id };
}

async function coreRequest<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(fleetToken ? { authorization: `Bearer ${fleetToken}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) throw new Error(fleetCoreRequestError(path, response.status, payload));
  return payload as T;
}

function emitCodexMicroState(state = codexMicroController?.getState()): void {
  if (!state) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fleet:codex-micro-state', state);
  void writeFile(join(app.getPath('userData'), 'codex-micro-diagnostics.json'), `${JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    .catch((error) => console.warn('[fleet] Codex Micro diagnostics could not be written', error));
}

function emitCodexMicroAction(action: CodexMicroActionId, phase: 'press' | 'release', session: MenuBarCodexSession | null, customShortcut?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow(false);
  mainWindow?.webContents.send('fleet:codex-micro-action', {
    action,
    phase,
    sessionId: session?.id ?? null,
    deviceId: session?.deviceId ?? null,
    customShortcut: customShortcut ?? null,
  });
}

function flushCodexMicroDialBurst(): void {
  if (codexMicroDialBurstTimer) clearTimeout(codexMicroDialBurstTimer);
  codexMicroDialBurstTimer = null;
  const burst = codexMicroDialBurst;
  codexMicroDialBurst = null;
  if (!burst || burst.steps === 0 || stopping) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow(false);
  mainWindow?.webContents.send('fleet:codex-micro-dial', {
    direction: burst.direction,
    steps: burst.steps,
    mode: burst.mode,
    sessionId: burst.sessionId,
    deviceId: burst.deviceId,
  });
}

function emitCodexMicroDial(
  direction: 'clockwise' | 'counterclockwise' | 'press' | 'release',
  mode: CodexMicroPreferences['dialMode'],
  session: MenuBarCodexSession | null,
): void {
  const sessionId = session?.id ?? null;
  const deviceId = session?.deviceId ?? null;
  if (direction === 'press' || direction === 'release') {
    // Preserve input order: every pending rotation lands before the click that
    // confirms it, even when the user spins and presses in one quick gesture.
    flushCodexMicroDialBurst();
    if (!mainWindow || mainWindow.isDestroyed()) createWindow(false);
    mainWindow?.webContents.send('fleet:codex-micro-dial', { direction, steps: 1, mode, sessionId, deviceId });
    return;
  }

  const sameTarget = codexMicroDialBurst
    && codexMicroDialBurst.direction === direction
    && codexMicroDialBurst.mode === mode
    && codexMicroDialBurst.sessionId === sessionId
    && codexMicroDialBurst.deviceId === deviceId;
  if (!sameTarget) {
    flushCodexMicroDialBurst();
    codexMicroDialBurst = { direction, mode, sessionId, deviceId, steps: 1 };
  } else {
    codexMicroDialBurst!.steps += 1;
  }
  if (!codexMicroDialBurstTimer) {
    codexMicroDialBurstTimer = setTimeout(flushCodexMicroDialBurst, CODEX_MICRO_DIAL_BATCH_MS);
  }
}

function emitCodexMicroDecision(sessionId: string, approvalId: string, accepted: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) return;
  mainWindow.webContents.send('fleet:codex-micro-decision', { sessionId, approvalId, accepted });
}

function emitVoiceState(state: CodexMicroVoiceState): void {
  codexMicroController?.updateVoiceState(state);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fleet:codex-micro-voice-state', state);
}

function codexApprovalResult(approval: MenuBarCodexApproval, accepted: boolean): unknown {
  if (!accepted) {
    if (approval.method === 'item/tool/requestUserInput') return { answers: {} };
    if (approval.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (approval.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
    return { decision: 'decline' };
  }
  if (approval.method === 'item/permissions/requestApproval') {
    const params = approval.params && typeof approval.params === 'object' && !Array.isArray(approval.params) ? approval.params as Record<string, unknown> : {};
    const requested = params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions) ? params.permissions as Record<string, unknown> : {};
    return { permissions: Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null && value !== undefined)), scope: 'turn' };
  }
  if (approval.method === 'item/tool/requestUserInput' || approval.method === 'mcpServer/elicitation/request') {
    throw new Error('This request needs review in Orchestra Canvas.');
  }
  return { decision: 'accept' };
}

async function handleCodexMicroDecision(session: MenuBarCodexSession, accepted: boolean): Promise<void> {
  const approval = menuBarSnapshot?.approvals.find((item): item is MenuBarCodexApproval => item.kind === 'codex' && item.sessionId === session.id);
  if (!approval) {
    routeMainWindow(codexSessionTarget(session), true);
    return;
  }
  const structured = approval.method === 'item/tool/requestUserInput' || approval.method === 'mcpServer/elicitation/request';
  if (accepted && structured) {
    if (codexMicroActiveSessionId !== session.id || !mainWindowReady || !mainTargetListenerReady) {
      routeMainWindow(codexSessionTarget(session), true);
      return;
    }
    codexMicroController?.signalFeedback('pending');
    emitCodexMicroDecision(session.id, approval.id, true);
    return;
  }
  try {
    await coreRequest(`/api/sessions/${encodeURIComponent(session.id)}/respond`, 'POST', {
      requestId: approval.requestId,
      result: codexApprovalResult(approval, accepted),
    });
    await pollMenuBarSnapshot();
  } catch (error) {
    console.warn('[fleet] Codex Micro approval needs review', error);
    routeMainWindow(codexSessionTarget(session), true);
  }
}

async function handleCodexMicroAction(action: CodexMicroActionId, phase: 'press' | 'release', session: MenuBarCodexSession | null, customShortcut?: string): Promise<void> {
  if (action === 'push-to-talk') {
    emitCodexMicroAction(action, phase, session, customShortcut);
    return;
  }
  if (phase !== 'press') return;
  if (action === 'approve' && session) { await handleCodexMicroDecision(session, true); return; }
  if (action === 'reject' && session) { await handleCodexMicroDecision(session, false); return; }
  if (action === 'fork-chat' && session) {
    const created = await coreRequest<MenuBarCodexSession>(`/api/sessions/${encodeURIComponent(session.id)}/fork`, 'POST', { title: `${session.title} (fork)` });
    routeMainWindow(codexSessionTarget(created), true);
    await pollMenuBarSnapshot();
    return;
  }
  if (action === 'open-openai-docs') { await shell.openExternal('https://developers.openai.com/'); return; }
  if (action === 'open-settings') { showMainWindow({ page: 'settings' }); return; }
  if (action === 'toggle-terminal' && session) { showMainWindow({ page: 'canvas', deviceId: session.deviceId, tab: 'terminal' }); return; }
  emitCodexMicroAction(action, phase, session, customShortcut);
}

function createCodexMicroController(): void {
  codexMicroController = new CodexMicroController(codexMicroPreferences, {
    ...(codexMicroReadAt === undefined ? {} : { initialReadAt: codexMicroReadAt }),
    onStateChanged: (state) => emitCodexMicroState(state),
    onReadStateChanged: (readAt) => {
      codexMicroReadAt = readAt;
      void saveDesktopPreferences().catch((error) => console.warn('[fleet] Codex Micro read state could not be saved', error));
    },
    onSessionSelected: (session, focusWindow) => {
      codexMicroActiveSessionId = session.id;
      routeMainWindow(codexSessionTarget(session), focusWindow);
    },
    onAction: (action, phase, session, customShortcut) => {
      void handleCodexMicroAction(action, phase, session, customShortcut).catch((error) => {
        console.error('[fleet] Codex Micro action failed', error);
        if (session) routeMainWindow(codexSessionTarget(session), true);
      });
    },
    onDial: emitCodexMicroDial,
  });
  codexMicroController.updateSessions(menuBarSnapshot?.codexSessions ?? []);
  codexMicroController.setActiveSession(codexMicroActiveSessionId);
  codexMicroController.start();
}

function legacyOpenTarget(input: unknown): OpenMainTarget {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Orchestra Canvas target');
  const value = input as Record<string, unknown>;
  const allowed = ['page', 'deviceId', 'tab', 'jobId', 'sessionId', 'alertId'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unsupported Orchestra Canvas target field');
  const entityCandidate = value.jobId ?? value.sessionId ?? value.alertId;
  return sanitizeOpenMainTarget({
    ...(value.page === undefined ? {} : { page: value.page }),
    ...(value.deviceId === undefined ? {} : { deviceId: value.deviceId }),
    ...(value.tab === undefined ? {} : { tab: value.tab }),
    ...(entityCandidate === undefined ? {} : { entityId: entityCandidate })
  });
}

function registerIpc(): void {
  ipcMain.handle('fleet:request', async (event, request: { path?: unknown; method?: unknown; body?: unknown }) => {
    assertTrustedRenderer(event);
    if (!request || typeof request !== 'object' || typeof request.path !== 'string') throw new Error('Invalid Orchestra Core request');
    if (request.method !== undefined && typeof request.method !== 'string') throw new Error('Invalid Orchestra Core request method');
    const method = (request.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported method');
    const response = await fetch(apiUrl(request.path), {
      method,
      headers: {
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(fleetToken ? { authorization: `Bearer ${fleetToken}` } : {})
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      throw new Error(fleetCoreRequestError(request.path, response.status, payload));
    }
    return payload;
  });
  ipcMain.handle('fleet:core-url', (event) => { assertTrustedRenderer(event); return coreUrl; });
  ipcMain.handle('fleet:client-device-name', (event) => { assertTrustedRenderer(event); return hostname(); });
  ipcMain.handle('fleet:connection-state', (event) => { assertTrustedRenderer(event); return websocketConnected; });
  ipcMain.handle('fleet:open-external', async (event, url: unknown) => {
    assertTrustedRenderer(event);
    await shell.openExternal(validatedExternalUrl(url));
  });
  ipcMain.handle('fleet:show-notification', (event, input: unknown) => {
    assertTrustedRenderer(event);
    const value = input as { id?: unknown; severity?: unknown };
    if (typeof value?.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value.id)) throw new Error('Invalid notification ID');
    if (!['info', 'success', 'warning', 'critical'].includes(String(value.severity))) throw new Error('Invalid notification severity');
    if (quietMode === 'quiet' && ['info', 'success'].includes(String(value.severity))) return false;
    if (!SystemNotification.isSupported() || shownNotificationIds.has(value.id)) return false;
    shownNotificationIds.add(value.id);
    if (shownNotificationIds.size > 2_000) shownNotificationIds.delete(shownNotificationIds.values().next().value!);
    const severity = String(value.severity);
    const notification = new SystemNotification({
      title: severity === 'critical' ? 'Orchestra critical event' : severity === 'warning' ? 'Orchestra warning' : 'Orchestra notification',
      body: 'Open Orchestra Canvas to review the new event.',
      silent: severity === 'info'
    });
    notification.on('click', () => {
      showMainWindow({ page: 'integrations', entityId: value.id });
      mainWindow?.webContents.send('fleet:notification-click', value.id);
    });
    notification.show();
    return true;
  });
  ipcMain.handle('fleet:menu-bar:get-state', (event) => { assertTrustedRenderer(event); return desktopState(); });
  ipcMain.handle('fleet:menu-bar:refresh', async (event) => {
    assertTrustedRenderer(event);
    await Promise.all([pollMenuBarSnapshot(), refreshExitNodeStatus()]);
    return desktopState();
  });
  ipcMain.handle('fleet:menu-bar:open-main', (event, target: unknown) => {
    assertTrustedRenderer(event);
    showMainWindow(target);
  });
  ipcMain.handle('fleet:menu-bar:open-full-app', (event, target: unknown) => {
    assertTrustedRenderer(event);
    showMainWindow(legacyOpenTarget(target));
  });
  ipcMain.handle('fleet:main-target-listener-ready', (event) => {
    assertTrustedRenderer(event, ['main']);
    mainTargetListenerReady = true;
    const target = pendingOpenMainTarget;
    pendingOpenMainTarget = undefined;
    return target;
  });
  ipcMain.handle('fleet:menu-bar:hide', (event) => {
    assertTrustedRenderer(event, ['menu-bar']);
    menuBarWindow?.hide();
  });
  ipcMain.handle('fleet:menu-bar:quit', (event) => {
    assertTrustedRenderer(event, ['menu-bar']);
    app.quit();
  });
  ipcMain.handle('fleet:menu-bar:get-quiet-mode', (event) => { assertTrustedRenderer(event); return quietMode; });
  ipcMain.handle('fleet:menu-bar:set-quiet-mode', async (event, input: unknown) => {
    assertTrustedRenderer(event);
    if (input !== 'normal' && input !== 'quiet') throw new Error('Invalid quiet-mode setting');
    quietMode = input;
    await saveDesktopPreferences();
    emitMenuBarState();
    return quietMode;
  });
  ipcMain.handle('fleet:menu-bar:get-launch-at-login', (event) => {
    assertTrustedRenderer(event);
    return app.getLoginItemSettings(loginItemIdentity()).openAtLogin;
  });
  ipcMain.handle('fleet:menu-bar:set-launch-at-login', (event, input: unknown) => {
    assertTrustedRenderer(event);
    if (typeof input !== 'boolean') throw new Error('Invalid launch-at-login setting');
    app.setLoginItemSettings({ ...loginItemIdentity(), openAtLogin: input, openAsHidden: true });
    emitMenuBarState();
    return app.getLoginItemSettings(loginItemIdentity()).openAtLogin;
  });
  ipcMain.handle('fleet:menu-bar:get-exit-node-status', async (event) => {
    assertTrustedRenderer(event);
    return refreshExitNodeStatus();
  });
  ipcMain.handle('fleet:menu-bar:set-exit-node', async (event, input: unknown) => {
    assertTrustedRenderer(event);
    return setExitNode(input);
  });
  ipcMain.handle('fleet:menu-bar:read-clipboard-text', (event) => {
    assertTrustedRenderer(event);
    return clipboard.readText().slice(0, MAX_CLIPBOARD_TEXT);
  });
  ipcMain.handle('fleet:menu-bar:write-clipboard-text', (event, input: unknown) => {
    assertTrustedRenderer(event);
    if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_CLIPBOARD_TEXT || input.includes('\0')) throw new Error('Invalid clipboard text');
    clipboard.writeText(input);
  });
  ipcMain.handle('fleet:codex-micro:get-state', (event) => {
    assertTrustedRenderer(event);
    return codexMicroController?.getState() ?? {
      status: process.platform === 'darwin' ? 'not-detected' : 'unsupported',
      name: 'Codex Micro',
      error: null,
      inputMonitoringRequired: false,
      batteryPercent: null,
      isCharging: null,
      firmwareVersion: null,
      selectedSlot: null,
      activeSessionId: codexMicroActiveSessionId,
      voice: nativeVoiceCapture?.getState() ?? { state: 'idle', sessionId: null },
      slots: [],
      preferences: codexMicroPreferences,
    } satisfies CodexMicroDeviceState;
  });
  ipcMain.handle('fleet:codex-micro:set-preferences', async (event, input: unknown) => {
    assertTrustedRenderer(event, ['main']);
    codexMicroPreferences = codexMicroController?.updatePreferences(input) ?? normalizeCodexMicroPreferences(input);
    await saveDesktopPreferences();
    emitCodexMicroState();
    return codexMicroController?.getState();
  });
  ipcMain.handle('fleet:codex-micro:retry', async (event) => {
    assertTrustedRenderer(event, ['main']);
    await codexMicroController?.stop();
    codexMicroController?.start();
    return codexMicroController?.getState();
  });
  ipcMain.handle('fleet:codex-micro:set-active-session', (event, input: unknown) => {
    assertTrustedRenderer(event, ['main']);
    if (input !== null && (typeof input !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(input))) throw new Error('Invalid active Codex session');
    codexMicroActiveSessionId = input;
    codexMicroController?.setActiveSession(input);
  });
  ipcMain.handle('fleet:codex-micro:start-voice-capture', async (event) => {
    assertTrustedRenderer(event, ['main']);
    return nativeVoiceCapture?.start(codexMicroActiveSessionId) ?? { state: 'error', sessionId: codexMicroActiveSessionId, code: 'unavailable', error: 'Native voice capture is unavailable.' } satisfies CodexMicroVoiceState;
  });
  ipcMain.handle('fleet:codex-micro:stop-voice-capture', async (event) => {
    assertTrustedRenderer(event, ['main']);
    return nativeVoiceCapture?.stop() ?? { state: 'idle', sessionId: null } satisfies CodexMicroVoiceState;
  });
  ipcMain.handle('fleet:codex-micro:get-voice-state', (event) => {
    assertTrustedRenderer(event, ['main']);
    return nativeVoiceCapture?.getState() ?? { state: 'idle', sessionId: null } satisfies CodexMicroVoiceState;
  });
  ipcMain.handle('fleet:codex-micro:signal-feedback', (event, input: unknown) => {
    assertTrustedRenderer(event, ['main']);
    if (!['pending', 'success', 'error'].includes(String(input))) throw new Error('Invalid Codex Micro feedback');
    codexMicroController?.signalFeedback(input as CodexMicroFeedback);
  });
  ipcMain.handle('fleet:codex-micro:open-input-monitoring', async (event) => {
    assertTrustedRenderer(event, ['main']);
    if (process.platform !== 'darwin') return;
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  });
  ipcMain.handle('fleet:codex-micro:open-voice-privacy', async (event, input: unknown) => {
    assertTrustedRenderer(event, ['main']);
    if (process.platform !== 'darwin') return;
    if (input !== 'microphone' && input !== 'speech-recognition') throw new Error('Invalid voice privacy setting');
    const pane = input === 'microphone' ? 'Privacy_Microphone' : 'Privacy_SpeechRecognition';
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  });
}

function connectWebSocket(): void {
  if (stopping) return;
  websocket?.close();
  const wsUrl = `${coreUrl.replace(/^http/, 'ws')}/ws/client`;
  websocket = new WebSocket(wsUrl, {
    headers: fleetToken ? { authorization: `Bearer ${fleetToken}` } : undefined,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false
  });
  websocket.on('open', () => {
    websocketConnected = true;
    mainWindow?.webContents.send('fleet:connection', true);
    menuBarWindow?.webContents.send('fleet:connection', true);
    void pollMenuBarSnapshot();
  });
  websocket.on('message', (data) => {
    const message = data.toString();
    mainWindow?.webContents.send('fleet:event', message);
    menuBarWindow?.webContents.send('fleet:event', message);
    if (menuBarEventRefreshTimer) clearTimeout(menuBarEventRefreshTimer);
    menuBarEventRefreshTimer = setTimeout(() => {
      menuBarEventRefreshTimer = null;
      void pollMenuBarSnapshot();
    }, 180);
  });
  websocket.on('close', () => {
    websocketConnected = false;
    mainWindow?.webContents.send('fleet:connection', false);
    menuBarWindow?.webContents.send('fleet:connection', false);
    if (!stopping) reconnectTimer = setTimeout(connectWebSocket, 1_500);
  });
  websocket.on('error', () => websocket?.close());
}

function createWindow(initiallyVisible = true): void {
  mainWindowReady = false;
  mainTargetListenerReady = false;
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1024,
    minHeight: 680,
    // Display the native shell immediately against the configured dark
    // background. Some GPU/renderer combinations never emit
    // `ready-to-show`, which otherwise leaves a healthy Fleet window hidden.
    show: initiallyVisible,
    backgroundColor: '#080b10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Keep the macOS window controls in the title-bar inset, above the
    // sidebar brand instead of overlapping its 18px top edge.
    trafficLightPosition: { x: 18, y: 8 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  secureRendererWindow(mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindowReady = true;
    mainWindow?.webContents.send('fleet:connection', websocketConnected);
    emitCodexMicroState();
  });
  mainWindow.webContents.on('did-start-loading', () => { mainTargetListenerReady = false; });
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !stopping) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; mainWindowReady = false; mainTargetListenerReady = false; });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function secureRendererWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(validatedExternalUrl(url)).catch(() => undefined); } catch { /* deny invalid and untrusted protocols */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (!current) { event.preventDefault(); return; }
    const currentWithoutFragment = current.split('#', 1)[0];
    const nextWithoutFragment = url.split('#', 1)[0];
    if (currentWithoutFragment !== nextWithoutFragment) event.preventDefault();
  });
}

function loadMenuBarRenderer(window: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set('view', 'menubar');
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: 'menubar' } });
  }
}

function placeMenuBarWindow(bounds = tray?.getBounds()): void {
  if (!menuBarWindow || menuBarWindow.isDestroyed()) return;
  const anchor = resolvedMenuBarAnchor(bounds);
  if (!anchor) return;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(anchor.x + anchor.width / 2),
    y: Math.round(anchor.y + anchor.height / 2)
  });
  const position = positionMenuBarWindow(anchor, menuBarWindow.getBounds(), display.workArea);
  menuBarWindow.setPosition(position.x, position.y, false);
}

function resolvedMenuBarAnchor(bounds?: RectangleLike): RectangleLike | undefined {
  if (bounds) {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2)
    });
    if (isUsableMenuBarAnchor(bounds, display.bounds)) return bounds;
  }
  const display = screen.getPrimaryDisplay();
  return {
    x: display.workArea.x + display.workArea.width - 28,
    y: display.bounds.y + 2,
    width: 22,
    height: 22
  };
}

function showMenuBarWhenTrayReady(attempt = 0): void {
  const bounds = tray?.getBounds();
  if (bounds) {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2)
    });
    if (isUsableMenuBarAnchor(bounds, display.bounds)) {
      showMenuBarWindow(bounds);
      return;
    }
  }
  if (attempt < 20) {
    setTimeout(() => showMenuBarWhenTrayReady(attempt + 1), 100);
    return;
  }
  showMenuBarWindow(resolvedMenuBarAnchor());
}

function showMenuBarWindow(bounds = tray?.getBounds()): void {
  if (!menuBarWindow || menuBarWindow.isDestroyed()) return;
  placeMenuBarWindow(bounds);
  emitMenuBarState();
  menuBarWindow.show();
  menuBarWindow.focus();
  void pollMenuBarSnapshot();
}

function toggleMenuBarWindow(bounds = tray?.getBounds()): void {
  if (!menuBarWindow || menuBarWindow.isDestroyed()) return;
  if (menuBarWindow.isVisible()) menuBarWindow.hide();
  else showMenuBarWindow(bounds);
}

function handleMenuBarToggleRequest(): void {
  if (!app.isReady() || !menuBarWindow || menuBarWindow.isDestroyed()) {
    pendingMenuBarToggle = true;
    return;
  }
  pendingMenuBarToggle = false;
  if (menuBarWindow.isVisible()) menuBarWindow.hide();
  // Requests from the native AppKit status item do not have Electron tray
  // bounds. On affected macOS/Electron combinations getBounds() remains at
  // the bottom-left startup sentinel, so waiting for it adds a two-second
  // delay on every click. Use the deterministic top-right anchor immediately.
  else showMenuBarWindow(resolvedMenuBarAnchor());
}

function trayContextMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Orchestra Canvas', click: () => showMainWindow({ page: 'overview' }) },
    { label: 'Refresh Orchestra Status', click: () => void pollMenuBarSnapshot() },
    { type: 'separator' },
    {
      label: 'Quiet Mode', type: 'checkbox', checked: quietMode === 'quiet', click: (item) => {
        quietMode = item.checked ? 'quiet' : 'normal';
        void saveDesktopPreferences().then(emitMenuBarState).catch((error) => console.error('[fleet] quiet mode could not be saved', error));
      }
    },
    {
      label: 'Launch at Login', type: 'checkbox', checked: app.getLoginItemSettings(loginItemIdentity()).openAtLogin, click: (item) => {
        app.setLoginItemSettings({ ...loginItemIdentity(), openAtLogin: item.checked, openAsHidden: true });
        emitMenuBarState();
      }
    },
    { type: 'separator' },
    { label: 'Quit Orchestra Canvas', click: () => app.quit() }
  ]);
}

function createMenuBar(): void {
  tray = new Tray(trayImage('disconnected'), MENU_BAR_TRAY_GUID);
  tray.setTitle('◇');
  tray.setToolTip('Orchestra Canvas — connecting to Core');
  tray.on('click', (_event, bounds) => toggleMenuBarWindow(bounds));
  tray.on('right-click', () => tray?.popUpContextMenu(trayContextMenu()));

  menuBarWindow = new BrowserWindow({
    width: MENU_BAR_WIDTH,
    height: MENU_BAR_HEIGHT,
    minWidth: MENU_BAR_WIDTH,
    maxWidth: MENU_BAR_WIDTH,
    minHeight: 480,
    maxHeight: 820,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#101318',
    vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  secureRendererWindow(menuBarWindow);
  menuBarWindow.setAlwaysOnTop(true, 'pop-up-menu');
  menuBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  menuBarWindow.webContents.on('did-finish-load', () => {
    menuBarWindow?.webContents.send('fleet:connection', websocketConnected);
    emitMenuBarState();
    if (pendingMenuBarToggle || process.env.FLEET_MENUBAR_OPEN_ON_START === 'true') {
      pendingMenuBarToggle = false;
      setTimeout(() => showMenuBarWhenTrayReady(), 0);
    }
  });
  menuBarWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') { event.preventDefault(); menuBarWindow?.hide(); }
  });
  menuBarWindow.on('blur', () => {
    setTimeout(() => { if (!menuBarWindow?.isFocused()) menuBarWindow?.hide(); }, 40);
  });
  menuBarWindow.on('close', (event) => {
    if (!stopping) { event.preventDefault(); menuBarWindow?.hide(); }
  });
  menuBarWindow.on('closed', () => { menuBarWindow = null; });
  loadMenuBarRenderer(menuBarWindow);

  const shortcut = process.env.FLEET_MENUBAR_SHORTCUT?.trim() || DEFAULT_MENU_BAR_SHORTCUT;
  if (!globalShortcut.register(shortcut, () => toggleMenuBarWindow())) {
    console.warn(`[fleet] ${shortcut} is already in use; the menu-bar shortcut was not registered.`);
  }
}

const ownsInstanceLock = app.requestSingleInstanceLock();
if (!ownsInstanceLock) app.quit();
else {
  if (process.platform === 'darwin') process.on('SIGUSR2', handleMenuBarToggleRequest);
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(MENU_BAR_TOGGLE_ARG)) {
      handleMenuBarToggleRequest();
      return;
    }
    if (app.isReady()) showMainWindow({ page: 'overview' });
    else app.once('ready', () => showMainWindow({ page: 'overview' }));
  });

  app.whenReady().then(async () => {
    await resolveDesktopConnection();
    fleetToken = await resolveFleetToken();
    await loadDesktopPreferences();
    nativeVoiceCapture = new NativeVoiceCapture({ onState: emitVoiceState });
    registerIpc();
    try { await startEmbeddedServices(); } catch (error) { console.error('[fleet] embedded startup failed', error); }
    const loginSettings = app.getLoginItemSettings(loginItemIdentity());
    const menuBarOnlyLaunch = pendingMenuBarToggle || shouldStartMenuBarOnly(process.argv, loginSettings);
    createWindow(!menuBarOnlyLaunch);
    if (process.platform === 'darwin') createMenuBar();
    if (process.platform === 'darwin') createCodexMicroController();
    connectWebSocket();
    if (process.platform === 'darwin') {
      startMenuBarPolling();
      void refreshExitNodeStatus();
    }
    app.on('activate', () => showMainWindow({ page: 'overview' }));
  }).catch((error) => {
    console.error('[fleet] Desktop startup failed', error);
    app.quit();
  });
}

async function resolveFleetToken(): Promise<string> {
  if (fleetToken) return fleetToken;
  if (!isLoopback) throw new Error('FLEET_TOKEN is required for a remote Orchestra Core.');
  const directory = app.getPath('userData'); const tokenPath = join(directory, 'local-core-token');
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString('hex'), temporary = `${tokenPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, tokenPath);
  return value;
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (menuBarPollTimer) clearInterval(menuBarPollTimer);
  if (menuBarEventRefreshTimer) clearTimeout(menuBarEventRefreshTimer);
  if (menuBarPulseTimer) clearTimeout(menuBarPulseTimer);
  if (codexMicroDialBurstTimer) clearTimeout(codexMicroDialBurstTimer);
  codexMicroDialBurstTimer = null;
  codexMicroDialBurst = null;
  globalShortcut.unregisterAll();
  websocket?.close();
  localAgentProcess?.kill('SIGTERM');
  void codexMicroController?.stop();
  nativeVoiceCapture?.dispose();
  tray?.destroy();
  tray = null;
  void stopHandle(embeddedCore);
});

async function stopHandle(handle: unknown): Promise<void> {
  if (!handle || typeof handle !== 'object') return;
  const candidate = handle as { stop?: () => unknown; close?: () => unknown };
  try {
    if (candidate.stop) await candidate.stop();
    else if (candidate.close) await candidate.close();
  } catch (error) { console.error('[fleet] embedded shutdown failed', error); }
}
