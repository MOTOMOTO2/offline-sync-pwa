"""How the server hosts the installed app: headers, SPA fallback, runtime config."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def built_dist(tmp_path: Path) -> Path:
    """A stand-in for a real `npm run build` output."""
    dist = tmp_path / "web-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "icons").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>app shell</title>", encoding="utf-8")
    (dist / "sw.js").write_text("self.addEventListener('install', () => {});", encoding="utf-8")
    (dist / "manifest.webmanifest").write_text(json.dumps({"name": "Field Reports"}), "utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "robots.txt").write_text("User-agent: *\n", encoding="utf-8")
    return dist


@pytest.fixture
def hosted(tmp_path: Path, built_dist: Path) -> TestClient:
    settings = Settings(db_path=str(tmp_path / "h.db"), web_dist=str(built_dist))
    with TestClient(create_app(settings)) as client:
        yield client


def test_root_serves_the_app_shell_uncached(hosted: TestClient) -> None:
    response = hosted.get("/")
    assert response.status_code == 200
    assert "app shell" in response.text
    assert "no-store" in response.headers["cache-control"]


def test_deep_link_falls_back_to_the_app_shell(hosted: TestClient) -> None:
    response = hosted.get("/sites/site-1041")
    assert response.status_code == 200
    assert "app shell" in response.text


def test_service_worker_is_served_from_the_root_scope(hosted: TestClient) -> None:
    response = hosted.get("/sw.js")
    assert response.status_code == 200
    assert response.headers["service-worker-allowed"] == "/"
    assert "no-store" in response.headers["cache-control"]
    assert "javascript" in response.headers["content-type"]


def test_hashed_assets_are_immutable(hosted: TestClient) -> None:
    response = hosted.get("/assets/index-abc123.js")
    assert response.status_code == 200
    assert "immutable" in response.headers["cache-control"]


def test_manifest_is_served_with_the_manifest_type(hosted: TestClient) -> None:
    response = hosted.get("/manifest.webmanifest")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/manifest+json")


def test_real_files_win_over_the_spa_fallback(hosted: TestClient) -> None:
    response = hosted.get("/robots.txt")
    assert response.status_code == 200
    assert response.text.startswith("User-agent")


def test_unknown_api_path_is_404_not_the_app_shell(hosted: TestClient) -> None:
    assert hosted.get("/api/v1/nothing-here").status_code == 404


def test_runtime_config_defaults_to_this_origin(hosted: TestClient) -> None:
    response = hosted.get("/runtime-config.js")
    assert response.status_code == 200
    assert "no-store" in response.headers["cache-control"]
    assert '"apiBase": ""' in response.text or '"apiBase":""' in response.text


def test_runtime_config_can_point_at_another_api(tmp_path: Path, built_dist: Path) -> None:
    settings = Settings(
        db_path=str(tmp_path / "r.db"),
        web_dist=str(built_dist),
        api_base="https://api.example.com/",
    )
    with TestClient(create_app(settings)) as client:
        body = client.get("/runtime-config.js").text
    # Trailing slash trimmed so the client can concatenate paths safely.
    assert "https://api.example.com/api" not in body
    assert "https://api.example.com" in body


def test_path_traversal_outside_the_dist_is_refused(hosted: TestClient) -> None:
    response = hosted.get("/../server/app/main.py")
    assert response.status_code in {200, 404}
    assert "create_app" not in response.text


def test_unbuilt_checkout_still_boots_and_explains_itself(tmp_path: Path) -> None:
    settings = Settings(db_path=str(tmp_path / "u.db"), web_dist=str(tmp_path / "missing"))
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/health").json()["status"] == "ok"
        root = client.get("/")
        assert root.status_code == 200
        assert "has not been built" in root.text
        assert client.get("/sw.js").status_code == 404


def test_cors_is_off_until_configured(tmp_path: Path, built_dist: Path) -> None:
    plain = Settings(db_path=str(tmp_path / "c1.db"), web_dist=str(built_dist))
    with TestClient(create_app(plain)) as client:
        response = client.get("/api/v1/sites", headers={"Origin": "https://elsewhere.test"})
        assert "access-control-allow-origin" not in response.headers

    allowed = Settings(
        db_path=str(tmp_path / "c2.db"),
        web_dist=str(built_dist),
        cors_origins=("https://elsewhere.test",),
    )
    with TestClient(create_app(allowed)) as client:
        response = client.get("/api/v1/sites", headers={"Origin": "https://elsewhere.test"})
        assert response.headers["access-control-allow-origin"] == "https://elsewhere.test"
