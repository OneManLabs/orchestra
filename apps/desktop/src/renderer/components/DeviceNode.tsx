import type { Device } from '@fleet/shared';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Cpu, Database, Gauge, HardDrive, Laptop, MemoryStick, Network, Server, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../lib/format';

export type DeviceCanvasNode = Node<{ device: Device; onAssignJob(jobId: string, deviceId: string): void }, 'device'>;

const roleIcons = { core: Server, gpu: Gauge, worker: Cpu, gateway: Network, storage: Database, workstation: Laptop, phone: Smartphone, unknown: HardDrive };

export function DeviceNode({ data, selected }: NodeProps<DeviceCanvasNode>) {
  const { device } = data;
  const Icon = roleIcons[device.role] ?? HardDrive;
  const gpu = device.metrics.gpus[0];
  const ram = device.metrics.memory;
  const isOnline = device.status !== 'offline';
  const presenceLabel = device.presence?.label ?? (isOnline ? 'Agent connected' : 'Offline');
  const [dropActive, setDropActive] = useState(false);

  return (
    <div
      className={`device-node device-node--${device.status} ${selected ? 'is-selected' : ''} ${dropActive ? 'is-drop-target' : ''}`}
      aria-label={`${device.name}, ${presenceLabel}`}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes('application/x-fleet-job')) { event.preventDefault(); setDropActive(true); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-fleet-job')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDropActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDropActive(false); const jobId = event.dataTransfer.getData('application/x-fleet-job'); if (jobId) data.onAssignJob(jobId, device.id); }}
    >
      <Handle type="target" position={Position.Left} className="node-handle" />
      <div className="device-node__header">
        <div className="device-node__icon"><Icon size={17} strokeWidth={1.8} /></div>
        <div className="device-node__identity">
          <strong>{device.name}</strong>
          <span>{device.osName || device.platform} · {device.arch}</span>
        </div>
        <span className={`status-dot status-dot--${device.status}`} title={device.status} />
      </div>

      <div className="device-node__metrics">
        <Metric label="CPU" value={`${Math.round(device.metrics.cpu.usagePercent)}%`} percent={device.metrics.cpu.usagePercent} />
        <Metric label="RAM" value={`${formatBytes(ram.usedBytes)} / ${formatBytes(ram.totalBytes)}`} percent={ram.usagePercent} />
        {gpu && <Metric label="GPU" value={`${Math.round(gpu.usagePercent ?? 0)}%`} percent={gpu.usagePercent ?? 0} accent />}
      </div>

      <div className="device-node__footer">
        <span className="role-pill">{device.role}</span>
        <span title={device.presence?.detail}>{device.activeJobIds.length ? `${device.activeJobIds.length} active` : presenceLabel}</span>
      </div>
      {dropActive && <div className="device-drop-overlay"><Gauge size={17} /><strong>Assign to {device.name}</strong><span>Release to dispatch</span></div>}
      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  );
}

function Metric({ label, value, percent, accent = false }: { label: string; value: string; percent: number; accent?: boolean }) {
  return (
    <div className="node-metric">
      <div><span>{label}</span><strong>{value}</strong></div>
      <div className="metric-track"><i className={accent ? 'accent' : ''} style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} /></div>
    </div>
  );
}
