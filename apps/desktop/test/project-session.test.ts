import { describe, expect, it } from 'vitest';
import { projectForCodexSession, projectPathContainsSessionCwd } from '../src/renderer/lib/project-session.js';

const projects = [
  { id: 'fleet', paths: [{ deviceId: 'mac', path: '/Users/example/fleet' }] },
  { id: 'desktop', paths: [{ deviceId: 'mac', path: '/Users/example/fleet/apps/desktop' }] },
  { id: 'windows', paths: [{ deviceId: 'pc', path: 'D:\\Projects\\Fleet' }] },
];

describe('Codex project matching', () => {
  it('uses the explicit project ID when present', () => {
    expect(projectForCodexSession(
      { projectId: 'fleet', deviceId: 'mac', cwd: '/Users/example/fleet/apps/desktop' },
      projects,
    )?.id).toBe('fleet');
  });

  it('falls back to the longest matching device path', () => {
    expect(projectForCodexSession(
      { deviceId: 'mac', cwd: '/Users/EXAMPLE/fleet/apps/desktop/src' },
      projects,
    )?.id).toBe('desktop');
    expect(projectForCodexSession(
      { deviceId: 'pc', cwd: 'D:\\Projects\\Fleet\\apps\\desktop' },
      projects,
    )?.id).toBe('windows');
  });

  it('does not confuse sibling path prefixes', () => {
    expect(projectPathContainsSessionCwd('/Users/example/fleet', '/Users/example/fleet-copy')).toBe(false);
  });
});
