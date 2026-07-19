import { contextBridge, ipcRenderer } from 'electron';
import type { CodexMicroActionId, CodexMicroDeviceState, CodexMicroFeedback, CodexMicroPreferences, CodexMicroVoiceState, MenuBarSnapshot } from '@fleet/shared';

export interface OpenMainTarget {
  page?: string;
  deviceId?: string;
  tab?: string;
  entityId?: string;
  navigationTarget?: { sessionId: string; sequence: number };
}

export interface OpenFullAppTarget extends OpenMainTarget {
  jobId?: string;
  sessionId?: string;
  alertId?: string;
}

export interface ExitNodeStatus {
  available: boolean;
  connected: boolean;
  selectedId?: string;
  selectedName?: string;
  allowLan: boolean;
  backendState?: string;
  error?: string;
  options: Array<{ id: string; name: string; online: boolean; addresses: string[] }>;
}

export interface MenuBarDesktopState {
  snapshot: MenuBarSnapshot | null;
  connected: boolean;
  quietMode: 'normal' | 'quiet';
  launchAtLogin: boolean;
  exitNode?: ExitNodeStatus;
  codexBar: import('../main/codexbar.js').CodexBarUsage;
  lastUpdatedAt?: string;
  error?: string;
}

export interface FleetMenuBarBridge {
  getState(): Promise<MenuBarDesktopState>;
  refresh(): Promise<MenuBarDesktopState>;
  onState(listener: (state: MenuBarDesktopState) => void): () => void;
  openMain(target?: OpenMainTarget): Promise<void>;
  openFullApp(target?: OpenFullAppTarget): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  getQuietMode(): Promise<'normal' | 'quiet'>;
  setQuietMode(mode: 'normal' | 'quiet'): Promise<'normal' | 'quiet'>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  getExitNodeStatus(): Promise<ExitNodeStatus>;
  setExitNode(input: { id: string | null; allowLan?: boolean }): Promise<ExitNodeStatus>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
}

export interface CodexMicroActionEvent {
  action: CodexMicroActionId;
  phase: 'press' | 'release';
  sessionId: string | null;
  deviceId: string | null;
  customShortcut: string | null;
}

export interface CodexMicroDialEvent {
  direction: 'clockwise' | 'counterclockwise' | 'press' | 'release';
  steps: number;
  mode: CodexMicroPreferences['dialMode'];
  sessionId: string | null;
  deviceId: string | null;
}

export interface CodexMicroDecisionEvent {
  sessionId: string;
  approvalId: string;
  accepted: boolean;
}

export interface FleetCodexMicroBridge {
  getState(): Promise<CodexMicroDeviceState>;
  setPreferences(preferences: CodexMicroPreferences): Promise<CodexMicroDeviceState>;
  setActiveSession(sessionId: string | null): Promise<void>;
  retry(): Promise<CodexMicroDeviceState>;
  startVoiceCapture(): Promise<CodexMicroVoiceState>;
  stopVoiceCapture(): Promise<CodexMicroVoiceState>;
  getVoiceState(): Promise<CodexMicroVoiceState>;
  signalFeedback(feedback: CodexMicroFeedback): Promise<void>;
  openInputMonitoring(): Promise<void>;
  openVoicePrivacy(kind: 'microphone' | 'speech-recognition'): Promise<void>;
  onState(listener: (state: CodexMicroDeviceState) => void): () => void;
  onAction(listener: (event: CodexMicroActionEvent) => void): () => void;
  onDial(listener: (event: CodexMicroDialEvent) => void): () => void;
  onDecision(listener: (event: CodexMicroDecisionEvent) => void): () => void;
  onVoiceState(listener: (state: CodexMicroVoiceState) => void): () => void;
}

export interface FleetDesktopBridge {
  platform: NodeJS.Platform;
  request<T>(path: string, options?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }): Promise<T>;
  coreUrl(): Promise<string>;
  clientDeviceName(): Promise<string>;
  connectionState(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  showNotification(input: { id: string; severity: 'info' | 'success' | 'warning' | 'critical' }): Promise<boolean>;
  onEvent(listener: (message: string) => void): () => void;
  onConnection(listener: (online: boolean) => void): () => void;
  onNotificationClick(listener: (id: string) => void): () => void;
  onOpenMainTarget(listener: (target: OpenMainTarget) => void): () => void;
  codexMicro: FleetCodexMicroBridge;
  menuBar: FleetMenuBarBridge;
}

