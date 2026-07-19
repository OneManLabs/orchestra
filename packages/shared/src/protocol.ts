import type { CodexEvent, CodexSession, CodexSessionStatus, Device, DeviceMetrics, FleetJob, ProjectPreview, TerminalSession } from './types.js';
import type { DevicePowerAction, RemoteDesktopSession, UpdateChannel } from './v2-types.js';

/**
 * App-server requests exposed to Fleet's Codex UI. Keep this list in sync with
 * the generated protocol from `codex app-server generate-ts --experimental`.
 *
 * Host escape hatches (`fs/*`, `command/*`, `process/*`,
 * `thread/shellCommand`, and remote-control listeners) are intentionally not
 * forwarded. Fleet has its own confined file/terminal transports for those
 * operations.
 */
export const CODEX_UI_RPC_METHODS = [
  'thread/archive', 'thread/delete', 'thread/name/set',
  'thread/goal/set', 'thread/goal/get', 'thread/goal/clear',
  'thread/metadata/update', 'thread/settings/update', 'thread/memoryMode/set', 'memory/reset',
  'thread/compact/start', 'thread/approveGuardianDeniedAction',
  'thread/backgroundTerminals/clean', 'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate',
  'thread/rollback', 'thread/list', 'thread/search', 'thread/loaded/list', 'thread/read',
  'thread/turns/list', 'thread/items/list', 'thread/inject_items',
  'skills/list', 'skills/extraRoots/set', 'skills/config/write', 'hooks/list',
  'marketplace/add', 'marketplace/remove', 'marketplace/upgrade',
  'plugin/list', 'plugin/installed', 'plugin/read', 'plugin/skill/read',
  'plugin/share/save', 'plugin/share/updateTargets', 'plugin/share/list',
  'plugin/share/checkout', 'plugin/share/delete', 'plugin/install', 'plugin/uninstall',
  'app/list', 'turn/steer', 'review/start', 'model/list', 'modelProvider/capabilities/read',
  'experimentalFeature/list', 'permissionProfile/list', 'experimentalFeature/enablement/set',
  'collaborationMode/list', 'environment/add', 'environment/info', 'environment/status',
  'mcpServer/oauth/login', 'config/mcpServer/reload', 'mcpServerStatus/list',
  'mcpServer/resource/read', 'mcpServer/tool/call',
  'windowsSandbox/setupStart', 'windowsSandbox/readiness',
  'account/login/start', 'account/login/cancel', 'account/logout', 'account/read',
  'account/rateLimits/read', 'account/rateLimitResetCredit/consume', 'account/usage/read',
  'account/workspaceMessages/read', 'account/sendAddCreditsNudgeEmail', 'feedback/upload',
  'config/read', 'config/value/write', 'config/batchWrite', 'configRequirements/read',
  'externalAgentConfig/detect', 'externalAgentConfig/import', 'externalAgentConfig/import/readHistories',
  'getConversationSummary', 'fuzzyFileSearch',
] as const;

export type CodexUiRpcMethod = typeof CODEX_UI_RPC_METHODS[number];

export type AgentRegistration = Pick<Device,
  'id' | 'name' | 'hostname' | 'role' | 'platform' | 'arch' | 'osName' | 'osVersion' | 'agentVersion' | 'capabilities' | 'projectRoots'
>;

export type AgentToCoreMessage =
  | { type: 'agent.register'; requestId?: string; payload: AgentRegistration & { metrics: DeviceMetrics } }
  | { type: 'agent.metrics'; payload: { deviceId: string; metrics: DeviceMetrics } }
  | { type: 'agent.response'; requestId: string; payload?: unknown; error?: string }
  | { type: 'terminal.data'; payload: { terminalId: string; data: string } }
  | { type: 'terminal.exit'; payload: { terminalId: string; exitCode?: number; signal?: number } }
  | { type: 'codex.event'; payload: { sessionId: string; message: Record<string, unknown> } }
  | { type: 'codex.exit'; payload: { sessionId: string; exitCode?: number; error?: string } }
  | { type: 'preview.updated'; payload: { projectId: string; preview: ProjectPreview } }
  | { type: 'job.output'; payload: { jobId: string; stream: 'stdout' | 'stderr' | 'codex'; text: string; raw?: unknown } }
  | { type: 'job.status'; payload: { jobId: string; status: FleetJob['status']; exitCode?: number; error?: string } }
  | { type: 'transfer.progress'; payload: { transferId: string; transferredBytes: number; totalBytes: number; checksumSha256?: string } }
  | { type: 'desktop.event'; payload: { sessionId: string; status: RemoteDesktopSession['status']; connectionUrl?: string; error?: string } };

