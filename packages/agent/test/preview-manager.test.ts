import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentToCoreMessage } from '@fleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPreviewInvocation, PreviewManager } from '../src/preview-manager.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('shared project previews', () => {
  it('detects common framework and package-manager development commands', async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^7.0.0' },
    }));
    await writeFile(path.join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const invocation = await detectPreviewInvocation(directory);

    expect(invocation).toMatchObject({
      command: 'pnpm',
      framework: 'Vite',
      defaultPort: 5173,
    });
    expect(invocation.args).toEqual(['run', 'dev', '--', '--host', '127.0.0.1', '--port', '$PORT']);
  });

  it('starts a dev server, publishes a private endpoint, reports logs, and cleans up', async () => {
    const directory = await temporaryDirectory();
    const port = await availablePort();
    await writeFile(path.join(directory, 'server.mjs'), `
      import http from 'node:http';
      const port = Number(process.env.PORT);
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('fleet preview');
      });
      server.listen(port, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + port));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `);
    const sent: AgentToCoreMessage[] = [];
    const configure = vi.fn(async () => ({
      url: 'https://preview.device.tailnet.ts.net:24443/',
      dnsName: 'preview.device.tailnet.ts.net',
      transport: 'tailscale-serve' as const,
    }));
    const disable = vi.fn(async () => {});
    const onStart = vi.fn();
    const onStop = vi.fn();
    const manager = new PreviewManager(
      'device-1',
      (message) => sent.push(message),
      undefined,
      { configure, disable },
      onStart,
      onStop,
    );

    const preview = await manager.start({
      projectId: 'project-1',
      projectName: 'Fleet Canvas',
      cwd: directory,
      configuredCommand: `${JSON.stringify(process.execPath)} server.mjs`,
      port,
      servePort: 24_443,
      visibility: 'tailnet',
      autoStartWithCodex: true,
      stopAfterMinutes: 120,
    });

    expect(preview).toMatchObject({
      projectId: 'project-1',
      deviceId: 'device-1',
      status: 'running',
      visibility: 'tailnet',
      port,
      servePort: 24_443,
      url: 'https://preview.device.tailnet.ts.net:24443/',
      transport: 'tailscale-serve',
      desiredState: 'running',
      autoStartWithCodex: true,
      health: { state: 'healthy', consecutiveFailures: 0 },
    });
    expect(preview.logs.map((log) => log.text).join('\n')).toContain('Private Tailscale Serve available');
    expect(configure).toHaveBeenCalledWith({ visibility: 'tailnet', servePort: 24_443, targetPort: port });
    expect(sent.some((message) => message.type === 'preview.updated' && message.payload.preview.status === 'running')).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);

    const stopped = await manager.stop('project-1');
    expect(stopped.status).toBe('stopped');
    expect(stopped.desiredState).toBe('stopped');
    expect(disable).toHaveBeenCalledWith({ visibility: 'tailnet', servePort: 24_443 });
    expect(onStop).toHaveBeenCalledTimes(1);
  }, 10_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-preview-'));
  directories.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a preview test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
