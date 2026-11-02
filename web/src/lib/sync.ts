/**
 * The sync engine.
 *
 * One module owns the answer to "what is the app's relationship with the
 * network right now", because that answer has to be on screen at all times.
 * Views subscribe to a snapshot; nothing else in the UI talks to the network.
 *
 * Order of operations in a sync is deliberate: push first, then pull. Sending
 * queued writes before re-reading means the list the tech sees already
 * includes what they filed, instead of flickering back to the old value.
 */

import { fetchSiteDetail, fetchSiteList } from './api';
import {
  getLastSyncedAt,
  patchListEntry,
  readDetail,
  readList,
  setLastSyncedAt,
  writeDetail,
  writeList,
} from './cache';
import { appConfig } from './config';
import {
  discardEntry,
  enqueueReport,
  flushOutbox,
  outboxCounts,
  retryAll,
  setApiBase,
  type QueueInput,
} from './outbox';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncSnapshot {
  online: boolean;
  phase: SyncPhase;
  pending: number;
  failed: number;
  lastSyncedAt: number | null;
  lastError: string | null;
  /** Bumped whenever cached data changed, so views know to re-read it. */
  dataRevision: number;
}

const SYNC_TAG = 'flush-outbox';
const CHANNEL_NAME = 'field-reports-sync';
/** While writes are queued, keep nudging them out without waiting for a tap. */
const RETRY_INTERVAL_MS = 20_000;
/** A pull older than this is worth refreshing when the app comes back up. */
const STALE_AFTER_MS = 60_000;

/** Assume online where the browser does not say otherwise; a failed fetch corrects it. */
function initialOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

let snapshot: SyncSnapshot = {
  online: initialOnline(),
  phase: 'idle',
  pending: 0,
  failed: 0,
  lastSyncedAt: null,
  lastError: null,
  dataRevision: 0,
};

const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let channel: BroadcastChannel | null = null;
let started = false;

function emit(patch: Partial<SyncSnapshot>): void {
  const next = { ...snapshot, ...patch };
  const unchanged = (Object.keys(next) as (keyof SyncSnapshot)[]).every(
    (key) => next[key] === snapshot[key],
  );
  if (unchanged) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function bumpData(): void {
  emit({ dataRevision: snapshot.dataRevision + 1 });
}

export const syncStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): SyncSnapshot {
    return snapshot;
  },
};

async function refreshCounts(): Promise<void> {
  const counts = await outboxCounts();
  emit({ pending: counts.pending, failed: counts.failed });
}

/**
 * Ask the browser to finish the queue for us even if the app is closed.
 * Only Chromium implements this; everywhere else the in-app retry loop and
 * the online event do the same job while the app is open.
 */
async function requestBackgroundSync(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registration = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    await registration.sync?.register(SYNC_TAG);
  } catch {
    // Permission denied or unsupported: not a problem, we retry in-app.
  }
}

/** Pull one site's detail and keep the cached list consistent with it. */
export async function pullSite(siteId: string): Promise<'updated' | 'unchanged' | 'failed'> {
  const cached = await readDetail(siteId);
  const result = await fetchSiteDetail(siteId, cached?.etag ?? null);

  if (result.kind === 'not-modified') return 'unchanged';
  if (result.kind === 'error') {
    if (result.offline) emit({ online: false, phase: 'offline' });
    return 'failed';
  }

  await writeDetail(result.data.site, result.data.reports, result.etag);
  await patchListEntry(result.data.site);
  bumpData();
  return result.fromCache ? 'unchanged' : 'updated';
}

async function pullList(): Promise<{ ok: boolean; fromCache: boolean; message?: string }> {
  const cached = await readList();
  const result = await fetchSiteList(cached?.etag ?? null);

  if (result.kind === 'not-modified') return { ok: true, fromCache: false };
  if (result.kind === 'error') {
    return { ok: false, fromCache: false, message: result.message };
  }

  await writeList(result.data.items, result.etag);
  bumpData();
  return { ok: true, fromCache: result.fromCache };
}

export interface SyncOptions {
  /** A manual tap reports errors loudly; a background tick stays quiet. */
  manual?: boolean;
}

