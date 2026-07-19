import type { Device, FleetDeviceMention } from '@fleet/shared';

function normalizeDeviceAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function preferredDeviceAlias(device: Device): string {
  const name = normalizeDeviceAlias(device.name);
  const hostname = normalizeDeviceAlias(device.hostname.replace(/\.local$/i, ''));
  const memoryGb = Math.round(device.metrics.memory.totalBytes / 1024 ** 3);
  const gpuModel = device.metrics.gpus.map((gpu) => gpu.model.match(/\b(\d{4})\b/)?.[1]).find(Boolean);
  if (gpuModel) return gpuModel;
  if (device.role === 'storage' && (name.includes('nas') || hostname.includes('nas'))) return 'nas';
  if (name.includes('macbookpro') || hostname.includes('macbookpro')) return 'mbp';
  if (name.includes('macmini') && memoryGb > 0) return `mini${memoryGb}`;
  if (device.role === 'core') return 'core';
  return compactWords(device.name) || hostname || device.id;
}

function deviceAliases(device: Device): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeDeviceAlias(value ?? '');
    if (normalized) values.add(normalized);
  };
  add(preferredDeviceAlias(device));
  add(device.id);
  add(device.name);
  add(device.hostname);
  add(device.hostname.replace(/\.local$/i, ''));
  add(compactWords(device.name));
  add(initials(device.name));
  add(device.role);
  for (const gpu of device.metrics.gpus) {
    add(gpu.model);
    for (const model of gpu.model.match(/\b\d{4}\b/g) ?? []) add(model);
  }
  const memoryGb = Math.round(device.metrics.memory.totalBytes / 1024 ** 3);
  if (device.name.toLowerCase().includes('mac mini') && memoryGb > 0) add(`mini${memoryGb}`);
  if (device.role === 'storage' && `${device.name} ${device.hostname}`.toLowerCase().includes('nas')) add('nas');
  if (`${device.name} ${device.hostname}`.toLowerCase().includes('macbook pro')) add('mbp');
  return [...values];
}

export function resolveDeviceMentions(text: string, devices: Device[]): FleetDeviceMention[] {
  const mentions: FleetDeviceMention[] = [];
  for (const match of text.matchAll(/@([A-Za-z0-9._-]+)/g)) {
    const token = match[0];
    const alias = normalizeDeviceAlias(match[1] ?? '');
    if (!alias) continue;
    const matching = devices.filter((device) => deviceAliases(device).includes(alias));
    const available = matching.filter((device) => device.status !== 'offline');
    const candidates = matching.length > 1 && available.length === 1 ? available : matching;
    mentions.push({
      token,
      alias,
      deviceIds: candidates.map((device) => device.id),
      label: candidates.length === 1 ? candidates[0]!.name : candidates.length > 1 ? candidates.map((device) => device.name).join(', ') : token,
      status: candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unknown',
    });
  }
  return mentions;
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function compactWords(value: string): string {
  return words(value).join('').toLowerCase();
}

function initials(value: string): string {
  return words(value).map((word) => word[0]).join('').toLowerCase();
}
