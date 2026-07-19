const MAX_FLEET_API_PATH_LENGTH = 16_384;

export function resolveFleetCoreApiUrl(coreUrl: string, input: string): string {
  if (!input.startsWith('/api/') || input.startsWith('//') || input.length > MAX_FLEET_API_PATH_LENGTH || input.includes('#')) {
    throw new Error('Only Orchestra Core API paths are allowed');
  }

  const queryIndex = input.indexOf('?');
  const encodedPathname = queryIndex < 0 ? input : input.slice(0, queryIndex);
  let decodedPathname: string;
  try { decodedPathname = decodeURIComponent(encodedPathname); }
  catch { throw new Error('Invalid Orchestra Core path'); }
  if (decodedPathname.includes('\\') || decodedPathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Only Orchestra Core API paths are allowed');
  }

  const origin = new URL(coreUrl).origin;
  const resolved = new URL(input, `${origin}/`);
  if (resolved.origin !== origin || !resolved.pathname.startsWith('/api/')) {
    throw new Error('Invalid Orchestra Core path');
  }
  return resolved.toString();
}
