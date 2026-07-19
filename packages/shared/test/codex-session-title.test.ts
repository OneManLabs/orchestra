import { describe, expect, it } from 'vitest';
import { contextualCodexSessionTitle, contextualCodexSessionTitleFromEvents, isGenericCodexSessionTitle } from '../src/codex-session-title.js';

describe('contextual Codex session titles', () => {
  it('creates compact task titles from conversational requests', () => {
    expect(contextualCodexSessionTitle('Please build a dashboard for GPU telemetry.')).toBe('Build Dashboard GPU Telemetry');
    expect(contextualCodexSessionTitle('The Fleet Canvas right side bar should be draggable, responsive, and resize smaller.')).toBe('Fleet Canvas Sidebar Resizing');
    expect(contextualCodexSessionTitle('Can session naming work more like ChatGPT titles on the web?')).toBe('ChatGPT-Style Session Titles');
  });

  it('preserves recognizable technical terms', () => {
    expect(contextualCodexSessionTitle('Investigate why the API connection fails on macOS')).toBe('Fix API Connection macOS');
  });

  it('distinguishes generated placeholders from deliberate names', () => {
    expect(isGenericCodexSessionTitle('Fleet session')).toBe(true);
    expect(isGenericCodexSessionTitle('Session on Mac Studio')).toBe(true);
    expect(isGenericCodexSessionTitle('Sidebar polish')).toBe(false);
  });

  it('generalizes an evolving conversation across related completed work', () => {
    const events = [
      event('user', 'Make the Fleet Canvas right sidebar draggable and responsive.'),
      event('assistant', 'Implemented sidebar resizing and responsive layout.'),
      event('user', 'Keep Markdown messages and code formatting inside the sidebar.'),
      event('assistant', 'Added responsive message formatting and code scrolling.'),
      event('user', 'Improve the Codex session picker, history ordering, and session naming.'),
      event('assistant', 'Built the Fleet-themed session picker and history grouping.'),
    ];

    expect(contextualCodexSessionTitleFromEvents(events)).toBe('Fleet Device Sidebar UX');
  });

  it('keeps short execution follow-ups from replacing the substantive task', () => {
    const events = [
      event('user', 'Build a landing page for Fleet Canvas, a private distributed computing and AI orchestration platform.'),
      event('assistant', 'The Fleet Canvas landing page is implemented and ready to run.'),
      event('user', 'You run it'),
    ];

    expect(contextualCodexSessionTitleFromEvents(events)).toBe('Fleet Canvas Landing Page');
    expect(contextualCodexSessionTitle('We need to change Codex session permissions during a chat.')).toBe('Codex Session Permissions');
  });
});

function event(type: 'user' | 'assistant', text: string) {
  return { id: `${type}-${text}`, at: '2026-07-16T12:00:00Z', type, text } as const;
}
