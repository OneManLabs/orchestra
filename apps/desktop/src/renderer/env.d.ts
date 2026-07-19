/// <reference types="vite/client" />

interface FleetOpenMainTarget {
  page?: string;
  deviceId?: string;
  tab?: string;
  entityId?: string;
  sessionId?: string;
  navigationTarget?: { sessionId: string; sequence: number };
}

interface FleetOpenFullAppTarget extends FleetOpenMainTarget {
  jobId?: string;
  alertId?: string;
}

interface FleetExitNodeStatus {
  available: boolean;
  connected: boolean;
  selectedId?: string;
  selectedName?: string;
  allowLan: boolean;
  backendState?: string;
  error?: string;
  options: Array<{ id: string; name: string; online: boolean; addresses: string[] }>;
}

interface FleetMenuBarDesktopState {
  snapshot: import('@fleet/shared').MenuBarSnapshot | null;
  connected: boolean;
  quietMode: 'normal' | 'quiet';
  launchAtLogin: boolean;
  exitNode?: FleetExitNodeStatus;
  lastUpdatedAt?: string;
  error?: string;
}

interface FleetMenuBarBridge {
  getState(): Promise<FleetMenuBarDesktopState>;
  refresh(): Promise<FleetMenuBarDesktopState>;
  onState(listener: (state: FleetMenuBarDesktopState) => void): () => void;
  openMain(target?: FleetOpenMainTarget): Promise<void>;
  openFullApp(target?: FleetOpenFullAppTarget): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  getQuietMode(): Promise<'normal' | 'quiet'>;
  setQuietMode(mode: 'normal' | 'quiet'): Promise<'normal' | 'quiet'>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  getExitNodeStatus(): Promise<FleetExitNodeStatus>;
  setExitNode(input: { id: string | null; allowLan?: boolean }): Promise<FleetExitNodeStatus>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
}

interface FleetDesktopBridge {
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
  onOpenMainTarget(listener: (target: FleetOpenMainTarget) => void): () => void;
  codexMicro: {
    getState(): Promise<import('@fleet/shared').CodexMicroDeviceState>;
    setPreferences(preferences: import('@fleet/shared').CodexMicroPreferences): Promise<import('@fleet/shared').CodexMicroDeviceState>;
    setActiveSession(sessionId: string | null): Promise<void>;
    retry(): Promise<import('@fleet/shared').CodexMicroDeviceState>;
    startVoiceCapture(): Promise<import('@fleet/shared').CodexMicroVoiceState>;
    stopVoiceCapture(): Promise<import('@fleet/shared').CodexMicroVoiceState>;
    getVoiceState(): Promise<import('@fleet/shared').CodexMicroVoiceState>;
    signalFeedback(feedback: import('@fleet/shared').CodexMicroFeedback): Promise<void>;
    openInputMonitoring(): Promise<void>;
    openVoicePrivacy(kind: 'microphone' | 'speech-recognition'): Promise<void>;
    onState(listener: (state: import('@fleet/shared').CodexMicroDeviceState) => void): () => void;
    onAction(listener: (event: { action: import('@fleet/shared').CodexMicroActionId; phase: 'press' | 'release'; sessionId: string | null; deviceId: string | null; customShortcut: string | null }) => void): () => void;
    onDial(listener: (event: { direction: 'clockwise' | 'counterclockwise' | 'press' | 'release'; steps: number; mode: import('@fleet/shared').CodexMicroDialMode; sessionId: string | null; deviceId: string | null }) => void): () => void;
    onDecision(listener: (event: { sessionId: string; approvalId: string; accepted: boolean }) => void): () => void;
    onVoiceState(listener: (state: import('@fleet/shared').CodexMicroVoiceState) => void): () => void;
  };
  menuBar: FleetMenuBarBridge;
}

interface Window { fleetDesktop?: FleetDesktopBridge }
