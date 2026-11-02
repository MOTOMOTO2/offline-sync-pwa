"""Checks against the real `npm run build` output, when there is one.

The valuable one here is test_every_precached_url_is_actually_served: the
service worker promises to cache a specific list of files at install time, and
if the server cannot serve one of them the install fails and the app is not
offline-capable at all. That mismatch is invisible until you are in a basement
with no signal, so it is worth a test.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

pytestmark = pytest.mark.skipif(
    not (DIST / "index.html").is_file() or not (DIST / "sw.js").is_file(),
    reason="web/dist is not built; run `npm --prefix web run build` first",
)


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(db_path=str(tmp_path / "built.db"), web_dist=str(DIST))
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def precached_urls() -> list[str]:
    """Pull the two baked-in URL lists back out of the built worker."""
    source = (DIST / "sw.js").read_text(encoding="utf-8")
    urls: list[str] = []
    for match in re.finditer(r'\[(?:"/[^"\]]*",?)+\]', source):
        candidate = json.loads(match.group(0))
        if any(url.startswith("/") for url in candidate):
            urls.extend(candidate)
    return sorted(set(urls))


def test_the_worker_actually_has_a_precache_list() -> None:
    urls = precached_urls()
    assert "/index.html" in urls
    assert any(url.startswith("/assets/") and url.endswith(".js") for url in urls)
    assert any(url.startswith("/icons/") for url in urls)


def test_every_precached_url_is_actually_served(client: TestClient) -> None:
    missing = [url for url in precached_urls() if client.get(url).status_code != 200]
    assert missing == []


def test_the_shell_loads_the_bundle_and_the_runtime_config(client: TestClient) -> None:
    body = client.get("/").text
    assert '<script src="/runtime-config.js">' in body
    assert re.search(r'<script type="module"[^>]*src="/assets/index-[^"]+\.js"', body)
    assert 'rel="manifest"' in body


def test_the_manifest_is_installable(client: TestClient) -> None:
    manifest = client.get("/manifest.webmanifest").json()
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/"
    sizes = {icon["sizes"] for icon in manifest["icons"]}
    # Chrome wants both of these before it will offer to install.
    assert {"192x192", "512x512"} <= sizes
    assert any(icon.get("purpose") == "maskable" for icon in manifest["icons"])


def test_icons_are_real_pngs(client: TestClient) -> None:
    for icon in ("/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"):
        response = client.get(icon)
        assert response.status_code == 200
        assert response.content.startswith(b"\x89PNG\r\n\x1a\n")


def test_the_worker_is_served_so_it_can_control_the_whole_origin(client: TestClient) -> None:
    response = client.get("/sw.js")
    assert response.status_code == 200
    assert response.headers["service-worker-allowed"] == "/"
    assert "no-store" in response.headers["cache-control"]
    assert "flush-outbox" in response.text
