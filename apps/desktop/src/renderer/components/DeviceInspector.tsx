import type { CodexApproval, CodexEvent, CodexMicroVoiceState, CodexSession, Device, FleetProject, PermissionMode } from '@fleet/shared';
import {
  Activity, AlertTriangle, BookOpen, Bot, Box, Check, ChevronDown, CircleStop, Clipboard, Clock3, Code2, Copy, Cpu, ExternalLink, GitFork,
  Command as CommandIcon, GripVertical, HardDrive, MemoryStick, MessageSquare, MonitorUp, MoveRight, Network, Play, RotateCcw, Send, ShieldCheck, Square, SquareTerminal, Thermometer, X, XCircle, Zap
} from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, apiV2, codexClientIdentity, type CodexClientIdentity } from '../lib/api';
import { approvalResponse, firstMissingApprovalQuestion } from '../lib/codex-approval-response';
import { boundedCodexModelOffset, CODEX_MICRO_MODEL_PRESETS, codexModelOffsetForMicroEncoder, codexModelPresetIndex, preferredCodexModelIdentifier, type CodexModelPreset } from '../lib/codex-model-settings';
import { canMessageCodexSession, codexSessionUnavailableMessage, preferredCodexSession, shouldApplyInitialCodexSessionTarget, type InitialCodexSessionTarget } from '../lib/codex-session-state';
import { codexEventTurnId, codexMessageSources, type CodexMessageSource } from '../lib/codex-message-actions';
import {
  DEFAULT_DEVICE_INSPECTOR_WIDTH,
  DEVICE_INSPECTOR_MOBILE_BREAKPOINT,
  MIN_DEVICE_INSPECTOR_WIDTH,
  clampDeviceInspectorWidth,
  maximumDeviceInspectorWidth,
  readDeviceInspectorWidth,
  writeDeviceInspectorWidth,
} from '../lib/device-inspector-state';
import { formatBytes, formatDuration, relativeTime, titleCase } from '../lib/format';
import { projectForCodexSession } from '../lib/project-session';
import { isTranscriptNearBottom } from '../lib/transcript-scroll';
import { isLiveTerminalSession, preferredTerminalSession } from '../lib/terminal-session-state';
import { useFleet } from '../state/FleetContext';
import { EmptyState } from './EmptyState';
import { CodexCommandCenter } from './CodexCommandCenter';
import { CodexSessionPicker } from './CodexSessionPicker';
import { DeviceMentionMenu, useDeviceMentionComposer } from './DeviceMentionComposer';
import { MessageContent } from './MessageContent';
import { StatusBadge } from './StatusBadge';
import { TerminalView } from './TerminalView';
import { WorkspacePathPicker } from './WorkspacePathPicker';

export type InspectorTab = 'overview' | 'codex' | 'terminal' | 'desktop' | 'jobs';

const CODEX_DIAL_PREVIEW_TIMEOUT_MS = 8_000;

type CodexDialState = { status: 'selecting' | 'applying' | 'applied' | 'error'; presets: readonly CodexModelPreset[]; index: number; message: string };
type CodexDialOverlayHandle = { update(state: CodexDialState | null): void };

const CodexDialOverlay = forwardRef<CodexDialOverlayHandle, { sessionTitle: string; deviceName: string }>(function CodexDialOverlay({ sessionTitle, deviceName }, ref) {
  const [state, setState] = useState<CodexDialState | null>(null);
  useImperativeHandle(ref, () => ({ update: setState }), []);
  if (!state) return null;
  const preset = state.presets[state.index];
  const previous = state.index > 0 ? state.presets[state.index - 1] : undefined;
  const next = state.index < state.presets.length - 1 ? state.presets[state.index + 1] : undefined;
  return <div className={`codex-dial-state codex-dial-state--${state.status}`} role="status" aria-live="polite">
    <header><span>Codex Micro</span><strong>Model + Reasoning</strong><small>{sessionTitle} · {deviceName}</small></header>
    {state.status === 'selecting' && preset ? <>
      <div className="codex-dial-state__ladder">
        <span><small>Previous</small>{previous?.label ?? '—'}</span>
        <strong><small>Preview</small>{preset.label}</strong>
        <span><small>Next</small>{next?.label ?? '—'}</span>
      </div>
      <footer><span>Rotate to choose</span><strong>Local preview — press knob to apply</strong><span>Closes in 8 seconds</span></footer>
    </> : <div className="codex-dial-state__result"><strong>{state.status === 'applied' ? 'Applied' : state.status === 'error' ? 'Could not apply' : 'Working'}</strong><span>{state.message}</span></div>}
  </div>;
});

export function DeviceInspector({ device, initialTab = 'overview', initialCodexSessionTarget, onClose }: { device: Device; initialTab?: InspectorTab; initialCodexSessionTarget?: InitialCodexSessionTarget; onClose(): void }) {
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [preferredWidth, setPreferredWidth] = useState(() => readDeviceInspectorWidth(typeof window === 'undefined' ? undefined : window.localStorage));
  const preferredWidthRef = useRef(preferredWidth);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1440 : window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const maximumWidth = maximumDeviceInspectorWidth(viewportWidth);
  const width = clampDeviceInspectorWidth(preferredWidth, viewportWidth);

  useEffect(() => setTab(initialTab), [device.id, initialTab]);
  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('inspector-is-resizing', resizing);
    return () => document.body.classList.remove('inspector-is-resizing');
  }, [resizing]);

  function updateWidth(next: number): void {
    const clamped = clampDeviceInspectorWidth(next, viewportWidth);
    preferredWidthRef.current = clamped;
    setPreferredWidth(clamped);
  }

  function persistWidth(next = preferredWidthRef.current): void {
    writeDeviceInspectorWidth(typeof window === 'undefined' ? undefined : window.localStorage, next);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (viewportWidth <= DEVICE_INSPECTOR_MOBILE_BREAKPOINT || event.button !== 0) return;
    resizeStart.current = { pointerId: event.pointerId, x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    event.preventDefault();
  }

  function resize(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    updateWidth(start.width + start.x - event.clientX);
    event.preventDefault();
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    persistWidth();
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (viewportWidth <= DEVICE_INSPECTOR_MOBILE_BREAKPOINT) return;
    const step = event.shiftKey ? 48 : 16;
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = width + step;
    if (event.key === 'ArrowRight') next = width - step;
    if (event.key === 'Home') next = MIN_DEVICE_INSPECTOR_WIDTH;
    if (event.key === 'End') next = maximumWidth;
    if (next === undefined) return;
    event.preventDefault();
    updateWidth(next);
    persistWidth(clampDeviceInspectorWidth(next, viewportWidth));
  }

  function resetWidth(): void {
    updateWidth(DEFAULT_DEVICE_INSPECTOR_WIDTH);
    persistWidth(clampDeviceInspectorWidth(DEFAULT_DEVICE_INSPECTOR_WIDTH, viewportWidth));
  }

  return (
    <aside className={`inspector ${resizing ? 'is-resizing' : ''}`} aria-label={`${device.name} inspector`} style={{ '--inspector-width': `${width}px` } as CSSProperties}>
      <div
        className="inspector__resize-handle"
        role="separator"
        aria-label="Resize device inspector"
        aria-orientation="vertical"
        aria-valuemin={Math.min(MIN_DEVICE_INSPECTOR_WIDTH, maximumWidth)}
        aria-valuemax={maximumWidth}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        onDoubleClick={resetWidth}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
      ><span><GripVertical size={14} /></span></div>
      <header className="inspector__header">
        <div className={`device-avatar device-avatar--${device.role}`}><Cpu size={19} /></div>
        <div><h2>{device.name}</h2><p>{device.hostname}</p></div>
        <StatusBadge status={device.status} />
        <button type="button" className="icon-button inspector__close" onClick={onClose} aria-label="Close inspector"><X size={18} /></button>
      </header>
      <nav className="inspector-tabs" aria-label="Device views">
        {([['overview', Activity], ['codex', Bot], ['terminal', SquareTerminal], ['desktop', MonitorUp], ['jobs', Box]] as const).map(([id, Icon]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} aria-label={titleCase(id)}><Icon size={15} /><span>{titleCase(id)}</span></button>
        ))}
      </nav>
      <div className="inspector__body">
        {tab === 'overview' && <Overview device={device} />}
        {tab === 'codex' && <CodexPanel key={device.id} device={device} initialSessionTarget={initialCodexSessionTarget} />}
        {tab === 'terminal' && <TerminalPanel key={device.id} device={device} />}
        {tab === 'desktop' && <RemoteDesktopPanel key={device.id} device={device} />}
        {tab === 'jobs' && <DeviceJobs device={device} />}
      </div>
    </aside>
  );
}

