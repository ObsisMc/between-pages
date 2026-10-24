#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
collab_container="between-pages-probe-$$"
collab_image="${COLLAB_TEST_PG_IMAGE:-postgres:18-alpine}"
cleanup() { docker rm -f "$collab_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Disposable local-only database. This password is test data, never a deployment credential.
docker run --detach --rm --name "$collab_container" \
  -e POSTGRES_PASSWORD=collab-test-only -e POSTGRES_DB=collab \
  -p 127.0.0.1::5432 "$collab_image" >/dev/null
collab_ready=false
for attempt in {1..30}; do
  if docker exec "$collab_container" pg_isready -U postgres -d collab >/dev/null 2>&1; then
    collab_ready=true; break
  fi
  sleep 1
done
if [ "$collab_ready" != true ]; then docker logs "$collab_container"; exit 1; fi
collab_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$collab_container")"
docker exec "$collab_container" postgres --version
COLLAB_TEST_DATABASE_URL="postgresql://postgres:collab-test-only@127.0.0.1:${collab_port}/collab" npm run "${COLLAB_TEST_SUITE:-test:pg}"
