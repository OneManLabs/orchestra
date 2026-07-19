import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizePortableBundlePermissions } from '../install/bundle-permissions.mjs';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('portable bundle permissions', () => {
  it('restores native and script execution while removing unsafe write modes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-bundle-modes-'));
    try {
      const helper = path.join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
      const script = path.join(root, 'bin', 'tool');
      const data = path.join(root, 'package.json');
      await mkdir(path.dirname(helper), { recursive: true, mode: 0o777 });
      await mkdir(path.dirname(script), { recursive: true, mode: 0o777 });
      await writeFile(helper, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]), { mode: 0o644 });
      await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      await writeFile(data, '{}\n', { mode: 0o666 });
      await chmod(path.dirname(helper), 0o777);

      await normalizePortableBundlePermissions(root, 'darwin');

      expect((await stat(helper)).mode & 0o777).toBe(0o755);
      expect((await stat(script)).mode & 0o777).toBe(0o755);
      expect((await stat(data)).mode & 0o777).toBe(0o644);
      expect((await stat(path.dirname(helper))).mode & 0o777).toBe(0o755);
      expect(await readFile(helper)).toEqual(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves internal package links and rejects links outside the bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-bundle-links-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fleet-bundle-outside-'));
    try {
      await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
      await writeFile(path.join(root, 'tool.js'), '#!/usr/bin/env node\n', { mode: 0o644 });
      await writeFile(path.join(outside, 'escape'), '#!/bin/sh\n', { mode: 0o755 });
      await symlink('../../tool.js', path.join(root, 'node_modules', '.bin', 'tool'));
      await normalizePortableBundlePermissions(root, 'darwin');
      await symlink(path.join(outside, 'escape'), path.join(root, 'escape'));
      await expect(normalizePortableBundlePermissions(root, 'darwin')).rejects.toThrow(/symlink outside the bundle/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
