import { statusLabel } from '../lib/format';
import type { SiteStatus } from '../lib/types';

const TONE: Record<SiteStatus, string> = {
  ok: 'ok',
  needs_work: 'warn',
  blocked: 'bad',
  unvisited: 'muted',
};

export function StatusPill({ status, size = 'md' }: { status: SiteStatus; size?: 'sm' | 'md' }) {
  return (
    <span className="pill" data-tone={TONE[status]} data-size={size}>
      {statusLabel(status)}
    </span>
  );
}
