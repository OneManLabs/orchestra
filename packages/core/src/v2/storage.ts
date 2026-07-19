import { lstat, mkdir, readdir, realpath, stat, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { ArtifactLocation, ArtifactTransfer, CoreToAgentCommand, StorageConnection } from '@fleet/shared';
import { z } from 'zod';

export type StorageDispatch = (deviceId: string, command: Omit<CoreToAgentCommand, 'requestId'>) => Promise<unknown>;

export const filesystemStorageKinds = new Set<StorageConnection['kind']>(['local', 'smb', 'nfs', 'synology', 'qnap']);

/**
 * Resolve every enrolled device implicated by an artifact location. Keeping the
 * direct device and provider-backed device (if both exist in legacy state) is
 * intentional: security and lifecycle checks must fail safe on malformed data.
 */
export function artifactLocationDeviceIds(
  location: Pick<ArtifactLocation, 'deviceId' | 'providerId'>,
  connections: readonly StorageConnection[],
): string[] {
  const deviceIds = new Set<string>();
  if (location.deviceId) deviceIds.add(location.deviceId);
  if (location.providerId) {
    const providerDeviceId = connections.find((connection) => connection.id === location.providerId)?.deviceId;
    if (providerDeviceId) deviceIds.add(providerDeviceId);
  }
  return [...deviceIds];
}

export function artifactTransferDeviceIds(
  transfer: Pick<ArtifactTransfer, 'source' | 'destination'>,
  connections: readonly StorageConnection[],
): string[] {
  return [...new Set([
    ...artifactLocationDeviceIds(transfer.source, connections),
    ...artifactLocationDeviceIds(transfer.destination, connections),
  ])];
}

const storageEntrySchema = z.object({
  name: z.string().min(1).max(4_096),
  path: z.string().max(4_096),
  type: z.enum(['directory', 'file', 'symlink', 'other']),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.string(),
});

export function normalizedStoragePath(input: string, options: { allowEmpty?: boolean; allowLeadingSlash?: boolean } = {}): string {
  const allowEmpty = options.allowEmpty ?? true;
  const allowLeadingSlash = options.allowLeadingSlash ?? true;
  if (input.length > 4_096 || input.includes('\0')) throw storageError(400, 'Storage path is invalid.');
  const portable = input.replace(/\\/g, '/');
  if (!allowLeadingSlash && (portable.startsWith('/') || /^[a-zA-Z]:/.test(portable))) {
    throw storageError(400, 'Storage directory path must be relative to the connection root.');
  }
  const withoutLeading = allowLeadingSlash ? portable.replace(/^\/+/, '') : portable;
  const segments = withoutLeading.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) throw storageError(403, 'Storage path escapes the provider root.');
  const normalized = segments.join('/');
  if (!allowEmpty && !normalized) throw storageError(400, 'A relative directory path is required.');
  return normalized;
}

