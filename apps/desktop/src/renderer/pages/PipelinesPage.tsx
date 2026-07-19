import type {
  Device,
  NotificationChannel,
  PermissionMode,
  PipelineDefinition,
  PipelineEdgeDefinition,
  PipelineNodeDefinition,
  PipelineNodeRun,
  PipelineNodeType,
  PipelineRun
} from '@fleet/shared';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  useEdgesState,
  useNodesState
} from '@xyflow/react';
import {
  AlertTriangle,
  Bell,
  Bot,
  Box,
  Braces,
  Check,
  CircleStop,
  Clock3,
  GitBranch,
  GitFork,
  Globe2,
  Hammer,
  Link2,
  Play,
  Plus,
  Power,
  Rocket,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  TestTube2,
  Trash2,
  Webhook,
  X,
  XCircle,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatePill } from '../components/V2Ui';
import { apiV2 } from '../lib/api';
import { relativeTime, titleCase } from '../lib/format';
import { useFleet } from '../state/FleetContext';
import { PageHeader } from './JobsPage';

type PipelineCanvasNode = Node<{ definition: PipelineNodeDefinition; runState?: string }, 'pipeline'>;
type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type PipelineIssue = { message: string; nodeId?: string; edgeId?: string };

const nodeTypes = { pipeline: PipelineNode };
const palette: Array<{ type: PipelineNodeType; icon: LucideIcon }> = [
  { type: 'codex', icon: Bot },
  { type: 'shell', icon: SquareTerminal },
  { type: 'python', icon: Braces },
  { type: 'git', icon: GitBranch },
  { type: 'test', icon: TestTube2 },
  { type: 'build', icon: Hammer },
  { type: 'training', icon: Zap },
  { type: 'evaluation', icon: Check },
  { type: 'deployment', icon: Rocket },
  { type: 'http', icon: Globe2 },
  { type: 'webhook', icon: Webhook },
  { type: 'transfer', icon: Send },
  { type: 'wait', icon: Clock3 },
  { type: 'notification', icon: Bell },
  { type: 'approval', icon: ShieldCheck },
  { type: 'wake', icon: Zap },
  { type: 'shutdown', icon: Power }
];

const shellLikeTypes = new Set<PipelineNodeType>([
  'shell', 'python', 'git', 'docker', 'training', 'evaluation', 'test', 'build', 'deployment', 'transform', 'database', 'plugin'
]);

