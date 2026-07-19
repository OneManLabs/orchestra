/**
 * Runtime copy of the Codex app-server methods Fleet exposes to its UI.
 *
 * Core is deployed as a standalone compiled bundle, while `@fleet/shared` is
 * consumed as a type-only workspace package. Keeping this runtime allowlist in
 * Core prevents a production deployment from depending on TypeScript source.
 * The parity test in `test/codex-ui-rpc.test.ts` prevents the shared protocol
 * type and this enforcement list from drifting apart.
 */
export const CORE_CODEX_UI_RPC_METHODS = [
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
