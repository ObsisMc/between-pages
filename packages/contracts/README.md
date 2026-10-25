# @between-pages/contracts

The single definition of every request and response the web client and the API exchange, as Zod 4 schemas. Both sides import it; neither restates a shape ([ADR-0006](../../docs/adr/0006-formal-stack.md) §22).

## Public surface

| Export | Contract |
| --- | --- |
| `routes` | Map of route name → `{ method, path, summary, access, response }`. The API registers exactly these; the web client calls only these. Adding a route here is how a new endpoint starts. |
| `RouteDefinition` | Shape every entry in `routes` satisfies. `path` always starts with `/api/`. |
| `RouteName`, `ResponseOf<Name>` | Route name union and the parsed response type for one route. |
| `HealthResponse` | `{ status: 'ok' }`, registered in OpenAPI as `HealthResponse`. |
| `routes.me`, `MeResponse`, `UserSummary` | `GET /api/me` (`access: 'user'`) → `{ user: { id, displayName } }`. `UserSummary` is what one member may learn about a user. |
| `ApiErrorBody`, `ErrorCode`, `errorStatus` | `{ error: { code, message } }` for every failed `/api/*` call we own; codes `UNAUTHENTICATED` 401, `FORBIDDEN_ORIGIN` 403, `VALIDATION_FAILED` 400, `NOT_FOUND` 404, `INTERNAL` 500. `message` is an English developer note; screens pick their text from `code`. |

## Invariants

- Contains schemas and types only: no I/O, no Fastify or React imports, no environment access.
- Each `method + path` pair appears once in `routes` (tested).
- Every route declares `access`; only `health` is `public` ([authentication-and-sessions](../../docs/adr/2026-10-24-authentication-and-sessions.md) invariant 13, tested).
- No response schema carries a last-seen time or login data (invariant 9, tested over every route).
- A schema that becomes an OpenAPI component carries `.meta({ id })`; the id is stable once published, because future native clients generate code from it.

## Allowed dependencies

- May import: `zod`.
- Must not import: `apps/*`, any other workspace package — it sits at the bottom of the graph ([architecture](../../docs/architecture.md#dependency-direction)).

## How to test

```sh
npx vitest run --project contracts
```

- Tier: unit — see [docs/testing.md](../../docs/testing.md#tiers).
- After changing a schema, run `npm run openapi` and commit `apps/api/openapi.json`; `verify-openapi-current` fails otherwise.

## Known limitations

- WebSocket message schemas are not defined yet; they arrive with the collaboration protocol (phase 2).
- No request bodies or params yet: `RouteDefinition` grows those fields when the first route needs them.