export function PipelinesPage() {
  const { snapshot } = useFleet();
  const pipelines = snapshot?.v2.pipelines ?? [];
  const runs = snapshot?.v2.pipelineRuns ?? [];
  const [selectedId, setSelectedId] = useState(pipelines[0]?.id ?? '');
  const [creating, setCreating] = useState(false);

  useEffect(() => { if (!selectedId && pipelines[0]) setSelectedId(pipelines[0].id); }, [pipelines, selectedId]);
  const pipeline = pipelines.find((item) => item.id === selectedId);
  const latestRun = runs.find((run) => run.pipelineId === selectedId);

  return <div className="page v2-page pipeline-page">
    <PageHeader eyebrow="Workflow fabric" title="Pipelines" detail="Design, dispatch, and observe multi-device workflows" action={<button className="primary-button" onClick={() => setCreating(true)}><Plus size={15} />New pipeline</button>} />
    {pipelines.length ? <div className="pipeline-shell">
      <aside className="pipeline-list">
        <header><span>Definitions</span><strong>{pipelines.length}</strong></header>
        {pipelines.map((item) => {
          const active = runs.find((run) => run.pipelineId === item.id && ['running', 'awaiting-approval', 'queued'].includes(run.state));
          return <button key={item.id} className={item.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
            <span className="pipeline-list__icon"><GitFork size={15} /></span>
            <div><strong>{item.name}</strong><small>v{item.version} · {item.nodes.length} nodes</small></div>
            {active ? <StatePill value={active.state} /> : <i className={`status-dot ${item.status === 'active' ? 'status-dot--online' : ''}`} />}
          </button>;
        })}
      </aside>
      {pipeline && <PipelineWorkspace pipeline={pipeline} latestRun={latestRun} />}
    </div> : <EmptyState icon={GitFork} title="Build your first pipeline" description="Connect Codex, shell, transfer, training, evaluation, approvals, and deployment steps into a reusable workflow." action={<button className="primary-button" onClick={() => setCreating(true)}><Plus size={15} />Create pipeline</button>} />}
    {creating && <NewPipelineDialog onClose={() => setCreating(false)} onCreated={setSelectedId} />}
  </div>;
}

function PipelineWorkspace({ pipeline, latestRun }: { pipeline: PipelineDefinition; latestRun?: PipelineRun }) {
  const { snapshot, request } = useFleet();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pipeline);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  useEffect(() => {
    setDraft(pipeline);
    setEditing(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [pipeline.id, pipeline.version]);

  const runStates = useMemo(() => Object.fromEntries(latestRun?.nodeRuns.map((run) => [run.nodeId, run.state]) ?? []), [latestRun]);
  const generatedNodes = useMemo(() => draft.nodes.map((definition): PipelineCanvasNode => ({
    id: definition.id,
    type: 'pipeline',
    position: definition.position,
    data: { definition, runState: runStates[definition.id] },
    selected: selectedNodeId === definition.id
  })), [draft.nodes, runStates, selectedNodeId]);
  const generatedEdges = useMemo(() => draft.edges.map((edge): Edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label || (edge.condition !== 'success' ? titleCase(edge.condition) : undefined),
    animated: latestRun?.state === 'running',
    selected: selectedEdgeId === edge.id,
    className: `pipeline-edge pipeline-edge--${edge.condition}`
  })), [draft.edges, latestRun?.state, selectedEdgeId]);
  const [nodes, setNodes, onNodesChange] = useNodesState<PipelineCanvasNode>(generatedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(generatedEdges);
  useEffect(() => setNodes(generatedNodes), [generatedNodes, setNodes]);
  useEffect(() => setEdges(generatedEdges), [generatedEdges, setEdges]);

  const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = draft.edges.find((edge) => edge.id === selectedEdgeId);
  const issues = useMemo(() => validatePipelineDraft(draft), [draft]);
  const selectedNodeIssue = selectedNode ? issues.find((issue) => issue.nodeId === selectedNode.id)?.message : undefined;
  const selectedEdgeIssue = selectedEdge ? issues.find((issue) => issue.edgeId === selectedEdge.id)?.message : undefined;

  function addNode(type: PipelineNodeType) {
    const id = crypto.randomUUID();
    const node: PipelineNodeDefinition = {
      id,
      type,
      name: titleCase(type),
      position: { x: 120 + (draft.nodes.length % 3) * 240, y: 110 + Math.floor(draft.nodes.length / 3) * 150 },
      config: defaultConfig(type),
      requiredLabels: [],
      preferredDeviceIds: [],
      retries: 0,
      retryDelaySeconds: 5,
      continueOnFailure: false,
      approvalRequired: type === 'approval'
    };
    setDraft((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setEditing(true);
  }

  function connect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const edge: PipelineEdgeDefinition = { id: crypto.randomUUID(), source: connection.source, target: connection.target, condition: 'success' };
    setDraft((current) => ({ ...current, edges: [...current.edges, edge] }));
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
  }

  function updateNode(id: string, patch: Partial<PipelineNodeDefinition>) {
    setDraft((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }));
  }

  function updateEdge(id: string, patch: Partial<PipelineEdgeDefinition>) {
    setDraft((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === id ? { ...edge, ...patch } : edge) }));
  }

  function removeNode(id: string) {
    setDraft((current) => ({ ...current, nodes: current.nodes.filter((node) => node.id !== id), edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id) }));
    setSelectedNodeId(null);
  }

  function removeEdge(id: string) {
    setDraft((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== id) }));
    setSelectedEdgeId(null);
  }

  async function save() {
    if (issues.length) return;
    const positioned = draft.nodes.map((definition) => ({ ...definition, position: nodes.find((node) => node.id === definition.id)?.position ?? definition.position }));
    await request(() => apiV2.updatePipeline(draft.id, { ...draft, nodes: positioned, edges: draft.edges }));
    setEditing(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }

  function discard() {
    setDraft(pipeline);
    setNodes(generatedNodes);
    setEditing(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }

  return <section className="pipeline-workspace">
    <header className="pipeline-toolbar">
      <div><strong>{pipeline.name}</strong><span>v{pipeline.version}</span><StatePill value={latestRun?.state ?? pipeline.status} />{issues.length > 0 && <span className="pipeline-validation" title={issues.map((issue) => issue.message).join('\n')}><AlertTriangle size={12} />{issues.length} issue{issues.length === 1 ? '' : 's'}</span>}</div>
      <div>
        {editing && <button className="secondary-button compact" onClick={discard}>Discard</button>}
        <button className="secondary-button compact" onClick={() => setEditing((value) => !value)}><Settings2 size={14} />{editing ? 'Editing' : 'Edit'}</button>
        {editing ? <button className="primary-button compact" disabled={issues.length > 0} title={issues[0]?.message} onClick={() => void save().catch(() => undefined)}><Save size={14} />Save</button> : <button className="primary-button compact" disabled={issues.length > 0} title={issues[0]?.message} onClick={() => void request(() => apiV2.runPipeline(pipeline.id)).catch(() => undefined)}><Play size={14} />Run</button>}
        {latestRun && ['running', 'queued', 'awaiting-approval'].includes(latestRun.state) && <button className="danger-button compact" onClick={() => void request(() => apiV2.cancelPipelineRun(latestRun.id)).catch(() => undefined)}><CircleStop size={14} />Stop</button>}
      </div>
    </header>
    <div className={`pipeline-canvas-wrap ${editing ? 'is-editing' : ''}`}>
      {editing && <aside className="node-palette"><span>Node palette</span>{palette.map(({ type, icon: Icon }) => <button key={type} onClick={() => addNode(type)} title={`Add ${titleCase(type)}`}><Icon size={15} /><small>{titleCase(type)}</small></button>)}</aside>}
      <ReactFlow<PipelineCanvasNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={editing ? connect : undefined}
        onNodeClick={editing ? (_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); } : undefined}
        onEdgeClick={editing ? (_event, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); } : undefined}
        onNodeDragStop={editing ? (_event, node) => updateNode(node.id, { position: node.position }) : undefined}
        onPaneClick={() => { if (editing) { setSelectedNodeId(null); setSelectedEdgeId(null); } }}
        nodesDraggable={editing}
        nodesConnectable={editing}
        edgesFocusable={editing}
        elementsSelectable={editing}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: .25 }}
        minZoom={.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#293544" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap pannable nodeColor={(node) => stateColor((node.data as PipelineCanvasNode['data']).runState)} maskColor="#090d13b8" />
      </ReactFlow>
      {selectedNode && editing && <NodeEditor node={selectedNode} devices={snapshot?.devices ?? []} transfers={snapshot?.v2.transfers ?? []} channels={snapshot?.v2.notificationChannels ?? []} issue={selectedNodeIssue} onUpdate={(patch) => updateNode(selectedNode.id, patch)} onRemove={() => removeNode(selectedNode.id)} onClose={() => setSelectedNodeId(null)} />}
      {selectedEdge && editing && <EdgeEditor edge={selectedEdge} pipeline={draft} issue={selectedEdgeIssue} onUpdate={(patch) => updateEdge(selectedEdge.id, patch)} onRemove={() => removeEdge(selectedEdge.id)} onClose={() => setSelectedEdgeId(null)} />}
    </div>
    {latestRun && <RunPanel pipeline={pipeline} run={latestRun} />}
  </section>;
}

