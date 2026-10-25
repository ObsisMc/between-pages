# @between-pages/web

The React single-page app (Vite, React Router, TanStack Query). Calls the API only through the typed client built on `@between-pages/contracts` ([ADR-0006](../../docs/adr/0006-formal-stack.md)).

## Public surface

| Export | Contract |
| --- | --- |
| `npm run dev -w @between-pages/web` | Vite dev server; proxies `/api` to the API on the repo-root `.env` `PORT` (default 3000), so the app is same-origin. |
| `npm run build -w @between-pages/web` | Static bundle in `dist/`. |
| `callApi(name, fetch?)` (`src/api/client.ts`) | The only way to call the API: method and path come from the contract, the response is parsed with its schema. Throws `ApiError` (with `status` and the contract error `code`, `INTERNAL` when the body is unreadable) on non-2xx and a Zod error on a shape mismatch. |
| `<App />` (`src/App.tsx`) | Root screen; currently shows API reachability. |

## Invariants

- No `fetch('/api/...')` outside `src/api/client.ts`; every call goes through `callApi`.
- Server data lives in TanStack Query; diary text will live only in the collaboration module, never in Query or Zustand ([ADR-0006](../../docs/adr/0006-formal-stack.md) §8).

## Allowed dependencies

- May import: `@between-pages/contracts`, React, React Router, TanStack Query.
- Must not import: `apps/api` ([architecture](../../docs/architecture.md#dependency-direction)).

## How to test

```sh
npx vitest run --project web
```

- Tier: component tests in jsdom with `@testing-library/react`; `fetch` is stubbed at the network boundary. See [docs/testing.md](../../docs/testing.md#tiers).

## Known limitations

- No editor, login or diary screens yet; `src/main.tsx` (excluded from coverage) only mounts providers and the router.
- No Playwright tests for the formal app yet; the browser suites under `prototypes/` remain the editor behavior baseline.
