import { describe, expect, it, vi } from 'vitest';
import { codexCapabilityLabels, detectCodexReadiness } from '../src/capabilities.js';
import { codexAuthenticationDiagnostic, codexCliDiagnostic } from '../src/diagnostics.js';

describe('Codex capability readiness', () => {
  it('advertises Codex as ready only when the CLI is installed and authenticated', async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args.includes('--version') ? 'codex-cli 1.0.0' : 'Logged in using ChatGPT',
      stderr: '',
      exitCode: 0,
    }));

    const readiness = await detectCodexReadiness('codex-test', runner);

    expect(readiness).toEqual({ installed: true, authenticated: true, reason: 'ready' });
    expect(codexCapabilityLabels(readiness)).toEqual(['codex:installed', 'codex:authenticated', 'codex:ready', 'codex:true']);
    expect(runner).toHaveBeenNthCalledWith(1, 'codex-test', ['--version'], { timeoutMs: 3_000 });
    expect(runner).toHaveBeenNthCalledWith(2, 'codex-test', ['login', 'status'], { timeoutMs: 3_000 });
  });

  it('keeps binary presence visible without advertising unauthenticated Codex as usable', async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args.includes('--version') ? 'codex-cli 1.0.0' : '',
      stderr: args.includes('--version') ? '' : 'Not logged in',
      exitCode: args.includes('--version') ? 0 : 1,
    }));

    const readiness = await detectCodexReadiness('codex-test', runner);

    expect(readiness).toEqual({ installed: true, authenticated: false, reason: 'not-authenticated' });
    expect(codexCapabilityLabels(readiness)).toEqual(['codex:installed']);
    expect(codexCliDiagnostic(readiness)).toMatchObject({ status: 'pass', detail: 'Codex CLI is installed.' });
    expect(codexAuthenticationDiagnostic(readiness)).toMatchObject({
      status: 'warning',
      detail: 'Codex CLI is installed but not authenticated.',
      remediation: 'Run codex login on this device.',
    });
  });

  it('does not run an authentication probe when the CLI is unavailable', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'not found', exitCode: 127 }));

    const readiness = await detectCodexReadiness('missing-codex', runner);

    expect(readiness).toEqual({ installed: false, authenticated: false, reason: 'not-installed' });
    expect(codexCapabilityLabels(readiness)).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the local authentication status probe times out', async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: '',
      stderr: '',
      exitCode: args.includes('--version') ? 0 : null,
    }));

    const readiness = await detectCodexReadiness('codex-test', runner);

    expect(readiness).toEqual({ installed: true, authenticated: false, reason: 'status-timeout' });
    expect(codexAuthenticationDiagnostic(readiness).detail).toBe('Codex CLI authentication status timed out.');
  });
});