function NodeEditor({ node, devices, transfers, channels, issue, onUpdate, onRemove, onClose }: {
  node: PipelineNodeDefinition;
  devices: Device[];
  transfers: Array<{ id: string; source: { path: string }; destination: { path: string }; status: string }>;
  channels: NotificationChannel[];
  issue?: string;
  onUpdate(patch: Partial<PipelineNodeDefinition>): void;
  onRemove(): void;
  onClose(): void;
}) {
  const updateConfig = (key: string, value: unknown) => onUpdate({ config: { ...node.config, [key]: value } });
  const toggleDevice = (deviceId: string, enabled: boolean) => onUpdate({ preferredDeviceIds: enabled ? [...new Set([...node.preferredDeviceIds, deviceId])] : node.preferredDeviceIds.filter((id) => id !== deviceId) });
  return <aside className="node-editor pipeline-config-editor">
    <header><div><span className="eyebrow">{titleCase(node.type)} node</span><h3>{node.name}</h3></div><button className="icon-button" onClick={onClose} aria-label="Close node settings"><X size={16} /></button></header>
    {issue && <div className="pipeline-editor-warning"><AlertTriangle size={14} /><span>{issue}</span></div>}
    <label>Name<input value={node.name} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
    <label>Description<textarea rows={2} value={node.description ?? ''} onChange={(event) => onUpdate({ description: event.target.value })} /></label>
    <div className="pipeline-editor-section"><span className="eyebrow">Execution</span><NodeConfigFields node={node} devices={devices} transfers={transfers} channels={channels} updateConfig={updateConfig} onUpdate={onUpdate} /></div>
    {!['approval', 'human-input', 'wake', 'shutdown'].includes(node.type) && <fieldset className="pipeline-targets"><legend>Preferred devices</legend>{devices.length ? <div className="pipeline-check-list">{devices.map((device) => <label key={device.id}><input type="checkbox" checked={node.preferredDeviceIds.includes(device.id)} onChange={(event) => toggleDevice(device.id, event.target.checked)} /><span><strong>{device.name}</strong><small>{titleCase(device.role)} · {titleCase(device.status)}</small></span></label>)}</div> : <p>No devices registered.</p>}</fieldset>}
    <label>Required capability labels<input value={node.requiredLabels.join(', ')} onChange={(event) => onUpdate({ requiredLabels: splitList(event.target.value) })} placeholder="cuda:true, gpu:nvidia" /></label>
    <div className="form-grid pipeline-number-grid">
      <label>Retries<input type="number" min="0" max="100" value={node.retries} onChange={(event) => onUpdate({ retries: Math.max(0, Number(event.target.value)) })} /></label>
      <label>Retry delay (sec)<input type="number" min="0" value={node.retryDelaySeconds} onChange={(event) => onUpdate({ retryDelaySeconds: Math.max(0, Number(event.target.value)) })} /></label>
      <label>Timeout (sec)<input type="number" min="1" value={node.timeoutSeconds ?? ''} onChange={(event) => onUpdate({ timeoutSeconds: Number(event.target.value) || undefined })} /></label>
    </div>
    <label className="toggle-row"><div><strong>Continue on failure</strong><span>Allow eligible downstream edges to continue.</span></div><input type="checkbox" checked={node.continueOnFailure} onChange={(event) => onUpdate({ continueOnFailure: event.target.checked })} /></label>
    <label className="toggle-row"><div><strong>Manual approval</strong><span>{node.type === 'approval' ? 'Required for dedicated approval nodes.' : 'Pause this node for an operator decision.'}</span></div><input type="checkbox" checked={node.approvalRequired} disabled={node.type === 'approval'} onChange={(event) => onUpdate({ approvalRequired: event.target.checked })} /></label>
    <button className="danger-button full" onClick={onRemove}><Trash2 size={14} />Remove node</button>
  </aside>;
}

