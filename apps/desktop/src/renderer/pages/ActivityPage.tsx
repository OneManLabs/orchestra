import { Activity, AlertCircle, CheckCircle2, Info, Search, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { relativeTime, titleCase } from '../lib/format';
import { useFleet } from '../state/FleetContext';
import { PageHeader } from './JobsPage';

const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle };

export function ActivityPage() {
  const { snapshot } = useFleet(); const [query, setQuery] = useState(''); const [severity, setSeverity] = useState('all');
  const events = (snapshot?.activity ?? []).filter((event) => (severity === 'all' || event.severity === severity) && `${event.title} ${event.detail}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="page"><PageHeader eyebrow="Audit & observability" title="Activity" detail="A live, durable record of device, job, session, and security events" /><div className="filter-bar"><label className="search"><Search size={15} /><input placeholder="Search activity" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="segmented compact">{['all', 'info', 'success', 'warning', 'error'].map((item) => <button key={item} className={severity === item ? 'active' : ''} onClick={() => setSeverity(item)}>{titleCase(item)}</button>)}</div></div>{events.length ? <div className="timeline">{events.map((event) => { const Icon = icons[event.severity]; return <article key={event.id} className={`timeline-event timeline-event--${event.severity}`}><div className="timeline-event__icon"><Icon size={16} /></div><div><header><strong>{event.title}</strong><span>{titleCase(event.type)}</span><time>{relativeTime(event.at)}</time></header><p>{event.detail}</p>{event.entityId && <code>{event.entityId}</code>}</div></article>; })}</div> : <EmptyState icon={severity === 'error' ? ShieldAlert : Activity} title="No activity matches" description={snapshot?.activity.length ? 'Adjust the search or severity filter.' : 'Orchestra activity will appear as agents connect and work is dispatched.'} />}</div>;
}
