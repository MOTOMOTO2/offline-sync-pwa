"""App factory: the API plus the static hosting for the installed PWA.

One process serves both, which keeps the phone on a single origin and means the
service worker can cache API responses without any CORS setup.
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import router as api_router
from .config import Settings, get_settings
from .db import Database
from .seed import seed_if_empty

# index.html and the service worker must never be held in a stale cache, or a
# deploy cannot reach a device that has already installed the app.
NO_STORE = "no-cache, no-store, must-revalidate"
IMMUTABLE = "public, max-age=31536000, immutable"

PLACEHOLDER_PAGE = """<!doctype html>
<meta charset="utf-8"><title>Field Reports API</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;
color:#e8eaf0;background:#11131a}code{background:#1e2230;padding:.15em .4em;border-radius:4px}
a{color:#7aa2ff}</style>
<h1>Field Reports API is running</h1>
<p>The web app has not been built into this checkout yet, so there is nothing to
serve at this path.</p>
<p>Build it with <code>npm --prefix web ci &amp;&amp; npm --prefix web run build</code>,
or run the Vite dev server on port 5173 while this API stays on port 8000.</p>
<p>The API itself is live: <a href="/api/v1/health">/api/v1/health</a> ·
<a href="/api/v1/sites">/api/v1/sites</a> · <a href="/docs">/docs</a></p>
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    app.state.db = Database(settings.db_path)
    if settings.seed_on_start:
        seed_if_empty(app.state.db)
    try:
        yield
    finally:
        app.state.db.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="Field Reports API",
        version=__version__,
        summary="List, detail and one idempotent write action for an offline-first phone client.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.dependency_overrides[get_settings] = lambda: settings

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Content-Type", "If-None-Match"],
            expose_headers=["ETag"],
        )

    app.include_router(api_router)
    _mount_web(app, settings)
    return app


def _mount_web(app: FastAPI, settings: Settings) -> None:
    dist = Path(settings.web_dist)

    for sub in ("assets", "icons"):
        directory = dist / sub
        if directory.is_dir():
            app.mount(
                "/" + sub,
                StaticFiles(directory=str(directory)),
                name=sub,
            )

    @app.middleware("http")
    async def _static_cache_headers(request: Request, call_next):
        """StaticFiles sets no Cache-Control of its own, so add it here.

        Vite hashes everything under /assets, so those files can be held
        forever; the icons are stable but unhashed, so give them a day.
        """
        response = await call_next(request)
        path = request.url.path
        if response.status_code in {200, 206, 304}:
            if path.startswith("/assets/"):
                response.headers["Cache-Control"] = IMMUTABLE
            elif path.startswith("/icons/"):
                response.headers["Cache-Control"] = "public, max-age=86400"
        return response

    @app.get("/runtime-config.js", include_in_schema=False)
    def runtime_config() -> Response:
        """Which API the installed app talks to, decided at boot, not at build.

        Empty apiBase means this same origin. Point it elsewhere with
        `fly secrets set API_BASE=https://api.example.com` and already-installed
        phones pick it up on their next load, with no rebuild.
        """
        payload = {
            "apiBase": settings.api_base,
            "appLabel": settings.app_label,
            "version": __version__,
        }
        body = "window.__APP_CONFIG__=" + json.dumps(payload) + ";"
        return Response(
            content=body,
            media_type="application/javascript",
            headers={"Cache-Control": NO_STORE},
        )

    @app.get("/sw.js", include_in_schema=False)
    def service_worker() -> Response:
        path = dist / "sw.js"
        if not path.is_file():
            return PlainTextResponse("// not built", status_code=404)
        return FileResponse(
            path,
            media_type="application/javascript",
            headers={
                "Cache-Control": NO_STORE,
                # Lets a worker served from here control the whole origin.
                "Service-Worker-Allowed": "/",
            },
        )

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest() -> Response:
        path = dist / "manifest.webmanifest"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="not built")
        return FileResponse(
            path,
            media_type="application/manifest+json",
            headers={"Cache-Control": "public, max-age=3600"},
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str, request: Request) -> Response:
        """Serve index.html for app routes so a deep link survives a cold start."""
        if full_path.startswith(("api/", "docs", "openapi.json", "redoc")):
            raise HTTPException(status_code=404, detail="Not found")

        # A real file (favicon, robots.txt, anything dropped in public/) wins.
        candidate = (dist / full_path).resolve() if full_path else None
        if (
            candidate is not None
            and candidate.is_file()
            and candidate.is_relative_to(dist.resolve())
        ):
            cache = IMMUTABLE if "/assets/" in request.url.path else "public, max-age=3600"
            return FileResponse(candidate, headers={"Cache-Control": cache})

        index = dist / "index.html"
        if not index.is_file():
            return HTMLResponse(PLACEHOLDER_PAGE, status_code=200)
        return FileResponse(
            index, media_type="text/html", headers={"Cache-Control": NO_STORE}
        )


app = create_app()


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
