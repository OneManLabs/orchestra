import type { Device, StorageConnection } from '@fleet/shared';

export interface WorkspaceRootChoice {
  path: string;
  label: string;
  readOnly: boolean;
  storageConnectionId?: string;
}

function slashPath(value: string): string {
  const converted = value.trim().replace(/\\/g, '/');
  const prefix = converted.startsWith('//') ? '//' : converted.startsWith('/') ? '/' : '';
  const normalized = `${prefix}${converted.split('/').filter(Boolean).join('/')}`;
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function workspacePathIsWithinRoot(candidate: string, root: string): boolean {
  const path = slashPath(candidate);
  const boundary = slashPath(root);
  return Boolean(path && boundary) && (path === boundary || (boundary === '/' ? path.startsWith('/') : path.startsWith(`${boundary}/`)));
}

export function joinWorkspacePath(parent: string, child: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child}`;
}

export function workspaceParentPath(candidate: string, root: string): string | undefined {
  if (!workspacePathIsWithinRoot(candidate, root) || slashPath(candidate) === slashPath(root)) return undefined;
  const separator = candidate.includes('\\') && !candidate.includes('/') ? '\\' : '/';
  const parent = candidate.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join(separator);
  return workspacePathIsWithinRoot(parent, root) ? parent : root;
}

export function selectableWorkspaceRoots(device: Device, storageConnections: StorageConnection[]): WorkspaceRootChoice[] {
  const choices = new Map<string, WorkspaceRootChoice>();
  for (const root of device.projectRoots.map((value) => value.trim()).filter(Boolean)) {
    choices.set(slashPath(root), { path: root, label: 'Agent project root', readOnly: false });
  }
  for (const storage of storageConnections) {
    if (storage.deviceId !== device.id || !storage.rootPath || ['offline', 'unconfigured'].includes(storage.status)) continue;
    const key = slashPath(storage.rootPath);
    const existing = choices.get(key);
    choices.set(key, {
      path: storage.rootPath,
      label: existing ? `${existing.label} · ${storage.name}` : `${storage.name} · ${storage.kind.toUpperCase()}`,
      readOnly: storage.readOnly,
      storageConnectionId: storage.id,
    });
  }
  return [...choices.values()];
}

export function validWorkspaceFolderName(value: string): boolean {
  const name = value.trim();
  return Boolean(name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name));
}
