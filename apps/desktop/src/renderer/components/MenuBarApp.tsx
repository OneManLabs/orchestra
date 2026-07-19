import type {
  CodexSession,
  FleetProject,
  FleetSnapshot,
  MenuBarAlert,
  MenuBarApproval,
  MenuBarDevice,
  MenuBarJob,
  MenuBarRecentItem,
  MenuBarSnapshot,
  PermissionMode
} from '@fleet/shared';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Command,
  Cpu,
  ExternalLink,
  Gauge,
  HardDrive,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  MemoryStick,
  MonitorUp,
  Moon,
  Network,
  Play,
  Power,
  RefreshCcw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Thermometer,
  Wifi,
  X,
  Zap
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiV2, request } from '../lib/api';
import { formatBytes, relativeTime, titleCase } from '../lib/format';
import {
  approvalNeedsReview,
  bestCodexDevice,
  canPowerDevice,
  codexApprovalDecision,
  isDeviceInteractive,
  jobProgress,
  parseMenuBarSnapshot
} from '../lib/menu-bar-state';
import './MenuBarApp.css';

type MainTarget = { page?: string; deviceId?: string; tab?: string; jobId?: string; sessionId?: string; alertId?: string; entityId?: string };
type ExitNodeState = { available: boolean; connected: boolean; selectedId?: string; selectedName?: string; allowLan: boolean; backendState?: string; error?: string; options?: Array<{ id: string; name: string; online: boolean; addresses: string[] }> };
type MenuBarDesktopState = {
  snapshot: MenuBarSnapshot | null;
  connected: boolean;
  quietMode: 'normal' | 'quiet';
  launchAtLogin: boolean;
  exitNode?: ExitNodeState;
  lastUpdatedAt?: string;
  error?: string;
};
type MenuBarBridge = {
  getState(): Promise<MenuBarDesktopState>;
  refresh(): Promise<MenuBarDesktopState>;
  onState(listener: (state: MenuBarDesktopState) => void): () => void;
  openMain?(target?: MainTarget): Promise<void>;
  openFullApp(target?: MainTarget): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  getQuietMode(): Promise<'normal' | 'quiet'>;
  setQuietMode(mode: 'normal' | 'quiet'): Promise<'normal' | 'quiet'>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  getExitNodeStatus(): Promise<ExitNodeState>;
  setExitNode(input: { id: string | null; allowLan?: boolean }): Promise<ExitNodeState>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
};

type Panel = 'codex' | 'wake' | 'terminal' | 'exit-node' | null;
type PowerConfirmation = { device: MenuBarDevice; action: 'sleep' | 'restart' | 'shutdown' };

