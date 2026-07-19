import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startBoundHttpProxy, type BoundHttpProxy } from '../src/http-proxy.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe('bound HTTP preview proxy', () => {
  it('forwards HTTP requests without exposing the upstream bind address', async () => {
    const upstreamPort = await availablePort();
    const proxyPort = await availablePort();
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
    });
    await listen(upstream, upstreamPort);
    cleanup.push(() => close(upstream));

    const proxy = await startBoundHttpProxy({
      listenHost: '127.0.0.1',
      listenPort: proxyPort,
      targetPort: upstreamPort,
    });
    cleanup.push(() => proxy.close());

    const response = await fetch(`http://127.0.0.1:${proxyPort}/fleet?device=mini64`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: '/fleet?device=mini64',
      host: `127.0.0.1:${upstreamPort}`,
    });
  });
});

async function availablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a proxy test port.');
  await close(server);
  return address.port;
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
