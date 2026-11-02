import { useEffect, useState } from 'react';

import { idbGet, idbPut, STORE } from '../lib/idb';
import { META } from '../lib/cache';
import { CloseIcon, DownloadIcon } from './Icons';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Offer to install, but only where the browser says it is possible, and only
 * once: a dismissed prompt stays dismissed.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    void idbGet<boolean>(STORE.meta, META.installPromptDismissed).then((value) =>
      setDismissed(Boolean(value)),
    );

    const onPrompt = (event: Event) => {
      // Keep the event so the install can happen on a real user gesture later.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred || dismissed) return null;

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  async function dismiss() {
    setDismissed(true);
    await idbPut(STORE.meta, true, META.installPromptDismissed);
  }

  return (
    <div className="install-card">
      <DownloadIcon />
      <div className="install-card__text">
        <strong>Install Field Reports</strong>
        <span className="muted">Add it to the home screen so it opens with no signal.</span>
      </div>
      <button type="button" className="button button--small" onClick={() => void install()}>
        Install
      </button>
      <button type="button" className="icon-button" onClick={() => void dismiss()} aria-label="Not now">
        <CloseIcon size={20} />
      </button>
    </div>
  );
}
