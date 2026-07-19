import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSignaturePolicy, UpdateManager, validateUpdateUrl, verifySignature } from '../src/update-manager.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

describe('update staging foundations', () => {
  it('downloads, verifies, stages, and activates a release without replacing the live executable', async () => {
    const payload = Buffer.from('fleet-agent-release');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address.');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-update-test-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const events: unknown[] = [];
    const updates = new UpdateManager(directory, 1024, undefined, false, (event) => events.push(event));
    const prepared = await updates.prepare({ version: '0.2.1', url: `http://127.0.0.1:${address.port}/agent.pkg`, checksumSha256: checksum, channel: 'development' });
    expect(prepared).toMatchObject({ state: 'prepared', checksumSha256: checksum, signatureStatus: 'absent' });
    expect(await updates.apply('0.2.1', true)).toMatchObject({ state: 'pending-service-installer', restartRequired: true });
    expect(events.length).toBeGreaterThan(0);
  });

  it('rejects insecure remote URLs and never calls an unverified signature verified', () => {
    expect(() => validateUpdateUrl('http://updates.example.test/agent.pkg')).toThrow(/HTTPS/);
    expect(verifySignature('0'.repeat(64), Buffer.from('signature').toString('base64'), undefined)).toBe('unverified');
    expect(() => assertSignaturePolicy('stable', 'unverified', false)).toThrow(/verified/);
    expect(() => assertSignaturePolicy('development', 'absent', true)).toThrow(/verified/);
    expect(() => assertSignaturePolicy('development', 'absent', false)).not.toThrow();
  });

  it('verifies an Ed25519 signature over the release digest', () => {
    const checksum = createHash('sha256').update('release').digest('hex');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, Buffer.from(checksum, 'hex'), privateKey).toString('base64');
    expect(verifySignature(checksum, signature, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe('verified');
  });

  it('does not stage bytes whose SHA-256 differs from the release manifest', async () => {
    const payload = Buffer.from('tampered-release');
    const server = createServer((_request, response) => response.end(payload));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address.');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-update-test-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const updates = new UpdateManager(directory, 1024, undefined, false, () => {});
    await expect(updates.prepare({
      version: '0.2.2', url: `http://127.0.0.1:${address.port}/agent.pkg`, checksumSha256: '0'.repeat(64), channel: 'development',
    })).rejects.toThrow(/checksum mismatch/);
  });
});
