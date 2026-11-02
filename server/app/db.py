"""SQLite access. Plain stdlib sqlite3 — the data model is three tables wide."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sites (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    address        TEXT NOT NULL,
    region         TEXT NOT NULL,
    asset_tag      TEXT NOT NULL,
    status         TEXT NOT NULL,
    priority       INTEGER NOT NULL,
    access_notes   TEXT NOT NULL DEFAULT '',
    contact_name   TEXT NOT NULL DEFAULT '',
    contact_phone  TEXT NOT NULL DEFAULT '',
    last_report_at TEXT,
    updated_at     TEXT NOT NULL,
    rev            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    author      TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_site ON reports(site_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(updated_at DESC);
"""


def utcnow() -> str:
    """ISO-8601 UTC with a trailing Z, which is what the client parses."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Database:
    def __init__(self, path: str) -> None:
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: FastAPI runs sync endpoints on a threadpool.
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """A write transaction. sqlite3's own locking serialises concurrent calls."""
        with self._conn:
            yield self._conn

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self._conn.execute(sql, params).fetchall()

    def query_one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        return self._conn.execute(sql, params).fetchone()

    def close(self) -> None:
        self._conn.close()
