# PostgreSQL with WAL-G for the database that holds real diaries (server-backup-and-google-docs D2).
# Stays on the Alpine image the existing data directory was created with: its libc collation
# (en_US.utf8 under musl) orders text differently from glibc, so a Debian image would leave
# text indexes out of order. WAL-G ships only glibc builds, so it is built here from the
# pinned tag and linked statically.
FROM golang:1.25.11-alpine3.24 AS walg
ARG WALG_VERSION=v3.0.9
ARG WALG_COMMIT=3e493188db28335fb93a45bd680c6ff8fc3028c1
RUN apk add --no-cache git build-base libsodium-dev libsodium-static
RUN git clone --depth 1 --branch "$WALG_VERSION" https://github.com/wal-g/wal-g.git /src \
  && test "$(git -C /src rev-parse HEAD)" = "$WALG_COMMIT"
WORKDIR /src/main/pg
RUN CGO_ENABLED=1 GOEXPERIMENT=jsonv2 go build -tags libsodium -o /wal-g \
  -ldflags "-s -w -linkmode external -extldflags -static -X github.com/wal-g/wal-g/cmd/pg.walgVersion=$WALG_VERSION -X github.com/wal-g/wal-g/cmd/pg.gitRevision=$WALG_COMMIT"

FROM postgres:18.6-alpine3.24
COPY --from=walg /wal-g /usr/local/bin/wal-g
