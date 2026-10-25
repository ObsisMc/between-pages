# @between-pages/api

The Fastify HTTP process: registers the routes defined in `@between-pages/contracts`, validates and serializes them with Zod, and publishes the OpenAPI document generated from them. Future home of sessions, the collaboration WebSocket and the PG write path ([ADR-0006](../../docs/adr/0006-formal-stack.md)).

## Public surface

| Export | Contract |
| --- | --- |
| `buildApp(deps)` (`src/app.ts`) | Returns a ready, non-listening Fastify instance with every contract route registered. `deps`: `publicOrigin` (the only trusted `Origin`), `currentUser(headers)` (the caller or `null`), optional `authHandler` (mounted at `/api/auth/*`), `logger`. Tests and the OpenAPI generator use it, so they exercise the same registration production serves. |
| `renderOpenApi()` (`src/openapi.ts`) | The OpenAPI 3.1 document as the exact text committed in `openapi.json`. |
| `npm run dev` / `npm start -w @between-pages/api` | Listens on `HOST:PORT` (defaults `127.0.0.1:3000`), reading the repo-root `.env` if present. |
| `GET /api/health` | Public. `200 { "status": "ok" }` while the process serves requests. |
| `GET /api/me` | `200 { user: { id, displayName } }` for the signed-in user; `401 UNAUTHENTICATED` otherwise. |
| Errors | Every failure on our `/api/*` routes is `{ error: { code, message } }` (`src/errors.ts`); internal details are logged, never returned. |
| `openapi.json` | Generated contract for non-TS clients. Never edit by hand: `npm run openapi`. |
| `createDb(url)` (`src/db/client.ts`) | `{ db, pool, close() }`: a Drizzle instance over one `pg` pool. The caller owns it and must `close()` it. |
| `runMigrations(url)` (`src/db/migrate.ts`) | Applies every pending migration in `drizzle/`; already-applied ones are skipped. Used by `npm run db:migrate` and the test setup, so production needs no drizzle-kit. |
| `users` (`src/db/schema.ts`) | Domain users: `id` (UUID issued by the auth layer), `display_name`, `created_at`, `last_seen_at`. |
| `drizzle/` | Generated migrations. Never edit by hand: change `schema.ts`, then `npm run db:generate -- --name <what-changed>`. |

## Invariants

- Every route is registered from a `routes` entry in `@between-pages/contracts`; no path or response shape is written inline.
- Responses are serialized through their Zod schema, so a handler cannot return a field the contract does not declare.
- `openapi.json` equals `renderOpenApi()` output (`verify-openapi-current`).
- `access: 'user'` routes run the login guard and answer 401 without a session (invariant 13).
- Every non-GET/HEAD/OPTIONS `/api/*` request outside `/api/auth/*` must carry `Origin` equal to `publicOrigin`, else 403 `FORBIDDEN_ORIGIN`, including unknown routes (invariant 7, HTTP part).
- `drizzle/` holds a migration for every change in `schema.ts` (`verify-migrations-current`).
- `users` is written only by this module's code and holds no email, login method or foreign key into `auth_*` tables; no domain table references an `auth_*` table ([authentication-and-sessions](../../docs/adr/2026-10-24-authentication-and-sessions.md) invariant 1, schema tests).

## Allowed dependencies

- May import: `@between-pages/contracts`, `fastify` and `@fastify/*` plugins, `fastify-type-provider-zod`, `zod`, `drizzle-orm`, `pg`.
- Must not import: `apps/web` ([architecture](../../docs/architecture.md#dependency-direction)).

## How to test

```sh
npx vitest run --project api      # *.db.test.ts are skipped without a database
npm run test:db                   # all tests against a disposable PostgreSQL 18 (Docker)
```

- Tier: integration through `app.inject()` — the real router, no network socket — and `*.db.test.ts` against real PostgreSQL. See [docs/testing.md](../../docs/testing.md#tiers).
- Database tests read `TEST_DATABASE_URL`; `test/global-setup.ts` migrates it once per run. Without it they are skipped with a notice locally and fail the run in CI.

## Known limitations

- No authentication, WebSocket or worker entry yet, and no code writes `users` yet: each arrives with the first feature that uses it (phase 1/2 in [roadmap](../../docs/roadmap.md)).
- `drizzle-kit` 0.31 pulls an old esbuild loader with 4 moderate `npm audit` findings. It runs only when generating migrations on a developer machine, never in production; re-check when upgrading to Drizzle 1.0.
- `src/server.ts` is excluded from coverage; it only wires `buildApp()` to a port.
