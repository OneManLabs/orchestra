import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEnrollmentUrl, exchangeEnrollmentToken, persistDeviceCredential, readDeviceCredential } from '../src/credential-store.js';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('device credential persistence', () => {
  it('normalizes the enrollment exchange URL', () => {
    expect(buildEnrollmentUrl('wss://core.example.test/base/')).toBe('https://core.example.test/base/api/v2/enrollment/exchange');
  });

  it('persists and reloads a per-device credential without broad Unix permissions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-credential-test-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'credential.json');
    const credential = {
      credential: 'device-secret', credentialId: 'cred-1', deviceId: 'device-1',
      coreUrl: 'https://core.example.test', protocolVersion: 2, issuedAt: new Date().toISOString(),
    };
    await persistDeviceCredential(file, credential);
    expect(await readDeviceCredential(file)).toEqual(credential);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('exchanges the documented enrollment payload for a device credential', async () => {
    let received: unknown;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ credential: 'issued-secret', credentialId: 'credential-1', deviceId: 'device-1', coreUrl: 'http://127.0.0.1', protocolVersion: 2 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No enrollment test address.');
    try {
      expect(await exchangeEnrollmentToken(`http://127.0.0.1:${address.port}`, 'one-time-token', {
        id: 'device-1', name: 'Worker', hostname: 'worker', platform: 'linux', arch: 'arm64',
      })).toMatchObject({ credential: 'issued-secret', credentialId: 'credential-1', protocolVersion: 2 });
      expect(received).toMatchObject({ token: 'one-time-token', device: { id: 'device-1', agentVersion: '2.0.0', protocolVersion: 2 } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
