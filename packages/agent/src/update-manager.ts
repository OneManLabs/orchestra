import { createHash, verify } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentToCoreMessage, UpdateChannel } from '@fleet/shared';

type SendMessage = (message: AgentToCoreMessage) => void;

interface UpdateManifest {
  version: string;
  channel: UpdateChannel;
  url: string;
  checksumSha256: string;
  signature?: string;
  signatureStatus: 'absent' | 'unverified' | 'verified';
  sizeBytes: number;
  preparedAt: string;
  artifactPath: string;
}

interface ActiveUpdate {
  version: string;
  previousVersion?: string;
  activatedAt: string;
  restartRequested: boolean;
}

export class UpdateManager {
  private readonly updatesDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly maxUpdateBytes: number,
    private readonly publicKey: string | undefined,
    private readonly requireSignedUpdates: boolean,
    private readonly send: SendMessage,
  ) {
    this.updatesDirectory = path.join(dataDirectory, 'updates');
  }

  async prepare(input: { version: string; url: string; checksumSha256: string; signature?: string; channel: UpdateChannel }): Promise<unknown> {
    const version = validateVersion(input.version);
    const expectedChecksum = validateChecksum(input.checksumSha256);
    const url = validateUpdateUrl(input.url);
    const stagingDirectory = path.join(this.updatesDirectory, 'staging', version);
    await rm(stagingDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(stagingDirectory, 'release.download');
    const artifactPath = path.join(stagingDirectory, 'release.package');
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Update download failed with HTTP ${response.status}.`);
    validateUpdateUrl(response.url);
    const announcedSize = Number(response.headers.get('content-length') ?? 0);
    if (announcedSize > this.maxUpdateBytes) throw new Error(`Update exceeds the ${this.maxUpdateBytes}-byte size limit.`);

    const transferId = `update-${version}`;
    const digest = createHash('sha256');
    const handle = await open(temporaryPath, 'wx', 0o600);
    let transferredBytes = 0;
    let downloadError: unknown;
    try {
      const reader = response.body.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        transferredBytes += chunk.length;
        if (transferredBytes > this.maxUpdateBytes) {
          await reader.cancel('Update size limit exceeded');
          throw new Error(`Update exceeds the ${this.maxUpdateBytes}-byte size limit.`);
        }
        digest.update(chunk);
        await handle.write(chunk);
        this.send({ type: 'transfer.progress', payload: { transferId, transferredBytes, totalBytes: announcedSize || transferredBytes } });
      }
      await handle.sync();
    } catch (error) {
      downloadError = error;
    } finally {
      await handle.close();
    }
    if (downloadError) {
      await rm(temporaryPath, { force: true });
      throw downloadError;
    }

    const actualChecksum = digest.digest('hex');
    if (actualChecksum !== expectedChecksum) {
      await rm(temporaryPath, { force: true });
      throw new Error(`Update checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}.`);
    }
    const signatureStatus = verifySignature(expectedChecksum, input.signature, await resolvePublicKey(this.publicKey));
    try {
      assertSignaturePolicy(input.channel, signatureStatus, this.requireSignedUpdates);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rename(temporaryPath, artifactPath);
    const manifest: UpdateManifest = {
      version,
      channel: input.channel,
      url: url.toString(),
      checksumSha256: expectedChecksum,
      ...(input.signature ? { signature: input.signature } : {}),
      signatureStatus,
      sizeBytes: transferredBytes,
      preparedAt: new Date().toISOString(),
      artifactPath,
    };
    await atomicJson(path.join(stagingDirectory, 'manifest.json'), manifest);
    this.send({ type: 'transfer.progress', payload: { transferId, transferredBytes, totalBytes: transferredBytes, checksumSha256: actualChecksum } });
    return { ...manifest, state: 'prepared' };
  }

  async apply(versionInput: string, restart: boolean): Promise<unknown> {
    const version = validateVersion(versionInput);
    const stagingDirectory = path.join(this.updatesDirectory, 'staging', version);
    const manifest = await readManifest(path.join(stagingDirectory, 'manifest.json'));
    if (manifest.version !== version) throw new Error('Staged update version does not match the requested version.');
    const checksum = await checksumFile(manifest.artifactPath);
    if (checksum !== manifest.checksumSha256) throw new Error('Staged update failed checksum verification before apply.');
    assertSignaturePolicy(manifest.channel, manifest.signatureStatus, this.requireSignedUpdates);
    const releasesDirectory = path.join(this.updatesDirectory, 'releases');
    const releaseDirectory = path.join(releasesDirectory, version);
    await mkdir(releasesDirectory, { recursive: true, mode: 0o700 });
    await rm(releaseDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, releaseDirectory);
    manifest.artifactPath = path.join(releaseDirectory, 'release.package');
    await atomicJson(path.join(releaseDirectory, 'manifest.json'), manifest);
    const current = await readActive(path.join(this.updatesDirectory, 'active.json'));
    const active: ActiveUpdate = {
      version,
      ...(current?.version ? { previousVersion: current.version } : {}),
      activatedAt: new Date().toISOString(),
      restartRequested: restart,
    };
    await atomicJson(path.join(this.updatesDirectory, 'active.json'), active);
    return {
      version,
      previousVersion: active.previousVersion,
      state: 'pending-service-installer',
      restartRequired: restart,
      artifactPath: manifest.artifactPath,
      detail: 'Release is verified and activated in agent state; the platform service installer must replace the running binary.',
    };
  }

  async rollback(versionInput: string): Promise<unknown> {
    const version = validateVersion(versionInput);
    const releaseDirectory = path.join(this.updatesDirectory, 'releases', version);
    const manifest = await readManifest(path.join(releaseDirectory, 'manifest.json'));
    const checksum = await checksumFile(manifest.artifactPath);
    if (checksum !== manifest.checksumSha256) throw new Error('Rollback release failed checksum verification.');
    const current = await readActive(path.join(this.updatesDirectory, 'active.json'));
    await atomicJson(path.join(this.updatesDirectory, 'active.json'), {
      version,
      ...(current?.version ? { previousVersion: current.version } : {}),
      activatedAt: new Date().toISOString(),
      restartRequested: true,
    } satisfies ActiveUpdate);
    return { version, previousVersion: current?.version, state: 'pending-service-installer', restartRequired: true, artifactPath: manifest.artifactPath };
  }
}

export function validateUpdateUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Update URLs must use HTTPS; HTTP is allowed only for loopback development.');
  }
  if (url.username || url.password) throw new Error('Update URLs must not contain embedded credentials.');
  return url;
}

export function verifySignature(checksum: string, signature: string | undefined, publicKey: string | undefined): UpdateManifest['signatureStatus'] {
  if (!signature) return 'absent';
  if (!publicKey) return 'unverified';
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature)) throw new Error('Update signature is not valid base64.');
  const signatureBytes = Buffer.from(signature, 'base64');
  if (!verify(null, Buffer.from(checksum, 'hex'), publicKey, signatureBytes)) throw new Error('Update signature verification failed.');
  return 'verified';
}

export function assertSignaturePolicy(channel: UpdateChannel, status: UpdateManifest['signatureStatus'], requireSignedUpdates: boolean): void {
  if (status === 'verified') return;
  if (channel === 'development' && !requireSignedUpdates) return;
  throw new Error(`${channel} updates require a signature verified by FLEET_UPDATE_PUBLIC_KEY.`);
}

async function resolvePublicKey(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value;
  return readFile(path.resolve(value), 'utf8');
}

async function checksumFile(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  const digest = createHash('sha256');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

async function readManifest(filePath: string): Promise<UpdateManifest> {
  const value = JSON.parse(await readFile(filePath, 'utf8')) as UpdateManifest;
  if (!value || typeof value.version !== 'string' || typeof value.artifactPath !== 'string' || typeof value.checksumSha256 !== 'string') {
    throw new Error('Update manifest is invalid.');
  }
  return value;
}

async function readActive(filePath: string): Promise<ActiveUpdate | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as ActiveUpdate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function validateVersion(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)) throw new Error('Update version contains unsupported characters.');
  return value;
}

function validateChecksum(value: string): string {
  const checksum = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Update checksum must be a SHA-256 hex digest.');
  return checksum;
}
