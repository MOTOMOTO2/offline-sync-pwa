/**
 * Turning sync state into words.
 *
 * Kept pure and separate from the components because "what does the app
 * currently claim about my data" is the thing most worth getting right, and
 * the thing most worth testing.
 */

import { pluralise, relativeTime } from './format';
import type { SyncSnapshot } from './sync';

export type SyncTone = 'ok' | 'busy' | 'warn' | 'bad';

export interface SyncDescription {
  tone: SyncTone;
  /** Short enough for the status bar. */
  title: string;
  /** The honest detail: when this data is from, or what is waiting. */
  detail: string;
  /** What tapping the status bar should do. */
  action: 'sync' | 'outbox';
}

export function describeSync(state: SyncSnapshot, now: number = Date.now()): SyncDescription {
  const since = state.lastSyncedAt ? `saved copy from ${relativeTime(state.lastSyncedAt, now)}` : 'no saved copy yet';
  const queued = pluralise(state.pending, 'report');

  if (state.phase === 'syncing') {
    return {
      tone: 'busy',
      title: 'Syncing',
      detail: state.pending > 0 ? `sending ${queued}` : 'checking for changes',
      action: 'sync',
    };
  }

  if (!state.online) {
    return {
      tone: 'bad',
      title: 'Offline',
      detail: state.pending > 0 ? `${queued} queued · ${since}` : since,
      action: state.pending > 0 ? 'outbox' : 'sync',
    };
  }

  if (state.failed > 0) {
    return {
      tone: 'warn',
      title: `${pluralise(state.failed, 'report')} rejected`,
      detail: 'open the outbox to fix or discard',
      action: 'outbox',
    };
  }

  if (state.pending > 0) {
    return {
      tone: 'warn',
      title: `${queued} queued`,
      detail: 'sending as soon as the network allows',
      action: 'outbox',
    };
  }

  if (state.phase === 'error') {
    return {
      tone: 'warn',
      title: 'Sync problem',
      detail: state.lastError ?? 'tap to try again',
      action: 'sync',
    };
  }

  return {
    tone: 'ok',
    title: 'Up to date',
    detail: state.lastSyncedAt ? `synced ${relativeTime(state.lastSyncedAt, now)}` : 'not synced yet',
    action: 'sync',
  };
}