export type CoreToAgentCommand =
  | { type: 'terminal.start'; requestId: string; payload: { terminal: TerminalSession; env?: Record<string, string> } }
  | { type: 'terminal.input'; requestId: string; payload: { terminalId: string; data: string } }
  | { type: 'terminal.resize'; requestId: string; payload: { terminalId: string; cols: number; rows: number } }
  | { type: 'terminal.stop'; requestId: string; payload: { terminalId: string } }
  | { type: 'codex.start'; requestId: string; payload: { session: CodexSession } }
  | { type: 'codex.resume'; requestId: string; payload: { session: CodexSession; threadId: string } }
  | { type: 'codex.fork'; requestId: string; payload: { session: CodexSession; threadId: string; lastTurnId?: string } }
  | { type: 'codex.send'; requestId: string; payload: { sessionId: string; text: string } }
  | { type: 'codex.rpc'; requestId: string; payload: { sessionId: string; method: CodexUiRpcMethod; params?: unknown } }
  | { type: 'codex.respond'; requestId: string; payload: { sessionId: string; codexRequestId: string | number; result: unknown } }
  | { type: 'codex.interrupt'; requestId: string; payload: { sessionId: string; threadId: string; turnId: string } }
  | { type: 'codex.stop'; requestId: string; payload: { sessionId: string } }
  | { type: 'codex.handoff.prepare'; requestId: string; payload: { sessionId: string } }
  | { type: 'codex.handoff.read'; requestId: string; payload: { handoffId: string; offset: number; length: number } }
  | { type: 'codex.handoff.begin'; requestId: string; payload: { handoffId: string; sizeBytes: number; checksumSha256: string } }
  | { type: 'codex.handoff.write'; requestId: string; payload: { handoffId: string; offset: number; dataBase64: string } }
  | { type: 'codex.handoff.finish'; requestId: string; payload: { handoffId: string; session: CodexSession; sourceThreadId: string; mode: 'resume' | 'fork'; lastTurnId?: string } }
  | { type: 'codex.handoff.discard'; requestId: string; payload: { handoffId: string } }
  | { type: 'preview.start'; requestId: string; payload: {
    projectId: string;
    projectName: string;
    cwd: string;
    configuredCommand?: string;
    port?: number;
    servePort: number;
    visibility: ProjectPreview['visibility'];
    autoStartWithCodex: boolean;
    stopAfterMinutes?: number;
  } }
  | { type: 'preview.stop'; requestId: string; payload: { projectId: string } }
  | { type: 'job.start'; requestId: string; payload: { job: FleetJob; environment?: Record<string, string> } }
  | { type: 'job.cancel'; requestId: string; payload: { jobId: string } }
  | { type: 'device.power'; requestId: string; payload: { action: DevicePowerAction; macAddress?: string; broadcastAddress?: string; force?: boolean } }
  | { type: 'file.list'; requestId: string; payload: { path: string; cursor?: string; limit?: number } }
  | { type: 'file.stat'; requestId: string; payload: { path: string } }
  | { type: 'file.read'; requestId: string; payload: { path: string; offset: number; length: number } }
  | { type: 'file.write'; requestId: string; payload: { path: string; offset: number; dataBase64: string; truncate?: boolean } }
  | { type: 'file.mkdir'; requestId: string; payload: { path: string; recursive?: boolean } }
  | { type: 'file.remove'; requestId: string; payload: { path: string; recursive?: boolean } }
  | { type: 'file.checksum'; requestId: string; payload: { path: string; algorithm: 'sha256' } }
  | { type: 'diagnostics.run'; requestId: string; payload: { kind: 'agent' | 'network' | 'storage' | 'compatibility'; redact: boolean } }
  | { type: 'update.prepare'; requestId: string; payload: { version: string; url: string; checksumSha256: string; signature?: string; channel: UpdateChannel } }
  | { type: 'update.apply'; requestId: string; payload: { version: string; restart: boolean } }
  | { type: 'update.rollback'; requestId: string; payload: { version: string } }
  | { type: 'desktop.start'; requestId: string; payload: { session: RemoteDesktopSession; config: Record<string, unknown> } }
  | { type: 'desktop.stop'; requestId: string; payload: { sessionId: string } }
  | { type: 'agent.ping'; requestId: string; payload: { at: string } };

/** Compact live update used while Codex is streaming text. */
export interface CodexSessionEventUpdate {
  sessionId: string;
  event: CodexEvent;
  status: CodexSessionStatus;
  updatedAt: string;
  turnId?: string;
  error?: string;
}

export type ClientEvent =
  | { type: 'snapshot'; payload: unknown }
  | { type: 'device.updated'; payload: unknown }
  | { type: 'job.updated'; payload: unknown }
  | { type: 'session.updated'; payload: unknown }
  | { type: 'session.event.updated'; payload: CodexSessionEventUpdate }
  | { type: 'project.updated'; payload: unknown }
  | { type: 'terminal.updated'; payload: unknown }
  | { type: 'terminal.data'; payload: { terminalId: string; data: string } }
  | { type: 'system.updated'; payload: unknown }
  | { type: 'activity.created'; payload: unknown }
  | { type: 'v2.updated'; payload: unknown }
  | { type: 'alert.created'; payload: unknown }
  | { type: 'pipeline.updated'; payload: unknown }
  | { type: 'transfer.updated'; payload: unknown };
