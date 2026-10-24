# Postmortems

A postmortem records a bug that reached `main` (a merged PR) or, later, a release, and the interesting part is **why every safety net missed it**, not the one-line fix. It is the only document tier where narrative belongs.

A postmortem is not a [decision record](../adr/README.md): decisions look forward, postmortems look back.

## When to write one

All four must hold:

1. **Escaped** — it reached `main` or a release. A bug found and fixed before merging does not qualify.
2. **Subtle** — the mechanism is non-obvious; a careful engineer would re-derive it the hard way.
3. **Systemic** — it got through because of a gap in tests, tooling or conventions, not a one-off slip.
4. **Costly to rediscover** — it cost real debugging time and would again.

Policy for agents: **ask** — after fixing a bug that clears the bar, state which criteria it meets and ask before writing.

Most bugs do not clear the bar. Fix, test, move on. Any bug that lost or misattributed diary text, or reported "saved" falsely, is presumed to clear it.

## File

- Location: this directory. Name: `YYYY-MM-DD-kebab-short-title.md`.
- Title: a declarative conclusion — "A stale snapshot overwrote pending text after reconnect" — never "Notes on X".
- Cite elsewhere by slug: `postmortem: stale-snapshot-overwrote-pending-text`.
- Register it in the index below.

## Required sections, in order

1. `## Executive summary` — what broke, root cause in plain terms, why it escaped, the durable lesson; one paragraph.
2. `## Summary` — full context, then `## Impact` when known.
3. `## Timeline` — the investigation sequence and its evidence, citing PRs.
4. `## Root cause` — the mechanism, with a minimal code block showing the broken and fixed forms.
5. `## Why every test missed it` — for each net (unit, integration, browser, prototype baseline, lint, review, docs): what it checked and why that was not enough.
6. `## Guardrails added` — concrete defenses with file paths.
7. `## Lessons` — durable principles, one per bullet.

## Guardrails

A defense counts only if something fires it automatically. Work down this order and stop as early as possible; give every guardrail its file path and back-link this postmortem's slug from that file.

| Order | Form | When |
| --- | --- | --- |
| 1 | **Test** in the file that already covers the code, through the real entry path | The invariant is one execution |
| 2 | **`checks/verify-<thing>.ts`**: one invariant, non-zero exit, names the location and the fix command; registered in a group in `checks/check.ts` | The invariant spans files or is structural |
| 3 | **Hook** in `.githooks/`, fast and staged-only | The mistake is cheap to catch at commit time |
| 4 | **One line in `AGENTS.md`**, linking here | Nothing above can express it |

Never write "be more careful" or "review more thoroughly" — they cannot fail.

## Index

| Date | Title |
| --- | --- |
| none yet | |
