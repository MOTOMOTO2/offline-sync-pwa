import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { BottomNav } from './components/BottomNav';
import { SyncStatusBar } from './components/SyncStatusBar';
import { startSync } from './lib/sync';
import { DetailView } from './routes/DetailView';
import { ListView } from './routes/ListView';
import { OutboxView } from './routes/OutboxView';

export function App() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    void startSync().then((teardown) => {
      stop = teardown;
    });
    return () => stop?.();
  }, []);

  return (
    <BrowserRouter>
      <div className="app">
        <SyncStatusBar />
        <main className="app__body">
          <Routes>
            <Route path="/" element={<ListView />} />
            <Route path="/sites/:siteId" element={<DetailView />} />
            <Route path="/outbox" element={<OutboxView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
    </BrowserRouter>
  );
}
