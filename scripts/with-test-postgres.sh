#!/usr/bin/env bash
# Usage: scripts/with-test-postgres.sh <command...>
# Runs the command with TEST_DATABASE_URL pointing at a disposable PostgreSQL 18
# container that is removed afterwards. The password is test data, never a deployment value.
set -euo pipefail
cd "$(dirname "$0")/.."
container="between-pages-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --rm --name "$container" \
  -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB=between_pages_test \
  -p 127.0.0.1::5432 postgres:18-alpine >/dev/null
# Over TCP: the first-boot init server listens on a socket only.
for _ in {1..30}; do
  docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d between_pages_test >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d between_pages_test >/dev/null || { docker logs "$container"; exit 1; }
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
TEST_DATABASE_URL="postgresql://postgres:test-only@127.0.0.1:${port}/between_pages_test" "$@"