export function MenuBarApp() {
  const bridge = menuBarBridge();
  const [snapshot, setSnapshot] = useState<MenuBarSnapshot | null>(null);
  const [fullSnapshot, setFullSnapshot] = useState<FleetSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [quietMode, setQuietMode] = useState<'normal' | 'quiet'>('normal');
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [exitNode, setExitNode] = useState<ExitNodeState>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [panel, setPanel] = useState<Panel>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [confirmation, setConfirmation] = useState<PowerConfirmation>();
  const [query, setQuery] = useState('');
  const [pendingAction, setPendingAction] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const fullSnapshotLoadedAt = useRef(0);
  const fullSnapshotRequest = useRef<Promise<FleetSnapshot> | null>(null);

  const applyState = useCallback((state: MenuBarDesktopState) => {
    setConnected(state.connected);
    setQuietMode(state.quietMode);
    setLaunchAtLogin(state.launchAtLogin);
    setExitNode(state.exitNode);
    setError(state.error);
    if (state.snapshot) setSnapshot(parseMenuBarSnapshot(state.snapshot));
    setLoading(false);
  }, []);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      if (bridge) {
        applyState(await bridge.refresh());
      } else {
        const compact = parseMenuBarSnapshot(await request<unknown>('/api/v2/menu-bar'));
        setSnapshot(compact);
        setConnected(true);
        setError(undefined);
        setLoading(false);
      }
    } catch (cause) {
      setConnected(false);
      setError(errorMessage(cause));
      setLoading(false);
    } finally { setRefreshing(false); }
  }, [applyState, bridge]);

  const loadFullSnapshot = useCallback(async (force = false) => {
    if (!force && fullSnapshot && Date.now() - fullSnapshotLoadedAt.current < 60_000) return fullSnapshot;
    if (fullSnapshotRequest.current) return fullSnapshotRequest.current;
    const pending = api.snapshot();
    fullSnapshotRequest.current = pending;
    try {
      const next = await pending;
      setFullSnapshot(next);
      fullSnapshotLoadedAt.current = Date.now();
      return next;
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally { fullSnapshotRequest.current = null; }
  }, [fullSnapshot]);

  useEffect(() => {
    let active = true;
    const unsubscribe = bridge?.onState((state) => { if (active) { try { applyState(state); } catch (cause) { setError(errorMessage(cause)); } } });
    void (async () => {
      try {
        if (bridge) applyState(await bridge.getState());
        await refresh();
      } catch (cause) { if (active) { setError(errorMessage(cause)); setLoading(false); } }
    })();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5_000);
    return () => { active = false; unsubscribe?.(); window.clearInterval(timer); };
  }, [applyState, bridge, refresh]);

  useEffect(() => {
    if (panel === 'codex' || query.trim()) void loadFullSnapshot().catch(() => undefined);
  }, [loadFullSnapshot, panel, query]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (confirmation) setConfirmation(undefined);
        else if (panel) setPanel(null);
        else if (query) setQuery('');
        else void bridge?.hide();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [bridge, confirmation, panel, query]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 2_800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openMain = useCallback(async (target?: MainTarget) => {
    if (!bridge) return;
    if (bridge.openMain) await bridge.openMain(target ? {
      ...(target.page ? { page: target.page } : {}),
      ...(target.deviceId ? { deviceId: target.deviceId } : {}),
      ...(target.tab ? { tab: target.tab } : {}),
      ...((target.entityId ?? target.jobId ?? target.sessionId ?? target.alertId) ? { entityId: target.entityId ?? target.jobId ?? target.sessionId ?? target.alertId } : {})
    } : undefined);
    else await bridge.openFullApp(target);
  }, [bridge]);

  const act = useCallback(async (key: string, action: () => Promise<unknown>, success?: string) => {
    setPendingAction(key); setError(undefined);
    try {
      await action();
      if (success) setToast(success);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPendingAction(undefined); }
  }, [refresh]);

  const selectedDevice = snapshot?.devices.find((device) => device.id === selectedDeviceId);
  const palette = useMemo(() => commandResults(query, snapshot, fullSnapshot), [fullSnapshot, query, snapshot]);

  async function runPaletteItem(item: CommandResult) {
    setQuery('');
    if (item.kind === 'device') { setSelectedDeviceId(item.id); return; }
    if (item.kind === 'job') { await openMain({ page: 'jobs', jobId: item.id }); return; }
    if (item.kind === 'project') { setPanel('codex'); return; }
    if (item.id === 'new-codex') setPanel('codex');
    else if (item.id === 'wake') setPanel('wake');
    else if (item.id === 'terminal') setPanel('terminal');
    else if (item.id === 'exit-node') setPanel('exit-node');
    else if (item.id === 'quiet') await toggleQuiet();
    else await openMain({ page: item.id });
  }

  async function toggleQuiet() {
    if (!bridge) return;
    const next = quietMode === 'normal' ? 'quiet' : 'normal';
    await act('quiet', async () => setQuietMode(await bridge.setQuietMode(next)), next === 'quiet' ? 'Quiet mode enabled' : 'Notifications restored');
  }

  if (loading && !snapshot) return <MenuFrame><MenuLoading /></MenuFrame>;

  if (panel) return <MenuFrame><div className="mb-panel-host"><PanelView panel={panel} snapshot={snapshot} fullSnapshot={fullSnapshot} exitNode={exitNode} pendingAction={pendingAction} onBack={() => setPanel(null)} onOpenMain={openMain} onAction={act} onExitNode={setExitNode} />{error && <div className="mb-panel-error" role="alert"><AlertTriangle size={13} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={12} /></button></div>}</div></MenuFrame>;

  if (!snapshot) return <MenuFrame><ConnectionError message={error ?? 'Orchestra Core is unavailable.'} retry={() => void refresh(true)} refreshing={refreshing} open={() => void openMain({ page: 'settings' })} /></MenuFrame>;

  return <MenuFrame>
    <div className="mb-shell">
      <header className={`mb-hero mb-hero--${connected ? snapshot.summary.status : 'offline'}`}>
        <button className="mb-hero__main" onClick={() => void openMain({ page: 'overview' })} aria-label="Open Orchestra Canvas overview">
          <span className="mb-brand-mark"><Command size={17} /></span>
          <span className="mb-hero__copy"><strong>{snapshot.core.fleetName}</strong><small>{healthHeadline(snapshot, connected)}</small></span>
          <span className={`mb-health mb-health--${connected ? snapshot.summary.status : 'offline'}`}>{connected ? titleCase(snapshot.summary.status) : 'Disconnected'}</span>
          <ChevronRight size={15} />
        </button>
        <div className="mb-hero__stats" aria-label="Orchestra summary">
          <span><i className="mb-dot mb-dot--online" />{snapshot.summary.onlineDevices} online</span>
          {snapshot.summary.sleepingDevices > 0 && <span><Moon size={11} />{snapshot.summary.sleepingDevices} sleeping</span>}
          <span><Zap size={11} />{snapshot.summary.activeJobs} active</span>
          {(snapshot.summary.pendingApprovals > 0 || snapshot.summary.openCriticalAlerts > 0) && <span className="attention"><ShieldAlert size={11} />{snapshot.summary.pendingApprovals + snapshot.summary.openCriticalAlerts} attention</span>}
          <button className="mb-icon-button" onClick={() => void refresh(true)} disabled={refreshing} aria-label="Refresh fleet"><RefreshCcw size={13} className={refreshing ? 'spin' : ''} /></button>
        </div>
      </header>

      <div className="mb-search-wrap">
        <Search size={14} />
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && palette[0]) void runPaletteItem(palette[0]); }} placeholder="Search devices, jobs, projects, or actions…" aria-label="Orchestra command palette" />
        {query ? <button onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button> : <kbd>⌘K</kbd>}
      </div>

      {query ? <CommandPalette query={query} results={palette} run={(item) => void runPaletteItem(item)} /> : <div className="mb-scroll">
        {error && <div className="mb-inline-error" role="alert"><AlertTriangle size={14} /><span>{error}</span><button onClick={() => void refresh(true)}>Retry</button></div>}

        <QuickStrip codex={() => setPanel('codex')} wake={() => setPanel('wake')} terminal={() => setPanel('terminal')} canvas={() => void openMain({ page: 'canvas' })} />

        <MenuSection title="Priority jobs" count={snapshot.jobs.length} action={snapshot.jobs.length ? <button onClick={() => void openMain({ page: 'jobs' })}>View all</button> : undefined}>
          {snapshot.jobs.length ? <div className="mb-list">{snapshot.jobs.map((job) => <JobRow key={job.id} job={job} pending={pendingAction === `job:${job.id}`} view={() => void openMain({ page: 'jobs', jobId: job.id })} cancel={() => void act(`job:${job.id}`, () => api.cancelJob(job.id), `${job.name} cancelled`)} />)}</div> : <InlineEmpty icon={<Check size={15} />} title="No active work" detail="Your fleet is ready for its next job." />}
        </MenuSection>

        <MenuSection title="Devices" count={snapshot.summary.totalDevices} action={<button onClick={() => void openMain({ page: 'canvas' })}>Canvas</button>}>
          <div className="mb-list">{snapshot.devices.map((device) => <DeviceRow key={device.id} device={device} expanded={selectedDeviceId === device.id} pending={pendingAction?.startsWith(`device:${device.id}:`) ?? false} toggle={() => setSelectedDeviceId(selectedDeviceId === device.id ? undefined : device.id)} openMain={openMain} wake={() => void act(`device:${device.id}:wake`, () => apiV2.powerDevices([device.id], 'wake'), `Wake request sent to ${device.name}`)} confirm={(action) => setConfirmation({ device, action })} />)}</div>
        </MenuSection>

        {snapshot.approvals.length > 0 && <MenuSection title="Approvals" count={snapshot.approvals.length} attention>
          <div className="mb-list">{snapshot.approvals.map((approval) => <ApprovalRow key={approval.id} approval={approval} pending={pendingAction === `approval:${approval.id}`} review={() => void openMain(approval.kind === 'codex' ? { page: 'canvas', deviceId: approval.deviceId, tab: 'codex', sessionId: approval.sessionId } : { page: 'pipelines', entityId: approval.pipelineRunId })} respond={(accepted) => void act(`approval:${approval.id}`, () => respondToApproval(approval, accepted), accepted ? 'Approval granted once' : 'Request declined')} />)}</div>
        </MenuSection>}

        {snapshot.alerts.length > 0 && <MenuSection title="Alerts" count={snapshot.alerts.length} attention>
          <div className="mb-list">{snapshot.alerts.slice(0, 4).map((alert) => <AlertRow key={alert.id} alert={alert} pending={pendingAction === `alert:${alert.id}`} open={() => void openAlert(alert, openMain)} acknowledge={() => void act(`alert:${alert.id}`, () => apiV2.alertAction(alert.id, 'acknowledge'), 'Alert acknowledged')} wake={alert.deviceId && snapshot.devices.find((device) => device.id === alert.deviceId && canPowerDevice(device, 'wake')) ? () => void act(`alert:${alert.id}`, () => apiV2.powerDevices([alert.deviceId!], 'wake'), 'Wake request sent') : undefined} />)}</div>
        </MenuSection>}

        <ExitNodeCard state={exitNode} open={() => setPanel('exit-node')} />

        <MenuSection title="Recent" count={snapshot.recent.length}>
          {snapshot.recent.length ? <div className="mb-recent">{snapshot.recent.slice(0, 5).map((item) => <RecentRow key={item.id} item={item} open={() => void openRecent(item, openMain)} />)}</div> : <InlineEmpty icon={<Clock3 size={15} />} title="No recent activity" detail="Completed work and fleet events appear here." />}
        </MenuSection>
      </div>}

      <footer className="mb-footer">
        <button className={quietMode === 'quiet' ? 'active' : ''} disabled={!bridge || pendingAction === 'quiet'} onClick={() => void toggleQuiet()}><Moon size={13} />{quietMode === 'quiet' ? 'Quiet' : 'Normal'}</button>
        <label className="mb-login-toggle" title="Launch Orchestra Canvas at login"><input type="checkbox" checked={launchAtLogin} disabled={!bridge || pendingAction === 'login'} onChange={(event) => { const checked = event.target.checked; void act('login', async () => setLaunchAtLogin(await bridge!.setLaunchAtLogin(checked)), checked ? 'Launch at login enabled' : 'Launch at login disabled'); }} /><span />Login</label>
        <button onClick={() => void openMain({ page: 'settings' })}><Settings2 size={13} />Settings</button>
        <button className="mb-footer__open" onClick={() => void openMain()}><Maximize2 size={13} />Open</button>
        <button onClick={() => void bridge?.quit()} disabled={!bridge} title="Quit Orchestra Canvas"><Power size={13} /><span className="sr-only">Quit</span></button>
      </footer>

      {toast && <div className="mb-toast" role="status"><Check size={13} />{toast}</div>}
      {confirmation && <Confirmation device={confirmation.device} action={confirmation.action} pending={pendingAction === `device:${confirmation.device.id}:${confirmation.action}`} cancel={() => setConfirmation(undefined)} confirm={() => void act(`device:${confirmation.device.id}:${confirmation.action}`, () => apiV2.powerDevices([confirmation.device.id], confirmation.action), `${titleCase(confirmation.action)} request sent`).then(() => setConfirmation(undefined))} />}
    </div>
  </MenuFrame>;
}

