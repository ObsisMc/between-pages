# @between-pages/web

The React single-page app (Vite, React Router, TanStack Query). Calls the API only through the typed client built on `@between-pages/contracts` ([ADR-0006](../../docs/adr/0006-formal-stack.md)). Diary code is split into the sub-modules of [kernel D11](../../docs/adr/2026-10-26-diary-collaboration-kernel.md): `editor-binding`, `journal`, `sender` and `sync-client`, wired together by the `diary` screen.

## Public surface

| Export | Contract |
| --- | --- |
| `npm run dev -w @between-pages/web` | Vite dev server; proxies `/api`, the sync WebSocket included, to the API on the repo-root `.env` `PORT` (default 3000), so the app is same-origin. |
| `npm run build -w @between-pages/web` | Static bundle in `dist/`. |
| `callApi(name, request?, fetch?)` (`src/api/client.ts`) | The only way to call the API: method and path come from the contract, the response is parsed with its schema. `request` is `{ params, query, body }` with exactly the inputs the route declares (`RequestOf<Name>`), required when it declares any; params fill the `:name` segments, the query skips undefined values, the body is sent as JSON. Throws `ApiError` (with `status` and the contract error `code`, `INTERNAL` when the body is unreadable) on non-2xx and a Zod error on a shape mismatch. |
| `signIn(provider, loginHint?)`, `signOut()` (`src/api/auth.ts`) | Better Auth's sign-in and sign-out. `signIn` returns the provider URL; success returns to `/`, failure to `/login?error=<code>`. |
| `appRoutes` (`src/routes.tsx`) | `/login` (public; signed-in users go to `/`), `/` and `/diaries/:diaryId` (behind `RequireAuth`), anything else → `/`. |
| `<RequireAuth>` (`src/auth/RequireAuth.tsx`), `useMe()` | Login state from the `['me']` query: loading → "正在打开…", 401 → `/login`, other errors → message and retry. A 401 is never retried. |
| `<LoginPage>` | Google button; Better Auth's `?error=` codes shown on the page; "开发登录" (name → mock issuer) only in dev builds (`import.meta.env.DEV`). |
| `<HomePage>` | "已登录为 {name}", "写今天" (opens or creates today's diary in the device's IANA time zone, the server deciding the date), a date picker to open or back-fill a past day, and sign-out, which clears the query cache before going to `/login`. Offline it says it cannot confirm the diary instead of creating one (DATE-06). |
| `<DiaryPage>` (`src/diary`, `/diaries/:diaryId`) | One diary: the editor, a single save-status line (正在保存到本机 / 正在同步 / 已保存到服务器 / 暂时无法同步，已保存在本机 / 正在确认保存结果 / 需要处理, and the warnings 本机保存失败, 登录已过期, 有新版本, 只读), a short notice when the editor refuses input, copy and download of the text when it cannot be stored, and the recovery drafts. |
| `createDiarySession({ place, userId, diaryId, onChange })` (`src/diary/session.ts`) | Wires the four building blocks for one diary and reports `DiaryState` (`phase`, `failure`, `save`, `sync`, `unstored`, `storeFailed`, `drafts`, `refusal`). Opens from the server, or from this device's journal when the server is unreachable; stores each operation in order, keeping unstored ones in memory and retrying them with their IDs; rebuilds the editor from the journal after drafts are made, once nothing unstored is on screen; `deleteDrafts(ids)`, `text()`, `destroy()`. |
| `<DraftList>`, `groupDrafts(drafts)` (`src/diary`) | Recovery drafts grouped for display: consecutive input of one refusal is one card, inserts typed one after another one passage. Inserts and the new part of a replace can be copied; a deletion is only shown; a card is deleted after a second click. |
| `createEditorBinding(place, { userId, onOperation, onRefuse })` (`src/editor-binding`) | A ProseMirror view in `place` bound to a new `Y.Text('body')` (`createDiaryDoc`) for one diary generation; a new generation needs a new binding (kernel D4, D8). Returns `{ view, applyUpdate(update, bindings), setEditable(editable), destroy() }`; read-only stops every edit path, undo included, and still shows applied updates. `applyUpdate` applies committed deltas or an earlier instance's pending operations with the bindings naming their authors, and throws on text whose clientID has none. |
| `EditorOperation` | Emitted synchronously, in order, for every local change (a keystroke, a confirmed IME composition, a paste, an undo step): `{ operationId, update, writtenAt, intent }`. `update` is one Yjs transaction as the `update` event emits it; `writtenAt` is its write session's start, which continues while typing or deleting goes on at the caret with pauses under 30 s (D13); `intent` lists its contiguous changes as `insert` / `delete` / `replace` with about 20 graphemes of context for recovery drafts (D7). |
| `Refusal` | `onRefuse` reasons; the text is left unchanged: `FOREIGN_TEXT`, `PASTE_TOO_LARGE` (the clipboard is untouched), `CONTROL_CHARACTER`. |
| `openJournal<Intent>(userId)` (`src/journal`) | The account's IndexedDB journal (kernel D7), database `between-pages-journal:<userId>`, stores for baselines, pending operations, send batches, receipts and drafts. Per diary: `load` → `{ baseline, pending, batch }`; `install(server)` takes a newer server state of the same generation (another generation throws, switching is phase 4); `append(diaryId, generationId, operation)` → `'pending'`, or `'draft'` when written against a generation that is no longer current; `nextBatch` → the unconfirmed batch or a new one of up to `BATCH_MAX_OPERATIONS` (100) and `BATCH_SOFT_BYTES` (64 KB), an oversized operation alone; `confirm(diaryId, receipt)`; `advance(diaryId, generationId, commits, bindings)` → the baseline seq; `reject(diaryId, batchId, reason)` → the drafts it made: the batch and every pending operation that may build on it (inserted by one of its editor instances, or deleting its characters), whose identity the journal keeps so a later `append` of such an operation becomes a draft too; `drafts`, `deleteDraft`, `close`. Once a newer tab upgrades the database every call rejects with `JournalUnavailable`. |
| `Baseline`, `PendingOperation`, `SendBatch`, `Draft`, `DraftReason` | The confirmed state (`seq`: every commit up to it is in `state`, and possibly this account's later acknowledged commits), an operation with its `localSequence`, a batch with its ordered members and bytes, and a draft: `operationId`, `writtenAt`, `intent`, `reason` (`rejected` / `stale-generation`), `savedAt`, and the `localSequence` drafts are listed in. |
| `createSender({ journal, userId, diaryId, transport, onStatus, onDrafts })` (`src/sender`) | Sends one diary's journal (kernel D13): `wake()` after each append and when the connection comes back; `stop()`. One batch in flight per account and diary across tabs, under the Web Lock `between-pages-send:<userId>:<diaryId>` (`sendLockName`). Answers by error category: `retry` resends the same batch after 1 s, doubling to 30 s, and new input does not cut the pause short; no answer (`offline`) resends it at the next `wake`, which the screen gives when the connection is back; `reconcile` looks up the receipt and confirms, otherwise drafts; `stop` turns the batch and whatever builds on it into drafts, reported through `onDrafts`, and goes on with the rest; `reauth` and `show` pause until the next `wake`; `upgrade` and `JournalUnavailable` stop for good. |
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
- A refused batch, and every pending or later operation that may build on it, becomes drafts; nothing of it is retried or sent in part, and it never joins a batch with input that does not depend on it (invariant 8). Drafts stay until the user deletes them (invariant 20, tested).
- The screen says "已保存到服务器" only when nothing waits on this device or in flight: the sender leaves `saved` the moment it is woken, before the stored operation is announced (SAVE-01, tested in three browsers).
- Text the journal could not store stays on screen and in memory, is retried with its operation IDs, and leaving the page asks first; the editor is never rebuilt over it (SAVE-06, tested).
- A batch whose submit came back with a context error is first looked up by receipt: committed means saved, never a draft (invariant 21, tested).
- Without Web Locks the sender stays read-only and sends nothing.
- Commits reach `onCommits` only in seq order without gaps, and base64 exists only inside `sync-client`.

## Allowed dependencies

- May import: `@between-pages/contracts`, `@between-pages/collab`, React, React Router, TanStack Query; in `editor-binding`, `yjs` and `prosemirror-{model,state,view,transform,keymap}`; in `journal`, `yjs` (exact versions). Tests may use `fake-indexeddb` (dev only).
- Must not import: `apps/api` ([architecture](../../docs/architecture.md#dependency-direction)).
- Sub-modules (`verify-dependency-direction`): `editor-binding` and `journal` import none of the others; `sender` imports `journal`; `sync-client` imports `api`; `diary` imports those four, `api` and `auth`, and nothing imports it but `routes`; `auth` imports `api`; `pages` import `api` and `auth`; `routes` imports `auth`, `pages` and `diary`. The sender and the sync client meet only in `diary`.

## How to test

```sh
npx vitest run --project web
```

- Tier: component tests in jsdom with `@testing-library/react`, rendering the real `appRoutes` in a memory router (`test/render.tsx`); `fetch` is stubbed at the network boundary with contract-shaped responses. See [docs/testing.md](../../docs/testing.md#tiers).
- `editor-binding` tests drive a real view with DOM events (keys, paste, composition, `beforeinput`) and the transactions ProseMirror dispatches for typed text; every operation is checked with `packages/collab`'s `acceptBatch`, and the other author's edits arrive as its re-encoded deltas. No network. Tests carry `[adr:diary-collaboration-kernel#N]` for the invariant they verify.
- `journal` and `sender` tests run on `fake-indexeddb` with real Yjs updates and no editor; the sender's Web Locks are a stand-in with the browser's one-holder-per-name order, and its transport a stand-in server that remembers committed batches. `sync-client` tests replace `WebSocket` and `fetch` at the network boundary, parsing what the client sends with the strict contract schemas.
- `diary` tests run the real session and screen on the same stand-ins (`test/diary.ts`), with text entered through paste events and storage failure injected at `IDBObjectStore.put`.
- The root `e2e/diary.spec.ts` runs the screen in Chromium, Firefox and WebKit against the real API and PostgreSQL: SAVE-01/DATE-02, DATE-06, SYNC-04 (two devices of one account), SAVE-02 (written while disconnected, across a reload), SAVE-03 (lost ACK), SAVE-07/11 (refused batch to drafts) and read-only without Web Locks; socket failures are made with `routeWebSocket`.

## Known limitations

- No own history view, author colors, click for author and time, or "只看我的文字" yet (EDIT-13, EDIT-14, EDIT-16): the next part of kernel phase 3. `src/main.tsx` (excluded from coverage) only mounts providers and the router.
- Opening a diary while offline works only for one this device has stored; there is no offline list of diaries, and the page itself still needs the server to load (no service worker).
- Refused input typed one character at a time is stored as one draft per character; only the display groups it.
- Switching a diary to a new generation (reconcile pending, keep drafts, install the new baseline in one transaction) is kernel phase 4; until then `install` refuses another generation.
- The journal is not locked on sign-out yet.
- No remote cursors yet (kernel D8 cursors, phase 4).
- Dragging text into the editor is blocked rather than handled as a paste.
- Undo steps are Yjs's 500 ms capture groups, split whenever typing, deleting and replacing alternate.
- `operationId` uses `crypto.randomUUID`, so the app needs a secure context (HTTPS or localhost), as Web Locks will.
- Authorship checks walk the whole `Y.Text` on each deletion (`authorRuns`); fine at diary size, not tuned for very long documents.
- IME and paste are tested in jsdom; the browser suite types through Playwright's keyboard, not a real IME or clipboard.
- No screen for linking a second login method; the server supports it (ADR D3).
- Browser-level login and diary flows are covered by the root `e2e/` Playwright suite, not here; the browser suites under `prototypes/` remain the editor behavior baseline.
