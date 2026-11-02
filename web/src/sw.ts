/**
 * Service worker: the offline half of the app.
 *
 * Three jobs.
 *   1. Precache the app shell at install, so a cold launch with no signal
 *      still gets a running app rather than the browser's dinosaur.
 *   2. Cache API reads as they go past, and replay them when the network is
 *      gone, tagged so the app knows it is looking at a saved copy.
 *   3. Drain the outbox on a Background Sync event, which lets queued reports
 *      leave the device even when the app is closed.
 *
 * It shares src/lib/outbox.ts with the app, so there is exactly one definition
 * of what a queued write is and how it gets sent.
 */

import { flushOutbox } from './lib/outbox';

declare const self: ServiceWorkerGlobalScope;

interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}

declare global {
  interface ServiceWorkerGlobalScopeEventMap {
    sync: SyncEvent;
  }
}

const SHELL_CACHE = `shell-${__BUILD_ID__}`;
const DATA_CACHE = 'api-data-v1';
const SYNC_TAG = 'flush-outbox';
const FROM_CACHE_HEADER = 'X-From-Cache';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // The core list must land in full, or this version of the app is not
      // actually installed and we would rather fail loudly now.
      await cache.addAll(__PRECACHE_CORE__);
      // Icons and the runtime config are best effort.
      await Promise.allSettled(__PRECACHE_OPTIONAL__.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Writes never go through here: they are queued in IndexedDB instead.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation());
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/runtime-config.js') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Hashed filenames, so a hit is always correct.
    event.respondWith(cacheFirst(request));
    return;
  }

  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.png'
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/** Every in-app route is the same shell, and it is already cached. */
async function handleNavigation(): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match('/index.html')) ?? (await cache.match('/'));
  if (cached) return cached;
  try {
    return await fetch('/index.html');
  } catch {
    return new Response(OFFLINE_SHELL, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? offlineJson();
}

/**
 * Reads: live data wins, the saved copy is the fallback.
 *
 * The fallback is tagged with a header so the app can say "showing the copy
 * saved at 14:32" instead of quietly pretending it just refreshed.
 */
async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    // 304 means the app's own copy is still good; nothing to store.
    if (response.ok) await cache.put(stripConditional(request), response.clone());
    return response;
  } catch {
    const cached = await cache.match(stripConditional(request));
    if (cached) return tagAsCached(cached);
    return offlineJson();
  }
}

/** Cache under the plain URL, never under a conditional variant of it. */
function stripConditional(request: Request): Request {
  return new Request(request.url, { method: 'GET' });
}

async function tagAsCached(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set(FROM_CACHE_HEADER, '1');
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function offlineJson(): Response {
  return new Response(JSON.stringify({ detail: 'Offline, and no saved copy of this request' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', [FROM_CACHE_HEADER]: '0' },
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(drainOutbox());
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (data?.type === 'FLUSH_OUTBOX') event.waitUntil(drainOutbox());
});

/**
 * Send whatever is queued and tell any open tab what moved.
 *
 * Rethrowing when the network is still down is deliberate: it tells the
 * browser this sync did not succeed, so it will wake us again later.
 */
async function drainOutbox(): Promise<void> {
  const result = await flushOutbox();

  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'outbox-flushed',
      sent: result.sent,
      duplicates: result.duplicates,
      failed: result.failed,
      touchedSites: result.touchedSites,
    });
  }

  if (result.offline) throw new Error('Still offline; ask the browser to retry this sync.');
}

const OFFLINE_SHELL = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Field Reports</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#0b0e14;color:#e9ecf4;
display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem;text-align:center}</style>
<h1>Offline</h1>
<p>The app shell has not been saved to this device yet. Open it once with a
connection and it will work offline from then on.</p>`;

export {};
