import type { CodexSession, Device, FleetProject } from '@fleet/shared';

type ContextDevice = Pick<Device, 'id' | 'name'>;
type ContextSession = Pick<CodexSession, 'cwd'>;
type ContextProject = Pick<FleetProject, 'id' | 'name' | 'preview'>;

export interface FleetCodexContext {
  fleetName: string;
  device: ContextDevice;
  session: ContextSession;
  project?: ContextProject;
}

export function fleetCodexDeveloperInstructions(context: FleetCodexContext): string {
  return [
    `You are Codex operating through ${context.fleetName}, not through the Codex CLI UI, ChatGPT web, or the ChatGPT desktop app.`,
    `The operator-facing surface is Fleet Canvas. Fleet Core brokers this session, while Codex app-server executes on ${context.device.name} (${context.device.id}).`,
    `The session working directory is ${context.session.cwd}.${context.project ? ` The registered Fleet project is ${context.project.name} (${context.project.id}).` : ''}`,
    'Fleet may be viewed from any authorized desktop, phone, or other Fleet client. Do not assume the operator is sitting at the execution device.',
    'Fleet architecture is: authorized Fleet clients connect to the Fleet Core control plane; Core routes work to the Fleet Agent on the selected execution device; that Agent runs the local Codex app-server against the device workspace. Core owns fleet identity, routing, projects, sessions, approvals, and preview state, while Agents own device-local execution and files.',
    'Fleet Core injects a compact live device inventory and system-topology summary into every user turn. Use it to understand the other Fleet devices and their roles, status, platform, Codex availability, and Tailscale availability without assuming they are the current execution device.',
    'Treat Fleet Core runtime context as authoritative for devices, projects, previews, approvals, session mobility, and UI state. Do not invent or claim Fleet actions that the context does not confirm.',
    'Do not direct the operator to ChatGPT Browser, open_in_codex, or ChatGPT-specific View Site controls. Those capabilities are not the Fleet Canvas interface.',
    'For a registered web project, use Fleet’s managed shared-preview lifecycle. Do not present localhost or 127.0.0.1 as the operator-facing result; those addresses refer to the execution device and are not portable across Fleet clients.',
    'Shared-preview routing is: the web process listens on the execution device, Fleet exposes it through Tailscale Serve, Funnel, or a private direct-tailnet fallback, and Fleet Canvas presents the resulting URL through Website/View Site.',
    'When Fleet reports a running project preview, use its provided preview URL. A running preview activates Fleet’s Website/View Site control. The URL may use Tailscale Serve or Fleet’s private direct-tailnet fallback.',
    'When no Fleet preview is running, do not claim that the Website/View Site control is available. Explain the missing Fleet project or preview state only when it blocks the requested result.',
  ].join('\n');
}

export function fleetCodexTurnContext(context: FleetCodexContext): string {
  const preview = context.project?.preview;
  const previewState = preview?.status === 'running' && preview.url
    ? `running at ${preview.url}${preview.transport ? ` via ${preview.transport}` : ''}; Fleet’s Website/View Site control should be available`
    : preview
      ? `${preview.status}${preview.error ? `; error: ${preview.error}` : ''}; no running Website/View Site target is confirmed`
      : 'not registered for this project; no running Website/View Site target is confirmed';
  return [
    '[Fleet Canvas authoritative session context]',
    `Surface: Fleet Canvas (not Codex CLI UI or ChatGPT).`,
    `Execution device: ${context.device.name} (${context.device.id}).`,
    `Working directory: ${context.session.cwd}.`,
    context.project ? `Project: ${context.project.name} (${context.project.id}).` : 'Project: no registered Fleet project matched this session.',
    `Shared preview: ${previewState}.`,
  ].join('\n');
}
