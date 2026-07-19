import { lstat, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPathInside, resolveAllowedDirectory, resolveAllowedPath } from '../src/security.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('project-root confinement', () => {
  it('allows the root and descendants', () => {
    const root = path.resolve('/projects/fleet');
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(path.join(root, 'packages', 'agent'), root)).toBe(true);
  });

  it('does not confuse sibling path prefixes with descendants', () => {
    expect(isPathInside(path.resolve('/projects/fleet-secret'), path.resolve('/projects/fleet'))).toBe(false);
  });

  it('creates a missing child working directory beneath an existing resolved root', async () => {
    const root = await temporaryDirectory('fleet-root-');
    const requested = path.join(root, 'workspaces', 'new-project');

    const resolved = await resolveAllowedDirectory(requested, [root]);

    expect(resolved).toBe(await realpath(requested));
    expect((await stat(resolved)).isDirectory()).toBe(true);
  });

  it('rejects creation outside configured roots', async () => {
    const root = await temporaryDirectory('fleet-root-');
    const outside = await temporaryDirectory('fleet-outside-');

    await expect(resolveAllowedDirectory(path.join(outside, 'new-project'), [root])).rejects.toThrow('outside configured project roots');
  });

  it('does not recreate a missing or unmounted configured root', async () => {
    const parent = await temporaryDirectory('fleet-mount-parent-');
    const missingRoot = path.join(parent, 'offline-volume', 'projects');

    // The unavailable root remains authoritative even if a broader configured
    // parent exists; Fleet must not recreate a vanished mount through it.
    await expect(resolveAllowedDirectory(path.join(missingRoot, 'new-project'), [parent, missingRoot])).rejects.toThrow('unavailable or unmounted');
    await expect(lstat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('turns a missing-path ENOENT into a clear confinement error', async () => {
    const root = await temporaryDirectory('fleet-root-');

    await expect(resolveAllowedPath(path.join(root, 'missing.txt'), [root], true)).rejects.toThrow('Path does not exist inside a configured project root');
  });

  it('refuses to create a working directory through a symlink', async () => {
    const root = await temporaryDirectory('fleet-root-');
    const outside = await temporaryDirectory('fleet-outside-');
    const linked = path.join(root, 'linked');
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveAllowedDirectory(path.join(linked, 'escaped'), [root])).rejects.toThrow('symbolic links');
    await expect(lstat(path.join(outside, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
