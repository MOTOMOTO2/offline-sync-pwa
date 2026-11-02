"""API behaviour, with a bias toward the parts an offline client depends on."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient


def _iso(moment: datetime) -> str:
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _report_body(**overrides) -> dict:
    body = {
        "id": "rep-" + uuid.uuid4().hex,
        "status": "ok",
        "note": "Checked the panel, all nominal.",
        "author": "A. Tester",
        "recorded_at": _iso(datetime.now(timezone.utc)),
    }
    body.update(overrides)
    return body


def test_health_reports_seeded_counts(client: TestClient) -> None:
    body = client.get("/api/v1/health").json()
    assert body["status"] == "ok"
    assert body["sites"] > 0
    assert body["reports"] > 0


def test_list_returns_sites_ordered_by_priority(client: TestClient) -> None:
    response = client.get("/api/v1/sites")
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == len(body["items"]) > 0
    priorities = [item["priority"] for item in body["items"]]
    assert priorities == sorted(priorities)
    first = body["items"][0]
    assert {"id", "name", "address", "status", "asset_tag", "updated_at"} <= first.keys()


def test_list_can_filter_by_region(client: TestClient) -> None:
    body = client.get("/api/v1/sites", params={"region": "Toronto West"}).json()
    assert body["count"] > 0
    assert {item["region"] for item in body["items"]} == {"Toronto West"}


def test_list_etag_allows_a_cheap_revalidation(client: TestClient) -> None:
    first = client.get("/api/v1/sites")
    etag = first.headers["etag"]
    again = client.get("/api/v1/sites", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["etag"] == etag


def test_list_etag_changes_after_a_write(client: TestClient) -> None:
    etag = client.get("/api/v1/sites").headers["etag"]
    client.post("/api/v1/sites/site-1042/reports", json=_report_body(status="blocked"))
    assert client.get("/api/v1/sites", headers={"If-None-Match": etag}).status_code == 200


def test_detail_includes_reports_newest_first(client: TestClient) -> None:
    body = client.get("/api/v1/sites/site-1041").json()
    assert body["site"]["id"] == "site-1041"
    assert body["site"]["access_notes"]
    assert body["site"]["report_count"] == len(body["reports"]) >= 2
    recorded = [report["recorded_at"] for report in body["reports"]]
    assert recorded == sorted(recorded, reverse=True)


def test_detail_404_for_unknown_site(client: TestClient) -> None:
    response = client.get("/api/v1/sites/site-does-not-exist")
    assert response.status_code == 404
    assert "detail" in response.json()


def test_write_creates_a_report_and_moves_the_site_status(client: TestClient) -> None:
    body = _report_body(status="blocked", note="Access road washed out.")
    before = client.get("/api/v1/sites/site-1042").json()["site"]

    response = client.post("/api/v1/sites/site-1042/reports", json=body)
    assert response.status_code == 201
    payload = response.json()
    assert payload["duplicate"] is False
    assert payload["report"]["id"] == body["id"]
    assert payload["report"]["note"] == body["note"]
    assert payload["report"]["received_at"]
    assert payload["site"]["status"] == "blocked"
    assert payload["site"]["rev"] == before["rev"] + 1

    detail = client.get("/api/v1/sites/site-1042").json()
    assert detail["reports"][0]["id"] == body["id"]


def test_write_is_idempotent_on_the_client_supplied_id(client: TestClient) -> None:
    """The whole point: a queued write retried three times stores one report."""
    body = _report_body(status="needs_work")
    first = client.post("/api/v1/sites/site-1044/reports", json=body)
    assert first.status_code == 201

    for _ in range(3):
        retry = client.post("/api/v1/sites/site-1044/reports", json=body)
        assert retry.status_code == 200
        assert retry.json()["duplicate"] is True
        assert retry.json()["report"]["id"] == body["id"]

    reports = client.get("/api/v1/sites/site-1044").json()["reports"]
    assert [r["id"] for r in reports].count(body["id"]) == 1


def test_write_retry_keeps_the_originally_accepted_content(client: TestClient) -> None:
    body = _report_body(note="first wins")
    client.post("/api/v1/sites/site-1047/reports", json=body)
    retry = client.post("/api/v1/sites/site-1047/reports", json={**body, "note": "second"})
    assert retry.status_code == 200
    assert retry.json()["report"]["note"] == "first wins"


def test_write_rejects_a_reused_id_against_a_different_site(client: TestClient) -> None:
    body = _report_body()
    assert client.post("/api/v1/sites/site-1047/reports", json=body).status_code == 201
    conflict = client.post("/api/v1/sites/site-1048/reports", json=body)
    assert conflict.status_code == 409


def test_write_to_unknown_site_is_404(client: TestClient) -> None:
    response = client.post("/api/v1/sites/nope/reports", json=_report_body())
    assert response.status_code == 404


def test_a_late_queued_write_does_not_clobber_newer_state(client: TestClient) -> None:
    """A report written at 09:00 and synced at 17:00 must not undo the 16:00 one."""
    now = datetime.now(timezone.utc)
    client.post(
        "/api/v1/sites/site-1053/reports",
        json=_report_body(status="blocked", recorded_at=_iso(now - timedelta(hours=1))),
    )
    late = client.post(
        "/api/v1/sites/site-1053/reports",
        json=_report_body(status="ok", recorded_at=_iso(now - timedelta(hours=8))),
    )
    assert late.status_code == 201
    # Stored, and visible in the history, but not promoted to current status.
    assert late.json()["site"]["status"] == "blocked"
    notes = [r["id"] for r in client.get("/api/v1/sites/site-1053").json()["reports"]]
    assert late.json()["report"]["id"] in notes


def test_write_clamps_a_wildly_wrong_device_clock(client: TestClient) -> None:
    future = _iso(datetime.now(timezone.utc) + timedelta(days=365))
    response = client.post(
        "/api/v1/sites/site-1050/reports", json=_report_body(recorded_at=future)
    )
    assert response.status_code == 201
    assert response.json()["report"]["recorded_at"] < future


def test_write_accepts_a_missing_recorded_at(client: TestClient) -> None:
    body = _report_body()
    body.pop("recorded_at")
    response = client.post("/api/v1/sites/site-1050/reports", json=body)
    assert response.status_code == 201
    assert response.json()["report"]["recorded_at"]


def test_write_validates_status_and_id(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/sites/site-1050/reports", json=_report_body(status="on fire")
        ).status_code
        == 422
    )
    assert (
        client.post("/api/v1/sites/site-1050/reports", json=_report_body(id="x")).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/sites/site-1050/reports", json=_report_body(id="has spaces!")
        ).status_code
        == 422
    )


def test_write_trims_whitespace_from_the_note(client: TestClient) -> None:
    response = client.post(
        "/api/v1/sites/site-1050/reports", json=_report_body(note="  padded  ")
    )
    assert response.json()["report"]["note"] == "padded"
