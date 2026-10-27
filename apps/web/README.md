# @between-pages/web

The React single-page app (Vite, React Router, TanStack Query). Calls the API only through the typed client built on `@between-pages/contracts` ([ADR-0006](../../docs/adr/0006-formal-stack.md)). Diary code is split into the sub-modules of [kernel D11](../../docs/adr/2026-10-26-diary-collaboration-kernel.md); `editor-binding` exists so far.

## Public surface

| Export | Contract |
| --- | --- |
| `npm run dev -w @between-pages/web` | Vite dev server; proxies `/api` to the API on the repo-root `.env` `PORT` (default 3000), so the app is same-origin. |
| `npm run build -w @between-pages/web` | Static bundle in `dist/`. |
| `callApi(name, fetch?)` (`src/api/client.ts`) | The only way to call the API: method and path come from the contract, the response is parsed with its schema. Throws `ApiError` (with `status` and the contract error `code`, `INTERNAL` when the body is unreadable) on non-2xx and a Zod error on a shape mismatch. |
| `signIn(provider, loginHint?)`, `signOut()` (`src/api/auth.ts`) | Better Auth's sign-in and sign-out. `signIn` returns the provider URL; success returns to `/`, failure to `/login?error=<code>`. |
| `appRoutes` (`src/routes.tsx`) | `/login` (public; signed-in users go to `/`), `/` (behind `RequireAuth`), anything else → `/`. |
| `<RequireAuth>` (`src/auth/RequireAuth.tsx`), `useMe()` | Login state from the `['me']` query: loading → "正在打开…", 401 → `/login`, other errors → message and retry. A 401 is never retried. |
| `<LoginPage>` | Google button; Better Auth's `?error=` codes shown on the page; "开发登录" (name → mock issuer) only in dev builds (`import.meta.env.DEV`). |
| `<HomePage>` | Placeholder: "已登录为 {name}" and sign-out, which clears the query cache before going to `/login`. |
| `createEditorBinding(place, { userId, onOperation, onRefuse })` (`src/editor-binding`) | A ProseMirror view in `place` bound to a new `Y.Text('body')` (`createDiaryDoc`) for one diary generation; a new generation needs a new binding (kernel D4, D8). Returns `{ view, applyUpdate(update, bindings), destroy() }`. `applyUpdate` applies committed deltas or an earlier instance's pending operations with the bindings naming their authors, and throws on text whose clientID has none. |
| `EditorOperation` | Emitted synchronously, in order, for every local change (a keystroke, a confirmed IME composition, a paste, an undo step): `{ operationId, update, writtenAt, intent }`. `update` is one Yjs transaction as the `update` event emits it; `writtenAt` is its write session's start, which continues while typing or deleting goes on at the caret with pauses under 30 s (D13); `intent` lists its contiguous changes as `insert` / `delete` / `replace` with about 20 graphemes of context for recovery drafts (D7). |
| `Refusal` | `onRefuse` reasons; the text is left unchanged: `FOREIGN_TEXT`, `PASTE_TOO_LARGE` (the clipboard is untouched), `CONTROL_CHARACTER`. |

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

## Allowed dependencies

- May import: `@between-pages/contracts`, `@between-pages/collab`, React, React Router, TanStack Query; in `editor-binding`, `yjs` and `prosemirror-{model,state,view,transform,keymap}` (exact versions).
- Must not import: `apps/api` ([architecture](../../docs/architecture.md#dependency-direction)).
- Sub-modules (`verify-dependency-direction`): `editor-binding` imports none of the others; `auth` imports `api`; `pages` import `api` and `auth`; `routes` imports `auth` and `pages`.

## How to test

```sh
npx vitest run --project web
```

- Tier: component tests in jsdom with `@testing-library/react`, rendering the real `appRoutes` in a memory router (`test/render.tsx`); `fetch` is stubbed at the network boundary with contract-shaped responses. See [docs/testing.md](../../docs/testing.md#tiers).
- `editor-binding` tests drive a real view with DOM events (keys, paste, composition, `beforeinput`) and the transactions ProseMirror dispatches for typed text; every operation is checked with `packages/collab`'s `acceptBatch`, and the other author's edits arrive as its re-encoded deltas. No network. Tests carry `[adr:diary-collaboration-kernel#N]` for the invariant they verify.

## Known limitations

- No diary screen yet: the editor binding is not mounted anywhere, and the journal, sender and sync client of kernel phase 3 do not exist; `src/main.tsx` (excluded from coverage) only mounts providers and the router.
- The editor shows no author colors or remote cursors yet (EDIT-13, kernel D8 cursors); "只看本人" and history views do not exist.
- Dragging text into the editor is blocked rather than handled as a paste.
- Undo steps are Yjs's 500 ms capture groups, split whenever typing, deleting and replacing alternate.
- `operationId` uses `crypto.randomUUID`, so the app needs a secure context (HTTPS or localhost), as Web Locks will.
- Authorship checks walk the whole `Y.Text` on each deletion (`authorRuns`); fine at diary size, not tuned for very long documents.
- IME, native typing and paste are tested in jsdom; real-browser acceptance in Chromium, Firefox and WebKit belongs to the phase-3 browser suite.
- No screen for linking a second login method; the server supports it (ADR D3).
- Browser-level login flows are covered by the root `e2e/` Playwright suite (E1-E6), not here; the browser suites under `prototypes/` remain the editor behavior baseline.
