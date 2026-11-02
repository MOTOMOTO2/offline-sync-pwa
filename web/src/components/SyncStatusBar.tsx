import { useNavigate } from 'react-router-dom';

import { useSyncState, useTicker } from '../hooks/useAppData';
import { describeSync } from '../lib/status';
import { syncNow } from '../lib/sync';

/**
 * The permanent answer to "can I trust what I am looking at".
 *
 * It is always on screen, it never says "up to date" unless a live pull
 * actually succeeded, and tapping it does the obvious next thing.
 */
export function SyncStatusBar() {
  const state = useSyncState();
  const now = useTicker(15_000);
  const navigate = useNavigate();
  const description = describeSync(state, now);

  return (
    <header className="sync-bar" data-tone={description.tone}>
      <button
        type="button"
        className="sync-bar__button"
        onClick={() => {
          if (description.action === 'outbox') navigate('/outbox');
          else void syncNow({ manual: true });
        }}
        aria-live="polite"
      >
        <span className="sync-bar__dot" data-spin={state.phase === 'syncing'} />
        <span className="sync-bar__text">
          <strong>{description.title}</strong>
          <span className="sync-bar__detail">{description.detail}</span>
        </span>
        <span className="sync-bar__hint">{description.action === 'outbox' ? 'Outbox' : 'Sync'}</span>
      </button>
    </header>
  );
}
