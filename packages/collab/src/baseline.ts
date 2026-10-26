import * as Y from 'yjs';
import { BODY } from './doc.ts';

export type BaselineProblem = 'DELETED_CONTENT_RETAINED' | 'TEXT_CHANGED';

export type BaselineResult =
  { ok: true; baseline: Uint8Array } | { ok: false; problem: BaselineProblem };

/**
 * Builds the clean baseline a new generation starts from (kernel ADR D4): the committed
 * state is loaded into an isolated document that collects garbage, so deleted text
 * becomes content-free placeholders while every item keeps its original ID. A failed
 * self-check is a build failure (`SHARE_OPEN_FAILED`); the caller hashes the baseline
 * only after it passes.
 *
 * Merging the baseline into an existing instance does not erase what that instance
 * already holds; every instance must be replaced by one loaded from the baseline.
 */
export function buildBaseline(committed: Uint8Array): BaselineResult {
  const isolated = new Y.Doc({ gc: true });
  Y.applyUpdate(isolated, committed);
  const baseline = Y.encodeStateAsUpdate(isolated);
  const problem = verifyBaseline(committed, baseline);
  return problem ? { ok: false, problem } : { ok: true, baseline };
}

/**
 * The self-check run before a baseline is installed (invariant 18): every deleted item
 * carries only `ContentDeleted`, and the visible text equals the source's.
 */
export function verifyBaseline(source: Uint8Array, baseline: Uint8Array): BaselineProblem | null {
  const { structs, ds } = Y.decodeUpdate(baseline);
  for (const struct of structs) {
    if (!(struct instanceof Y.Item) || struct.content instanceof Y.ContentDeleted) continue;
    const { client, clock } = struct.id;
    const deleted = ds.clients.get(client) ?? [];
    if (
      deleted.some(
        (range) => range.clock < clock + struct.length && clock < range.clock + range.len,
      )
    )
      return 'DELETED_CONTENT_RETAINED';
  }
  if (visibleText(source) !== visibleText(baseline)) return 'TEXT_CHANGED';
  return null;
}

function visibleText(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText(BODY).toString();
}
