export interface StorageBrowserEntry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  sizeBytes: number;
  modifiedAt: string;
}

export interface StorageBrowserPage {
  providerId: string;
  path: string;
  entries: StorageBrowserEntry[];
  nextCursor?: string;
  total: number;
}

/**
 * Append a page only when it belongs to the same provider and directory.
 * Duplicate paths are replaced in place so a refreshed entry does not appear
 * twice, while every previously loaded entry remains visible.
 */
export function mergeStorageBrowserPages(current: StorageBrowserPage | null, incoming: StorageBrowserPage): StorageBrowserPage {
  if (!current || current.providerId !== incoming.providerId || current.path !== incoming.path) return incoming;

  const entries = [...current.entries];
  const positions = new Map(entries.map((entry, index) => [entry.path, index]));
  for (const entry of incoming.entries) {
    const index = positions.get(entry.path);
    if (index === undefined) {
      positions.set(entry.path, entries.length);
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
  }

  return {
    ...incoming,
    entries,
    total: Math.max(incoming.total, entries.length),
  };
}

export function parseStorageCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  if (!/^\d+$/.test(cursor)) return undefined;
  const value = Number(cursor);
  return Number.isSafeInteger(value) ? value : undefined;
}
