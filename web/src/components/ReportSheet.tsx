import { useEffect, useState } from 'react';

import { getAuthor, setAuthor } from '../lib/cache';
import { statusLabel } from '../lib/format';
import { queueReport } from '../lib/sync';
import type { ReportStatus } from '../lib/types';
import { CloseIcon } from './Icons';

const CHOICES: ReportStatus[] = ['ok', 'needs_work', 'blocked'];

interface Props {
  siteId: string;
  siteName: string;
  online: boolean;
  onClose: () => void;
  onFiled: (message: string) => void;
}

/**
 * The write action, as a bottom sheet.
 *
 * Everything sits in the lower half of the screen so it can be completed
 * one-handed, and the primary button says what will actually happen: saved
 * now either way, sent now or later depending on the network.
 */
export function ReportSheet({ siteId, siteName, online, onClose, onFiled }: Props) {
  const [status, setStatus] = useState<ReportStatus>('ok');
  const [note, setNote] = useState('');
  const [author, setAuthorValue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getAuthor().then(setAuthorValue);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('is-locked');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('is-locked');
    };
  }, [onClose]);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const trimmed = author.trim();
    if (trimmed) await setAuthor(trimmed);
    // Stamped with the device clock now, not with whenever it manages to send.
    await queueReport({
      siteId,
      siteName,
      status,
      note,
      author: trimmed || 'Field tech',
      recordedAt: new Date().toISOString(),
    });
    onFiled(online ? 'Report filed and sending.' : 'Report saved. It will send when you have signal.');
    onClose();
  }

  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={`File a report for ${siteName}`}>
      <button type="button" className="sheet-scrim" onClick={onClose} aria-label="Close" />
      <div className="sheet">
        <div className="sheet__grip" aria-hidden="true" />
        <div className="sheet__head">
          <div>
            <h2>File report</h2>
            <p className="muted">{siteName}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <fieldset className="segmented">
          <legend className="label">What did you find?</legend>
          <div className="segmented__row">
            {CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className="segmented__option"
                data-status={choice}
                aria-pressed={status === choice}
                onClick={() => setStatus(choice)}
              >
                {statusLabel(choice)}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="label" htmlFor="note">
          Notes
        </label>
        <textarea
          id="note"
          className="input"
          rows={3}
          maxLength={2000}
          placeholder="What you saw, what you did, what is still outstanding."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />

        <label className="label" htmlFor="author">
          Your name
        </label>
        <input
          id="author"
          className="input"
          type="text"
          autoComplete="name"
          maxLength={120}
          placeholder="Remembered for next time"
          value={author}
          onChange={(event) => setAuthorValue(event.target.value)}
        />

        <button type="button" className="button button--primary button--block" onClick={() => void submit()} disabled={saving}>
          {saving ? 'Saving…' : online ? 'Save and send' : 'Save to outbox'}
        </button>
        <p className="sheet__foot muted">
          {online
            ? 'Saved on this phone first, then sent. Nothing is lost if the signal drops mid-send.'
            : 'No signal. This is stored on the phone and sent automatically once you are back in range.'}
        </p>
      </div>
    </div>
  );
}
