import { createHash } from 'node:crypto';
import { constants as fileConstants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, resolveAllowedPath, resolvedRoots } from './security.js';

export class FleetFileManager {
  constructor(private readonly roots: string[], private readonly maxChunkBytes: number) {}

  async list(inputPath: string, cursor?: string, requestedLimit?: number): Promise<unknown> {
    const target = await resolveAllowedPath(inputPath, this.roots, true);
    if (!(await stat(target)).isDirectory()) throw new Error(`Path is not a directory: ${inputPath}`);
    const offset = parseCursor(cursor);
    const limit = Math.min(500, Math.max(1, Math.floor(requestedLimit ?? 100)));
    const names = (await readdir(target)).sort((a, b) => a.localeCompare(b));
    const selected = names.slice(offset, offset + limit);
    const entries = await Promise.all(selected.map(async (name) => {
      const entryPath = path.join(target, name);
      const info = await lstat(entryPath);
      return {
        name,
        path: entryPath,
        type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        mode: info.mode,
      };
    }));
    const nextOffset = offset + entries.length;
    return { path: target, entries, nextCursor: nextOffset < names.length ? String(nextOffset) : undefined, total: names.length };
  }

  async stat(inputPath: string): Promise<unknown> {
    const target = await resolveAllowedPath(inputPath, this.roots, true);
    const info = await lstat(target);
    return {
      path: target,
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      sizeBytes: info.size,
      mode: info.mode,
      createdAt: info.birthtime.toISOString(),
      modifiedAt: info.mtime.toISOString(),
      accessedAt: info.atime.toISOString(),
      readable: true,
      writable: await canOpenForWrite(target, info.isDirectory()),
    };
  }

  async read(inputPath: string, offset: number, length: number): Promise<unknown> {
    assertOffset(offset);
    if (!Number.isInteger(length) || length < 1 || length > this.maxChunkBytes) {
      throw new Error(`Read length must be between 1 and ${this.maxChunkBytes} bytes.`);
    }
    const target = await resolveAllowedPath(inputPath, this.roots, true);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Path is not a file: ${inputPath}`);
    const size = Math.min(length, Math.max(0, info.size - offset));
    const buffer = Buffer.alloc(size);
    const handle = await open(target, 'r');
    try {
      const { bytesRead } = size ? await handle.read(buffer, 0, size, offset) : { bytesRead: 0 };
      return {
        path: target,
        offset,
        dataBase64: buffer.subarray(0, bytesRead).toString('base64'),
        bytesRead,
        nextOffset: offset + bytesRead,
        totalBytes: info.size,
        eof: offset + bytesRead >= info.size,
      };
    } finally {
      await handle.close();
    }
  }

  async write(inputPath: string, offset: number, dataBase64: string, truncate = false): Promise<unknown> {
    assertOffset(offset);
    if (truncate && offset !== 0) throw new Error('A truncating write must start at offset 0.');
    const data = decodeBase64(dataBase64);
    if (data.length > this.maxChunkBytes) throw new Error(`Write chunk exceeds ${this.maxChunkBytes} bytes.`);
    const target = await resolveAllowedPath(inputPath, this.roots, false);
    await assertNoSymlinkComponents(target, this.roots);
    const noFollow = typeof fileConstants.O_NOFOLLOW === 'number' ? fileConstants.O_NOFOLLOW : 0;
    const handle = await open(target, fileConstants.O_RDWR | fileConstants.O_CREAT | noFollow, 0o600);
    try {
      if (truncate) await handle.truncate(0);
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written, offset + written);
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const resolved = await realpath(target);
    const roots = await resolvedRoots(this.roots);
    if (!roots.some((root) => isPathInside(resolved, root))) throw new Error('Written file escaped configured project roots.');
    const info = await stat(resolved);
    return { path: resolved, offset, bytesWritten: data.length, nextOffset: offset + data.length, totalBytes: info.size };
  }

  async mkdir(inputPath: string, recursive = false): Promise<unknown> {
    const target = await resolveAllowedPath(inputPath, this.roots, false);
    await assertNoSymlinkComponents(target, this.roots);
    await mkdir(target, { recursive, mode: 0o755 });
    const resolved = await resolveAllowedPath(target, this.roots, true);
    return { path: resolved, created: true };
  }

  async remove(inputPath: string, recursive = false): Promise<unknown> {
    const mutationTarget = await resolveAllowedPath(inputPath, this.roots, false);
    await assertNoSymlinkComponents(mutationTarget, this.roots);
    const target = await resolveAllowedPath(mutationTarget, this.roots, true);
    const roots = await resolvedRoots(this.roots);
    if (roots.some((root) => pathEquals(target, root))) throw new Error('Removing a configured project root is not allowed.');
    const info = await lstat(target);
    if (info.isDirectory() && !recursive) throw new Error('Directory removal requires recursive=true.');
    await rm(target, { recursive, force: false, maxRetries: 2 });
    return { path: target, removed: true };
  }

  async checksum(inputPath: string): Promise<unknown> {
    const target = await resolveAllowedPath(inputPath, this.roots, true);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Path is not a file: ${inputPath}`);
    const digest = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(target);
      stream.on('data', (chunk) => digest.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    return { path: target, algorithm: 'sha256', checksum: digest.digest('hex'), sizeBytes: info.size };
  }
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error('Invalid file-list cursor.');
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new Error('Invalid file-list cursor.');
  return value;
}

function assertOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('File offset must be a non-negative safe integer.');
}

function decodeBase64(value: string): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('File data must be canonical base64.');
  }
  return Buffer.from(value, 'base64');
}

async function canOpenForWrite(target: string, directory: boolean): Promise<boolean> {
  try {
    const { access, constants } = await import('node:fs');
    await new Promise<void>((resolve, reject) => access(directory ? target : path.dirname(target), constants.W_OK, (error) => error ? reject(error) : resolve()));
    return true;
  } catch {
    return false;
  }
}

function pathEquals(left: string, right: string): boolean {
  return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}

async function assertNoSymlinkComponents(target: string, configuredRoots: string[]): Promise<void> {
  const absoluteTarget = path.resolve(target);
  const realRoots = await resolvedRoots(configuredRoots);
  let base: string | undefined;
  let relative: string | undefined;
  for (let index = 0; index < configuredRoots.length; index += 1) {
    const configuredRoot = path.resolve(configuredRoots[index]!);
    const realRoot = realRoots[index]!;
    if (isPathInside(absoluteTarget, configuredRoot)) {
      base = realRoot;
      relative = path.relative(configuredRoot, absoluteTarget);
      break;
    }
    if (isPathInside(absoluteTarget, realRoot)) {
      base = realRoot;
      relative = path.relative(realRoot, absoluteTarget);
      break;
    }
  }
  if (base === undefined || relative === undefined) throw new Error(`Mutation path is outside configured project roots: ${target}`);
  let current = base;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Mutation through symbolic links is not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}