function MenuFrame({ children }: { children: ReactNode }) { return <main className="menu-bar-root">{children}</main>; }

function MenuLoading() { return <div className="mb-loading"><span className="mb-brand-mark"><Command size={19} /></span><LoaderCircle size={18} className="spin" /><strong>Connecting to Orchestra Core</strong><small>Loading live fleet state…</small></div>; }

function ConnectionError({ message, retry, refreshing, open }: { message: string; retry(): void; refreshing: boolean; open(): void }) {
  return <div className="mb-disconnected"><span><Network size={21} /></span><h1>Orchestra Core disconnected</h1><p>{message}</p><button className="mb-primary" onClick={retry} disabled={refreshing}>{refreshing ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}Reconnect</button><button className="mb-secondary" onClick={open}>Open connection settings</button></div>;
}

function QuickStrip({ codex, wake, terminal, canvas }: { codex(): void; wake(): void; terminal(): void; canvas(): void }) {
  return <section className="mb-quick-strip" aria-label="Quick actions"><button onClick={codex}><span><Sparkles size={15} /></span><strong>New Codex</strong></button><button onClick={wake}><span><Power size={15} /></span><strong>Wake</strong></button><button onClick={terminal}><span><SquareTerminal size={15} /></span><strong>Terminal</strong></button><button onClick={canvas}><span><Gauge size={15} /></span><strong>Canvas</strong></button></section>;
}

