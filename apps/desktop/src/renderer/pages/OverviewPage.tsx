import { Activity, AlertTriangle, Bot, Boxes, ChevronRight, Cpu, Database, ExternalLink, FolderGit2, Gauge, Globe2, Network, Play, Radio, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState } from '../components/EmptyState';
import { KpiCard, SectionCard, Sparkline, StatePill } from '../components/V2Ui';
import { formatBytes, relativeTime } from '../lib/format';
import { useFleet } from '../state/FleetContext';
import { PageHeader } from './JobsPage';

export function OverviewPage({ navigate, selectDevice, openPreview, openCodex }: {
  navigate(page: string): void;
  selectDevice(id: string): void;
  openPreview(projectId: string): void;
  openCodex(deviceId: string, sessionId: string): void;
}) {
  const { snapshot } = useFleet(); const devices = snapshot?.devices ?? []; const v2 = snapshot?.v2;
  const online = devices.filter((device) => device.status !== 'offline'); const openAlerts = v2?.alerts.filter((alert) => alert.status === 'open') ?? []; const running = (v2?.pipelineRuns ?? []).filter((run) => ['running', 'awaiting-approval'].includes(run.state));
  const approvals = (snapshot?.sessions ?? []).flatMap((session) => session.pendingApprovals.map((approval) => ({ session, approval })));
  const totalMemory = devices.reduce((sum, device) => sum + device.metrics.memory.totalBytes, 0); const currentPower = (v2?.metricHistory ?? []).filter((point) => Date.now() - new Date(point.sampledAt).getTime() < 60_000).reduce((sum, point) => sum + (point.powerWatts ?? 0), 0);
  const history = useMemo(() => (v2?.metricHistory ?? []).slice(-40), [v2?.metricHistory]);
  const sharedProjects = (snapshot?.projects ?? []).filter((project) =>
    project.preview?.status === 'running'
    || (snapshot?.sessions ?? []).some((session) => session.projectId === project.id)
  );

  return <div className="page v2-page overview-page"><PageHeader eyebrow="Mission control" title="Orchestra overview" detail="Live operational posture across compute, work, data, and security" action={<button className="primary-button" onClick={() => navigate('pipelines')}><Play size={15} />Run pipeline</button>} />
    <div className="mission-strip"><div><span className={`connection-pulse ${online.length ? 'online' : ''}`} /><strong>{online.length === devices.length && devices.length ? 'Orchestra nominal' : devices.length ? 'Attention required' : 'Awaiting enrollment'}</strong><small>{online.length} of {devices.length} devices online</small></div><span>Protocol v{v2?.protocolVersion ?? '—'}</span><span>Schema v{v2?.schemaVersion ?? '—'}</span><time>{new Date(snapshot?.now ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
    {sharedProjects.length > 0 && <section className="overview-shared-workspaces">
      <header><div><Globe2 size={15} /><span><strong>Shared workspaces</strong><small>Open websites and Codex conversations from this Mac</small></span></div><button className="text-button" onClick={() => navigate('projects')}>All projects <ChevronRight size={13} /></button></header>
      <div>{sharedProjects.map((project) => {
        const preview = project.preview;
        const session = (snapshot?.sessions ?? [])
          .filter((candidate) => candidate.projectId === project.id)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        const host = devices.find((device) => device.id === preview?.deviceId);
        return <article key={project.id}>
          <span className="overview-workspace-icon"><FolderGit2 size={16} /></span>
          <div><strong>{project.name}</strong><small>{preview?.status === 'running' ? `Website on ${host?.name ?? preview.deviceId}` : 'Shared Codex workspace'}</small></div>
          {preview?.status === 'running' && preview.url && <button className="primary-button compact" onClick={() => openPreview(project.id)}><ExternalLink size={13} />Open Website</button>}
          {session && <button className="secondary-button compact" onClick={() => openCodex(session.deviceId, session.id)}><Bot size={13} />Open Codex</button>}
        </article>;
      })}</div>
    </section>}
    <div className="kpi-grid"><KpiCard icon={Radio} label="Online capacity" value={`${online.length}/${devices.length}`} detail={`${devices.filter((d) => d.status === 'busy').length} nodes executing`} tone="green" /><KpiCard icon={Cpu} label="Memory fabric" value={formatBytes(totalMemory)} detail={`${devices.reduce((sum, d) => sum + d.metrics.cpu.cores, 0)} CPU cores visible`} /><KpiCard icon={Boxes} label="Active workflows" value={running.length + (snapshot?.jobs.filter((job) => job.status === 'running').length ?? 0)} detail={`${v2?.pipelineRuns.filter((run) => run.state === 'pending' || run.state === 'queued').length ?? 0} queued`} tone="purple" /><KpiCard icon={AlertTriangle} label="Open alerts" value={openAlerts.length} detail={`${openAlerts.filter((alert) => alert.severity === 'critical').length} critical`} tone={openAlerts.some((a) => a.severity === 'critical') ? 'red' : 'yellow'} /><KpiCard icon={Zap} label="Estimated draw" value={currentPower ? `${currentPower.toFixed(0)} W` : '—'} detail={currentPower ? 'Latest reported samples' : 'Power telemetry unavailable'} tone="yellow" /></div>
    <div className="overview-grid">
      <SectionCard title="Digital twin" detail="Live device posture and operational links" action={<button className="text-button" onClick={() => navigate('canvas')}>Open canvas <ChevronRight size={13} /></button>} className="twin-card">{devices.length ? <div className="twin-map">{devices.map((device, index) => <button key={device.id} className={`twin-node twin-node--${device.status}`} style={{ '--i': index } as React.CSSProperties} onClick={() => selectDevice(device.id)}><span><DeviceRoleIcon role={device.role} /></span><strong>{device.name}</strong><small>{device.role} · {Math.round(device.metrics.cpu.usagePercent)}%</small></button>)}<div className="twin-core-line" /></div> : <EmptyState icon={Network} title="No topology yet" description="Enroll an Agent to create the first live node in your digital twin." />}</SectionCard>
      <SectionCard title="Resource pulse" detail="Aggregate from real device samples"><div className="pulse-charts"><div><header><span>CPU history</span><strong>{history.at(-1)?.cpuPercent.toFixed(0) ?? '—'}%</strong></header><Sparkline values={history.map((point) => point.cpuPercent)} /></div><div><header><span>Memory history</span><strong>{history.at(-1)?.memoryPercent.toFixed(0) ?? '—'}%</strong></header><Sparkline color="#a78bfa" values={history.map((point) => point.memoryPercent)} /></div><div><header><span>Network receive</span><strong>{history.at(-1) ? formatBytes(history.at(-1)!.rxBytesPerSecond) + '/s' : '—'}</strong></header><Sparkline color="#34d399" values={history.map((point) => point.rxBytesPerSecond)} /></div></div></SectionCard>
      <SectionCard title="Needs attention" detail="Approvals and active alerts" action={(openAlerts.length + approvals.length) > 0 && <span className="attention-count">{openAlerts.length + approvals.length}</span>}><div className="attention-list">{approvals.slice(0, 4).map(({ session, approval }) => <button key={approval.id} onClick={() => selectDevice(session.deviceId)}><span className="attention-icon approval"><Bot size={15} /></span><div><strong>{approval.title}</strong><p>{snapshot?.devices.find((d) => d.id === session.deviceId)?.name} · Codex approval</p></div><ChevronRight size={14} /></button>)}{openAlerts.slice(0, 5).map((alert) => <button key={alert.id} onClick={() => navigate('telemetry')}><span className={`attention-icon ${alert.severity}`}><AlertTriangle size={15} /></span><div><strong>{alert.title}</strong><p>{alert.detail}</p></div><StatePill value={alert.severity} /></button>)}{!approvals.length && !openAlerts.length && <div className="inline-empty"><ShieldCheck size={21} /><strong>Nothing needs attention</strong><span>There are no pending approvals or open alerts.</span></div>}</div></SectionCard>
      <SectionCard title="Recent operations" detail="Work and movement across the fleet" action={<button className="text-button" onClick={() => navigate('activity')}>Full audit <ChevronRight size={13} /></button>}><div className="ops-feed">{(snapshot?.activity ?? []).slice(0, 6).map((event) => <article key={event.id}><i className={`activity-icon activity-icon--${event.severity}`} /><div><strong>{event.title}</strong><p>{event.detail}</p></div><time>{relativeTime(event.at)}</time></article>)}{!snapshot?.activity.length && <div className="inline-empty"><Activity size={21} /><strong>No operations yet</strong><span>Orchestra activity will stream here.</span></div>}</div></SectionCard>
    </div>
  </div>;
}

function DeviceRoleIcon({ role }: { role: string }) { const Icon = role === 'storage' ? Database : role === 'gpu' ? Gauge : role === 'core' ? Sparkles : Cpu; return <Icon size={16} />; }
