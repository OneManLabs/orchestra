import { randomUUID } from 'node:crypto';
import type { FleetRole, FleetV2Snapshot } from '@fleet/shared';

const role = (name: string, description: string, permissions: string[], builtIn = true): FleetRole => ({
  id: `role-${name.toLowerCase().replaceAll(' ', '-')}`,
  name,
  description,
  permissions,
  builtIn,
});

export function createV2State(): FleetV2Snapshot {
  const createdAt = new Date().toISOString();
  const organizationId = randomUUID();
  return {
    schemaVersion: 2,
    protocolVersion: 2,
    sites: [],
    groups: [],
    deviceProfiles: [],
    enrollmentTokens: [],
    deviceCredentials: [],
    agentReleases: [],
    updateRollouts: [],
    metricHistory: [],
    alertRules: [],
    alerts: [],
    audit: [],
    secrets: [],
    backups: [],
    artifacts: [],
    transfers: [],
    storageConnections: [],
    pipelines: [],
    pipelineRuns: [],
    schedulingPolicies: [],
    schedulingDecisions: [],
    notificationChannels: [{
      id: 'channel-desktop', name: 'Fleet desktop', kind: 'desktop', enabled: true,
      config: {}, createdAt, updatedAt: createdAt,
    }],
    notifications: [],
    apiTokens: [],
    webhooks: [],
    plugins: [],
    desktopSessions: [],
    diagnostics: [],
    policies: [],
    organizations: [{ id: organizationId, name: 'My Fleet', slug: 'my-fleet', createdAt }],
    workspaces: [{ id: 'workspace-default', organizationId, name: 'Operations', description: 'Default fleet workspace', createdAt }],
    roles: [
      role('Organization owner', 'Complete administrative control.', ['*']),
      role('Fleet administrator', 'Manage devices, jobs, pipelines, and policies.', ['devices:*', 'jobs:*', 'pipelines:*', 'artifacts:*', 'policies:*', 'audit:read']),
      role('Operator', 'Operate approved fleet workloads.', ['devices:read', 'jobs:*', 'pipelines:run', 'artifacts:read', 'sessions:*']),
      role('Approver', 'Review privileged and production actions.', ['approvals:*', 'devices:read', 'jobs:read', 'audit:read']),
      role('Auditor', 'Inspect fleet state and immutable records.', ['*:read', 'audit:read']),
      role('Read-only viewer', 'View fleet health and activity.', ['devices:read', 'jobs:read', 'pipelines:read', 'artifacts:read']),
    ],
    members: [],
    advancedSessions: [],
    agentTeams: [],
    jobHistory: [],
  };
}

export function hydrateV2(value: unknown): FleetV2Snapshot {
  const fallback = createV2State();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const incoming = value as Record<string, unknown>;
  const hydrated = { ...fallback } as FleetV2Snapshot;
  for (const key of Object.keys(fallback) as Array<keyof FleetV2Snapshot>) {
    const candidate = incoming[key];
    if (Array.isArray(fallback[key])) {
      (hydrated as unknown as Record<string, unknown>)[key] = Array.isArray(candidate) ? candidate : fallback[key];
    }
  }
  hydrated.schemaVersion = typeof incoming.schemaVersion === 'number' ? Math.max(2, incoming.schemaVersion) : 2;
  hydrated.protocolVersion = typeof incoming.protocolVersion === 'number' ? incoming.protocolVersion : 2;
  return hydrated;
}
