// @vitest-environment happy-dom

/**
 * Screen-level checks: that the cache actually reaches the screen, that the
 * sync state is visible, and that the write action reaches the outbox when
 * there is no network to send it over.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BottomNav } from '../src/components/BottomNav';
import { SyncStatusBar } from '../src/components/SyncStatusBar';
import { writeDetail, writeList } from '../src/lib/cache';
import { listOutbox } from '../src/lib/outbox';
import { syncNow } from '../src/lib/sync';
import type { Report, Site, SiteSummary } from '../src/lib/types';
import { DetailView } from '../src/routes/DetailView';
import { ListView } from '../src/routes/ListView';
import { OutboxView } from '../src/routes/OutboxView';

const SITES: SiteSummary[] = [
  {
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
  },
  {
    id: 'site-1042',
    name: 'Lakeshore Pump House',
    address: '22 Marine Pde Dr, Toronto',
    region: 'Toronto West',
    asset_tag: 'PMP-1042',
    status: 'ok',
    priority: 3,
    last_report_at: '2026-10-23T12:00:00Z',
    updated_at: '2026-10-23T12:00:00Z',
    rev: 2,
  },
];

const DETAIL: Site = {
  ...SITES[0]!,
  access_notes: 'Gate code 4417. Park in the laneway.',
  contact_name: 'R. Deshpande',
  contact_phone: '+1-416-555-0141',
  report_count: 1,
};

const REPORT: Report = {
  id: 'seed-000',
  site_id: 'site-1041',
  status: 'needs_work',
  note: 'Door seal perished.',
  author: 'R. Deshpande',
  recorded_at: '2026-10-30T12:00:00Z',
  received_at: '2026-10-30T12:00:05Z',
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  // Every one of these runs as if the phone has no signal: the screens must
  // come entirely from what was cached earlier.
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function renderApp(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SyncStatusBar />
      <Routes>
        <Route path="/" element={<ListView />} />
        <Route path="/sites/:siteId" element={<DetailView />} />
        <Route path="/outbox" element={<OutboxView />} />
      </Routes>
      <BottomNav />
    </MemoryRouter>,
  );
}

describe('the list screen', () => {
  it('renders sites from the cache with no network at all', async () => {
    await writeList(SITES, '"etag"');

    renderApp();

    expect(await screen.findByText('Dundas West Substation')).toBeTruthy();
    expect(screen.getByText('Lakeshore Pump House')).toBeTruthy();
    // It says where the data came from rather than implying it is live.
    expect(screen.getAllByText(/saved copy|saved \d|saved just now/i).length).toBeGreaterThan(0);
  });

  it('says plainly when nothing has been downloaded yet', async () => {
    renderApp();
    expect(await screen.findByText('Nothing saved yet')).toBeTruthy();
  });

  it('filters by status from controls inside thumb reach', async () => {
    await writeList(SITES, null);
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('Dundas West Substation');

    await user.click(screen.getByRole('button', { name: /^OK/ }));

    expect(screen.queryByText('Dundas West Substation')).toBeNull();
    expect(screen.getByText('Lakeshore Pump House')).toBeTruthy();
  });
});

describe('the sync status', () => {
  it('is on screen, and admits when it has never synced', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText(/not synced yet|Syncing/)).toBeTruthy());
  });

  it('turns to offline once a sync attempt fails', async () => {
    await writeList(SITES, null);
    renderApp();

    await syncNow({ manual: true });

    expect(await screen.findByText('Offline')).toBeTruthy();
  });
});

describe('filing a report with no signal', () => {
  it('saves it to the outbox and shows it on the site immediately', async () => {
    await writeList(SITES, null);
    await writeDetail(DETAIL, [REPORT], null);
    const user = userEvent.setup();

    renderApp('/sites/site-1041');
    expect(await screen.findByText('Gate code 4417. Park in the laneway.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /file report/i }));

    const sheet = screen.getByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Blocked' }));
    await user.type(within(sheet).getByLabelText(/notes/i), 'Road washed out.');
    // The button says what will actually happen while offline.
    await user.click(within(sheet).getByRole('button', { name: /save to outbox/i }));

    await waitFor(async () => expect(await listOutbox()).toHaveLength(1));
    const [queued] = await listOutbox();
    expect(queued).toMatchObject({ siteId: 'site-1041', status: 'blocked', note: 'Road washed out.' });

    // And it is visible on the timeline straight away, marked as unsent.
    expect(await screen.findByText('queued')).toBeTruthy();
    expect(screen.getByText('Road washed out.')).toBeTruthy();
  });

  it('shows the queued report in the outbox with a way to discard it', async () => {
    await writeList(SITES, null);
    await writeDetail(DETAIL, [REPORT], null);
    const user = userEvent.setup();

    renderApp('/sites/site-1041');
    await user.click(await screen.findByRole('button', { name: /file report/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /save to outbox/i }));
    await waitFor(async () => expect(await listOutbox()).toHaveLength(1));

    await user.click(screen.getByRole('link', { name: /outbox/i }));

    expect(await screen.findByText('Queued')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /discard report/i }));

    await waitFor(async () => expect(await listOutbox()).toHaveLength(0));
    expect(await screen.findByText('Nothing waiting')).toBeTruthy();
  });
});
