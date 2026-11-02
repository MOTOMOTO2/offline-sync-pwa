/** Shapes shared by the API, the cache and the outbox. */

export type ReportStatus = 'ok' | 'needs_work' | 'blocked';
export type SiteStatus = ReportStatus | 'unvisited';

export interface SiteSummary {
  id: string;
  name: string;
  address: string;
  region: string;
  asset_tag: string;
  status: SiteStatus;
  priority: number;
  last_report_at: string | null;
  updated_at: string;
  rev: number;
}

export interface Site extends SiteSummary {
  access_notes: string;
  contact_name: string;
  contact_phone: string;
  report_count: number;
}

export interface Report {
  id: string;
  site_id: string;
  status: ReportStatus;
  note: string;
  author: string;
  recorded_at: string;
  received_at: string;
}

export interface SiteListResponse {
  server_time: string;
  count: number;
  items: SiteSummary[];
}

export interface SiteDetailResponse {
  server_time: string;
  site: Site;
  reports: Report[];
}

/**
 * A write that has been captured on the device but not yet accepted by the
 * server. `id` is both the primary key here and the idempotency key the API
 * dedupes on, so a retry can never create a second report.
 */
export interface OutboxEntry {
  id: string;
  siteId: string;
  /** Denormalised so the outbox screen reads properly with no network. */
  siteName: string;
  status: ReportStatus;
  note: string;
  author: string;
  /** Device clock at the moment of capture, not at the moment of sending. */
  recordedAt: string;
  createdAt: number;
  state: 'pending' | 'failed';
  attempts: number;
  /** Epoch ms before which a retry should not be attempted (backoff). */
  nextAttemptAt: number;
  /** Set while a tab or the service worker is mid-send, to avoid double posts. */
  leaseUntil: number;
  lastError: string | null;
}

/** What the cache holds for a single site's detail screen. */
export interface CachedDetail {
  id: string;
  site: Site;
  reports: Report[];
  cachedAt: number;
  etag: string | null;
}

export interface CachedList {
  items: SiteSummary[];
  cachedAt: number;
  etag: string | null;
}