function NodeConfigFields({ node, devices, transfers, channels, updateConfig, onUpdate }: {
  node: PipelineNodeDefinition;
  devices: Device[];
  transfers: Array<{ id: string; source: { path: string }; destination: { path: string }; status: string }>;
  channels: NotificationChannel[];
  updateConfig(key: string, value: unknown): void;
  onUpdate(patch: Partial<PipelineNodeDefinition>): void;
}) {
  const configString = (key: string, fallback = '') => typeof node.config[key] === 'string' ? String(node.config[key]) : fallback;
  if (node.type === 'codex') return <>
    <label>Instructions<textarea rows={6} value={configString('prompt')} onChange={(event) => updateConfig('prompt', event.target.value)} placeholder="Describe the outcome Codex should achieve…" /></label>
    <div className="form-grid">
      <label>Permission<select value={configString('permissionMode', 'workspace-write')} onChange={(event) => updateConfig('permissionMode', event.target.value as PermissionMode)}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></label>
      <label>Command approval<select value={configString('approvalPolicy', 'on-request')} onChange={(event) => updateConfig('approvalPolicy', event.target.value as ApprovalPolicy)}><option value="untrusted">Untrusted only</option><option value="on-request">On request</option><option value="never">Never</option></select></label>
    </div>
  </>;

  if (shellLikeTypes.has(node.type)) return <label>{node.type === 'python' ? 'Python command or script invocation' : `${titleCase(node.type)} command`}<textarea rows={5} value={configString('command')} onChange={(event) => updateConfig('command', event.target.value)} placeholder={node.type === 'python' ? 'python scripts/evaluate.py' : commandPlaceholder(node.type)} /></label>;

  if (node.type === 'http' || node.type === 'webhook') return <>
    <label>URL<input type="url" value={configString('url')} onChange={(event) => updateConfig('url', event.target.value)} placeholder="https://api.example.com/hook" /></label>
    <label>Method<select value={configString('method', node.type === 'webhook' ? 'POST' : 'GET')} onChange={(event) => onUpdate({ config: { ...node.config, method: event.target.value, ...(event.target.value === 'GET' ? { body: undefined } : {}) } })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => <option key={method}>{method}</option>)}</select></label>
    {configString('method', node.type === 'webhook' ? 'POST' : 'GET') !== 'GET' && <label>Request body<textarea rows={5} value={configString('body')} onChange={(event) => updateConfig('body', event.target.value)} placeholder={'{"event":"pipeline.completed"}'} /></label>}
  </>;

  if (node.type === 'transfer') return <label>Transfer<select value={configString('transferId')} onChange={(event) => updateConfig('transferId', event.target.value)}><option value="">Select a registered transfer</option>{transfers.map((transfer) => <option key={transfer.id} value={transfer.id}>{transfer.source.path} → {transfer.destination.path} ({transfer.status})</option>)}</select>{!transfers.length && <small>Create an artifact transfer before adding this step.</small>}</label>;

  if (node.type === 'wait') return <label>Duration (seconds)<input type="number" min="0" step="0.1" value={numberConfig(node.config.seconds, numberConfig(node.config.milliseconds, 60_000) / 1_000)} onChange={(event) => onUpdate({ config: { ...node.config, seconds: Math.max(0, Number(event.target.value)), milliseconds: undefined } })} /></label>;

  if (node.type === 'notification') {
    const selectedChannels = Array.isArray(node.config.channelIds) ? node.config.channelIds.filter((value): value is string => typeof value === 'string') : [];
    return <>
      <label>Title<input value={configString('title')} onChange={(event) => updateConfig('title', event.target.value)} placeholder="Pipeline requires attention" /></label>
      <label>Message<textarea rows={4} value={configString('body')} onChange={(event) => updateConfig('body', event.target.value)} /></label>
      <label>Severity<select value={configString('severity', 'info')} onChange={(event) => updateConfig('severity', event.target.value)}><option>info</option><option>success</option><option>warning</option><option>critical</option></select></label>
      <fieldset className="pipeline-targets"><legend>Notification channels</legend>{channels.length ? <div className="pipeline-check-list">{channels.map((channel) => <label key={channel.id}><input type="checkbox" checked={selectedChannels.includes(channel.id)} onChange={(event) => updateConfig('channelIds', event.target.checked ? [...new Set([...selectedChannels, channel.id])] : selectedChannels.filter((id) => id !== channel.id))} /><span><strong>{channel.name}</strong><small>{titleCase(channel.kind)}</small></span></label>)}</div> : <p>No channels configured; Orchestra inbox delivery will be used.</p>}</fieldset>
    </>;
  }

  if (node.type === 'wake' || node.type === 'shutdown') {
    const targetId = configString('deviceId', node.preferredDeviceIds[0] ?? '');
    return <label>Target device<select value={targetId} onChange={(event) => { updateConfig('deviceId', event.target.value); onUpdate({ preferredDeviceIds: event.target.value ? [event.target.value] : [] }); }}><option value="">Select a device</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {titleCase(device.status)}</option>)}</select></label>;
  }

  if (node.type === 'approval' || node.type === 'human-input') return <div className="pipeline-config-note"><ShieldCheck size={15} /><p>This step pauses the run until an operator approves or rejects it from the live run controls.</p></div>;
  return <div className="pipeline-config-note"><Box size={15} /><p>This node uses its structured configuration as provided by its plugin or runtime adapter.</p></div>;
}

