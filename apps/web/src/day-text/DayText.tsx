import type { Ref } from 'react';
import type { TextRun } from './decode.ts';
import { MarginBars } from './margin-bars.tsx';
import './day-text.css';

/** A passage by text index, `[from, to)`, sorted and disjoint. */
export type Passage = { from: number; to: number };

type Mark = 'unread' | 'kept';
type Marked = Passage & { mark: Mark };
type Segment = { run: TextRun; from: number; to: number; mark: Mark | null };

const MARK_CLASS: Record<Mark, string> = { unread: 'day-text-unread', kept: 'day-text-kept' };

/** The runs cut where marked passages start and end, so each piece is wholly one kind. */
function segmentsOf(runs: readonly TextRun[], marked: readonly Marked[]): Segment[] {
  const segments: Segment[] = [];
  let next = 0;
  for (const run of runs) {
    const end = run.index + run.text.length;
    for (let from = run.index; from < end;) {
      while (next < marked.length && marked[next]!.to <= from) next++;
      const passage = marked[next];
      const inside = !!passage && passage.from <= from;
      const to = inside ? Math.min(end, passage.to) : Math.min(end, passage?.from ?? end);
      segments.push({ run, from, to, mark: inside ? passage.mark : null });
      from = to;
    }
  }
  return segments;
}

/** Both kinds of passage in text order; a character unread is never also kept. */
const markedOf = (unread: readonly Passage[], kept: readonly Passage[]): Marked[] =>
  [
    ...unread.map((p) => ({ ...p, mark: 'unread' as const })),
    ...kept.map((p) => ({ ...p, mark: 'kept' as const })),
  ].sort((a, b) => a.from - b.from);

/**
 * One diary's text, read-only, each author's characters in their color (EDIT-13) and the
 * reader's unread passages marked (unread-and-day-page D2, the in-diary rule), and the
 * passages read during this visit marked light (`kept`, read-marks-until-leaving D1). Both
 * are `<mark>` pieces, so a piece read while it is shown stays the same element and keeps
 * what was set on it, such as a jump's flash. Every piece carries its clientID and first
 * clock; the other person's also `data-other`, which is what `visibleOthers` measures for
 * the read tracker. No editor, session or socket.
 */
export function DayText({
  runs,
  readerId,
  authorClass,
  unread = [],
  kept = [],
  rootRef,
}: {
  runs: readonly TextRun[];
  readerId: string;
  /** The class that colors an author's text; empty for none. */
  authorClass: (author: string) => string;
  unread?: readonly Passage[];
  /** Read during this visit; disjoint from `unread`. */
  kept?: readonly Passage[];
  rootRef?: Ref<HTMLDivElement>;
}) {
  return (
    <>
      <MarginBars />
      <div className="day-text" ref={rootRef}>
        {segmentsOf(runs, markedOf(unread, kept)).map(({ run, from, to, mark }) => {
          const Piece = mark ? 'mark' : 'span';
          return (
            <Piece
              key={from}
              className={[authorClass(run.author), mark ? MARK_CLASS[mark] : '']
                .filter(Boolean)
                .join(' ')}
              data-client={run.client}
              data-clock={run.clock + from - run.index}
              data-other={run.author === readerId ? undefined : ''}
            >
              {run.text.slice(from - run.index, to - run.index)}
            </Piece>
          );
        })}
      </div>
    </>
  );
}
