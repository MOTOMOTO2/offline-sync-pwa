/**
 * Runtime configuration, read from /runtime-config.js rather than baked into
 * the bundle, so the same build can be pointed at a different API without a
 * rebuild (and so an already-installed phone picks the change up on reload).
 */

export interface AppConfig {
  /** Empty means "this origin". */
  apiBase: string;
  appLabel: string;
  version: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: Partial<AppConfig>;
  }
}

const FALLBACK: AppConfig = { apiBase: '', appLabel: 'Field Reports', version: 'dev' };

export function appConfig(): AppConfig {
  const raw = typeof window === 'undefined' ? undefined : window.__APP_CONFIG__;
  return {
    apiBase: (raw?.apiBase ?? FALLBACK.apiBase).replace(/\/$/, ''),
    appLabel: raw?.appLabel || FALLBACK.appLabel,
    version: raw?.version || FALLBACK.version,
  };
}
