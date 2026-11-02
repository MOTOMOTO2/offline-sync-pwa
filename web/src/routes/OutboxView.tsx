import { Link } from 'react-router-dom';

import { AlertIcon, CheckIcon, ClockIcon, SyncIcon, TrashIcon } from '../components/Icons';
import { useOutbox, useSyncState, useTicker } from '../hooks/useAppData';
import { pluralise, relativeTime, stamp, statusLabel, untilTime } from '../lib/format';
import { discardQueued, retryFailed, syncNow } from '../lib/sync';
import { EmptyState } from './ListView';

/**
 * The outbox is deliberately a first-class screen rather than a spinner
 * somewhere: if a report has not reached the server, the tech should be able
 * to see exactly which one, why, and what to do about it.
 */
export function OutboxView() {
  const { entries, loading } = useOutbox();
  const state = useSyncState();
  const now = useTicker(10_000);

  const failed = entries.filter((entry) => entry.state === 'failed');

  return (
    <div className="screen">
      <div className="screen__head">
        <h1>Outbox</h1>
        <p className="muted">
          {entries.length === 0
            ? 'Everything you have filed has reached the server'
            : `${pluralise(entries.length, 'report')} on this phone`}
        </p>
      </div>

      {!loading && entries.length === 0 && (
        <EmptyState
          icon={<CheckIcon size={32} />}
          title="Nothing waiting"
          body={
            state.lastSyncedAt
              ? `Last synced ${relativeTime(state.lastSyncedAt, now)}, at ${stamp(state.lastSyncedAt)}.`
              : 'Nothing has been synced from this phone yet.'
          }
        />
      )}

      <ul className="cards">
        {entries.map((entry) => (
          <li key={entry.id}>
            <article className="card card--queued" data-state={entry.state}>
              <div className="card__main">
                <div className="card__top">
                  <span className="pill" data-tone={entry.state === 'failed' ? 'bad' : 'pending'} data-size="sm">
                    {entry.state === 'failed' ? 'Rejected' : 'Queued'}
                  </span>
                  <span className="muted">{statusLabel(entry.status)}</span>
                </div>
                <h2 className="card__title">
                  <Link to={`/sites/${entry.siteId}`}>{entry.siteName}</Link>
                </h2>
                {entry.note && <p className="card__meta">{entry.note}</p>}
                <p className="card__meta muted">
                  <ClockIcon size={14} /> written {relativeTime(entry.recordedAt, now)}
                  {entry.attempts > 0 && ` · ${pluralise(entry.attempts, 'try', 'tries')}`}
                </p>
                {entry.state === 'failed' && entry.lastError && (
                  <p className="card__error">
                    <AlertIcon size={14} /> {entry.lastError}
                  </p>
                )}
                {entry.state === 'pending' && entry.nextAttemptAt > now && (
                  <p className="card__meta muted">next try {untilTime(entry.nextAttemptAt, now)}</p>
                )}
              </div>
              <div className="card__actions">
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void retryFailed()}
                  disabled={state.phase === 'syncing'}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void discardQueued(entry.id)}
                  aria-label={`Discard report for ${entry.siteName}`}
                >
                  <TrashIcon size={20} />
                </button>
              </div>
            </article>
          </li>
        ))}
      </ul>

      {failed.length > 0 && (
        <p className="screen__foot muted">
          A rejected report is not retried automatically. Fix the cause or discard it.
        </p>
      )}

      <div className="actionbar">
        <button
          type="button"
          className="button button--primary button--block"
          onClick={() => void syncNow({ manual: true })}
          disabled={state.phase === 'syncing'}
        >
          <SyncIcon size={20} />
          {state.phase === 'syncing' ? 'Syncing…' : state.online ? 'Sync now' : 'Try anyway'}
        </button>
      </div>
    </div>
  );
}
