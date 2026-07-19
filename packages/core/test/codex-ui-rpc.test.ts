import { CODEX_UI_RPC_METHODS } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { CORE_CODEX_UI_RPC_METHODS } from '../src/codex-ui-rpc.js';

describe('standalone Core Codex RPC allowlist', () => {
  it('stays identical to the shared UI protocol contract', () => {
    expect(CORE_CODEX_UI_RPC_METHODS).toEqual(CODEX_UI_RPC_METHODS);
  });
});
