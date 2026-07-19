import { describe, expect, it } from 'vitest';
import { CODEX_COMMANDS, filterCodexCommands, nextCommandIndex } from '../src/renderer/components/CodexCommandCenter.js';
import { boundedCodexModelIndex, boundedCodexModelOffset, CODEX_MICRO_MODEL_PRESETS, codexModelDirectionForMicroEncoder, codexModelIdentifier, codexModelOffsetForMicroEncoder, codexModelOptions, codexModelPresetIndex, codexModelPresets, preferredCodexModelIdentifier, wrappedCodexModelIndex } from '../src/renderer/lib/codex-model-settings.js';

describe('Codex command center parity surface', () => {
  it('exposes the major agent-affecting CLI command families', () => {
    const commands = CODEX_COMMANDS.map((command) => command.id);
    expect(commands).toEqual(expect.arrayContaining([
      'model', 'permissions', 'plan', 'personality', 'memories', 'experimental',
      'compact', 'review', 'rename', 'goal', 'new', 'fork', 'resume', 'undo',
      'archive', 'delete', 'clear', 'side', 'quit', 'init', 'mention', 'diff', 'status', 'agent', 'ps', 'stop',
      'skills', 'hooks', 'mcp', 'apps', 'plugins', 'import', 'usage', 'limits',
      'debug-config', 'feedback', 'logout',
    ]));
  });

  it('keeps command identifiers unique', () => {
    const commands = CODEX_COMMANDS.map((command) => command.id);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('wraps keyboard navigation in both directions', () => {
    expect(nextCommandIndex(0, 4, 'ArrowDown')).toBe(1);
    expect(nextCommandIndex(3, 4, 'ArrowDown')).toBe(0);
    expect(nextCommandIndex(0, 4, 'ArrowUp')).toBe(3);
    expect(nextCommandIndex(2, 4, 'ArrowUp')).toBe(1);
  });

  it('filters directly from slash text in the composer', () => {
    expect(filterCodexCommands('/mod').map((command) => command.id)).toContain('model');
    expect(filterCodexCommands('/permissions').map((command) => command.id)).toEqual(['permissions']);
    expect(filterCodexCommands('/definitely-missing')).toEqual([]);
  });

  it('uses model IDs as a safe app-server fallback and never manufactures an empty model', () => {
    expect(codexModelIdentifier({ id: 'gpt-test' })).toBe('gpt-test');
    expect(codexModelIdentifier({ model: '  gpt-trimmed  ', id: 'ignored' })).toBe('gpt-trimmed');
    expect(codexModelIdentifier({ model: ' ', id: ' ' }, ' ')).toBeUndefined();
  });

  it('resolves a missing collaboration-mode model to the app-server default', () => {
    const models = [
      { id: 'gpt-secondary', isDefault: false },
      { id: 'gpt-default', isDefault: true },
    ];
    expect(preferredCodexModelIdentifier(models, null, '')).toBe('gpt-default');
    expect(preferredCodexModelIdentifier(models, 'gpt-explicit')).toBe('gpt-explicit');
  });

  it('normalizes the full live model and reasoning range for the Micro knob', () => {
    const models = [
      { model: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', supportedReasoningEfforts: [{ effort: 'high' }, { effort: 'ultra', displayName: 'Ultra' }] },
      { id: 'gpt-5.6-terra', displayName: 'GPT 5.6 Terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' },
      { id: 'gpt-5.6-luna', displayName: 'GPT 5.6 Luna', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
      { id: 'gpt-5.5', displayName: 'GPT 5.5', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ];
    expect(codexModelOptions(models)).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', efforts: ['high', 'ultra'], defaultEffort: 'ultra' },
      { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', efforts: ['low', 'high'], defaultEffort: 'low' },
      { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', efforts: ['max'], defaultEffort: 'max' },
      { id: 'gpt-5.5', label: 'GPT 5.5', efforts: ['high'], defaultEffort: 'high' },
    ]);
    const presets = codexModelPresets(models);
    expect(presets).toEqual([
      { modelId: 'gpt-5.6-luna', modelLabel: 'GPT 5.6 Luna', effort: 'max', effortLabel: 'Max', label: 'GPT 5.6 Luna · Max' },
      { modelId: 'gpt-5.6-terra', modelLabel: 'GPT 5.6 Terra', effort: 'low', effortLabel: 'Low', label: 'GPT 5.6 Terra · Low' },
      { modelId: 'gpt-5.6-terra', modelLabel: 'GPT 5.6 Terra', effort: 'high', effortLabel: 'High', label: 'GPT 5.6 Terra · High' },
      { modelId: 'gpt-5.6-sol', modelLabel: 'GPT 5.6 Sol', effort: 'high', effortLabel: 'High', label: 'GPT 5.6 Sol · High' },
      { modelId: 'gpt-5.6-sol', modelLabel: 'GPT 5.6 Sol', effort: 'ultra', effortLabel: 'Ultra', label: 'GPT 5.6 Sol · Ultra' },
    ]);
    expect(codexModelPresetIndex(presets, 'gpt-5.6-terra', 'high')).toBe(2);
    expect(codexModelPresetIndex(presets, 'gpt-5.6-sol', 'missing')).toBe(3);
    expect(wrappedCodexModelIndex(4, presets.length, 'next')).toBe(0);
    expect(wrappedCodexModelIndex(0, presets.length, 'previous')).toBe(4);
    expect(boundedCodexModelIndex(4, presets.length, 'next')).toBe(4);
    expect(boundedCodexModelIndex(0, presets.length, 'previous')).toBe(0);
    expect(boundedCodexModelIndex(1, presets.length, 'next')).toBe(2);
    expect(boundedCodexModelOffset(1, presets.length, 3)).toBe(4);
    expect(boundedCodexModelOffset(3, presets.length, -10)).toBe(0);
    expect(codexModelDirectionForMicroEncoder('counterclockwise')).toBe('next');
    expect(codexModelDirectionForMicroEncoder('clockwise')).toBe('previous');
    expect(codexModelOffsetForMicroEncoder('counterclockwise', 7)).toBe(7);
    expect(codexModelOffsetForMicroEncoder('clockwise', 7)).toBe(-7);
    expect(codexModelOffsetForMicroEncoder('counterclockwise', Number.NaN)).toBe(1);
  });

  it('keeps the complete Micro ladder local, fixed, and ordered from Luna to Sol Ultra', () => {
    expect(CODEX_MICRO_MODEL_PRESETS).toHaveLength(17);
    expect(CODEX_MICRO_MODEL_PRESETS[0]).toMatchObject({ modelId: 'gpt-5.6-luna', effort: 'low', label: 'GPT 5.6 Luna · Low' });
    expect(CODEX_MICRO_MODEL_PRESETS[4]).toMatchObject({ modelId: 'gpt-5.6-luna', effort: 'max' });
    expect(CODEX_MICRO_MODEL_PRESETS[5]).toMatchObject({ modelId: 'gpt-5.6-terra', effort: 'low' });
    expect(CODEX_MICRO_MODEL_PRESETS[10]).toMatchObject({ modelId: 'gpt-5.6-terra', effort: 'ultra' });
    expect(CODEX_MICRO_MODEL_PRESETS.at(-1)).toMatchObject({ modelId: 'gpt-5.6-sol', effort: 'ultra', label: 'GPT 5.6 Sol · Ultra' });
  });
});
