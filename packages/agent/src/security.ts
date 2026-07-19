import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

interface ConfiguredRoot {
  configured: string;
  resolved?: string;
  available: boolean;
}

interface AllowedTarget {
  target: string;
  root: ConfiguredRoot & { resolved: string; available: true };
}

/**
 * Resolve a working directory and create missing descendants when safe.
 * The configured root itself must already exist and resolve to a directory.
 */
export async function resolveAllowedDirectory(cwd: string, allowedRoots: string[]): Promise<string> {
  const allowed = await resolveAllowedTarget(cwd, allowedRoots);
  assertDirectoryComponent(await lstat(allowed.root.resolved), allowed.root.resolved);
  let current = allowed.root.resolved;
  const relative = path.relative(allowed.root.resolved, allowed.target);

  for (const component of pathComponents(relative)) {
    const next = path.join(current, component);
    try {
      const info = await lstat(next);
      assertDirectoryComponent(info, next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        // Create one component at a time. Recursive mkdir could silently
        // recreate a missing mount/root after it disappeared.
        await mkdir(next, { mode: 0o755 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          if ((mkdirError as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`Configured project root became unavailable while creating working directory: ${allowed.root.configured}`);
          }
          throw new Error(`Unable to create working directory inside configured project root: ${cwd}. ${(mkdirError as Error).message}`);
        }
      }
      const created = await lstat(next);
      assertDirectoryComponent(created, next);
    }
    current = next;
  }

  // Re-walk after creation to reject a component swapped for a symlink, then
  // resolve the final path and verify it still belongs to the same real root.
  await assertDirectoryComponents(allowed.target, allowed.root.resolved);
  const resolved = await realpath(allowed.target);
  assertInsideRoots(resolved, [allowed.root.resolved]);
  return resolved;
}

export async function resolveAllowedPath(candidate: string, allowedRoots: string[], mustExist: boolean): Promise<string> {
  const allowed = await resolveAllowedTarget(candidate, allowedRoots);
  let current = allowed.root.resolved;
  const components = pathComponents(path.relative(allowed.root.resolved, allowed.target));

  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Paths through symbolic links are not allowed: ${current}`);
      if (index < components.length - 1 && !info.isDirectory()) throw new Error(`Path component is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (mustExist) throw new Error(`Path does not exist inside a configured project root: ${candidate}`);
      return allowed.target;
    }
  }

  const resolved = await realpath(allowed.target);
  assertInsideRoots(resolved, [allowed.root.resolved]);
  return resolved;
}

export async function resolvedRoots(allowedRoots: string[]): Promise<string[]> {
  const roots = await inspectRoots(allowedRoots);
  const unavailable = roots.find((root) => !root.available || !root.resolved);
  if (unavailable) throw unavailableRootError(unavailable.configured);
  return roots.map((root) => root.resolved!);
}

export function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeCase(path.resolve(candidate));
  const normalizedRoot = normalizeCase(path.resolve(root));
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveAllowedTarget(candidate: string, allowedRoots: string[]): Promise<AllowedTarget> {
  if (!candidate?.trim()) throw new Error('A path is required.');
  if (allowedRoots.length === 0) throw new Error('No project roots are configured.');
  const absolute = path.resolve(candidate);
  const roots = await inspectRoots(allowedRoots);
  const matches = roots.flatMap((root) => {
    const configuredMatch = isPathInside(absolute, root.configured);
    const resolvedMatch = Boolean(root.resolved && isPathInside(absolute, root.resolved));
    if (!configuredMatch && !resolvedMatch) return [];
    const base = configuredMatch ? root.configured : root.resolved!;
    return [{ root, base, relative: path.relative(base, absolute) }];
  }).sort((left, right) => right.base.length - left.base.length);

  const match = matches[0];
  if (!match) throw new Error(`Path is outside configured project roots: ${candidate}`);
  if (!match.root.available || !match.root.resolved) throw unavailableRootError(match.root.configured);
  const target = path.resolve(match.root.resolved, match.relative);
  assertInsideRoots(target, [match.root.resolved]);
  return { target, root: match.root as AllowedTarget['root'] };
}

async function inspectRoots(allowedRoots: string[]): Promise<ConfiguredRoot[]> {
  return Promise.all(allowedRoots.map(async (root) => {
    const configured = path.resolve(root);
    try {
      const resolved = await realpath(configured);
      const info = await stat(resolved);
      if (!info.isDirectory()) return { configured, available: false };
      return { configured, resolved, available: true };
    } catch {
      return { configured, available: false };
    }
  }));
}

async function assertDirectoryComponents(target: string, root: string): Promise<void> {
  assertDirectoryComponent(await lstat(root), root);
  let current = root;
  for (const component of pathComponents(path.relative(root, target))) {
    current = path.join(current, component);
    const info = await lstat(current);
    assertDirectoryComponent(info, current);
  }
}

function assertDirectoryComponent(info: Awaited<ReturnType<typeof lstat>>, component: string): void {
  if (info.isSymbolicLink()) throw new Error(`Working directories cannot traverse symbolic links: ${component}`);
  if (!info.isDirectory()) throw new Error(`Working directory component is not a directory: ${component}`);
}

function pathComponents(relative: string): string[] {
  return relative.split(path.sep).filter(Boolean);
}

function unavailableRootError(root: string): Error {
  return new Error(`Configured project root is unavailable or unmounted: ${root}. Restore or mount it before starting work.`);
}

function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function assertInsideRoots(candidate: string, roots: string[]): void {
  if (!roots.some((root) => isPathInside(candidate, root))) {
    throw new Error(`Path is outside configured project roots: ${candidate}`);
  }
}
