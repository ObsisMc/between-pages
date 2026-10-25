# AGENTS.md

Between Pages is a shared diary for two people: each character has an immutable author, and each person may only change their own text. Read [docs/architecture.md](docs/architecture.md) before changing anything under `apps/` or `packages/`; read the affected module's `README.md` before editing it. Product rules: [docs/diary-spec.md](docs/diary-spec.md); stack: [ADR-0006](docs/adr/0006-formal-stack.md).

## Layout

| Path | Owns |
| --- | --- |
| `apps/api/` | Fastify API, OpenAPI generation (`openapi.json` is generated) |
| `apps/web/` | React app and the typed API client |
| `packages/contracts/` | Zod schemas and the route table both apps use |
| `prototypes/` | Frozen behavior baseline for collaboration; do not edit or import |
| `docs/` | Spec, acceptance, ADRs, standards ([index](docs/README.md)) |
| `checks/` | Verify scripts; `npm run check -- <group>` runs them |

## Commands

```sh
nvm use && npm ci                 # Node 26; also installs the git hooks
npm run format:check              # fix with: npm run format
npm run lint                      # fix with: npx eslint --fix <file>
npm run typecheck
npx vitest run --project <name>   # contracts | api | web — one module
npm run openapi                   # after any contract or route change
npm run db:generate -- --name <x> # after any change to apps/api/src/db/schema.ts
npm run test:db                   # all tests incl. *.db.test.ts on a disposable PostgreSQL
npm run check -- docs             # module READMEs, links, ADR format, budget, OpenAPI freshness
npm run check -- all              # everything CI runs, locally
```

Run the subset that matches what you changed; CI owns the full matrix. PostgreSQL and browser prototype suites (`npm run test:pg:docker`, `npm run test:browser`) need Docker and Playwright browsers — run them when touching collaboration behavior.

## Definition of Done

A task is complete when every line below is true. Check them before reporting; report the ones you could not satisfy by name.

**Before changing**
- Read the module's `README.md`. Its *Invariants* and *Allowed dependencies* sections are constraints.
- Bug fix: reproduce through the real entry point (`app.inject()`, the rendered screen, a browser) before editing.
- Before deleting or restoring code that looks odd: `grep -rn <symbol> docs/adr/` and `git log -S <symbol>`.

**While changing**
- One owner per responsibility; extend the existing owner unless the new code holds a responsibility nothing else does. Fix invalid state at its producer.
- Comments state contracts and reasons, never what the code does ([standards](docs/engineering-standards.md#comments)).
- No parameter, config key or compatibility branch without a current consumer you can name.
- Prefer the smallest production diff; unrelated cleanup is a separate commit.
- Wire shapes live only in `packages/contracts`; the web app calls the API only through `callApi`.
- Author and "saved" state come from the server, never from client input or before PG commit ([ADR-0003](docs/adr/0003-postgres-and-durable-commit.md), [ADR-0006](docs/adr/0006-formal-stack.md)).

**After changing** — each line is checked by CI
- Behavior changed ⇒ the module README's *Public surface* / *Invariants* / *Known limitations* updated in the same commit. `verify-doc-pairs` fails the PR otherwise; bypass only with the `docs-not-needed` label and a reason in the PR.
- Contract or route changed ⇒ `npm run openapi` and commit `apps/api/openapi.json`. `verify-openapi-current`.
- A choice another agent might re-litigate ⇒ an ADR in [docs/adr/](docs/adr/README.md). `verify-decision-format` checks the form.
- Changing an existing decision ⇒ a new ADR that supersedes it, plus its line in [architecture.md](docs/architecture.md#current-decisions); never rewrite an accepted ADR's body (`verify-adr-immutable`).
- Meaningful behavior ⇒ a test that fails before and passes after, at the tier [docs/testing.md](docs/testing.md) names. No tests for static values or that mirror the implementation. Coverage gate: 80% lines on `apps/*/src` and `packages/*/src`.
- Format, lint, typecheck and the relevant test subset ran; the PR's *Evidence* section lists what ran and what did not.
- Commits: Conventional Commits `type(scope)!: description` — see [CONTRIBUTING.md](CONTRIBUTING.md#commits). PRs merge with a merge commit, so every commit must conform; the hook and the `commit-convention` job enforce it.
- A bug that reached `main` and clears the [postmortem bar](docs/postmortem/README.md#when-to-write-one) ⇒ say which criteria it meets and ask before writing one.

## Boundaries

- ✅ Always: run `npm run format` before committing; put tests beside the code (`*.test.ts(x)`); keep secrets, tokens and real diary text out of commits, fixtures and logs.
- ⚠️ Ask first: database schema or migration changes; new dependencies (pin exact versions); deleting a public export; changing CI, hooks, `checks/` or this file's budget; anything under `prototypes/`.
- 🚫 Never: `--no-verify`; weakening an assertion, widening a mock, or adding a retry or sleep to make a test pass; editing `apps/api/openapi.json` by hand; force-pushing shared branches; accepting a client-supplied author, actor or raw update without the server check.

## Read when relevant

- Architecture and dependency direction → [docs/architecture.md](docs/architecture.md)
- Code practice with examples → [docs/engineering-standards.md](docs/engineering-standards.md)
- Test tiers, mocks, flakes → [docs/testing.md](docs/testing.md)
- Decisions → [docs/adr/](docs/adr/README.md) · Postmortems → [docs/postmortem/](docs/postmortem/README.md)
- Acceptance IDs to cite in tests and PRs → [docs/acceptance.md](docs/acceptance.md)
- Branches, commits, PRs → [CONTRIBUTING.md](CONTRIBUTING.md)

## Maintaining this file

- An agent made the same mistake twice ⇒ add one line here with a link to the explanation, not a paragraph.
- A rule became enforced by a check or linter ⇒ delete it here; the check is its home.
- `verify-agents-md-budget` red ⇒ relocate, then condense, then raise the ceiling with the reason in the PR.
- Rules for one directory go in that directory's `AGENTS.md`.
