import { createRequire } from 'node:module';
import type {
  CodexMicroActionId,
  CodexMicroAgentSlotState,
  CodexMicroCommandSlot,
  CodexMicroDeviceState,
  CodexMicroDirection,
  CodexMicroFeedback,
  CodexMicroLightStatus,
  CodexMicroPreferences,
  CodexMicroVoiceState,
  MenuBarCodexSession,
} from '@fleet/shared';
import { CODEX_MICRO_AGENT_SLOTS, CODEX_MICRO_KEYCAPS, defaultCodexMicroPreferences } from '@fleet/shared';

const dynamicRequire = createRequire(import.meta.url);
const RECONNECT_MS = 10_000;
const DISCONNECT_RECONNECT_MS = 1_000;
const BATTERY_REFRESH_MS = 60_000;
const DEVICE_WRITE_QUIET_MS = 100;
const INPUT_DEVICE_WRITE_QUIET_MS = 120;
const SELECTED_LIGHTING_MS = 4_000;
const TERMINAL_SESSION_GRACE_MS = 30 * 60_000;
const FEEDBACK_LIGHTING_MS = 1_400;

const COLORS = {
  off: 0x000000,
  idle: 0xffffff,
  working: 0x00c8ff,
  unread: 0x00ff4c,
  awaitingApproval: 0xff6d00,
  error: 0xff0033,
  transcribing: 0x8b5cf6,
} as const;

interface WorkLouderDevice {
  productName?: string;
  deviceType?: string;
}

interface WorkLouderComm {
  connect(device: WorkLouderDevice): Promise<void>;
  disconnect(): Promise<void>;
  onConnectionEvent(listener: (event: { type: unknown; error?: unknown }) => void): () => void;
}

interface WorkLouderApi {
  onHidReceived(listener: (event: { key: string; act?: number; agent?: number }) => void): () => void;
  onJoystickMove(listener: (event: { angle: number; distance: number }) => void): () => void;
  getDeviceStatus(): Promise<Record<string, unknown>>;
  sendLightingConfig(config: unknown): Promise<boolean>;
  sendThreadsLighting(config: unknown[]): Promise<boolean>;
}

interface WorkLouderKit {
  ConnectionEventType: { CONNECTED: unknown; DISCONNECTED: unknown; ERROR: unknown };
  DeviceType: { Project2077: unknown };
  OAILightingEffect: { off: number; solid: number; snake: number; breath: number };
  WLDeviceDiscovery: new () => { findWLDevices(types: unknown[]): WorkLouderDevice[] };
  WLDeviceCommImpl: new () => WorkLouderComm;
  RPCApiOAI: new (comm: WorkLouderComm) => WorkLouderApi;
}

export interface CodexMicroControllerOptions {
  initialReadAt?: Record<string, number>;
  onStateChanged(state: CodexMicroDeviceState): void;
  onReadStateChanged?(readAt: Record<string, number>): void;
  onSessionSelected(session: MenuBarCodexSession, focusWindow: boolean): void;
  onAction(action: CodexMicroActionId, phase: 'press' | 'release', session: MenuBarCodexSession | null, customShortcut?: string): void;
  onDial(direction: 'clockwise' | 'counterclockwise' | 'press' | 'release', mode: CodexMicroPreferences['dialMode'], session: MenuBarCodexSession | null): void;
}

