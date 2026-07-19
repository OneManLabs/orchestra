import {
  CODEX_MICRO_KEYCAPS,
  defaultCodexMicroPreferences,
  type CodexMicroActionId,
  type CodexMicroCommandSlot,
  type CodexMicroDeviceState,
  type CodexMicroDirection,
  type CodexMicroPreferences,
  type FleetSettings,
} from '@fleet/shared';
import { Battery, Check, Clock3, Database, Globe2, Keyboard, Lightbulb, RefreshCcw, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useFleet } from '../state/FleetContext';
import { PageHeader } from './JobsPage';

const actionOptions: Array<{ id: CodexMicroActionId; label: string }> = ([
  ['toggle-fast-mode', 'Toggle Fast mode'], ['approve', 'Approve request'], ['reject', 'Reject request'],
  ['fork-chat', 'Continue in a new chat'], ['push-to-talk', 'Push to talk'], ['send-message', 'Send composer'],
  ['open-feedback', 'Open feedback'], ['open-openai-docs', 'Open OpenAI docs'], ['toggle-terminal', 'Open terminal'],
  ['copy-chat-markdown', 'Copy chat as Markdown'], ['archive-chat', 'Archive chat'], ['new-chat', 'New chat'],
  ['open-browser', 'Open project website/browser'], ['toggle-pin', 'Pin or unpin chat'], ['toggle-review', 'Open review/diff'],
  ['run-primary-action', 'Run primary project action'], ['git-commit-push', 'Commit or push'], ['create-pull-request', 'Create pull request'],
  ['add-photos', 'Add photos'], ['open-settings', 'Open Fleet settings'], ['open-side-chat', 'Open Fleet System chat'],
  ['open-scheduled', 'Open automations'], ['increase-reasoning', 'Increase reasoning'], ['decrease-reasoning', 'Decrease reasoning'],
  ['open-folder', 'Open project/folder'], ['add-files', 'Attach files'], ['open-plugins', 'Open plugins and skills'],
  ['insert-yolo', 'Insert :yolo:'], ['insert-yeet', 'Insert :yeet:'], ['custom-shortcut', 'Custom Fleet shortcut'],
  ['toggle-plan-mode', 'Toggle plan mode'], ['navigate-forward', 'Navigate forward'], ['toggle-sidebar', 'Toggle sidebar'], ['navigate-back', 'Navigate back'],
] as const).map(([id, label]) => ({ id, label }));

const commandSlotLabels: Record<keyof CodexMicroPreferences['commandSlots'], string> = {
  ACT06: 'Command 1', ACT07: 'Command 2', ACT08: 'Command 3', ACT09: 'Command 4', ACT10_ACT11: 'Wide command', ACT12: 'Command 6',
};

const lightLabels = {
  off: 'Unassigned', idle: 'Idle', working: 'Working', unread: 'Completed · unread', 'awaiting-approval': 'Needs approval', error: 'Error',
} as const;

