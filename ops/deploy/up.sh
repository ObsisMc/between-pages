#!/usr/bin/env bash
# First start and every update (production-deployment D9). Run with sudo: only root reads
# /etc/between-pages. Migrations run before the new API starts; if they fail, it does not.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec docker compose --env-file "${BACKUP_ENV_FILE:-/etc/between-pages/backup.env}" \
  up -d --build --wait
