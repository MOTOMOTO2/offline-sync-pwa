/**
 * Service worker registration.
 *
 * Kept out of App.tsx because it is a page-level concern, and because a dev
 * server has no worker to register: Vite serves /sw.js only after a build.
 */

const SW_URL = '/sw.js';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // The dev server does not build the worker, and registering a 404 is noise.
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    // A first install also fires controllerchange, via the worker's
    // clients.claim(). Only an *update* should reload the page.
    const hadController = Boolean(navigator.serviceWorker.controller);

    void navigator.serviceWorker
      .register(SW_URL, { scope: '/' })
      .then((registration) => {
        // A new build is waiting: take it now rather than on some later visit.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              installing.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
        void registration.update();
      })
      .catch((error: unknown) => {
        console.warn('Service worker registration failed; the app still runs online.', error);
      });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // One reload, so the page and its worker are from the same build.
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    });
  });
}
