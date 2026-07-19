type UnknownRecord = Record<string, unknown>;

export interface CodexModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
}

export interface CodexModelPreset {
  modelId: string;
  modelLabel: string;
  effort?: string;
  effortLabel?: string;
  label: string;
}

const CODEX_MICRO_5_6_MODELS = [
  { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
] as const;

const CODEX_MICRO_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

/**
 * The Micro's fixed, fully local 5.6 ladder. Rotation must never wait on
 * app-server model discovery; the selected pair is validated only on apply.
 */
export const CODEX_MICRO_MODEL_PRESETS: readonly CodexModelPreset[] = CODEX_MICRO_5_6_MODELS.flatMap((model) => model.efforts.map((effort) => {
  const effortLabel = CODEX_MICRO_EFFORT_LABELS[effort] ?? titleCaseWords(effort);
  return {
    modelId: model.id,
    modelLabel: model.label,
    effort,
    effortLabel,
    label: `${model.label} · ${effortLabel}`,
  };
}));

/** Return the app-server model identifier without ever manufacturing an empty model. */
export function codexModelIdentifier(value: unknown, fallback?: unknown): string | undefined {
  const model = record(value);
  return nonBlankString(model.model) ?? nonBlankString(model.id) ?? nonBlankString(fallback);
}

/** Prefer an explicit/thread model, then the app-server default, then its first usable model. */
export function preferredCodexModelIdentifier(models: readonly unknown[], ...preferred: unknown[]): string | undefined {
  for (const candidate of preferred) {
    const identifier = nonBlankString(candidate);
    if (identifier) return identifier;
  }

  const entries = models.map(record);
  const defaultModel = entries.find((entry) => entry.isDefault === true);
  return codexModelIdentifier(defaultModel) ?? entries.map((entry) => codexModelIdentifier(entry)).find(Boolean);
}

/** Normalize the live app-server list used by the Micro knob and Orchestra model picker. */
export function codexModelOptions(models: readonly unknown[]): CodexModelOption[] {
  return models.map(record).flatMap((model) => {
    const id = codexModelIdentifier(model);
    if (!id) return [];
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map(record).map((effort) => nonBlankString(effort.reasoningEffort) ?? nonBlankString(effort.effort)).filter((value): value is string => Boolean(value))
      : [];
    return [{
      id,
      label: nonBlankString(model.displayName) ?? nonBlankString(model.name) ?? id,
      efforts,
      defaultEffort: nonBlankString(model.defaultReasoningEffort) ?? efforts[Math.floor(efforts.length / 2)],
    }];
  });
}

/** Expand every live model and supported effort into one dial-friendly ladder. */
export function codexModelPresets(models: readonly unknown[]): CodexModelPreset[] {
  return orderedPresetModels(models).flatMap((model) => {
    const modelId = codexModelIdentifier(model);
    if (!modelId) return [];
    const modelLabel = nonBlankString(model.displayName) ?? nonBlankString(model.name) ?? modelId;
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map(record).flatMap((effort) => {
        const id = nonBlankString(effort.reasoningEffort) ?? nonBlankString(effort.effort);
        if (!id) return [];
        return [{ id, label: nonBlankString(effort.displayName) ?? nonBlankString(effort.name) ?? titleCaseWords(id) }];
      })
      : [];
    if (!efforts.length) return [{ modelId, modelLabel, label: modelLabel }];
    return efforts.map((effort) => ({
      modelId,
      modelLabel,
      effort: effort.id,
      effortLabel: effort.label,
      label: `${modelLabel} · ${effort.label}`,
    }));
  });
}

export function codexModelPresetIndex(presets: readonly CodexModelPreset[], modelId: unknown, effort: unknown): number {
  const normalizedModel = nonBlankString(modelId);
  const normalizedEffort = nonBlankString(effort);
  const exact = presets.findIndex((preset) => preset.modelId === normalizedModel && preset.effort === normalizedEffort);
  if (exact >= 0) return exact;
  const sameModel = presets.findIndex((preset) => preset.modelId === normalizedModel);
  return sameModel >= 0 ? sameModel : 0;
}

export function wrappedCodexModelIndex(current: number, length: number, direction: 'next' | 'previous'): number {
  if (length <= 0) return 0;
  return (current + (direction === 'next' ? 1 : -1) + length) % length;
}

export function boundedCodexModelIndex(current: number, length: number, direction: 'next' | 'previous'): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, current + (direction === 'next' ? 1 : -1)));
}

export function boundedCodexModelOffset(current: number, length: number, offset: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, current + offset));
}

export function codexModelDirectionForMicroEncoder(direction: 'clockwise' | 'counterclockwise'): 'next' | 'previous' {
  return direction === 'counterclockwise' ? 'next' : 'previous';
}

export function codexModelOffsetForMicroEncoder(direction: 'clockwise' | 'counterclockwise', steps: unknown = 1): number {
  const magnitude = typeof steps === 'number' && Number.isFinite(steps)
    ? Math.max(1, Math.trunc(Math.abs(steps)))
    : 1;
  return codexModelDirectionForMicroEncoder(direction) === 'next' ? magnitude : -magnitude;
}

export function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function titleCaseWords(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function orderedPresetModels(models: readonly unknown[]): UnknownRecord[] {
  const entries = models.map(record).map((model, index) => ({ model, index, id: codexModelIdentifier(model) }));
  const families = entries.flatMap((entry) => {
    const match = entry.id?.match(/^gpt-(\d+)\.(\d+)-(terra|luna|sol)$/i);
    return match ? [{ entry, generation: Number(match[1]) * 1_000 + Number(match[2]), family: match[3]!.toLowerCase() }] : [];
  });
  const currentGeneration = Math.max(0, ...families.map((entry) => entry.generation));
  const familyOrder = new Map([['luna', 0], ['terra', 1], ['sol', 2]]);
  const currentFamilies = families.filter((entry) => entry.generation === currentGeneration);
  if (currentFamilies.length) {
    return currentFamilies.sort((left, right) => familyOrder.get(left.family)! - familyOrder.get(right.family)!).map((entry) => entry.entry.model);
  }
  return entries.sort((left, right) => left.index - right.index).map((entry) => entry.model);
}
