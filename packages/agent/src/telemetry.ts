import os from 'node:os';
import si from 'systeminformation';
import type { BatteryMetrics, DeviceMetrics, FanMetrics, GpuMetrics, ServiceHealthMetrics, StorageMetrics } from '@fleet/shared';
import { getTailscaleIdentity } from './tailscale.js';

export interface HostInformation {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  osName: string;
  osVersion: string;
}

export async function getHostInformation(): Promise<HostInformation> {
  try {
    const info = await si.osInfo();
    return {
      hostname: info.hostname || os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osName: info.distro || info.platform || process.platform,
      osVersion: info.release || os.release(),
    };
  } catch {
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osName: os.type(),
      osVersion: os.release(),
    };
  }
}

export async function collectMetrics(): Promise<DeviceMetrics> {
  const [cpuInfo, load, temperature, memory, filesystems, graphics, network, battery, processes, services, tailscale] = await Promise.all([
    safely(() => si.cpu()),
    safely(() => si.currentLoad()),
    safely(() => si.cpuTemperature()),
    safely(() => si.mem()),
    safely(() => si.fsSize()),
    safely(() => si.graphics()),
    safely(() => si.networkStats()),
    safely(() => si.battery()),
    safely(() => si.processes()),
    safely(() => si.services('*')),
    getTailscaleIdentity(),
  ]);

  const totalMemory = memory?.total ?? os.totalmem();
  const usedMemory = memory?.active ?? memory?.used ?? totalMemory - os.freemem();
  const cpuUsage = finite(load?.currentLoad, fallbackCpuUsage());
  const rxBytesPerSecond = (network ?? []).reduce((sum, item) => sum + finite(item.rx_sec, 0), 0);
  const txBytesPerSecond = (network ?? []).reduce((sum, item) => sum + finite(item.tx_sec, 0), 0);
  const gpus = normalizeGpus(graphics?.controllers ?? []);
  const fans = normalizeFans(gpus);
  const powerDrawWatts = sumGpuPowerDraw(gpus);
  const batteryMetrics = normalizeBattery(battery);
  const serviceHealth = normalizeServiceHealth(services);

  return {
    cpu: {
      model: cpuInfo ? [cpuInfo.manufacturer, cpuInfo.brand].filter(Boolean).join(' ') : os.cpus()[0]?.model ?? 'Unknown CPU',
      cores: cpuInfo?.cores ?? os.cpus().length,
      usagePercent: roundPercent(cpuUsage),
      ...(temperature && finite(temperature.main, 0) > 0 ? { temperatureCelsius: round(temperature.main) } : {}),
    },
    memory: {
      totalBytes: totalMemory,
      usedBytes: usedMemory,
      usagePercent: roundPercent(totalMemory > 0 ? usedMemory / totalMemory * 100 : 0),
    },
    storage: normalizeStorage(filesystems ?? []),
    gpus,
    network: {
      rxBytesPerSecond: Math.max(0, Math.round(rxBytesPerSecond)),
      txBytesPerSecond: Math.max(0, Math.round(txBytesPerSecond)),
      ...(tailscale.ip ? { tailscaleIp: tailscale.ip } : {}),
      ...(tailscale.dnsName ? { tailscaleDnsName: tailscale.dnsName } : {}),
    },
    ...(batteryMetrics ? { battery: batteryMetrics } : {}),
    ...(powerDrawWatts !== undefined ? { powerDrawWatts, powerDrawSource: 'gpu' as const } : {}),
    ...(fans.length > 0 ? { fans } : {}),
    ...(processes && isFiniteNumber(processes.all) ? { processCount: Math.max(0, Math.floor(processes.all)) } : {}),
    ...(processes && isFiniteNumber(processes.running) ? { runningProcessCount: Math.max(0, Math.floor(processes.running)) } : {}),
    ...(serviceHealth ? { serviceHealth } : {}),
    uptimeSeconds: Math.max(0, Math.round(os.uptime())),
    sampledAt: new Date().toISOString(),
  };
}