function RemoteDesktopPanel({ device }: { device: Device }) {
  const { snapshot, request } = useFleet();
  const sessions = snapshot?.v2.desktopSessions.filter((session) => session.deviceId === device.id) ?? [];
  const protocol = device.platform === 'win32' ? 'rdp' : device.platform === 'darwin' ? 'screen-sharing' : device.capabilities.labels.includes('sunshine:true') ? 'sunshine' : 'vnc';
  return <div className="inspector-section-stack remote-desktop-panel">
    <section className="inspector-section remote-desktop-hero">
      <span><MonitorUp size={22} /></span>
      <div><span className="eyebrow">Visual control</span><h3>{titleCase(protocol)} on {device.name}</h3><p>Start a device-native remote desktop session through the Orchestra Agent, then connect with the registered macOS client.</p></div>
    </section>
    <section className="inspector-section"><h3>Remote session</h3><RemoteAccess device={device} sessions={sessions} start={async (nextProtocol) => {
      const session = await request(() => apiV2.startDesktop({ deviceId: device.id, protocol: nextProtocol, viewOnly: false, recording: false }));
      if (session.connectionUrl) await openRemoteDesktopUrl(session.connectionUrl);
    }} close={(id) => void request(() => apiV2.closeDesktop(id)).catch(() => undefined)} /></section>
    <div className="notice subtle"><ShieldCheck size={15} /><span>Remote desktop access uses the protocol configured on this device. Orchestra never embeds credentials in the connection URL.</span></div>
  </div>;
}

function Overview({ device }: { device: Device }) {
  const { snapshot, request } = useFleet();
  const memory = device.metrics.memory;
  const storage = device.metrics.storage[0];
  const gpu = device.metrics.gpus[0];
  return (
    <div className="inspector-section-stack inspector-overview">
      <section className="overview-hero">
        <div className="eyebrow">Live utilization</div>
        <div className="hero-gauge" style={{ '--usage': `${Math.round(device.metrics.cpu.usagePercent * 3.6)}deg` } as React.CSSProperties}>
          <div><strong>{Math.round(device.metrics.cpu.usagePercent)}%</strong><span>CPU</span></div>
        </div>
        <div className="hero-stats">
          <div><MemoryStick size={15} /><span>Memory</span><strong>{Math.round(memory.usagePercent)}%</strong></div>
          <div><Clock3 size={15} /><span>Uptime</span><strong>{formatDuration(device.metrics.uptimeSeconds)}</strong></div>
          {gpu && <div><Zap size={15} /><span>GPU</span><strong>{Math.round(gpu.usagePercent ?? 0)}%</strong></div>}
        </div>
      </section>

      {device.presence && <Section title="Truthful presence">
        <div className={`presence-summary presence-summary--${device.presence.summary}`}>
          <span className="status-dot" /><div><strong>{device.presence.label}</strong><small>{device.presence.detail}</small></div>
        </div>
        <div className="presence-layers">
          {(['agent', 'tailscale', 'lan', 'services'] as const).map((key) => {
            const evidence = device.presence![key];
            return <div key={key}><i className={`presence-layer-state presence-layer-state--${evidence.state}`} /><span><strong>{titleCase(key)}</strong><small>{evidence.detail}</small></span><time>{relativeTime(evidence.checkedAt)}</time></div>;
          })}
        </div>
      </Section>}

      <Section title="Resources">
        <ResourceRow icon={Cpu} label={device.metrics.cpu.model || 'Processor'} value={`${device.metrics.cpu.cores} cores · ${Math.round(device.metrics.cpu.usagePercent)}%`} percent={device.metrics.cpu.usagePercent} />
        <ResourceRow icon={MemoryStick} label="Unified memory" value={`${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}`} percent={memory.usagePercent} />
        {storage && <ResourceRow icon={HardDrive} label={storage.mount || 'Storage'} value={`${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)}`} percent={storage.usagePercent} />}
        {gpu && <ResourceRow icon={Zap} label={gpu.model} value={`${Math.round(gpu.usagePercent ?? 0)}%${gpu.vramTotalBytes ? ` · ${formatBytes(gpu.vramUsedBytes ?? 0)} VRAM` : ''}`} percent={gpu.usagePercent ?? 0} />}
      </Section>

      <Section title="Network & identity">
        <Definition label="Tailnet address" value={device.metrics.network.tailscaleIp ?? 'Not reported'} icon={Network} />
        <Definition label="DNS name" value={device.metrics.network.tailscaleDnsName ?? 'Not reported'} />
        <Definition label="Operating system" value={`${device.osName} ${device.osVersion}`} />
        <Definition label="Agent" value={`v${device.agentVersion} · seen ${relativeTime(device.lastSeenAt)}`} />
      </Section>

      <Section title="Capabilities">
        <div className="chip-grid">
          {capabilityLabels(device).map((label) => <span className="capability-chip" key={label}><Check size={12} />{label}</span>)}
          {!capabilityLabels(device).length && <span className="muted">No capabilities reported</span>}
        </div>
      </Section>
      <Section title="Remote desktop">
        <RemoteAccess device={device} sessions={snapshot?.v2.desktopSessions.filter((session) => session.deviceId === device.id) ?? []} start={async (protocol) => {
          const session = await request(() => apiV2.startDesktop({ deviceId: device.id, protocol, viewOnly: false, recording: false }));
          if (session.connectionUrl) await openRemoteDesktopUrl(session.connectionUrl);
        }} close={(id) => void request(() => apiV2.closeDesktop(id)).catch(() => undefined)} />
      </Section>
    </div>
  );
}

function RemoteAccess({ device, sessions, start, close }: { device: Device; sessions: import('@fleet/shared').RemoteDesktopSession[]; start(protocol: string): Promise<void>; close(id: string): void }) {
  const active = sessions.find((session) => ['starting', 'ready'].includes(session.status));
  const protocol = device.platform === 'win32' ? 'rdp' : device.platform === 'darwin' ? 'screen-sharing' : device.capabilities.labels.includes('sunshine:true') ? 'sunshine' : 'vnc';
  return active ? <div className="remote-access"><div><span className="status-dot status-dot--online" /><div><strong>{titleCase(active.protocol)} session</strong><small>{active.status === 'ready' ? 'Ready to connect' : 'Starting secure session…'}</small></div><StatusBadge status={active.status} /></div><div>{active.connectionUrl && <button className="primary-button" onClick={() => void openRemoteDesktopUrl(active.connectionUrl!).catch(() => undefined)}><ExternalLink size={14} />Connect</button>}<button className="secondary-button" onClick={() => close(active.id)}><CircleStop size={14} />Close</button></div></div> : <div className="remote-launch"><div><ExternalLink size={16} /><span><strong>{titleCase(protocol)}</strong><small>Launch through the device Agent</small></span></div><button className="secondary-button compact" disabled={device.status === 'offline'} onClick={() => void start(protocol).catch(() => undefined)}><Play size={13} />Launch</button></div>;
}

