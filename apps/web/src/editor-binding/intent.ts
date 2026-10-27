import type * as Y from 'yjs';

/** One contiguous change of an operation, in the text as it was before the operation. */
export type Change = { at: number; deleted: string; inserted: string };

/**
 * What the user meant by one change, kept for a recovery draft when the operation cannot
 * be committed (kernel ADR D7): only `text` of an insert and `inserted` of a replace are
 * the user's own new words; `before` and `after` are about 20 graphemes of the old text
 * around it, which may be the other person's and serve only to locate it.
 */
export type EditIntent =
  | { kind: 'insert'; text: string; before: string; after: string }
  | { kind: 'delete'; text: string; before: string; after: string }
  | { kind: 'replace'; deleted: string; inserted: string; before: string; after: string };

type Read = (from: number, to: number) => string;

/**
 * Reads the changes of one transaction from its `Y.Text` delta, which Yjs records from the
 * operations actually applied, so nothing is inferred by comparing whole texts. `read`
 * returns the text before the transaction.
 */
export function changesOf(delta: Y.YTextEvent['delta'], read: Read): Change[] {
  const changes: Change[] = [];
  let current: Change | undefined;
  let pos = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      current = undefined;
      pos += op.retain;
      continue;
    }
    if (!current) changes.push((current = { at: pos, deleted: '', inserted: '' }));
    if (op.delete !== undefined) {
      current.deleted += read(pos, pos + op.delete);
      pos += op.delete;
    }
    if (typeof op.insert === 'string') current.inserted += op.insert;
  }
  return changes;
}

const CONTEXT_GRAPHEMES = 20;
// Code units read around a change so that 20 clusters fit even when each is a long emoji.
const CONTEXT_WINDOW = CONTEXT_GRAPHEMES * 8;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function intentOf({ at, deleted, inserted }: Change, read: Read): EditIntent {
  const end = at + deleted.length;
  const before = clusters(read(Math.max(0, at - CONTEXT_WINDOW), at)).slice(-CONTEXT_GRAPHEMES);
  const after = clusters(read(end, end + CONTEXT_WINDOW)).slice(0, CONTEXT_GRAPHEMES);
  const context = { before: before.join(''), after: after.join('') };
  if (!deleted) return { kind: 'insert', text: inserted, ...context };
  if (!inserted) return { kind: 'delete', text: deleted, ...context };
  return { kind: 'replace', deleted, inserted, ...context };
}

function clusters(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}