function normalizeStorage(filesystems: Awaited<ReturnType<typeof si.fsSize>>): StorageMetrics[] {
  return filesystems
    .filter((filesystem) => finite(filesystem.size, 0) > 0 && Boolean(filesystem.mount))
    .map((filesystem) => {
      const size = finite(filesystem.size, 0);
      const used = Math.max(0, finite(filesystem.used, 0));
      return {
        totalBytes: size,
        usedBytes: used,
        usagePercent: roundPercent(finite(filesystem.use, size > 0 ? used / size * 100 : 0)),
        mount: filesystem.mount,
      };
    })
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

export function normalizeGpus(controllers: Awaited<ReturnType<typeof si.graphics>>['controllers']): GpuMetrics[] {
  return controllers.map((gpu) => {
    const vram = finite(gpu.vram, 0);
    const memoryUsed = finite(gpu.memoryUsed, 0);
    const temperature = finite(gpu.temperatureGpu, 0);
    const fanSpeed = optionalFinite(gpu.fanSpeed);
    const powerDraw = optionalFinite(gpu.powerDraw);
    const powerLimit = optionalFinite(gpu.powerLimit);
    return {
      vendor: gpu.vendor || 'Unknown',
      model: gpu.model || 'Unknown GPU',
      ...(vram > 0 ? { vramTotalBytes: Math.round(vram * 1024 ** 2) } : {}),
      ...(memoryUsed > 0 ? { vramUsedBytes: Math.round(memoryUsed * 1024 ** 2) } : {}),
      ...(gpu.utilizationGpu !== undefined && gpu.utilizationGpu !== null ? { usagePercent: roundPercent(gpu.utilizationGpu) } : {}),
      ...(temperature > 0 ? { temperatureCelsius: round(temperature) } : {}),
      ...(fanSpeed !== undefined && fanSpeed >= 0 ? { fanSpeedPercent: roundPercent(fanSpeed) } : {}),
      ...(powerDraw !== undefined && powerDraw >= 0 ? { powerDrawWatts: round(powerDraw) } : {}),
      ...(powerLimit !== undefined && powerLimit > 0 ? { powerLimitWatts: round(powerLimit) } : {}),
    };
  });
}

export function normalizeBattery(battery: Awaited<ReturnType<typeof si.battery>> | undefined): BatteryMetrics | undefined {
  if (!battery?.hasBattery || !isFiniteNumber(battery.percent)) return undefined;
  const percent = roundPercent(battery.percent);
  const timeRemaining = optionalFinite(battery.timeRemaining);
  const cycleCount = optionalFinite(battery.cycleCount);
  return {
    state: battery.isCharging ? 'charging' : battery.acConnected && percent >= 99 ? 'full' : battery.acConnected ? 'connected' : 'discharging',
    percent,
    isCharging: Boolean(battery.isCharging),
    acConnected: Boolean(battery.acConnected),
    ...(timeRemaining !== undefined && timeRemaining > 0 ? { timeRemainingMinutes: Math.round(timeRemaining) } : {}),
    ...(cycleCount !== undefined && cycleCount > 0 ? { cycleCount: Math.floor(cycleCount) } : {}),
  };
}

export function normalizeServiceHealth(services: Awaited<ReturnType<typeof si.services>> | undefined): ServiceHealthMetrics | undefined {
  if (!services?.length) return undefined;
  const running = services.filter((service) => service.running).length;
  return { total: services.length, running, stopped: services.length - running };
}

export function normalizeFans(gpus: GpuMetrics[]): FanMetrics[] {
  return gpus.flatMap((gpu) => gpu.fanSpeedPercent === undefined ? [] : [{ label: gpu.model, speedPercent: gpu.fanSpeedPercent }]);
}

export function sumGpuPowerDraw(gpus: GpuMetrics[]): number | undefined {
  const readings = gpus.map((gpu) => gpu.powerDrawWatts).filter((value): value is number => value !== undefined && Number.isFinite(value));
  return readings.length > 0 ? round(readings.reduce((sum, value) => sum + value, 0)) : undefined;
}

async function safely<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}

function fallbackCpuUsage(): number {
  const load = os.loadavg()[0] ?? 0;
  return os.cpus().length > 0 ? load / os.cpus().length * 100 : 0;
}

function finite(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalFinite(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundPercent(value: number): number {
  return Math.min(100, Math.max(0, round(value)));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