export function codexMicroDialDirection(event: { key: string; act?: number }): 'clockwise' | 'counterclockwise' | 'press' | 'release' | null {
  if (event.key === 'ENC_CW') return event.act === 2 ? 'clockwise' : null;
  if (event.key === 'ENC_CC') return event.act === 2 ? 'counterclockwise' : null;
  if (!event.key.startsWith('ENC')) return null;
  if (event.act === 1) return 'press';
  if (event.act === 0) return 'release';
  return null;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function sourcePriority(session: MenuBarCodexSession, readAt: number): number {
  if (session.status === 'awaiting-approval' || session.pendingApprovalCount > 0) return 0;
  if (session.status === 'thinking' || session.status === 'starting') return 1;
  if (session.status === 'error' && timeValue(session.updatedAt) > readAt) return 2;
  if (session.status === 'completed' && timeValue(session.updatedAt) > readAt) return 3;
  if (session.status === 'ready') return 4;
  return 5;
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lightStatus(session: MenuBarCodexSession, readAt: number): CodexMicroLightStatus {
  if (session.status === 'awaiting-approval' || session.pendingApprovalCount > 0) return 'awaiting-approval';
  if (session.status === 'thinking' || session.status === 'starting') return 'working';
  if (session.status === 'error' && timeValue(session.updatedAt) > readAt) return 'error';
  if (session.status === 'completed' && timeValue(session.updatedAt) > readAt) return 'unread';
  if (session.status === 'stopped') return 'off';
  return 'idle';
}

function statusColor(status: CodexMicroLightStatus): number {
  if (status === 'awaiting-approval') return COLORS.awaitingApproval;
  return COLORS[status];
}

function clampedBrightness(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

const commandSlotIds = ['ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT10_ACT11', 'ACT12'] as const;
const sourceModes = new Set(['recent', 'priority', 'pinned', 'custom']);
const dialModes = new Set(['composer-navigation', 'model-reasoning']);
const keycapDefinitions = new Map(CODEX_MICRO_KEYCAPS.map((item) => [item.id, item]));

function normalizeCommandSlot(value: unknown, fallback: CodexMicroCommandSlot, expectedSize: 'single' | 'double'): CodexMicroCommandSlot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const candidate = value as Partial<CodexMicroCommandSlot>;
  const definition = typeof candidate.keycapId === 'string' ? keycapDefinitions.get(candidate.keycapId as never) : undefined;
  if (!definition || definition.size !== expectedSize || typeof candidate.actionId !== 'string') return fallback;
  return {
    keycapId: definition.id,
    actionId: candidate.actionId as CodexMicroActionId,
    ...(typeof candidate.customShortcut === 'string' && candidate.customShortcut.trim()
      ? { customShortcut: candidate.customShortcut.trim().slice(0, 200) }
      : {}),
  };
}

export function normalizeCodexMicroPreferences(value: unknown): CodexMicroPreferences {
  const defaults = defaultCodexMicroPreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const candidate = value as Partial<CodexMicroPreferences>;
  const rawDialMode = (value as Record<string, unknown>).dialMode;
  const commandSlots = Object.fromEntries(commandSlotIds.map((slotId) => [
    slotId,
    normalizeCommandSlot(candidate.commandSlots?.[slotId], defaults.commandSlots[slotId], slotId === 'ACT10_ACT11' ? 'double' : 'single'),
  ])) as CodexMicroPreferences['commandSlots'];
  const joystick = { ...defaults.joystick };
  if (candidate.joystick && typeof candidate.joystick === 'object') {
    for (const direction of ['up', 'right', 'down', 'left'] as const) {
      if (typeof candidate.joystick[direction] === 'string') joystick[direction] = candidate.joystick[direction];
    }
  }
  return {
    enabled: candidate.enabled !== false,
    sourceMode: sourceModes.has(String(candidate.sourceMode)) ? candidate.sourceMode! : defaults.sourceMode,
    brightness: clampedBrightness(candidate.brightness, defaults.brightness),
    inactivityTimeoutMs: candidate.inactivityTimeoutMs === null
      ? null
      : typeof candidate.inactivityTimeoutMs === 'number' && Number.isFinite(candidate.inactivityTimeoutMs)
        ? Math.max(60_000, Math.min(24 * 60 * 60_000, Math.floor(candidate.inactivityTimeoutMs)))
        : defaults.inactivityTimeoutMs,
    agentAssignments: Array.from({ length: CODEX_MICRO_AGENT_SLOTS }, (_, index) => {
      const sessionId = candidate.agentAssignments?.[index];
      return typeof sessionId === 'string' && sessionId ? sessionId : null;
    }),
    pinnedSessionIds: Array.isArray(candidate.pinnedSessionIds)
      ? [...new Set(candidate.pinnedSessionIds.filter((item): item is string => typeof item === 'string' && Boolean(item)))].slice(0, 100)
      : [],
    commandSlots,
    joystick,
    dialMode: rawDialMode === 'reasoning'
      ? 'model-reasoning'
      : dialModes.has(String(rawDialMode)) ? rawDialMode as CodexMicroPreferences['dialMode'] : defaults.dialMode,
  };
}

export class CodexMicroController {
  readonly #options: CodexMicroControllerOptions;
  #preferences: CodexMicroPreferences;
  #sessions: MenuBarCodexSession[] = [];
  #slotSessions: Array<MenuBarCodexSession | null> = Array.from({ length: CODEX_MICRO_AGENT_SLOTS }, () => null);
  #readAt: Map<string, number>;
  #initializedReadState = false;
  #selectedSlot: number | null = null;
  #activeSessionId: string | null = null;
  #voice: CodexMicroVoiceState = { state: 'idle', sessionId: null };
  #feedback: CodexMicroFeedback | null = null;
  #state: CodexMicroDeviceState;
  #kit: WorkLouderKit | null = null;
  #comm: WorkLouderComm | null = null;
  #api: WorkLouderApi | null = null;
  #stopped = true;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #batteryTimer: ReturnType<typeof setTimeout> | null = null;
  #selectionTimer: ReturnType<typeof setTimeout> | null = null;
  #inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  #writeQuietTimer: ReturnType<typeof setTimeout> | null = null;
  #inputQuietTimer: ReturnType<typeof setTimeout> | null = null;
  #feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  #lastActivityAt = Date.now();
  #inputActive = false;
  #lightingWriteDeferred = false;
  #statusRefreshDeferred = false;
  #lastLightingSignature: string | null = null;
  #writeChain: Promise<unknown> = Promise.resolve();
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeHid: (() => void) | null = null;
  #unsubscribeJoystick: (() => void) | null = null;
  #joystickDirection: CodexMicroDirection | null = null;
  #selectionLightingVisible = false;
  #lightsOffForInactivity = false;
  #fleetAttention: CodexMicroLightStatus | null = null;

  constructor(preferences: unknown, options: CodexMicroControllerOptions) {
    this.#options = options;
    this.#preferences = normalizeCodexMicroPreferences(preferences);
    this.#readAt = new Map(Object.entries(options.initialReadAt ?? {}).filter(([, at]) => Number.isFinite(at) && at >= 0));
    this.#initializedReadState = options.initialReadAt !== undefined;
    this.#state = {
      status: process.platform === 'darwin' ? 'not-detected' : 'unsupported',
      name: 'Codex Micro',
      error: null,
      inputMonitoringRequired: false,
      batteryPercent: null,
      isCharging: null,
      firmwareVersion: null,
      selectedSlot: null,
      activeSessionId: null,
      voice: this.#voice,
      slots: this.#buildSlotState(),
      preferences: this.#preferences,
    };
  }

  getState(): CodexMicroDeviceState { return this.#state; }

  start(): void {
    if (process.platform !== 'darwin' || !this.#preferences.enabled) {
      this.#setState({ status: process.platform === 'darwin' ? 'not-detected' : 'unsupported' });
      return;
    }
    this.#stopped = false;
    try {
      this.#kit = loadWorkLouderKit();
    } catch (error) {
      this.#setState({ status: 'kit-unavailable', error: error instanceof Error ? error.message : 'Codex Micro device support is unavailable.' });
      return;
    }
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();
    this.#clearSubscriptions();
    const api = this.#api;
    const comm = this.#comm;
    this.#api = null;
    this.#comm = null;
    this.#lastLightingSignature = null;
    if (api) {
      await Promise.allSettled([
        api.sendLightingConfig(this.#offLightingConfig()),
        api.sendThreadsLighting(this.#offThreadLighting()),
      ]);
    }
    await comm?.disconnect().catch(() => undefined);
    this.#setState({ status: 'not-detected', batteryPercent: null, isCharging: null, firmwareVersion: null, error: null });
  }

  updateSessions(sessions: MenuBarCodexSession[]): void {
    this.#sessions = sessions;
    if (!this.#initializedReadState && sessions.length > 0) {
      for (const session of sessions) {
        if (session.status === 'completed' || session.status === 'error') {
          this.#readAt.set(session.id, timeValue(session.updatedAt));
        }
      }
      this.#initializedReadState = true;
      this.#publishReadState();
    }
    const byId = new Map(sessions.map((session) => [session.id, session]));
    let desired: Array<MenuBarCodexSession | null>;
    if (this.#preferences.sourceMode === 'custom') {
      desired = this.#preferences.agentAssignments.map((id) => id ? byId.get(id) ?? null : null);
    } else {
      const ranked = this.#rankedSessions(byId);
      const allowed = new Set(ranked.slice(0, CODEX_MICRO_AGENT_SLOTS).map((session) => session.id));
      const stable = this.#slotSessions.map((session) => session && allowed.has(session.id) ? byId.get(session.id) ?? null : null);
      const used = new Set(stable.flatMap((session) => session ? [session.id] : []));
      const fill = ranked.filter((session) => !used.has(session.id));
      desired = stable.map((session) => session ?? fill.shift() ?? null);
    }
    this.#slotSessions = desired;
    if (this.#selectedSlot !== null && !this.#slotSessions[this.#selectedSlot]) this.#selectedSlot = null;
    // Keep the renderer-selected target while Core catches up after a new chat is
    // created. The next snapshot will resolve it without reviving an older slot.
    this.#publishState();
    this.#scheduleLightingWrite();
  }

  setActiveSession(sessionId: string | null): void {
    this.#activeSessionId = sessionId;
    const slot = sessionId ? this.#slotSessions.findIndex((session) => session?.id === sessionId) : -1;
    this.#selectedSlot = slot >= 0 ? slot : null;
    if (sessionId) this.#markViewed(sessionId);
    this.updateSessions(this.#sessions);
  }

  updateVoiceState(state: CodexMicroVoiceState): void {
    this.#voice = state;
    this.#publishState();
    this.#scheduleLightingWrite();
  }

  signalFeedback(feedback: CodexMicroFeedback): void {
    this.#feedback = feedback;
    if (this.#feedbackTimer) clearTimeout(this.#feedbackTimer);
    this.#feedbackTimer = setTimeout(() => {
      this.#feedbackTimer = null;
      this.#feedback = null;
      this.#scheduleLightingWrite();
    }, FEEDBACK_LIGHTING_MS);
    this.#scheduleLightingWrite();
  }

  updateFleetAttention(summary: { openCriticalAlerts: number; pendingApprovals: number; openWarnings: number; failedJobs: number; activeJobs: number }): void {
    const next: CodexMicroLightStatus | null = summary.openCriticalAlerts > 0 || summary.failedJobs > 0
      ? 'error'
      : summary.pendingApprovals > 0 || summary.openWarnings > 0
        ? 'awaiting-approval'
        : summary.activeJobs > 0
          ? 'working'
          : null;
    if (next === this.#fleetAttention) return;
    this.#fleetAttention = next;
    this.#scheduleLightingWrite();
  }

  updatePreferences(value: unknown): CodexMicroPreferences {
    const wasEnabled = this.#preferences.enabled;
    this.#preferences = normalizeCodexMicroPreferences(value);
    this.updateSessions(this.#sessions);
    if (!wasEnabled && this.#preferences.enabled) this.start();
    if (wasEnabled && !this.#preferences.enabled) void this.stop();
    this.#resetInactivityTimer();
    this.#scheduleLightingWrite();
    return this.#preferences;
  }

  #rankedSessions(byId: Map<string, MenuBarCodexSession>): MenuBarCodexSession[] {
    if (this.#preferences.sourceMode === 'pinned') {
      return this.#preferences.pinnedSessionIds.flatMap((id) => byId.get(id) ?? []);
    }
    const now = Date.now();
    const candidates = this.#sessions.filter((session) => {
      if (session.status === 'stopped') return false;
      if (session.status !== 'completed' && session.status !== 'error') return true;
      const readAt = this.#readAt.get(session.id) ?? 0;
      return timeValue(session.updatedAt) > readAt || now - readAt <= TERMINAL_SESSION_GRACE_MS;
    });
    if (this.#preferences.sourceMode === 'priority') {
      return [...candidates].sort((left, right) => sourcePriority(left, this.#readAt.get(left.id) ?? 0) - sourcePriority(right, this.#readAt.get(right.id) ?? 0)
        || timeValue(right.updatedAt) - timeValue(left.updatedAt));
    }
    return [...candidates].sort((left, right) => timeValue(right.updatedAt) - timeValue(left.updatedAt));
  }

  async #connect(): Promise<void> {
    if (this.#stopped || !this.#kit || this.#api) return;
    let device: WorkLouderDevice | undefined;
    try {
      const discovery = new this.#kit.WLDeviceDiscovery();
      [device] = discovery.findWLDevices([this.#kit.DeviceType.Project2077]);
    } catch (error) {
      this.#setState({ status: 'error', error: `Codex Micro discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`, inputMonitoringRequired: true });
      this.#scheduleReconnect(RECONNECT_MS);
      return;
    }
    if (!device) {
      this.#setState({ status: 'not-detected', error: null, inputMonitoringRequired: false });
      this.#scheduleReconnect(RECONNECT_MS);
      return;
    }
    this.#setState({ status: 'detected', name: device.productName ?? 'Codex Micro', error: null });
    const comm = new this.#kit.WLDeviceCommImpl();
    this.#unsubscribeConnection = comm.onConnectionEvent((event) => {
      if (!this.#kit) return;
      if (event.type === this.#kit.ConnectionEventType.DISCONNECTED || event.type === this.#kit.ConnectionEventType.ERROR) {
        this.#handleDisconnect(event.error);
      }
    });
    try {
      await comm.connect(device);
      if (this.#stopped) { await comm.disconnect(); return; }
      const api = new this.#kit.RPCApiOAI(comm);
      this.#comm = comm;
      this.#api = api;
      this.#lastLightingSignature = null;
      this.#unsubscribeHid = api.onHidReceived((event) => this.#handleHid(event));
      this.#unsubscribeJoystick = api.onJoystickMove((event) => this.#handleJoystick(event));
      this.#setState({ status: 'connected', error: null, inputMonitoringRequired: false });
      await this.#writeLighting();
      await this.#refreshDeviceStatus();
      this.#resetInactivityTimer();
    } catch (error) {
      this.#clearSubscriptions();
      await comm.disconnect().catch(() => undefined);
      this.#setState({
        status: 'error',
        error: `Codex Micro connection failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        inputMonitoringRequired: true,
      });
      this.#scheduleReconnect(RECONNECT_MS);
    }
  }

  #handleDisconnect(error?: unknown): void {
    const comm = this.#comm;
    this.#api = null;
    this.#comm = null;
    this.#lastLightingSignature = null;
    this.#clearSubscriptions();
    void comm?.disconnect().catch(() => undefined);
    this.#setState({ status: 'error', error: error instanceof Error ? error.message : 'Codex Micro disconnected.', batteryPercent: null, isCharging: null });
    this.#scheduleReconnect(DISCONNECT_RECONNECT_MS);
  }

  #handleHid(event: { key: string; act?: number }): void {
    this.#registerInputActivity();
    this.#registerActivity();
    const agentMatch = /^AG0([0-5])$/.exec(event.key);
    if (agentMatch && event.act === 1) {
      const slot = Number(agentMatch[1]);
      const session = this.#slotSessions[slot];
      if (!session) return;
      const now = Date.now();
      this.#selectedSlot = slot;
      this.#activeSessionId = session.id;
      this.#markViewed(session.id, now);
      this.#showSelectionLighting();
      this.#publishState();
      this.#scheduleLightingWrite();
      this.#options.onSessionSelected(session, true);
      return;
    }
    const dialDirection = codexMicroDialDirection(event);
    if (dialDirection) {
      this.#options.onDial(dialDirection, this.#preferences.dialMode, this.#commandSession());
      return;
    }
    if (event.key.startsWith('ENC')) return;
    const slotId = event.key === 'ACT10' ? 'ACT10_ACT11' : commandSlotIds.includes(event.key as never) ? event.key as typeof commandSlotIds[number] : null;
    if (!slotId || event.key === 'ACT11' || (event.act !== 0 && event.act !== 1)) return;
    const mapping = this.#preferences.commandSlots[slotId];
    if (mapping.actionId !== 'push-to-talk' && event.act !== 1) return;
    this.#options.onAction(mapping.actionId, event.act === 1 ? 'press' : 'release', this.#commandSession(), mapping.customShortcut);
  }

  #handleJoystick(event: { angle: number; distance: number }): void {
    this.#registerInputActivity();
    if (!Number.isFinite(event.distance) || event.distance <= 0.1) {
      this.#joystickDirection = null;
      return;
    }
    this.#registerActivity();
    const direction = joystickDirection(event.angle);
    if (direction === this.#joystickDirection) return;
    this.#joystickDirection = direction;
    this.#options.onAction(this.#preferences.joystick[direction], 'press', this.#commandSession());
  }

  #commandSession(): MenuBarCodexSession | null {
    return this.#activeSessionId ? this.#sessions.find((session) => session.id === this.#activeSessionId) ?? null : null;
  }

  #markViewed(sessionId: string, at = Date.now()): void {
    this.#readAt.set(sessionId, at);
    this.#publishReadState();
  }

  #publishReadState(): void {
    const entries = [...this.#readAt.entries()].sort((left, right) => right[1] - left[1]).slice(0, 500);
    this.#options.onReadStateChanged?.(Object.fromEntries(entries));
  }

  #buildSlotState(): CodexMicroAgentSlotState[] {
    return this.#slotSessions.map((session, slot) => ({
      slot,
      sessionId: session?.id ?? null,
      deviceId: session?.deviceId ?? null,
      deviceName: session?.deviceName ?? null,
      title: session?.title ?? null,
      sessionStatus: session?.status ?? null,
      lightStatus: session ? lightStatus(session, this.#readAt.get(session.id) ?? 0) : 'off',
      selected: slot === this.#selectedSlot,
      pendingApprovalCount: session?.pendingApprovalCount ?? 0,
    }));
  }

  #publishState(): void {
    this.#commitState({ ...this.#state, selectedSlot: this.#selectedSlot, activeSessionId: this.#activeSessionId, voice: this.#voice, slots: this.#buildSlotState(), preferences: this.#preferences });
  }

  #setState(patch: Partial<CodexMicroDeviceState>): void {
    this.#commitState({ ...this.#state, ...patch, activeSessionId: this.#activeSessionId, voice: this.#voice, slots: this.#buildSlotState(), preferences: this.#preferences });
  }

  #commitState(next: CodexMicroDeviceState): void {
    if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
    this.#state = next;
    this.#options.onStateChanged(next);
  }

  #showSelectionLighting(): void {
    this.#selectionLightingVisible = true;
    if (this.#selectionTimer) clearTimeout(this.#selectionTimer);
    this.#selectionTimer = setTimeout(() => {
      this.#selectionTimer = null;
      this.#selectionLightingVisible = false;
      this.#scheduleLightingWrite();
    }, SELECTED_LIGHTING_MS);
  }

  #scheduleLightingWrite(): void {
    if (!this.#api || this.#lightsOffForInactivity) return;
    if (this.#inputActive) {
      this.#lightingWriteDeferred = true;
      return;
    }
    if (this.#writeQuietTimer) clearTimeout(this.#writeQuietTimer);
    this.#writeQuietTimer = setTimeout(() => {
      this.#writeQuietTimer = null;
      void this.#writeLighting();
    }, DEVICE_WRITE_QUIET_MS);
  }

  #writeLighting(): Promise<void> {
    const run = async () => {
      const api = this.#api;
      const kit = this.#kit;
      if (!api || !kit || this.#lightsOffForInactivity) return;
      if (this.#inputActive) {
        this.#lightingWriteDeferred = true;
        return;
      }
      const brightness = this.#preferences.brightness;
      const slots = this.#buildSlotState();
      const selected = this.#selectedSlot === null ? undefined : slots[this.#selectedSlot];
      const selectedColor = selected ? statusColor(selected.lightStatus) : COLORS.off;
      const selectedWorking = selected?.lightStatus === 'working';
      const fleetAttentionColor = this.#fleetAttention ? statusColor(this.#fleetAttention) : COLORS.off;
      const offSide = { effect: kit.OAILightingEffect.off, brightness: 0, speed: 0, magic: 0, color: 0 };
      const voiceActive = this.#voice.state !== 'idle';
      const voiceColor = this.#voice.state === 'transcribing' ? COLORS.transcribing
        : this.#voice.state === 'error' ? COLORS.error : COLORS.working;
      const feedbackColor = this.#feedback === 'error' ? COLORS.error
        : this.#feedback === 'success' ? COLORS.unread
          : this.#feedback === 'pending' ? COLORS.awaitingApproval : COLORS.off;
      const overrideColor = voiceActive ? voiceColor : this.#feedback ? feedbackColor : null;
      const overrideEffect = this.#voice.state === 'listening' ? kit.OAILightingEffect.snake
        : this.#voice.state === 'transcribing' || this.#voice.state === 'requesting-permission' ? kit.OAILightingEffect.breath
          : kit.OAILightingEffect.solid;
      const lightingConfig = {
        keys: overrideColor !== null
          ? { effect: overrideEffect, brightness, speed: 0.4, magic: 0, color: overrideColor }
          : this.#selectionLightingVisible && selected
          ? { effect: kit.OAILightingEffect.solid, brightness, speed: 0, magic: 0, color: selectedColor }
          : offSide,
        ambient: overrideColor !== null
          ? { effect: overrideEffect, brightness, speed: 0.4, magic: 0, color: overrideColor }
          : selected && (selectedWorking || this.#selectionLightingVisible)
          ? { effect: selectedWorking ? kit.OAILightingEffect.snake : kit.OAILightingEffect.solid, brightness, speed: selectedWorking ? 0.4 : 0, magic: 0, color: selectedColor }
          : this.#fleetAttention
            ? { effect: kit.OAILightingEffect.snake, brightness: Math.min(brightness, 0.75), speed: this.#fleetAttention === 'working' ? 0.25 : 0.4, magic: 0, color: fleetAttentionColor }
            : offSide,
      };
      const threadLighting = slots.map((slot) => {
        const pulsing = slot.selected || slot.lightStatus === 'awaiting-approval' || slot.lightStatus === 'unread';
        return {
          id: slot.slot,
          color: statusColor(slot.lightStatus),
          brightness: slot.lightStatus === 'off' ? 0 : brightness,
          effect: slot.lightStatus === 'off' ? kit.OAILightingEffect.off : pulsing ? kit.OAILightingEffect.breath : kit.OAILightingEffect.solid,
          speed: pulsing ? 0.4 : 0,
          syncKeysLighting: false,
          syncAmbientLighting: false,
        };
      });
      const signature = JSON.stringify([lightingConfig, threadLighting]);
      if (signature === this.#lastLightingSignature) return;
      await api.sendLightingConfig(lightingConfig);
      if (api !== this.#api) return;
      if (this.#inputActive) {
        this.#lightingWriteDeferred = true;
        return;
      }
      await api.sendThreadsLighting(threadLighting);
      if (api === this.#api) this.#lastLightingSignature = signature;
    };
    this.#writeChain = this.#writeChain.then(run, run);
    return this.#writeChain.then(() => undefined);
  }

  async #refreshDeviceStatus(): Promise<void> {
    const api = this.#api;
    if (!api || this.#stopped) return;
    if (this.#inputActive) {
      this.#statusRefreshDeferred = true;
      return;
    }
    try {
      const status = await api.getDeviceStatus();
      if (api !== this.#api) return;
      const batteryPercent = numeric(status.batteryPercentage ?? status.battery_percent ?? status.battery);
      const version = status.version ?? status.firmwareVersion ?? status.firmware_version;
      this.#setState({
        status: 'connected',
        batteryPercent,
        isCharging: booleanOrNull(status.isCharging ?? status.is_charging),
        firmwareVersion: typeof version === 'string' ? version : this.#state.firmwareVersion,
      });
    } catch { /* Lighting and key events remain useful if status polling is unavailable. */ }
    if (!this.#stopped && this.#api === api) {
      if (this.#batteryTimer) clearTimeout(this.#batteryTimer);
      this.#batteryTimer = setTimeout(() => { this.#batteryTimer = null; void this.#refreshDeviceStatus(); }, BATTERY_REFRESH_MS);
    }
  }

  #registerActivity(): void {
    this.#lastActivityAt = Date.now();
    if (this.#lightsOffForInactivity) {
      this.#lightsOffForInactivity = false;
      this.#lastLightingSignature = null;
      this.#scheduleLightingWrite();
    }
    this.#scheduleInactivityTimer();
  }

  #registerInputActivity(): void {
    this.#inputActive = true;
    if (this.#writeQuietTimer) {
      clearTimeout(this.#writeQuietTimer);
      this.#lightingWriteDeferred = true;
    }
    this.#writeQuietTimer = null;
    if (this.#inputQuietTimer) clearTimeout(this.#inputQuietTimer);
    this.#inputQuietTimer = setTimeout(() => {
      this.#inputQuietTimer = null;
      this.#inputActive = false;
      if (this.#lightingWriteDeferred) {
        this.#lightingWriteDeferred = false;
        this.#scheduleLightingWrite();
      }
      if (this.#statusRefreshDeferred) {
        this.#statusRefreshDeferred = false;
        void this.#refreshDeviceStatus();
      }
    }, INPUT_DEVICE_WRITE_QUIET_MS);
  }

  #resetInactivityTimer(): void {
    if (this.#inactivityTimer) clearTimeout(this.#inactivityTimer);
    this.#inactivityTimer = null;
    this.#lastActivityAt = Date.now();
    this.#scheduleInactivityTimer();
  }

  #scheduleInactivityTimer(): void {
    const timeout = this.#preferences.inactivityTimeoutMs;
    if (!timeout || !this.#api || this.#inactivityTimer) return;
    const remaining = Math.max(1, timeout - (Date.now() - this.#lastActivityAt));
    this.#inactivityTimer = setTimeout(() => {
      this.#inactivityTimer = null;
      const currentTimeout = this.#preferences.inactivityTimeoutMs;
      if (!currentTimeout || !this.#api) return;
      const currentRemaining = currentTimeout - (Date.now() - this.#lastActivityAt);
      if (currentRemaining > 0) {
        this.#scheduleInactivityTimer();
        return;
      }
      this.#lightsOffForInactivity = true;
      this.#lastLightingSignature = null;
      const api = this.#api;
      if (!api) return;
      this.#writeChain = this.#writeChain.then(async () => {
        await api.sendLightingConfig(this.#offLightingConfig());
        await api.sendThreadsLighting(this.#offThreadLighting());
      });
    }, remaining);
  }

  #offLightingConfig(): unknown {
    const effect = this.#kit?.OAILightingEffect.off ?? 0;
    const side = { effect, brightness: 0, speed: 0, magic: 0, color: 0 };
    return { keys: side, ambient: side };
  }

  #offThreadLighting(): unknown[] {
    const effect = this.#kit?.OAILightingEffect.off ?? 0;
    return Array.from({ length: CODEX_MICRO_AGENT_SLOTS }, (_, id) => ({ id, color: 0, brightness: 0, effect, speed: 0, syncKeysLighting: false, syncAmbientLighting: false }));
  }

  #scheduleReconnect(delay: number): void {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }

  #clearSubscriptions(): void {
    this.#unsubscribeConnection?.();
    this.#unsubscribeHid?.();
    this.#unsubscribeJoystick?.();
    this.#unsubscribeConnection = null;
    this.#unsubscribeHid = null;
    this.#unsubscribeJoystick = null;
  }

  #clearTimers(): void {
    for (const timer of [this.#reconnectTimer, this.#batteryTimer, this.#selectionTimer, this.#inactivityTimer, this.#writeQuietTimer, this.#inputQuietTimer, this.#feedbackTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#reconnectTimer = null;
    this.#batteryTimer = null;
    this.#selectionTimer = null;
    this.#inactivityTimer = null;
    this.#writeQuietTimer = null;
    this.#inputQuietTimer = null;
    this.#feedbackTimer = null;
    this.#inputActive = false;
    this.#lightingWriteDeferred = false;
    this.#statusRefreshDeferred = false;
  }
}

function joystickDirection(angle: number): CodexMicroDirection {
  const normalized = ((angle % 1) + 1) % 1;
  if (normalized < 0.125 || normalized >= 0.875) return 'right';
  if (normalized < 0.375) return 'down';
  if (normalized < 0.625) return 'left';
  return 'up';
}

function loadWorkLouderKit(): WorkLouderKit {
  const configured = process.env.FLEET_CODEX_MICRO_DEVICE_KIT?.trim();
  const candidates = [
    configured,
    '@worklouder/device-kit-oai',
    '/Applications/ChatGPT.app/Contents/Resources/app.asar/node_modules/@worklouder/device-kit-oai',
    '/Applications/Codex.app/Contents/Resources/app.asar/node_modules/@worklouder/device-kit-oai',
  ].filter((value): value is string => Boolean(value));
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const kit = dynamicRequire(candidate) as Partial<WorkLouderKit>;
      if (kit.WLDeviceDiscovery && kit.WLDeviceCommImpl && kit.RPCApiOAI && kit.DeviceType?.Project2077 !== undefined) return kit as WorkLouderKit;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Install the current ChatGPT/Codex desktop app to provide Codex Micro device support.${failures.length ? ` (${failures.at(-1)})` : ''}`);
}