function MenuSection({ title, count, action, attention, children }: { title: string; count?: number; action?: ReactNode; attention?: boolean; children: ReactNode }) {
  return <section className={`mb-section${attention ? ' mb-section--attention' : ''}`}><header><h2>{title}</h2>{typeof count === 'number' && count > 0 && <span>{count}</span>}<div>{action}</div></header>{children}</section>;
}

function InlineEmpty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="mb-empty"><span>{icon}</span><div><strong>{title}</strong><small>{detail}</small></div></div>; }

function JobRow({ job, pending, view, cancel }: { job: MenuBarJob; pending: boolean; view(): void; cancel(): void }) {
  const progress = jobProgress(job);
  const active = ['queued', 'dispatching', 'running', 'awaiting-approval'].includes(job.status);
  return <article className={`mb-job mb-job--${job.status}`}>
    <button className="mb-row-main" onClick={view}>
      <span className="mb-job__icon">{job.kind === 'codex' ? <Bot size={14} /> : <SquareTerminal size={14} />}</span>
      <span><strong>{job.name}</strong><small>{job.deviceName ?? 'Waiting for a device'}{job.phase ? ` · ${job.phase}` : ''}</small></span>
      <span className="mb-job__state">{progress !== undefined ? `${Math.round(progress)}%` : titleCase(job.status)}</span>
    </button>
    {progress !== undefined && <div className="mb-progress" aria-label={`${Math.round(progress)} percent complete`}><i style={{ width: `${progress}%` }} /></div>}
    <div className="mb-row-actions"><button onClick={view}><ExternalLink size={12} />View</button>{active && <button onClick={cancel} disabled={pending}>{pending ? <LoaderCircle size={12} className="spin" /> : <CircleStop size={12} />}Cancel</button>}</div>
  </article>;
}

function DeviceRow({ device, expanded, pending, toggle, openMain, wake, confirm }: { device: MenuBarDevice; expanded: boolean; pending: boolean; toggle(): void; openMain(target?: MainTarget): Promise<void>; wake(): void; confirm(action: 'sleep' | 'restart' | 'shutdown'): void }) {
  const gpu = device.metrics.gpuPercent;
  const secondary = device.status === 'sleeping' ? 'Sleeping' : device.status === 'offline' ? `Last seen ${relativeTime(device.lastSeenAt)}` : device.activeJobCount ? `${device.activeJobCount} active job${device.activeJobCount === 1 ? '' : 's'}` : device.role === 'storage' && device.metrics.storageMaxPercent !== undefined ? `${Math.round(device.metrics.storageMaxPercent)}% storage` : `RAM ${Math.round(device.metrics.memoryPercent)}%`;
  return <article className={`mb-device${expanded ? ' expanded' : ''}`}>
    <button className="mb-device__row" onClick={toggle} aria-expanded={expanded}>
      <i className={`mb-device-dot mb-device-dot--${device.status}`} />
      <span><strong>{device.name}</strong><small>{titleCase(device.role)}</small></span>
      <span className="mb-device__summary">{secondary}</span>
      <ChevronDown size={13} />
    </button>
    {expanded && <div className="mb-device__detail">
      <div className="mb-mini-metrics">
        <Metric icon={<Cpu size={12} />} label="CPU" value={`${Math.round(device.metrics.cpuPercent)}%`} />
        <Metric icon={<MemoryStick size={12} />} label="RAM" value={`${Math.round(device.metrics.memoryPercent)}%`} />
        {gpu !== undefined && <Metric icon={<Activity size={12} />} label="GPU" value={`${Math.round(gpu)}%`} />}
        {device.metrics.temperatureCelsius !== undefined && <Metric icon={<Thermometer size={12} />} label="Temp" value={`${Math.round(device.metrics.temperatureCelsius)}°`} warning={device.metrics.temperatureCelsius >= 80} />}
      </div>
      <div className="mb-device-actions">
        <button disabled={!device.capabilities.codex || !isDeviceInteractive(device)} onClick={() => void openMain({ page: 'canvas', deviceId: device.id, tab: 'codex' })}><Bot size={13} />Codex</button>
        <button disabled={!isDeviceInteractive(device)} onClick={() => void openMain({ page: 'canvas', deviceId: device.id, tab: 'terminal' })}><SquareTerminal size={13} />Terminal</button>
        <button disabled={!isDeviceInteractive(device)} onClick={() => void openMain({ page: 'canvas', deviceId: device.id, tab: 'desktop' })}><MonitorUp size={13} />Desktop</button>
        <button onClick={() => void openMain({ page: 'telemetry', deviceId: device.id })}><Activity size={13} />Metrics</button>
      </div>
      <div className="mb-power-actions">
        {canPowerDevice(device, 'wake') && <button onClick={wake} disabled={pending}><Power size={12} />Wake</button>}
        {canPowerDevice(device, 'sleep') && <button onClick={() => confirm('sleep')}><Moon size={12} />Sleep</button>}
        {canPowerDevice(device, 'restart') && <button onClick={() => confirm('restart')}><RotateCcw size={12} />Restart</button>}
        {canPowerDevice(device, 'shutdown') && <button className="danger" onClick={() => confirm('shutdown')}><Power size={12} />Shut down</button>}
      </div>
    </div>}
  </article>;
}

