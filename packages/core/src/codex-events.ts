import { randomUUID } from 'node:crypto';
import type { CodexApproval, CodexEvent, CodexSession } from '@fleet/shared';
import { boundedJson, FleetStore } from './store.js';

type JsonRecord = Record<string, unknown>;

export interface CodexEventResult {
  approval?: CodexApproval;
  significant?: 'turn-started' | 'turn-completed' | 'error';
  /** True only for high-frequency text deltas that are safe to publish at a bounded cadence. */
  streamingDelta?: boolean;
}

/** Normalize the stable, useful portion of Codex app-server events for the Fleet UI. */
export function applyCodexMessage(store: FleetStore, session: CodexSession, message: JsonRecord): CodexEventResult {
  const method = typeof message.method === 'string' ? message.method : undefined;
  if (!method) return {};
  const params = record(message.params);

  if (method === 'fleet/thread-context') {
    if (typeof params.threadId === 'string') session.threadId = params.threadId;
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    return {};
  }
  if (method === 'fleet/turn-context') {
    if (typeof params.threadId === 'string') session.threadId = params.threadId;
    if (typeof params.turnId === 'string') session.turnId = params.turnId;
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    return {};
  }

  if (message.id !== undefined && isApprovalMethod(method)) {
    const approval: CodexApproval = {
      id: randomUUID(),
      requestId: message.id as string | number,
      method,
      title: approvalTitle(method),
      detail: approvalDetail(params),
      params,
      createdAt: new Date().toISOString(),
    };
    session.pendingApprovals.push(approval);
    session.status = 'awaiting-approval';
    session.updatedAt = approval.createdAt;
    store.markDirty();
    return { approval };
  }

  if (method === 'turn/started') {
    if (!eventBelongsToSessionThread(session, params)) return {};
    const turn = record(params.turn);
    if (typeof turn.id === 'string') session.turnId = turn.id;
    session.status = 'thinking';
    session.error = undefined;
    append(store, session, 'status', 'Codex started a turn.', method, params);
    return { significant: 'turn-started' };
  }
  if (method === 'turn/completed') {
    if (!eventBelongsToSessionThread(session, params)) return {};
    const turn = record(params.turn); const status = turnStatus(turn.status);
    if (status === 'failed') { session.status = 'error'; session.error = extractText(turn.error) ?? 'Codex turn failed.'; }
    else { session.status = status === 'interrupted' ? 'ready' : 'completed'; session.error = undefined; }
    session.turnId = undefined;
    append(store, session, status === 'failed' ? 'error' : 'status', completionText(params), method, params);
    return { significant: status === 'failed' ? 'error' : 'turn-completed' };
  }
  if (method === 'error' || method.endsWith('/error')) {
    if (!eventBelongsToSessionThread(session, params)) return {};
    const text = extractText(params) ?? 'Codex reported an error.';
    session.status = 'error';
    session.error = text;
    append(store, session, 'error', text, method, params);
    return { significant: 'error' };
  }

  const lower = method.toLowerCase();
  if (method === 'item/started' || method === 'item/completed') {
    const item = record(params.item); const itemType = stringAt(item, 'type');
    if (itemType === 'commandExecution') { const command = extractCommand(params); if (command) upsertItemEvent(store, session, 'command', command, method, params); }
    else if (itemType === 'fileChange') { const changedPath = extractPath(params); if (changedPath) upsertItemEvent(store, session, 'file', changedPath, method, params); }
    else if (itemType === 'plan') { const text = stringAt(item, 'text'); if (text) upsertItemEvent(store, session, 'plan', text, method, params); }
    else if (['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageGeneration', 'imageView', 'sleep'].includes(itemType ?? '')) {
      const text = toolItemText(item);
      if (text) upsertItemEvent(store, session, 'tool', text, method, params);
    } else if (itemType === 'contextCompaction' && method === 'item/completed') {
      append(store, session, 'status', 'Codex compacted the conversation context.', method, params);
    } else if ((itemType === 'enteredReviewMode' || itemType === 'exitedReviewMode') && method === 'item/completed') {
      append(store, session, 'status', itemType === 'enteredReviewMode' ? 'Codex entered review mode.' : 'Codex completed review mode.', method, params);
    }
    return {};
  }
  if (lower.includes('agentmessage') || lower.includes('assistantmessage')) {
    const text = extractText(params);
    if (text) appendOrMergeDelta(store, session, 'assistant', text, method, params);
    return { streamingDelta: Boolean(text) && lower.includes('delta') };
  }
  if (lower.includes('reasoning') && (lower.includes('delta') || lower.includes('summary'))) {
    const text = extractText(params);
    if (text) appendOrMergeDelta(store, session, 'reasoning', text, method, params);
    return { streamingDelta: Boolean(text) && lower.includes('delta') };
  }
  if (lower.includes('commandexecution')) {
    const command = extractCommand(params);
    if (command && (lower.includes('started') || lower.includes('completed'))) {
      append(store, session, 'command', command, method, params);
    }
    return {};
  }
  if (lower.includes('filechange') || lower.includes('diff')) {
    const path = extractPath(params);
    if (path && (lower.includes('completed') || lower.includes('updated'))) {
      append(store, session, 'file', path, method, params);
    }
    return {};
  }
  if (method === 'fleet/stderr' || method === 'fleet/protocolError') {
    const text = extractText(params);
    if (text) append(store, session, 'error', text, method, params);
  }
  return {};
}

