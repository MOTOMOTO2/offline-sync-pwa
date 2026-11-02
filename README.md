# Field Reports — an offline-first phone front end

An installable PWA for a field-service API: a **list** of sites, a **detail**
screen for each one, and **one write action** (file a report). Reading works
with no signal, writing works with no signal, and the app is always explicit
about which of those is currently happening.

Live: <https://offline-sync-pwa.fly.dev/>

```
┌─ React PWA (web/) ─────────────┐        ┌─ FastAPI (server/) ───────────┐
│ screens read from IndexedDB    │        │ GET  /api/v1/sites            │
│ writes go to a durable outbox  │ ◄────► │ GET  /api/v1/sites/{id}       │
│ service worker precaches shell │        │ POST /api/v1/sites/{id}/reports│
│ + caches API reads             │        │ (idempotent on report id)     │
└────────────────────────────────┘        └───────────────────────────────┘
```

## The short version of how it works

**Reads are cached, and the app says how old they are.** Every list and detail
response is written to IndexedDB with its ETag. Screens render from that cache
first and never block on the network. The next sync sends `If-None-Match`, so
an unchanged list costs a 304 and no body. The status bar says *"synced 2 min
ago"* or *"saved copy from 3 h ago"* — it only claims to be up to date when a
live read actually succeeded.

**Writes are queued, durably, before anything is sent.** Tapping *Save* writes
the report to an IndexedDB outbox and returns. It is already safe at that point
— the app can be killed, the phone can die, the tunnel can swallow the signal.
Sending is a separate concern that happens whenever it can: immediately, on the
`online` event, when the app is brought back to the foreground, on a 20-second
retry tick while anything is queued, and through Background Sync (where the
browser supports it) even if the app is closed.

**Retries cannot create duplicates.** The client generates the report id and
the server treats it as an idempotency key: a replay returns `200` with
`duplicate: true` instead of creating a second report. Outbox entries are also
leased before sending, so two tabs — or a tab and the service worker — racing
the same entry will only post it once.

**A late write cannot clobber newer state.** A report captured at 09:00 and
synced at 17:00 is stored with its original `recorded_at`. The server recomputes
a site's status from its *newest* report, not from whichever write landed last.

**Failures are visible and actionable.** A `4xx` parks the entry as *rejected*
and stops retrying, because retrying will not help; a `5xx` backs off
exponentially with jitter and gives up after 8 tries; a dead network stops the
drain entirely rather than burning the queue. The Outbox screen shows each
waiting report, why it is waiting, and offers Retry or Discard.

**Thumb reach.** Navigation, sync, filtering and every primary action sit in
the bottom third of the screen at ≥48px, inside `env(safe-area-inset-bottom)`.
The write action is a bottom sheet. The only thing up top is the status strip,
which is information, not a control (though tapping it still works).

## Running it

Requires Node 20+ and Python 3.11+.

```bash
# 1. Backend
python -m venv .venv
.venv/Scripts/python -m pip install -r server/requirements-dev.txt   # Windows
# source .venv/bin/activate && pip install -r server/requirements-dev.txt

# 2. Frontend
npm --prefix web ci
```

### Everything from one process (what production does)

```bash
npm --prefix web run build
cd server && python -m app.main          # http://127.0.0.1:8080
```

The Python app serves the built PWA and the API from the same origin, so there
is no CORS to configure and the service worker can cache API responses.

> The service worker is only active in a build, not in the Vite dev server, so
> this is the mode to use when testing offline behaviour. In DevTools:
> Application → Service Workers, then Network → Offline. Reading keeps working;
> filing a report lands in the outbox and sends itself when you go back online.

### Dev servers (hot reload)

```bash
cd server && python -m uvicorn app.main:app --reload --port 8000
npm --prefix web run dev                 # http://127.0.0.1:5173, proxies /api to :8000
```

### Tests

```bash
.venv/Scripts/python -m pytest server/tests -c server/pytest.ini   # 35 tests
npm --prefix web test                                              # 65 tests
npm --prefix web run typecheck
```

The backend suite covers the API contract (idempotent replays, late-arriving
writes, clock skew, ETags) and the static hosting. One test reads the precache
list back out of the built `sw.js` and asserts the server can actually serve
every URL in it — if that drifts, the install fails and the app silently stops
being offline-capable. The frontend suite covers the outbox state machine
(including two senders racing one entry), the sync engine, the cache, the
status wording, and the screens rendering with `fetch` hard-failing.

### Regenerating the icons

```bash
python web/scripts/make_icons.py
```

Pure standard library — a small PNG writer and some signed-distance-field
shapes, so there is no image toolchain to install.

