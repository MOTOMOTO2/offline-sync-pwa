/**
 * The outbox is the part that has to be right: a report captured with no
 * signal must survive, must eventually arrive, and must arrive exactly once.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  backoffMs,
  enqueueReport,
  flushOutbox,
  listOutbox,
  outboxCounts,
  retryEntry,
  type QueueInput,
} from '../src/lib/outbox';

const INPUT: QueueInput = {
  siteId: 'site-1041',
  siteName: 'Dundas West Substation',
  status: 'needs_work',
  note: '  Door seal perished.  ',
  author: 'A. Tester',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function accepted(status = 201) {
  return vi.fn(async () => jsonResponse(status, { duplicate: status === 200, report: {}, site: {} }));
}

describe('capturing a write', () => {
  it('stores the report immediately, before any network call', async () => {
    const entry = await enqueueReport(INPUT);

    const stored = await listOutbox();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      siteId: 'site-1041',
      status: 'needs_work',
      state: 'pending',
      attempts: 0,
    });
    // Trimmed on the way in, so the server never sees the stray whitespace.
    expect(stored[0]?.note).toBe('Door seal perished.');
  });

  it('gives every report an id that can be used as an idempotency key', async () => {
    const first = await enqueueReport(INPUT);
    const second = await enqueueReport(INPUT);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^rep-[a-z0-9]{8,}$/i);
  });

  it('stamps the device clock at capture time, not at send time', async () => {
    const captured = new Date('2026-03-04T09:15:00.000Z').toISOString();
    await enqueueReport({ ...INPUT, recordedAt: captured });
    expect((await listOutbox())[0]?.recordedAt).toBe(captured);
  });
});

describe('flushing when the network is there', () => {
  it('sends the queue oldest first and clears what the server accepted', async () => {
    const first = await enqueueReport(INPUT, 1_000);
    const second = await enqueueReport({ ...INPUT, note: 'second' }, 2_000);
    const fetchImpl = accepted();

    const result = await flushOutbox({ fetchImpl, apiBase: '' });

    expect(result.sent).toEqual([first.id, second.id]);
    expect(result.touchedSites).toEqual(['site-1041']);
    expect(await listOutbox()).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('posts the report id as the body id and as an idempotency header', async () => {
    const entry = await enqueueReport(INPUT);
    const fetchImpl = accepted();

    await flushOutbox({ fetchImpl, apiBase: 'https://api.example.com' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/sites/site-1041/reports');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(entry.id);
    expect(JSON.parse(init.body as string)).toMatchObject({
      id: entry.id,
      status: 'needs_work',
      note: 'Door seal perished.',
      author: 'A. Tester',
    });
  });

  it('treats a 200 as "the server already had this one" and still clears it', async () => {
    await enqueueReport(INPUT);
    const result = await flushOutbox({ fetchImpl: accepted(200), apiBase: '' });

    expect(result.duplicates).toHaveLength(1);
    expect(result.sent).toHaveLength(0);
    expect(await listOutbox()).toHaveLength(0);
  });
});

describe('flushing when the network is not there', () => {
  it('keeps the report, reports offline, and does not burn through the queue', async () => {
    await enqueueReport(INPUT, 1_000);
    await enqueueReport({ ...INPUT, note: 'second' }, 2_000);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    const result = await flushOutbox({ fetchImpl, apiBase: '' });

    expect(result.offline).toBe(true);
    expect(result.sent).toHaveLength(0);
    // Stopped after the first failure rather than retrying every entry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = await listOutbox();
    expect(stored).toHaveLength(2);
    expect(stored[0]?.state).toBe('pending');
    // The lease is released so the next attempt is not blocked.
    expect(stored[0]?.leaseUntil).toBe(0);
  });

  it('retries later with a growing backoff when the server is broken', async () => {
    await enqueueReport(INPUT, 0);
    const fetchImpl = vi.fn(async () => jsonResponse(503, { detail: 'upstream down' }));
    const now = () => 10_000;

    const result = await flushOutbox({ fetchImpl, apiBase: '', now });

    expect(result.retryLater).toHaveLength(1);
    const [entry] = await listOutbox();
    expect(entry?.state).toBe('pending');
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextAttemptAt).toBeGreaterThan(10_000);
    expect(entry?.lastError).toContain('upstream down');
  });

  it('does not touch an entry that is still inside its backoff window', async () => {
    await enqueueReport(INPUT, 0);
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    await flushOutbox({ fetchImpl, apiBase: '', now: () => 10_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await flushOutbox({ fetchImpl, apiBase: '', now: () => 10_100 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after enough server failures so a human can look at it', async () => {
    await enqueueReport(INPUT, 0);
    const fetchImpl = vi.fn(async () => jsonResponse(500, { detail: 'boom' }));

    let clock = 0;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      clock += 10 * 60_000; // Well past any backoff.
      await flushOutbox({ fetchImpl, apiBase: '', now: () => clock, maxAttempts: 4 });
    }

    const [entry] = await listOutbox();
    expect(entry?.state).toBe('failed');
    expect(entry?.lastError).toContain('gave up');
    // Parked, so later flushes leave it alone.
    const callsWhenParked = fetchImpl.mock.calls.length;
    await flushOutbox({ fetchImpl, apiBase: '', now: () => clock + 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(callsWhenParked);
  });
});

describe('writes the server refuses', () => {
  it.each([
    [404, 'No site with id'],
    [409, 'already exists against a different site'],
    [422, 'value is not a valid enumeration member'],
  ])('parks a %i instead of retrying forever', async (status, detail) => {
    await enqueueReport(INPUT);
    const fetchImpl = vi.fn(async () => jsonResponse(status, { detail }));

    const result = await flushOutbox({ fetchImpl, apiBase: '' });

    expect(result.failed).toHaveLength(1);
    const [entry] = await listOutbox();
    expect(entry?.state).toBe('failed');
    expect(entry?.lastError).toBe(detail);
    expect(await outboxCounts()).toEqual({ pending: 0, failed: 1 });
  });

  it('retries a 429 rather than parking it', async () => {
    await enqueueReport(INPUT);
    const result = await flushOutbox({
      fetchImpl: vi.fn(async () => jsonResponse(429, { detail: 'slow down' })),
      apiBase: '',
    });
    expect(result.retryLater).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('reads a FastAPI validation error into something a person can act on', async () => {
    await enqueueReport(INPUT);
    await flushOutbox({
      fetchImpl: vi.fn(async () =>
        jsonResponse(422, { detail: [{ msg: 'String should match pattern', loc: ['body', 'id'] }] }),
      ),
      apiBase: '',
    });
    expect((await listOutbox())[0]?.lastError).toBe('String should match pattern (body.id)');
  });

  it('can be put back in the queue by hand', async () => {
    await enqueueReport(INPUT);
    await flushOutbox({
      fetchImpl: vi.fn(async () => jsonResponse(500, {})),
      apiBase: '',
      maxAttempts: 1,
    });
    expect((await listOutbox())[0]?.state).toBe('failed');

    await retryEntry((await listOutbox())[0]!.id, 50_000);
    const [entry] = await listOutbox();
    expect(entry).toMatchObject({ state: 'pending', attempts: 0, lastError: null });

    const result = await flushOutbox({ fetchImpl: accepted(), apiBase: '', now: () => 50_000 });
    expect(result.sent).toHaveLength(1);
  });
});

describe('two senders at once', () => {
  it('only posts a leased entry once, even from concurrent flushes', async () => {
    await enqueueReport(INPUT);
    // A slow request, so the second flush starts while the first is in flight.
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse(201, {})), 20);
        }),
    );

    const [first, second] = await Promise.all([
      flushOutbox({ fetchImpl, apiBase: '' }),
      flushOutbox({ fetchImpl, apiBase: '' }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first!.sent.length + second!.sent.length).toBe(1);
    expect(await listOutbox()).toHaveLength(0);
  });

  it('lets another sender take over once a lease has expired', async () => {
    await enqueueReport(INPUT, 0);
    const stalled = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await flushOutbox({ fetchImpl: stalled, apiBase: '', now: () => 1_000, leaseMs: 30_000 });

    const later = accepted();
    const result = await flushOutbox({ fetchImpl: later, apiBase: '', now: () => 40_000 });
    expect(result.sent).toHaveLength(1);
  });
});

describe('backoff', () => {
  it('grows with each attempt and stays within a sane band', () => {
    const steady = () => 0.5;
    expect(backoffMs(1, steady)).toBe(2_000);
    expect(backoffMs(2, steady)).toBe(4_000);
    expect(backoffMs(3, steady)).toBe(8_000);
    // Capped, so an hours-long outage still retries every few minutes.
    expect(backoffMs(30, steady)).toBe(300_000);
  });

  it('jitters so a fleet of phones does not retry in lockstep', () => {
    expect(backoffMs(4, () => 0)).toBeLessThan(backoffMs(4, () => 1));
  });
});
