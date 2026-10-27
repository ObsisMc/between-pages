# @between-pages/collab

The pure collaboration model both apps share: the `Y.Text('body')` document, the server-side check of every edit, the clean baseline a new generation starts from, the batch digest and author derivation ([diary collaboration kernel](../../docs/adr/2026-10-26-diary-collaboration-kernel.md) D3, D4, D9, D11). Pure functions over Yjs values: no I/O, sessions, PG, HTTP or UI, so the API and the web app run the same rules.

## Public surface

Everything is exported from the package root (`src/index.ts`). Each sub-module owns one responsibility; `doc` is the shared model they all build on.

| Sub-module | Export | Contract |
| --- | --- | --- |
| `doc` | `BODY`, `createDiaryDoc()` | The one shared type name `'body'`; a document for normal running with garbage collection off, so deleted items keep their content for undo, unread anchors and the owner's archive. |
| `doc` | `ClientBindings` | `ReadonlyMap<clientID, userId>`: the server's record of who owns each Yjs clientID of one diary. |
| `validate` | `acceptBatch(candidate, updates, actor, bindings)` | Checks each update of one send batch, in order, then applies it to `candidate`, so later updates may depend on earlier ones. Returns `{ ok: true, delta, claimedClientIds }` or `{ ok: false, index, reason }` for the first failing update. Mutates `candidate`; after a rejection it holds a prefix and must be discarded. `delta` is re-encoded by Yjs from the accepted state, never the uploaded bytes. `claimedClientIds` are unbound clientIDs this batch binds to `actor`; the caller registers them in the commit transaction. |
| `validate` | `RejectReason` | Diagnostic detail for `EDIT_REJECTED`: `MALFORMED_UPDATE`, `FOREIGN_CLIENT_ID`, `FOREIGN_DELETE`, `CONTENT_NOT_ALLOWED`, `CONTROL_CHARACTER`, `FOREIGN_TYPE`, `MISSING_DEPENDENCY`. Not user text. |
| `baseline` | `buildBaseline(committed)` | Loads committed state into an isolated garbage-collecting document and re-encodes it: deleted text becomes `ContentDeleted`, every item keeps its ID. Returns `{ ok: true, baseline }` or `{ ok: false, problem }` (`DELETED_CONTENT_RETAINED` or `TEXT_CHANGED`), which the caller reports as `SHARE_OPEN_FAILED`. |
| `digest` | `batchDigest(batch, algorithm)`, `DIGEST_ALGORITHM`, `DigestAlgorithm`, `BatchIdentity` | sha256 over the canonical bytes of `{ generationId, epochId, operations: [{ operationId, updateSha256 }] }`. Algorithm 1: the algorithm byte, then length-prefixed fields: generation, an epoch flag with the epoch, member count, and each member's ID and hash in order. A retry is compared using the algorithm stored with its commit. |
| `digest` | `sha256(bytes)` | SHA-256 via Web Crypto, available in Node and browsers alike. |
| `authorship` | `authorRuns(doc, bindings)`, `AuthorRun` | Visible text in document order as `{ author, client, clock, text }` runs, each one clientID with consecutive clocks. Throws if a visible clientID has no binding. |
| `authorship` | `insertedRanges(stateVector, updates)`, `CharacterRange` | For each update of an accepted batch, in order, the characters it newly inserts as `{ client, clock, length }` runs (clocks count UTF-16 code units, as Yjs does). `stateVector` is the document's before the batch. Re-sent items and deletion placeholders yield nothing. The API stores one row per run with the operation's ID, which gives every character its written time (kernel D15). |

## Invariants

- A new character's clientID is bound to the actor, or is unbound and gets claimed for the actor; a deletion covers only the actor's characters (kernel invariants 2, 3; attack tests).
- Accepted content is `ContentString` (no C0 control character except `\n` and `\t`, no DEL) or `ContentDeleted`, always in the `body` root type. Formatting, embeds, nested types, attributes, other root types and references to unknown items are rejected; nothing is left in Yjs's pending queue (tested).
- Items the candidate already has are skipped without an owner check, and are never in `delta`: re-sent raw bytes may carry deleted private text, but the delta and the accepted state never do (invariant 12, tested).
- A baseline is returned only after its self-check: deleted items carry only `ContentDeleted`, and the visible text equals the source's (invariant 18, tested).
- A baseline keeps every visible character's ID and author (invariant 18; multi-client property test over several generations).
- Algorithm 1's digest bytes never change; a new layout is a new `DigestAlgorithm` (golden-value test).
- No I/O, clock or environment access; the only randomness is the clientID Yjs gives each new document.
- Sub-modules import only `doc` and `yjs`, never each other; `doc` imports no sub-module (`verify-dependency-direction`).

## Allowed dependencies

- May import: `yjs` (exact version, matching the apps); `vitest` in tests only.
- Must not import: `apps/*`, `@between-pages/contracts`, Node built-ins, or anything under `prototypes/` ([architecture](../../docs/architecture.md#dependency-direction), `verify-dependency-direction`).

## How to test

```sh
npx vitest run --project collab
```

- Tier: unit, see [docs/testing.md](../../docs/testing.md#tiers). Each sub-module has its own `*.test.ts`. `src/kernel.test.ts` runs cross-sub-module behavior through the package root: generation switches, raw replays and a seeded multi-client property test (12 seeds, 4 generations each).
- Tests carry `[adr:diary-collaboration-kernel#N]` for the invariant they verify.

## Known limitations

- Each update passed to `acceptBatch` must be one Yjs transaction as emitted by the `update` event. A state diff (`encodeStateAsUpdate(doc, vector)`) carries the whole delete set, including the other author's deletions, and is rejected as `FOREIGN_DELETE`.
- The canonical batch bytes live here, not in `packages/contracts`, so web and API share one implementation; contracts will own only the wire fields.
- Baselines remove deleted text but keep structure: clientIDs, clocks and deletion lengths can still hint at edit volume (kernel D4).
- The API uses it since kernel phase 2; the web app's editor binding since phase 3.
