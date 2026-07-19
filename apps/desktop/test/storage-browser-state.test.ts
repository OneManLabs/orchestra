import { describe, expect, it } from 'vitest';
import { mergeStorageBrowserPages, parseStorageCursor, type StorageBrowserPage } from '../src/renderer/lib/storage-browser-state.js';

const entry = (path: string, sizeBytes = 1) => ({
  name: path.split('/').at(-1)!,
  path,
  type: 'file' as const,
  sizeBytes,
  modifiedAt: '2026-07-16T00:00:00.000Z',
});

describe('storage browser pagination state', () => {
  it('appends pages, preserves prior entries, and replaces duplicate paths in place', () => {
    const first: StorageBrowserPage = {
      providerId: 'nas', path: 'models', entries: [entry('models/a'), entry('models/b')], nextCursor: '2', total: 4,
    };
    const second: StorageBrowserPage = {
      providerId: 'nas', path: 'models', entries: [entry('models/b', 20), entry('models/c')], nextCursor: '4', total: 4,
    };

    expect(mergeStorageBrowserPages(first, second)).toEqual({
      ...second,
      entries: [entry('models/a'), entry('models/b', 20), entry('models/c')],
    });
  });

  it('resets rather than merging when the provider or directory changes', () => {
    const current: StorageBrowserPage = { providerId: 'nas-a', path: 'models', entries: [entry('models/a')], total: 1 };
    const nextPath: StorageBrowserPage = { providerId: 'nas-a', path: 'datasets', entries: [entry('datasets/b')], total: 1 };
    const nextProvider: StorageBrowserPage = { providerId: 'nas-b', path: 'models', entries: [entry('models/c')], total: 1 };

    expect(mergeStorageBrowserPages(current, nextPath)).toBe(nextPath);
    expect(mergeStorageBrowserPages(current, nextProvider)).toBe(nextProvider);
  });

  it('accepts only non-negative safe integer cursors', () => {
    expect(parseStorageCursor('200')).toBe(200);
    expect(parseStorageCursor('0')).toBe(0);
    expect(parseStorageCursor(undefined)).toBeUndefined();
    expect(parseStorageCursor('-1')).toBeUndefined();
    expect(parseStorageCursor('2.5')).toBeUndefined();
    expect(parseStorageCursor('9007199254740992')).toBeUndefined();
  });
});
