import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{5,127}$/;

export async function getOrCreateDeviceId(dataDir: string, configuredId?: string): Promise<string> {
  if (configuredId) return validateDeviceId(configuredId);
  const idPath = path.join(dataDir, 'device-id');
  try {
    const stored = (await readFile(idPath, 'utf8')).trim();
    if (DEVICE_ID_PATTERN.test(stored)) return stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = deterministicDeviceId();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${idPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, idPath);
  return generated;
}

export function deterministicDeviceId(): string {
  const interfaces = os.networkInterfaces();
  const macs = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00')
    .map((entry) => entry.mac.toLowerCase())
    .sort();
  const identity = [os.hostname().toLowerCase(), process.platform, process.arch, ...macs].join('|');
  return `fleet-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function validateDeviceId(value: string): string {
  const id = value.trim();
  if (!DEVICE_ID_PATTERN.test(id)) {
    throw new Error('Device ID must be 6-128 characters and contain only letters, numbers, dots, colons, underscores, or dashes.');
  }
  return id;
}