function Metric({ icon, label, value, warning }: { icon: ReactNode; label: string; value: string; warning?: boolean }) { return <div className={warning ? 'warning' : ''}>{icon}<span>{label}</span><strong>{value}</strong></div>; }

function ApprovalRow({ approval, pending, review, respond }: { approval: MenuBarApproval; pending: boolean; review(): void; respond(accepted: boolean): void }) {
  const reviewOnly = approvalNeedsReview(approval);
  return <article className={`mb-approval${reviewOnly ? ' high-risk' : ''}`}>
    <div className="mb-approval__head"><span>{reviewOnly ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}</span><div><strong>{approval.title}</strong><small>{approval.deviceName ?? (approval.kind === 'pipeline' ? approval.pipelineName ?? 'Pipeline gate' : 'Codex approval')}</small></div><time>{relativeTime(approval.createdAt)}</time></div>
    <p>{approval.detail}</p>
    <div className="mb-approval__actions"><button onClick={() => respond(false)} disabled={pending}>Decline</button>{reviewOnly ? <button className="review" onClick={review}>Review safely <ChevronRight size={12} /></button> : <><button className="review" onClick={review}>Review</button><button className="approve" onClick={() => respond(true)} disabled={pending}>{pending ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}Approve once</button></>}</div>
  </article>;
}

function AlertRow({ alert, pending, open, acknowledge, wake }: { alert: MenuBarAlert; pending: boolean; open(): void; acknowledge(): void; wake?: () => void }) {
  return <article className={`mb-alert mb-alert--${alert.severity}`}><span><AlertTriangle size={14} /></span><div><strong>{alert.title}</strong><p>{alert.detail}</p><small>{alert.deviceName ?? alert.jobName ?? 'Orchestra'} · {relativeTime(alert.openedAt)}</small><div>{wake && <button onClick={wake}><Power size={11} />Wake</button>}<button onClick={open}>Open</button>{alert.status === 'open' && <button onClick={acknowledge} disabled={pending}>Acknowledge</button>}</div></div></article>;
}

function ExitNodeCard({ state, open }: { state?: ExitNodeState; open(): void }) {
  return <button className="mb-exit-card" onClick={open}><span className={state?.connected ? 'connected' : ''}><Wifi size={14} /></span><div><small>Network route</small><strong>{state?.connected ? state.selectedName ?? 'Exit node connected' : 'Direct internet'}</strong></div><span>{state?.connected ? state.backendState ?? 'Connected' : state?.available === false ? 'Tailscale unavailable' : 'Not routed'}</span><ChevronRight size={13} /></button>;
}

function RecentRow({ item, open }: { item: MenuBarRecentItem; open(): void }) {
  const icon = item.severity === 'success' ? <Check size={11} /> : item.severity === 'error' ? <X size={11} /> : item.severity === 'warning' ? <AlertTriangle size={11} /> : <Activity size={11} />;
  return <button className={`mb-recent-row mb-recent-row--${item.severity}`} onClick={open}><span>{icon}</span><div><strong>{item.title}</strong><small>{item.deviceName ? `${item.deviceName} · ` : ''}{relativeTime(item.at)}</small></div><ChevronRight size={12} /></button>;
}

function CommandPalette({ query, results, run }: { query: string; results: CommandResult[]; run(item: CommandResult): void }) {
  return <div className="mb-command-results"><header><span>Results for “{query}”</span><small>↵ Open</small></header>{results.length ? results.map((item, index) => <button key={`${item.kind}:${item.id}`} className={index === 0 ? 'selected' : ''} onClick={() => run(item)}><span>{commandIcon(item)}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div><em>{titleCase(item.kind)}</em><ChevronRight size={12} /></button>) : <InlineEmpty icon={<Search size={15} />} title="No matching fleet item" detail="Try a device, job, project, or action." />}</div>;
}

