import { authorRuns, type ClientBindings } from '@between-pages/collab';
import type * as Y from 'yjs';

/** Visible text as consecutive `[start, end)` index spans, each written by one person. */
export type Span = { start: number; end: number; own: boolean };

/** Every visible clientID must be in `bindings` (`authorRuns` throws otherwise). */
export function spansOf(doc: Y.Doc, bindings: ClientBindings, userId: string): Span[] {
  let offset = 0;
  return authorRuns(doc, bindings).map(({ author, text }) => {
    const start = offset;
    offset += text.length;
    return { start, end: offset, own: author === userId };
  });
}

export function ownsRange(spans: readonly Span[], from: number, to: number): boolean {
  return spans.every((span) => span.end <= from || span.start >= to || span.own);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Longer than any grapheme cluster a keyboard produces (a family emoji is 11 code units),
// so segmenting a window this wide around the caret finds the whole cluster.
const GRAPHEME_WINDOW = 64;

type Read = (from: number, to: number) => string;

/** What one Backspace (-1) or Delete (1) does: remove a range, move the caret, or nothing. */
export type Erase = { from: number; to: number } | { caret: number } | undefined;

/**
 * Removes the adjacent grapheme cluster when every code unit of it is the user's own, so
 * emoji and combining marks are never split (EDIT-10). Next to the other person's text it
 * deletes nothing and moves the caret past it to the nearest own cluster, or to the
 * document edge (EDIT-04).
 */
export function erase(
  spans: readonly Span[],
  read: Read,
  length: number,
  caret: number,
  direction: -1 | 1,
): Erase {
  let pos = caret;
  for (;;) {
    const cluster = direction < 0 ? clusterBefore(read, pos) : clusterAfter(read, length, pos);
    if (!cluster) return pos === caret ? undefined : { caret: pos };
    const [from, to] = cluster;
    if (ownsRange(spans, from, to)) return pos === caret ? { from, to } : { caret: pos };
    pos = direction < 0 ? from : to;
  }
}

function clusterBefore(read: Read, index: number): [number, number] | undefined {
  if (index <= 0) return undefined;
  const start = Math.max(0, index - GRAPHEME_WINDOW);
  const last = [...segmenter.segment(read(start, index))].at(-1)!;
  return [start + last.index, index];
}

function clusterAfter(read: Read, length: number, index: number): [number, number] | undefined {
  if (index >= length) return undefined;
  const first = segmenter.segment(read(index, index + GRAPHEME_WINDOW)).containing(0)!;
  return [index, index + first.segment.length];
}