async function openRemoteDesktopUrl(url: string): Promise<void> {
  if (window.fleetDesktop) {
    await window.fleetDesktop.openExternal(url);
    return;
  }
  const parsed = new URL(url);
  if (!['https:', 'rdp:', 'vnc:', 'moonlight:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(decodeURIComponent(url))) throw new Error('Unsupported remote desktop URL');
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

function ResourceRow({ icon: Icon, label, value, percent }: { icon: typeof Cpu; label: string; value: string; percent: number }) {
  return <div className="resource-row"><Icon size={15} /><div><span>{label}</span><strong>{value}</strong><div className="resource-track"><i style={{ width: `${Math.min(100, Math.max(1, percent))}%` }} /></div></div></div>;
}

function Definition({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Network }) {
  return <div className="definition-row"><span>{Icon && <Icon size={13} />}{label}</span><strong title={value}>{value}</strong></div>;
}

function capabilityLabels(device: Device): string[] {
  const capabilities = device.capabilities;
  const codexInstalled = capabilities.codex || capabilities.labels.includes('codex:installed');
  const implementationLabels = new Set(['codex:installed', 'codex:authenticated', 'codex:ready', 'codex:true']);
  return [
    capabilities.codex ? 'Codex ready' : codexInstalled ? 'Codex CLI installed' : false,
    capabilities.git && 'Git', capabilities.docker && 'Docker', capabilities.tailscale && 'Tailscale',
    capabilities.cuda && 'CUDA', capabilities.mlx && 'MLX', capabilities.node && 'Node.js', capabilities.wakeOnLan && 'Wake on LAN',
    ...capabilities.labels.filter((label) => !implementationLabels.has(label)),
  ].filter((value): value is string => Boolean(value));
}

function CodexPanel({ device, initialSessionTarget }: { device: Device; initialSessionTarget?: InitialCodexSessionTarget }) {
  const { snapshot, request } = useFleet();
  const sessions = useMemo(() => snapshot?.sessions.filter((session) => session.deviceId === device.id) ?? [], [snapshot, device.id]);
  const initialSession = preferredCodexSession(sessions);
  const [activeId, setActiveId] = useState<string | null>(initialSessionTarget ? initialSessionTarget.id : initialSession?.id ?? null);
  const [creatingNew, setCreatingNew] = useState(initialSessionTarget ? initialSessionTarget.id === null : !initialSession);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandInitialView, setCommandInitialView] = useState<'commands' | 'permissions'>('commands');
  const [operation, setOperation] = useState<'fork' | 'move' | null>(null);
  const [branchingEventId, setBranchingEventId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<CodexClientIdentity | null>(null);
  const active = creatingNew ? undefined : (sessions.find((session) => session.id === activeId) ?? preferredCodexSession(sessions));
  const activeAdvancedSession = active ? snapshot?.v2.advancedSessions.find((session) => session.sessionId === active.id) : undefined;
  const activeProject = active ? projectForCodexSession(active, snapshot?.projects ?? []) : undefined;
  const activePreviewUrl = activeProject?.preview?.status === 'running' ? activeProject.preview.url : undefined;
  const canMessage = canMessageCodexSession(active) && device.status !== 'offline';
  const mobilityAvailable = device.capabilities.labels.includes('feature:codex-session-mobility');
  const codexInstalled = device.capabilities.codex || device.capabilities.labels.includes('codex:installed');

  const canResume = Boolean(active?.status === 'stopped' && device.capabilities.codex && mobilityAvailable && active.threadId);
  const canChangePermissions = Boolean(active?.threadId && (
    active.status === 'stopped' || (
      device.status !== 'offline'
      && device.capabilities.labels.includes('feature:codex-ui-rpc')
      && ['ready', 'thinking', 'awaiting-approval', 'completed'].includes(active.status)
    )
  ) && (!active.controllerClientId || active.controllerClientId === identity?.clientId));
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const messageRef = useRef('');
  const fastMode = useRef(false);
  const planMode = useRef(false);
  const reasoningEffort = useRef(new Map<string, string>());
  const consumedInitialSessionTarget = useRef<InitialCodexSessionTarget | undefined>(undefined);
  const voiceGesture = useRef<{ stopTimer: ReturnType<typeof setTimeout> | null; latched: boolean; suppressRelease: boolean }>({ stopTimer: null, latched: false, suppressRelease: false });
  const [voiceState, setVoiceState] = useState<CodexMicroVoiceState>({ state: 'idle', sessionId: null });
  const dialOverlay = useRef<CodexDialOverlayHandle>(null);
  const dialStateRef = useRef<CodexDialState | null>(null);
  const dialClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialApplyChains = useRef(new Map<string, Promise<void>>());
  const activeSessionId = useRef<string | null>(null);
  const microApprovalActions = useRef(new Map<string, { submit(): void; reject(): void }>());
  const mention = useDeviceMentionComposer(message, setMessage, snapshot?.devices ?? [], composer);

  useEffect(() => {
    if (creatingNew || (activeId && sessions.some((session) => session.id === activeId))) return;
    const preferred = preferredCodexSession(sessions);
    if (preferred) setActiveId(preferred.id);
    else setCreatingNew(true);
  }, [activeId, creatingNew, sessions]);
  useEffect(() => {
    if (!shouldApplyInitialCodexSessionTarget(initialSessionTarget, consumedInitialSessionTarget.current, sessions.map((session) => session.id))) return;
    consumedInitialSessionTarget.current = initialSessionTarget;
    setActiveId(initialSessionTarget!.id);
    setCreatingNew(initialSessionTarget!.id === null);
  }, [initialSessionTarget, sessions]);
  useEffect(() => {
    void window.fleetDesktop?.codexMicro.setActiveSession(creatingNew ? null : active?.id ?? null);
    return () => { void window.fleetDesktop?.codexMicro.setActiveSession(null); };
  }, [active?.id, creatingNew]);
  const followTranscript = useRef(true);
  useLayoutEffect(() => {
    followTranscript.current = true;
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active?.id]);
  useLayoutEffect(() => {
    if (!followTranscript.current) return;
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active?.updatedAt, active?.events.length, active?.pendingApprovals.length, active?.status]);
  useEffect(() => { messageRef.current = message; }, [message]);
  useEffect(() => { activeSessionId.current = creatingNew ? null : active?.id ?? null; }, [active?.id, creatingNew]);
  useEffect(() => {
    if (active?.id && activeAdvancedSession?.reasoningLevel) reasoningEffort.current.set(active.id, activeAdvancedSession.reasoningLevel);
  }, [active?.id, activeAdvancedSession?.reasoningLevel]);
  useEffect(() => {
    clearDialPreviewTimer();
    commitDialState(null);
  }, [active?.id]);
  useEffect(() => () => clearDialPreviewTimer(), []);
  useEffect(() => { void codexClientIdentity().then(setIdentity); }, []);
  useEffect(() => {
    const bridge = window.fleetDesktop?.codexMicro;
    if (!bridge) return;
    void bridge.getVoiceState().then(setVoiceState).catch(() => undefined);
    return bridge.onVoiceState((state) => {
      setVoiceState(state);
      if (state.state !== 'idle' || !state.transcript?.trim() || state.sessionId !== activeSessionId.current) return;
      const transcript = state.transcript.trim();
      setMessage((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${transcript} `);
      queueMicrotask(() => composer.current?.focus());
    });
  }, []);
  useEffect(() => window.fleetDesktop?.codexMicro.onDecision((event) => {
    if (event.sessionId !== active?.id) return;
    const actions = microApprovalActions.current.get(event.approvalId);
    if (!actions) { void window.fleetDesktop?.codexMicro.signalFeedback('error'); return; }
    if (event.accepted) actions.submit();
    else actions.reject();
  }), [active?.id]);
  useEffect(() => {
    if (!active?.id || !identity) return;
    let disposed = false;
    const heartbeat = () => { if (!disposed) void api.updatePresence(active.id, Boolean(messageRef.current.trim())).catch(() => undefined); };
    heartbeat();
    const timer = setInterval(heartbeat, 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void api.leavePresence(active.id).catch(() => undefined);
    };
  }, [active?.id, identity?.clientId]);
  useEffect(() => {
    if (!active?.id || !identity) return;
    const timer = setTimeout(() => void api.updatePresence(active.id, Boolean(message.trim())).catch(() => undefined), 300);
    return () => clearTimeout(timer);
  }, [active?.id, identity?.clientId, message]);

  async function sendText(text: string): Promise<void> {
    if (!active || !canMessage || !text.trim() || sending) return;
    setSending(true);
    try {
      await request(() => api.sendMessage(active.id, text.trim()));
      setMessage('');
    } finally { setSending(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    await sendText(message);
  }

  async function resume(): Promise<void> {
    if (!active || !canResume) return;
    const resumed = await request(() => api.resumeSession(active.id));
    setActiveId(resumed.id);
  }

  async function interrupt(): Promise<void> {
    if (!active?.threadId || !active.turnId || interrupting) return;
    setInterrupting(true);
    try { await request(() => api.interruptSession(active.id)); }
    finally { setInterrupting(false); }
  }

  async function branchFrom(event: CodexEvent): Promise<void> {
    if (!active || branchingEventId) return;
    setBranchingEventId(event.id);
    try {
      const lastTurnId = codexEventTurnId(event);
      const branched = await request(() => api.forkSession(active.id, {
        deviceId: active.deviceId,
        title: `${active.title} (branch)`,
        ...(lastTurnId ? { lastTurnId } : {}),
      }));
      setActiveId(branched.id);
      setCreatingNew(false);
    } finally {
      setBranchingEventId(null);
    }
  }

  function openCommands(initialView: 'commands' | 'permissions' = 'commands'): void {
    setCommandInitialView(initialView);
    if (initialView === 'commands') setMessage((current) => current || '/');
    setCommandOpen(true);
    queueMicrotask(() => composer.current?.focus());
  }

  function closeCommands(): void {
    setCommandOpen(false);
    setMessage((current) => current.trimStart().startsWith('/') ? '' : current);
    queueMicrotask(() => composer.current?.focus());
  }

  function openWebsite(): void {
    if (!activeProject || !activePreviewUrl) return;
    void api.touchProjectPreview(activeProject.id).catch(() => undefined);
    if (window.fleetDesktop) void window.fleetDesktop.openExternal(activePreviewUrl).catch(() => undefined);
    else window.open(activePreviewUrl, '_blank', 'noopener,noreferrer');
  }

  function startVoicePrompt(): void {
    composer.current?.focus();
    void window.fleetDesktop?.codexMicro.startVoiceCapture().then(setVoiceState).catch((error) => {
      setVoiceState({ state: 'error', sessionId: active?.id ?? null, code: 'capture-failed', error: error instanceof Error ? error.message : 'Voice capture failed.' });
    });
  }

  function stopVoicePrompt(): void {
    void window.fleetDesktop?.codexMicro.stopVoiceCapture().then(setVoiceState).catch(() => undefined);
  }

  function handleVoiceGesture(phase: 'press' | 'release'): void {
    const gesture = voiceGesture.current;
    if (phase === 'press') {
      if (gesture.latched) {
        gesture.latched = false;
        gesture.suppressRelease = true;
        stopVoicePrompt();
        return;
      }
      if (gesture.stopTimer) {
        clearTimeout(gesture.stopTimer);
        gesture.stopTimer = null;
        gesture.latched = true;
        return;
      }
      startVoicePrompt();
      return;
    }
    if (gesture.suppressRelease) { gesture.suppressRelease = false; return; }
    if (gesture.latched) return;
    gesture.stopTimer = setTimeout(() => {
      gesture.stopTimer = null;
      stopVoicePrompt();
    }, 350);
  }

  async function togglePlanMode(): Promise<void> {
    if (!active?.threadId) return;
    const modeResponse = await api.codexRpc<Record<string, unknown>>(active.id, 'collaborationMode/list', {});
    const modes = Array.isArray(asRecord(modeResponse.result).data) ? asRecord(modeResponse.result).data as unknown[] : [];
    const nextPlan = !planMode.current;
    const mode = modes.map(asRecord).find((item) => String(item.mode ?? item.name ?? '').toLowerCase().includes(nextPlan ? 'plan' : 'default'));
    if (!mode) return;
    const model = preferredCodexModelIdentifier([], mode.model, active.model);
    if (!model) throw new Error('Codex did not report a usable model for this collaboration mode.');
    await api.codexRpc(active.id, 'thread/settings/update', {
      threadId: active.threadId,
      collaborationMode: {
        mode: String(mode.mode ?? (nextPlan ? 'plan' : 'default')),
        settings: { model, reasoning_effort: mode.reasoning_effort ?? null, developer_instructions: null },
      },
    });
    planMode.current = nextPlan;
  }

  function clearDialPreviewTimer(): void {
    if (dialClearTimer.current) clearTimeout(dialClearTimer.current);
    dialClearTimer.current = null;
  }

  function commitDialState(next: CodexDialState | null): void {
    dialStateRef.current = next;
    dialOverlay.current?.update(next);
  }

  function updateDialState(update: (current: CodexDialState | null) => CodexDialState | null): void {
    const current = dialStateRef.current;
    const next = update(current);
    if (next === current) return;
    commitDialState(next);
  }

  function scheduleDialPreviewTimeout(): void {
    clearDialPreviewTimer();
    dialClearTimer.current = setTimeout(() => {
      dialClearTimer.current = null;
      updateDialState((current) => current?.status === 'selecting' ? null : current);
    }, CODEX_DIAL_PREVIEW_TIMEOUT_MS);
  }

  function settleDial(status: 'applied' | 'error', message: string, presets: readonly CodexModelPreset[] = [], index = 0): void {
    clearDialPreviewTimer();
    commitDialState({ status, presets, index, message });
    void window.fleetDesktop?.codexMicro.signalFeedback(status === 'applied' ? 'success' : 'error');
    dialClearTimer.current = setTimeout(() => { dialClearTimer.current = null; commitDialState(null); }, status === 'applied' ? 1_600 : 3_500);
  }

  async function adjustReasoning(direction: 'increase' | 'decrease'): Promise<void> {
    if (!active?.threadId) return;
    const modelId = CODEX_MICRO_MODEL_PRESETS.some((preset) => preset.modelId === active.model) ? active.model : 'gpt-5.6-terra';
    const presets = CODEX_MICRO_MODEL_PRESETS.filter((preset) => preset.modelId === modelId);
    const currentIndex = Math.max(0, presets.findIndex((preset) => preset.effort === reasoningEffort.current.get(active.id)));
    const nextIndex = Math.max(0, Math.min(presets.length - 1, currentIndex + (direction === 'increase' ? 1 : -1)));
    const preset = presets[nextIndex];
    if (!preset) return;
    commitDialState({ status: 'applying', presets, index: nextIndex, message: `Applying ${preset.label}…` });
    void window.fleetDesktop?.codexMicro.signalFeedback('pending');
    try {
      await api.codexRpc(active.id, 'thread/settings/update', { threadId: active.threadId, model: preset.modelId, effort: preset.effort });
      if (preset.effort) reasoningEffort.current.set(active.id, preset.effort);
      settleDial('applied', `${preset.label} applied`, presets, nextIndex);
    } catch (error) {
      settleDial('error', error instanceof Error ? error.message : 'Reasoning could not be changed.', presets, nextIndex);
    }
  }

  function openModelDial(offset = 0): void {
    if (!active?.threadId) return;
    const sessionId = active.id;
    const currentPreview = dialStateRef.current;
    const currentIndex = currentPreview?.presets === CODEX_MICRO_MODEL_PRESETS
      && currentPreview.index >= 0
      && currentPreview.index < CODEX_MICRO_MODEL_PRESETS.length
      ? currentPreview.index
      : codexModelPresetIndex(CODEX_MICRO_MODEL_PRESETS, active.model, reasoningEffort.current.get(sessionId));
    const index = boundedCodexModelOffset(currentIndex, CODEX_MICRO_MODEL_PRESETS.length, offset);
    commitDialState({ status: 'selecting', presets: CODEX_MICRO_MODEL_PRESETS, index, message: 'Local preview — press knob to apply' });
    scheduleDialPreviewTimeout();
  }

  async function applyModelDial(): Promise<void> {
    const current = dialStateRef.current;
    if (!active?.threadId || !current || current.status !== 'selecting') return;
    const preset = current.presets[current.index];
    if (!preset) return;
    const sessionId = active.id;
    const threadId = active.threadId;
    clearDialPreviewTimer();
    const applyingState: CodexDialState = { ...current, status: 'applying', message: `Applying ${preset.label}…` };
    commitDialState(applyingState);
    void window.fleetDesktop?.codexMicro.signalFeedback('pending');
    const previous = dialApplyChains.current.get(sessionId) ?? Promise.resolve();
    let operation!: Promise<void>;
    operation = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await api.codexRpc(sessionId, 'thread/settings/update', { threadId, model: preset.modelId, ...(preset.effort ? { effort: preset.effort } : {}) });
          if (preset.effort) reasoningEffort.current.set(sessionId, preset.effort);
          if (activeSessionId.current !== sessionId || dialStateRef.current !== applyingState) return;
          settleDial('applied', `${preset.label} applied`, current.presets, current.index);
        } catch (error) {
          if (activeSessionId.current !== sessionId || dialStateRef.current !== applyingState) return;
          settleDial('error', error instanceof Error ? error.message : 'The model preset could not be changed.', current.presets, current.index);
        }
      })
      .finally(() => {
        if (dialApplyChains.current.get(sessionId) === operation) dialApplyChains.current.delete(sessionId);
      });
    dialApplyChains.current.set(sessionId, operation);
    await operation;
  }

  useEffect(() => window.fleetDesktop?.codexMicro.onAction((event) => {
    if (!active || event.sessionId !== active.id) return;
    if (event.action === 'push-to-talk') { handleVoiceGesture(event.phase); return; }
    if (event.phase !== 'press') return;
    if (event.action === 'send-message') { void sendText(messageRef.current); return; }
    if (event.action === 'insert-yolo' || event.action === 'insert-yeet') { setMessage((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${event.action === 'insert-yolo' ? ':yolo:' : ':yeet:'}`); return; }
    if (event.action === 'toggle-fast-mode' && active.threadId) {
      const next = !fastMode.current;
      void api.codexRpc(active.id, 'thread/settings/update', { threadId: active.threadId, serviceTier: next ? 'fast' : 'default' }).then(() => { fastMode.current = next; });
      return;
    }
    if (event.action === 'toggle-plan-mode') { void togglePlanMode(); return; }
    if (event.action === 'increase-reasoning' || event.action === 'decrease-reasoning') { void adjustReasoning(event.action === 'increase-reasoning' ? 'increase' : 'decrease'); return; }
    if (event.action === 'archive-chat' && active.threadId) { void api.codexRpc(active.id, 'thread/archive', { threadId: active.threadId }); return; }
    if (event.action === 'toggle-review') { setMessage('/review'); setCommandInitialView('commands'); setCommandOpen(true); return; }
    if (event.action === 'open-plugins') { setMessage('/plugins'); setCommandInitialView('commands'); setCommandOpen(true); return; }
    if (event.action === 'git-commit-push') { void sendText('Review the current changes, create an appropriate commit, and push the branch.'); return; }
    if (event.action === 'create-pull-request') { void sendText('Review the branch and create a pull request with an accurate title and summary.'); return; }
    if (event.action === 'run-primary-action') { void sendText('Run the primary build or test action for this project, diagnose any failures, and report the result.'); return; }
    if (event.action === 'custom-shortcut' && event.customShortcut) { setMessage(event.customShortcut.startsWith('/') ? event.customShortcut : `/${event.customShortcut}`); setCommandOpen(true); return; }
    if (event.action === 'add-files' || event.action === 'add-photos') { composer.current?.focus(); }
  }), [active?.id, active?.threadId, active?.model, canMessage, sending]);
  useEffect(() => window.fleetDesktop?.codexMicro.onDial((event) => {
    if (!active || event.sessionId !== active.id || event.mode !== 'model-reasoning') return;
    if (event.direction === 'press') {
      const current = dialStateRef.current;
      if (current?.status === 'selecting') void applyModelDial();
      else openModelDial();
      return;
    }
    if (event.direction !== 'clockwise' && event.direction !== 'counterclockwise') return;
    const offset = codexModelOffsetForMicroEncoder(event.direction, event.steps);
    if (dialStateRef.current?.status === 'selecting') {
      updateDialState((current) => {
        if (!current || current.status !== 'selecting') return current;
        const index = boundedCodexModelOffset(current.index, current.presets.length, offset);
        if (index === current.index) return current;
        return { ...current, index, message: 'Local preview — press knob to apply' };
      });
      scheduleDialPreviewTimeout();
      return;
    }
    openModelDial(offset);
  }), [active?.id, active?.threadId, active?.model]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  if (!active) return <NewCodexSession device={device} projects={snapshot?.projects ?? []} pending={creating} setPending={setCreating} onCreated={(session) => { setActiveId(session.id); setCreatingNew(false); }} />;

  const participants = active.participants ?? [];
  const latestAssistantId = [...active.events].reverse().find((event) => event.type === 'assistant')?.id;
  const hasControl = Boolean(identity && active.controllerClientId === identity.clientId);
  const typingParticipants = participants.filter((participant) => participant.typing && participant.clientId !== identity?.clientId);

  return (<>
    <div className="codex-panel">
      <div className="session-toolbar">
        <CodexSessionPicker sessions={sessions} active={active} onSelect={(sessionId) => { setActiveId(sessionId); setCreatingNew(false); }} />
        <StatusBadge status={active.status} />
        {activePreviewUrl && <button className="secondary-button compact codex-open-website" onClick={openWebsite} title={`Open ${activeProject?.name ?? 'project'} website`}><ExternalLink size={13} /><span>Website</span></button>}
        {active.status === 'stopped' && <button className="icon-button" disabled={!canResume} onClick={() => void resume().catch(() => undefined)} title={device.capabilities.codex ? 'Resume this Codex thread' : 'Authenticate Codex on this device before resuming'}><RotateCcw size={16} /></button>}
        <button className="icon-button" disabled={!mobilityAvailable || !active.threadId || !['ready', 'completed', 'stopped'].includes(active.status)} onClick={() => setOperation('fork')} title="Fork this session"><GitFork size={16} /></button>
        <button className="icon-button" disabled={!mobilityAvailable || !active.threadId || !['ready', 'completed'].includes(active.status)} onClick={() => setOperation('move')} title="Move this session to another device"><MoveRight size={16} /></button>
        <button className="icon-button" onClick={() => openCommands()} title="Codex commands (⌘K)"><CommandIcon size={16} /></button>
        <button className="icon-button" disabled={active.status === 'stopped'} onClick={() => void request(() => api.stopSession(active.id)).catch(() => undefined)} title="Stop session"><XCircle size={16} /></button>
        <button className="secondary-button compact" onClick={() => setCreatingNew(true)}><span>New</span></button>
      </div>
      <div className="context-strip"><span><Code2 size={12} />{activeProject?.name ?? projectName(active, snapshot?.projects ?? [])}</span><span>{active.cwd}</span></div>
      <div className="codex-collaboration-bar">
        <div className="codex-participants">{participants.length ? participants.map((participant) => <span key={participant.clientId} className={participant.clientId === active.controllerClientId ? 'is-controller' : ''} title={`${participant.deviceName} · ${participant.permissions.join(', ')}`}><i>{initials(participant.name)}</i>{participant.name}{participant.clientId === active.controllerClientId && <small>Controller</small>}</span>) : <span className="codex-participant-empty">Connecting participant presence…</span>}</div>
        {!hasControl && identity && <button className="text-button" onClick={() => void api.requestControl(active.id).catch(() => undefined)}>Request control</button>}
        {hasControl && <span className="codex-control-state"><ShieldCheck size={12} />You control this session</span>}
      </div>
      {device.status === 'offline' && <div className="codex-host-offline"><AlertTriangle size={15} /><span><strong>Session paused</strong><small>{device.name} is offline. Conversation history remains available and the thread will recover when the Agent reconnects.</small></span></div>}
      <div className="chat-feed" ref={scroll} onScroll={(event) => { followTranscript.current = isTranscriptNearBottom(event.currentTarget); }}>
        {active.events.length === 0 && <EmptyState icon={MessageSquare} title={canMessage ? 'Ready for direction' : `${titleCase(active.status)} session`} description={canMessage ? `Codex is running on ${device.name}. Ask it to inspect, build, test, or operate within this workspace.` : codexSessionUnavailableMessage(active.status)} />}
        {active.events.map((event) => {
          const latestAssistant = latestAssistantId === event.id;
          const hasTurnBoundary = Boolean(codexEventTurnId(event));
          return <CodexEventRow
            key={event.id}
            event={event}
            sources={codexMessageSources(active.events, event)}
            canBranch={event.type === 'assistant' && mobilityAvailable && Boolean(active.threadId) && device.status !== 'offline' && ['ready', 'completed', 'stopped'].includes(active.status) && (hasTurnBoundary || latestAssistant)}
            branching={branchingEventId === event.id}
            onBranch={() => branchFrom(event)}
          />;
        })}
        {active.pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} respond={(result) => request(() => api.respondApproval(active.id, approval.requestId, result))} registerMicroActions={(actions) => { if (actions) microApprovalActions.current.set(approval.id, actions); else microApprovalActions.current.delete(approval.id); }} />)}
        {['thinking', 'starting'].includes(active.status) && <div className="thinking"><i /><i /><i /><span>Codex is working</span></div>}
        {typingParticipants.length > 0 && <div className="codex-typing"><i /><i /><i /><span>{typingParticipants.map((participant) => participant.name).join(', ')} {typingParticipants.length === 1 ? 'is' : 'are'} typing</span></div>}
      </div>
      <CodexCommandCenter
        open={commandOpen}
        query={message.trimStart().startsWith('/') ? message.trim() : ''}
        initialView={commandInitialView}
        session={active}
        onClose={closeCommands}
        onNew={() => setCreatingNew(true)}
        onFork={() => setOperation('fork')}
        onResume={resume}
        onStop={() => request(() => api.stopSession(active.id)).then(() => undefined)}
        onInsert={(text) => setMessage((current) => current.trimStart().startsWith('/') ? text : `${current}${text}`)}
        onSend={sendText}
        onFocusComposer={() => composer.current?.focus()}
      />
      {mention.open && <DeviceMentionMenu suggestions={mention.suggestions} selectedIndex={mention.selectedIndex} onSelect={mention.select} />}
      <CodexDialOverlay ref={dialOverlay} sessionTitle={active.title} deviceName={device.name} />
      {voiceState.sessionId === active.id && voiceState.state !== 'idle' && <div className={`codex-voice-state codex-voice-state--${voiceState.state}`} role="status" aria-live="polite"><span>{voiceState.state === 'requesting-permission' ? 'Requesting microphone and Speech Recognition access…' : voiceState.state === 'listening' ? 'Listening through the macOS default input…' : voiceState.state === 'transcribing' ? 'Finishing local transcription…' : voiceState.code === 'permission-denied' ? 'Microphone or Speech Recognition permission denied.' : 'Voice transcription failed.'}</span>{voiceState.error && <small>{voiceState.error}</small>}</div>}
      {canMessage ? <form className="composer" onSubmit={send}>
        <textarea ref={composer} aria-label="Message Codex" rows={3} value={message} disabled={sending} onChange={(event) => { const next = event.target.value; setMessage(next); mention.setCaret(event.target.selectionStart ?? next.length); const opensCommands = next.trimStart().startsWith('/') && !next.includes('\n'); if (opensCommands) setCommandInitialView('commands'); setCommandOpen(opensCommands); }} onClick={mention.trackCaret} onKeyUp={mention.trackCaret} onSelect={mention.trackCaret} placeholder={active.status === 'thinking' ? 'Steer the active turn…' : `Message Codex on ${device.name}… Type @ for a fleet device.`} onKeyDown={(event) => { if (mention.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !commandOpen) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div><button type="button" className="codex-command-trigger" onClick={() => openCommands()}><CommandIcon size={13} />Commands<kbd>/</kbd></button><button type="button" className="codex-permission-trigger" disabled={!canChangePermissions} onClick={() => openCommands('permissions')} title="Change permissions for this Codex session"><ShieldCheck size={12} /><span>{titleCase(active.permissionMode)}</span><ChevronDown size={11} /></button><span className="composer-status">{active.status === 'thinking' ? 'Steering active turn · ' : ''}{titleCase(active.approvalPolicy)}</span><span className="composer-submit-actions">{active.status === 'thinking' && <button type="button" className="stop-generation-button" disabled={!active.turnId || interrupting} onClick={() => void interrupt()} aria-label="Stop Codex response" title="Stop Codex response">{interrupting ? <i /> : <Square size={11} fill="currentColor" />}</button>}<button className="send-button" disabled={!message.trim() || sending || commandOpen || mention.open} aria-label={active.status === 'thinking' ? 'Steer active turn' : 'Send message'}><Send size={16} /></button></span></div>
      </form> : <div className="composer composer--unavailable" role="status">
        <div className="composer-unavailable__message"><AlertTriangle size={15} /><span><strong>{titleCase(active.status)} session</strong><small>{active.status === 'stopped' && !device.capabilities.codex ? (codexInstalled ? `Codex CLI is installed on ${device.name}, but it must be authenticated before this thread can resume.` : `Codex CLI must be installed on ${device.name} before this thread can resume.`) : codexSessionUnavailableMessage(active.status)}</small></span></div>
        <div className="composer-unavailable__actions"><span><button type="button" className="codex-permission-trigger" disabled={!canChangePermissions} onClick={() => openCommands('permissions')} title="Change permissions for this Codex session"><ShieldCheck size={12} /><span>{titleCase(active.permissionMode)}</span><ChevronDown size={11} /></button> · {titleCase(active.approvalPolicy)}</span><span>{active.status === 'stopped' && <button className="secondary-button compact" disabled={!canResume} onClick={() => void resume().catch(() => undefined)} title={device.capabilities.codex ? 'Resume this Codex thread' : 'Authenticate Codex on this device before resuming'}><RotateCcw size={13} />Resume</button>}<button className="primary-button compact" onClick={() => setCreatingNew(true)}>New session</button></span></div>
      </div>}
    </div>
    {operation && <SessionOperationDialog operation={operation} session={active} devices={snapshot?.devices ?? []} projects={snapshot?.projects ?? []} onClose={() => setOperation(null)} onComplete={(session) => { if (session.deviceId === device.id) { setActiveId(session.id); setCreatingNew(false); } setOperation(null); }} />}
  </>);
}

function SessionOperationDialog({ operation, session, devices, projects, onClose, onComplete }: {
  operation: 'fork' | 'move'; session: CodexSession; devices: Device[]; projects: FleetProject[]; onClose(): void; onComplete(session: CodexSession): void;
}) {
  const { request } = useFleet();
  const candidates = devices.filter((candidate) => {
    if (!['online', 'busy'].includes(candidate.status) || !candidate.capabilities.codex || !candidate.capabilities.labels.includes('feature:codex-session-mobility')) return false;
    if (operation === 'move' && candidate.id === session.deviceId) return false;
    return !session.projectId || projects.some((project) => project.id === session.projectId && project.paths.some((entry) => entry.deviceId === candidate.id));
  });
  const [deviceId, setDeviceId] = useState(operation === 'fork' ? session.deviceId : (candidates[0]?.id ?? ''));
  const [title, setTitle] = useState(`${session.title} (fork)`);
  const [pending, setPending] = useState(false);
  const selected = devices.find((candidate) => candidate.id === deviceId);
  const mappedPath = session.projectId ? projects.find((project) => project.id === session.projectId)?.paths.find((entry) => entry.deviceId === deviceId)?.path : selected?.projectRoots[0];

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!deviceId || pending) return; setPending(true);
    try {
      const result = operation === 'fork'
        ? await request(() => api.forkSession(session.id, { deviceId, title }))
        : await request(() => api.moveSession(session.id, deviceId));
      onComplete(result);
    } finally { setPending(false); }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !pending) onClose(); }}>
    <form className="modal session-operation" onSubmit={submit}>
      <header><div><span className="eyebrow">Codex continuity</span><h2>{operation === 'fork' ? 'Fork session' : 'Move session'}</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={pending} aria-label="Close"><X size={18} /></button></header>
      <div className="session-operation__summary"><span>{operation === 'fork' ? <GitFork size={18} /> : <MoveRight size={18} />}</span><div><strong>{session.title}</strong><small>{operation === 'fork' ? 'Create an independent native Codex thread with the same history.' : 'Resume the same Codex thread on a new device, then stop the source.'}</small></div></div>
      <label>Destination device<select required value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">Select a compatible device</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {titleCase(candidate.status)}</option>)}</select></label>
      {operation === 'fork' && <label>Fork title<input required value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /></label>}
      <div className="session-operation__path"><Code2 size={14} /><span><small>Destination workspace</small><strong>{mappedPath ?? 'No compatible project mapping'}</strong></span></div>
      {!candidates.length && <div className="notice"><AlertTriangle size={15} />No online Codex device has a compatible project mapping.</div>}
      <div className="notice subtle"><ShieldCheck size={15} />Cross-device history is copied through a private, checksummed Agent handoff. The source stays active unless the destination starts successfully.</div>
      <footer><button type="button" className="secondary-button" onClick={onClose} disabled={pending}>Cancel</button><button className="primary-button" disabled={!deviceId || !mappedPath || pending}>{operation === 'fork' ? <GitFork size={14} /> : <MoveRight size={14} />}{pending ? 'Transferring…' : operation === 'fork' ? 'Fork session' : 'Move session'}</button></footer>
    </form>
  </div>;
}

function ApprovalCard({ approval, respond, registerMicroActions }: { approval: CodexApproval; respond(result: unknown): Promise<unknown>; registerMicroActions?(actions: { submit(): void; reject(): void } | null): void }) {
  const params = asRecord(approval.params); const questions = Array.isArray(params.questions) ? params.questions.map(asRecord) : [];
  const elicitation = approval.method === 'mcpServer/elicitation/request';
  const canAcceptForSession = Array.isArray(params.availableDecisions) && params.availableDecisions.includes('acceptForSession');
  const [answers, setAnswers] = useState<Record<string, string>>({}); const [content, setContent] = useState('{}'); const [pending, setPending] = useState(false); const [validationError, setValidationError] = useState<string | null>(null); const fields = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  async function answer(decision: 'accept' | 'acceptForSession' | 'decline') {
    if (pending) return;
    if (decision !== 'decline') {
      const missing = firstMissingApprovalQuestion(approval, answers);
      if (missing) {
        const id = missing.id;
        setValidationError(`Answer “${missing.label}” before submitting.`);
        fields.current.get(id)?.focus();
        void window.fleetDesktop?.codexMicro.signalFeedback('error');
        return;
      }
    }
    setValidationError(null); setPending(true);
    try { await respond(approvalResponse(approval, decision, answers, content)); void window.fleetDesktop?.codexMicro.signalFeedback('success'); }
    catch (error) { setValidationError(error instanceof Error ? error.message : 'The response could not be submitted.'); void window.fleetDesktop?.codexMicro.signalFeedback('error'); }
    finally { setPending(false); }
  }
  useEffect(() => {
    registerMicroActions?.({ submit: () => { void answer('accept'); }, reject: () => { void answer('decline'); } });
    return () => registerMicroActions?.(null);
  }, [registerMicroActions, answers, content, pending]);
  return <div className={`approval-card${validationError ? ' approval-card--invalid' : ''}`}>
    <div><ShieldCheck size={17} /><span><strong>{approval.method.includes('requestUserInput') ? 'Input required' : 'Approval required'}</strong><small>{approval.method}</small></span></div>
    <h4>{approval.title}</h4><MessageContent text={approval.detail} className="approval-card__detail" />
    {questions.map((question) => { const id = String(question.id ?? 'answer'); const options = Array.isArray(question.options) ? question.options.map(asRecord) : []; const fieldRef = (element: HTMLInputElement | HTMLSelectElement | null) => { if (element) fields.current.set(id, element); else fields.current.delete(id); }; return <label key={id}>{String(question.header ?? question.question ?? id)}{options.length ? <select ref={fieldRef} value={answers[id] ?? ''} onChange={(event) => { setValidationError(null); setAnswers((current) => ({ ...current, [id]: event.target.value })); }}><option value="">Select an answer</option>{options.map((option, index) => <option key={index} value={String(option.label ?? '')}>{String(option.label ?? '')}</option>)}</select> : <input ref={fieldRef} type={question.isSecret ? 'password' : 'text'} value={answers[id] ?? ''} onChange={(event) => { setValidationError(null); setAnswers((current) => ({ ...current, [id]: event.target.value })); }} placeholder={String(question.question ?? 'Enter a response')} />}</label>; })}
    {elicitation && <label>Structured response<textarea rows={3} value={content} onChange={(event) => setContent(event.target.value)} placeholder='{"field":"value"}' /></label>}
    {elicitation && typeof params.url === 'string' && <button className="text-button" onClick={() => void openRemoteDesktopUrl(params.url as string)}><ExternalLink size={13} />Open requested page</button>}
    {validationError && <div className="approval-card__validation" role="alert">{validationError}</div>}
    <div className="approval-actions"><button className="secondary-button" disabled={pending} onClick={() => void answer('decline')}><XCircle size={14} />Decline</button>{canAcceptForSession && <button className="secondary-button" disabled={pending} onClick={() => void answer('acceptForSession')}><ShieldCheck size={14} />Allow for session</button>}<button className="primary-button" disabled={pending} onClick={() => void answer('accept')}><Check size={14} />{questions.length ? 'Submit' : 'Approve'}</button></div>
  </div>;
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function NewCodexSession({ device, projects, pending, setPending, onCreated }: { device: Device; projects: FleetProject[]; pending: boolean; setPending(value: boolean): void; onCreated(session: CodexSession): void }) {
  const { snapshot, request } = useFleet();
  const [projectId, setProjectId] = useState('');
  const [cwd, setCwd] = useState(device.projectRoots[0] ?? '');
  const [permissionMode, setPermission] = useState<PermissionMode>('workspace-write');
  const [browsingWorkspace, setBrowsingWorkspace] = useState(false);
  const available = projects.filter((project) => project.paths.some((path) => path.deviceId === device.id));
  const codexInstalled = device.capabilities.codex || device.capabilities.labels.includes('codex:installed');

  useEffect(() => {
    setProjectId('');
    setCwd(device.projectRoots[0] ?? '');
    setBrowsingWorkspace(false);
  }, [device.id]);

  function chooseProject(id: string) {
    setProjectId(id);
    const path = projects.find((project) => project.id === id)?.paths.find((entry) => entry.deviceId === device.id)?.path;
    if (path) setCwd(path);
  }

  async function create(event: FormEvent) {
    event.preventDefault(); setPending(true);
    try {
      const session = await request(() => api.createSession({ deviceId: device.id, projectId: projectId || undefined, cwd, title: projectId ? `${projects.find((p) => p.id === projectId)?.name ?? 'Project'} session` : `Session on ${device.name}`, permissionMode, approvalPolicy: 'on-request' }));
      onCreated(session);
    } finally { setPending(false); }
  }

  return (
    <form className="launcher" onSubmit={create}>
      <div className="launcher__icon"><Bot size={28} /></div><h3>Start a Codex session</h3><p>Run Codex directly on this device, inside the workspace you choose.</p>
      <label>Project<select value={projectId} onChange={(event) => chooseProject(event.target.value)}><option value="">No registered project</option>{available.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      <label>Working directory<div className="workspace-input"><input required value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/workspace" /><button type="button" className="secondary-button" onClick={() => setBrowsingWorkspace(true)}><HardDrive size={14} />Browse</button></div></label>
      <label>Permissions<select value={permissionMode} onChange={(event) => setPermission(event.target.value as PermissionMode)}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></label>
      {!device.capabilities.codex && <div className="notice"><AlertTriangle size={15} />{codexInstalled ? 'Codex CLI is installed but is not authenticated. Run codex login on this device before starting a session.' : 'Codex CLI is not installed on this device.'}</div>}
      <button className="primary-button full" disabled={!device.capabilities.codex || !cwd || pending}><Play size={15} />{pending ? 'Starting…' : 'Start session'}</button>
      {browsingWorkspace && <WorkspacePathPicker device={device} storageConnections={snapshot?.v2.storageConnections ?? []} value={cwd} onChoose={setCwd} onClose={() => setBrowsingWorkspace(false)} />}
    </form>
  );
}

function projectName(session: CodexSession, projects: FleetProject[]): string { return projects.find((project) => project.id === session.projectId)?.name ?? 'Unregistered workspace'; }

function CodexEventRow({ event, sources = [], canBranch = false, branching = false, onBranch }: {
  event: CodexEvent;
  sources?: CodexMessageSource[];
  canBranch?: boolean;
  branching?: boolean;
  onBranch?(): void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [showSources, setShowSources] = useState(false);
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(event.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  }
  if (event.type === 'status') return <div className="event-status"><Clock3 size={12} />{event.text}</div>;
  if (event.type === 'command') return <div className="command-event"><div><SquareTerminal size={13} />Command</div><pre><code>{event.text}</code></pre></div>;
  if (event.type === 'file') return <div className="file-event"><Code2 size={14} /><code>{event.text}</code></div>;
  if (event.type === 'tool') return <div className="tool-event"><Zap size={14} /><MessageContent text={event.text} /></div>;
  if (event.type === 'plan') return <div className="plan-event"><Bot size={14} /><span><strong>Plan</strong><MessageContent text={event.text} /></span></div>;
  if (event.type === 'reasoning') return <details className="reasoning-event"><summary>Working notes</summary><MessageContent text={event.text} /></details>;
  return <div className={`chat-message chat-message--${event.type}`}>
    <div className="chat-message__meta"><strong>{event.type === 'user' ? event.actor?.name ?? 'You' : event.type === 'error' ? 'Error' : 'Codex'}</strong>{event.actor && <small>{event.actor.deviceName}</small>}<time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
    <MessageContent text={event.text} />
    {(event.type === 'user' || event.type === 'assistant') && <div className="chat-message__actions">
      <button type="button" onClick={() => void copy()} title={copied ? 'Copied' : 'Copy message'} aria-label={copied ? 'Message copied' : 'Copy message'}>{copied ? <Check size={11} /> : <Copy size={11} />}<span>{copied ? 'Copied' : 'Copy'}</span></button>
      {event.type === 'assistant' && <button type="button" disabled={!canBranch || branching} onClick={() => void onBranch?.()} title={canBranch ? 'Branch into a new chat from this response' : 'This response does not have an available turn boundary'} aria-label="Branch in new chat"><GitFork size={11} /><span>{branching ? 'Branching…' : 'Branch'}</span></button>}
      {sources.length > 0 && <button type="button" aria-expanded={showSources} onClick={() => setShowSources((value) => !value)} title="Show web sources"><BookOpen size={11} /><span>Sources</span><i>{sources.length}</i></button>}
    </div>}
    {showSources && sources.length > 0 && <div className="chat-message__sources" role="region" aria-label="Sources">
      {sources.map((source, index) => source.url
        ? <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><ExternalLink size={10} /><span>{source.title}</span></a>
        : <span key={`${source.title}-${index}`}><Clipboard size={10} /><span>Search: {source.title}</span></span>)}
    </div>}
  </div>;
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
}

function TerminalPanel({ device }: { device: Device }) {
  const { snapshot, request } = useFleet();
  const sessions = snapshot?.terminals.filter((session) => session.deviceId === device.id) ?? [];
  const liveSessions = sessions.filter(isLiveTerminalSession);
  const initialSession = preferredTerminalSession(liveSessions);
  const [activeId, setActiveId] = useState<string | null>(initialSession?.id ?? null);
  const [creatingNew, setCreatingNew] = useState(!initialSession);
  const [cwd, setCwd] = useState(device.projectRoots[0] ?? '');
  const active = creatingNew ? undefined : liveSessions.find((session) => session.id === activeId);
  useEffect(() => {
    if (creatingNew || (activeId && liveSessions.some((session) => session.id === activeId))) return;
    const preferred = preferredTerminalSession(liveSessions);
    if (preferred) setActiveId(preferred.id);
    else setCreatingNew(true);
  }, [activeId, creatingNew, liveSessions]);

  async function start() {
    const session = await request(() => api.createTerminal({ deviceId: device.id, cwd, cols: 100, rows: 32 }));
    setActiveId(session.id);
    setCreatingNew(false);
  }

  if (!active) return <div className="launcher"><div className="launcher__icon"><SquareTerminal size={28} /></div><h3>Open a remote shell</h3><p>Start an interactive PTY on {device.name}. Input and output stay within your Orchestra connection.</p><label>Working directory<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Home directory" /></label><button className="primary-button full" onClick={() => void start()}><Play size={15} />Open terminal</button></div>;

  return <div className="terminal-panel"><div className="terminal-toolbar"><label className="select-wrap"><SquareTerminal size={14} /><select value={active.id} onChange={(event) => { setActiveId(event.target.value); setCreatingNew(false); }}>{liveSessions.map((session, index) => <option value={session.id} key={session.id}>Terminal {index + 1} · {session.cwd} · {titleCase(session.status)}</option>)}</select><ChevronDown size={13} /></label><StatusBadge status={active.status} /><button className="icon-button" disabled={active.status !== 'open'} onClick={() => void request(() => api.stopTerminal(active.id)).catch(() => undefined)} aria-label="Stop terminal"><CircleStop size={16} /></button><button className="secondary-button compact" onClick={() => setCreatingNew(true)}>New</button></div><TerminalView session={active} /></div>;
}

function DeviceJobs({ device }: { device: Device }) {
  const { snapshot, request } = useFleet();
  const jobs = snapshot?.jobs.filter((job) => job.deviceId === device.id) ?? [];
  if (!jobs.length) return <EmptyState icon={Box} title="No jobs on this device" description="Jobs assigned to this device will appear here with live output and status." />;
  return <div className="device-job-list">{jobs.map((job) => <article className="device-job" key={job.id}><div><StatusBadge status={job.status} /><time>{relativeTime(job.createdAt)}</time></div><h4>{job.name}</h4><p>{job.phase ?? job.prompt ?? job.command}</p>{job.progress !== undefined && <div className="job-progress"><i style={{ width: `${job.progress}%` }} /></div>}{['running', 'queued', 'awaiting-approval', 'dispatching'].includes(job.status) && <button className="secondary-button" onClick={() => void request(() => api.cancelJob(job.id))}><CircleStop size={14} />Cancel</button>}</article>)}</div>;
}