function EdgeEditor({ edge, pipeline, issue, onUpdate, onRemove, onClose }: {
  edge: PipelineEdgeDefinition;
  pipeline: PipelineDefinition;
  issue?: string;
  onUpdate(patch: Partial<PipelineEdgeDefinition>): void;
  onRemove(): void;
  onClose(): void;
}) {
  const source = pipeline.nodes.find((node) => node.id === edge.source)?.name ?? edge.source;
  const target = pipeline.nodes.find((node) => node.id === edge.target)?.name ?? edge.target;
  return <aside className="node-editor edge-editor">
    <header><div><span className="eyebrow">Connection</span><h3>{source} → {target}</h3></div><button className="icon-button" onClick={onClose} aria-label="Close connection settings"><X size={16} /></button></header>
    {issue && <div className="pipeline-editor-warning"><AlertTriangle size={14} /><span>{issue}</span></div>}
    <div className="edge-route"><span>{source}</span><Link2 size={14} /><span>{target}</span></div>
    <label>Run target when<select value={edge.condition} onChange={(event) => onUpdate({ condition: event.target.value as PipelineEdgeDefinition['condition'], expression: event.target.value === 'expression' ? edge.expression ?? '' : undefined })}><option value="success">Source succeeds</option><option value="failure">Source fails</option><option value="always">Source finishes</option><option value="expression">Expression matches</option></select></label>
    <label>Label<input value={edge.label ?? ''} onChange={(event) => onUpdate({ label: event.target.value || undefined })} placeholder={titleCase(edge.condition)} /></label>
    {edge.condition === 'expression' && <label>Expression<textarea rows={5} value={edge.expression ?? ''} onChange={(event) => onUpdate({ expression: event.target.value })} placeholder="output.approved == true" /><small>Use state, parameters.key, or output.key with ==, !=, &gt;, &gt;=, &lt;, or &lt;=.</small></label>}
    <button className="danger-button full" onClick={onRemove}><Trash2 size={14} />Remove connection</button>
  </aside>;
}