export function SettingsPage() {
  const { snapshot, request } = useFleet();
  const [form, setForm] = useState<FleetSettings | null>(snapshot?.settings ?? null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (snapshot?.settings) setForm(snapshot.settings); }, [snapshot?.settings]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    await request(() => api.updateSettings(form));
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }
  if (!form) return null;
  return <div className="page settings-page">
    <PageHeader eyebrow="Orchestra configuration" title="Settings" detail="Core identity, local desktop behavior, and Codex Micro controls" />
    <div className="settings-page__grid">
      <form onSubmit={submit}>
        <section className="settings-card"><header><Globe2 size={18} /><div><h2>Orchestra identity</h2><p>How this command center identifies itself.</p></div></header><label>Orchestra name<input value={form.fleetName} onChange={(event) => setForm({ ...form, fleetName: event.target.value })} /></label><label>Core URL<input value={form.coreUrl} readOnly /><small>Set the desktop Core URL with FLEET_CORE_URL or VITE_FLEET_CORE_URL.</small></label></section>
        <section className="settings-card"><header><Clock3 size={18} /><div><h2>Presence & retention</h2><p>Control health timing and audit history.</p></div></header><div className="form-grid"><label>Heartbeat interval (ms)<input type="number" min="1000" value={form.heartbeatIntervalMs} onChange={(event) => setForm({ ...form, heartbeatIntervalMs: Number(event.target.value) })} /></label><label>Offline after (ms)<input type="number" min="3000" value={form.offlineAfterMs} onChange={(event) => setForm({ ...form, offlineAfterMs: Number(event.target.value) })} /></label></div><label>Retain activity (days)<input type="number" min="1" max="3650" value={form.retainActivityDays} onChange={(event) => setForm({ ...form, retainActivityDays: Number(event.target.value) })} /></label></section>
        <section className="settings-card"><header><Database size={18} /><div><h2>Desktop startup</h2><p>Control services started alongside the Electron application.</p></div></header><label className="toggle-row"><div><strong>Start the local Agent automatically</strong><span>Register this computer and expose its real capabilities to the fleet.</span></div><input type="checkbox" checked={form.autoStartLocalAgent} onChange={(event) => setForm({ ...form, autoStartLocalAgent: event.target.checked })} /></label><div className="security-note"><ShieldCheck size={16} /><p>Renderer isolation and sandboxing are enabled. Orchestra HTTP requests and WebSocket events pass through a narrow, validated preload bridge.</p></div></section>
        <button className="primary-button save-settings"><Save size={15} />{saved ? <><Check size={15} />Saved</> : 'Save Fleet settings'}</button>
      </form>
      <CodexMicroSettings sessions={snapshot?.sessions ?? []} />
    </div>
  </div>;
}

