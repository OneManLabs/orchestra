import type { CodexEvent } from '@fleet/shared';

export interface CodexMessageSource {
  title: string;
  url?: string;
}

export function codexEventTurnId(event: CodexEvent): string | undefined {
  return stringForKey(event.data, 'turnId') ?? stringForKey(event.data, 'id', 'turn');
}

export function codexMessageSources(events: readonly CodexEvent[], assistantEvent: CodexEvent): CodexMessageSource[] {
  if (assistantEvent.type !== 'assistant') return [];
  const assistantIndex = events.findIndex((event) => event.id === assistantEvent.id);
  if (assistantIndex < 0) return [];
  const turnId = codexEventTurnId(assistantEvent);
  let start = assistantIndex - 1;
  while (start >= 0 && events[start]?.type !== 'user' && events[start]?.type !== 'assistant') start -= 1;
  const candidates = events.slice(Math.max(0, start), assistantIndex);
  const searches = candidates.filter((event) => isWebSearchEvent(event) && (!turnId || !codexEventTurnId(event) || codexEventTurnId(event) === turnId));
  if (!searches.length) return [];

  const sources = markdownSources(assistantEvent.text);
  for (const search of searches) collectSourceUrls(search.data, sources);
  if (!sources.length) {
    for (const search of searches) {
      const query = webSearchQuery(search);
      if (query) sources.push({ title: query });
    }
  }
  return deduplicateSources(sources);
}

function isWebSearchEvent(event: CodexEvent): boolean {
  return event.type === 'tool' && (
    stringForKey(event.data, 'type') === 'webSearch'
    || event.text.toLowerCase().startsWith('web search')
  );
}

function webSearchQuery(event: CodexEvent): string | undefined {
  return stringForKey(event.data, 'query') ?? event.text.split('—').at(1)?.trim();
}

function markdownSources(text: string): CodexMessageSource[] {
  const result: CodexMessageSource[] = [];
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of text.matchAll(markdownLink)) result.push({ title: match[1]?.trim() || hostname(match[2]!), url: match[2] });
  const bareUrl = /https?:\/\/[^\s<>()\]]+/g;
  for (const match of text.matchAll(bareUrl)) result.push({ title: hostname(match[0]), url: match[0] });
  return result;
}

function collectSourceUrls(value: unknown, result: CodexMessageSource[], depth = 0): void {
  if (depth > 7 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectSourceUrls(entry, result, depth + 1);
    return;
  }
  const object = value as Record<string, unknown>;
  for (const key of ['url', 'uri', 'href']) {
    const url = object[key];
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const title = [object.title, object.name].find((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
      result.push({ title: title?.trim() || hostname(url), url });
    }
  }
  for (const entry of Object.values(object)) collectSourceUrls(entry, result, depth + 1);
}

function deduplicateSources(sources: CodexMessageSource[]): CodexMessageSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url ?? `query:${source.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Source'; }
}

function stringForKey(value: unknown, key: string, parentKey?: string, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = stringForKey(entry, key, parentKey, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (!parentKey && typeof object[key] === 'string') return object[key] as string;
  if (parentKey) {
    const parent = object[parentKey];
    if (parent && typeof parent === 'object' && !Array.isArray(parent) && typeof (parent as Record<string, unknown>)[key] === 'string') {
      return (parent as Record<string, unknown>)[key] as string;
    }
  }
  for (const entry of Object.values(object)) {
    const found = stringForKey(entry, key, parentKey, depth + 1);
    if (found) return found;
  }
  return undefined;
}
