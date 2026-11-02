import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { InstallPrompt } from '../components/InstallPrompt';
import { ChevronRight, CloudOffIcon } from '../components/Icons';
import { StatusPill } from '../components/StatusPill';
import { useOutbox, useSiteList, useSyncState, useTicker } from '../hooks/useAppData';
import { pluralise, priorityLabel, relativeTime, stamp } from '../lib/format';
import { syncNow } from '../lib/sync';
import type { SiteStatus } from '../lib/types';

type Filter = 'all' | SiteStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_work', label: 'Needs work' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'unvisited', label: 'Not visited' },
  { key: 'ok', label: 'OK' },
];

export function ListView() {
  const { list, loading } = useSiteList();
  const { entries } = useOutbox();
  const state = useSyncState();
  const now = useTicker();
  const [filter, setFilter] = useState<Filter>('all');

  const queuedBySite = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.siteId, (counts.get(entry.siteId) ?? 0) + 1);
    return counts;
  }, [entries]);

  const items = list?.items ?? [];
  const visible = filter === 'all' ? items : items.filter((item) => item.status === filter);

  return (
    <div className="screen">
      <div className="screen__head">
        <h1>Sites</h1>
        <p className="muted">
          {list
            ? `${pluralise(items.length, 'site')} · saved ${relativeTime(list.cachedAt, now)}`
            : 'No sites saved on this device yet'}
        </p>
      </div>

      <InstallPrompt />

      {loading && !list && <ListSkeleton />}

      {!loading && !list && (
        <EmptyState
          icon={<CloudOffIcon size={32} />}
          title="Nothing saved yet"
          body={
            state.online
              ? 'Fetching the site list now.'
              : 'This phone has not downloaded the site list. Connect once and it will be available offline from then on.'
          }
          action={{ label: 'Try now', onClick: () => void syncNow({ manual: true }) }}
        />
      )}

      {list && visible.length === 0 && (
        <EmptyState title="Nothing in this filter" body="Pick another filter below." />
      )}

      <ul className="cards">
        {visible.map((site) => {
          const queued = queuedBySite.get(site.id) ?? 0;
          return (
            <li key={site.id}>
              <Link className="card" to={`/sites/${site.id}`}>
                <div className="card__main">
                  <div className="card__top">
                    <span className="priority" data-level={site.priority}>
                      {priorityLabel(site.priority)}
                    </span>
                    <StatusPill status={site.status} size="sm" />
                    {queued > 0 && (
                      <span className="pill" data-tone="pending" data-size="sm">
                        {queued} queued
                      </span>
                    )}
                  </div>
                  <h2 className="card__title">{site.name}</h2>
                  <p className="card__meta">{site.address}</p>
                  <p className="card__meta muted">
                    {site.asset_tag} ·{' '}
                    {site.last_report_at
                      ? `last report ${relativeTime(site.last_report_at, now)}`
                      : 'never reported'}
                  </p>
                </div>
                <ChevronRight className="card__chevron" />
              </Link>
            </li>
          );
        })}
      </ul>

      {list && (
        <p className="screen__foot muted">
          Saved copy from {stamp(list.cachedAt)}. Reading works offline; new reports queue.
        </p>
      )}

      <div className="filterbar" role="group" aria-label="Filter sites by status">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            className="chip"
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
          >
            {option.label}
            {option.key !== 'all' && (
              <span className="chip__count">
                {items.filter((item) => item.status === option.key).length}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul className="cards" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <li key={index}>
          <div className="card card--skeleton">
            <div className="skeleton skeleton--sm" />
            <div className="skeleton skeleton--lg" />
            <div className="skeleton skeleton--md" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      {action && (
        <button type="button" className="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
