import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { titleCase } from '../lib/format';

export function V2Tabs<T extends string>({ value, onChange, items }: { value: T; onChange(value: T): void; items: Array<{ id: T; label: string; count?: number }> }) {
  return <nav className="v2-tabs" aria-label="Page sections">{items.map((item) => <button key={item.id} className={value === item.id ? 'active' : ''} onClick={() => onChange(item.id)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</nav>;
}

export function KpiCard({ icon: Icon, label, value, detail, tone = 'blue', children }: { icon: LucideIcon; label: string; value: string | number; detail: string; tone?: 'blue' | 'green' | 'yellow' | 'red' | 'purple'; children?: ReactNode }) {
  return <article className={`kpi-card kpi-card--${tone}`}><header><span><Icon size={16} /></span><small>{label}</small></header><strong>{value}</strong><p>{detail}</p>{children}</article>;
}

export function SectionCard({ title, detail, action, children, className = '' }: { title: string; detail?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`v2-card ${className}`}><header className="v2-card__header"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</header>{children}</section>;
}

export function Sparkline({ values, color = '#38bdf8', height = 54 }: { values: number[]; color?: string; height?: number }) {
  if (!values.length) return <div className="sparkline-empty">No samples</div>;
  const width = 220; const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(1, max - min);
  const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * width},${height - 4 - ((value - min) / spread) * (height - 10)}`).join(' ');
  return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label={`Trend from ${values[0]?.toFixed(0)} to ${values.at(-1)?.toFixed(0)}`}><defs><linearGradient id={`fill-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".3" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs><polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#fill-${color.replace('#', '')})`} /><polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

export function StatePill({ value }: { value: string }) { return <span className={`v2-state v2-state--${value}`}>{titleCase(value)}</span>; }

export function ConfirmDialog({ title, detail, confirmLabel, danger = false, onCancel, onConfirm }: { title: string; detail: string; confirmLabel: string; danger?: boolean; onCancel(): void; onConfirm(): void }) {
  useEscape(onCancel);
  return <div className="modal-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><button className="icon-button confirm-close" onClick={onCancel} aria-label="Close"><X size={17} /></button><div className={`confirm-icon ${danger ? 'danger' : ''}`}><AlertTriangle size={21} /></div><h2 id="confirm-title">{title}</h2><p>{detail}</p><footer><button className="secondary-button" onClick={onCancel}>Cancel</button><button className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</button></footer></section></div>;
}

export function useEscape(onEscape: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [active, onEscape]);
}

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return <div className="v2-table" style={{ '--columns': headers.length } as React.CSSProperties}><div className="v2-table__head">{headers.map((header) => <span key={header}>{header}</span>)}</div>{children}</div>;
}
