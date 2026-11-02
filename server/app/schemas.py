"""Request and response models. These double as the published API contract."""

from __future__ import annotations

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field, field_validator

from .db import utcnow


class ReportStatus(str, Enum):
    ok = "ok"
    needs_work = "needs_work"
    blocked = "blocked"


class SiteStatus(str, Enum):
    ok = "ok"
    needs_work = "needs_work"
    blocked = "blocked"
    unvisited = "unvisited"


class SiteSummary(BaseModel):
    id: str
    name: str
    address: str
    region: str
    asset_tag: str
    status: SiteStatus
    priority: int
    last_report_at: str | None = None
    updated_at: str
    rev: int


class Site(SiteSummary):
    access_notes: str = ""
    contact_name: str = ""
    contact_phone: str = ""
    report_count: int = 0


class Report(BaseModel):
    id: str
    site_id: str
    status: ReportStatus
    note: str = ""
    author: str = ""
    recorded_at: str
    received_at: str


class SiteListResponse(BaseModel):
    server_time: str = Field(default_factory=utcnow)
    count: int
    items: list[SiteSummary]


class SiteDetailResponse(BaseModel):
    server_time: str = Field(default_factory=utcnow)
    site: Site
    reports: list[Report]


class ReportCreate(BaseModel):
    """The one write action.

    `id` is supplied by the client and is the idempotency key: a phone that
    queues a report offline and retries it three times on a flaky connection
    must not create three reports.
    """

    id: Annotated[str, Field(min_length=8, max_length=64)]
    status: ReportStatus
    note: Annotated[str, Field(max_length=2000)] = ""
    author: Annotated[str, Field(max_length=120)] = ""
    recorded_at: str | None = None

    @field_validator("id")
    @classmethod
    def _id_is_url_safe(cls, value: str) -> str:
        if not all(c.isalnum() or c in "-_" for c in value):
            raise ValueError("id must contain only letters, digits, '-' or '_'")
        return value

    @field_validator("note", "author")
    @classmethod
    def _trim(cls, value: str) -> str:
        return value.strip()


class ReportCreateResponse(BaseModel):
    server_time: str = Field(default_factory=utcnow)
    # True when this exact report id had already been accepted: the client's
    # retry was a duplicate, not a new observation.
    duplicate: bool = False
    report: Report
    site: Site


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    server_time: str = Field(default_factory=utcnow)
    sites: int
    reports: int
