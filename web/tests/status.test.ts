/**
 * What the status bar says is the app's main promise to the user, so it gets
 * its own tests rather than being left to a component snapshot.
 */

import { describe, expect, it } from 'vitest';

import { relativeTime, untilTime } from '../src/lib/format';
import { describeSync } from '../src/lib/status';
import type { SyncSnapshot } from '../src/lib/sync';

const NOW = Date.parse('2026-11-01T12:00:00Z');

function state(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    online: true,
    phase: 'idle',
    pending: 0,
    failed: 0,
    lastSyncedAt: NOW - 120_000,
    lastError: null,
    dataRevision: 1,
    ...overrides,
  };
}

describe('describeSync', () => {
  it('says when it last actually reached the server', () => {
    const result = describeSync(state(), NOW);
    expect(result.tone).toBe('ok');
    expect(result.title).toBe('Up to date');
    expect(result.detail).toBe('synced 2 min ago');
  });

  it('never claims to be up to date before the first successful sync', () => {
    const result = describeSync(state({ lastSyncedAt: null }), NOW);
    expect(result.detail).toBe('not synced yet');
  });

  it('shows progress while a sync is running', () => {
    expect(describeSync(state({ phase: 'syncing' }), NOW)).toMatchObject({
      tone: 'busy',
      title: 'Syncing',
      detail: 'checking for changes',
    });
    expect(describeSync(state({ phase: 'syncing', pending: 2 }), NOW).detail).toBe('sending 2 reports');
  });

  it('offline says how old the data on screen is', () => {
    const result = describeSync(state({ online: false, lastSyncedAt: NOW - 3 * 3_600_000 }), NOW);
    expect(result.tone).toBe('bad');
    expect(result.title).toBe('Offline');
    expect(result.detail).toBe('saved copy from 3 h ago');
    expect(result.action).toBe('sync');
  });

  it('offline with queued work points at the outbox', () => {
    const result = describeSync(state({ online: false, pending: 1 }), NOW);
    expect(result.detail).toContain('1 report queued');
    expect(result.action).toBe('outbox');
  });

  it('warns while writes are still waiting, even though the network is up', () => {
    const result = describeSync(state({ pending: 3 }), NOW);
    expect(result.tone).toBe('warn');
    expect(result.title).toBe('3 reports queued');
    expect(result.action).toBe('outbox');
  });

  it('a rejected write outranks a merely queued one', () => {
    const result = describeSync(state({ pending: 2, failed: 1 }), NOW);
    expect(result.title).toBe('1 report rejected');
    expect(result.action).toBe('outbox');
  });

  it('reports a sync problem with the reason attached', () => {
    const result = describeSync(state({ phase: 'error', lastError: 'Server returned 500' }), NOW);
    expect(result.tone).toBe('warn');
    expect(result.detail).toBe('Server returned 500');
  });
});

describe('relative time', () => {
  it.each([
    [0, 'just now'],
    [30_000, 'just now'],
    [5 * 60_000, '5 min ago'],
    [2 * 3_600_000, '2 h ago'],
    [26 * 3_600_000, '1 day ago'],
    [5 * 86_400_000, '5 days ago'],
    [70 * 86_400_000, '2 months ago'],
  ])('renders %i ms ago as "%s"', (delta, expected) => {
    expect(relativeTime(NOW - delta, NOW)).toBe(expected);
  });

  it('handles a missing or unparseable timestamp', () => {
    expect(relativeTime(null, NOW)).toBe('never');
    expect(relativeTime('not a date', NOW)).toBe('never');
  });

  it('does not say "in the future" when a device clock runs fast', () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now');
  });

  it('counts down to the next retry', () => {
    expect(untilTime(NOW + 8_000, NOW)).toBe('in 8 s');
    expect(untilTime(NOW + 240_000, NOW)).toBe('in 4 min');
    expect(untilTime(NOW - 1, NOW)).toBe('any moment now');
  });
});