function PanelView({ panel, snapshot, fullSnapshot, exitNode, pendingAction, onBack, onOpenMain, onAction, onExitNode }: { panel: Exclude<Panel, null>; snapshot: MenuBarSnapshot | null; fullSnapshot: FleetSnapshot | null; exitNode?: ExitNodeState; pendingAction?: string; onBack(): void; onOpenMain(target?: MainTarget): Promise<void>; onAction(key: string, action: () => Promise<unknown>, success?: string): Promise<void>; onExitNode(state: ExitNodeState): void }) {
  if (!snapshot) return <ConnectionError message="Orchestra Core is unavailable." retry={() => location.reload()} refreshing={false} open={() => void onOpenMain({ page: 'settings' })} />;
  if (panel === 'codex') return <CodexLauncher compact={snapshot} full={fullSnapshot} pending={pendingAction === 'new-codex'} back={onBack} action={onAction} open={onOpenMain} />;
  if (panel === 'wake') return <DevicePicker title="Wake a device" detail="Wake-on-LAN is sent through the configured Orchestra relay." icon={<Power size={17} />} devices={snapshot.devices.filter((device) => canPowerDevice(device, 'wake'))} empty="No sleeping device has a configured Wake-on-LAN route." pending={pendingAction} back={onBack} choose={(device) => void onAction(`device:${device.id}:wake`, () => apiV2.powerDevices([device.id], 'wake'), `Wake request sent to ${device.name}`)} />;
  if (panel === 'terminal') return <DevicePicker title="Open terminal" detail="Choose a live device. The full terminal opens in Orchestra Canvas." icon={<SquareTerminal size={17} />} devices={snapshot.devices.filter(isDeviceInteractive)} empty="No interactive devices are online." pending={pendingAction} back={onBack} choose={(device) => void onOpenMain({ page: 'canvas', deviceId: device.id, tab: 'terminal' })} />;
  return <ExitNodePanel state={exitNode} pending={pendingAction === 'exit-node'} back={onBack} change={async (id, allowLan) => onAction('exit-node', async () => { const bridge = menuBarBridge(); if (!bridge) throw new Error('Exit-node control is available only in the macOS app.'); onExitNode(await bridge.setExitNode({ id, allowLan })); }, id ? 'Exit node connected' : 'Direct internet restored')} />;
}

function PanelHeader({ icon, eyebrow, title, detail, back }: { icon: ReactNode; eyebrow: string; title: string; detail: string; back(): void }) { return <header className="mb-panel-header"><button onClick={back} aria-label="Back"><ArrowLeft size={15} /></button><span>{icon}</span><div><small>{eyebrow}</small><h1>{title}</h1><p>{detail}</p></div></header>; }

function DevicePicker({ title, detail, icon, devices, empty, pending, back, choose }: { title: string; detail: string; icon: ReactNode; devices: MenuBarDevice[]; empty: string; pending?: string; back(): void; choose(device: MenuBarDevice): void }) {
  return <div className="mb-panel"><PanelHeader icon={icon} eyebrow="Quick action" title={title} detail={detail} back={back} /><div className="mb-panel-scroll">{devices.length ? <div className="mb-picker-list">{devices.map((device) => <button key={device.id} disabled={pending === `device:${device.id}:wake`} onClick={() => choose(device)}><i className={`mb-device-dot mb-device-dot--${device.status}`} /><span><strong>{device.name}</strong><small>{titleCase(device.role)} · {titleCase(device.status)}</small></span>{pending === `device:${device.id}:wake` ? <LoaderCircle size={14} className="spin" /> : <ChevronRight size={14} />}</button>)}</div> : <InlineEmpty icon={<Power size={15} />} title="Nothing to wake" detail={empty} />}</div></div>;
}

function CodexLauncher({ compact, full, pending, back, action, open }: { compact: MenuBarSnapshot; full: FleetSnapshot | null; pending: boolean; back(): void; action(key: string, action: () => Promise<unknown>, success?: string): Promise<void>; open(target?: MainTarget): Promise<void> }) {
  const readyDevices = compact.devices.filter((device) => device.capabilities.codex && isDeviceInteractive(device));
  const [deviceId, setDeviceId] = useState('auto');
  const [projectId, setProjectId] = useState('');
  const [cwd, setCwd] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('workspace-write');
  const [prompt, setPrompt] = useState('');
  const [launchError, setLaunchError] = useState<string>();
  const projects = full?.projects ?? [];
  const selectedProject = projects.find((project) => project.id === projectId);
  const projectDeviceIds = selectedProject?.paths.map((path) => path.deviceId) ?? [];
  const selectedDevice = deviceId === 'auto' ? bestCodexDevice(readyDevices, projectDeviceIds) : readyDevices.find((device) => device.id === deviceId);
  const mappedPath = selectedProject?.paths.find((path) => path.deviceId === selectedDevice?.id)?.path;
  const rootPath = full?.devices.find((device) => device.id === selectedDevice?.id)?.projectRoots[0];
  const workingDirectory = cwd.trim() || mappedPath || rootPath || '';
  const availableProjects = projects.filter((project) => deviceId === 'auto' ? project.paths.some((path) => readyDevices.some((device) => device.id === path.deviceId)) : project.paths.some((path) => path.deviceId === deviceId));

  async function submit(event: FormEvent) {
    event.preventDefault(); setLaunchError(undefined);
    if (!selectedDevice) { setLaunchError('No online, authenticated Codex device is available.'); return; }
    if (!workingDirectory) { setLaunchError('Choose a mapped project or enter a working directory.'); return; }
    await action('new-codex', async () => {
      const session = await api.createSession({ deviceId: selectedDevice.id, projectId: projectId || undefined, cwd: workingDirectory, title: selectedProject ? `${selectedProject.name} session` : `Quick session on ${selectedDevice.name}`, permissionMode, approvalPolicy: 'on-request' });
      if (prompt.trim()) await sendWhenReady(session, prompt.trim());
      await open({ page: 'canvas', deviceId: selectedDevice.id, tab: 'codex', sessionId: session.id });
    });
  }

  return <div className="mb-panel"><PanelHeader icon={<Bot size={17} />} eyebrow="Codex quick launcher" title="New Codex session" detail="Run Codex directly on the best live device." back={back} /><form className="mb-launcher" onSubmit={submit}>
    <label>Device<select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setProjectId(''); }}><option value="auto">Automatic · least busy compatible</option>{readyDevices.map((device) => <option key={device.id} value={device.id}>{device.name} · {titleCase(device.status)}</option>)}</select></label>
    <label>Project<select value={projectId} onChange={(event) => { setProjectId(event.target.value); setCwd(''); }}><option value="">New working directory…</option>{availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    {!projectId && <label>Working directory<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={rootPath ?? '/path/to/workspace'} /></label>}
    {projectId && <div className="mb-mapped-path"><HardDrive size={13} /><span><small>Mapped workspace</small><strong>{mappedPath ?? 'Automatic device selection pending'}</strong></span></div>}
    <label>Permission<select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access · approvals still required</option></select></label>
    <label>What should Codex do?<textarea autoFocus rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Review the latest changes, run tests, and explain any failures…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }} /></label>
    <div className="mb-saved-prompts"><span>Quick prompts</span>{['Review recent changes', 'Run tests and fix failures', 'Summarize fleet health'].map((value) => <button type="button" key={value} onClick={() => setPrompt(value)}>{value}</button>)}</div>
    {(launchError || !readyDevices.length) && <div className="mb-form-error"><AlertTriangle size={13} />{launchError ?? 'No online device reports an authenticated Codex CLI.'}</div>}
    <button className="mb-primary" disabled={pending || !selectedDevice || !workingDirectory}>{pending ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{pending ? 'Starting session…' : 'Start and open'}<kbd>⌘↵</kbd></button>
  </form></div>;
}

