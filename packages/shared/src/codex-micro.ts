import type { CodexSessionStatus } from './types.js';

export const CODEX_MICRO_AGENT_SLOTS = 6 as const;

export type CodexMicroSourceMode = 'recent' | 'priority' | 'pinned' | 'custom';
export type CodexMicroDialMode = 'composer-navigation' | 'model-reasoning';
export type CodexMicroDirection = 'up' | 'right' | 'down' | 'left';
export type CodexMicroVoiceStateName = 'idle' | 'requesting-permission' | 'listening' | 'transcribing' | 'error';
export type CodexMicroFeedback = 'pending' | 'success' | 'error';

export interface CodexMicroVoiceState {
  state: CodexMicroVoiceStateName;
  sessionId: string | null;
  transcript?: string;
  error?: string;
  code?: 'permission-denied' | 'unavailable' | 'capture-failed' | 'transcription-failed';
}

export type CodexMicroActionId =
  | 'toggle-fast-mode' | 'approve' | 'reject' | 'fork-chat' | 'push-to-talk' | 'send-message'
  | 'open-feedback' | 'open-openai-docs' | 'toggle-terminal' | 'copy-chat-markdown'
  | 'archive-chat' | 'new-chat' | 'open-browser' | 'toggle-pin' | 'toggle-review'
  | 'run-primary-action' | 'git-commit-push' | 'create-pull-request' | 'add-photos'
  | 'open-settings' | 'open-side-chat' | 'open-scheduled' | 'increase-reasoning'
  | 'decrease-reasoning' | 'open-folder' | 'add-files' | 'open-plugins'
  | 'insert-yolo' | 'insert-yeet' | 'custom-shortcut' | 'toggle-plan-mode'
  | 'navigate-forward' | 'toggle-sidebar' | 'navigate-back';

export type CodexMicroKeycapId =
  | 'FAST' | 'APPR' | 'REJ' | 'SPLIT' | 'MIC' | 'CODEX' | 'BUG' | 'OAI' | 'TERM'
  | 'DWN' | 'DEL' | 'NEW' | 'NAV' | 'MAGIC' | 'DIFF' | 'PLAY' | 'GIT' | 'BRCH'
  | 'MRG' | 'PR' | 'PAINT' | 'LAB' | 'PARTY' | 'TIME' | 'MIND+' | 'MIND-'
  | 'EMPT1' | 'EMPT2' | 'EMPT3' | 'EMPT4' | 'SETUP' | 'FOLD' | 'UPL' | 'APPS'
  | 'YOLO' | 'YEET' | 'EMPT5';

export interface CodexMicroKeycapDefinition {
  id: CodexMicroKeycapId;
  label: string;
  size: 'single' | 'double';
  defaultAction: CodexMicroActionId;
}

export interface CodexMicroCommandSlot {
  keycapId: CodexMicroKeycapId;
  actionId: CodexMicroActionId;
  customShortcut?: string;
}

export interface CodexMicroPreferences {
  enabled: boolean;
  sourceMode: CodexMicroSourceMode;
  brightness: number;
  inactivityTimeoutMs: number | null;
  agentAssignments: Array<string | null>;
  pinnedSessionIds: string[];
  commandSlots: Record<'ACT06' | 'ACT07' | 'ACT08' | 'ACT09' | 'ACT10_ACT11' | 'ACT12', CodexMicroCommandSlot>;
  joystick: Record<CodexMicroDirection, CodexMicroActionId>;
  dialMode: CodexMicroDialMode;
}

export type CodexMicroConnectionStatus = 'unsupported' | 'kit-unavailable' | 'not-detected' | 'detected' | 'connected' | 'error';
export type CodexMicroLightStatus = 'off' | 'idle' | 'working' | 'unread' | 'awaiting-approval' | 'error';

export interface CodexMicroAgentSlotState {
  slot: number;
  sessionId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  title: string | null;
  sessionStatus: CodexSessionStatus | null;
  lightStatus: CodexMicroLightStatus;
  selected: boolean;
  pendingApprovalCount: number;
}

export interface CodexMicroDeviceState {
  status: CodexMicroConnectionStatus;
  name: string;
  error: string | null;
  inputMonitoringRequired: boolean;
  batteryPercent: number | null;
  isCharging: boolean | null;
  firmwareVersion: string | null;
  selectedSlot: number | null;
  activeSessionId: string | null;
  voice: CodexMicroVoiceState;
  slots: CodexMicroAgentSlotState[];
  preferences: CodexMicroPreferences;
}