function append(
  store: FleetStore,
  session: CodexSession,
  type: CodexEvent['type'],
  text: string,
  method: string,
  data: unknown,
): void {
  store.appendCodexEvent(session, { type, text, method, data: dataWithTurnId(session, data) });
}

function appendOrMergeDelta(
  store: FleetStore,
  session: CodexSession,
  type: 'assistant' | 'reasoning',
  text: string,
  method: string,
  data: unknown,
): void {
  const last = session.events.at(-1);
  const enrichedData = dataWithTurnId(session, data);
  const turnId = stringAt(record(enrichedData), 'turnId');
  let sameTurn: CodexEvent | undefined;
  if (turnId) {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]!;
      // A newly started turn is a hard transcript boundary even if a broken
      // or test app-server accidentally reuses a turn identifier.
      if (event.method === 'turn/started') break;
      if (event.type === type && event.method === method && stringAt(record(event.data), 'turnId') === turnId) {
        sameTurn = event;
        break;
      }
    }
  }
  const mergeTarget = sameTurn
    ?? (last?.type === type && last.method === method && Date.now() - new Date(last.at).getTime() < 120_000 ? last : undefined);
  if (mergeTarget) {
    mergeTarget.text = `${mergeTarget.text}${text}`.slice(0, 65_536);
    mergeTarget.at = new Date().toISOString();
    mergeTarget.data = boundedJson(enrichedData);
    session.updatedAt = mergeTarget.at;
    store.markDirty();
  } else {
    append(store, session, type, text, method, data);
  }
}

function isApprovalMethod(method: string): boolean {
  return method.includes('requestApproval') || method.includes('requestUserInput') || method.includes('elicitation/request');
}

function eventBelongsToSessionThread(session: CodexSession, params: JsonRecord): boolean {
  const eventThreadId = stringAt(params, 'threadId');
  return !eventThreadId || !session.threadId || eventThreadId === session.threadId;
}

function approvalTitle(method: string): string {
  if (method.includes('commandExecution')) return 'Run command on this device';
  if (method.includes('fileChange')) return 'Apply workspace changes';
  if (method.includes('permissions')) return 'Grant additional permissions';
  if (method.includes('requestUserInput')) return 'Codex needs your input';
  return 'Codex requires approval';
}

function approvalDetail(params: JsonRecord): string {
  const reason = stringAt(params, 'reason') ?? stringAt(params, 'message');
  const command = extractCommand(params);
  const path = extractPath(params);
  return reason ?? command ?? path ?? 'Review this request before allowing Codex to continue.';
}

