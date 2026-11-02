/**
 * Read calls against the API.
 *
 * Every call is conditional: the phone sends back the ETag it already has, so
 * an unchanged list costs a 304 and no body. Writes do not live here, they go
 * through the outbox (see outbox.ts) because they must survive being offline.
 */

import { appConfig } from './config';
import type { SiteDetailResponse, SiteListResponse } from './types';

/** Set by the service worker when it answered from its own cache. */
export const FROM_CACHE_HEADER = 'X-From-Cache';

export type ApiResult<T> =
  | { kind: 'ok'; data: T; etag: string | null; fromCache: boolean }
  | { kind: 'not-modified' }
  | { kind: 'error'; message: string; status: number | null; offline: boolean };

export function apiUrl(path: string): string {
  return appConfig().apiBase + path;
}

async function get<T>(
  path: string,
  etag: string | null,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'GET',
      headers: etag ? { 'If-None-Match': etag } : undefined,
      signal,
    });
  } catch (error) {
    // A rejected fetch is the network, not the server: treat it as offline.
    return {
      kind: 'error',
      message: error instanceof Error && error.name === 'AbortError' ? 'Cancelled' : 'No connection',
      status: null,
      offline: true,
    };
  }

  if (response.status === 304) return { kind: 'not-modified' };

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof body?.detail === 'string' ? body.detail : `Server returned ${response.status}`;
    return { kind: 'error', message: detail, status: response.status, offline: false };
  }

  return {
    kind: 'ok',
    data: (await response.json()) as T,
    etag: response.headers.get('ETag'),
    // The service worker replayed a stored response, so this is not live data.
    fromCache: response.headers.get(FROM_CACHE_HEADER) === '1',
  };
}

export function fetchSiteList(
  etag: string | null = null,
  signal?: AbortSignal,
): Promise<ApiResult<SiteListResponse>> {
  return get<SiteListResponse>('/api/v1/sites', etag, signal);
}

export function fetchSiteDetail(
  siteId: string,
  etag: string | null = null,
  signal?: AbortSignal,
): Promise<ApiResult<SiteDetailResponse>> {
  return get<SiteDetailResponse>(`/api/v1/sites/${encodeURIComponent(siteId)}`, etag, signal);
}
