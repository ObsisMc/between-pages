# Engineering standards

How code in this repository is written. Each rule is one sentence you can check a diff against, followed by an example. Prettier and ESLint enforce formatting and lint; this file covers what tooling cannot see. Commands live in [AGENTS.md](../AGENTS.md#commands); test practice lives in [testing.md](testing.md).

## Ownership and coupling

**One owner per responsibility.** Exactly one module decides and mutates each piece of state. Diary text has one owner — the collaboration module — never a copy in TanStack Query or Zustand ([ADR-0006](adr/0006-formal-stack.md) §8).

**A new abstraction needs a responsibility nothing else holds.** Before adding a module, class or helper, name the existing owner you would otherwise extend and say why it cannot absorb the change.

**Dependencies point the way [architecture.md](architecture.md#dependency-direction) draws them.** `packages/*` never import `apps/*`; the two apps never import each other.

**Shapes that cross the wire are defined once, in `packages/contracts`.**

```ts
// Bad — the path and shape now live in two places and will drift
const res = await fetch('/api/health');
const body = (await res.json()) as { status: string };

// Good — method, path and parsing come from the shared contract
const body = await callApi('health');
```

**Fix invalid state at its producer.** Validate where untrusted data enters (request schema, update check, IndexedDB read, Google response) and trust typed values after that, instead of re-checking at every consumer.

```ts
// Bad — every reader re-checks, and the bad record still got stored
function authorOf(item: StoredChar) {
  return item.author ?? 'unknown';
}

// Good — the server check rejects updates without a bound author, so the type holds
const author = owners.get(item.id.client); // set by Authority.register before accept()
```

## Size and shape

**A function reads as its happy path.** Validation and edge cases move into named helpers below it.

**Do not extract a single-use helper preemptively.** Inline it unless it names a domain concept, is reused, or hides a genuinely complex boundary.

**A module over ~500 lines (tests excluded) is a candidate for splitting; over ~800 it must not grow further.** Move its tests and README section with the extracted code.

**Prefer early return to `else`.**

```ts
// Bad
function savedLabel(state: SaveState) {
  if (state.kind === 'committed') {
    return '已保存到服务器';
  } else {
    if (state.kind === 'local') return '仅本机保存';
    else return '保存失败';
  }
}

// Good
function savedLabel(state: SaveState) {
  if (state.kind === 'committed') return '已保存到服务器';
  if (state.kind === 'local') return '仅本机保存';
  return '保存失败';
}
```

## Comments

**A comment states something the code cannot: why, ownership, ordering, failure modes, a platform constraint, or the decision it follows.** Never what the code visibly does.

```ts
// Bad
// register the route
app.route({ ... });

// Good — names the ordering contract
// Ack only after COMMIT: a broadcast of uncommitted text could show the peer
// something a crash then loses (ADR-0003 §3).
await tx.commit();
socket.send(ack);
```

**A docstring states what is not in the signature** — failure modes, side effects, cost. If the signature says it all, no docstring.

**An empty or broad `catch` names the error and why swallowing it is correct**, and its `try` body is one statement.

**TODO markers name an owner or an issue**: `TODO(ray): …` or `TODO(#12): …`.

## Errors and failure

**Never report a state that has not happened.** "Saved" means committed in PG; "backed up" means both Google artifacts cover that version ([spec INV-07](diary-spec.md)). A failure keeps the user's text and says so.

**Every action has a visible outcome or a recorded intentional non-outcome.** A rejected update becomes a recovery draft plus a message, not a silent drop.

**Do not add retries, fallbacks or compatibility branches without a named consumer and a removal condition**, written in the comment.

## Types and data

**Trust the type system at typed same-process boundaries.** Runtime validation (Zod) belongs where data enters the process: HTTP, WebSocket, IndexedDB, environment, Google APIs.

**Identifiers are branded types, not bare strings**, once two kinds of ID meet in one signature.

```ts
// Bad
function openDiary(spaceId: string, diaryId: string) {}

// Good
type SpaceId = string & { readonly __brand: 'SpaceId' };
type DiaryId = string & { readonly __brand: 'DiaryId' };
function openDiary(spaceId: SpaceId, diaryId: DiaryId) {}
```

**No type laundering.** `as any`, `as unknown as T` or `@ts-expect-error` needs an adjacent one-line reason.

**Switch on discriminant tags; closed unions end in an exhaustiveness check.**

```ts
function label(state: SaveState): string {
  switch (state.kind) {
    case 'committed':
      return '已保存到服务器';
    case 'local':
      return '仅本机保存';
    case 'failed':
      return '保存失败';
    default:
      return state satisfies never;
  }
}
```

**Source is erasable TypeScript** (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties, so Node runs files directly. Use union types and `as const` objects.

## Naming

**Name the role that exists, not the pattern used.** `DiaryRepository` over `DiaryManager`; no `utils.ts`.

**Do not alias imports.** Consistent names across files let an agent grep.

**Reserved vocabulary** — each word means exactly this:

| Word | Meaning |
| --- | --- |
| space | The two-person membership unit (`spaceId`) |
| diary | One shared document for one `diaryDate` in a space |
| author | The user a character belongs to, derived on the server from the Yjs item ID, never from client input |
| committed / saved | Durably in PG, acknowledged by the server |
| pending | Applied locally, persisted in IndexedDB, not yet acknowledged |
| recovery draft | Local text the server refused, kept for the user to copy or retry |
| backup | A diary version present in both the Google Doc and the data snapshot |

## Dependencies

**Prefer a maintained dependency over hand-rolling when it genuinely deletes owned code and tests**; a dependency for one function is not worth its upgrade cost. Pin exact versions (`npm i -E`).

**Adding a dependency is an *ask first* action** ([AGENTS.md](../AGENTS.md#boundaries)): say what it replaces, its maintenance evidence, and its cost.

## Module READMEs

Every directory in `checks/modules.json` has a `README.md` with these headings, exact wording: `## Public surface`, `## Invariants`, `## Allowed dependencies`, `## How to test`, `## Known limitations` (`verify-module-readmes`). It is the module's contract, not a tour of its implementation.

## What this file is not

It does not repeat what Prettier and ESLint enforce, project commands (root `AGENTS.md`), or module contracts (each README). When a rule here becomes enforceable by a lint rule or a `checks/verify-*` script, add the check and delete the rule.
