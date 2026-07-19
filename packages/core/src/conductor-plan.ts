import { randomUUID } from 'node:crypto';
import type { CodexActor, Device, FleetConductorPlan, FleetConductorStep, FleetProject } from '@fleet/shared';

export interface BuildConductorPlanInput {
  objective: string;
  devices: Device[];
  projects: FleetProject[];
  explicitDeviceIds: string[];
  actor?: CodexActor;
  now?: string;
}

export function buildConductorPlan(input: BuildConductorPlanInput): FleetConductorPlan {
  const now = input.now ?? new Date().toISOString();
  const objective = input.objective.trim();
  const project = selectProject(objective, input.projects);
  const explicit = input.explicitDeviceIds
    .map((id) => input.devices.find((device) => device.id === id))
    .filter((device): device is Device => Boolean(device));
  const targets = explicit.length ? explicit : bestAutomaticTarget(objective, input.devices, project);
  const steps: FleetConductorStep[] = [];

  if (!targets.length) {
    steps.push({
      id: randomUUID(),
      kind: 'codex',
      title: 'Select an execution device',
      detail: 'No online Codex-capable device currently satisfies this plan.',
      status: 'blocked',
      projectId: project?.id,
      dependsOn: [],
      permissionMode: 'workspace-write',
      selectionReason: 'No eligible device is currently connected.',
    });
  } else {
    for (const device of targets) {
      const mapped = !project || project.paths.some((path) => path.deviceId === device.id);
      const connected = device.status !== 'offline' && device.presence?.summary !== 'agent-offline' && device.presence?.summary !== 'host-unreachable';
      const blockedReason = !connected
        ? `${device.name} has no live Agent heartbeat.`
        : !device.capabilities.codex
          ? `${device.name} does not report Codex readiness.`
          : !mapped
            ? `${project?.name ?? 'The project'} has no workspace mapping on ${device.name}.`
            : undefined;
      steps.push({
        id: randomUUID(),
        kind: 'codex',
        title: `Delegate to ${device.name}`,
        detail: blockedReason ?? `Start a workspace-write Codex session on ${device.name}${project ? ` for ${project.name}` : ''}.`,
        status: blockedReason ? 'blocked' : 'pending',
        deviceId: device.id,
        projectId: project?.id,
        dependsOn: [],
        permissionMode: 'workspace-write',
        selectionReason: explicit.length
          ? 'Explicitly selected with an @device mention.'
          : automaticSelectionReason(objective, device, project),
        error: blockedReason,
      });
    }
  }

  if (requestsPreview(objective)) {
    const hostStep = steps.find((step) => step.kind === 'codex' && step.status === 'pending' && step.deviceId);
    const previewBlockedReason = !project
      ? 'Mention or register a project before Orchestra can create a persistent preview.'
      : !hostStep
        ? 'No eligible project device is available to host the preview.'
        : undefined;
    steps.push({
      id: randomUUID(),
      kind: 'preview',
      title: project ? `Publish ${project.name} preview` : 'Publish project preview',
      detail: previewBlockedReason ?? 'Keep a private tailnet preview healthy and expose it through Website/View Site.',
      status: previewBlockedReason ? 'blocked' : 'pending',
      deviceId: hostStep?.deviceId,
      projectId: project?.id,
      dependsOn: hostStep ? [hostStep.id] : [],
      selectionReason: hostStep ? 'Uses the same mapped device as the primary Codex step.' : undefined,
      error: previewBlockedReason,
    });
  }

  return {
    id: randomUUID(),
    title: planTitle(objective),
    objective,
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    actor: input.actor,
    steps,
  };
}

function selectProject(objective: string, projects: FleetProject[]): FleetProject | undefined {
  const query = objective.toLowerCase();
  const named = projects
    .filter((project) => query.includes(project.name.toLowerCase()))
    .sort((left, right) => right.name.length - left.name.length)[0];
  return named ?? (projects.length === 1 ? projects[0] : undefined);
}

function bestAutomaticTarget(objective: string, devices: Device[], project?: FleetProject): Device[] {
  const query = objective.toLowerCase();
  const wantsGpu = /\b(?:gpu|cuda|inference|model|render|train)\b/.test(query);
  const candidates = devices
    .filter((device) => device.status !== 'offline' && device.capabilities.codex)
    .filter((device) => !project || project.paths.some((path) => path.deviceId === device.id))
    .sort((left, right) => score(right, wantsGpu, project) - score(left, wantsGpu, project));
  return candidates.slice(0, 1);
}

function score(device: Device, wantsGpu: boolean, project?: FleetProject): number {
  let value = 0;
  if (device.status === 'online') value += 40;
  if (device.status === 'busy') value += 20;
  if (device.presence?.summary === 'operational') value += 30;
  if (project?.preferredDeviceIds.includes(device.id)) value += 25;
  if (wantsGpu && (device.capabilities.cuda || device.capabilities.mlx || device.role === 'gpu')) value += 50;
  value -= device.activeJobIds.length * 6 + device.activeSessionIds.length * 4;
  value -= device.metrics.cpu.usagePercent / 10;
  return value;
}

function automaticSelectionReason(objective: string, device: Device, project?: FleetProject): string {
  const gpu = /\b(?:gpu|cuda|inference|model|render|train)\b/i.test(objective)
    && (device.capabilities.cuda || device.capabilities.mlx || device.role === 'gpu');
  if (gpu) return 'Best available mapped Codex device with requested GPU capability.';
  if (project?.preferredDeviceIds.includes(device.id)) return 'Preferred online device for this project.';
  return 'Best available online Codex device after load and project-locality scoring.';
}

function requestsPreview(objective: string): boolean {
  return /\b(?:preview|website|view site|landing page|web app|dev server|site)\b/i.test(objective);
}

function planTitle(objective: string): string {
  const normalized = objective.replace(/@[A-Za-z0-9._-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Conductor plan';
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).trimEnd()}…`;
}
