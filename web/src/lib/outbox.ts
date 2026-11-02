/**
 * The outbox: durable, idempotent, replayable writes.
 *
 * Every write goes into IndexedDB first and is only ever removed once the
 * server has acknowledged it. That ordering is what makes the app honest when
 * there is no signal: the report is safe the instant the tech taps Save, the
 * network is just a later detail.
 *
 * This module is imported by both the app and the service worker, so it must
 * not touch `window`, `document` or `localStorage`.
 */

import { idbDelete, idbGet, idbGetAll, idbPut, idbUpdate, STORE } from './idb';
import type { OutboxEntry, ReportStatus } from './types';

export const META_API_BASE = 'apiBase';

/** How long one sender may hold an entry before another may take it over. */
export const LEASE_MS = 30_000;

/** Server errors are retried this many times before the entry needs a human. */
export const MAX_ATTEMPTS = 8;

export interface QueueInput {
  siteId: string;
  siteName: string;
  status: ReportStatus;
  note: string;
  author: string;
  recordedAt?: string;
}

export interface FlushOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  apiBase?: string;
  leaseMs?: number;
  maxAttempts?: number;
}

export interface FlushResult {
  /** Entry ids the server accepted (new writes). */
  sent: string[];
  /** Accepted, but the server had already seen them: a retry that landed twice. */
  duplicates: string[];
  /** Rejected for good; they stay in the outbox until the user deals with them. */
  failed: string[];
  /** Deferred: server trouble, will be tried again after a backoff. */
  retryLater: string[];
  /** True when the network itself is unreachable, so the rest was not attempted. */
  offline: boolean;
  /** Sites whose cached detail is now out of date. */
  touchedSites: string[];
}

const EMPTY_RESULT: FlushResult = {
  sent: [],
  duplicates: [],
  failed: [],
  retryLater: [],
  offline: false,
  touchedSites: [],
};

export function newReportId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return 'rep-' + uuid.replace(/-/g, '');
}

/** Exponential backoff with jitter, capped so a long outage still retries. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(2 ** Math.max(0, attempts - 1) * 2_000, 5 * 60_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export async function enqueueReport(input: QueueInput, now = Date.now()): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    id: newReportId(),
    siteId: input.siteId,
    siteName: input.siteName,
    status: input.status,
    note: input.note.trim(),
    author: input.author.trim(),
    recordedAt: input.recordedAt ?? new Date(now).toISOString(),
    createdAt: now,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: 0,
    lastError: null,
  };
  await idbPut(STORE.outbox, entry);
  return entry;
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const entries = await idbGetAll<OutboxEntry>(STORE.outbox);
  return entries.sort((a, b) => a.createdAt - b.createdAt);
}

export async function outboxCounts(): Promise<{ pending: number; failed: number }> {
  const entries = await listOutbox();
  return {
    pending: entries.filter((entry) => entry.state === 'pending').length,
    failed: entries.filter((entry) => entry.state === 'failed').length,
  };
}

export async function pendingForSite(siteId: string): Promise<OutboxEntry[]> {
  return (await listOutbox()).filter((entry) => entry.siteId === siteId);
}

export function discardEntry(id: string): Promise<unknown> {
  return idbDelete(STORE.outbox, id);
}

/** Put a parked entry back in the queue and clear its backoff. */
export async function retryEntry(id: string, now = Date.now()): Promise<void> {
  await idbUpdate<OutboxEntry>(STORE.outbox, id, (current) =>
    current
      ? { ...current, state: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: 0, lastError: null }
      : current,
  );
}

export async function retryAll(now = Date.now()): Promise<void> {
  for (const entry of await listOutbox()) {
    if (entry.state === 'failed' || entry.nextAttemptAt > now) await retryEntry(entry.id, now);
  }
}

export async function getApiBase(): Promise<string> {
  return (await idbGet<string>(STORE.meta, META_API_BASE)) ?? '';
}

export async function setApiBase(base: string): Promise<void> {
  await idbPut(STORE.meta, base, META_API_BASE);
}

function describeError(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: string; loc?: unknown[] } | undefined;
    if (first?.msg) return `${first.msg}${first.loc ? ` (${first.loc.join('.')})` : ''}`;
  }
  return `Server returned ${status}`;
}

/** 4xx that will never succeed on retry. 408 and 429 are explicitly not here. */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Try to send every due entry, oldest first.
 *
 * Safe to call concurrently from several tabs and the service worker: entries
 * are leased before sending, and the server dedupes on the report id anyway.
 */
export async function flushOutbox(options: FlushOptions = {}): Promise<FlushResult> {
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const apiBase = options.apiBase ?? (await getApiBase());

  const result: FlushResult = { ...EMPTY_RESULT, sent: [], duplicates: [], failed: [], retryLater: [], touchedSites: [] };
  const queue = await listOutbox();

  for (const entry of queue) {
    const startedAt = now();
    if (entry.state !== 'pending' || entry.nextAttemptAt > startedAt) continue;

    // Claim the entry. The flag is set inside the transaction, so of two
    // senders racing for the same entry exactly one comes out of here with
    // `claimed` true, even if both picked the same millisecond.
    let claimed = false;
    await idbUpdate<OutboxEntry>(STORE.outbox, entry.id, (current) => {
      if (!current || current.state !== 'pending') return current;
      if (current.leaseUntil > startedAt) return current;
      claimed = true;
      return { ...current, leaseUntil: startedAt + leaseMs };
    });
    if (!claimed) continue;

    const url = `${apiBase}/api/v1/sites/${encodeURIComponent(entry.siteId)}/reports`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Harmless here, and the convention most APIs expect.
          'Idempotency-Key': entry.id,
        },
        body: JSON.stringify({
          id: entry.id,
          status: entry.status,
          note: entry.note,
          author: entry.author,
          recorded_at: entry.recordedAt,
        }),
      });
    } catch {
      // No network. Release the lease and stop: the rest would fail the same way.
      await releaseLease(entry.id);
      result.offline = true;
      break;
    }

    if (response.ok) {
      await idbDelete(STORE.outbox, entry.id);
      // 200 rather than 201 means the server had already stored this id.
      (response.status === 200 ? result.duplicates : result.sent).push(entry.id);
      if (!result.touchedSites.includes(entry.siteId)) result.touchedSites.push(entry.siteId);
      continue;
    }

    const body = await response.json().catch(() => null);
    const message = describeError(response.status, body);

    if (isPermanent(response.status)) {
      await parkEntry(entry.id, message);
      result.failed.push(entry.id);
      continue;
    }

    const attempts = entry.attempts + 1;
    if (attempts >= maxAttempts) {
      await parkEntry(entry.id, `${message} (gave up after ${attempts} tries)`);
      result.failed.push(entry.id);
      continue;
    }

    const retryAt = now() + backoffMs(attempts);
    await idbUpdate<OutboxEntry>(STORE.outbox, entry.id, (current) =>
      current ? { ...current, attempts, nextAttemptAt: retryAt, leaseUntil: 0, lastError: message } : current,
    );
    result.retryLater.push(entry.id);
  }

  return result;
}

async function releaseLease(id: string): Promise<void> {
  await idbUpdate<OutboxEntry>(STORE.outbox, id, (current) =>
    current ? { ...current, leaseUntil: 0 } : current,
  );
}

async function parkEntry(id: string, message: string): Promise<void> {
  await idbUpdate<OutboxEntry>(STORE.outbox, id, (current) =>
    current ? { ...current, state: 'failed', leaseUntil: 0, lastError: message } : current,
  );
}
