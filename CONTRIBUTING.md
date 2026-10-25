# Contributing

## Setup

Requires Node.js 26 (`.nvmrc`) and, for PostgreSQL suites, Docker.

```sh
nvm use            # or install Node 26 another way
npm ci             # installs dependencies and the git hooks
cp .env.example .env
npm run db:up      # local PostgreSQL 18 (compose.yaml)
npm run db:migrate
npm run dev:oidc   # mock login issuer on 127.0.0.1:4010 (no Google account needed)
npm run dev:api    # API on 127.0.0.1:3000
npm run dev:web    # Vite dev server; proxies /api to the API
```

`npm ci` also enables the tracked hooks (`prepare` → `checks/install-hooks.ts` sets `core.hooksPath=.githooks`); there is no separate step. The hooks run Prettier and ESLint on the staged files and check each commit message; a failing hook aborts the commit. `npm run check` refuses to run until the hooks are installed.

Do not bypass with `--no-verify`. The chain is: hooks stop the mistake, CI re-runs the same checks so a bypass still fails the PR, and branch protection blocks the merge.

Day-to-day commands: [AGENTS.md#commands](AGENTS.md#commands).

## Branches

`<type>/<short-topic>`, using a commit type: `feat/diary-creation`, `fix/reconnect-pending`, `docs/auth-adr`, `chore/project-init`. Branch from `main`.

## Commits

Format: `type(scope)!: description` — [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

- `type`: one of [`checks/commit-types.json`](checks/commit-types.json) (that file is authoritative).
- `scope` (optional): the module or area — `api`, `web`, `contracts`, `checks`, `docs`, `prototypes`.
- `description`: imperative, lowercase start, no trailing period; the whole subject at most 72 characters.
- Body (optional, after one blank line) explains *why* when the diff does not.
- Breaking change: `type(scope)!: description` and/or a `BREAKING CHANGE: …` footer.

```
feat(api): add diary creation endpoint
fix(web): keep pending text when the server rejects an update
docs(adr): record the session storage decision
refactor(contracts)!: rename health route to status
```

The `commit-msg` hook rejects a non-conforming message. CI's `commit-convention` job checks every non-merge commit in the PR, because PRs are merged with a **merge commit** (no squash), so each commit lands on `main` as written.

## Pull requests

- One PR per independent change; split a refactor from the feature that needed it.
- Title follows the commit format.
- Fill the template: **Problem**, **Change**, **Evidence** (every check you ran with its result, and every check you did not run with why), **Docs** (which READMEs / ADRs changed, or why none), **Decision** (ADR link or "none needed").
- If module code changed without a contract change, add the `docs-not-needed` label and say why in the Docs section; otherwise `docs-gates` fails.

## Running the checks locally

```sh
npm run check -- docs      # module READMEs, links, ADR format, AGENTS.md budget, OpenAPI freshness
npm run check -- pairs     # module code changed ⇒ its README changed (vs origin/main)
npm run check -- commits   # commit messages on this branch vs origin/main
npm run check -- stack     # format, lint, typecheck, tests with coverage, prototype suites
npm run check -- all       # everything CI runs
```

`pairs` and `commits` accept a range as the next argument (`npm run check -- commits HEAD~3..HEAD`). CI runs the same entry point; see `.github/workflows/ci.yml`.

## Documentation

Every behavior change updates the owning module's README in the same commit. Product documents (`docs/diary-spec.md`, `docs/acceptance.md`, ADRs) are in Chinese; engineering documents and module READMEs are in English, with no translated pairs.

Design choices get an ADR in [docs/adr/](docs/adr/README.md). Escaped bugs that clear the bar get a [postmortem](docs/postmortem/README.md).

## Dependencies

Adding one is an *ask first* action: say what it replaces, its maintenance evidence and its cost. Install with an exact version (`npm i -E <pkg>@<version>`, `-w <workspace>` for a workspace) so the lockfile stays consistent; never hand-edit dependency versions.

## Security

Never commit secrets, tokens or real diary content — including in tests, fixtures and logs. Use `.env` (ignored) with `.env.example` as the template; test data is fictional. Report vulnerabilities privately to the repository owner, not in a public issue.