export const CODEX_MICRO_KEYCAPS: readonly CodexMicroKeycapDefinition[] = [
  { id: 'FAST', label: 'Fast mode', size: 'single', defaultAction: 'toggle-fast-mode' },
  { id: 'APPR', label: 'Approve', size: 'single', defaultAction: 'approve' },
  { id: 'REJ', label: 'Reject', size: 'single', defaultAction: 'reject' },
  { id: 'SPLIT', label: 'Continue in new chat', size: 'single', defaultAction: 'fork-chat' },
  { id: 'MIC', label: 'Push to talk', size: 'double', defaultAction: 'push-to-talk' },
  { id: 'CODEX', label: 'Send message', size: 'single', defaultAction: 'send-message' },
  { id: 'BUG', label: 'Feedback', size: 'single', defaultAction: 'open-feedback' },
  { id: 'OAI', label: 'OpenAI docs', size: 'single', defaultAction: 'open-openai-docs' },
  { id: 'TERM', label: 'Terminal', size: 'single', defaultAction: 'toggle-terminal' },
  { id: 'DWN', label: 'Copy as Markdown', size: 'single', defaultAction: 'copy-chat-markdown' },
  { id: 'DEL', label: 'Archive chat', size: 'single', defaultAction: 'archive-chat' },
  { id: 'NEW', label: 'New chat', size: 'single', defaultAction: 'new-chat' },
  { id: 'NAV', label: 'Browser', size: 'single', defaultAction: 'open-browser' },
  { id: 'MAGIC', label: 'Pin chat', size: 'single', defaultAction: 'toggle-pin' },
  { id: 'DIFF', label: 'Review diff', size: 'single', defaultAction: 'toggle-review' },
  { id: 'PLAY', label: 'Run primary action', size: 'single', defaultAction: 'run-primary-action' },
  { id: 'GIT', label: 'Commit or push', size: 'single', defaultAction: 'git-commit-push' },
  { id: 'BRCH', label: 'Review branch', size: 'single', defaultAction: 'toggle-review' },
  { id: 'MRG', label: 'Review merge', size: 'single', defaultAction: 'toggle-review' },
  { id: 'PR', label: 'Create pull request', size: 'single', defaultAction: 'create-pull-request' },
  { id: 'PAINT', label: 'Add photos', size: 'single', defaultAction: 'add-photos' },
  { id: 'LAB', label: 'Settings lab', size: 'single', defaultAction: 'open-settings' },
  { id: 'PARTY', label: 'Side chat', size: 'single', defaultAction: 'open-side-chat' },
  { id: 'TIME', label: 'Scheduled tasks', size: 'single', defaultAction: 'open-scheduled' },
  { id: 'MIND+', label: 'Reasoning up', size: 'single', defaultAction: 'increase-reasoning' },
  { id: 'MIND-', label: 'Reasoning down', size: 'single', defaultAction: 'decrease-reasoning' },
  { id: 'EMPT1', label: 'Custom 1', size: 'single', defaultAction: 'custom-shortcut' },
  { id: 'EMPT2', label: 'Custom 2', size: 'single', defaultAction: 'custom-shortcut' },
  { id: 'EMPT3', label: 'Custom 3', size: 'single', defaultAction: 'custom-shortcut' },
  { id: 'EMPT4', label: 'Custom 4', size: 'single', defaultAction: 'custom-shortcut' },
  { id: 'SETUP', label: 'Settings', size: 'single', defaultAction: 'open-settings' },
  { id: 'FOLD', label: 'Open folder', size: 'single', defaultAction: 'open-folder' },
  { id: 'UPL', label: 'Attach files', size: 'single', defaultAction: 'add-files' },
  { id: 'APPS', label: 'Plugins', size: 'single', defaultAction: 'open-plugins' },
  { id: 'YOLO', label: ':yolo:', size: 'single', defaultAction: 'insert-yolo' },
  { id: 'YEET', label: ':yeet:', size: 'single', defaultAction: 'insert-yeet' },
  { id: 'EMPT5', label: 'Custom wide', size: 'double', defaultAction: 'custom-shortcut' },
] as const;

export function defaultCodexMicroPreferences(): CodexMicroPreferences {
  return {
    enabled: true,
    sourceMode: 'priority',
    brightness: 1,
    inactivityTimeoutMs: 30 * 60_000,
    agentAssignments: Array.from({ length: CODEX_MICRO_AGENT_SLOTS }, () => null),
    pinnedSessionIds: [],
    commandSlots: {
      ACT06: { keycapId: 'FAST', actionId: 'toggle-fast-mode' },
      ACT07: { keycapId: 'APPR', actionId: 'approve' },
      ACT08: { keycapId: 'REJ', actionId: 'reject' },
      ACT09: { keycapId: 'SPLIT', actionId: 'fork-chat' },
      ACT10_ACT11: { keycapId: 'MIC', actionId: 'push-to-talk' },
      ACT12: { keycapId: 'CODEX', actionId: 'send-message' },
    },
    joystick: {
      up: 'toggle-plan-mode',
      right: 'navigate-forward',
      down: 'toggle-sidebar',
      left: 'navigate-back',
    },
    dialMode: 'model-reasoning',
  };
}
