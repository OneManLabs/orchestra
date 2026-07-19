import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetMcpServer } from '../src/server.js';

afterEach(() => vi.unstubAllGlobals());

describe('Fleet MCP server', () => {
  it('exposes typed read tools and returns Core state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/snapshot')) return json({ devices: [{ id: 'device-1', status: 'online' }], v2: {} });
      return json({ ok: true });
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFleetMcpServer({ coreUrl: 'http://core', token: 'token', readOnly: true });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'fleet_list_devices')).toBe(true);
    const response = await client.callTool({ name: 'fleet_list_devices', arguments: { onlineOnly: true } });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.structuredContent)).toContain('device-1');
    await client.close(); await server.close();
  });

  it('blocks mutations in read-only mode', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFleetMcpServer({ coreUrl: 'http://core', readOnly: true, allowedTools: ['fleet_restart_device'] });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: 'fleet_restart_device', arguments: { deviceId: 'device-1', confirm: true } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain('read-only');
    await client.close(); await server.close();
  });

  it('does not let scheduler selection write through read-only mode', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFleetMcpServer({ coreUrl: 'http://core', readOnly: true, allowedTools: ['fleet_find_capable_device'] });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: 'fleet_find_capable_device', arguments: { requiredLabels: [], preferredDeviceIds: [] } });
    expect(response.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await client.close(); await server.close();
  });
});

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
