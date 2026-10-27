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
| `ApiErrorBody`, `ErrorCode`, `errorStatus` | `{ error: { code, message, dates? } }` for every failed `/api/*` call we own, `dates` (`YYYY-MM-DD[]`) only with `SHARE_OPEN_FAILED` 409 (category `show`): the diaries whose clean baseline could not be built, nothing having opened; codes `UNAUTHENTICATED` 401, `FORBIDDEN_ORIGIN` 403, `VALIDATION_FAILED` 400, `NOT_FOUND` 404, `INTERNAL` 500, and the kernel's `STALE_CONTEXT` 409, `OPERATION_ALREADY_COMMITTED` 409, `EDIT_REJECTED` 422, `BATCH_CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `PROTOCOL_UNSUPPORTED` 400, `VERSION_UNREADABLE` 500, and the relationship codes `INVITE_INVALID` 404, `INVITE_EXPIRED`, `INVITE_REVOKED`, `INVITE_USED`, `SELF_INVITE`, `ALREADY_BOUND`, `PARTNER_FIXED`, `PERIOD_CLOSED`, `POLICY_CONFLICT` 409 (category `show`). `message` is an English developer note; screens pick their text from `code`. |
| `ErrorCategory`, `errorCategory` | The one recovery category of each code ([kernel D10](../../docs/adr/2026-10-26-diary-collaboration-kernel.md)): `retry`, `reconcile`, `stop`, `reauth`, `upgrade`, `show`. Clients branch on the category, never on codes. |
| `routes.openDiary`, `routes.diary`, `OpenDiaryRequest`, `DiaryState`, `ClientBinding` (schema and type), `TimeZone` | `POST /api/diaries` `{ timezone, date? }` → `{ created, diary }`; `GET /api/diaries/:diaryId` → `{ diary }`. `DiaryState`: `diaryId`, `diaryDate`, `ownerId`, `generationId`, `seq`, `state` (base64 Yjs update), `bindings` (`{ clientId, userId }[]`). `TimeZone` accepts IANA names only, not offsets. |
| `routes.diaries`, `DiaryListQuery`, `DiarySummary`, `DiaryListPage` | `GET /api/diaries?before=` → `{ diaries: [{ diaryId, diaryDate, excerpt, updatedAt }], nextBefore }`: the caller's own diaries, newest date first; `excerpt` is plain text or `null` when unreadable. |
| `routes.receipt`, `ReceiptQuery`, `CommitReceipt` (schema and type) | `GET /api/diaries/:diaryId/receipt` with exactly one of `batchId`, `operationId` → `{ receipt: CommitReceipt \| null }`. `CommitReceipt`: `batchId`, `operationIds`, `generationId`, `seq`, `publicId`, `committedAt`; also the ACK's receipt. Long-term compatible. |
| `routes.history`, `routes.historyVersion`, `HistoryPage`, `HistoryPoint`, `HistoryVersion` | History points newest first with an opaque `nextCursor` and `nextPointInMs` (milliseconds until the open group becomes a point, relative so device clocks do not matter, `null` when none is open); one version as `runs: { author, text }[]`. |
| `routes.binding`, `routes.spaces`, `routes.space`, `routes.createInvitation`, `routes.revokeInvitation`, `routes.previewInvitation`, `routes.acceptInvitation`, `routes.unbind`, `routes.mySharing`, `routes.saveMySharing` and their schemas (`spaces.ts`) | The relationship routes of [spaces-and-invitations](../../docs/adr/2026-10-25-spaces-and-invitations.md) D11. `SpaceSummary` `{ id, createdAt, state: 'active' \| 'archived', participants: [{ user, authorSlot: 1 \| 2 }] }`, `BindingSummary` `{ space, periodId }`, `PeriodSummary` `{ id, startedAt, endedAt }`, `InvitationSummary` `{ id, expiresAt, state }`, `InvitationToken` (43 base64url characters). Request bodies are strict. Only `MySharingResponse` carries a `DateSelection` (tested over every route). |
| `DateRange`, `DateSelection` | A person's sharing range ([spaces-and-invitations](../../docs/adr/2026-10-25-spaces-and-invitations.md) D3): `{ include, exclude }` of inclusive `{ from, to }` calendar days, `null` for an open end; the shared days are the include union minus the exclude union. Strict; a range with `from` after `to` is rejected. Used by the invitation, acceptance and range routes. |
| `routes.readRanges`, `routes.reportRead`, `ReadRange`, `ReportReadRequest`, `ReadRangesResponse` | `GET` / `POST /api/diaries/:diaryId/read`: the caller's own read coverage as `{ clientId, from, to }` clock ranges (strict, `from < to`), 1–1000 per report (kernel D15). |
| `routes.sharedDiaries`, `routes.sharedDiary`, `routes.character` and their schemas | The partner's entry (kernel D10): `SharedDiarySummary` / `SharedDiaryListPage` (`GET /api/spaces/:spaceId/shared-diaries?before=`), `SharedDiaryState` (`GET /api/diaries/:diaryId/shares/:epochId`: `DiaryState` fields plus `epochId` and `share: 'live' \| 'frozen'`), `CharacterInfo` (`GET /api/diaries/:diaryId/characters/:clientId/:clock?epochId=`: `author`, `writtenAt`, `clockAdjusted`). `ShareState`, `ShareParams`, `CharacterParams`, `CharacterQuery`. |
| `syncSocket`, `PROTOCOL_VERSION`, `MAX_MESSAGE_BYTES`, `closeCode` | The WebSocket path `/api/sync`, protocol 1, the 1 MiB message cap, close code `4401` for an ended session. |
| `ClientMessage` (`SubscribeMessage`, `SubmitMessage`, `SubmitOperation`, `CursorMessage`) | Client → server, strict (unknown fields rejected), each with `v`. `subscribe`: `diaryId`, `generationId`, optional `epochId` (the partner's live epoch), `knownSeq`. `submit`: `diaryId`, `batchId`, `generationId`, optional `epochId`, ordered `operations`; `cursor`: `diaryId`, `generationId`, `anchor` and `head` as encoded `Y.RelativePosition`s (base64, at most 256), both null when the caret left of `{ operationId, update (base64), writtenAt }` with distinct IDs. No actor or author field exists. |
| `ServerMessage` (`SyncedMessage`, `CommitMessage`, `AckMessage`, `ErrorMessage`, `ContextMessage`, `RemoteCursorMessage`) | Server → client, lenient (unknown fields stripped). `synced` (on the owner's subscription also `shared`: in a live share as of the reply), `commit` (server-encoded `delta`, new `bindings`), `ack` (`receipt`, `replayed`), `error` (`code`, optional `diaryId`, `batchId`, diagnostic `reason`, `index`), `context` (`change: 'opened' \| 'stopped'`, `generationId`, `epochId`), `cursor` (`user`, `anchor`, `head`). Protocol stays 1: the new fields are optional and clients of protocol 1 drop message types they do not know. |

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

- `BINDING_CONFLICT`, listed in spaces-and-invitations D11, is left out: nothing produces it (see the API README).
- Binary payloads travel as base64 in JSON, so `MAX_MESSAGE_BYTES` counts the encoded text.
