# Testing

How this repository tests, tier by tier, and the rules that keep a green suite meaningful. Commands: [AGENTS.md](../AGENTS.md#commands).

## Tiers

| Tier | Runs | Proves | Location |
| --- | --- | --- | --- |
| Unit | `npx vitest run --project <name>` — every push | One module's contract in isolation | `*.test.ts` beside the code |
| Integration | same runner, `apps/api` project | The API through its real router (`app.inject()`), no socket | `apps/api/src/*.test.ts` |
| Component | same runner, `apps/web` project (jsdom) | Screens render and react to real contract responses | `apps/web/src/*.test.tsx` |
| Prototype baseline | `npm run test:prototypes` — every PR; PG/browser suites on demand | The validated collaboration behavior still holds | `prototypes/**/test/` (node:test, frozen) |
| End-to-end | None yet for the formal app | — | Playwright arrives with the first editor screen |

Coverage gate: `npm run test:coverage` fails under **80% lines** across `apps/*/src` and `packages/*/src` (process entry points excluded, see `vitest.config.ts`). Coverage proves lines ran, not that behavior is right — necessary, never sufficient. An uncovered line is often dead code to delete, not a test to bolt on.

Collaboration code carries a stricter bar than coverage: author protection, no silent text loss and honest "saved" state need the attack, fault and multi-client tests listed in [ADR-0002](adr/0002-collaboration-and-author-authorization.md) and [ADR-0006](adr/0006-formal-stack.md), mapped to [acceptance](acceptance.md) IDs.

## What must have a test

- **Any behavior change** — a test that fails on the old code and passes on the new. If you cannot make it fail first, you have not tested the change.
- **Any bug fix** — the regression test reproduces the defect through the entry point where it was observed (`app.inject`, the rendered screen, the browser), not a hand-built object that happens to hit the same line.
- **Any new public surface** listed in a module README, and every new contract route (served at its path, response parses).
- **Every server-side rejection rule** (foreign delete, forged author, missing dependency) — with an attack test that bypasses the UI.

## What must not have a test

- Statically defined values, constants and config defaults.
- Tests that mirror the implementation (assert that `f` calls `g`).
- Negative tests for logic that was removed.
- Reversible, low-impact changes where the test would only restate the diff — say so in the PR's Evidence section instead.

## Tagging ADR invariants

A test or `checks/verify-*` script that verifies a numbered invariant (`## 不变量`) of a dated ADR carries `[adr:<slug>#<n>]` in its title, e.g. `it('[adr:authentication-and-sessions#3] refuses a different subject with an existing email', …)`. The ADR index counts these markers as implementation progress ([docs/adr/README.md](adr/README.md#实施状态)); `verify-adr-tags` rejects markers that name no ADR or invariant. Keep the marker when renaming or moving the test.

## Mocks

Mock only the expensive or nondeterministic boundary — network, clock, Google APIs, external processes — and keep everything downstream real.

- In `apps/web`, stub `fetch` with responses the real API returns (`Response.json(...)` matching the contract), including failure statuses.
- In `apps/api`, use `buildApp()` + `app.inject()`; do not unit-test handlers pulled out of the router.
- PostgreSQL behavior (locks, unique constraints, transactions) is tested against a real disposable PG, never a mock — see `scripts/test-collab-postgres.sh` for the pattern.

## Verify the world, not the self-report

Assertions re-read state: re-query PG, re-render, re-parse the response with its schema. A test that checks a handler's own "success" log lets a no-op pass.

## Ownership and isolation

Tests run concurrently. Every test owns what it acquires — Fastify instances (`app.close()`), stubbed globals (`vi.unstubAllGlobals()`), DB rows, ports — and releases it in teardown, including on failure.

## Flaky tests

Fix them when you meet them: find the cause, repair it, verify the behavior. Do not add a retry, a longer timeout or a sleep; do not weaken the assertion; do not skip without an issue link and an owner. A retry hides a race; the race ships.

Known: the prototype browser test "firefox: peer caret stays anchored after insertion and vanishes on disconnect" timed out in one of eight Node 26 suite runs on 2026-10-24 and passed on both reruns. TODO(owner): investigate before porting caret behavior to the formal editor.

## Running subsets

```sh
npx vitest run --project api          # one module
npx vitest run -t "health route"      # one test by name
npx vitest --project web              # watch mode while editing
npm run test:prototypes               # prototype core suites (node:test)
```

Run the subset matching your change before committing. The full matrix is CI's job.