export function agentStoragePath(rootPath: string, requestedPath: string): string {
  if (!requestedPath) return rootPath;
  const separator = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  return rootPath.replace(/[\\/]+$/, '') + separator + requestedPath.replace(/\//g, separator);
}

export async function browseMountedStorage(item: StorageConnection, requestedInput: string, cursorInput = 0, limitInput = 200) {
  if (!item.rootPath) throw storageError(409, 'This provider has no Core-mounted rootPath to browse.');
  const requestedPath = normalizedStoragePath(requestedInput);
  const root = await realpath(item.rootPath);
  const unresolved = resolve(root, requestedPath);
  assertInsideMountedRoot(unresolved, root, 'Storage path escapes the provider root.');
  const target = await realpath(unresolved);
  assertInsideMountedRoot(target, root, 'Storage path resolves outside the provider root.');
  if (!(await stat(target)).isDirectory()) throw storageError(400, 'Storage path is not a directory.');
  const offset = Math.max(0, Math.floor(cursorInput) || 0);
  const limit = Math.min(500, Math.max(1, Math.floor(limitInput) || 200));
  const directoryEntries = (await readdir(target, { withFileTypes: true }))
    .sort((left, right) => Number(!left.isDirectory()) - Number(!right.isDirectory()) || left.name.localeCompare(right.name));
  const entries = await Promise.all(directoryEntries.slice(offset, offset + limit).map(async (entry) => {
    const fullPath = join(target, entry.name);
    const information = await lstat(fullPath);
    return {
      name: entry.name,
      path: relative(root, fullPath).split(sep).join('/'),
      type: entry.isSymbolicLink() ? 'symlink' as const : entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const,
      sizeBytes: information.size,
      modifiedAt: information.mtime.toISOString(),
    };
  }));
  return {
    providerId: item.id,
    path: relative(root, target).split(sep).join('/'),
    entries,
    nextCursor: offset + entries.length < directoryEntries.length ? String(offset + entries.length) : undefined,
    total: directoryEntries.length,
  };
}

export async function browseAgentStorage(item: StorageConnection, deviceId: string, dispatch: StorageDispatch, requestedInput: string, cursorInput = 0, limitInput = 200) {
  if (!item.rootPath) throw storageError(409, 'This device-backed provider has no rootPath to browse.');
  const requestedPath = normalizedStoragePath(requestedInput);
  const offset = Math.max(0, Math.floor(cursorInput) || 0);
  const limit = Math.min(500, Math.max(1, Math.floor(limitInput) || 200));
  const response = z.object({
    entries: z.array(storageEntrySchema).max(500),
    nextCursor: z.string().optional(),
    total: z.number().int().nonnegative(),
  }).parse(await dispatch(deviceId, {
    type: 'file.list',
    payload: { path: agentStoragePath(item.rootPath, requestedPath), cursor: String(offset), limit },
  }));
  return {
    providerId: item.id,
    path: requestedPath,
    entries: response.entries.map((entry) => ({ ...entry, path: [requestedPath, entry.name].filter(Boolean).join('/') })),
    nextCursor: response.nextCursor,
    total: response.total,
  };
}

export async function testMountedStorage(item: StorageConnection): Promise<{ capacityBytes: number; usedBytes: number }> {
  if (!item.rootPath) throw storageError(409, 'A mounted rootPath on the Core host is required for this provider.');
  const information = await stat(item.rootPath);
  if (!information.isDirectory()) throw storageError(409, 'rootPath is not a directory.');
  const filesystem = await statfs(item.rootPath);
  return {
    capacityBytes: filesystem.blocks * filesystem.bsize,
    usedBytes: (filesystem.blocks - filesystem.bfree) * filesystem.bsize,
  };
}

export async function testAgentStorage(item: StorageConnection, deviceId: string, dispatch: StorageDispatch): Promise<void> {
  if (!item.rootPath) throw storageError(409, 'A rootPath on the backing device is required for this provider.');
  const information = z.object({ type: z.string() }).passthrough().parse(
    await dispatch(deviceId, { type: 'file.stat', payload: { path: item.rootPath } }),
  );
  if (information.type !== 'directory') throw storageError(409, 'rootPath is not a directory.');
}

export async function createMountedStorageDirectory(item: StorageConnection, requestedPath: string): Promise<void> {
  if (!item.rootPath) throw storageError(409, 'This provider has no Core-mounted rootPath.');
  await ensureMountedStorageDirectory(item.rootPath, requestedPath);
}

/**
 * Create or validate a directory beneath a mounted root without ever asking the
 * operating system to recursively traverse untrusted path components. Each
 * component is checked with lstat before use and checked again after realpath so
 * a static symlink is rejected and a concurrent replacement is detected as
 * closely as Node's path-based filesystem API permits.
 */
export async function ensureMountedStorageDirectory(rootPath: string, requestedInput: string): Promise<string> {
  const requestedPath = normalizedStoragePath(requestedInput, { allowEmpty: true, allowLeadingSlash: false });
  const root = await realpath(rootPath);
  const rootInformation = await lstat(root);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) throw storageError(409, 'Storage root is not a safe directory.');
  let current = root;
  for (const component of requestedPath.split('/')) {
    if (!component) continue;
    const next = join(current, component);
    assertInsideMountedRoot(next, root, 'Storage directory escapes the provider root.');
    try {
      const information = await lstat(next);
      if (information.isSymbolicLink()) throw storageError(403, 'Storage directories cannot traverse symbolic links.');
      if (!information.isDirectory()) throw storageError(409, 'Storage path component is not a directory: ' + component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(next, { mode: 0o755 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
    }
    const observed = await lstat(next);
    if (observed.isSymbolicLink()) throw storageError(403, 'Storage directories cannot traverse symbolic links.');
    if (!observed.isDirectory()) throw storageError(409, 'Storage path component is not a directory: ' + component);
    const actual = await realpath(next);
    assertInsideMountedRoot(actual, root, 'Storage directory resolves outside the provider root.');
    const confirmed = await lstat(next);
    if (confirmed.isSymbolicLink() || !confirmed.isDirectory()) throw storageError(403, 'Storage directory changed during validation.');
    if (observed.dev !== confirmed.dev || observed.ino !== confirmed.ino) throw storageError(409, 'Storage directory changed during validation.');
    current = actual;
  }
  const target = await realpath(current);
  assertInsideMountedRoot(target, root, 'Storage directory resolves outside the provider root.');
  return target;
}

function assertInsideMountedRoot(candidate: string, root: string, message: string): void {
  if (candidate !== root && !candidate.startsWith(root + sep)) throw storageError(403, message);
}

function storageError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
