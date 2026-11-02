"""The three endpoints the phone talks to: list, detail, and one write action."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from . import __version__
from .config import Settings, get_settings
from .db import Database, utcnow
from .schemas import (
    HealthResponse,
    Report,
    ReportCreate,
    ReportCreateResponse,
    Site,
    SiteDetailResponse,
    SiteListResponse,
    SiteSummary,
)

router = APIRouter(prefix="/api/v1", tags=["field-reports"])

# A device clock this far ahead of the server is not trusted.
CLOCK_SKEW_TOLERANCE = timedelta(minutes=10)


def get_db(request: Request) -> Database:
    return request.app.state.db


def _slow_down(settings: Settings) -> None:
    """Optional artificial latency, so the syncing state is visible locally."""
    if settings.demo_latency_ms > 0:
        time.sleep(min(settings.demo_latency_ms, 5000) / 1000)


def _etag(payload: object) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return '"' + hashlib.sha256(blob).hexdigest()[:24] + '"'


def _not_modified(request: Request, etag: str) -> bool:
    header = request.headers.get("if-none-match", "")
    return any(candidate.strip() in {etag, "*"} for candidate in header.split(","))


def _parse_iso(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_recorded_at(value: str | None) -> str:
    """Trust the device clock only within reason.

    A queued write may legitimately be hours old, which is the whole point, but
    it must not claim to be from next year.
    """
    now = datetime.now(timezone.utc)
    parsed = _parse_iso(value) if value else None
    if parsed is None or parsed > now + CLOCK_SKEW_TOLERANCE:
        return utcnow()
    return parsed.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _site_row_to_model(row: sqlite3.Row, report_count: int) -> Site:
    return Site(**{**dict(row), "report_count": report_count})


def _load_site(db: Database, site_id: str) -> sqlite3.Row:
    row = db.query_one("SELECT * FROM sites WHERE id = ?", (site_id,))
    if row is None:
        raise HTTPException(status_code=404, detail="No site with id " + repr(site_id))
    return row


def _load_reports(db: Database, site_id: str, limit: int = 50) -> list[Report]:
    rows = db.query(
        """SELECT * FROM reports WHERE site_id = ?
           ORDER BY recorded_at DESC, received_at DESC LIMIT ?""",
        (site_id, limit),
    )
    return [Report(**dict(row)) for row in rows]


def _detail_payload(db: Database, site_id: str) -> SiteDetailResponse:
    row = _load_site(db, site_id)
    reports = _load_reports(db, site_id)
    return SiteDetailResponse(site=_site_row_to_model(row, len(reports)), reports=reports)


@router.get("/health", response_model=HealthResponse)
def health(db: Database = Depends(get_db)) -> HealthResponse:
    sites = db.query_one("SELECT COUNT(*) AS n FROM sites")
    reports = db.query_one("SELECT COUNT(*) AS n FROM reports")
    return HealthResponse(
        version=__version__,
        sites=sites["n"] if sites else 0,
        reports=reports["n"] if reports else 0,
    )


@router.get("/sites", response_model=SiteListResponse)
def list_sites(
    request: Request,
    response: Response,
    region: str | None = None,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """List: the first screen. Small enough to cache whole on the device."""
    _slow_down(settings)
    if region:
        rows = db.query(
            "SELECT * FROM sites WHERE region = ? ORDER BY priority ASC, name ASC", (region,)
        )
    else:
        rows = db.query("SELECT * FROM sites ORDER BY priority ASC, name ASC")

    items = [SiteSummary(**dict(row)) for row in rows]
    etag = _etag([item.model_dump() for item in items])
    if _not_modified(request, etag):
        # Nothing changed, so the phone keeps the copy it already has.
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    return SiteListResponse(count=len(items), items=items)


@router.get("/sites/{site_id}", response_model=SiteDetailResponse)
def get_site(
    site_id: str,
    request: Request,
    response: Response,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """Detail: everything a tech needs on site, including when there is no signal."""
    _slow_down(settings)
    payload = _detail_payload(db, site_id)
    etag = _etag(
        {"site": payload.site.model_dump(), "reports": [r.model_dump() for r in payload.reports]}
    )
    if _not_modified(request, etag):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    return payload


@router.post(
    "/sites/{site_id}/reports",
    response_model=ReportCreateResponse,
    status_code=201,
    responses={200: {"description": "Already accepted; this was a retry of a queued write."}},
)
def create_report(
    site_id: str,
    body: ReportCreate,
    response: Response,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ReportCreateResponse:
    """The write action: file a report against a site.

    Idempotent on the client-supplied report id. A phone that queued this
    report while offline can retry as often as it likes, including from two
    tabs at once, and the server still holds exactly one report.
    """
    _slow_down(settings)
    _load_site(db, site_id)

    existing = db.query_one("SELECT * FROM reports WHERE id = ?", (body.id,))
    if existing is not None:
        if existing["site_id"] != site_id:
            raise HTTPException(
                status_code=409,
                detail="Report id " + repr(body.id) + " already exists against a different site",
            )
        response.status_code = 200
        return ReportCreateResponse(
            duplicate=True,
            report=Report(**dict(existing)),
            site=_detail_payload(db, site_id).site,
        )

    recorded_at = _normalize_recorded_at(body.recorded_at)
    received_at = utcnow()

    with db.write() as conn:
        try:
            conn.execute(
                """INSERT INTO reports (id, site_id, status, note, author, recorded_at, received_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (body.id, site_id, body.status.value, body.note,
                 body.author or "Field tech", recorded_at, received_at),
            )
        except sqlite3.IntegrityError:
            # Lost a race with a concurrent retry of the same queued write.
            row = conn.execute("SELECT * FROM reports WHERE id = ?", (body.id,)).fetchone()
            if row is None:
                raise
            response.status_code = 200
            return ReportCreateResponse(
                duplicate=True,
                report=Report(**dict(row)),
                site=_detail_payload(db, site_id).site,
            )

        # Derive the site status from its newest report rather than from
        # whichever write landed last: a report queued this morning must not
        # overwrite state that was observed this afternoon.
        newest = conn.execute(
            """SELECT status, recorded_at FROM reports WHERE site_id = ?
               ORDER BY recorded_at DESC, received_at DESC LIMIT 1""",
            (site_id,),
        ).fetchone()
        conn.execute(
            """UPDATE sites SET status = ?, last_report_at = ?, updated_at = ?, rev = rev + 1
               WHERE id = ?""",
            (newest["status"], newest["recorded_at"], utcnow(), site_id),
        )

    created = db.query_one("SELECT * FROM reports WHERE id = ?", (body.id,))
    assert created is not None
    return ReportCreateResponse(
        duplicate=False,
        report=Report(**dict(created)),
        site=_detail_payload(db, site_id).site,
    )
