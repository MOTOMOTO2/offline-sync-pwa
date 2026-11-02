/** Short, glanceable formatting. Everything here is pure, so it is easy to test. */

import type { SiteStatus } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function toEpoch(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** "just now", "6 min ago", "3 h ago", "2 days ago". */
export function relativeTime(
  value: string | number | null | undefined,
  now: number = Date.now(),
): string {
  const epoch = toEpoch(value);
  if (epoch === null) return 'never';

  const delta = now - epoch;
  if (delta < 0) return 'just now';
  if (delta < 45_000) return 'just now';
  if (delta < HOUR) return `${Math.round(delta / MINUTE)} min ago`;
  if (delta < DAY) {
    const hours = Math.round(delta / HOUR);
    return `${hours} h ago`;
  }
  const days = Math.round(delta / DAY);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** "in 12 s", "in 4 min": how long until a scheduled retry. */
export function untilTime(target: number, now: number = Date.now()): string {
  const delta = target - now;
  if (delta <= 0) return 'any moment now';
  if (delta < MINUTE) return `in ${Math.max(1, Math.round(delta / 1000))} s`;
  if (delta < HOUR) return `in ${Math.round(delta / MINUTE)} min`;
  return `in ${Math.round(delta / HOUR)} h`;
}

/** Local wall-clock time, e.g. "14:32". */
export function clockTime(value: string | number | null | undefined): string {
  const epoch = toEpoch(value);
  if (epoch === null) return '--:--';
  return new Date(epoch).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local date and time, e.g. "1 Nov, 14:32". */
export function stamp(value: string | number | null | undefined): string {
  const epoch = toEpoch(value);
  if (epoch === null) return 'unknown';
  return new Date(epoch).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_LABELS: Record<SiteStatus, string> = {
  ok: 'OK',
  needs_work: 'Needs work',
  blocked: 'Blocked',
  unvisited: 'Not visited',
};

export function statusLabel(status: SiteStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function priorityLabel(priority: number): string {
  return `P${priority}`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
