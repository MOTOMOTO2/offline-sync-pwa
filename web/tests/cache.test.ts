/** The read cache: what the phone can still show with the radio off. */

import { describe, expect, it } from 'vitest';

import {
  getAuthor,
  getLastSyncedAt,
  patchListEntry,
  readDetail,
  readList,
  setAuthor,
  setLastSyncedAt,
  writeDetail,
  writeList,
} from '../src/lib/cache';
import type { Report, Site, SiteSummary } from '../src/lib/types';

function summary(id: string, overrides: Partial<SiteSummary> = {}): SiteSummary {
  return {
    id,
    name: `Site ${id}`,
    address: '1 Example Rd',
    region: 'Toronto Core',
    asset_tag: `TAG-${id}`,
    status: 'ok',
    priority: 2,
    last_report_at: null,
    updated_at: '2026-10-01T00:00:00Z',
    rev: 1,
    ...overrides,
  };
}

function site(id: string, overrides: Partial<Site> = {}): Site {
  return {
    ...summary(id),
    access_notes: 'Gate code 1234.',
    contact_name: 'A. Contact',
    contact_phone: '+1-416-555-0100',
    report_count: 0,
    ...overrides,
  };
}

const REPORT: Report = {
  id: 'rep-1',
  site_id: 'a',
  status: 'ok',
  note: 'All nominal.',
  author: 'A. Tester',
  recorded_at: '2026-10-31T09:00:00Z',
  received_at: '2026-10-31T09:00:05Z',
};

describe('the site list cache', () => {
  it('round-trips the list with the ETag needed to revalidate it', async () => {
    await writeList([summary('a'), summary('b')], '"etag-1"', 1_000);

    const cached = await readList();
    expect(cached?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(cached?.etag).toBe('"etag-1"');
    expect(cached?.cachedAt).toBe(1_000);
  });

  it('starts empty rather than inventing data', async () => {
    expect(await readList()).toBeUndefined();
  });

  it('keeps the list in step after a write to one site', async () => {
    await writeList([summary('a'), summary('b')], null);

    await patchListEntry(site('a', { status: 'blocked', rev: 7, name: 'Renamed' }));

    const items = (await readList())?.items ?? [];
    expect(items.find((item) => item.id === 'a')).toMatchObject({
      status: 'blocked',
      rev: 7,
      name: 'Renamed',
    });
    // The untouched row is untouched.
    expect(items.find((item) => item.id === 'b')?.status).toBe('ok');
    // The summary stays a summary: no detail fields leak into the list.
    expect(items.find((item) => item.id === 'a')).not.toHaveProperty('access_notes');
  });

  it('ignores a patch for a site that is not in the list', async () => {
    await writeList([summary('a')], null);
    await patchListEntry(site('zzz'));
    expect((await readList())?.items).toHaveLength(1);
  });
});

describe('the detail cache', () => {
  it('stores the site and its reports together, with a timestamp', async () => {
    await writeDetail(site('a'), [REPORT], '"etag-detail"', 5_000);

    const cached = await readDetail('a');
    expect(cached?.site.access_notes).toBe('Gate code 1234.');
    expect(cached?.reports).toHaveLength(1);
    expect(cached?.cachedAt).toBe(5_000);
    expect(cached?.etag).toBe('"etag-detail"');
  });

  it('does not grow without bound as a tech works through a region', async () => {
    for (let index = 0; index < 70; index += 1) {
      await writeDetail(site(`s-${index}`), [], null, index);
    }
    // Oldest evicted, newest kept.
    expect(await readDetail('s-0')).toBeUndefined();
    expect(await readDetail('s-69')).toBeDefined();
  });
});

describe('remembered odds and ends', () => {
  it('remembers who is filing reports so it is typed once', async () => {
    expect(await getAuthor()).toBe('');
    await setAuthor('  R. Deshpande  ');
    expect(await getAuthor()).toBe('R. Deshpande');
  });

  it('remembers when the last real sync happened', async () => {
    expect(await getLastSyncedAt()).toBeNull();
    await setLastSyncedAt(1_730_000_000_000);
    expect(await getLastSyncedAt()).toBe(1_730_000_000_000);
  });
});
