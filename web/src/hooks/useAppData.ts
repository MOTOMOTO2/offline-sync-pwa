import { useEffect, useState, useSyncExternalStore } from 'react';

import { readDetail, readList } from '../lib/cache';
import { listOutbox, pendingForSite } from '../lib/outbox';
import { pullSite, syncStore, type SyncSnapshot } from '../lib/sync';
import type { CachedDetail, CachedList, OutboxEntry } from '../lib/types';

/** The one source of truth for "what is happening with the network". */
export function useSyncState(): SyncSnapshot {
  return useSyncExternalStore(syncStore.subscribe, syncStore.getSnapshot, syncStore.getSnapshot);
}

/**
 * Screens read from the cache, never from the network directly. The sync
 * engine refills the cache and bumps `dataRevision`, which re-runs these.
 */
export function useSiteList(): { list: CachedList | undefined; loading: boolean } {
  const { dataRevision } = useSyncState();
  const [list, setList] = useState<CachedList | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void readList().then((value) => {
      if (!alive) return;
      setList(value);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [dataRevision]);

  return { list, loading };
}

export function useSiteDetail(siteId: string): {
  detail: CachedDetail | undefined;
  queued: OutboxEntry[];
  loading: boolean;
} {
  const { dataRevision } = useSyncState();
  const [detail, setDetail] = useState<CachedDetail | undefined>(undefined);
  const [queued, setQueued] = useState<OutboxEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [cached, pending] = await Promise.all([readDetail(siteId), pendingForSite(siteId)]);
      if (!alive) return;
      setDetail(cached);
      setQueued(pending);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [siteId, dataRevision]);

  // Opening a site is a good moment to check for a fresher copy.
  useEffect(() => {
    void pullSite(siteId);
  }, [siteId]);

  return { detail, queued, loading };
}

export function useOutbox(): { entries: OutboxEntry[]; loading: boolean } {
  const { dataRevision, pending, failed } = useSyncState();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void listOutbox().then((value) => {
      if (!alive) return;
      setEntries(value);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [dataRevision, pending, failed]);

  return { entries, loading };
}

/** Re-render on a timer so "4 min ago" does not freeze on screen. */
export function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}
