import type { CodexSession, Device, FleetProject } from '@fleet/shared';
import {
  Bot, Code2, Copy, ExternalLink, FolderGit2, GitBranch, Globe2, MoreHorizontal,
  Play, Plus, QrCode, RefreshCcw, Server, ShieldCheck, Square, Trash2, X,
} from 'lucide-react';
import QRCode from 'react-qr-code';
import { useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState';
import { api } from '../lib/api';
import { relativeTime, titleCase } from '../lib/format';
import { useFleet } from '../state/FleetContext';
import { PageHeader } from './JobsPage';

export function ProjectsPage({ onOpenCodex }: { onOpenCodex(deviceId: string, sessionId: string): void }) {
  const { snapshot, request } = useFleet();
  const [editing, setEditing] = useState<FleetProject | 'new' | null>(null);
  const [qrProject, setQrProject] = useState<FleetProject | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const projects = snapshot?.projects ?? [];

  async function startPreview(project: FleetProject, visibility: 'tailnet' | 'public' = 'tailnet'): Promise<void> {
    if (visibility === 'public' && !window.confirm('Public previews are reachable from the internet. Continue with Tailscale Funnel?')) return;
    setPendingProjectId(project.id);
    try {
      await request(() => api.startProjectPreview(project.id, {
        visibility,
        confirmPublic: visibility === 'public',
        autoStartWithCodex: true,
      }));
    } finally { setPendingProjectId(null); }
  }

  async function stopPreview(project: FleetProject): Promise<void> {
    setPendingProjectId(project.id);
    try { await request(() => api.stopProjectPreview(project.id)); }
    finally { setPendingProjectId(null); }
  }

  async function openPreview(project: FleetProject): Promise<void> {
    if (!project.preview?.url) return;
    void api.touchProjectPreview(project.id).catch(() => undefined);
    await openExternal(project.preview.url);
  }

  return <div className="page">
    <PageHeader eyebrow="Shared development workspaces" title="Projects" detail="Open the website and its live Codex conversation from every authorized fleet device" action={<button className="primary-button" onClick={() => setEditing('new')}><Plus size={15} />Add project</button>} />
    {projects.length ? <div className="project-grid project-grid--shared">{projects.map((project) => {
      const host = snapshot?.devices.find((device) => device.id === project.preview?.deviceId);
      const sessions = (snapshot?.sessions ?? []).filter((session) => session.projectId === project.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return <SharedProjectCard
        key={project.id}
        project={project}
        host={host}
        sessions={sessions}
        devices={snapshot?.devices ?? []}
        pending={pendingProjectId === project.id}
        configure={() => setEditing(project)}
        start={(visibility) => void startPreview(project, visibility).catch(() => undefined)}
        stop={() => void stopPreview(project).catch(() => undefined)}
        open={() => void openPreview(project)}
        copy={() => void copyText(project.preview?.url ?? '')}
        qr={() => setQrProject(project)}
        openCodex={(session) => onOpenCodex(session.deviceId, session.id)}
      />;
    })}</div> : <EmptyState icon={FolderGit2} title="Register your first project" description="Map one logical project to its local path on each device, then Orchestra can share its website and Codex session everywhere." action={<button className="primary-button" onClick={() => setEditing('new')}><Plus size={15} />Add project</button>} />}
    {editing && <ProjectDialog project={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDelete={editing === 'new' ? undefined : async () => { await request(() => api.deleteProject(editing.id)); setEditing(null); }} />}
    {qrProject?.preview?.url && <QrDialog project={qrProject} onClose={() => setQrProject(null)} />}
  </div>;
}

function SharedProjectCard({
  project, host, sessions, devices, pending, configure, start, stop, open, copy, qr, openCodex,
}: {
  project: FleetProject;
  host?: Device;
  sessions: CodexSession[];
  devices: Device[];
  pending: boolean;
  configure(): void;
  start(visibility: 'tailnet' | 'public'): void;
  stop(): void;
  open(): void;
  copy(): void;
  qr(): void;
  openCodex(session: CodexSession): void;
}) {
  const preview = project.preview;
  const activePreview = Boolean(preview && ['starting', 'running', 'restarting', 'offline'].includes(preview.status));
  const activeSession = sessions.find((session) => ['thinking', 'awaiting-approval', 'ready', 'completed'].includes(session.status)) ?? sessions[0];
  const mappedOnlineDevices = devices.filter((device) => device.status !== 'offline' && project.paths.some((path) => path.deviceId === device.id));
  const recentPreviewOutput = preview?.logs.filter((log) => log.stream === 'stderr' || log.stream === 'system').slice(-4) ?? [];
  const setupUrl = preview?.error?.match(/https:\/\/login\.tailscale\.com\/[^\s]+/)?.[0];
  return <article className="project-card shared-project-card">
    <header><div className="project-card__identity"><div className="project-icon"><FolderGit2 size={20} /></div><div><span className="eyebrow">Shared workspace</span><h2>{project.name}</h2></div></div><button className="icon-button" onClick={configure}><MoreHorizontal size={17} /></button></header>
    <p>{project.description || 'No description provided.'}</p>
    {project.repository && <a href={project.repository} target="_blank" rel="noreferrer"><Code2 size={13} />{project.repository.replace(/^https?:\/\//, '')}<ExternalLink size={12} /></a>}

    <section className="project-resource">
      <header><div><Globe2 size={15} /><span><strong>Preview</strong><small>{preview ? `${preview.framework} · port ${preview.port || 'detecting'}` : 'Development server not started'}</small></span></div><ResourceState status={preview?.status ?? 'stopped'} /></header>
      {preview && <div className="project-resource__details"><span><Server size={12} />{host?.name ?? preview.deviceId}</span><span><ShieldCheck size={12} />{preview.visibility === 'public' ? 'Public Funnel' : preview.transport === 'direct-tailnet' ? 'Private tailnet · Direct' : 'Private tailnet'}</span><span><RefreshCcw size={12} />{preview.desiredState === 'stopped' ? 'Stopped by operator' : 'Persistent · auto-recovers'}</span>{preview.health && <span className={`preview-health preview-health--${preview.health.state}`}>{titleCase(preview.health.state)}{preview.health.latencyMs != null ? ` · ${preview.health.latencyMs} ms` : ''}{preview.health.statusCode ? ` · HTTP ${preview.health.statusCode}` : ''}</span>}{preview.lastHealthyAt && <span>Healthy {relativeTime(preview.lastHealthyAt)}</span>}{preview.url && <code>{preview.url}</code>}</div>}
      {preview?.error && <div className="project-resource__error">{preview.error}</div>}
      {setupUrl && <button className="secondary-button compact preview-setup-button" onClick={() => void openExternal(setupUrl)}><ShieldCheck size={13} />Enable Tailscale {preview?.visibility === 'public' ? 'Funnel' : 'Serve'}</button>}
      {recentPreviewOutput.length > 0 && <details className="project-preview-output" open={preview?.status === 'error'}><summary>Development server output</summary><pre>{recentPreviewOutput.map((log) => `[${new Date(log.at).toLocaleTimeString()}] ${log.text}`).join('\n')}</pre></details>}
      <div className="project-resource__actions">
        {preview?.status === 'running' && preview.url ? <><button className="primary-button compact" onClick={open}><ExternalLink size={13} />Open Website</button><button className="icon-button" onClick={copy} title="Copy preview link"><Copy size={14} /></button><button className="icon-button" onClick={qr} title="Show QR code"><QrCode size={14} /></button><button className="secondary-button compact" disabled={pending} onClick={stop}><Square size={12} />Stop</button></> :
          <button className="primary-button compact" disabled={pending || mappedOnlineDevices.length === 0} onClick={() => start(preview?.visibility ?? 'tailnet')}>{preview?.status === 'offline' || preview?.status === 'error' ? <RefreshCcw size={13} /> : <Play size={13} />}{pending ? 'Starting…' : preview?.status === 'offline' || preview?.status === 'error' ? 'Restart Preview' : 'Start Shared Preview'}</button>}
        {!activePreview && <button className="text-button public-preview-button" disabled={pending || mappedOnlineDevices.length === 0} onClick={() => start('public')}><Globe2 size={12} />Public preview</button>}
      </div>
    </section>

    <section className="project-resource">
      <header><div><Bot size={15} /><span><strong>Codex</strong><small>{activeSession ? `${activeSession.status === 'thinking' ? 'Working' : titleCase(activeSession.status)} on ${devices.find((device) => device.id === activeSession.deviceId)?.name ?? activeSession.deviceId}` : 'No shared conversation yet'}</small></span></div><ResourceState status={activeSession?.status ?? 'stopped'} /></header>
      {activeSession && <><div className="project-resource__details"><span>{activeSession.events.length} events</span><span>{activeSession.participants?.length ?? 0} participants</span><span>{activeSession.pendingApprovals.length} approvals</span></div><button className="secondary-button compact project-open-codex" onClick={() => openCodex(activeSession)}><Bot size={13} />Open Codex</button></>}
    </section>

    <div className="project-card__meta"><span><GitBranch size={13} />{project.defaultBranch}</span><span><Server size={13} />{project.paths.length} mappings</span></div>
    <footer>Updated {relativeTime(project.updatedAt)}<button className="text-button" onClick={configure}>Configure</button></footer>
  </article>;
}

function ResourceState({ status }: { status: string }) {
  const live = ['running', 'ready', 'completed'].includes(status);
  const working = ['starting', 'restarting', 'thinking', 'awaiting-approval'].includes(status);
  return <span className={`project-resource-state ${live ? 'is-live' : working ? 'is-working' : status === 'error' || status === 'offline' ? 'is-error' : ''}`}><i />{titleCase(status)}</span>;
}

function QrDialog({ project, onClose }: { project: FleetProject; onClose(): void }) {
  const url = project.preview!.url!;
  return <div className="modal-backdrop" role="presentation"><section className="modal preview-qr-dialog"><header><div><span className="eyebrow">Open on another device</span><h2>{project.name}</h2></div><button className="icon-button" onClick={onClose}><X size={17} /></button></header><div className="preview-qr-code"><QRCode value={url} size={220} bgColor="#ffffff" fgColor="#071018" /></div><p>Scan from an authorized phone or tablet connected to this tailnet.</p><code>{url}</code><button className="secondary-button" onClick={() => void copyText(url)}><Copy size={14} />Copy link</button></section></div>;
}

function ProjectDialog({ project, onClose, onDelete }: { project?: FleetProject; onClose(): void; onDelete?: () => Promise<void> }) {
  const { snapshot, request } = useFleet();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [repository, setRepository] = useState(project?.repository ?? '');
  const [branch, setBranch] = useState(project?.defaultBranch ?? 'main');
  const [startCommand, setStartCommand] = useState(project?.commands.start ?? '');
  const [paths, setPaths] = useState<Record<string, string>>(Object.fromEntries(project?.paths.map((path) => [path.deviceId, path.path]) ?? []));
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true);
    const body = {
      name, description, repository: repository || undefined, defaultBranch: branch,
      paths: Object.entries(paths).filter(([, path]) => path.trim()).map(([deviceId, path]) => ({ deviceId, path })),
      preferredDeviceIds: project?.preferredDeviceIds ?? [],
      commands: { ...project?.commands, start: startCommand.trim() || undefined },
      artifactPaths: project?.artifactPaths ?? [],
    };
    try {
      if (project) await request(() => api.updateProject(project.id, body));
      else await request(() => api.createProject(body));
      onClose();
    } finally { setPending(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal modal--wide" onSubmit={submit}><header><div><span className="eyebrow">Project registry</span><h2>{project ? 'Configure project' : 'Add a project'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></header><div className="form-grid"><label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Orchestra Canvas Website" /></label><label>Default branch<input required value={branch} onChange={(event) => setBranch(event.target.value)} /></label></div><label>Description<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this project does" /></label><label>Git repository<input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="https://github.com/org/repo" /></label><label>Development command <span className="optional">optional</span><input value={startCommand} onChange={(event) => setStartCommand(event.target.value)} placeholder="Auto-detect package manager and dev script" /><small>Leave blank for automatic Next.js, Vite, Astro, Remix, Nuxt, SvelteKit, or Angular detection.</small></label><fieldset><legend>Device paths</legend><p>Only fill in devices where this project is checked out or mounted.</p><div className="path-list">{snapshot?.devices.map((device) => <label key={device.id}><span><i className={`status-dot status-dot--${device.status}`} />{device.name}</span><input value={paths[device.id] ?? ''} onChange={(event) => setPaths((current) => ({ ...current, [device.id]: event.target.value }))} placeholder={device.projectRoots[0] ?? '/path/to/project'} /></label>)}</div></fieldset><footer>{onDelete && <button type="button" className="danger-button" onClick={() => void onDelete()}><Trash2 size={14} />Delete</button>}<span /><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={pending}>{pending ? 'Saving…' : 'Save project'}</button></footer></form></div>;
}

async function copyText(value: string): Promise<void> {
  if (!value) return;
  if (window.fleetDesktop?.menuBar) await window.fleetDesktop.menuBar.writeClipboardText(value);
  else await navigator.clipboard.writeText(value);
}

async function openExternal(url: string): Promise<void> {
  if (window.fleetDesktop) await window.fleetDesktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
