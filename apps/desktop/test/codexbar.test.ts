import { describe, expect, it } from 'vitest';
import { codexBarCliCandidates, parseCodexBarUsage } from '../src/main/codexbar.js';

describe('CodexBar integration', () => {
  it('accepts the documented JSON payload without retaining account identity', () => {
    expect(parseCodexBarUsage(JSON.stringify({
      provider: 'codex', version: '1.2.3', source: 'oauth',
      usage: {
        primary: { usedPercent: 28, resetsAt: '2026-07-20T00:00:00Z' },
        secondary: { usedPercent: 59 }, updatedAt: '2026-07-19T23:00:00Z',
        accountEmail: 'private@example.com'
      },
      credits: { remaining: 12.5 }
    }))).toEqual({
      available: true, version: '1.2.3', source: 'oauth', updatedAt: '2026-07-19T23:00:00Z',
      primary: { usedPercent: 28, resetsAt: '2026-07-20T00:00:00Z' },
      secondary: { usedPercent: 59 }, creditsRemaining: 12.5
    });
  });

  it('supports multi-provider arrays and clamps malformed percentages', () => {
    expect(parseCodexBarUsage(JSON.stringify([
      { provider: 'claude', usage: { primary: { usedPercent: 10 } } },
      { provider: 'codex', usage: { primary: { usedPercent: 130 } } }
    ])).primary?.usedPercent).toBe(100);
  });

  it('uses only fixed absolute executable candidates', () => {
    expect(codexBarCliCandidates('/var/empty/demo', 'relative/codexbar')).not.toContain('relative/codexbar');
    expect(codexBarCliCandidates('/var/empty/demo', '/custom/codexbar')).toContain('/custom/codexbar');
  });
});
