/**
 * The engine's job is to be honest: never claim to be up to date unless a
 * live read actually succeeded, and never lose a queued write along the way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDetail, readList } from '../src/lib/cache';
import { listOutbox } from '../src/lib/outbox';
import { discardQueued, queueReport, syncNow, syncStore } from '../src/lib/sync';
import type { Site, SiteSummary } from '../src/lib/types';

const SITE: Site = {
  id: 'site-1041',
  name: 'Dundas West Substation',
  address: '1180 Dundas St W, Toronto',
  region: 'Toronto Core',
  asset_tag: 'PLC-1041',
  status: 'needs_work',
  priority: 1,
  last_report_at: '2026-10-30T12:00:00Z',
  updated_at: '2026-10-30T12:00:00Z',
  rev: 4,
  access_notes: 'Gate code 4417.',
  contact_name: 'R. Deshpande',
  contact_phone: '+1-416-555-0141',
  report_count: 2,
};

const SUMMARY: SiteSummary = {
  id: SITE.id,
  name: SITE.name,
  address: SITE.address,
  region: SITE.region,
  asset_tag: SITE.asset_tag,
  status: SITE.status,
  priority: SITE.priority,
  last_report_at: SITE.last_report_at,
  updated_at: SITE.updated_at,
  rev: SITE.rev,
};

interface MockOptions {
  listStatus?: number;
  writeStatus?: number;
  fromCache?: boolean;
  offline?: boolean;
}

let calls: string[] = [];

function mockApi(options: MockOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(`${init?.method ?? 'GET'} ${url}`);

    if (options.offline) throw new TypeError('Failed to fetch');

    const headers: Record<string, string> = { 'Content-Type': 'application/json', ETag: '"abc"' };
    if (options.fromCache) headers['X-From-Cache'] = '1';

    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ duplicate: false, report: {}, site: SITE }), {
        status: options.writeStatus ?? 201,
        headers,
      });
    }

    if (url.endsWith('/api/v1/sites')) {
      if (options.listStatus === 304) return new Response(null, { status: 304, headers });
      return new Response(
        JSON.stringify({ server_time: '2026-11-01T10:00:00Z', count: 1, items: [SUMMARY] }),
        { status: 200, headers },
      );
    }

    return new Response(
      JSON.stringify({ server_time: '2026-11-01T10:00:00Z', site: SITE, reports: [] }),
      { status: 200, headers },
    );
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const QUEUE_INPUT = {
  siteId: SITE.id,
  siteName: SITE.name,
  status: 'blocked' as const,
  note: 'Access road washed out.',
  author: 'A. Tester',
};

/**
 * Queue a report with no network.
 *
 * queueReport deliberately fires a send attempt of its own, so join it before
 * asserting: otherwise the next syncNow() just rides along on that one.
 */
async function queueWhileOffline() {
  mockApi({ offline: true });
  await queueReport(QUEUE_INPUT);
  await syncNow();
  calls = [];
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('reading', () => {
  it('fills the cache and only then calls itself up to date', async () => {
    mockApi();
    expect(syncStore.getSnapshot().lastSyncedAt).toBeNull();

    await syncNow({ manual: true });

    const cached = await readList();
    expect(cached?.items).toHaveLength(1);
    expect(cached?.etag).toBe('"abc"');
    const state = syncStore.getSnapshot();
    expect(state.phase).toBe('idle');
    expect(state.lastSyncedAt).toBeGreaterThan(0);
  });

  it('sends the ETag it already has, so an unchanged list costs no body', async () => {
    mockApi();
    await syncNow({ manual: true });
    calls = [];

    const fetchMock = mockApi({ listStatus: 304 });
    await syncNow({ manual: true });

    const listCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/v1/sites'));
    expect((listCall?.[1]?.headers as Record<string, string>)['If-None-Match']).toBe('"abc"');
    // The cached copy survives a 304 rather than being blanked.
    expect((await readList())?.items).toHaveLength(1);
    expect(syncStore.getSnapshot().phase).toBe('idle');
  });

  it('does not count a service-worker replay as a fresh sync', async () => {
    mockApi({ fromCache: true });

    await syncNow({ manual: true });

    // Data is there to read, but the app must not claim it just synced.
    expect((await readList())?.items).toHaveLength(1);
    expect(syncStore.getSnapshot().lastSyncedAt).toBeNull();
  });

  it('goes to offline rather than pretending, when the network is gone', async () => {
    mockApi({ offline: true });

    await syncNow({ manual: true });

    const state = syncStore.getSnapshot();
    expect(state.phase).toBe('offline');
    expect(state.online).toBe(false);
    expect(state.lastSyncedAt).toBeNull();
  });

  it('coalesces overlapping syncs into one', async () => {
    const fetchMock = mockApi();
    await Promise.all([syncNow({ manual: true }), syncNow({ manual: true }), syncNow({ manual: true })]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/sites'))).toHaveLength(1);
  });
});

describe('writing', () => {
  it('queues the report straight away and shows it as pending', async () => {
    await queueWhileOffline();

    expect(await listOutbox()).toHaveLength(1);
    expect(syncStore.getSnapshot().pending).toBe(1);
  });

  it('pushes queued writes before pulling, so the list already includes them', async () => {
    await queueWhileOffline();

    mockApi();
    await syncNow({ manual: true });

    const postIndex = calls.findIndex((call) => call.startsWith('POST'));
    const listIndex = calls.findIndex((call) => call === 'GET /api/v1/sites');
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBeLessThan(listIndex);
  });

  it('clears the queue and refreshes the affected site once the write lands', async () => {
    await queueWhileOffline();

    mockApi();
    await syncNow({ manual: true });

    expect(await listOutbox()).toHaveLength(0);
    expect(syncStore.getSnapshot().pending).toBe(0);
    // The detail for the site we wrote to was re-read, not left stale.
    expect(calls).toContain(`GET /api/v1/sites/${SITE.id}`);
    expect((await readDetail(SITE.id))?.site.rev).toBe(4);
  });

  it('keeps the write and stays offline when the push fails', async () => {
    await queueWhileOffline();

    await syncNow({ manual: true });

    expect(await listOutbox()).toHaveLength(1);
    const state = syncStore.getSnapshot();
    expect(state.pending).toBe(1);
    expect(state.phase).toBe('offline');
    // Never reached the read, because there is no network to read over.
    expect(calls).not.toContain('GET /api/v1/sites');
  });

  it('surfaces a rejected write instead of silently dropping it', async () => {
    await queueWhileOffline();

    mockApi({ writeStatus: 422 });
    await syncNow({ manual: true });

    const state = syncStore.getSnapshot();
    expect(state.failed).toBe(1);
    expect(state.pending).toBe(0);
    expect(state.phase).toBe('error');
    expect(await listOutbox()).toHaveLength(1);
  });

  it('lets a queued report be thrown away', async () => {
    await queueWhileOffline();
    const [entry] = await listOutbox();

    await discardQueued(entry!.id);

    expect(await listOutbox()).toHaveLength(0);
    expect(syncStore.getSnapshot().pending).toBe(0);
  });
});

describe('subscribers', () => {
  it('notifies views when the data underneath them changed', async () => {
    mockApi();
    const seen: number[] = [];
    const unsubscribe = syncStore.subscribe(() => seen.push(syncStore.getSnapshot().dataRevision));

    await syncNow({ manual: true });
    unsubscribe();

    expect(seen.length).toBeGreaterThan(0);
    expect(syncStore.getSnapshot().dataRevision).toBeGreaterThan(0);
  });
});
