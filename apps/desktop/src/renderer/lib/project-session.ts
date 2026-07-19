import type { CodexSession, FleetProject } from '@fleet/shared';

type SessionProjectContext = Pick<CodexSession, 'projectId' | 'deviceId' | 'cwd'>;
type ProjectContext = Pick<FleetProject, 'id' | 'paths'>;

export function normalizedFleetPath(value: string): string {
  let normalized = value.trim().replaceAll('\\', '/').toLowerCase();
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

export function projectPathContainsSessionCwd(projectPath: string, sessionCwd: string): boolean {
  const project = normalizedFleetPath(projectPath);
  const session = normalizedFleetPath(sessionCwd);
  if (project.length <= 1) return session === project;
  return session === project || session.startsWith(`${project}/`);
}

export function projectForCodexSession<T extends ProjectContext>(
  session: SessionProjectContext,
  projects: readonly T[],
): T | undefined {
  if (session.projectId) {
    const exact = projects.find((project) => project.id === session.projectId);
    if (exact) return exact;
  }

  return projects
    .flatMap((project) => project.paths
      .filter((path) => path.deviceId === session.deviceId)
      .filter((path) => projectPathContainsSessionCwd(path.path, session.cwd))
      .map((path) => ({ project, length: normalizedFleetPath(path.path).length })))
    .sort((left, right) => right.length - left.length)[0]?.project;
}
