# @between-pages/contracts

The single definition of every request and response the web client and the API exchange, as Zod 4 schemas. Both sides import it; neither restates a shape ([ADR-0006](../../docs/adr/0006-formal-stack.md) §22).

## Public surface

| Export | Contract |
| --- | --- |
| `routes` | Map of route name → `{ method, path, summary, access, response }`. The API registers exactly these; the web client calls only these. Adding a route here is how a new endpoint starts. |
| `RouteDefinition` | Shape every entry in `routes` satisfies. `path` always starts with `/api/`; `:name` segments are named in the optional `params` schema; optional `query` and `body` schemas. |
| `RouteName`, `ResponseOf<Name>`, `ParamsOf<Name>`, `QueryOf<Name>`, `BodyOf<Name>` | Route name union, the parsed response type, and the parsed input types (`undefined` when the route has none). |
| `HealthResponse` | `{ status: 'ok' }`, registered in OpenAPI as `HealthResponse`. |
| `routes.me`, `MeResponse`, `UserSummary` | `GET /api/me` (`access: 'user'`) → `{ user: { id, displayName } }`. `UserSummary` is what one member may learn about a user. |
| `ApiErrorBody`, `ErrorCode`, `errorStatus` | `{ error: { code, message } }` for every failed `/api/*` call we own; codes `UNAUTHENTICATED` 401, `FORBIDDEN_ORIGIN` 403, `VALIDATION_FAILED` 400, `NOT_FOUND` 404, `INTERNAL` 500, and the kernel's `STALE_CONTEXT` 409, `OPERATION_ALREADY_COMMITTED` 409, `EDIT_REJECTED` 422, `BATCH_CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `PROTOCOL_UNSUPPORTED` 400, `VERSION_UNREADABLE` 500. `message` is an English developer note; screens pick their text from `code`. |
| `ErrorCategory`, `errorCategory` | The one recovery category of each code ([kernel D10](../../docs/adr/2026-10-26-diary-collaboration-kernel.md)): `retry`, `reconcile`, `stop`, `reauth`, `upgrade`, `show`. Clients branch on the category, never on codes. |
| `routes.openDiary`, `routes.diary`, `OpenDiaryRequest`, `DiaryState`, `ClientBinding` (schema and type), `TimeZone` | `POST /api/diaries` `{ timezone, date? }` → `{ created, diary }`; `GET /api/diaries/:diaryId` → `{ diary }`. `DiaryState`: `diaryId`, `diaryDate`, `ownerId`, `generationId`, `seq`, `state` (base64 Yjs update), `bindings` (`{ clientId, userId }[]`). `TimeZone` accepts IANA names only, not offsets. |
| `routes.receipt`, `ReceiptQuery`, `CommitReceipt` (schema and type) | `GET /api/diaries/:diaryId/receipt` with exactly one of `batchId`, `operationId` → `{ receipt: CommitReceipt \| null }`. `CommitReceipt`: `batchId`, `operationIds`, `generationId`, `seq`, `publicId`, `committedAt`; also the ACK's receipt. Long-term compatible. |
| `routes.history`, `routes.historyVersion`, `HistoryPage`, `HistoryPoint`, `HistoryVersion` | History points newest first with an opaque `nextCursor` and `nextPointInMs` (milliseconds until the open group becomes a point, relative so device clocks do not matter, `null` when none is open); one version as `runs: { author, text }[]`. |
| `syncSocket`, `PROTOCOL_VERSION`, `MAX_MESSAGE_BYTES`, `closeCode` | The WebSocket path `/api/sync`, protocol 1, the 1 MiB message cap, close code `4401` for an ended session. |
| `ClientMessage` (`SubscribeMessage`, `SubmitMessage`, `SubmitOperation`) | Client → server, strict (unknown fields rejected), each with `v`. `subscribe`: `diaryId`, `generationId`, `knownSeq`. `submit`: `diaryId`, `batchId`, `generationId`, ordered `operations` of `{ operationId, update (base64), writtenAt }` with distinct IDs. No actor or author field exists. |
| `ServerMessage` (`SyncedMessage`, `CommitMessage`, `AckMessage`, `ErrorMessage`) | Server → client, lenient (unknown fields stripped). `synced`, `commit` (server-encoded `delta`, new `bindings`), `ack` (`receipt`, `replayed`), `error` (`code`, optional `diaryId`, `batchId`, diagnostic `reason`, `index`). |

## Invariants

- Contains schemas and types only: no I/O, no Fastify or React imports, no environment access.
- Each `method + path` pair appears once in `routes` (tested).
- Every route declares `access`; only `health` is `public` ([authentication-and-sessions](../../docs/adr/2026-10-24-authentication-and-sessions.md) invariant 13, tested).
- No response schema carries a last-seen time or login data (invariant 9, tested over every route).
- A schema that becomes an OpenAPI component carries `.meta({ id })`; the id is stable once published, because future native clients generate code from it.
- Every error code has exactly one recovery category (`satisfies Record<ErrorCode, ErrorCategory>`).
- No response or server message carries an internal version (kernel invariant 15, tested over every route and `ServerMessage`).
- Client messages are strict and server messages lenient, so only an incompatible change bumps `PROTOCOL_VERSION` (kernel D10, tested).

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

- Personal diaries only: epoch fields, cursors and sharing messages arrive with kernel phase 4. `SHARE_OPEN_FAILED`, `POLICY_CONFLICT` and `PERIOD_CLOSED` join `ErrorCode` with the first route that returns them.
- Binary payloads travel as base64 in JSON, so `MAX_MESSAGE_BYTES` counts the encoded text.
