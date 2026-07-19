export function fleetCoreRequestError(path: string, status: number, payload: unknown): string {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const error = typeof value.error === 'string' ? value.error : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const missingRpcRoute = status === 404
    && /\/api\/sessions\/[^/]+\/rpc$/.test(path)
    && (message?.startsWith('Route ') || (!message && error === 'Not Found'));
  if (missingRpcRoute) {
    return 'Orchestra Core is older than this Desktop build and does not expose Codex commands. Fully quit and reopen Orchestra to restart Desktop, Core, and Agent together.';
  }
  return error ?? message ?? `Request failed (${status})`;
}