function CodexMicroSettings({ sessions }: { sessions: NonNullable<ReturnType<typeof useFleet>['snapshot']>['sessions'] }) {
  const bridge = window.fleetDesktop?.codexMicro;
  const [device, setDevice] = useState<CodexMicroDeviceState | null>(null);
  const [draft, setDraft] = useState<CodexMicroPreferences>(defaultCodexMicroPreferences());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const availableSessions = useMemo(() => [...sessions]
    .filter((session) => session.kind !== 'fleet-system')
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)), [sessions]);

  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    void bridge.getState().then((state) => { if (mounted) { setDevice(state); setDraft(state.preferences); } });
    const off = bridge.onState((state) => { if (mounted) setDevice(state); });
    return () => { mounted = false; off(); };
  }, [bridge]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!bridge) return;
    setSaving(true);
    try {
      const state = await bridge.setPreferences(draft);
      setDevice(state);
      setDraft(state.preferences);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } finally { setSaving(false); }
  }

  function updateCommand(slotId: keyof CodexMicroPreferences['commandSlots'], patch: Partial<CodexMicroCommandSlot>): void {
    setDraft((current) => ({ ...current, commandSlots: { ...current.commandSlots, [slotId]: { ...current.commandSlots[slotId], ...patch } } }));
  }

  if (!bridge) return <section className="settings-card codex-micro-card"><header><Keyboard size={18} /><div><h2>Codex Micro</h2><p>Open this page in Orchestra Canvas for macOS to configure the locally paired controller.</p></div></header></section>;
  const status = device?.status ?? 'not-detected';
  return <form className="codex-micro-form" onSubmit={save}>
    <section className="settings-card codex-micro-card">
      <header><Keyboard size={18} /><div><h2>Codex Micro</h2><p>Control every Codex session in the fleet from the Micro paired to this Mac.</p></div><span className={`micro-connection micro-connection--${status}`}>{status.replace('-', ' ')}</span></header>
      <div className="micro-device-strip">
        <span><Battery size={14} /><strong>{device?.batteryPercent == null ? 'Battery —' : `${Math.round(device.batteryPercent)}%${device.isCharging ? ' · charging' : ''}`}</strong></span>
        <span>Firmware <strong>{device?.firmwareVersion ?? '—'}</strong></span>
        <span>Transport <strong>Bluetooth / USB-C</strong></span>
      </div>
      {device?.error && <div className="notice"><Lightbulb size={15} /><p>{device.error}</p></div>}
      {device?.inputMonitoringRequired && <div className="micro-permission"><div><ShieldCheck size={15} /><span><strong>Input Monitoring may be required</strong><small>Allow Orchestra Canvas, then reconnect the Micro.</small></span></div><button type="button" className="secondary-button compact" onClick={() => void bridge.openInputMonitoring()}>Open macOS Settings</button></div>}
      <div className="micro-permission"><div><ShieldCheck size={15} /><span><strong>Apple Speech permissions</strong><small>MIC records the current macOS default input and transcribes with Apple Speech Recognition. Audio is never sent to OpenAI.</small></span></div><span className="micro-permission__actions"><button type="button" className="secondary-button compact" onClick={() => void bridge.openVoicePrivacy('microphone')}>Microphone</button><button type="button" className="secondary-button compact" onClick={() => void bridge.openVoicePrivacy('speech-recognition')}>Speech Recognition</button></span></div>
      {device?.voice.state === 'error' && <div className="notice"><Lightbulb size={15} /><p>{device.voice.error ?? 'Native voice capture failed. Review macOS privacy permissions and try again.'}</p></div>}
      <div className="micro-header-actions"><label className="toggle-row"><div><strong>Enable Codex Micro</strong><span>Connect, receive controls, and drive RGB notifications.</span></div><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /></label><button type="button" className="secondary-button compact" onClick={() => void bridge.retry().then(setDevice)}><RefreshCcw size={13} />Reconnect</button></div>
    </section>

    <section className="settings-card codex-micro-card">
      <header><Lightbulb size={18} /><div><h2>Agent Keys & LED notifications</h2><p>Six keys track sessions across every Fleet device. Tap one from any app to bring Orchestra forward and open that chat.</p></div></header>
      <div className="micro-control-grid">
        <label>Agent source<select value={draft.sourceMode} onChange={(event) => setDraft({ ...draft, sourceMode: event.target.value as CodexMicroPreferences['sourceMode'] })}><option value="priority">Attention priority</option><option value="recent">Most recent</option><option value="pinned">Pinned sessions</option><option value="custom">Custom six slots</option></select></label>
        <label>Lighting brightness<div className="micro-range"><input type="range" min="0" max="1" step="0.05" value={draft.brightness} onChange={(event) => setDraft({ ...draft, brightness: Number(event.target.value) })} /><strong>{Math.round(draft.brightness * 100)}%</strong></div></label>
        <label>Lights off after<select value={draft.inactivityTimeoutMs ?? 0} onChange={(event) => setDraft({ ...draft, inactivityTimeoutMs: Number(event.target.value) || null })}><option value="0">Never</option><option value="300000">5 minutes</option><option value="900000">15 minutes</option><option value="1800000">30 minutes</option><option value="3600000">1 hour</option></select></label>
      </div>
      <div className="micro-agent-grid">{Array.from({ length: 6 }, (_, slot) => {
        const live = device?.slots[slot];
        return <article key={slot} className={`micro-agent micro-agent--${live?.lightStatus ?? 'off'}${live?.selected ? ' is-selected' : ''}`}><header><i /><span>Agent {slot + 1}</span><small>{lightLabels[live?.lightStatus ?? 'off']}</small></header>{draft.sourceMode === 'custom' ? <select aria-label={`Agent ${slot + 1} session`} value={draft.agentAssignments[slot] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, agentAssignments: current.agentAssignments.map((value, index) => index === slot ? event.target.value || null : value) }))}><option value="">Unassigned</option>{availableSessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {deviceName(session.deviceId, sessions)}</option>)}</select> : <div><strong>{live?.title ?? 'Unassigned'}</strong><small>{live?.deviceName ?? 'No Fleet session'}</small></div>}</article>;
      })}</div>
      {draft.sourceMode === 'pinned' && <div className="micro-pins"><strong>Sessions shown on Agent Keys</strong>{availableSessions.slice(0, 30).map((session) => <label key={session.id}><input type="checkbox" checked={draft.pinnedSessionIds.includes(session.id)} disabled={!draft.pinnedSessionIds.includes(session.id) && draft.pinnedSessionIds.length >= 6} onChange={(event) => setDraft((current) => ({ ...current, pinnedSessionIds: event.target.checked ? [...current.pinnedSessionIds, session.id].slice(0, 6) : current.pinnedSessionIds.filter((id) => id !== session.id) }))} /><span>{session.title}<small>{deviceName(session.deviceId, sessions)} · {session.status}</small></span></label>)}</div>}
      <div className="micro-led-legend"><span className="idle">Idle</span><span className="working">Thinking</span><span className="unread">Complete / unread</span><span className="approval">Approval / input</span><span className="error">Error</span></div>
    </section>

    <section className="settings-card codex-micro-card">
      <header><Keyboard size={18} /><div><h2>Command keycaps</h2><p>All supplied icon caps are available. The installed cap and its Fleet action remain independently configurable.</p></div></header>
      <div className="micro-command-grid">{(Object.keys(draft.commandSlots) as Array<keyof CodexMicroPreferences['commandSlots']>).map((slotId) => {
        const mapping = draft.commandSlots[slotId];
        const size = slotId === 'ACT10_ACT11' ? 'double' : 'single';
        return <article key={slotId} className={`micro-command micro-command--${size}`}><header><span>{commandSlotLabels[slotId]}</span><kbd>{mapping.keycapId === 'SPLIT' ? 'FORK' : mapping.keycapId}</kbd></header><label>Physical cap<select value={mapping.keycapId} onChange={(event) => { const definition = CODEX_MICRO_KEYCAPS.find((item) => item.id === event.target.value)!; updateCommand(slotId, { keycapId: definition.id, actionId: definition.defaultAction, customShortcut: undefined }); }}>{CODEX_MICRO_KEYCAPS.filter((item) => item.size === size).map((cap) => <option key={cap.id} value={cap.id}>{cap.id === 'SPLIT' ? 'FORK' : cap.id} · {cap.label}</option>)}</select></label><label>Fleet action<select value={mapping.actionId} onChange={(event) => updateCommand(slotId, { actionId: event.target.value as CodexMicroActionId })}>{actionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}</select></label>{mapping.actionId === 'custom-shortcut' && <label>Shortcut or command<input value={mapping.customShortcut ?? ''} onChange={(event) => updateCommand(slotId, { customShortcut: event.target.value })} placeholder="e.g. open diagnostics" /></label>}</article>;
      })}</div>
    </section>

    <section className="settings-card codex-micro-card">
      <header><Keyboard size={18} /><div><h2>Joystick & dial</h2><p>Navigate Fleet, trigger high-frequency actions, or control how deeply the selected agent reasons.</p></div></header>
      <div className="micro-joystick-grid">{(['up', 'left', 'right', 'down'] as CodexMicroDirection[]).map((direction) => <label key={direction}>{direction[0]!.toUpperCase() + direction.slice(1)}<select value={draft.joystick[direction]} onChange={(event) => setDraft((current) => ({ ...current, joystick: { ...current.joystick, [direction]: event.target.value as CodexMicroActionId } }))}>{actionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}</select></label>)}</div>
      <label className="micro-dial-mode">Dial mode<select value={draft.dialMode} onChange={(event) => setDraft({ ...draft, dialMode: event.target.value as CodexMicroPreferences['dialMode'] })}><option value="composer-navigation">Composer navigation — move through controls and press to open</option><option value="model-reasoning">Model + reasoning — rotate the full preset ladder; press to apply</option></select></label>
    </section>
    <button className="primary-button save-settings" disabled={saving}><Save size={15} />{saved ? <><Check size={15} />Saved</> : saving ? 'Saving…' : 'Save Codex Micro layout'}</button>
  </form>;
}

function deviceName(deviceId: string, sessions: Array<{ deviceId: string; participants?: Array<{ deviceName: string }> }>): string {
  return sessions.find((session) => session.deviceId === deviceId)?.participants?.[0]?.deviceName ?? deviceId.slice(0, 8);
}
