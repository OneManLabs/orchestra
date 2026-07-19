import { CODEX_UI_RPC_METHODS } from '../src/protocol.js';
import { describe, expect, it } from 'vitest';

describe('Codex UI RPC boundary', () => {
  it('covers the primary CLI parity methods', () => {
    expect(CODEX_UI_RPC_METHODS).toEqual(expect.arrayContaining([
      'thread/settings/update', 'thread/compact/start', 'review/start', 'model/list',
      'skills/list', 'hooks/list', 'mcpServerStatus/list', 'app/list', 'plugin/list',
      'account/usage/read', 'config/read', 'fuzzyFileSearch',
    ]));
  });

  it('does not expose app-server host escape hatches', () => {
    expect(CODEX_UI_RPC_METHODS).not.toEqual(expect.arrayContaining([
      'thread/shellCommand', 'command/exec', 'process/spawn', 'fs/writeFile', 'remoteControl/enable',
    ]));
  });
});
