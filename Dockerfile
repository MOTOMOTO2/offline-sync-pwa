# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- web build --
# Builds the PWA twice: once for the app bundle, once for the service worker,
# which needs the first build's hashed filenames to write its precache list.
FROM node:24-alpine AS web

WORKDIR /build

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ------------------------------------------------------------------ runtime --
FROM python:3.13-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    WEB_DIST=/app/web \
    DB_PATH=/data/field-reports.db

WORKDIR /app

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server/app ./app
COPY --from=web /build/dist ./web

# /data is container-local unless a Fly volume is mounted there; either way the
# API seeds itself on an empty database, so the app always boots with content.
RUN mkdir -p /data \
    && useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app /data
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT','8080') + '/api/v1/health').read()"

# app.main reads PORT from the environment and binds 0.0.0.0.
CMD ["python", "-m", "app.main"]
