import { execFileSync } from 'node:child_process';

/**
 * Prefer an explicitly configured identity, then a stable identity from the
 * login keychain. Ad-hoc signing is a last resort because its designated
 * requirement changes on every build and invalidates macOS privacy grants.
 */
export function resolveCodesignIdentity() {
  const configured = process.env.ORCHESTRA_CODESIGN_IDENTITY?.trim()
    || process.env.FLEET_CODESIGN_IDENTITY?.trim();
  if (configured) return configured;

  try {
    const identities = execFileSync(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' },
    );
    const match = identities.match(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/m);
    if (match?.[1]) return match[1];
  } catch {
    // Source installations on machines without a development certificate
    // remain usable, but macOS may ask for privacy permissions after updates.
  }

  return '-';
}
