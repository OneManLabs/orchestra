import { createServer, request as createRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';

export interface BoundHttpProxy {
  close(): Promise<void>;
}

export async function startBoundHttpProxy(input: {
  listenHost: string;
  listenPort: number;
  targetHost?: string;
  targetPort: number;
}): Promise<BoundHttpProxy> {
  const targetHost = input.targetHost ?? '127.0.0.1';
  const server = createServer((request, response) => {
    const upstream = createRequest({
      host: targetHost,
      port: input.targetPort,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request.headers, targetHost, input.targetPort),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('The Fleet preview development server is unavailable.');
    });
    request.once('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on('upgrade', (request, client, head) => {
    const upstream = connect(input.targetPort, targetHost);
    upstream.once('connect', () => {
      const requestLine = `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}\r\n`;
      upstream.write(requestLine);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        const value = name.toLowerCase() === 'host'
          ? `${targetHost}:${input.targetPort}`
          : request.rawHeaders[index + 1] ?? '';
        upstream.write(`${name}: ${value}\r\n`);
      }
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.listenPort, input.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    close: () => closeServer(server),
  };
}

function proxyHeaders(headers: IncomingHttpHeaders, targetHost: string, targetPort: number): IncomingHttpHeaders {
  const next = { ...headers };
  next.host = `${targetHost}:${targetPort}`;
  delete next['proxy-authorization'];
  delete next['proxy-authenticate'];
  return next;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
