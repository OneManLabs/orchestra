import type { Device, FleetArtifact, PipelineNodeRun } from '@fleet/shared';
import { z } from 'zod';

export const pluginCapabilitySchema = z.enum([
  'job', 'pipeline-node', 'telemetry', 'artifact-viewer', 'notification', 'policy', 'scheduler', 'auth',
]);

export const fleetPluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
  name: z.string().min(1).max(160),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().max(2_000),
  publisher: z.string().min(1).max(160),
  entrypoint: z.string().min(1).max(1_024).refine(safeEntrypoint, 'entrypoint must be a relative path contained within the plugin package'),
  capabilities: z.array(pluginCapabilitySchema).min(1).refine(unique, 'capabilities must not contain duplicates'),
  minimumFleetVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).default('2.0.0'),
  permissions: z.object({
    networkDomains: z.array(z.string().max(253).regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i)).default([]).refine(unique, 'networkDomains must not contain duplicates'),
    filesystemRoots: z.array(z.string().min(1).max(4_096)).default([]).refine(unique, 'filesystemRoots must not contain duplicates'),
    secretNames: z.array(z.string().min(1).max(256)).default([]).refine(unique, 'secretNames must not contain duplicates'),
    fleetScopes: z.array(z.string().min(1).max(256)).default([]).refine(unique, 'fleetScopes must not contain duplicates'),
  }).default({}),
  configSchema: z.record(z.unknown()).optional(),
  signature: z.object({ algorithm: z.literal('ed25519'), keyId: z.string(), value: z.string() }).optional(),
}).strict();

export type FleetPluginManifest = z.infer<typeof fleetPluginManifestSchema>;

export interface PluginLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface PluginContext {
  pluginId: string;
  executionId: string;
  signal: AbortSignal;
  logger: PluginLogger;
  config: Readonly<Record<string, unknown>>;
  secrets: { get(name: string): Promise<string> };
  artifacts: {
    register(input: Pick<FleetArtifact, 'name' | 'kind'> & Partial<FleetArtifact>): Promise<FleetArtifact>;
  };
}

export interface PipelineNodePlugin {
  type: string;
  validate(config: unknown): Promise<{ valid: boolean; errors: string[] }>;
  execute(context: PluginContext, input: { config: Record<string, unknown>; run: PipelineNodeRun; device?: Device }): Promise<Record<string, unknown>>;
  cancel?(executionId: string): Promise<void>;
}

export interface TelemetryPlugin {
  collect(context: PluginContext, device: Device): Promise<Record<string, number | string | boolean>>;
}

export interface NotificationPlugin {
  send(context: PluginContext, input: { title: string; body: string; severity: string; link?: string }): Promise<{ providerId?: string }>;
}

export interface SchedulerPlugin {
  score(context: PluginContext, input: { device: Device; workload: Record<string, unknown> }): Promise<{ score: number; reasons: string[] }>;
}

export interface FleetPluginModule {
  manifest: FleetPluginManifest;
  pipelineNodes?: readonly PipelineNodePlugin[];
  telemetry?: TelemetryPlugin;
  notification?: NotificationPlugin;
  scheduler?: SchedulerPlugin;
  activate?(context: Omit<PluginContext, 'executionId' | 'signal'>): Promise<void>;
  deactivate?(): Promise<void>;
}

export function defineFleetPlugin(module: FleetPluginModule): FleetPluginModule {
  const manifest = fleetPluginManifestSchema.parse(module.manifest);
  const declared = new Set(manifest.capabilities);
  if (module.pipelineNodes?.length && !declared.has('pipeline-node')) throw new Error('Plugin provides pipeline nodes without declaring pipeline-node capability.');
  if (module.telemetry && !declared.has('telemetry')) throw new Error('Plugin provides telemetry without declaring telemetry capability.');
  if (module.notification && !declared.has('notification')) throw new Error('Plugin provides notifications without declaring notification capability.');
  if (module.scheduler && !declared.has('scheduler')) throw new Error('Plugin provides scheduling without declaring scheduler capability.');
  const pipelineNodes = module.pipelineNodes ? Object.freeze([...module.pipelineNodes]) : undefined;
  return Object.freeze({ ...module, manifest: Object.freeze(manifest), pipelineNodes });
}

function unique(values: readonly unknown[]): boolean { return new Set(values).size === values.length; }
function safeEntrypoint(value: string): boolean {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.replace(/^\.\//, '').split('/');
  return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}