const codexMicro: FleetCodexMicroBridge = {
  getState: () => ipcRenderer.invoke('fleet:codex-micro:get-state') as Promise<CodexMicroDeviceState>,
  setPreferences: (preferences) => ipcRenderer.invoke('fleet:codex-micro:set-preferences', preferences) as Promise<CodexMicroDeviceState>,
  setActiveSession: (sessionId) => ipcRenderer.invoke('fleet:codex-micro:set-active-session', sessionId) as Promise<void>,
  retry: () => ipcRenderer.invoke('fleet:codex-micro:retry') as Promise<CodexMicroDeviceState>,
  startVoiceCapture: () => ipcRenderer.invoke('fleet:codex-micro:start-voice-capture') as Promise<CodexMicroVoiceState>,
  stopVoiceCapture: () => ipcRenderer.invoke('fleet:codex-micro:stop-voice-capture') as Promise<CodexMicroVoiceState>,
  getVoiceState: () => ipcRenderer.invoke('fleet:codex-micro:get-voice-state') as Promise<CodexMicroVoiceState>,
  signalFeedback: (feedback) => ipcRenderer.invoke('fleet:codex-micro:signal-feedback', feedback) as Promise<void>,
  openInputMonitoring: () => ipcRenderer.invoke('fleet:codex-micro:open-input-monitoring') as Promise<void>,
  openVoicePrivacy: (kind) => ipcRenderer.invoke('fleet:codex-micro:open-voice-privacy', kind) as Promise<void>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CodexMicroDeviceState) => listener(value);
    ipcRenderer.on('fleet:codex-micro-state', handler);
    return () => ipcRenderer.removeListener('fleet:codex-micro-state', handler);
  },
  onAction: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CodexMicroActionEvent) => listener(value);
    ipcRenderer.on('fleet:codex-micro-action', handler);
    return () => ipcRenderer.removeListener('fleet:codex-micro-action', handler);
  },
  onDial: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CodexMicroDialEvent) => listener(value);
    ipcRenderer.on('fleet:codex-micro-dial', handler);
    return () => ipcRenderer.removeListener('fleet:codex-micro-dial', handler);
  },
  onDecision: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CodexMicroDecisionEvent) => listener(value);
    ipcRenderer.on('fleet:codex-micro-decision', handler);
    return () => ipcRenderer.removeListener('fleet:codex-micro-decision', handler);
  },
  onVoiceState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CodexMicroVoiceState) => listener(value);
    ipcRenderer.on('fleet:codex-micro-voice-state', handler);
    return () => ipcRenderer.removeListener('fleet:codex-micro-voice-state', handler);
  },
};

const menuBar: FleetMenuBarBridge = {
  getState: () => ipcRenderer.invoke('fleet:menu-bar:get-state') as Promise<MenuBarDesktopState>,
  refresh: () => ipcRenderer.invoke('fleet:menu-bar:refresh') as Promise<MenuBarDesktopState>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: MenuBarDesktopState) => listener(value);
    ipcRenderer.on('fleet:menu-bar-state', handler);
    return () => ipcRenderer.removeListener('fleet:menu-bar-state', handler);
  },
  openMain: (target) => ipcRenderer.invoke('fleet:menu-bar:open-main', target) as Promise<void>,
  openFullApp: (target) => ipcRenderer.invoke('fleet:menu-bar:open-full-app', target) as Promise<void>,
  hide: () => ipcRenderer.invoke('fleet:menu-bar:hide') as Promise<void>,
  quit: () => ipcRenderer.invoke('fleet:menu-bar:quit') as Promise<void>,
  getQuietMode: () => ipcRenderer.invoke('fleet:menu-bar:get-quiet-mode') as Promise<'normal' | 'quiet'>,
  setQuietMode: (mode) => ipcRenderer.invoke('fleet:menu-bar:set-quiet-mode', mode) as Promise<'normal' | 'quiet'>,
  getLaunchAtLogin: () => ipcRenderer.invoke('fleet:menu-bar:get-launch-at-login') as Promise<boolean>,
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('fleet:menu-bar:set-launch-at-login', enabled) as Promise<boolean>,
  getExitNodeStatus: () => ipcRenderer.invoke('fleet:menu-bar:get-exit-node-status') as Promise<ExitNodeStatus>,
  setExitNode: (input) => ipcRenderer.invoke('fleet:menu-bar:set-exit-node', input) as Promise<ExitNodeStatus>,
  readClipboardText: () => ipcRenderer.invoke('fleet:menu-bar:read-clipboard-text') as Promise<string>,
  writeClipboardText: (text) => ipcRenderer.invoke('fleet:menu-bar:write-clipboard-text', text) as Promise<void>
};

const bridge: FleetDesktopBridge = {
  platform: process.platform,
  request: (path, options) => ipcRenderer.invoke('fleet:request', { path, ...options }) as Promise<never>,
  coreUrl: () => ipcRenderer.invoke('fleet:core-url') as Promise<string>,
  clientDeviceName: () => ipcRenderer.invoke('fleet:client-device-name') as Promise<string>,
  connectionState: () => ipcRenderer.invoke('fleet:connection-state') as Promise<boolean>,
  openExternal: (url) => ipcRenderer.invoke('fleet:open-external', url) as Promise<void>,
  showNotification: (input) => ipcRenderer.invoke('fleet:show-notification', input) as Promise<boolean>,
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value);
    ipcRenderer.on('fleet:event', handler);
    return () => ipcRenderer.removeListener('fleet:event', handler);
  },
  onConnection: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: boolean) => listener(value);
    ipcRenderer.on('fleet:connection', handler);
    return () => ipcRenderer.removeListener('fleet:connection', handler);
  },
  onNotificationClick: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value);
    ipcRenderer.on('fleet:notification-click', handler);
    return () => ipcRenderer.removeListener('fleet:notification-click', handler);
  },
  onOpenMainTarget: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: OpenMainTarget) => listener(value);
    ipcRenderer.on('fleet:open-main-target', handler);
    void (ipcRenderer.invoke('fleet:main-target-listener-ready') as Promise<OpenMainTarget | undefined>)
      .then((value) => { if (value) listener(value); })
      .catch(() => undefined);
    return () => ipcRenderer.removeListener('fleet:open-main-target', handler);
  },
  codexMicro,
  menuBar
};

contextBridge.exposeInMainWorld('fleetDesktop', bridge);