function ExitNodePanel({ state, pending, back, change }: { state?: ExitNodeState; pending: boolean; back(): void; change(id: string | null, allowLan?: boolean): Promise<void> }) {
  const candidates = state?.options?.filter((option) => option.online) ?? [];
  const [allowLan, setAllowLan] = useState(state?.allowLan ?? true);
  return <div className="mb-panel"><PanelHeader icon={<Wifi size={17} />} eyebrow="Tailscale routing" title="Network route" detail="Choose how this Mac reaches the internet." back={back} /><div className="mb-panel-scroll"><div className="mb-route-status"><span className={state?.connected ? 'connected' : ''}><Network size={18} /></span><div><small>Current route</small><strong>{state?.connected ? state.selectedName ?? 'Orchestra exit node' : 'Direct internet'}</strong><p>{state?.error ?? (state?.available === false ? 'Tailscale CLI is unavailable on this Mac.' : state?.backendState ?? 'No exit node selected')}</p></div></div><div className="mb-picker-list routes"><button className={!state?.connected ? 'selected' : ''} disabled={pending} onClick={() => void change(null)}><span><Network size={14} /></span><span><strong>Direct internet</strong><small>Do not use an exit node</small></span>{!state?.connected && <Check size={14} />}</button>{candidates.map((option) => <button className={state?.selectedId === option.id ? 'selected' : ''} key={option.id} disabled={pending} onClick={() => void change(option.id, allowLan)}><span><Server size={14} /></span><span><strong>{option.name}</strong><small>{option.addresses[0] ?? 'Tailscale exit node'} · Online</small></span>{state?.selectedId === option.id ? <Check size={14} /> : <ChevronRight size={14} />}</button>)}</div><label className="mb-setting-row"><span><strong>Allow local network access</strong><small>Keep printers, NAS shares, and LAN services reachable.</small></span><input type="checkbox" checked={allowLan} onChange={(event) => { setAllowLan(event.target.checked); if (state?.selectedId) void change(state.selectedId, event.target.checked); }} /></label>{!candidates.length && <InlineEmpty icon={<Wifi size={15} />} title="No exit nodes reported" detail="Enable an exit node in Tailscale, then reopen this panel." />}</div></div>;
}

function Confirmation({ device, action, pending, cancel, confirm }: { device: MenuBarDevice; action: string; pending: boolean; cancel(): void; confirm(): void }) { return <div className="mb-modal" role="dialog" aria-modal="true" aria-labelledby="mb-confirm-title"><div><span className={action === 'shutdown' ? 'danger' : ''}>{action === 'sleep' ? <Moon size={18} /> : <Power size={18} />}</span><h2 id="mb-confirm-title">{titleCase(action)} {device.name}?</h2><p>Orchestra will send a signed {action} request. Active sessions or work may be interrupted.</p><footer><button onClick={cancel} disabled={pending}>Cancel</button><button className={action === 'shutdown' ? 'danger' : 'confirm'} onClick={confirm} disabled={pending}>{pending && <LoaderCircle size={13} className="spin" />}{titleCase(action)}</button></footer></div></div>; }

type CommandResult = { id: string; kind: 'action' | 'device' | 'job' | 'project'; title: string; detail: string; keywords: string };

