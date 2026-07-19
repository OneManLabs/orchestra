import type { Device, StorageConnection } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import {
  joinWorkspacePath,
  selectableWorkspaceRoots,
  validWorkspaceFolderName,
  workspaceParentPath,
  workspacePathIsWithinRoot,
} from '../src/renderer/lib/workspace-path';

describe('Codex workspace path state', () => {
  it('keeps parent navigation inside its selected root', () => {
    expect(workspaceParentPath('/Volumes/NAS/repos/fleet', '/Volumes/NAS')).toBe('/Volumes/NAS/repos');
    expect(workspaceParentPath('/Volumes/NAS', '/Volumes/NAS')).toBeUndefined();
    expect(workspaceParentPath('/Users/example', '/Volumes/NAS')).toBeUndefined();
  });

  it('handles Windows roots case-insensitively and preserves separators', () => {
    expect(workspacePathIsWithinRoot('D:\\Projects\\Fleet', 'd:\\projects')).toBe(true);
    expect(joinWorkspacePath('D:\\Projects', 'New folder')).toBe('D:\\Projects\\New folder');
    expect(workspacePathIsWithinRoot('\\\\nas\\share\\models', '\\\\nas\\share')).toBe(true);
  });

  it('rejects names that could escape the current directory', () => {
    expect(validWorkspaceFolderName('models')).toBe(true);
    expect(validWorkspaceFolderName('../models')).toBe(false);
    expect(validWorkspaceFolderName('nested/models')).toBe(false);
  });

  it('exposes connected storage only when it belongs to the execution device', () => {
    const device = { id: 'mbp', projectRoots: ['/Users/example/Code', '/Volumes/NAS'] } as Device;
    const storage = [
      { id: 'nas-local', name: 'Studio NAS', kind: 'smb', deviceId: 'mbp', rootPath: '/Volumes/NAS', status: 'connected', readOnly: false },
      { id: 'nas-remote', name: 'Remote NAS', kind: 'nfs', deviceId: 'nas-agent', rootPath: '/data', status: 'connected', readOnly: false },
    ] as StorageConnection[];
    const roots = selectableWorkspaceRoots(device, storage);
    expect(roots).toHaveLength(2);
    expect(roots.find((root) => root.path === '/Volumes/NAS')?.label).toContain('Studio NAS');
    expect(roots.some((root) => root.path === '/data')).toBe(false);
  });
});