export function syncNow(options: SyncOptions = {}): Promise<void> {
  // Coalesce: a tap during an in-flight sync joins it rather than racing it.
  if (inFlight) return inFlight;
  inFlight = runSync(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync({ manual = false }: SyncOptions): Promise<void> {
  // navigator.onLine lies on captive portals, so it is a hint, not a gate:
  // a manual tap always tries the network and lets the fetch decide.
  if (!snapshot.online && !manual) {
    emit({ phase: 'offline' });
    return;
  }

  emit({ phase: 'syncing', lastError: null });

  // Push before pull, so the pull reflects what we just sent.
  const flushed = await flushOutbox({ apiBase: appConfig().apiBase });
  await refreshCounts();

  if (flushed.offline) {
    emit({ online: false, phase: 'offline' });
    return;
  }
  if (flushed.sent.length || flushed.duplicates.length) bumpData();
  for (const siteId of flushed.touchedSites) await pullSite(siteId);

  const list = await pullList();
  if (!list.ok) {
    emit({ online: false, phase: 'offline', lastError: list.message ?? 'Sync failed' });
    return;
  }

  const now = Date.now();
  if (!list.fromCache) await setLastSyncedAt(now);

  emit({
    online: true,
    phase: flushed.failed.length ? 'error' : 'idle',
    lastSyncedAt: list.fromCache ? snapshot.lastSyncedAt : now,
    lastError: flushed.failed.length ? 'Some reports were rejected' : null,
  });
}

/** Capture a report. Durable immediately; sent whenever the network allows. */
export async function queueReport(input: QueueInput): Promise<void> {
  await enqueueReport(input);
  await refreshCounts();
  bumpData();
  void requestBackgroundSync();
  channel?.postMessage({ type: 'outbox-changed' });
  if (snapshot.online) void syncNow();
}

export async function retryFailed(): Promise<void> {
  await retryAll();
  await refreshCounts();
  bumpData();
  await syncNow({ manual: true });
}

export async function discardQueued(id: string): Promise<void> {
  await discardEntry(id);
  await refreshCounts();
  bumpData();
  channel?.postMessage({ type: 'outbox-changed' });
}

/** Wire up the listeners that decide when a sync happens. Call once at boot. */
export async function startSync(): Promise<() => void> {
  if (started) return () => undefined;
  started = true;

  // The service worker runs in its own context and cannot read window config.
  await setApiBase(appConfig().apiBase);

  emit({ lastSyncedAt: await getLastSyncedAt() });
  await refreshCounts();

  const goOnline = () => {
    emit({ online: true });
    void syncNow();
  };
  const goOffline = () => emit({ online: false, phase: 'offline' });

  const onVisible = () => {
    if (document.visibilityState !== 'visible' || !snapshot.online) return;
    const stale = !snapshot.lastSyncedAt || Date.now() - snapshot.lastSyncedAt > STALE_AFTER_MS;
    if (stale || snapshot.pending > 0) void syncNow();
  };

  const onServiceWorkerMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; touchedSites?: string[] } | null;
    if (data?.type !== 'outbox-flushed') return;
    // The worker sent our queue while we were idle or closed.
    void (async () => {
      await refreshCounts();
      for (const siteId of data.touchedSites ?? []) await pullSite(siteId);
      bumpData();
    })();
  };

  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);

  if ('BroadcastChannel' in globalThis) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => void refreshCounts();
  }

  timer = setInterval(() => {
    if (snapshot.online && snapshot.pending > 0 && snapshot.phase !== 'syncing') void syncNow();
  }, RETRY_INTERVAL_MS);

  void syncNow();

  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    channel?.close();
    channel = null;
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
  };
}

/** Test helper: drop all engine state between cases. */
export function resetSyncStateForTests(): void {
  snapshot = {
    online: true,
    phase: 'idle',
    pending: 0,
    failed: 0,
    lastSyncedAt: null,
    lastError: null,
    dataRevision: 0,
  };
  listeners.clear();
  inFlight = null;
  if (timer) clearInterval(timer);
  timer = null;
  channel?.close();
  channel = null;
  started = false;
}
