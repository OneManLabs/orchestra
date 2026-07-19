import { describe, expect, it } from 'vitest';
import { defineFleetPlugin, fleetPluginManifestSchema } from '../src/index.js';

describe('Fleet plugin manifest', () => {
  const manifest = {
    schemaVersion: 1 as const,
    id: 'com.example.notify',
    name: 'Example notifications',
    version: '1.0.0',
    description: 'Sends an example notification.',
    publisher: 'Example',
    entrypoint: './dist/index.js',
    capabilities: ['notification' as const],
    minimumFleetVersion: '2.0.0',
    permissions: { networkDomains: [], filesystemRoots: [], secretNames: [], fleetScopes: [] },
  };

  it('accepts a least-privilege manifest', () => {
    expect(fleetPluginManifestSchema.parse(manifest).id).toBe('com.example.notify');
  });

  it('rejects undeclared runtime capabilities', () => {
    expect(() => defineFleetPlugin({ manifest, scheduler: { score: async () => ({ score: 1, reasons: [] }) } })).toThrow('scheduler capability');
  });

  it('rejects entrypoints that escape the plugin package', () => {
    expect(() => fleetPluginManifestSchema.parse({ ...manifest, entrypoint: '../outside.js' })).toThrow('entrypoint');
    expect(() => fleetPluginManifestSchema.parse({ ...manifest, entrypoint: '/tmp/plugin.js' })).toThrow('entrypoint');
  });

  it('applies manifest defaults to the returned module', () => {
    const { permissions: _permissions, minimumFleetVersion: _minimum, ...minimal } = manifest;
    const plugin = defineFleetPlugin({ manifest: minimal as typeof manifest });
    expect(plugin.manifest.permissions.networkDomains).toEqual([]);
    expect(plugin.manifest.minimumFleetVersion).toBe('2.0.0');
  });
});
