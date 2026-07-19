import { describe, expect, it, vi } from 'vitest';
import { FleetApiError, FleetClient } from '../src/index.js';

describe('FleetClient', () => {
  it('attaches bearer authentication and JSON bodies', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'run-1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const client = new FleetClient({ baseUrl: 'https://core.example/', token: 'secret', fetch: fetcher });
    await client.runPipeline('pipeline-1', { dataset: 'v14' });
    expect(fetcher).toHaveBeenCalledWith('https://core.example/api/v2/pipelines/pipeline-1/run', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer secret', 'content-type': 'application/json' }),
      body: JSON.stringify({ parameters: { dataset: 'v14' } }),
      redirect: 'error',
    }));
  });

  it('surfaces API errors with status and detail', async () => {
    const client = new FleetClient({
      baseUrl: 'http://core',
      fetch: async () => new Response(JSON.stringify({ error: 'denied' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    });
    await expect(client.snapshot()).rejects.toEqual(expect.objectContaining<FleetApiError>({ status: 403, message: 'denied' }));
  });

  it('rejects unsafe resource paths', async () => {
    const client = new FleetClient({ baseUrl: 'http://core', fetch: vi.fn() });
    await expect(client.list('../secrets')).rejects.toThrow('Invalid Fleet resource name');
  });

  it('rejects credential-bearing base URLs and malformed JSON', async () => {
    expect(() => new FleetClient({ baseUrl: 'https://token@example.test' })).toThrow('must not contain credentials');
    const client = new FleetClient({ baseUrl: 'https://core.example', fetch: async () => new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }) });
    await expect(client.snapshot()).rejects.toEqual(expect.objectContaining<FleetApiError>({ message: 'Fleet Core returned invalid JSON.' }));
  });

  it('requires explicit confirmation when restoring a backup', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ restoreStaged: true, restartRequired: true, backupId: 'backup-1', preRestoreBackupId: 'backup-safe' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new FleetClient({ baseUrl: 'https://core.example', fetch: fetcher });
    await expect(client.restoreBackup('backup-1')).resolves.toMatchObject({ restoreStaged: true, restartRequired: true });
    expect(fetcher).toHaveBeenCalledWith('https://core.example/api/v2/backups/backup-1/restore', expect.objectContaining({ body: JSON.stringify({ confirm: true }) }));
  });
});
