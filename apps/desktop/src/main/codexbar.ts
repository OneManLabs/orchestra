import { isAbsolute, join } from 'node:path';

export interface CodexBarUsageWindow {
  usedPercent: number;
  resetsAt?: string;
}

export interface CodexBarUsage {
  available: boolean;
  version?: string;
  source?: string;
  updatedAt?: string;
  primary?: CodexBarUsageWindow;
  secondary?: CodexBarUsageWindow;
  creditsRemaining?: number;
  error?: string;
}

export function codexBarCliCandidates(home: string, configured?: string): string[] {
  return [
    configured,
    '/opt/homebrew/bin/codexbar',
    '/usr/local/bin/codexbar',
    '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI',
    join(home, 'Applications', 'CodexBar.app', 'Contents', 'Helpers', 'CodexBarCLI')
  ].filter((value): value is string => typeof value === 'string' && isAbsolute(value));
}

export function parseCodexBarUsage(stdout: string): CodexBarUsage {
  if (Buffer.byteLength(stdout, 'utf8') > 2 * 1024 * 1024) throw new Error('CodexBar response exceeded the safety limit');
  const decoded = JSON.parse(stdout) as unknown;
  const value = Array.isArray(decoded) ? decoded.find((entry) => record(entry)?.provider === 'codex') : decoded;
  const root = record(value);
  if (!root || root.provider !== 'codex') throw new Error('CodexBar returned no Codex usage');
  const usage = record(root.usage);
  if (!usage) throw new Error('CodexBar returned an invalid Codex usage payload');
  return {
    available: true,
    ...(text(root.version) ? { version: text(root.version) } : {}),
    ...(text(root.source) ? { source: text(root.source) } : {}),
    ...(text(usage.updatedAt) ? { updatedAt: text(usage.updatedAt) } : {}),
    ...(usageWindow(usage.primary) ? { primary: usageWindow(usage.primary) } : {}),
    ...(usageWindow(usage.secondary) ? { secondary: usageWindow(usage.secondary) } : {}),
    ...(finite(record(root.credits)?.remaining) !== undefined ? { creditsRemaining: finite(record(root.credits)?.remaining) } : {})
  };
}

function usageWindow(value: unknown): CodexBarUsageWindow | undefined {
  const source = record(value);
  const usedPercent = finite(source?.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetsAt = text(source?.resetsAt);
  return { usedPercent: Math.min(100, Math.max(0, usedPercent)), ...(resetsAt ? { resetsAt } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
