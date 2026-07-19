import type { CodexEvent } from '@fleet/shared';

const STOP_WORDS = new Set([
  'a', 'about', 'actually', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been',
  'being', 'better', 'but', 'by', 'can', 'cleaner', 'could', 'do', 'does', 'either', 'even', 'feel', 'for', 'from',
  'had', 'has', 'have', 'help', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'just', 'kind', 'like', 'lot', 'make',
  'me', 'more', 'much', 'my', 'need', 'not', 'of', 'okay', 'on', 'only', 'or', 'our', 'please', 'problem', 'really',
  'should', 'so', 'some', 'something', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'think', 'this', 'those', 'to', 'up', 'us', 'user', 'very', 'want', 'way', 'we', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'works', 'would', 'you', 'your', 'able', 'app',
]);

const INTENT_WORDS = new Set([
  'add', 'added', 'adding', 'build', 'building', 'change', 'changed', 'changing', 'create', 'creating', 'debug', 'delete',
  'design', 'deploy', 'explain', 'fix', 'fixed', 'fixing', 'implement', 'implemented', 'improve', 'improved', 'improving',
  'fail', 'fails', 'failed', 'failing', 'install', 'investigate', 'remove', 'removed', 'removing', 'rename', 'renaming',
  'review', 'update', 'updated', 'updating',
]);

const DISPLAY_TERMS: Record<string, string> = {
  api: 'API',
  chatgpt: 'ChatGPT',
  cli: 'CLI',
  codex: 'Codex',
  css: 'CSS',
  fleet: 'Fleet',
  gpu: 'GPU',
  github: 'GitHub',
  html: 'HTML',
  ios: 'iOS',
  javascript: 'JavaScript',
  macos: 'macOS',
  mcp: 'MCP',
  nas: 'NAS',
  pr: 'PR',
  ssh: 'SSH',
  ui: 'UI',
  url: 'URL',
  typescript: 'TypeScript',
};

export function isGenericCodexSessionTitle(value: string): boolean {
  const title = value.trim();
  return !title
    || /^(codex session|session on .+|quick session on .+)$/i.test(title)
    || /^[\w ._-]+ session$/i.test(title);
}

