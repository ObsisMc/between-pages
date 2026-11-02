import type { Ref } from 'react';
import type { TextRun } from './decode.ts';
import './day-text.css';

/** A passage by text index, `[from, to)`, sorted and disjoint. */
export type Passage = { from: number; to: number };

type Segment = { run: TextRun; from: number; to: number; unread: boolean };

/** The runs cut where unread passages start and end, so each piece is wholly one or the other. */
function segmentsOf(runs: readonly TextRun[], unread: readonly Passage[]): Segment[] {
  const segments: Segment[] = [];
  let next = 0;
  for (const run of runs) {
    const end = run.index + run.text.length;
    for (let from = run.index; from < end;) {
      while (next < unread.length && unread[next]!.to <= from) next++;
      const passage = unread[next];
      const inside = !!passage && passage.from <= from;
      const to = inside ? Math.min(end, passage.to) : Math.min(end, passage?.from ?? end);
      segments.push({ run, from, to, unread: inside });
      from = to;
    }
  }
  return segments;
}

/**
 * One diary's text, read-only, each author's characters in their color (EDIT-13) and the
 * reader's unread passages marked (unread-and-day-page D2, the in-diary rule). Every piece
 * carries its clientID and first clock; the other person's also `data-other`, which is
 * what `visibleOthers` measures for the read tracker. No editor, session or socket.
 */
export function DayText({
  runs,
  readerId,
  authorClass,
  unread = [],
  rootRef,
}: {
  runs: readonly TextRun[];
  readerId: string;
  /** The class that colors an author's text; empty for none. */
  authorClass: (author: string) => string;
  unread?: readonly Passage[];
  rootRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="day-text" ref={rootRef}>
      {segmentsOf(runs, unread).map(({ run, from, to, unread: marked }) => {
        const Piece = marked ? 'mark' : 'span';
        return (
          <Piece
            key={from}
            className={[authorClass(run.author), marked ? 'day-text-unread' : '']
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
  );
}
