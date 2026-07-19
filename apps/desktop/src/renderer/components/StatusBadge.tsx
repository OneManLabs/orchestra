import { titleCase } from '../lib/format';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{titleCase(status)}</span>;
}
