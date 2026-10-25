# @between-pages/web

The React single-page app (Vite, React Router, TanStack Query). Calls the API only through the typed client built on `@between-pages/contracts` ([ADR-0006](../../docs/adr/0006-formal-stack.md)).

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

## Invariants

- No `fetch('/api/...')` outside `src/api/client.ts` and `src/api/auth.ts`. `auth.ts` is the single exception, because Better Auth's endpoints are not in the contract ([authentication-and-sessions](../../docs/adr/2026-10-24-authentication-and-sessions.md) D9); everything else goes through `callApi`.
- Production builds contain no development login (it sits behind `import.meta.env.DEV`).
- Server data lives in TanStack Query; diary text will live only in the collaboration module, never in Query or Zustand ([ADR-0006](../../docs/adr/0006-formal-stack.md) §8).

## Allowed dependencies

- May import: `@between-pages/contracts`, React, React Router, TanStack Query.
- Must not import: `apps/api` ([architecture](../../docs/architecture.md#dependency-direction)).

## How to test

```sh
npx vitest run --project web
```

- Tier: component tests in jsdom with `@testing-library/react`, rendering the real `appRoutes` in a memory router (`test/render.tsx`); `fetch` is stubbed at the network boundary with contract-shaped responses. See [docs/testing.md](../../docs/testing.md#tiers).

## Known limitations

- No editor or diary screens yet; `src/main.tsx` (excluded from coverage) only mounts providers and the router.
- No screen for linking a second login method; the server supports it (ADR D3).
- No Playwright tests for the formal app yet; the browser suites under `prototypes/` remain the editor behavior baseline.
