"""Runtime configuration, all of it optional.

The app is designed to boot with no environment set at all so it can be
deployed without secrets. Every switch below has a working default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _default_db_path() -> str:
    """Prefer a mounted volume at /data, else a writable temp location."""
    if Path("/data").is_dir():
        return "/data/field-reports.db"
    return str(REPO_ROOT / "server" / "var" / "field-reports.db")


def _default_web_dist() -> str:
    """Where the built PWA lives: /app/web in the image, web/dist locally."""
    for candidate in (Path("/app/web"), REPO_ROOT / "web" / "dist"):
        if (candidate / "index.html").is_file():
            return str(candidate)
    return str(REPO_ROOT / "web" / "dist")


@dataclass(frozen=True)
class Settings:
    port: int = field(default_factory=lambda: _env_int("PORT", 8080))
    db_path: str = field(default_factory=lambda: os.environ.get("DB_PATH") or _default_db_path())
    web_dist: str = field(default_factory=lambda: os.environ.get("WEB_DIST") or _default_web_dist())
    # Empty means "talk to this same origin" — the bundled demo API.
    api_base: str = field(default_factory=lambda: os.environ.get("API_BASE", "").rstrip("/"))
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()
        )
    )
    seed_on_start: bool = field(default_factory=lambda: _env_bool("SEED_ON_START", True))
    # Lets you watch the "syncing" state on a fast local network.
    demo_latency_ms: int = field(default_factory=lambda: _env_int("DEMO_LATENCY_MS", 0))

    @property
    def app_label(self) -> str:
        return os.environ.get("APP_LABEL", "Field Reports")


def get_settings() -> Settings:
    return Settings()
