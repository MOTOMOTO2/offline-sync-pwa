import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ArrowLeft, CheckIcon, ClockIcon, CloudOffIcon, PhoneIcon, PlusIcon } from '../components/Icons';
import { ReportSheet } from '../components/ReportSheet';
import { StatusPill } from '../components/StatusPill';
import { useSiteDetail, useSyncState, useTicker } from '../hooks/useAppData';
import { relativeTime, stamp, statusLabel } from '../lib/format';
import { syncNow } from '../lib/sync';
import { EmptyState } from './ListView';

export function DetailView() {
  const { siteId = '' } = useParams();
  const { detail, queued, loading } = useSiteDetail(siteId);
  const state = useSyncState();
  const now = useTicker();
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  if (loading) {
    return (
      <div className="screen">
        <div className="card card--skeleton">
          <div className="skeleton skeleton--md" />
          <div className="skeleton skeleton--lg" />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="screen">
        <EmptyState
          icon={<CloudOffIcon size={32} />}
          title="Not saved on this phone"
          body={
            state.online
              ? 'Fetching this site now.'
              : 'This site was never opened while online, so there is no saved copy to read.'
          }
          action={{ label: 'Try again', onClick: () => void syncNow({ manual: true }) }}
        />
        <div className="actionbar">
          <button type="button" className="button button--ghost" onClick={() => navigate('/')}>
            <ArrowLeft size={20} /> Sites
          </button>
        </div>
      </div>
    );
  }

  const { site, reports, cachedAt } = detail;
  // A queued report is already true on the ground, so show it as the status.
  const latestQueued = queued[queued.length - 1];

  return (
    <div className="screen screen--detail">
      <div className="screen__head">
        <div className="detail__pills">
          <StatusPill status={latestQueued ? latestQueued.status : site.status} />
          {latestQueued && (
            <span className="pill" data-tone="pending" data-size="sm">
              unsent
            </span>
          )}
          <span className="priority" data-level={site.priority}>
            P{site.priority}
          </span>
        </div>
        <h1>{site.name}</h1>
        <p className="muted">
          {site.asset_tag} · {site.region}
        </p>
      </div>

      <section className="panel">
        <h2 className="panel__title">Where</h2>
        <p className="panel__body">{site.address}</p>
        {site.contact_name && (
          <a className="rowlink" href={`tel:${site.contact_phone.replace(/[^+\d]/g, '')}`}>
            <PhoneIcon />
            <span>
              <strong>{site.contact_name}</strong>
              <span className="muted">{site.contact_phone}</span>
            </span>
          </a>
        )}
      </section>

      {site.access_notes && (
        <section className="panel">
          <h2 className="panel__title">Access</h2>
          <p className="panel__body">{site.access_notes}</p>
        </section>
      )}

      <section className="panel">
        <h2 className="panel__title">
          Reports
          <span className="muted"> · {reports.length + queued.length}</span>
        </h2>

        <ol className="timeline">
          {queued.map((entry) => (
            <li key={entry.id} className="timeline__item" data-pending="true">
              <div className="timeline__dot" data-tone={entry.state === 'failed' ? 'bad' : 'pending'} />
              <div className="timeline__body">
                <div className="timeline__top">
                  <strong>{statusLabel(entry.status)}</strong>
                  <span className="pill" data-tone={entry.state === 'failed' ? 'bad' : 'pending'} data-size="sm">
                    {entry.state === 'failed' ? 'rejected' : 'queued'}
                  </span>
                </div>
                {entry.note && <p className="timeline__note">{entry.note}</p>}
                <p className="muted timeline__meta">
                  <ClockIcon size={14} /> written {relativeTime(entry.recordedAt, now)} ·{' '}
                  {entry.state === 'failed' ? entry.lastError : 'waiting to send'}
                </p>
              </div>
            </li>
          ))}

          {reports.map((report) => (
            <li key={report.id} className="timeline__item">
              <div className="timeline__dot" data-tone={report.status === 'ok' ? 'ok' : report.status === 'blocked' ? 'bad' : 'warn'} />
              <div className="timeline__body">
                <div className="timeline__top">
                  <strong>{statusLabel(report.status)}</strong>
                  <span className="muted">{relativeTime(report.recorded_at, now)}</span>
                </div>
                {report.note && <p className="timeline__note">{report.note}</p>}
                <p className="muted timeline__meta">
                  <CheckIcon size={14} /> {report.author} · {stamp(report.recorded_at)}
                </p>
              </div>
            </li>
          ))}

          {reports.length === 0 && queued.length === 0 && (
            <li className="timeline__item">
              <div className="timeline__dot" data-tone="muted" />
              <div className="timeline__body muted">No reports filed yet.</div>
            </li>
          )}
        </ol>
      </section>

      <p className="screen__foot muted">
        Saved copy from {stamp(cachedAt)}
        {!state.online && ' · offline, showing what was last downloaded'}
      </p>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      <div className="actionbar">
        <button type="button" className="button button--ghost" onClick={() => navigate('/')} aria-label="Back to sites">
          <ArrowLeft size={20} />
        </button>
        <button type="button" className="button button--primary button--grow" onClick={() => setSheetOpen(true)}>
          <PlusIcon size={20} /> File report
        </button>
      </div>

      {sheetOpen && (
        <ReportSheet
          siteId={site.id}
          siteName={site.name}
          online={state.online}
          onClose={() => setSheetOpen(false)}
          onFiled={setToast}
        />
      )}
    </div>
  );
}
