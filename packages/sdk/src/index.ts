import type {
  AgentTeam,
  AlertRule,
  ArtifactTransfer,
  BackupRecord,
  DevicePowerAction,
  FleetArtifact,
  FleetJob,
  FleetSnapshot,
  FleetV2Snapshot,
  PipelineDefinition,
  PipelineRun,
  SchedulingPolicy,
  SecretMetadata,
  StorageConnection,
} from '@fleet/shared';

export interface FleetClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class FleetApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'FleetApiError';
    this.status = status;
    this.detail = detail;
  }
}

/** Typed Fleet Canvas V2 REST client for browser, Node, and service-account use. */
export class FleetClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: FleetClientOptions) {
    validateBaseUrl(options.baseUrl);
    if (options.token && /[\r\n]/.test(options.token)) throw new Error('Fleet bearer token contains invalid control characters.');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseHeaders = options.headers ?? {};
  }

  snapshot(options?: RequestOptions): Promise<FleetSnapshot> {
    return this.request('/api/snapshot', { options });
  }

  v2(options?: RequestOptions): Promise<FleetV2Snapshot> {
    return this.request('/api/v2', { options });
  }

  jobs(options?: RequestOptions): Promise<FleetJob[]> {
    return this.request('/api/jobs', { options });
  }

  createJob(input: Partial<FleetJob> & Pick<FleetJob, 'name' | 'kind'>, options?: RequestOptions): Promise<FleetJob> {
    return this.request('/api/jobs', { method: 'POST', body: input, options });
  }

  cancelJob(jobId: string, options?: RequestOptions): Promise<FleetJob> {
    return this.action(`/api/jobs/${segment(jobId)}/cancel`, undefined, options);
  }

  power(deviceIds: string[], action: DevicePowerAction, input: { force?: boolean } = {}, options?: RequestOptions): Promise<unknown> {
    return this.request('/api/v2/devices/power', { method: 'POST', body: { deviceIds, action, ...input }, options });
  }

  artifacts(options?: RequestOptions): Promise<FleetArtifact[]> {
    return this.list('artifacts', options);
  }

  createArtifact(input: Partial<FleetArtifact> & Pick<FleetArtifact, 'name' | 'kind'>, options?: RequestOptions): Promise<FleetArtifact> {
    return this.create('artifacts', input, options);
  }

  transfers(options?: RequestOptions): Promise<ArtifactTransfer[]> {
    return this.list('transfers', options);
  }

  createTransfer(input: Partial<ArtifactTransfer> & Pick<ArtifactTransfer, 'source' | 'destination'>, options?: RequestOptions): Promise<ArtifactTransfer> {
    return this.create('transfers', input, options);
  }

  storageConnections(options?: RequestOptions): Promise<StorageConnection[]> {
    return this.list('storage-connections', options);
  }

  pipelines(options?: RequestOptions): Promise<PipelineDefinition[]> {
    return this.list('pipelines', options);
  }

  createPipeline(input: Partial<PipelineDefinition> & Pick<PipelineDefinition, 'name' | 'nodes' | 'edges'>, options?: RequestOptions): Promise<PipelineDefinition> {
    return this.create('pipelines', input, options);
  }

  runPipeline(pipelineId: string, parameters: Record<string, unknown> = {}, options?: RequestOptions): Promise<PipelineRun> {
    return this.action(`/api/v2/pipelines/${segment(pipelineId)}/run`, { parameters }, options);
  }

  cancelPipelineRun(runId: string, options?: RequestOptions): Promise<PipelineRun> {
    return this.action(`/api/v2/pipeline-runs/${segment(runId)}/cancel`, undefined, options);
  }

  approvePipelineNode(runId: string, nodeRunId: string, approved: boolean, options?: RequestOptions): Promise<PipelineRun> {
    return this.action(`/api/v2/pipeline-runs/${segment(runId)}/approve`, { nodeRunId, approved }, options);
  }

  alertRules(options?: RequestOptions): Promise<AlertRule[]> {
    return this.list('alert-rules', options);
  }

  schedulingPolicies(options?: RequestOptions): Promise<SchedulingPolicy[]> {
    return this.list('scheduling-policies', options);
  }

  secrets(options?: RequestOptions): Promise<SecretMetadata[]> {
    return this.list('secrets', options);
  }

  putSecret(input: { name: string; value: string; description?: string; scope?: SecretMetadata['scope']; scopeId?: string; tags?: string[] }, options?: RequestOptions): Promise<SecretMetadata> {
    return this.create('secrets', input, options);
  }

  backups(options?: RequestOptions): Promise<BackupRecord[]> {
    return this.list('backups', options);
  }

  createBackup(options?: RequestOptions): Promise<BackupRecord> {
    return this.create('backups', {}, options);
  }

  restoreBackup(backupId: string, options?: RequestOptions): Promise<{ restoreStaged: true; restartRequired: true; backupId: string; preRestoreBackupId: string }> {
    return this.action(`/api/v2/backups/${segment(backupId)}/restore`, { confirm: true }, options);
  }

  agentTeams(options?: RequestOptions): Promise<AgentTeam[]> {
    return this.list('agent-teams', options);
  }

  createEnrollmentToken(input: { label: string; role?: string; groupIds?: string[]; expiresInSeconds?: number; maxUses?: number }, options?: RequestOptions): Promise<{ token: string; record: FleetV2Snapshot['enrollmentTokens'][number]; enrollmentUrl: string }> {
    return this.request('/api/v2/enrollment/tokens', { method: 'POST', body: input, options });
  }

  async list<T>(resource: string, options?: RequestOptions): Promise<T[]> {
    return this.request(`/api/v2/${resourceName(resource)}`, { options });
  }

  async create<T>(resource: string, input: unknown, options?: RequestOptions): Promise<T> {
    return this.request(`/api/v2/${resourceName(resource)}`, { method: 'POST', body: input, options });
  }

  async update<T>(resource: string, id: string, input: unknown, options?: RequestOptions): Promise<T> {
    return this.request(`/api/v2/${resourceName(resource)}/${segment(id)}`, { method: 'PATCH', body: input, options });
  }

  async remove(resource: string, id: string, options?: RequestOptions): Promise<void> {
    await this.request(`/api/v2/${resourceName(resource)}/${segment(id)}`, { method: 'DELETE', options });
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; options?: RequestOptions } = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.baseHeaders,
      ...init.options?.headers,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetcher(`${this.baseUrl}${safePath(path)}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.options?.signal,
      redirect: 'error',
    });
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    let payload: unknown = raw;
    if (raw && (contentType.includes('application/json') || contentType.includes('+json'))) {
      try { payload = JSON.parse(raw); }
      catch { throw new FleetApiError(response.status, 'Fleet Core returned invalid JSON.', raw.slice(0, 4_096)); }
    } else if (!raw) payload = undefined;
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Fleet API request failed (${response.status}).`;
      throw new FleetApiError(response.status, message, payload);
    }
    return payload as T;
  }

  private action<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request(path, { method: 'POST', body: body ?? {}, options });
  }
}

function segment(value: string): string {
  if (!value || value.includes('/') || value.includes('..')) throw new Error('Invalid Fleet resource identifier.');
  return encodeURIComponent(value);
}

function resourceName(value: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error('Invalid Fleet resource name.');
  return value;
}

function safePath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://') || value.includes('\\') || value.includes('#') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Fleet API paths must be relative to the configured Core.');
  return value;
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Fleet Core base URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Fleet Core base URL must be an absolute HTTP(S) URL.');
  if (url.username || url.password) throw new Error('Fleet Core base URL must not contain credentials.');
  if (url.search || url.hash) throw new Error('Fleet Core base URL must not contain a query or fragment.');
}
