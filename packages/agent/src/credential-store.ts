import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedFleetAgentOptions } from './config.js';
import { AGENT_VERSION, PROTOCOL_VERSION } from './constants.js';

export interface EnrollmentDevice {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
}

export interface PersistedDeviceCredential {
  credential: string;
  credentialId: string;
  deviceId: string;
  coreUrl: string;
  protocolVersion: number;
  issuedAt: string;
  expiresAt?: string;
}

export async function resolveAgentCredential(options: ResolvedFleetAgentOptions, device: EnrollmentDevice): Promise<string> {
  if (options.tokenIsExplicit) return requireCredential(options.token);
  const persisted = await readDeviceCredential(options.credentialFile);
  if (persisted && (!persisted.expiresAt || new Date(persisted.expiresAt).getTime() > Date.now())) return persisted.credential;
  if (options.enrollmentToken) {
    const enrolled = await exchangeEnrollmentToken(options.coreUrl, options.enrollmentToken, device);
    if (enrolled.deviceId !== device.id) throw new Error('Fleet Core returned a credential for a different device ID.');
    await persistDeviceCredential(options.credentialFile, enrolled);
    return enrolled.credential;
  }
  if (options.token) return requireCredential(options.token);
  throw new Error('Fleet authentication is required. Set FLEET_ENROLLMENT_TOKEN for first enrollment or FLEET_TOKEN for recovery.');
}

export async function readDeviceCredential(filePath: string): Promise<PersistedDeviceCredential | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<PersistedDeviceCredential>;
    if (typeof value.credential !== 'string' || !value.credential || typeof value.credentialId !== 'string' || typeof value.deviceId !== 'string') return undefined;
    return {
      credential: value.credential,
      credentialId: value.credentialId,
      deviceId: value.deviceId,
      coreUrl: typeof value.coreUrl === 'string' ? value.coreUrl : '',
      protocolVersion: typeof value.protocolVersion === 'number' ? value.protocolVersion : PROTOCOL_VERSION,
      issuedAt: typeof value.issuedAt === 'string' ? value.issuedAt : new Date(0).toISOString(),
      ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function persistDeviceCredential(filePath: string, credential: PersistedDeviceCredential): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises');
    await chmod(filePath, 0o600);
  }
}

export async function exchangeEnrollmentToken(coreUrl: string, token: string, device: EnrollmentDevice): Promise<PersistedDeviceCredential> {
  const endpoint = buildEnrollmentUrl(coreUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      device: { ...device, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Fleet enrollment failed with HTTP ${response.status}.`);
  const value = await response.json() as Record<string, unknown>;
  if (typeof value.credential !== 'string' || !value.credential
    || typeof value.credentialId !== 'string' || typeof value.deviceId !== 'string'
    || typeof value.coreUrl !== 'string' || typeof value.protocolVersion !== 'number') {
    throw new Error('Fleet Core returned an invalid enrollment response.');
  }
  if (value.protocolVersion < PROTOCOL_VERSION) throw new Error(`Fleet Core protocol ${value.protocolVersion} is older than required protocol ${PROTOCOL_VERSION}.`);
  return {
    credential: value.credential,
    credentialId: value.credentialId,
    deviceId: value.deviceId,
    coreUrl: value.coreUrl,
    protocolVersion: value.protocolVersion,
    issuedAt: new Date().toISOString(),
    ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
  };
}

export function buildEnrollmentUrl(coreUrl: string): string {
  const url = new URL(coreUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/api/v2/enrollment/exchange') ? pathname : `${pathname}/api/v2/enrollment/exchange`;
  url.search = '';
  return url.toString();
}

function requireCredential(value: string): string {
  if (!value.trim()) throw new Error('Fleet credential cannot be empty.');
  return value;
}
