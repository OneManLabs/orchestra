import type { CodexEvent } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { codexEventTurnId, codexMessageSources } from '../src/renderer/lib/codex-message-actions.js';

function event(id: string, type: CodexEvent['type'], text: string, data?: unknown): CodexEvent {
  return { id, type, text, data, at: '2026-07-16T12:00:00.000Z' };
}

describe('Codex message actions', () => {
  it('finds a branch turn boundary in normalized event metadata', () => {
    expect(codexEventTurnId(event('answer', 'assistant', 'Done', { turn: { id: 'turn-7' } }))).toBe('turn-7');
    expect(codexEventTurnId(event('answer', 'assistant', 'Done', { turnId: 'turn-8' }))).toBe('turn-8');
  });

  it('shows deduplicated sources only for web-backed answers', () => {
    const events = [
      event('user', 'user', 'Look this up'),
      event('search', 'tool', 'Web search — Fleet docs', {
        turnId: 'turn-web',
        item: { type: 'webSearch', query: 'Fleet docs', results: [{ title: 'Fleet', url: 'https://fleet.example/docs' }] },
      }),
      event('answer', 'assistant', 'See [Fleet docs](https://fleet.example/docs).', { turnId: 'turn-web' }),
    ];
    expect(codexMessageSources(events, events[2]!)).toEqual([{ title: 'Fleet docs', url: 'https://fleet.example/docs' }]);

    const localAnswer = event('local', 'assistant', 'See [local docs](https://fleet.example/local).');
    expect(codexMessageSources([events[0]!, localAnswer], localAnswer)).toEqual([]);
  });

  it('falls back to the search query when Codex reports no source URLs', () => {
    const events = [
      event('user', 'user', 'Look this up'),
      event('search', 'tool', 'Web search — current release', { item: { type: 'webSearch', query: 'current release' } }),
      event('answer', 'assistant', 'The release is current.'),
    ];
    expect(codexMessageSources(events, events[2]!)).toEqual([{ title: 'current release' }]);
  });
});
