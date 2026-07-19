import { Activity, BellRing, Bot, Box, Boxes, Command, Database, FolderGit2, GitFork, Gauge, HardDrive, KeyRound, LayoutDashboard, Menu, MessageSquare, Plug, RefreshCcw, Server, Settings, ShieldCheck, Stethoscope, Users, Workflow, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DeviceInspector, type InspectorTab } from './components/DeviceInspector';
import type { InitialCodexSessionTarget } from './lib/codex-session-state';
import { useFleet } from './state/FleetContext';
import { ActivityPage } from './pages/ActivityPage';
import { CanvasPage } from './pages/CanvasPage';
import { JobsPage } from './pages/JobsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { OverviewPage } from './pages/OverviewPage';
import { ArtifactsPage } from './pages/ArtifactsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { AutomationPage } from './pages/AutomationPage';
import { SecurityPage } from './pages/SecurityPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { TeamsPage } from './pages/TeamsPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { SystemPage } from './pages/SystemPage';
import { api, browserConnectionDefaults } from './lib/api';

type Page = 'overview' | 'system' | 'canvas' | 'projects' | 'jobs' | 'pipelines' | 'artifacts' | 'telemetry' | 'automation' | 'security' | 'teams' | 'integrations' | 'diagnostics' | 'activity' | 'settings';
const navItems = [
  { id: 'overview', label: 'Overview', icon: Gauge, group: 'Command' },
  { id: 'system', label: 'Orchestra System', icon: MessageSquare },
  { id: 'canvas', label: 'Orchestra canvas', icon: LayoutDashboard },
  { id: 'jobs', label: 'Jobs', icon: Box },
  { id: 'pipelines', label: 'Pipelines', icon: GitFork, group: 'Work' },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'artifacts', label: 'Artifacts', icon: Database },
  { id: 'teams', label: 'Teams & Codex', icon: Users },
  { id: 'telemetry', label: 'Telemetry', icon: Activity, group: 'Operate' },
  { id: 'automation', label: 'Automation', icon: Zap },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings, group: 'System' }
] as const;

