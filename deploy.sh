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

echo "[deploy] Building and (re)starting with docker compose..."
docker compose up -d --build --remove-orphans

echo "[deploy] Pruning old images..."
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy] Done. Current services:"
docker compose ps