function commandResults(query: string, compact: MenuBarSnapshot | null, full: FleetSnapshot | null): CommandResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const actions: CommandResult[] = [
    { id: 'new-codex', kind: 'action', title: 'New Codex session', detail: 'Start on the best available device', keywords: 'ask fleet start agent chat' },
    { id: 'wake', kind: 'action', title: 'Wake device', detail: 'Send Wake-on-LAN', keywords: 'power sleeping gpu computer' },
    { id: 'terminal', kind: 'action', title: 'Open terminal', detail: 'Choose an online device', keywords: 'shell ssh command' },
    { id: 'exit-node', kind: 'action', title: 'Change exit node', detail: 'Manage Tailscale routing', keywords: 'route home network vpn internet' },
    { id: 'quiet', kind: 'action', title: 'Toggle quiet mode', detail: 'Limit non-critical notifications', keywords: 'notifications focus do not disturb' },
    { id: 'jobs', kind: 'action', title: 'Open all jobs', detail: 'View fleet work queue', keywords: 'active failed completed queue' },
    { id: 'telemetry', kind: 'action', title: 'Open fleet health', detail: 'Metrics and alerts', keywords: 'gpu cpu ram storage warning' }
  ];
  const devices = (compact?.devices ?? []).map<CommandResult>((device) => ({ id: device.id, kind: 'device', title: device.name, detail: `${titleCase(device.role)} · ${titleCase(device.status)}`, keywords: `${device.platform} ${device.capabilities.labels.join(' ')}` }));
  const jobs = (compact?.jobs ?? []).map<CommandResult>((job) => ({ id: job.id, kind: 'job', title: job.name, detail: `${job.deviceName ?? 'Unassigned'} · ${titleCase(job.status)}`, keywords: `${job.kind} ${job.phase ?? ''} ${job.error ?? ''}` }));
  const projects = (full?.projects ?? []).map<CommandResult>((project) => ({ id: project.id, kind: 'project', title: project.name, detail: `${project.paths.length} device mapping${project.paths.length === 1 ? '' : 's'}`, keywords: `${project.description} ${project.repository ?? ''}` }));
  return [...actions, ...devices, ...jobs, ...projects]
    .map((item) => ({ item, score: searchScore(needle, `${item.title} ${item.detail} ${item.keywords}`.toLowerCase()) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.item.title.localeCompare(right.item.title))
    .slice(0, 12)
    .map(({ item }) => item);
}

function searchScore(query: string, haystack: string): number { if (haystack.startsWith(query)) return 5; if (haystack.includes(query)) return 3; return query.split(/\s+/).every((word) => haystack.includes(word)) ? 1 : 0; }
function commandIcon(item: CommandResult): ReactNode { if (item.kind === 'device') return <Server size={14} />; if (item.kind === 'job') return <Zap size={14} />; if (item.kind === 'project') return <HardDrive size={14} />; if (item.id === 'new-codex') return <Bot size={14} />; if (item.id === 'wake') return <Power size={14} />; if (item.id === 'terminal') return <SquareTerminal size={14} />; if (item.id === 'exit-node') return <Wifi size={14} />; return <Command size={14} />; }

async function respondToApproval(approval: MenuBarApproval, accepted: boolean): Promise<unknown> {
  if (approvalNeedsReview(approval) && accepted) throw new Error('Review this request in Orchestra Canvas before approving it.');
  if (approval.kind === 'codex') return api.respondApproval(approval.sessionId, approval.requestId, codexApprovalDecision(approval, accepted));
  return accepted ? apiV2.approvePipelineNode(approval.pipelineRunId, approval.nodeRunId) : apiV2.rejectPipelineNode(approval.pipelineRunId, approval.nodeRunId);
}

async function sendWhenReady(created: CodexSession, text: string): Promise<void> {
  let session = created;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (['ready', 'completed'].includes(session.status)) { await api.sendMessage(session.id, text); return; }
    if (['error', 'stopped'].includes(session.status)) throw new Error(session.error ?? `Codex session ${session.status}.`);
    await delay(500);
    session = (await api.snapshot()).sessions.find((candidate) => candidate.id === session.id) ?? session;
  }
  throw new Error('Codex did not become ready in time. The session remains available in Orchestra Canvas.');
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
function healthHeadline(snapshot: MenuBarSnapshot, connected: boolean): string {
  if (!connected) return 'Core connection unavailable';
  if (snapshot.summary.status === 'healthy') return 'All monitored systems are healthy';
  const issues = [
    snapshot.summary.openCriticalAlerts ? `${snapshot.summary.openCriticalAlerts} critical` : '',
    snapshot.summary.pendingApprovals ? `${snapshot.summary.pendingApprovals} approval${snapshot.summary.pendingApprovals === 1 ? '' : 's'}` : '',
    snapshot.summary.openWarnings ? `${snapshot.summary.openWarnings} warning${snapshot.summary.openWarnings === 1 ? '' : 's'}` : '',
    snapshot.summary.degradedDevices ? `${snapshot.summary.degradedDevices} degraded` : '',
    snapshot.summary.failedJobs ? `${snapshot.summary.failedJobs} failed` : ''
  ].filter(Boolean);
  return issues.length ? issues.slice(0, 3).join(' · ') : snapshot.summary.status === 'critical' ? 'Critical fleet condition' : 'Orchestra attention required';
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }

function menuBarBridge(): MenuBarBridge | undefined {
  return (window.fleetDesktop as (FleetDesktopBridge & { menuBar?: MenuBarBridge }) | undefined)?.menuBar;
}

async function openAlert(alert: MenuBarAlert, open: (target?: MainTarget) => Promise<void>): Promise<void> { await open(alert.jobId ? { page: 'jobs', jobId: alert.jobId, alertId: alert.id } : alert.deviceId ? { page: 'telemetry', deviceId: alert.deviceId, alertId: alert.id } : { page: 'telemetry', alertId: alert.id }); }
async function openRecent(item: MenuBarRecentItem, open: (target?: MainTarget) => Promise<void>): Promise<void> { await open(item.kind === 'job' ? { page: 'jobs', jobId: item.entityId } : item.deviceId ? { page: 'activity', deviceId: item.deviceId, entityId: item.entityId } : { page: 'activity', entityId: item.entityId }); }

export const menuBarTestHelpers = { commandResults, searchScore };
