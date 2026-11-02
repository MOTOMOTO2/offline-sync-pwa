import { NavLink, useLocation } from 'react-router-dom';

import { useSyncState } from '../hooks/useAppData';
import { InboxIcon, ListIcon, SyncIcon } from './Icons';
import { syncNow } from '../lib/sync';

/**
 * Everything you need to steer the app lives in the bottom third of the
 * screen, inside the home-indicator inset, with 56px targets. The sync control
 * is in the middle because it is the one thing you reach for in a hurry.
 */
export function BottomNav() {
  const state = useSyncState();
  const location = useLocation();
  const syncing = state.phase === 'syncing';
  const waiting = state.pending + state.failed;

  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink
        to="/"
        className={({ isActive }) =>
          'tabbar__item' + (isActive || location.pathname.startsWith('/sites/') ? ' is-active' : '')
        }
      >
        <ListIcon />
        <span>Sites</span>
      </NavLink>

      <button
        type="button"
        className="tabbar__sync"
        onClick={() => void syncNow({ manual: true })}
        disabled={syncing}
        aria-label={syncing ? 'Syncing' : 'Sync now'}
      >
        <span className="tabbar__sync-ring" data-tone={toneOf(state)} data-spin={syncing}>
          <SyncIcon size={26} />
        </span>
        <span>{syncing ? 'Syncing' : 'Sync'}</span>
      </button>

      <NavLink to="/outbox" className={({ isActive }) => 'tabbar__item' + (isActive ? ' is-active' : '')}>
        <span className="tabbar__badge-wrap">
          <InboxIcon />
          {waiting > 0 && (
            <span className="tabbar__badge" data-tone={state.failed > 0 ? 'bad' : 'warn'}>
              {waiting}
            </span>
          )}
        </span>
        <span>Outbox</span>
      </NavLink>
    </nav>
  );
}

function toneOf(state: ReturnType<typeof useSyncState>): string {
  if (state.phase === 'syncing') return 'busy';
  if (!state.online) return 'bad';
  if (state.failed > 0 || state.pending > 0) return 'warn';
  return 'ok';
}
