# @between-pages/web

The React single-page app (Vite, React Router, TanStack Query). Calls the API only through the typed client built on `@between-pages/contracts` ([ADR-0006](../../docs/adr/0006-formal-stack.md)). Diary code is split into the sub-modules of [kernel D11](../../docs/adr/2026-10-26-diary-collaboration-kernel.md): `editor-binding`, `journal`, `sender` and `sync-client` exist; the diary screen that composes them does not yet.

## Public surface

| Export | Contract |
| --- | --- |
| `npm run dev -w @between-pages/web` | Vite dev server; proxies `/api`, the sync WebSocket included, to the API on the repo-root `.env` `PORT` (default 3000), so the app is same-origin. |
| `npm run build -w @between-pages/web` | Static bundle in `dist/`. |
| `callApi(name, request?, fetch?)` (`src/api/client.ts`) | The only way to call the API: method and path come from the contract, the response is parsed with its schema. `request` is `{ params, query, body }` with exactly the inputs the route declares (`RequestOf<Name>`), required when it declares any; params fill the `:name` segments, the query skips undefined values, the body is sent as JSON. Throws `ApiError` (with `status` and the contract error `code`, `INTERNAL` when the body is unreadable) on non-2xx and a Zod error on a shape mismatch. |
| `signIn(provider, loginHint?)`, `signOut()` (`src/api/auth.ts`) | Better Auth's sign-in and sign-out. `signIn` returns the provider URL; success returns to `/`, failure to `/login?error=<code>`. |
| `appRoutes` (`src/routes.tsx`) | `/login` (public; signed-in users go to `/`), `/` (behind `RequireAuth`), anything else → `/`. |
| `<RequireAuth>` (`src/auth/RequireAuth.tsx`), `useMe()` | Login state from the `['me']` query: loading → "正在打开…", 401 → `/login`, other errors → message and retry. A 401 is never retried. |
| `<LoginPage>` | Google button; Better Auth's `?error=` codes shown on the page; "开发登录" (name → mock issuer) only in dev builds (`import.meta.env.DEV`). |
| `<HomePage>` | Placeholder: "已登录为 {name}" and sign-out, which clears the query cache before going to `/login`. |
| `createEditorBinding(place, { userId, onOperation, onRefuse })` (`src/editor-binding`) | A ProseMirror view in `place` bound to a new `Y.Text('body')` (`createDiaryDoc`) for one diary generation; a new generation needs a new binding (kernel D4, D8). Returns `{ view, applyUpdate(update, bindings), destroy() }`. `applyUpdate` applies committed deltas or an earlier instance's pending operations with the bindings naming their authors, and throws on text whose clientID has none. |
| `EditorOperation` | Emitted synchronously, in order, for every local change (a keystroke, a confirmed IME composition, a paste, an undo step): `{ operationId, update, writtenAt, intent }`. `update` is one Yjs transaction as the `update` event emits it; `writtenAt` is its write session's start, which continues while typing or deleting goes on at the caret with pauses under 30 s (D13); `intent` lists its contiguous changes as `insert` / `delete` / `replace` with about 20 graphemes of context for recovery drafts (D7). |
| `Refusal` | `onRefuse` reasons; the text is left unchanged: `FOREIGN_TEXT`, `PASTE_TOO_LARGE` (the clipboard is untouched), `CONTROL_CHARACTER`. |
| `openJournal<Intent>(userId)` (`src/journal`) | The account's IndexedDB journal (kernel D7), database `between-pages-journal:<userId>`, stores for baselines, pending operations, send batches, receipts and drafts. Per diary: `load` → `{ baseline, pending, batch }`; `install(server)` takes a newer server state of the same generation (another generation throws, switching is phase 4); `append(diaryId, generationId, operation)` → `'pending'`, or `'draft'` when written against a generation that is no longer current; `nextBatch` → the unconfirmed batch or a new one of up to `BATCH_MAX_OPERATIONS` (100) and `BATCH_SOFT_BYTES` (64 KB), an oversized operation alone; `confirm(diaryId, receipt)`; `advance(diaryId, generationId, commits, bindings)` → the baseline seq; `reject(diaryId, batchId, reason)` → the drafts it made; `drafts`, `deleteDraft`, `close`. Once a newer tab upgrades the database every call rejects with `JournalUnavailable`. |
| `Baseline`, `PendingOperation`, `SendBatch`, `Draft`, `DraftReason` | The confirmed state (`seq`: every commit up to it is in `state`, and possibly this account's later acknowledged commits), an operation with its `localSequence`, a batch with its ordered members and bytes, and a draft: `operationId`, `writtenAt`, `intent`, `reason` (`rejected` / `stale-generation`), `savedAt`, and the `localSequence` drafts are listed in. |
| `createSender({ journal, userId, diaryId, transport, onStatus, onDrafts })` (`src/sender`) | Sends one diary's journal (kernel D13): `wake()` after each append and when the connection comes back; `stop()`. One batch in flight per account and diary across tabs, under the Web Lock `between-pages-send:<userId>:<diaryId>` (`sendLockName`). Answers by error category: `retry` and no answer resend the same batch after 1 s, doubling to 30 s (or at the next `wake`); `reconcile` looks up the receipt and confirms, otherwise drafts; `stop` turns the batch and every later pending operation into drafts, reported through `onDrafts`, and goes on with newer input; `reauth` and `show` pause until the next `wake`; `upgrade` and `JournalUnavailable` stop for good. |
| `SyncTransport`, `SubmitResult`, `SaveStatus` | What the sender needs from the network: `submit(batch)` → `ack` / `error` / `offline` (no answer, outcome unknown), `receipt(diaryId, batchId)`. `SaveStatus`: `saved`, `syncing`, `confirming`, `offline`, `attention`, `reauth`, `upgrade`, `readonly`. It describes the queue, so `saved` follows `attention` once nothing waits; drafts stay in `journal.drafts` until deleted, and the screen keeps showing them as needing attention. |
| `createSyncClient({ diaryId, generationId, knownSeq, onCommits, onStatus })` (`src/sync-client`) | The `/api/sync` socket of one diary generation; it implements `SyncTransport`. Subscribes from the last delivered seq, hands commits over decoded and strictly in seq order (a gap re-subscribes), resolves each submit with its ACK or error, and reconnects after 1 s, doubling to 30 s. `SyncStatus`: `connecting`, `live`, `offline`, and the final `reauth` (close 4401), `upgrade` (`PROTOCOL_UNSUPPORTED`) and `refused` (the subscription failed, e.g. `NOT_FOUND`). `receipt` calls the contract route through `callApi`. `close()`. |

## Invariants

- No `fetch('/api/...')` outside `src/api/client.ts` and `src/api/auth.ts`. `auth.ts` is the single exception, because Better Auth's endpoints are not in the contract ([authentication-and-sessions](../../docs/adr/2026-10-24-authentication-and-sessions.md) D9); everything else goes through `callApi`.
- Production builds contain no development login (it sits behind `import.meta.env.DEV`).
- Server data lives in TanStack Query; diary text will live only in the collaboration module, never in Query or Zustand ([ADR-0006](../../docs/adr/0006-formal-stack.md) §8).
- Editor steps are translated into `Y.Text` inserts and deletes as they happen, never by comparing whole texts; Yjs's delta of the same transaction gives the intent (tested with repeated characters that a string diff confuses).
- No edit path deletes or changes a character another user wrote: typing, deleting, Enter, cut, paste, IME and undo/redo over such text are refused or, for Backspace/Delete, jump past it without deleting (EDIT-04/05); every emitted operation passes the server's `acceptBatch` (kernel invariant 3, tested).
- Personal undo covers only this instance's own edits, never applied updates, and starts empty with each generation's binding (kernel invariant 19, tested).
- During an IME composition only the confirmed text becomes an operation; updates arriving meanwhile are shown after it ends (EDIT-11, tested).
- A paste whose operation would not fit one 1 MB submit message (base64 included) is refused at input, without an operation (D13, tested against the encoded message); pasted text is plain, with `\n` line breaks and no control characters.
- `editor-binding` imports no other web sub-module, so it knows neither the network nor IndexedDB (`verify-dependency-direction`).
- Local writes are IndexedDB transactions with `strict` durability, and count only once complete. The `localSequence` is allocated in the same transaction that stores the operation and is shared by every tab of the account; batches follow it, never operation IDs (kernel invariant 22, tested).
- A send batch is stored before its first send and resent unchanged, after a lost answer or a restart (invariants 9, 10, tested). The next batch is formed only after the journal confirms the last one, which removes its operations, stores the receipt and merges the text into the baseline in one transaction.
- An operation written against a generation that is no longer current is checked inside its write transaction and becomes a draft, never pending.
- A refused batch, and every later pending operation that may build on it, becomes drafts in one transaction; nothing of it is retried or sent in part (invariant 8). Drafts stay until the user deletes them (invariant 20, tested).
- A batch whose submit came back with a context error is first looked up by receipt: committed means saved, never a draft (invariant 21, tested).
- Without Web Locks the sender stays read-only and sends nothing.
- Commits reach `onCommits` only in seq order without gaps, and base64 exists only inside `sync-client`.

## Allowed dependencies

- May import: `@between-pages/contracts`, `@between-pages/collab`, React, React Router, TanStack Query; in `editor-binding`, `yjs` and `prosemirror-{model,state,view,transform,keymap}`; in `journal`, `yjs` (exact versions). Tests may use `fake-indexeddb` (dev only).
- Must not import: `apps/api` ([architecture](../../docs/architecture.md#dependency-direction)).
- Sub-modules (`verify-dependency-direction`): `editor-binding` and `journal` import none of the others; `sender` imports `journal`; `sync-client` imports `api`; `auth` imports `api`; `pages` import `api` and `auth`; `routes` imports `auth` and `pages`. The sender and the sync client meet only in the screen that wires them.

## How to test

```sh
npx vitest run --project web
```

- Tier: component tests in jsdom with `@testing-library/react`, rendering the real `appRoutes` in a memory router (`test/render.tsx`); `fetch` is stubbed at the network boundary with contract-shaped responses. See [docs/testing.md](../../docs/testing.md#tiers).
- `editor-binding` tests drive a real view with DOM events (keys, paste, composition, `beforeinput`) and the transactions ProseMirror dispatches for typed text; every operation is checked with `packages/collab`'s `acceptBatch`, and the other author's edits arrive as its re-encoded deltas. No network. Tests carry `[adr:diary-collaboration-kernel#N]` for the invariant they verify.
- `journal` and `sender` tests run on `fake-indexeddb` with real Yjs updates and no editor; the sender's Web Locks are a stand-in with the browser's one-holder-per-name order, and its transport a stand-in server that remembers committed batches. `sync-client` tests replace `WebSocket` and `fetch` at the network boundary, parsing what the client sends with the strict contract schemas.

## Known limitations

- No diary screen yet: nothing composes the editor binding, journal, sender and sync client, so there is no save status, draft list or own history on screen; `src/main.tsx` (excluded from coverage) only mounts providers and the router.
- Switching a diary to a new generation (reconcile pending, keep drafts, install the new baseline in one transaction) is kernel phase 4; until then `install` refuses another generation.
- The journal is not locked on sign-out yet, and storage failures surface only as rejected calls; the screen that keeps unsaved text in memory and offers copying arrives with it.
- The real IndexedDB, Web Locks and socket path ran in a throwaway Chromium/Firefox/WebKit probe against the real API; the committed browser suite for it arrives with the diary screen.
- The editor shows no author colors or remote cursors yet (EDIT-13, kernel D8 cursors); "只看本人" and history views do not exist.
- Dragging text into the editor is blocked rather than handled as a paste.
- Undo steps are Yjs's 500 ms capture groups, split whenever typing, deleting and replacing alternate.
- `operationId` uses `crypto.randomUUID`, so the app needs a secure context (HTTPS or localhost), as Web Locks will.
- Authorship checks walk the whole `Y.Text` on each deletion (`authorRuns`); fine at diary size, not tuned for very long documents.
- IME, native typing and paste are tested in jsdom; real-browser acceptance in Chromium, Firefox and WebKit belongs to the phase-3 browser suite.
- No screen for linking a second login method; the server supports it (ADR D3).
- Browser-level login flows are covered by the root `e2e/` Playwright suite (E1-E6), not here; the browser suites under `prototypes/` remain the editor behavior baseline.
