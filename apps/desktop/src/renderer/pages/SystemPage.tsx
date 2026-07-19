import type { FleetConductorPlan, FleetSystemConversation, FleetSystemMessage, FleetSystemReference } from '@fleet/shared';
import { Archive, Bot, Check, ChevronDown, Cpu, ExternalLink, ListChecks, MessageSquare, Plus, Send, Server, ShieldCheck, Sparkles, Trash2, WandSparkles, X, Zap } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { DeviceMentionMenu, useDeviceMentionComposer } from '../components/DeviceMentionComposer';
import { api } from '../lib/api';
import { relativeTime, titleCase } from '../lib/format';
import { isTranscriptNearBottom } from '../lib/transcript-scroll';
import { useFleet } from '../state/FleetContext';

export function SystemPage({
  onOpenDevice,
  onOpenCodex,
}: {
  onOpenDevice(deviceId: string): void;
  onOpenCodex(deviceId: string, sessionId?: string): void;
}) {
  const { snapshot, request } = useFleet();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [conductorMode, setConductorMode] = useState(false);
  const [pendingPlanId, setPendingPlanId] = useState<string>();
  const [viewedConversationId, setViewedConversationId] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const mention = useDeviceMentionComposer(draft, setDraft, snapshot?.devices ?? [], input);
  const activeConversation = snapshot?.systemConversation;
  const conversations = snapshot?.systemConversations ?? (activeConversation ? [activeConversation] : []);
  const conversation = conversations.find((candidate) => candidate.id === viewedConversationId) ?? activeConversation;
  const viewingHistory = Boolean(conversation && activeConversation && conversation.id !== activeConversation.id);
  const orchestrator = snapshot?.devices.find((device) => device.id === conversation?.orchestratorDeviceId)
    ?? snapshot?.devices.find((device) => device.id === snapshot.settings.systemOrchestratorDeviceId)
    ?? snapshot?.devices.find((device) => device.role === 'core');

  useEffect(() => {
    if (!followTail.current) return;
    const frame = requestAnimationFrame(() => {
      if (!followTail.current || !feed.current) return;
      feed.current.scrollTo({ top: feed.current.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation?.id, conversation?.updatedAt]);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending || viewingHistory) return;
    setSending(true);
    try {
      await request(() => api.sendSystemMessage(text, conductorMode ? 'conductor' : 'chat'));
      setDraft('');
    } finally {
      setSending(false);
      queueMicrotask(() => input.current?.focus());
    }
  }

  async function confirm(message: FleetSystemMessage): Promise<void> {
    if (viewingHistory) return;
    const action = conversation?.pendingActions.find((candidate) => candidate.id === message.pendingActionId);
    if (!action || action.status !== 'pending') return;
    await request(() => api.confirmSystemPowerAction(action.id, action.action, action.deviceIds));
  }

  async function executePlan(plan: FleetConductorPlan): Promise<void> {
    if (viewingHistory || pendingPlanId || plan.status !== 'proposed') return;
    setPendingPlanId(plan.id);
    try { await request(() => api.executeConductorPlan(plan.id)); }
    finally { setPendingPlanId(undefined); }
  }

  async function cancelPlan(plan: FleetConductorPlan): Promise<void> {
    if (viewingHistory || pendingPlanId || plan.status !== 'proposed') return;
    setPendingPlanId(plan.id);
    try { await request(() => api.cancelConductorPlan(plan.id)); }
    finally { setPendingPlanId(undefined); }
  }

  function openReference(reference: FleetSystemReference): void {
    if (reference.kind === 'codex-session' && reference.deviceId) {
      onOpenCodex(reference.deviceId, reference.sessionId);
      return;
    }
    if (reference.deviceId) onOpenDevice(reference.deviceId);
  }

  async function startNewConversation(): Promise<void> {
    if (resetting || activeConversation?.activeResponseMessageId) return;
    setResetting(true);
    try {
      await request(() => api.newSystemConversation());
      setViewedConversationId(undefined);
      followTail.current = true;
    } finally {
      setResetting(false);
    }
  }

  async function clearConversation(): Promise<void> {
    if (resetting || viewingHistory || !activeConversation?.messages.length || activeConversation.activeResponseMessageId) return;
    if (!window.confirm('Clear this Orchestra System conversation? This permanently removes its messages and resets the underlying Codex context.')) return;
    setResetting(true);
    try {
      await request(() => api.clearSystemConversation());
      setViewedConversationId(undefined);
      followTail.current = true;
    } finally {
      setResetting(false);
    }
  }

  if (!snapshot || !conversation || !activeConversation) return null;

  return <div className="system-page">
    <header className="system-page__header">
      <div className="system-page__identity"><span><Sparkles size={21} /></span><div><span className="eyebrow">Core-owned orchestration</span><h1>Orchestra System</h1><p>Manage the whole fleet, inspect live telemetry, and start device-hosted Codex conversations from one shared thread.</p></div></div>
      <div className="system-page__host"><span className={`status-dot status-dot--${orchestrator?.status === 'offline' ? 'offline' : 'online'}`} /><div><small>Orchestra Core host</small><strong>{orchestrator?.name ?? 'Waiting for Core device'}</strong></div><Server size={16} /></div>
    </header>

    <section className="system-chat">
      <div className="system-session-toolbar">
        <SystemConversationPicker
          conversations={conversations}
          activeId={activeConversation.id}
          selected={conversation}
          onSelect={(id) => {
            setViewedConversationId(id === activeConversation.id ? undefined : id);
            followTail.current = true;
          }}
        />
        <span className={`system-session-status system-session-status--${activeConversation.status ?? 'ready'}`}>{titleCase(activeConversation.status ?? 'ready')}</span>
        <button className="icon-button" disabled={resetting || viewingHistory || !activeConversation.messages.length || Boolean(activeConversation.activeResponseMessageId)} onClick={() => void clearConversation()} title="Clear active Orchestra System conversation"><Trash2 size={15} /></button>
        <button className="secondary-button compact" disabled={resetting || Boolean(activeConversation.activeResponseMessageId)} onClick={() => void startNewConversation()}><Plus size={13} /><span>New</span></button>
      </div>
      <div className="system-chat__context"><ShieldCheck size={14} /><span>{viewingHistory ? 'Viewing a preserved Orchestra System conversation. Return to the current conversation to send messages or approve actions.' : 'This conversation is stored by Orchestra Core. Messages from the MacBook, iPhone, and other authorized clients join the same ordered history.'}</span>{activeConversation.status === 'thinking' && <small>Codex is thinking…</small>}</div>
      <div
        className="system-chat__feed"
        ref={feed}
        tabIndex={0}
        onScroll={() => {
          const element = feed.current;
          if (!element) return;
          followTail.current = isTranscriptNearBottom(element);
        }}
      >
        {conversation.messages.length === 0 && <div className="system-chat-empty"><MessageSquare size={22} /><strong>Fresh Orchestra System conversation</strong><span>Ask about any device, preview, project, or Codex session. Type @ to target a fleet device.</span></div>}
        {conversation.messages.map((message, messageIndex) => {
          const pending = conversation.pendingActions.find((candidate) => candidate.id === message.pendingActionId);
          const plan = conversation.conductorPlans.find((candidate) => candidate.id === message.conductorPlanId);
          const showPlan = Boolean(plan && conversation.messages.findIndex((candidate) => candidate.conductorPlanId === plan.id) === messageIndex);
          return <article className={`system-message system-message--${message.role}`} key={message.id}>
            <div className="system-message__avatar">{message.role === 'user' ? (message.actor?.name.slice(0, 2).toUpperCase() ?? 'YOU') : <Bot size={15} />}</div>
            <div className="system-message__body">
              <header><strong>{message.role === 'user' ? message.actor?.name ?? 'You' : 'Orchestra System'}</strong>{message.actor?.deviceName && <small>{message.actor.deviceName}</small>}<time>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
              <p>{message.text}</p>
              {message.references.length > 0 && <div className="system-references">{message.references.map((reference) => <button key={reference.id} onClick={() => openReference(reference)}>
                <span>{reference.kind === 'codex-session' ? <Sparkles size={14} /> : <Cpu size={14} />}</span>
                <span><strong>{reference.label}</strong><small>{reference.detail ?? titleCase(reference.kind)}</small></span>
                <ExternalLink size={13} />
              </button>)}</div>}
              {pending && <div className={`system-confirmation system-confirmation--${pending.status}`}>
                <span><Zap size={14} /><strong>{titleCase(pending.action)}</strong><small>{pending.deviceIds.length} device{pending.deviceIds.length === 1 ? '' : 's'} · {titleCase(pending.status)}</small></span>
                {pending.status === 'pending' && !viewingHistory
                  ? <button className="primary-button compact" disabled={sending} onClick={() => void confirm(message)}><Check size={13} />Confirm once</button>
                  : <span className="system-confirmation__result">{pending.error ?? titleCase(pending.status)}</span>}
              </div>}
              {plan && showPlan && <ConductorPlanCard
                plan={plan}
                pending={pendingPlanId === plan.id}
                readOnly={viewingHistory}
                execute={() => void executePlan(plan)}
                cancel={() => void cancelPlan(plan)}
                openStep={(step) => {
                  if (step.sessionId && step.deviceId) onOpenCodex(step.deviceId, step.sessionId);
                  else if (step.previewUrl) {
                    if (window.fleetDesktop) void window.fleetDesktop.openExternal(step.previewUrl);
                    else window.open(step.previewUrl, '_blank', 'noopener,noreferrer');
                  } else if (step.deviceId) onOpenDevice(step.deviceId);
                }}
              />}
            </div>
          </article>;
        })}
        <div className="system-chat__tail" ref={tail} aria-hidden="true" />
      </div>

      {viewingHistory ? <div className="system-history-bar"><Archive size={15} /><span><strong>Conversation history</strong><small>This chat is preserved and read-only.</small></span><button className="secondary-button compact" onClick={() => setViewedConversationId(undefined)}>Return to current</button></div> : <form className="system-composer" onSubmit={send}>
        {mention.open && <DeviceMentionMenu suggestions={mention.suggestions} selectedIndex={mention.selectedIndex} onSelect={mention.select} />}
        <div className="system-composer__mode">
          <button type="button" className={conductorMode ? 'is-active' : ''} onClick={() => setConductorMode((current) => !current)} aria-pressed={conductorMode}>
            <WandSparkles size={13} /><span>Conductor</span><small>{conductorMode ? 'Draft a reviewable execution plan' : 'Chat normally'}</small>
          </button>
        </div>
        <div className="system-composer__examples">
          {['gpu temps on @demo-gpu', 'status of @demo-storage', 'start Codex on @demo-workstation to review Orchestra'].map((example) => <button type="button" key={example} onClick={() => { setDraft(example); input.current?.focus(); }}>{example}</button>)}
        </div>
        <div className="system-composer__input">
          {conductorMode ? <WandSparkles size={17} /> : <MessageSquare size={17} />}
          <textarea
            ref={input}
            rows={2}
            value={draft}
            disabled={sending}
            placeholder={conductorMode ? 'Describe the outcome… Orchestra will propose a plan before running anything' : 'Ask Orchestra System… Type @ to target a device'}
            onChange={(event) => { setDraft(event.target.value); mention.setCaret(event.target.selectionStart ?? event.target.value.length); }}
            onClick={mention.trackCaret}
            onKeyUp={mention.trackCaret}
            onSelect={mention.trackCaret}
            onKeyDown={(event) => {
              if (mention.onKeyDown(event)) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button className="send-button" disabled={!draft.trim() || sending} aria-label="Send to Orchestra System"><Send size={16} /></button>
        </div>
        <footer><span>{conductorMode ? <><strong>Conductor</strong> plan · review · approve · dispatch</> : <><strong>@device</strong> telemetry · orchestration · confirmed controls</>}</span><span>Owned by Orchestra Core</span></footer>
      </form>}
    </section>
  </div>;
}

function ConductorPlanCard({ plan, pending, readOnly, execute, cancel, openStep }: {
  plan: FleetConductorPlan;
  pending: boolean;
  readOnly: boolean;
  execute(): void;
  cancel(): void;
  openStep(step: FleetConductorPlan['steps'][number]): void;
}) {
  const blocked = plan.steps.filter((step) => step.status === 'blocked').length;
  return <section className={`conductor-plan conductor-plan--${plan.status}`}>
    <header><span><WandSparkles size={15} /></span><div><small>Conductor plan</small><strong>{plan.title}</strong></div><em>{titleCase(plan.status)}</em></header>
    <div className="conductor-plan__steps">{plan.steps.map((step, index) => <button type="button" key={step.id} disabled={!step.deviceId && !step.previewUrl} onClick={() => openStep(step)}>
      <i className={`conductor-step-state conductor-step-state--${step.status}`}>{index + 1}</i>
      <span><strong>{step.title}</strong><small>{step.detail}</small>{step.selectionReason && <em>{step.selectionReason}</em>}{step.error && step.error !== step.detail && <b>{step.error}</b>}</span>
      {(step.sessionId || step.previewUrl || step.deviceId) && <ExternalLink size={12} />}
    </button>)}</div>
    {plan.status === 'proposed' && !readOnly && <footer>
      <span>{blocked ? `${blocked} blocked step${blocked === 1 ? '' : 's'} will not run` : 'No action occurs until approval'}</span>
      <button type="button" className="text-button" disabled={pending} onClick={cancel}><X size={12} />Cancel</button>
      <button type="button" className="primary-button compact" disabled={pending || plan.steps.every((step) => step.status === 'blocked')} onClick={execute}><ListChecks size={13} />{pending ? 'Dispatching…' : 'Approve & Run'}</button>
    </footer>}
  </section>;
}

function SystemConversationPicker({
  conversations,
  activeId,
  selected,
  onSelect,
}: {
  conversations: FleetSystemConversation[];
  activeId: string;
  selected: FleetSystemConversation;
  onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const selectedIndex = conversations.findIndex((conversation) => conversation.id === selected.id);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selected.id, conversations]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(`[data-system-conversation-index="${highlightedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  function choose(id: string): void {
    onSelect(id);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlightedIndex((current) => (current + direction + conversations.length) % conversations.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setHighlightedIndex(event.key === 'Home' ? 0 : conversations.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const conversation = conversations[highlightedIndex];
      if (conversation) choose(conversation.id);
    }
  }

  return <div className={`system-conversation-picker ${open ? 'is-open' : ''}`} ref={root}>
    <button
      ref={trigger}
      type="button"
      className="system-conversation-picker__trigger"
      aria-haspopup="listbox"
      aria-controls={menuId}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={keyDown}
    >
      <span className="session-picker__icon"><Bot size={14} /></span>
      <span className="session-picker__selection"><strong>{systemConversationLabel(selected)}</strong><small><i className={`session-picker__status session-picker__status--${selected.status ?? 'ready'}`} />{selected.id === activeId ? 'Current conversation' : `${selected.messages.length} messages · ${relativeTime(selected.updatedAt)}`}</small></span>
      <ChevronDown size={14} />
    </button>
    {open && <div className="system-conversation-picker__menu">
      <header><span><strong>Orchestra System conversations</strong><small>Switch between the current chat and preserved history</small></span><kbd>↑↓</kbd></header>
      <div id={menuId} role="listbox" aria-label="Orchestra System conversations">
        {conversations.map((conversation, index) => <button
          type="button"
          role="option"
          key={conversation.id}
          data-system-conversation-index={index}
          aria-selected={conversation.id === selected.id}
          className={`${conversation.id === selected.id ? 'is-selected' : ''} ${index === highlightedIndex ? 'is-highlighted' : ''}`.trim()}
          onMouseEnter={() => setHighlightedIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(conversation.id)}
        >
          <i className={`session-picker__status session-picker__status--${conversation.status ?? 'ready'}`} />
          <span><strong>{systemConversationLabel(conversation)}</strong><small>{conversation.id === activeId ? 'Current' : relativeTime(conversation.updatedAt)} · {conversation.messages.length} messages</small></span>
          {conversation.id === selected.id && <Check size={14} />}
        </button>)}
      </div>
    </div>}
  </div>;
}

function systemConversationLabel(conversation: { title: string; messages: FleetSystemMessage[] }): string {
  const firstUserMessage = conversation.messages.find((message) => message.role === 'user')?.text.trim();
  return firstUserMessage || conversation.title;
}
