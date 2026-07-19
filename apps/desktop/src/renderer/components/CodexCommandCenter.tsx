import type { CodexEvent, CodexSession, CodexUiRpcMethod, PermissionMode } from '@fleet/shared';
import {
  Archive, Bot, BrainCircuit, Check, ChevronLeft, CircleStop, Clipboard, Code2, Command,
  FileDiff, GitFork, Goal, ListFilter, MemoryStick, MessageSquare, Package, Plug, Search,
  Settings2, ShieldCheck, Sparkles, Trash2, Undo2, Wrench, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { codexModelIdentifier, preferredCodexModelIdentifier } from '../lib/codex-model-settings';
import { titleCase } from '../lib/format';
import { useFleet } from '../state/FleetContext';

type CommandCategory = 'Session' | 'Agent' | 'Context' | 'Extensions' | 'Account';
type ArgumentCommand = 'rename' | 'review' | 'goal' | 'mention' | 'feedback';

export interface CodexCommandDefinition {
  id: string;
  title: string;
  description: string;
  category: CommandCategory;
  keywords?: string;
}

/** Mirrors agent-affecting Codex CLI commands; Orchestra-specific chrome commands live in Orchestra itself. */
export const CODEX_COMMANDS: readonly CodexCommandDefinition[] = [
  { id: 'model', title: 'Model & reasoning', description: 'Choose a model and its default reasoning effort', category: 'Agent', keywords: 'reasoning effort' },
  { id: 'permissions', title: 'Permissions', description: 'Change sandbox and approval behavior', category: 'Agent', keywords: 'sandbox approval' },
  { id: 'plan', title: 'Plan mode', description: 'Switch between Plan and Default collaboration modes', category: 'Agent' },
  { id: 'personality', title: 'Personality', description: 'Choose Codex’s communication style', category: 'Agent' },
  { id: 'memories', title: 'Memories', description: 'Enable or disable memory for this thread', category: 'Agent', keywords: 'memory' },
  { id: 'experimental', title: 'Experimental features', description: 'Inspect and toggle Codex feature flags', category: 'Agent', keywords: 'features beta' },
  { id: 'compact', title: 'Compact conversation', description: 'Summarize context to make room for more work', category: 'Session' },
  { id: 'review', title: 'Review changes', description: 'Review uncommitted changes or custom instructions', category: 'Session' },
  { id: 'rename', title: 'Rename thread', description: 'Give this Codex thread a new name', category: 'Session' },
  { id: 'goal', title: 'Goal', description: 'Set or inspect the long-running thread goal', category: 'Session', keywords: 'objective budget' },
  { id: 'new', title: 'New thread', description: 'Start a fresh Codex conversation', category: 'Session' },
  { id: 'fork', title: 'Fork thread', description: 'Create an independent thread with this history', category: 'Session' },
  { id: 'resume', title: 'Resume thread', description: 'Resume this saved thread', category: 'Session' },
  { id: 'undo', title: 'Undo last turn', description: 'Remove the last turn from Codex history', category: 'Session', keywords: 'rollback' },
  { id: 'archive', title: 'Archive thread', description: 'Archive this thread and stop its session', category: 'Session' },
  { id: 'delete', title: 'Delete thread', description: 'Permanently delete this Codex thread', category: 'Session' },
  { id: 'clear', title: 'Clear into new thread', description: 'Start a fresh conversation from this workspace', category: 'Session' },
  { id: 'side', title: 'Side conversation', description: 'Fork this history into an independent side thread', category: 'Session', keywords: 'btw' },
  { id: 'quit', title: 'Stop session', description: 'Stop the active Codex process', category: 'Session', keywords: 'exit' },
  { id: 'init', title: 'Create AGENTS.md', description: 'Ask Codex to generate repository guidance', category: 'Context' },
  { id: 'mention', title: 'Mention a file', description: 'Search the workspace and add a file reference', category: 'Context', keywords: 'file search' },
  { id: 'diff', title: 'Changes & diff', description: 'Inspect file-change items in the current thread', category: 'Context' },
  { id: 'status', title: 'Session status', description: 'Inspect thread configuration, history, and token usage', category: 'Context' },
  { id: 'raw', title: 'Raw thread items', description: 'Inspect the structured app-server items', category: 'Context', keywords: 'debug json' },
  { id: 'copy', title: 'Copy last response', description: 'Copy the last assistant message as Markdown', category: 'Context' },
  { id: 'agent', title: 'Agent threads', description: 'List loaded main, side, and sub-agent threads', category: 'Context', keywords: 'subagents multi agent' },
  { id: 'ps', title: 'Background terminals', description: 'Inspect processes started by this thread', category: 'Context', keywords: 'shell process' },
  { id: 'stop', title: 'Stop background terminals', description: 'Stop all background terminals for this thread', category: 'Context', keywords: 'clean ps' },
  { id: 'skills', title: 'Skills', description: 'Browse installed skills and insert one into the composer', category: 'Extensions' },
  { id: 'hooks', title: 'Hooks', description: 'Inspect lifecycle hooks active for this workspace', category: 'Extensions' },
  { id: 'mcp', title: 'MCP servers', description: 'Inspect configured MCP servers, tools, and resources', category: 'Extensions' },
  { id: 'apps', title: 'Apps', description: 'Browse apps and connectors available to Codex', category: 'Extensions' },
  { id: 'plugins', title: 'Plugins', description: 'Browse Codex plugin marketplaces and installed plugins', category: 'Extensions' },
  { id: 'import', title: 'Import from Claude Code', description: 'Detect portable settings, MCP servers, and guidance', category: 'Extensions' },
  { id: 'usage', title: 'Usage', description: 'Inspect account token usage', category: 'Account' },
  { id: 'limits', title: 'Rate limits', description: 'Inspect current Codex usage limits and resets', category: 'Account' },
  { id: 'debug-config', title: 'Effective configuration', description: 'Show config layers and requirement sources', category: 'Account', keywords: 'config status' },
  { id: 'feedback', title: 'Send feedback', description: 'Send optional logs and comments to Codex maintainers', category: 'Account' },
  { id: 'logout', title: 'Log out', description: 'Remove Codex authentication on this device', category: 'Account' },
] as const;

interface Choice {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  run(): Promise<void> | void;
}

export function CodexCommandCenter({
  open, query, initialView = 'commands', session, onClose, onNew, onFork, onResume, onStop, onInsert, onSend, onFocusComposer,
}: {
  open: boolean;
  query: string;
  initialView?: 'commands' | 'permissions';
  session: CodexSession;
  onClose(): void;
  onNew(): void;
  onFork(): void;
  onResume(): Promise<void>;
  onStop(): Promise<void>;
  onInsert(text: string): void;
  onSend(text: string): Promise<void>;
  onFocusComposer(): void;
}) {
  const { request } = useFleet();
  const [argument, setArgument] = useState<ArgumentCommand | null>(null);
  const [argumentValue, setArgumentValue] = useState('');
  const [choices, setChoices] = useState<{ title: string; detail: string; items: Choice[] } | null>(null);
  const [result, setResult] = useState<{ title: string; value: unknown } | null>(null);
  const [confirming, setConfirming] = useState<'archive' | 'delete' | 'logout' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLElement>(null);
  const threadId = session.threadId;

  useEffect(() => {
    if (!open) return;
    setArgument(null); setArgumentValue(''); setChoices(null); setResult(null); setConfirming(null); setError(''); setSelectedIndex(0);
    if (initialView === 'permissions') {
      if (threadId) void loadPermissions();
      else setError('This command needs an active Codex thread.');
    }
  }, [open, initialView, session.id]);

  const commands = useMemo(() => {
    return filterCodexCommands(query);
  }, [query]);

  useEffect(() => { setSelectedIndex(0); }, [query, argument, choices, result, confirming]);

  useEffect(() => {
    if (!open) return;
    popover.current?.querySelector<HTMLElement>(`[data-codex-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (argument) setArgument(null);
        else if (choices) setChoices(null);
        else if (result) setResult(null);
        else if (confirming) setConfirming(null);
        else onClose();
        queueMicrotask(onFocusComposer);
        return;
      }
      if (argument || result || confirming || busy) return;
      const count = choices ? choices.items.length : commands.length;
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) {
        event.preventDefault(); event.stopPropagation();
        const direction = event.key;
        setSelectedIndex((current) => nextCommandIndex(current, count, direction));
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && count > 0) {
        event.preventDefault(); event.stopPropagation();
        if (choices) void choices.items[selectedIndex]?.run();
        else {
          const command = commands[selectedIndex];
          if (command) void choose(command);
        }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [open, argument, choices, result, confirming, busy, commands, selectedIndex]);

  if (!open) return null;

  async function rpc<T = unknown>(method: CodexUiRpcMethod, params?: unknown): Promise<T> {
    setBusy(true); setError('');
    try { return (await request(() => api.codexRpc<T>(session.id, method, params))).result; }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); throw value; }
    finally { setBusy(false); }
  }

  async function showRpc(title: string, method: CodexUiRpcMethod, params?: unknown): Promise<void> {
    try { setResult({ title, value: await rpc(method, params) }); }
    catch { /* request() already exposes and records the error */ }
  }

  function requireThread(): string | undefined {
    if (threadId) return threadId;
    setError('This command needs an active Codex thread.');
    return undefined;
  }

  async function choose(command: CodexCommandDefinition): Promise<void> {
    setError('');
    const id = command.id;
    if (id === 'new' || id === 'clear') { onNew(); onClose(); return; }
    if (id === 'fork' || id === 'side') { onFork(); onClose(); return; }
    if (id === 'resume') { await onResume(); onClose(); return; }
    if (id === 'quit') { await onStop(); onClose(); return; }
    if (id === 'copy') {
      const message = [...session.events].reverse().find((event) => event.type === 'assistant')?.text;
      if (!message) { setError('This thread does not have an assistant response to copy yet.'); return; }
      await navigator.clipboard.writeText(message); onClose(); return;
    }
    if (id === 'init') {
      await onSend('Create an AGENTS.md file for this repository. Inspect the project first, capture its real build and test commands, and keep the guidance concise.');
      onClose(); return;
    }
    if (id === 'rename' || id === 'review' || id === 'goal' || id === 'mention' || id === 'feedback') {
      setArgument(id); setArgumentValue(''); return;
    }
    if (id === 'archive' || id === 'delete' || id === 'logout') { setConfirming(id); return; }
    const activeThread = requireThread();
    if (!activeThread) return;

    if (id === 'compact') { await showRpc('Conversation compacted', 'thread/compact/start', { threadId: activeThread }); return; }
    if (id === 'undo') { await showRpc('Last turn removed', 'thread/rollback', { threadId: activeThread, numTurns: 1 }); return; }
    if (id === 'diff') {
      try {
        const response = record(await rpc('thread/items/list', { threadId: activeThread, limit: 100 }));
        setResult({ title: 'Thread changes', value: { data: array(response.data).filter((item) => record(item).type === 'fileChange') } });
      } catch { /* surfaced above */ }
      return;
    }
    if (id === 'raw') { await showRpc('Raw thread items', 'thread/items/list', { threadId: activeThread, limit: 100 }); return; }
    if (id === 'status') { await showRpc('Session status', 'thread/read', { threadId: activeThread, includeTurns: true }); return; }
    if (id === 'agent') { await showRpc('Loaded agent threads', 'thread/loaded/list', {}); return; }
    if (id === 'ps') { await showRpc('Background terminals', 'thread/backgroundTerminals/list', { threadId: activeThread, limit: 100 }); return; }
    if (id === 'stop') { await showRpc('Background terminals stopped', 'thread/backgroundTerminals/clean', { threadId: activeThread }); return; }
    if (id === 'hooks') { await showRpc('Workspace hooks', 'hooks/list', { cwds: [session.cwd] }); return; }
    if (id === 'mcp') { await showRpc('MCP servers', 'mcpServerStatus/list', { threadId: activeThread, limit: 100, detail: 'full' }); return; }
    if (id === 'apps') { await showRpc('Apps and connectors', 'app/list', { threadId: activeThread, limit: 100 }); return; }
    if (id === 'plugins') { await showRpc('Plugin marketplaces', 'plugin/list', { cwds: [session.cwd] }); return; }
    if (id === 'import') { await showRpc('Importable Claude Code configuration', 'externalAgentConfig/detect', { cwds: [session.cwd], includeHome: true }); return; }
    if (id === 'usage') { await showRpc('Account usage', 'account/usage/read'); return; }
    if (id === 'limits') { await showRpc('Rate limits', 'account/rateLimits/read'); return; }
    if (id === 'debug-config') { await showRpc('Effective Codex configuration', 'config/read', { cwd: session.cwd, includeLayers: true }); return; }
    if (id === 'model') { await loadModels(activeThread); return; }
    if (id === 'permissions') { await loadPermissions(); return; }
    if (id === 'personality') { loadPersonalities(activeThread); return; }
    if (id === 'memories') { loadMemories(activeThread); return; }
    if (id === 'plan') { await loadModes(activeThread); return; }
    if (id === 'experimental') { await loadExperimental(); return; }
    if (id === 'skills') { await loadSkills(); }
  }

  async function loadModels(activeThread: string): Promise<void> {
    try {
      const response = record(await rpc('model/list', { limit: 100 }));
      const models = array(response.data).map(record).filter((model) => Boolean(codexModelIdentifier(model)));
      setChoices({ title: 'Model & reasoning', detail: 'Models are provided by the Codex installation on this device.', items: models.map((model) => {
        const modelIdentifier = codexModelIdentifier(model)!;
        return {
          id: modelIdentifier,
          title: string(model.displayName) || modelIdentifier,
          detail: string(model.description),
          meta: model.isDefault ? 'Default' : undefined,
          run: async () => {
            const efforts = array(model.supportedReasoningEfforts).map(record);
            if (efforts.length) {
              setChoices({ title: `${string(model.displayName) || modelIdentifier} reasoning`, detail: 'Choose how much reasoning Codex should use for subsequent turns.', items: efforts.map((effort) => ({
                id: string(effort.reasoningEffort), title: titleCase(string(effort.reasoningEffort)), detail: string(effort.description), meta: effort.reasoningEffort === model.defaultReasoningEffort ? 'Default' : undefined,
                run: async () => { await rpc('thread/settings/update', { threadId: activeThread, model: modelIdentifier, effort: string(effort.reasoningEffort) }); onClose(); },
              })) });
            } else {
              await rpc('thread/settings/update', { threadId: activeThread, model: modelIdentifier, effort: string(model.defaultReasoningEffort) || null });
              onClose();
            }
          },
        };
      }) });
    } catch { /* surfaced above */ }
  }

  async function loadPermissions(): Promise<void> {
    const permission = (id: PermissionMode, title: string, detail: string): Choice => ({
      id, title, detail, meta: session.permissionMode === id ? 'Active' : undefined,
      run: async () => {
        setBusy(true); setError('');
        try { await request(() => api.updateSessionPermission(session.id, id)); onClose(); }
        catch (value) { setError(value instanceof Error ? value.message : String(value)); }
        finally { setBusy(false); }
      },
    });
    const defaults = [
      permission('read-only', 'Read only', 'Inspect and plan without workspace writes.'),
      permission('workspace-write', 'Workspace', 'Write inside the workspace and ask before escalation.'),
      permission('danger-full-access', 'Full access', "Remove the filesystem sandbox. Keeps this thread's approval policy."),
    ];
    const detail = session.status === 'stopped'
      ? 'Choose the sandbox for this thread when it resumes.'
      : 'Changes apply to subsequent Codex actions in this thread.';
    setChoices({ title: 'Permissions', detail, items: defaults });
  }

  function loadPersonalities(activeThread: string): void {
    setChoices({ title: 'Personality', detail: 'Changes the communication style used on subsequent turns.', items: ([
      ['friendly', 'Friendly', 'Warm and conversational'], ['pragmatic', 'Pragmatic', 'Direct and execution-focused'], ['none', 'None', 'Use the model default'],
    ] as const).map(([id, title, detail]) => ({ id, title, detail, run: async () => { await rpc('thread/settings/update', { threadId: activeThread, personality: id }); onClose(); } })) });
  }

  function loadMemories(activeThread: string): void {
    setChoices({ title: 'Memories', detail: 'Control whether Codex memory is available to this thread.', items: [
      { id: 'enabled', title: 'Enabled', detail: 'Allow memory use and generation.', run: async () => { await rpc('thread/memoryMode/set', { threadId: activeThread, mode: 'enabled' }); onClose(); } },
      { id: 'disabled', title: 'Disabled', detail: 'Do not use memory in this thread.', run: async () => { await rpc('thread/memoryMode/set', { threadId: activeThread, mode: 'disabled' }); onClose(); } },
    ] });
  }

  async function loadModes(activeThread: string): Promise<void> {
    try {
      const response = record(await rpc('collaborationMode/list', {}));
      const modelResponse = record(await rpc('model/list', { limit: 100 }));
      const modes = array(response.data).map(record);
      const models = array(modelResponse.data).map(record);
      setChoices({ title: 'Collaboration mode', detail: 'Plan mode explores and clarifies before implementation.', items: modes.map((mode) => ({
        id: string(mode.name), title: titleCase(string(mode.name)), meta: string(mode.mode),
        detail: [string(mode.model), string(mode.reasoning_effort)].filter(Boolean).join(' · '),
        run: async () => {
          const model = preferredCodexModelIdentifier(models, mode.model, session.model);
          if (!model) throw new Error('Codex did not report a usable model for this collaboration mode.');
          await rpc('thread/settings/update', { threadId: activeThread, collaborationMode: { mode: string(mode.mode) || 'default', settings: { model, reasoning_effort: string(mode.reasoning_effort) || null, developer_instructions: null } } });
          onClose();
        },
      })) });
    } catch { /* surfaced above */ }
  }

  async function loadExperimental(): Promise<void> {
    try {
      const response = record(await rpc('experimentalFeature/list', { limit: 100 }));
      const features = array(response.data).map(record);
      setChoices({ title: 'Experimental features', detail: 'Feature changes apply to this running Codex app-server.', items: features.map((feature) => ({
        id: string(feature.name), title: string(feature.displayName) || string(feature.name), detail: string(feature.description), meta: feature.enabled ? 'Enabled' : 'Disabled',
        run: async () => { await rpc('experimentalFeature/enablement/set', { enablement: { [string(feature.name)]: !feature.enabled } }); await loadExperimental(); },
      })) });
    } catch { /* surfaced above */ }
  }

  async function loadSkills(): Promise<void> {
    try {
      const response = record(await rpc('skills/list', { cwds: [session.cwd] }));
      const skills = array(response.data).flatMap((entry) => array(record(entry).skills)).map(record);
      setChoices({ title: 'Skills', detail: 'Choose a skill to mention it in your next message.', items: skills.map((skill) => ({
        id: string(skill.name), title: `$${string(skill.name)}`, detail: string(skill.description) || string(skill.shortDescription), meta: skill.enabled === false ? 'Disabled' : string(skill.scope),
        run: () => { onInsert(`$${string(skill.name)} `); onClose(); },
      })) });
    } catch { /* surfaced above */ }
  }

  async function submitArgument(event: FormEvent): Promise<void> {
    event.preventDefault();
    const activeThread = requireThread();
    if (!activeThread || !argument) return;
    const value = argumentValue.trim();
    if (argument === 'rename') {
      if (!value) { setError('Enter a thread name.'); return; }
      await showRpc('Thread renamed', 'thread/name/set', { threadId: activeThread, name: value }); return;
    }
    if (argument === 'review') {
      await showRpc('Review started', 'review/start', { threadId: activeThread, target: value ? { type: 'custom', instructions: value } : { type: 'uncommittedChanges' }, delivery: 'inline' }); return;
    }
    if (argument === 'goal') {
      if (!value) { await showRpc('Thread goal', 'thread/goal/get', { threadId: activeThread }); return; }
      await showRpc('Goal updated', 'thread/goal/set', { threadId: activeThread, objective: value }); return;
    }
    if (argument === 'feedback') {
      if (!value) { setError('Tell the maintainers what happened.'); return; }
      await showRpc('Feedback sent', 'feedback/upload', { classification: 'other', reason: value, threadId: activeThread, includeLogs: true, tags: { client: 'fleet-canvas' } }); return;
    }
    if (argument === 'mention') {
      if (!value) { setError('Enter part of a filename.'); return; }
      try {
        const response = record(await rpc('fuzzyFileSearch', { query: value, roots: [session.cwd], cancellationToken: null }));
        const files = array(response.files).map(record);
        setArgument(null);
        setChoices({ title: 'Mention a file', detail: `Matches in ${session.cwd}`, items: files.map((file) => ({
          id: string(file.path), title: string(file.file_name) || string(file.path), detail: string(file.path), meta: string(file.match_type),
          run: () => { onInsert(`@${string(file.path)} `); onClose(); },
        })) });
      } catch { /* surfaced above */ }
    }
  }

  async function confirm(): Promise<void> {
    if (!confirming) return;
    const activeThread = confirming === 'logout' ? threadId : requireThread();
    if (confirming !== 'logout' && !activeThread) return;
    try {
      if (confirming === 'archive') await rpc('thread/archive', { threadId: activeThread });
      if (confirming === 'delete') await rpc('thread/delete', { threadId: activeThread });
      if (confirming === 'logout') await rpc('account/logout');
      if (confirming !== 'logout') await onStop();
      onClose();
    } catch { /* surfaced above */ }
  }

  const back = (action: () => void) => { action(); queueMicrotask(onFocusComposer); };
  const body = confirming ? <ConfirmView kind={confirming} busy={busy} onBack={() => back(() => setConfirming(null))} onConfirm={() => void confirm()} />
    : argument ? <ArgumentView command={argument} value={argumentValue} busy={busy} inputRef={input} onChange={setArgumentValue} onBack={() => back(() => setArgument(null))} onSubmit={(event) => void submitArgument(event)} />
      : choices ? <ChoiceView title={choices.title} detail={choices.detail} items={choices.items} busy={busy} selectedIndex={selectedIndex} onHighlight={setSelectedIndex} onBack={() => back(() => setChoices(null))} />
        : result ? <ResultView result={result} onBack={() => setResult(null)} />
          : <CommandList query={query} commands={commands} busy={busy} selectedIndex={selectedIndex} onHighlight={setSelectedIndex} choose={(command) => void choose(command)} />;

  return <section ref={popover} className="codex-command-popover" role="region" aria-label="Codex slash commands">
      <header><span><Command size={16} /></span><div><strong>Codex commands</strong><small>Type to filter · ↑↓ navigate · Enter select · Esc close</small></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close commands"><X size={16} /></button></header>
      {body}
      {error && <div className="codex-command-error" role="alert">{error}</div>}
  </section>;
}

function CommandList({ query, commands, busy, selectedIndex, onHighlight, choose }: { query: string; commands: readonly CodexCommandDefinition[]; busy: boolean; selectedIndex: number; onHighlight(index: number): void; choose(command: CodexCommandDefinition): void }) {
  const categories = [...new Set(commands.map((command) => command.category))];
  return <div className="codex-command-list"><div className="codex-command-query"><Search size={14} /><code>{query || '/'}</code><kbd>↑↓ Enter</kbd></div><div className="codex-command-scroll">{categories.map((category) => <section key={category}><h3>{category}</h3>{commands.filter((command) => command.category === category).map((command) => { const index = commands.indexOf(command); return <button key={command.id} data-codex-index={index} className={index === selectedIndex ? 'is-keyboard-active' : ''} disabled={busy} onMouseEnter={() => onHighlight(index)} onClick={() => choose(command)}><CommandGlyph id={command.id} /><span><strong>/{command.id}</strong><small>{command.description}</small></span><code>{command.title}</code></button>; })}</section>)}{!commands.length && <div className="codex-command-empty">No matching Codex commands.</div>}</div></div>;
}

function ArgumentView({ command, value, busy, inputRef, onChange, onBack, onSubmit }: { command: ArgumentCommand; value: string; busy: boolean; inputRef: React.RefObject<HTMLInputElement | null>; onChange(value: string): void; onBack(): void; onSubmit(event: FormEvent): void }) {
  const content: Record<ArgumentCommand, [string, string, string]> = {
    rename: ['Rename thread', 'Enter the new display name for this Codex thread.', 'Thread name'],
    review: ['Review changes', 'Leave blank to review all uncommitted changes, or add custom review instructions.', 'Optional review instructions'],
    goal: ['Thread goal', 'Leave blank to inspect the current goal, or enter a new objective.', 'Objective'],
    mention: ['Mention a file', 'Search the active workspace by filename.', 'Filename or path'],
    feedback: ['Send feedback', 'Feedback includes this thread id and optional Codex logs.', 'What happened?'],
  };
  const [title, detail, placeholder] = content[command];
  return <form className="codex-command-form" onSubmit={onSubmit}><button type="button" className="codex-command-back" onClick={onBack}><ChevronLeft size={14} />All commands</button><h2>{title}</h2><p>{detail}</p>{command === 'feedback' ? <textarea autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={5} /> : <input ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />}<button className="primary-button" disabled={busy}>{busy ? 'Working…' : command === 'goal' && !value.trim() ? 'View goal' : command === 'review' ? 'Start review' : 'Continue'}</button></form>;
}

function ChoiceView({ title, detail, items, busy, selectedIndex, onHighlight, onBack }: { title: string; detail: string; items: Choice[]; busy: boolean; selectedIndex: number; onHighlight(index: number): void; onBack(): void }) {
  return <div className="codex-choice-view"><button className="codex-command-back" onClick={onBack}><ChevronLeft size={14} />All commands</button><h2>{title}</h2><p>{detail}</p><div>{items.map((item, index) => <button key={item.id} data-codex-index={index} className={index === selectedIndex ? 'is-keyboard-active' : ''} disabled={busy} onMouseEnter={() => onHighlight(index)} onClick={() => void item.run()}><span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.meta && <code>{item.meta}</code>}</button>)}{!items.length && <div className="codex-command-empty">Nothing available from this Codex installation.</div>}</div></div>;
}

function ResultView({ result, onBack }: { result: { title: string; value: unknown }; onBack(): void }) {
  const rows = resultRows(result.value);
  return <div className="codex-result-view"><button className="codex-command-back" onClick={onBack}><ChevronLeft size={14} />All commands</button><h2>{result.title}</h2>{rows.length ? <div className="codex-result-rows">{rows.map((row, index) => <article key={`${row.title}-${index}`}><strong>{row.title}</strong>{row.detail && <p>{row.detail}</p>}{row.meta && <code>{row.meta}</code>}</article>)}</div> : <pre>{JSON.stringify(result.value ?? {}, null, 2)}</pre>}<details><summary>Raw app-server response</summary><pre>{JSON.stringify(result.value ?? {}, null, 2)}</pre></details></div>;
}

function ConfirmView({ kind, busy, onBack, onConfirm }: { kind: 'archive' | 'delete' | 'logout'; busy: boolean; onBack(): void; onConfirm(): void }) {
  const destructive = kind !== 'archive';
  return <div className="codex-confirm-view"><button className="codex-command-back" onClick={onBack}><ChevronLeft size={14} />All commands</button><span className={destructive ? 'danger' : ''}>{kind === 'archive' ? <Archive size={22} /> : kind === 'delete' ? <Trash2 size={22} /> : <ShieldCheck size={22} />}</span><h2>{kind === 'archive' ? 'Archive this thread?' : kind === 'delete' ? 'Permanently delete this thread?' : 'Log out on this device?'}</h2><p>{kind === 'archive' ? 'The thread remains saved in Codex and can be unarchived later.' : kind === 'delete' ? 'The saved Codex rollout will be removed. This cannot be undone.' : 'Orchestra will no longer be able to start Codex here until the device is authenticated again.'}</p><button className={destructive ? 'danger-button' : 'primary-button'} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : titleCase(kind)}</button></div>;
}

function CommandGlyph({ id }: { id: string }): ReactNode {
  const Icon = id === 'model' ? BrainCircuit : id === 'permissions' ? ShieldCheck : id === 'review' ? FileDiff : id === 'fork' ? GitFork : id === 'goal' ? Goal : id === 'skills' ? Sparkles : id === 'mcp' ? Plug : id === 'plugins' ? Package : id === 'memories' ? MemoryStick : id === 'copy' ? Clipboard : id === 'stop' || id === 'quit' ? CircleStop : id === 'undo' ? Undo2 : id === 'status' ? ListFilter : id === 'new' ? MessageSquare : id === 'experimental' ? Wrench : id === 'init' ? Code2 : id === 'permissions' ? Settings2 : Bot;
  return <span><Icon size={15} /></span>;
}

function resultRows(value: unknown): Array<{ title: string; detail?: string; meta?: string }> {
  const root = record(value);
  let values = array(root.data);
  if (!values.length) values = array(root.files);
  if (!values.length) values = array(root.marketplaces).flatMap((marketplace) => array(record(marketplace).plugins));
  if (!values.length && root.thread) values = [root.thread];
  if (!values.length && root.goal) values = [root.goal];
  return values.flatMap((item) => {
    const value = record(item);
    if (array(value.skills).length) return array(value.skills).map(record).map(row);
    if (array(value.hooks).length) return array(value.hooks).map(record).map(row);
    return [row(value)];
  });
}

function row(value: Record<string, unknown>): { title: string; detail?: string; meta?: string } {
  if (value.type === 'fileChange') {
    const paths = array(value.changes).map(record).map((change) => string(change.path)).filter(Boolean);
    const title = paths.length === 1 && paths[0] ? paths[0] : 'File changes';
    return {
      title,
      detail: paths.join(', '),
      meta: string(value.status),
    };
  }
  return {
    title: string(value.displayName) || string(value.name) || string(value.title) || string(value.file_name) || string(value.id) || 'Codex item',
    detail: string(value.description) || string(value.shortDescription) || string(value.detail) || string(value.path),
    meta: string(value.status) || string(value.stage) || string(value.scope) || string(value.model),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function nextCommandIndex(current: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count <= 0) return 0;
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count;
}

export function filterCodexCommands(query: string): readonly CodexCommandDefinition[] {
  const search = query.trim().replace(/^\//, '').toLowerCase();
  if (!search) return CODEX_COMMANDS;
  return CODEX_COMMANDS.filter((command) => `${command.id} ${command.title} ${command.description} ${command.keywords ?? ''}`.toLowerCase().includes(search));
}

export function latestGuardianEvent(events: readonly CodexEvent[]): unknown {
  return [...events].reverse().find((event) => event.method?.toLowerCase().includes('guardian'))?.data;
}