function PipelineNode({ data, selected }: NodeProps<PipelineCanvasNode>) {
  const item = palette.find((entry) => entry.type === data.definition.type);
  const Icon = item?.icon ?? Box;
  return <div className={`pipeline-node pipeline-node--${data.runState ?? 'idle'} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <span className="pipeline-node__icon"><Icon size={16} /></span>
    <div><strong>{data.definition.name}</strong><small>{titleCase(data.definition.type)}</small></div>
    {data.runState && <i title={data.runState} />}
    <Handle type="source" position={Position.Right} />
  </div>;
}

function RunPanel({ pipeline, run }: { pipeline: PipelineDefinition; run: PipelineRun }) {
  const pending = run.nodeRuns.filter((node) => node.state === 'awaiting-approval');
  return <section className="pipeline-run-panel">
    {pending.length > 0 && <div className="pipeline-approval-list">{pending.map((node) => <ApprovalCard key={node.id} pipeline={pipeline} run={run} nodeRun={node} />)}</div>}
    <footer className="run-strip">
      <div><StatePill value={run.state} /><span>Started {relativeTime(run.startedAt ?? run.createdAt)}</span><span>{run.nodeRuns.filter((node) => node.state === 'succeeded').length}/{run.nodeRuns.length} nodes complete</span></div>
      <div className="run-track">{run.nodeRuns.map((node) => <i key={node.id} className={`run-track--${node.state}`} title={`${pipeline.nodes.find((item) => item.id === node.nodeId)?.name ?? node.nodeId}: ${node.state}`} />)}</div>
      {run.estimatedCompletionAt && <small>ETA {new Date(run.estimatedCompletionAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
    </footer>
  </section>;
}

function ApprovalCard({ pipeline, run, nodeRun }: { pipeline: PipelineDefinition; run: PipelineRun; nodeRun: PipelineNodeRun }) {
  const { request } = useFleet();
  const [deciding, setDeciding] = useState(false);
  const definition = pipeline.nodes.find((node) => node.id === nodeRun.nodeId);
  async function decide(approved: boolean) {
    setDeciding(true);
    try {
      if (approved) await request(() => apiV2.approvePipelineNode(run.id, nodeRun.id));
      else await request(() => apiV2.rejectPipelineNode(run.id, nodeRun.id));
    } finally { setDeciding(false); }
  }
  return <article className="pipeline-approval-card">
    <span><ShieldCheck size={17} /></span>
    <div><strong>{definition?.name ?? nodeRun.nodeId}</strong><p>{definition?.description || 'This workflow is waiting for an operator decision.'}</p><small>Attempt {nodeRun.attempt} · run {run.id.slice(0, 8)}</small></div>
    <div><button className="secondary-button compact" disabled={deciding} onClick={() => void decide(false).catch(() => undefined)}><XCircle size={14} />Reject</button><button className="primary-button compact" disabled={deciding} onClick={() => void decide(true).catch(() => undefined)}><Check size={14} />Approve</button></div>
  </article>;
}

function NewPipelineDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const { request } = useFleet();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const pipeline = await request(() => apiV2.createPipeline({ name, description, status: 'draft', nodes: [], edges: [], triggers: [], parameters: {}, concurrencyLimit: 1, tags: [] }));
    onCreated(pipeline.id);
    onClose();
  }
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}>
    <header><div><span className="eyebrow">Workflow fabric</span><h2>New pipeline</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></header>
    <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Train and evaluate vision model" /></label>
    <label>Description<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"><Plus size={14} />Create pipeline</button></footer>
  </form></div>;
}

function defaultConfig(type: PipelineNodeType): Record<string, unknown> {
  if (type === 'codex') return { prompt: '', permissionMode: 'workspace-write', approvalPolicy: 'on-request' };
  if (shellLikeTypes.has(type)) return { command: '' };
  if (type === 'http') return { url: '', method: 'GET' };
  if (type === 'webhook') return { url: '', method: 'POST', body: '' };
  if (type === 'transfer') return { transferId: '' };
  if (type === 'wait') return { seconds: 60 };
  if (type === 'notification') return { title: '', body: '', severity: 'info', channelIds: [] };
  if (type === 'wake' || type === 'shutdown') return { deviceId: '' };
  return {};
}

function validatePipelineDraft(pipeline: PipelineDefinition): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  if (!pipeline.nodes.length) issues.push({ message: 'Add at least one executable node.' });
  for (const node of pipeline.nodes) {
    const message = nodeConfigIssue(node);
    if (message) issues.push({ nodeId: node.id, message: `${node.name}: ${message}` });
  }
  const ids = new Set(pipeline.nodes.map((node) => node.id));
  for (const edge of pipeline.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) issues.push({ edgeId: edge.id, message: 'Connection references a missing node.' });
    if (edge.source === edge.target) issues.push({ edgeId: edge.id, message: 'A node cannot connect to itself.' });
    if (edge.condition === 'expression' && !edge.expression?.trim()) issues.push({ edgeId: edge.id, message: 'Expression connections require an expression.' });
  }
  if (hasCycle(pipeline.nodes, pipeline.edges)) issues.push({ message: 'Pipeline connections contain a cycle.' });
  return issues;
}

function nodeConfigIssue(node: PipelineNodeDefinition): string | undefined {
  const value = (key: string) => typeof node.config[key] === 'string' ? String(node.config[key]).trim() : '';
  if (node.type === 'codex' && !value('prompt')) return 'Codex instructions are required.';
  if (shellLikeTypes.has(node.type) && !(value('command') || value('script'))) return 'An executable command is required.';
  if (node.type === 'http' || node.type === 'webhook') {
    if (!value('url')) return 'A URL is required.';
    try { const url = new URL(value('url')); if (!['http:', 'https:'].includes(url.protocol)) return 'URL must use HTTP or HTTPS.'; } catch { return 'Enter a valid absolute URL.'; }
  }
  if (node.type === 'transfer' && !value('transferId')) return 'Select a registered transfer.';
  if (node.type === 'wait') { const duration = node.config.seconds ?? (Number(node.config.milliseconds) / 1_000); if (!Number.isFinite(Number(duration)) || Number(duration) < 0) return 'Duration must be zero or greater.'; }
  if (node.type === 'notification' && !value('title')) return 'A notification title is required.';
  if ((node.type === 'wake' || node.type === 'shutdown') && !(value('deviceId') || node.preferredDeviceIds.length)) return 'Select a target device.';
  return undefined;
}

function hasCycle(nodes: PipelineNodeDefinition[], edges: PipelineEdgeDefinition[]): boolean {
  const graph = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) graph.get(edge.source)?.push(edge.target);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function commandPlaceholder(type: PipelineNodeType): string {
  if (type === 'git') return 'git status --short';
  if (type === 'test') return 'npm test';
  if (type === 'build') return 'npm run build';
  if (type === 'training') return 'python train.py --config configs/train.yaml';
  if (type === 'evaluation') return 'python evaluate.py --checkpoint latest';
  if (type === 'deployment') return './scripts/deploy.sh staging';
  return 'Enter a command to run on the selected device';
}

function splitList(value: string): string[] { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function numberConfig(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function stateColor(state?: string) { return state === 'succeeded' ? '#34d399' : state === 'running' ? '#38bdf8' : state === 'failed' ? '#fb7185' : state === 'awaiting-approval' ? '#fbbf24' : '#506072'; }