## Pointing it at your own API

The bundled FastAPI service is a working reference implementation of the
contract, so the app runs standalone. To point it at the API you already run:

```bash
fly secrets set API_BASE=https://api.example.com
```

`/runtime-config.js` is generated by the server at request time, so already
installed phones pick this up on their next load with **no rebuild**. Your API
then needs to allow the PWA's origin via CORS (`Access-Control-Allow-Origin`,
and expose `ETag`).

The contract is three endpoints:

| | |
|---|---|
| `GET /api/v1/sites` | `{ server_time, count, items: [SiteSummary] }`, `ETag`, honours `If-None-Match` |
| `GET /api/v1/sites/{id}` | `{ server_time, site: Site, reports: [Report] }`, same ETag behaviour |
| `POST /api/v1/sites/{id}/reports` | body `{ id, status, note, author, recorded_at }` → `201`, or `200` with `duplicate: true` if `id` was already accepted |

`status` is one of `ok`, `needs_work`, `blocked`. `id` is client-generated and
is the idempotency key; the app also sends it as an `Idempotency-Key` header.
`4xx` is treated as permanent, `5xx`/`408`/`429` as retryable. Full schema at
`/docs` on a running instance.

If your shapes differ, the mapping lives in two small files: `web/src/lib/api.ts`
(reads) and the `flushOutbox` function in `web/src/lib/outbox.ts` (the write).

## Deploying

A Fly deploy needs no secrets at all — the app boots, seeds a demo dataset and
serves. The host deploys this repo; `fly.toml` and the `Dockerfile` are set up
for `internal_port = 8080`, with the server reading `PORT` from the environment
and binding `0.0.0.0`.

Everything below is optional:

| Variable | Default | What it does |
|---|---|---|
| `API_BASE` | *(same origin)* | Point the installed app at a different API |
| `DB_PATH` | `/data/field-reports.db` | SQLite location |
| `CORS_ORIGINS` | *(off)* | Comma-separated origins allowed to call the API |
| `SEED_ON_START` | `true` | Seed demo sites when the database is empty |
| `DEMO_LATENCY_MS` | `0` | Artificial API latency, to watch the syncing state |
| `APP_LABEL` | `Field Reports` | Name shown in the runtime config |

```bash
fly secrets set API_BASE=https://api.example.com CORS_ORIGINS=https://offline-sync-pwa.fly.dev
```

**Data persistence.** Without a volume, `/data` is container-local, so SQLite
resets when the machine restarts (and `auto_stop_machines` means it will). That
is fine for a demo of the client. For durable storage:

```bash
fly volumes create data --size 1 --region yyz
# then add to fly.toml:
#   [[mounts]]
#     source = "data"
#     destination = "/data"
```

## Layout

```
server/app/      api.py (3 endpoints) · main.py (app + static hosting) · db.py · seed.py
server/tests/    35 tests: API contract, hosting headers, built-app integration
web/src/lib/     outbox.ts · sync.ts · cache.ts · idb.ts · api.ts · status.ts
web/src/sw.ts    service worker: precache, runtime caching, Background Sync
web/src/routes/  ListView · DetailView · OutboxView
web/tests/       65 tests: outbox, sync engine, cache, status wording, screens
```

`web/src/lib/outbox.ts` is imported by both the app and the service worker, so
there is exactly one definition of what a queued write is and how it is sent.
The service worker is built in a second Vite pass (`vite.sw.config.ts`) that
reads the real hashed filenames out of `dist/` and bakes them into its precache
list — that is what makes a cold launch with no signal work.

## Notes and assumptions

- **The API is bundled rather than assumed.** The brief described an API you
  already run; since it was not reachable from here, the repo ships a FastAPI
  implementation of the contract above so the whole thing is runnable and
  testable end to end. Swap it out with `API_BASE`.
- **The domain is field-service site inspections** — a case where "no signal"
  is the normal condition rather than an edge case. Nothing about the offline
  machinery depends on that choice.
- **Background Sync is Chromium-only.** Everywhere else the in-app retry loop,
  the `online` event and the foreground check do the same job while the app is
  open; nothing is lost either way, it just waits for the app to be opened.
- **The Docker image was not built here** — the Docker daemon was not running
  on the build machine. Both steps it runs (`npm ci`, `npm run build`) were
  verified directly from a clean `node_modules`, and the server was smoke
  tested over real HTTP through the same `python -m app.main` entrypoint the
  image uses.
- **No auth.** The API is open, which matches a public demo. If you add a
  token, put it behind the same runtime-config mechanism rather than baking it
  into the bundle.