export function App() {
  const { snapshot, loading, connected, error, refresh, connectBrowser } = useFleet(); const [page, setPage] = useState<Page>('overview'); const [selectedId, setSelectedId] = useState<string | null>(null); const [selectedInspectorTab, setSelectedInspectorTab] = useState<InspectorTab>('overview'); const [selectedSessionTarget, setSelectedSessionTarget] = useState<InitialCodexSessionTarget | undefined>(); const sessionTargetSequence = useRef(0); const [sidebarOpen, setSidebarOpen] = useState(false); const [openEntity, setOpenEntity] = useState<{ id: string; sequence: number } | null>(null);
  const macDesktop = window.fleetDesktop?.platform === 'darwin';
  const seenNotifications = useRef<Set<string> | null>(null);
  const selected = useMemo(() => snapshot?.devices.find((device) => device.id === selectedId), [snapshot, selectedId]);
  function navigate(next: Page) { setPage(next); setSidebarOpen(false); setOpenEntity(null); if (next !== 'canvas') setSelectedId(null); }
  function selectDevice(id: string, inspectorTab: InspectorTab = 'overview', sessionId?: string) { setPage('canvas'); setSelectedInspectorTab(inspectorTab); setSelectedSessionTarget(sessionId ? { id: sessionId, sequence: ++sessionTargetSequence.current } : undefined); setSelectedId(id); }
  function openNewCodexSession(id: string) { setPage('canvas'); setSelectedInspectorTab('codex'); setSelectedSessionTarget({ id: null, sequence: ++sessionTargetSequence.current }); setSelectedId(id); void window.fleetDesktop?.codexMicro.setActiveSession(null); }
  function openProjectPreview(id: string) {
    const project = snapshot?.projects.find((candidate) => candidate.id === id);
    const url = project?.preview?.status === 'running' ? project.preview.url : undefined;
    if (!url) return;
    void api.touchProjectPreview(id).catch(() => undefined);
    if (window.fleetDesktop) void window.fleetDesktop.openExternal(url).catch(() => undefined);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  useEffect(() => window.fleetDesktop?.onNotificationClick(() => navigate('integrations')), []);
  useEffect(() => window.fleetDesktop?.onOpenMainTarget?.((target) => {
    const targetPage = navItems.some((item) => item.id === target.page) ? target.page as Page : undefined;
    const inspectorTab = deepLinkInspectorTab(target.tab);
    if (target.deviceId && (targetPage === 'canvas' || inspectorTab)) {
      const sessionId = target.navigationTarget?.sessionId ?? target.sessionId ?? (inspectorTab === 'codex' ? target.entityId : undefined);
      // Main and renderer both issue navigation commands. Rebase the main-process
      // sequence onto the renderer's local monotonic clock so every command is
      // consumable even after several dropdown/new-chat selections.
      const sequence = Math.max(target.navigationTarget?.sequence ?? 0, sessionTargetSequence.current + 1);
      sessionTargetSequence.current = sequence;
      setPage('canvas'); setSidebarOpen(false); setSelectedId(target.deviceId); setSelectedInspectorTab(inspectorTab ?? 'overview'); setSelectedSessionTarget(target.navigationTarget ? { id: target.navigationTarget.sessionId, sequence } : sessionId ? { id: sessionId, sequence } : undefined);
      return;
    }
    if (targetPage) {
      setPage(targetPage); setSidebarOpen(false); if (targetPage !== 'canvas') setSelectedId(null);
      setOpenEntity(targetPage === 'jobs' && target.entityId
        ? (current) => ({ id: target.entityId!, sequence: (current?.sequence ?? 0) + 1 })
        : null);
    }
  }), []);
  useEffect(() => window.fleetDesktop?.codexMicro.onAction((event) => {
    if (event.phase !== 'press') return;
    const session = event.sessionId ? snapshot?.sessions.find((item) => item.id === event.sessionId) : undefined;
    if (event.action === 'toggle-sidebar') { setSidebarOpen((value) => !value); return; }
    if (event.action === 'navigate-back') { window.history.back(); return; }
    if (event.action === 'navigate-forward') { window.history.forward(); return; }
    if (event.action === 'open-feedback') { navigate('integrations'); return; }
    if (event.action === 'open-side-chat') { navigate('system'); return; }
    if (event.action === 'open-scheduled') { navigate('automation'); return; }
    if (event.action === 'open-plugins') { navigate('integrations'); return; }
    if (event.action === 'open-folder') { navigate('projects'); return; }
    if (event.action === 'new-chat' && event.deviceId) { openNewCodexSession(event.deviceId); return; }
    if (event.action === 'open-browser' && session?.projectId) {
      openProjectPreview(session.projectId);
      return;
    }
    if (event.action === 'copy-chat-markdown' && session) {
      const markdown = [`# ${session.title}`, '', ...session.events.map((item) => `## ${item.type}\n\n${item.text}`)].join('\n');
      void window.fleetDesktop?.menuBar.writeClipboardText(markdown);
      return;
    }
    if (event.action === 'toggle-pin' && event.sessionId) {
      void window.fleetDesktop?.codexMicro.getState().then((state) => window.fleetDesktop!.codexMicro.setPreferences({
        ...state.preferences,
        pinnedSessionIds: state.preferences.pinnedSessionIds.includes(event.sessionId!)
          ? state.preferences.pinnedSessionIds.filter((id) => id !== event.sessionId)
          : [...state.preferences.pinnedSessionIds, event.sessionId!].slice(-6),
      }));
    }
  }), [snapshot]);
  useEffect(() => window.fleetDesktop?.codexMicro.onDial((event) => {
    if (event.mode !== 'composer-navigation') return;
    const key = event.direction === 'clockwise' ? 'ArrowUp' : event.direction === 'counterclockwise' ? 'ArrowDown' : event.direction === 'press' ? 'Enter' : null;
    if (!key) return;
    const repeat = event.direction === 'press'
      ? 1
      : typeof event.steps === 'number' && Number.isFinite(event.steps)
        ? Math.max(1, Math.min(64, Math.trunc(Math.abs(event.steps))))
        : 1;
    for (let step = 0; step < repeat; step += 1) {
      (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
    }
  }), []);
  useEffect(() => {
    if (!snapshot) return;
    const notifications = snapshot.v2.notifications;
    if (!seenNotifications.current) {
      seenNotifications.current = new Set(notifications.map((item) => item.id));
      return;
    }
    for (const item of notifications) {
      if (seenNotifications.current.has(item.id)) continue;
      seenNotifications.current.add(item.id);
      if (item.status === 'read' || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      if (window.fleetDesktop) {
        void window.fleetDesktop.showNotification({ id: item.id, severity: item.severity }).catch(() => undefined);
      } else {
        const notice = new Notification(item.severity === 'critical' ? 'Orchestra critical event' : item.severity === 'warning' ? 'Orchestra warning' : 'Orchestra notification', { body: 'Open Orchestra Canvas to review the new event.', tag: `fleet-${item.id}` });
        notice.onclick = () => { window.focus(); navigate('integrations'); notice.close(); };
      }
    }
  }, [snapshot]);

  if (!window.fleetDesktop && !snapshot && !loading && error) return <BrowserConnectionGate error={error} connect={connectBrowser} />;

  return <div className={`app-shell${macDesktop ? ' app-shell--mac' : ''}${sidebarOpen ? ' sidebar-open' : ''}`}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Command size={19} /></div><div><strong>Orchestra</strong><span>Canvas</span></div></div><nav>{navItems.map(({ id, label, icon: Icon, ...item }) => <div className="nav-entry" key={id}>{'group' in item && item.group && <span className="nav-label">{item.group}</span>}<button className={page === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={17} /><span>{label}</span>{id === 'jobs' && Boolean(snapshot?.jobs.filter((job) => ['running', 'queued', 'dispatching'].includes(job.status)).length) && <i>{snapshot?.jobs.filter((job) => ['running', 'queued', 'dispatching'].includes(job.status)).length}</i>}{id === 'telemetry' && Boolean(snapshot?.v2.alerts.filter((alert) => alert.status === 'open').length) && <i className="warning-count">{snapshot?.v2.alerts.filter((alert) => alert.status === 'open').length}</i>}</button></div>)}</nav><div className="sidebar-footer"><div className="core-state"><span className={`connection-pulse ${connected ? 'online' : ''}`} /><div><strong>{connected ? 'Core connected' : 'Core reconnecting'}</strong><span>{snapshot?.settings.coreUrl ?? 'Loading endpoint…'}</span></div></div><div className="fleet-version">Orchestra desktop <span>v{snapshot?.version ?? '0.1.0'}</span></div></div></aside>
    {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
    <main className="workspace"><header className="topbar"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)}>{sidebarOpen ? <X size={18} /> : <Menu size={18} />}</button><div className="breadcrumbs"><span>{snapshot?.settings.fleetName ?? 'Orchestra Canvas'}</span><i>/</i><strong>{navItems.find((item) => item.id === page)?.label}</strong></div><div className="fleet-summary"><span><i className="summary-dot online" />{snapshot?.devices.filter((device) => device.status !== 'offline').length ?? 0} online</span><span><i className="summary-dot running" />{snapshot?.jobs.filter((job) => job.status === 'running').length ?? 0} running</span></div><button className="icon-button" onClick={() => void refresh()} title="Refresh snapshot"><RefreshCcw size={16} className={loading ? 'spin' : ''} /></button><button className="avatar" aria-label="User menu">NH</button></header>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
      <div className="page-host">{loading && !snapshot ? <LoadingView /> : <>{page === 'overview' && <OverviewPage navigate={(next) => navigate(next as Page)} selectDevice={selectDevice} openPreview={openProjectPreview} openCodex={(deviceId, sessionId) => selectDevice(deviceId, 'codex', sessionId)} />}{page === 'system' && <SystemPage onOpenDevice={(deviceId) => selectDevice(deviceId)} onOpenCodex={(deviceId, sessionId) => selectDevice(deviceId, 'codex', sessionId)} />}{page === 'canvas' && <CanvasPage selectedId={selectedId} onSelect={(id) => { setSelectedSessionTarget(undefined); setSelectedId(id); }} />}{page === 'projects' && <ProjectsPage onOpenCodex={(deviceId, sessionId) => selectDevice(deviceId, 'codex', sessionId)} />}{page === 'jobs' && <JobsPage key={openEntity ? `job-${openEntity.sequence}` : 'jobs'} initialInspectedId={openEntity?.id} onSelectDevice={selectDevice} />}{page === 'pipelines' && <PipelinesPage />}{page === 'artifacts' && <ArtifactsPage />}{page === 'telemetry' && <TelemetryPage />}{page === 'automation' && <AutomationPage selectDevice={selectDevice} />}{page === 'security' && <SecurityPage />}{page === 'teams' && <TeamsPage selectDevice={selectDevice} />}{page === 'integrations' && <IntegrationsPage />}{page === 'diagnostics' && <DiagnosticsPage />}{page === 'activity' && <ActivityPage />}{page === 'settings' && <SettingsPage />}</>}</div>
      {snapshot && <MobileDock page={page} navigate={navigate} approvals={snapshot.sessions.reduce((sum, session) => sum + session.pendingApprovals.length, 0)} alerts={snapshot.v2.alerts.filter((alert) => alert.status === 'open').length} onApproval={() => { const session = snapshot.sessions.find((item) => item.pendingApprovals.length); if (session) selectDevice(session.deviceId, 'codex'); }} />}
    </main>
    {selected && <DeviceInspector device={selected} initialTab={selectedInspectorTab} initialCodexSessionTarget={selectedSessionTarget} onClose={() => { setSelectedId(null); setSelectedSessionTarget(undefined); void window.fleetDesktop?.codexMicro.setActiveSession(null); }} />}
  </div>;
}

function deepLinkInspectorTab(tab?: string): InspectorTab | undefined {
  if (tab === 'codex' || tab === 'terminal' || tab === 'desktop' || tab === 'jobs' || tab === 'overview') return tab;
  if (tab === 'metrics' || tab === 'files') return 'overview';
  if (tab === 'logs') return 'jobs';
  return undefined;
}

function BrowserConnectionGate({ error, connect }: { error: string; connect(coreUrl: string, token: string): Promise<void> }) {
  const [coreUrl, setCoreUrl] = useState(browserConnectionDefaults().coreUrl);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setConnecting(true);
    try { await connect(coreUrl, token); } finally { setConnecting(false); }
  }
  return <main className="connection-gate"><section className="connection-gate__card"><div className="connection-gate__mark"><Command size={24} /></div><span className="eyebrow">Orchestra Canvas V2</span><h1>Connect to Orchestra Core</h1><p>Enter the private Core address and a scoped API or recovery token. The browser keeps the token in memory only.</p><form onSubmit={submit}><label><span><Server size={14} />Core URL</span><input type="url" required value={coreUrl} onChange={(event) => setCoreUrl(event.target.value)} placeholder="https://orchestra-core.tailnet.ts.net" /></label><label><span><KeyRound size={14} />Access token</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Scoped API token" /></label><div className="connection-gate__error">{error}</div><button className="primary-button" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect securely'}</button></form><footer><ShieldCheck size={15} /><span>Use HTTPS and a least-privilege API token for remote access.</span></footer></section></main>;
}

function LoadingView() { return <div className="loading-view"><div className="loading-logo"><Boxes size={25} /></div><h2>Connecting to Orchestra Core</h2><p>Loading devices, projects, jobs, and active sessions…</p><div className="loading-bar"><i /></div></div>; }

function MobileDock({ page, navigate, approvals, alerts, onApproval }: { page: Page; navigate(page: Page): void; approvals: number; alerts: number; onApproval(): void }) { return <nav className="mobile-dock" aria-label="Quick actions"><button className={page === 'overview' ? 'active' : ''} onClick={() => navigate('overview')}><Gauge size={18} /><span>Mission</span></button><button className={page === 'system' ? 'active' : ''} onClick={() => navigate('system')}><MessageSquare size={18} /><span>System</span></button><button className={page === 'canvas' ? 'active' : ''} onClick={() => navigate('canvas')}><LayoutDashboard size={18} /><span>Orchestra</span></button>{approvals > 0 ? <button className="mobile-approval" onClick={onApproval}><Bot size={19} /><i>{approvals}</i><span>Approve</span></button> : <button className={page === 'jobs' ? 'active' : ''} onClick={() => navigate('jobs')}><Box size={18} /><span>Jobs</span></button>}<button className={page === 'telemetry' ? 'active' : ''} onClick={() => navigate('telemetry')}><BellRing size={18} />{alerts > 0 && <i>{alerts}</i>}<span>Alerts</span></button></nav>; }