function contextualCodexSessionTitle(input: string, fallback = 'Codex session'): string {
  const text = normalize(input);
  if (!text) return fallback;
  const lower = text.toLowerCase();

  if (/\bsessions?\b/.test(lower) && /\bpermissions?\b/.test(lower)) return 'Codex Session Permissions';
  if (/\blanding page\b/.test(lower)) return /\b(?:orchestra|fleet canvas)(?: canvas)?\b/.test(lower) ? 'Orchestra Landing Page' : 'Landing Page';
  if (/\bsessions?\b/.test(lower) && /\b(nam\w*|titl\w*)\b/.test(lower)) {
    if (/\bchatgpt\b/.test(lower)) return 'ChatGPT-Style Session Titles';
    if (/\bcontext\w*\b/.test(lower)) return 'Contextual Session Titles';
    return 'Better Session Titles';
  }
  if (/\b(sidebar|side bar)\b/.test(lower) && /\b(drag\w*|resiz\w*|responsive|bigger|smaller|slide)\b/.test(lower)) {
    return /\borchestra\b|\bfleet\b|\bcanvas\b/.test(lower) ? 'Orchestra Sidebar Resizing' : 'Responsive Sidebar Resizing';
  }

  const intent = titleIntent(lower);
  const candidates = text.match(/[A-Za-z0-9][A-Za-z0-9+#.-]*/g) ?? [];
  const subjects: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
    if (!key || STOP_WORDS.has(key) || INTENT_WORDS.has(key) || key.length === 1 || seen.has(normalizedKey(key))) continue;
    const display = displayToken(key);
    seen.add(normalizedKey(key));
    subjects.push(display);
    if (subjects.length === (intent ? 5 : 6)) break;
  }

  const words = [...(intent ? [intent] : []), ...subjects];
  if (!words.length) return fallback;
  return truncate(words.join(' '), 56);
}

export function contextualCodexSessionTitleFromEvents(events: readonly CodexEvent[], fallback = 'Codex session'): string {
  const relevant = events.filter((event) => ['user', 'assistant', 'plan', 'file'].includes(event.type) && event.text.trim()).slice(-40);
  const userEvents = relevant.filter((event) => event.type === 'user');
  if (!userEvents.length) return fallback;
  const context = normalize(relevant.map((event) => event.text).join(' '));
  const lower = context.toLowerCase();

  const sidebar = /\b(sidebar|side bar|inspector|right panel)\b/.test(lower);
  const fleet = /\b(fleet|canvas|device)\b/.test(lower);
  const layoutWork = /\b(drag\w*|resiz\w*|responsive|layout|width|cover\w*|smaller|bigger)\b/.test(lower);
  const messageWork = /\b(message|markdown|syntax|format\w*|text wrapping|code block)\b/.test(lower);
  const sessionWork = /\b(session|thread)\b/.test(lower) && /\b(picker|dropdown|history|nam\w*|titl\w*|ranking|stopped)\b/.test(lower);
  const workstreamCount = [layoutWork, messageWork, sessionWork].filter(Boolean).length;

  if (sidebar && workstreamCount >= 2) return fleet ? 'Fleet Device Sidebar UX' : 'Device Sidebar UX';
  if (sessionWork && /\b(nam\w*|titl\w*)\b/.test(lower) && /\b(picker|dropdown|history|ranking)\b/.test(lower)) return 'Codex Session Management';

  const substantiveUserEvents = userEvents.filter((event) => !isLowInformationFollowUp(event.text));
  const titleEvents = substantiveUserEvents.length ? substantiveUserEvents : userEvents;
  const generated = titleEvents.map((event) => contextualCodexSessionTitle(event.text, '')).filter(Boolean);
  if (generated.length === 1) return generated[0]!;
  const recurring = recurringTitle(generated);
  return recurring || generated.at(-1) || fallback;
}

function isLowInformationFollowUp(value: string): boolean {
  const text = normalize(value).toLowerCase().replace(/[.!?]+$/g, '').trim();
  return /^(continue|do it|go ahead|keep going|okay|ok|proceed|run it|ship it|sure|yes|you do it|you run it)$/.test(text);
}

function titleIntent(value: string): string | undefined {
  if (/\b(fix\w*|broken|bug|error|fail\w*|issue)\b/.test(value)) return 'Fix';
  if (/\b(debug\w*|investigat\w*|diagnos\w*|why\b)/.test(value)) return 'Investigate';
  if (/\b(review\w*|audit\w*)\b/.test(value)) return 'Review';
  if (/\b(deploy\w*|ship\w*|release\w*)\b/.test(value)) return 'Deploy';
  if (/\b(install\w*|configur\w*|setup|set up)\b/.test(value)) return 'Configure';
  if (/\b(remove\w*|delet\w*)\b/.test(value)) return 'Remove';
  if (/\b(add\w*|creat\w*|build\w*|implement\w*)\b/.test(value)) return 'Build';
  if (/\b(improv\w*|enhanc\w*|refactor\w*|better)\b/.test(value)) return 'Improve';
  if (/\b(explain\w*|how\b)\b/.test(value)) return 'Explain';
  if (/\b(chang\w*|updat\w*|make\b)\b/.test(value)) return 'Update';
  return undefined;
}

function recurringTitle(titles: string[]): string | undefined {
  const counts = new Map<string, { value: string; count: number; first: number }>();
  titles.forEach((title, titleIndex) => {
    for (const word of title.match(/[A-Za-z0-9][A-Za-z0-9+#.-]*/g) ?? []) {
      const key = normalizedKey(word.toLowerCase());
      if (STOP_WORDS.has(key) || INTENT_WORDS.has(key)) continue;
      const current = counts.get(key);
      counts.set(key, { value: displayToken(word.toLowerCase()), count: (current?.count ?? 0) + 1, first: current?.first ?? titleIndex });
    }
  });
  const repeated = [...counts.values()].filter((item) => item.count > 1).sort((left, right) => right.count - left.count || left.first - right.first).slice(0, 5);
  return repeated.length >= 2 ? truncate(repeated.map((item) => item.value).join(' '), 56) : undefined;
}

function normalize(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\bright[ -]?side[ -]?bar\b/gi, ' sidebar ')
    .replace(/\bchat[ -]?gpt\b/gi, ' ChatGPT ')
    .replace(/\btype[ -]?script\b/gi, ' TypeScript ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedKey(value: string): string {
  if (/^nam(e|es|ing)$/.test(value)) return 'naming';
  if (/^titl(e|es|ing)$/.test(value)) return 'title';
  if (/^connect(ed|ing|ion|ions)?$/.test(value)) return 'connection';
  if (/^resiz(e|ed|ing|able)$/.test(value)) return 'resizing';
  return value.replace(/s$/, '');
}

function displayToken(value: string): string {
  const normalized = normalizedKey(value);
  if (DISPLAY_TERMS[value]) return DISPLAY_TERMS[value]!;
  if (DISPLAY_TERMS[normalized]) return DISPLAY_TERMS[normalized]!;
  if (/^[a-z]+$/.test(value)) return value[0]!.toUpperCase() + value.slice(1);
  return value;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}
