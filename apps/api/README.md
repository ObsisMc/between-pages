# @between-pages/api

The Fastify HTTP process: registers the routes defined in `@between-pages/contracts`, validates and serializes them with Zod, and publishes the OpenAPI document generated from them. Future home of sessions, the collaboration WebSocket and the PG write path ([ADR-0006](../../docs/adr/0006-formal-stack.md)).

## Public surface

| Export | Contract |
| --- | --- |
| `buildApp(options)` (`src/app.ts`) | Returns a ready, non-listening Fastify instance with every contract route registered. Tests and the OpenAPI generator use it, so they exercise the same registration production serves. |
| `renderOpenApi()` (`src/openapi.ts`) | The OpenAPI 3.1 document as the exact text committed in `openapi.json`. |
| `npm run dev` / `npm start -w @between-pages/api` | Listens on `HOST:PORT` (defaults `127.0.0.1:3000`), reading the repo-root `.env` if present. |
| `GET /api/health` | `200 { "status": "ok" }` while the process serves requests. |
| `openapi.json` | Generated contract for non-TS clients. Never edit by hand: `npm run openapi`. |

## Invariants

- Every route is registered from a `routes` entry in `@between-pages/contracts`; no path or response shape is written inline.
- Responses are serialized through their Zod schema, so a handler cannot return a field the contract does not declare.
- `openapi.json` equals `renderOpenApi()` output (`verify-openapi-current`).

## Allowed dependencies

- May import: `@between-pages/contracts`, `fastify` and `@fastify/*` plugins, `fastify-type-provider-zod`, `zod`.
- Must not import: `apps/web` ([architecture](../../docs/architecture.md#dependency-direction)).

## How to test

```sh
npx vitest run --project api
```

- Tier: integration through `app.inject()` — the real router, no network socket. See [docs/testing.md](../../docs/testing.md#tiers).

## Known limitations

- No database, authentication, WebSocket or worker entry yet: each arrives with the first feature that uses it (phase 1/2 in [roadmap](../../docs/roadmap.md)).
- `src/server.ts` is excluded from coverage; it only wires `buildApp()` to a port.
