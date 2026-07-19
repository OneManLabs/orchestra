#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Request, Response } from 'express';
import { createFleetMcpServer, type FleetMcpOptions } from './server.js';

interface CliOptions extends FleetMcpOptions { transport: 'stdio' | 'http'; host: string; port: number; mcpToken?: string; }

const options: CliOptions = {
  coreUrl: process.env.FLEET_CORE_URL ?? 'http://127.0.0.1:4780',
  token: process.env.FLEET_TOKEN,
  readOnly: process.env.FLEET_MCP_READ_ONLY === 'true',
  allowedTools: process.env.FLEET_MCP_ALLOWED_TOOLS?.split(',').map((item) => item.trim()).filter(Boolean),
  transport: (process.env.FLEET_MCP_TRANSPORT as 'stdio' | 'http') ?? 'stdio',
  host: process.env.FLEET_MCP_HOST ?? '127.0.0.1',
  port: Number(process.env.FLEET_MCP_PORT ?? 4790),
  mcpToken: process.env.FLEET_MCP_TOKEN,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--read-only') { options.readOnly = true; continue; }
  if (flag === '--help') {
    process.stdout.write('Usage: fleet-mcp [--transport stdio|http] [--core URL] [--read-only] [--allow-tools names] [--host HOST] [--port PORT]\nUse environment variables for bearer tokens so they do not appear in the process list.\n');
    process.exit(0);
  }
  const value = process.argv[++index]; if (!value) throw new Error(`Missing value for ${flag}.`);
  if (flag === '--core') options.coreUrl = value;
  else if (flag === '--token') options.token = value;
  else if (flag === '--transport') options.transport = value as 'stdio' | 'http';
  else if (flag === '--host') options.host = value;
  else if (flag === '--port') options.port = Number(value);
  else if (flag === '--mcp-token') options.mcpToken = value;
  else if (flag === '--allow-tools') options.allowedTools = value.split(',').map((item) => item.trim()).filter(Boolean);
  else throw new Error(`Unknown option: ${flag}`);
}

if (!['stdio', 'http'].includes(options.transport)) throw new Error('Transport must be stdio or http.');
validateCoreUrl(options.coreUrl);
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error('MCP port must be an integer between 1 and 65535.');

if (options.transport === 'stdio') {
  const server = createFleetMcpServer(options);
  await server.connect(new StdioServerTransport());
} else {
  if (!isLoopback(options.host) && !options.mcpToken) throw new Error('FLEET_MCP_TOKEN is required when HTTP MCP listens beyond loopback.');
  if (options.mcpToken && Buffer.byteLength(options.mcpToken) < 32) throw new Error('FLEET_MCP_TOKEN must contain at least 32 bytes.');
  const allowedHosts = process.env.FLEET_MCP_ALLOWED_HOSTS?.split(',').map((item) => item.trim()).filter(Boolean);
  const app = createMcpExpressApp({ host: options.host, allowedHosts });
  const denied = new Map<string, { count: number; resetAt: number }>();
  app.use('/mcp', (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (isLoopback(options.host) && !options.mcpToken) { next(); return; }
    const address = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let attempt = denied.get(address);
    if (!attempt || attempt.resetAt <= now) { attempt = { count: 0, resetAt: now + 60_000 }; denied.set(address, attempt); }
    if (attempt.count >= 12) {
      response.setHeader('retry-after', String(Math.ceil((attempt.resetAt - now) / 1_000)));
      response.status(429).json({ error: 'Too many failed MCP authentication attempts.' });
      return;
    }
    const supplied = bearer(request.headers.authorization);
    if (!options.mcpToken || !safeEqual(supplied, options.mcpToken)) {
      attempt.count += 1;
      response.setHeader('www-authenticate', 'Bearer');
      response.status(401).json({ error: 'MCP authentication required.' });
      return;
    }
    denied.delete(address);
    next();
  });
  app.post('/mcp', async (request: Request, response: Response) => {
    const server = createFleetMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      void transport.close().finally(() => server.close());
    };
    response.once('finish', close);
    response.once('close', close);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      process.stderr.write(`[fleet-mcp] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error' }, id: null });
      else response.end();
    }
  });
  app.all('/mcp', (_request: Request, response: Response) => response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  const http = createHttpServer(app);
  http.on('error', (error) => { process.stderr.write(`[fleet-mcp] HTTP server failed: ${error.message}\n`); process.exitCode = 1; });
  http.listen(options.port, options.host, () => process.stderr.write(`[fleet-mcp] Streamable HTTP listening at http://${options.host}:${options.port}/mcp\n`));
  const stop = (): void => { http.close(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function isLoopback(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }
function bearer(value: string | undefined): string { return value?.startsWith('Bearer ') ? value.slice(7) : ''; }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function validateCoreUrl(value: string): void { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Orchestra Core URL must be an HTTP(S) URL without embedded credentials.'); }
