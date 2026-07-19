import type { Device, ActivityEvent } from '@fleet/shared';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type Edge, type NodeMouseHandler, useEdgesState, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Boxes, GripVertical, LocateFixed, Radio, TerminalSquare, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useFleet } from '../state/FleetContext';
import { DeviceNode, type DeviceCanvasNode } from '../components/DeviceNode';
import { EmptyState } from '../components/EmptyState';

const nodeTypes = { device: DeviceNode };

export function CanvasPage({ selectedId, onSelect }: { selectedId: string | null; onSelect(id: string | null): void }) {
  const { snapshot, request } = useFleet();
  const devices = snapshot?.devices ?? [];
  const queuedJobs = snapshot?.jobs.filter((job) => job.status === 'queued') ?? [];
  const assignJob = useCallback((jobId: string, deviceId: string) => {
    void request(() => api.assignJob(jobId, deviceId)).catch(() => undefined);
  }, [request]);
  const generatedNodes = useMemo(() => devices.map((device, index): DeviceCanvasNode => ({
    id: device.id,
    type: 'device',
    position: device.position ?? defaultPosition(index),
    data: { device, onAssignJob: assignJob },
    selected: device.id === selectedId
  })), [assignJob, devices, selectedId]);
  const generatedEdges = useMemo(() => inferEdges(devices), [devices]);
  const [nodes, setNodes, onNodesChange] = useNodesState<DeviceCanvasNode>(generatedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(generatedEdges);

  useEffect(() => {
    setNodes((current) => generatedNodes.map((node) => ({ ...node, position: current.find((item) => item.id === node.id)?.position ?? node.position })));
  }, [generatedNodes, setNodes]);
  useEffect(() => setEdges(generatedEdges), [generatedEdges, setEdges]);

  const clickNode: NodeMouseHandler<DeviceCanvasNode> = useCallback((_event, node) => onSelect(node.id), [onSelect]);

  if (!devices.length) return (
    <div className="canvas-empty"><EmptyState icon={WifiOff} title="No devices have checked in" description="Start an Orchestra Agent on a device and point it at this Core. The canvas only shows real registered devices." action={<button className="secondary-button" onClick={() => void window.navigator.clipboard?.writeText('npm run dev:agent')}><Boxes size={15} />Copy agent command</button>} /></div>
  );

  return (
    <div className="canvas-layout">
      <div className="canvas-stage">
        <div className="canvas-hud">
          <div><Radio size={14} /><strong>{devices.filter((device) => device.status !== 'offline').length}</strong> live nodes</div>
          <span>{devices.reduce((sum, device) => sum + device.activeJobIds.length, 0)} active jobs</span>
        </div>
        {queuedJobs.length > 0 && <div className="job-tray" aria-label="Queued jobs"><header><span>Queued work</span><strong>{queuedJobs.length}</strong><small>Drag a job onto a device</small></header><div>{queuedJobs.map((job) => <article key={job.id} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-fleet-job', job.id); }}><GripVertical size={13} /><span className="job-tray__icon">{job.kind === 'shell' ? <TerminalSquare size={13} /> : <Boxes size={13} />}</span><div><strong>{job.name}</strong><small>{job.requiredLabels.length ? job.requiredLabels.join(' · ') : 'Any compatible device'}</small></div></article>)}</div></div>}
        <ReactFlow<DeviceCanvasNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={clickNode}
          onPaneClick={() => onSelect(null)}
          onNodeDragStop={(_event, node) => void request(() => api.updateDevice(node.id, { position: node.position })).catch(() => undefined)}
          fitView
          fitViewOptions={{ padding: 0.25, minZoom: 0.55, maxZoom: 1.05 }}
          minZoom={0.3}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: 'smoothstep', animated: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.1} color="#283341" />
          <Controls position="bottom-left" showInteractive={false} orientation="horizontal"><button className="react-flow__controls-button" title="Center fleet"><LocateFixed size={14} /></button></Controls>
          <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => statusColor((node.data as { device: Device }).device.status)} maskColor="#080b10b8" />
        </ReactFlow>
      </div>
      <ActivityRail activity={snapshot?.activity.slice(0, 14) ?? []} />
    </div>
  );
}

function defaultPosition(index: number) { return { x: 80 + (index % 3) * 330, y: 90 + Math.floor(index / 3) * 260 }; }

function inferEdges(devices: Device[]): Edge[] {
  const core = devices.find((device) => device.role === 'core');
  const storage = devices.find((device) => device.role === 'storage');
  const edges: Edge[] = [];
  if (core) {
    for (const device of devices) if (device.id !== core.id) edges.push({ id: `core-${device.id}`, source: core.id, target: device.id, className: device.status === 'offline' ? 'edge-offline' : 'edge-live', animated: device.activeJobIds.length > 0, label: device.activeJobIds.length > 0 ? `${device.activeJobIds.length} active` : undefined });
  }
  if (storage) {
    for (const device of devices.filter((item) => ['gpu', 'worker', 'workstation'].includes(item.role))) {
      if (device.id !== storage.id && !edges.some((edge) => edge.source === storage.id && edge.target === device.id)) edges.push({ id: `storage-${device.id}`, source: storage.id, target: device.id, className: 'edge-storage' });
    }
  }
  return edges;
}

function statusColor(status: Device['status']) { return status === 'online' ? '#34d399' : status === 'busy' ? '#38bdf8' : status === 'degraded' ? '#fbbf24' : '#64748b'; }

function ActivityRail({ activity }: { activity: ActivityEvent[] }) {
  return <aside className="activity-rail"><header><div><span className="eyebrow">Live stream</span><h2>Activity</h2></div></header><div className="activity-stream">{activity.length === 0 ? <p className="muted centered">Waiting for fleet activity…</p> : activity.map((event) => <article className="activity-item" key={event.id}><i className={`activity-icon activity-icon--${event.severity}`} /><div><strong>{event.title}</strong><p>{event.detail}</p><time>{relativeTime(event.at)}</time></div></article>)}</div></aside>;
}
