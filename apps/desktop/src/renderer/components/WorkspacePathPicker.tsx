import type { Device, StorageConnection } from '@fleet/shared';
import { ArrowLeft, File, FolderOpen, HardDrive, LoaderCircle, Plus, RefreshCw, Server, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type DeviceWorkspacePage } from '../lib/api';
import {
  joinWorkspacePath,
  selectableWorkspaceRoots,
  validWorkspaceFolderName,
  workspaceParentPath,
  workspacePathIsWithinRoot,
} from '../lib/workspace-path';
import { useFleet } from '../state/FleetContext';

interface WorkspacePathPickerProps {
  device: Device;
  storageConnections: StorageConnection[];
  value: string;
  onChoose(path: string): void;
  onClose(): void;
}

export function WorkspacePathPicker({ device, storageConnections, value, onChoose, onClose }: WorkspacePathPickerProps) {
  const { request } = useFleet();
  const roots = useMemo(() => selectableWorkspaceRoots(device, storageConnections), [device, storageConnections]);
  const initialRoot = useMemo(() => roots
    .filter((root) => workspacePathIsWithinRoot(value, root.path))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? roots[0], [roots, value]);
  const [rootPath, setRootPath] = useState(initialRoot?.path ?? '');
  const [rootBoundary, setRootBoundary] = useState(initialRoot?.path ?? '');
  const [currentPath, setCurrentPath] = useState(value && initialRoot && workspacePathIsWithinRoot(value, initialRoot.path) ? value : initialRoot?.path ?? '');
  const [listing, setListing] = useState<DeviceWorkspacePage | null>(null);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [pendingFolder, setPendingFolder] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const selectedRoot = roots.find((root) => root.path === rootPath) ?? roots[0];
  const effectivePath = listing?.path ?? currentPath;
  const parent = workspaceParentPath(effectivePath, rootBoundary);
  const inaccessibleStorage = storageConnections.filter((storage) => storage.rootPath && storage.deviceId !== device.id && !['offline', 'unconfigured'].includes(storage.status));

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !pendingFolder) onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose, pendingFolder]);

  useEffect(() => {
    if (!currentPath) return;
    const activeGeneration = ++generation.current;
    const requestedPath = currentPath;
    setListing(null);
    setError('');
    setPageError('');
    setLoadingMore(false);
    void request(() => api.listDeviceWorkspace(device.id, requestedPath)).then((page) => {
      if (generation.current !== activeGeneration) return;
      setListing(page);
      if (selectedRoot && sameWorkspacePath(requestedPath, selectedRoot.path)) setRootBoundary(page.path);
    }).catch((reason) => {
      if (generation.current === activeGeneration) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { if (generation.current === activeGeneration) generation.current += 1; };
  }, [currentPath, device.id, request, revision, selectedRoot?.path]);

  function chooseRoot(path: string): void {
    setRootPath(path);
    setRootBoundary(path);
    setCurrentPath(path);
    setListing(null);
    setError('');
  }

  async function loadMore(): Promise<void> {
    if (!listing?.nextCursor || loadingMore) return;
    const activeGeneration = generation.current;
    setLoadingMore(true);
    setPageError('');
    try {
      const page = await request(() => api.listDeviceWorkspace(device.id, effectivePath, listing.nextCursor));
      if (generation.current !== activeGeneration) return;
      setListing((current) => mergeWorkspacePages(current, page));
    } catch (reason) {
      if (generation.current === activeGeneration) setPageError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === activeGeneration) setLoadingMore(false);
    }
  }

  async function createFolder(): Promise<void> {
    const name = folderName.trim();
    if (!validWorkspaceFolderName(name)) {
      setError('Folder name must be one name without slashes.');
      return;
    }
    setPendingFolder(true);
    setError('');
    try {
      const created = await request(() => api.createDeviceWorkspaceDirectory(device.id, joinWorkspacePath(effectivePath, name)));
      setFolderName('');
      setCreatingFolder(false);
      setCurrentPath(created.path);
      setListing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingFolder(false);
    }
  }

  function folderKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    void createFolder();
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !pendingFolder) onClose(); }}>
    <div className="modal workspace-picker" role="dialog" aria-modal="true" aria-labelledby="workspace-picker-title">
      <header><div><span className="eyebrow">Execution workspace</span><h2 id="workspace-picker-title">Choose a folder on {device.name}</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={pendingFolder} aria-label="Close"><X size={18} /></button></header>
      {roots.length ? <>
        <label>Available root<select value={selectedRoot?.path ?? ''} onChange={(event) => chooseRoot(event.target.value)}>{roots.map((root) => <option key={root.path} value={root.path}>{root.label} · {root.path}{root.readOnly ? ' · read only' : ''}</option>)}</select></label>
        <div className="workspace-picker__path"><button type="button" className="icon-button" disabled={!parent} onClick={() => parent && setCurrentPath(parent)} aria-label="Parent folder"><ArrowLeft size={15} /></button><FolderOpen size={16} /><code>{effectivePath}</code><button type="button" className="icon-button" onClick={() => setRevision((current) => current + 1)} aria-label="Refresh"><RefreshCw size={14} /></button></div>
        <div className="workspace-picker__toolbar"><span>Folders can be used as a Codex working directory.</span><button type="button" className="secondary-button compact" disabled={selectedRoot?.readOnly} onClick={() => setCreatingFolder((current) => !current)}><Plus size={14} />New folder</button></div>
        {creatingFolder && <div className="workspace-picker__new-folder"><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} onKeyDown={folderKeyDown} placeholder="Folder name" aria-label="New folder name" /><button type="button" className="secondary-button compact" onClick={() => { setCreatingFolder(false); setFolderName(''); }}>Cancel</button><button type="button" className="primary-button compact" disabled={pendingFolder} onClick={() => void createFolder()}>{pendingFolder ? 'Creating…' : 'Create & open'}</button></div>}
        {error ? <div className="workspace-picker__empty"><HardDrive size={25} /><strong>Folder unavailable</strong><span>{error}</span><button type="button" className="secondary-button compact" onClick={() => setRevision((current) => current + 1)}>Retry</button></div> : !listing ? <div className="workspace-picker__empty"><LoaderCircle className="spin" size={25} /><strong>Reading {device.name}</strong><span>The Agent is checking this folder against its allowed roots.</span></div> : listing.entries.length ? <div className="workspace-picker__entries">{listing.entries.map((entry) => <button type="button" key={entry.path} disabled={entry.type !== 'directory'} onClick={() => entry.type === 'directory' && setCurrentPath(entry.path)}><span>{entry.type === 'directory' ? <FolderOpen size={17} /> : <File size={16} />}</span><strong>{entry.name}</strong><small>{entry.type === 'directory' ? 'Folder' : entry.type}</small></button>)}</div> : <div className="workspace-picker__empty"><FolderOpen size={25} /><strong>Empty folder</strong><span>Create a folder here or use this folder directly.</span></div>}
        {listing && (listing.nextCursor || pageError) && <div className="workspace-picker__pagination"><span>Showing {listing.entries.length} of {listing.total}</span>{pageError && <small role="alert">{pageError}</small>}{listing.nextCursor && <button type="button" className="secondary-button compact" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}</div>}
        {inaccessibleStorage.length > 0 && <div className="notice subtle"><Server size={15} /><span>{inaccessibleStorage.map((storage) => storage.name).join(', ')} {inaccessibleStorage.length === 1 ? 'is' : 'are'} not mounted through {device.name}'s Agent. For live editing, mount the share there and add that mount to the Agent project roots.</span></div>}
        <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={!listing || Boolean(error)} onClick={() => { onChoose(effectivePath); onClose(); }}><FolderOpen size={14} />Use this folder</button></footer>
      </> : <><div className="workspace-picker__empty"><HardDrive size={25} /><strong>No workspace roots configured</strong><span>Add a local folder or mounted NAS path to this device's Agent project roots, then reconnect the Agent.</span></div><footer><button type="button" className="secondary-button" onClick={onClose}>Close</button></footer></>}
    </div>
  </div>;
}

function sameWorkspacePath(left: string, right: string): boolean {
  return workspacePathIsWithinRoot(left, right) && workspacePathIsWithinRoot(right, left);
}

function mergeWorkspacePages(current: DeviceWorkspacePage | null, incoming: DeviceWorkspacePage): DeviceWorkspacePage {
  if (!current || !sameWorkspacePath(current.path, incoming.path)) return incoming;
  const entries = new Map(current.entries.map((entry) => [entry.path, entry]));
  for (const entry of incoming.entries) entries.set(entry.path, entry);
  return { ...incoming, entries: [...entries.values()], total: Math.max(incoming.total, entries.size) };
}
