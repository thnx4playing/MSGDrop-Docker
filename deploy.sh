#!/usr/bin/env bash
set -euo pipefail

# Deploy latest from GitHub and rebuild container

cd "$(dirname "$0")"

echo "[deploy] Force-syncing to origin/main..."
if [ -d .git ]; then
  git fetch --all --prune
  git reset --hard origin/main
  git clean -fd
else
  echo "[deploy] Not a git repo; skipping sync"
fi

COMPOSE_OVERRIDE="/srv/msgdrop-data/docker-compose.yml"
if [ -n "${COMPOSE_FILE:-}" ]; then
  USE_COMPOSE="$COMPOSE_FILE"
elif [ -f "$COMPOSE_OVERRIDE" ]; then
  USE_COMPOSE="$COMPOSE_OVERRIDE"
elif [ -f "docker-compose.yml" ]; then
  USE_COMPOSE="docker-compose.yml"
else
  echo "[deploy] ERROR: No docker-compose.yml found (looked for $COMPOSE_OVERRIDE or ./docker-compose.yml)" >&2
  exit 1
fi

echo "[deploy] Using compose file: $USE_COMPOSE"
echo "[deploy] Building and (re)starting with docker compose..."
docker compose -f "$USE_COMPOSE" up -d --build --remove-orphans

echo "[deploy] Pruning old images..."
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy] Done. Current services:"
docker compose -f "$USE_COMPOSE" ps