function completionText(params: JsonRecord): string {
  const turn = record(params.turn);
  const status = turnStatus(turn.status);
  if (status !== 'completed') return status === 'failed' ? (extractText(turn.error) ?? 'Codex turn failed.') : `Turn finished: ${status}.`;
  return 'Codex completed the turn.';
}

function turnStatus(value: unknown): string {
  if (typeof value === 'string') return value;
  const structured = record(value);
  return typeof structured.type === 'string' ? structured.type : 'completed';
}

function upsertItemEvent(store: FleetStore, session: CodexSession, type: 'command' | 'file' | 'tool' | 'plan', text: string, method: string, data: JsonRecord): void {
  const itemId = stringAt(record(data.item), 'id');
  const existing = itemId ? session.events.find((event) => event.type === type && stringAt(record(record(event.data).item), 'id') === itemId) : undefined;
  if (!existing) { append(store, session, type, text, method, data); return; }
  existing.text = text.slice(0, 65_536); existing.method = method; existing.data = boundedJson(dataWithTurnId(session, data)); existing.at = new Date().toISOString(); session.updatedAt = existing.at; store.markDirty();
}

function dataWithTurnId(session: CodexSession, data: unknown): unknown {
  if (!session.turnId) return data;
  const value = record(data);
  return typeof value.turnId === 'string' ? data : { ...value, turnId: session.turnId };
}

function toolItemText(item: JsonRecord): string | undefined {
  const type = stringAt(item, 'type');
  if (type === 'mcpToolCall') return [`MCP ${stringAt(item, 'server') ?? 'server'} · ${stringAt(item, 'tool') ?? 'tool'}`, stringAt(item, 'status')].filter(Boolean).join(' — ');
  if (type === 'dynamicToolCall') return [`${stringAt(item, 'namespace') ?? 'Codex'} · ${stringAt(item, 'tool') ?? 'tool'}`, stringAt(item, 'status')].filter(Boolean).join(' — ');
  if (type === 'collabAgentToolCall') {
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string') : [];
    return [`Agent ${stringAt(item, 'tool') ?? 'operation'}`, receivers.length ? receivers.join(', ') : undefined, stringAt(item, 'status')].filter(Boolean).join(' — ');
  }
  if (type === 'subAgentActivity') return [`Sub-agent ${stringAt(item, 'kind') ?? 'activity'}`, stringAt(item, 'agentPath')].filter(Boolean).join(' — ');
  if (type === 'webSearch') return `Web search — ${stringAt(item, 'query') ?? 'searching'}`;
  if (type === 'imageGeneration') return [`Image generation`, stringAt(item, 'status'), stringAt(item, 'savedPath')].filter(Boolean).join(' — ');
  if (type === 'imageView') return `Viewed image — ${stringAt(item, 'path') ?? ''}`.trim();
  if (type === 'sleep') return `Waiting for ${typeof item.durationMs === 'number' ? `${Math.round(item.durationMs / 1_000)}s` : 'a scheduled interval'}`;
  return undefined;
}

function extractCommand(params: JsonRecord): string | undefined {
  const item = record(params.item);
  const command = params.command ?? item.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === 'string').join(' ');
  return undefined;
}

function extractPath(params: JsonRecord): string | undefined {
  const item = record(params.item);
  for (const candidate of [params.path, params.filePath, item.path, item.filePath]) {
    if (typeof candidate === 'string') return candidate;
  }
  const changes = params.changes ?? item.changes;
  if (Array.isArray(changes)) {
    const paths = changes.map((change) => {
      const value = record(change);
      return typeof value.path === 'string' ? value.path : undefined;
    }).filter(Boolean);
    if (paths.length) return paths.join(', ');
  }
  return undefined;
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((entry) => extractText(entry, depth + 1)).filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join('') : undefined;
  }
  const object = record(value);
  for (const key of ['delta', 'text', 'message', 'reason', 'outputText']) {
    const found = extractText(object[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['item', 'content', 'error']) {
    const found = extractText(object[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function stringAt(object: JsonRecord, key: string): string | undefined {
  return typeof object[key] === 'string' ? object[key] : undefined;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
