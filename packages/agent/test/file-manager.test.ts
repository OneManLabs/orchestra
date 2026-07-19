import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetFileManager } from '../src/file-manager.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('FleetFileManager', () => {
  it('supports resumable writes, reads, listings, stats, and checksums inside a root', async () => {
    const root = await temporaryDirectory();
    const manager = new FleetFileManager([root], 1024);
    const subdirectory = path.join(root, 'artifacts');
    await manager.mkdir(subdirectory, true);
    const file = path.join(subdirectory, 'result.txt');
    await manager.write(file, 0, Buffer.from('hello').toString('base64'), true);
    await manager.write(file, 5, Buffer.from(' world').toString('base64'));
    const read = await manager.read(file, 0, 1024) as { dataBase64: string; eof: boolean; totalBytes: number };
    expect(Buffer.from(read.dataBase64, 'base64').toString()).toBe('hello world');
    expect(read).toMatchObject({ eof: true, totalBytes: 11 });
    const checksum = await manager.checksum(file) as { checksum: string };
    expect(checksum.checksum).toBe(createHash('sha256').update('hello world').digest('hex'));
    const listing = await manager.list(subdirectory) as { entries: Array<{ name: string }> };
    expect(listing.entries.map((entry) => entry.name)).toEqual(['result.txt']);
    expect(await manager.stat(file)).toMatchObject({ type: 'file', sizeBytes: 11 });
  });

  it('rejects outside paths, symlink escapes, oversized chunks, and project-root removal', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const manager = new FleetFileManager([root], 8);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await expect(manager.read(path.join(outside, 'secret.txt'), 0, 8)).rejects.toThrow(/outside configured project roots/);
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    await expect(manager.read(path.join(root, 'escape.txt'), 0, 8)).rejects.toThrow(/outside configured project roots|symbolic links/);
    await expect(manager.write(path.join(root, 'escape.txt'), 0, Buffer.from('changed').toString('base64'), true)).rejects.toThrow(/outside configured project roots|symbolic links/);
    await expect(manager.remove(path.join(root, 'escape.txt'))).rejects.toThrow(/outside configured project roots|symbolic links/);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect((await lstat(path.join(root, 'escape.txt'))).isSymbolicLink()).toBe(true);
    await expect(manager.write(path.join(root, 'large.bin'), 0, Buffer.alloc(9).toString('base64'))).rejects.toThrow(/exceeds/);
    await expect(manager.remove(root, true)).rejects.toThrow(/project root/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-agent-file-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
