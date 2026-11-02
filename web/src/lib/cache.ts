/**
 * The read cache: whatever the phone last saw from the API, kept so the list
 * and detail screens render instantly and keep working with no signal.
 */

import { idbDelete, idbGet, idbGetAll, idbPut, STORE } from './idb';
import type { CachedDetail, CachedList, Report, Site, SiteSummary } from './types';

const LIST_KEY = 'current';

export const META = {
  lastSyncedAt: 'lastSyncedAt',
  author: 'author',
  installPromptDismissed: 'installPromptDismissed',
} as const;

/** Details are small, but there is no reason to keep every site forever. */
const MAX_CACHED_DETAILS = 60;

export function readList(): Promise<CachedList | undefined> {
  return idbGet<CachedList>(STORE.list, LIST_KEY);
}

export async function writeList(
  items: SiteSummary[],
  etag: string | null,
  cachedAt = Date.now(),
): Promise<CachedList> {
  const record: CachedList = { items, etag, cachedAt };
  await idbPut(STORE.list, record, LIST_KEY);
  return record;
}

/** Keep the cached list in step after a write without a full round trip. */
export async function patchListEntry(site: Site): Promise<void> {
  const current = await readList();
  if (!current || !current.items.some((item) => item.id === site.id)) return;
  const items = current.items.map((item) => (item.id === site.id ? summaryOf(site) : item));
  await idbPut(STORE.list, { ...current, items }, LIST_KEY);
}

function summaryOf(site: Site): SiteSummary {
  return {
    id: site.id,
    name: site.name,
    address: site.address,
    region: site.region,
    asset_tag: site.asset_tag,
    status: site.status,
    priority: site.priority,
    last_report_at: site.last_report_at,
    updated_at: site.updated_at,
    rev: site.rev,
  };
}

export function readDetail(id: string): Promise<CachedDetail | undefined> {
  return idbGet<CachedDetail>(STORE.details, id);
}

export async function writeDetail(
  site: Site,
  reports: Report[],
  etag: string | null,
  cachedAt = Date.now(),
): Promise<CachedDetail> {
  const record: CachedDetail = { id: site.id, site, reports, etag, cachedAt };
  await idbPut(STORE.details, record);
  await pruneDetails();
  return record;
}

async function pruneDetails(): Promise<void> {
  const all = await idbGetAll<CachedDetail>(STORE.details);
  if (all.length <= MAX_CACHED_DETAILS) return;
  const stale = all.sort((a, b) => a.cachedAt - b.cachedAt).slice(0, all.length - MAX_CACHED_DETAILS);
  for (const record of stale) await idbDelete(STORE.details, record.id);
}

export async function getLastSyncedAt(): Promise<number | null> {
  return (await idbGet<number>(STORE.meta, META.lastSyncedAt)) ?? null;
}

export async function setLastSyncedAt(value: number): Promise<void> {
  await idbPut(STORE.meta, value, META.lastSyncedAt);
}

export async function getAuthor(): Promise<string> {
  return (await idbGet<string>(STORE.meta, META.author)) ?? '';
}

export async function setAuthor(name: string): Promise<void> {
  await idbPut(STORE.meta, name.trim(), META.author);
}
