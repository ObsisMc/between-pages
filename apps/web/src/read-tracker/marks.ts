import type { ReadRange } from '@between-pages/contracts';
import { coverageOf, difference, intersection, rangesOf, union, type Coverage } from './ranges.ts';
import type { VisibleRun } from './read-tracker.ts';

/**
 * What one visit to the diary page keeps of the reader's reading there
 * (read-marks-until-leaving D1–D3): per diary, the other person's characters this page
 * reported read during the visit, which stay marked light until the visit ends. In memory
 * only, never stored or sent (invariant 5); whoever holds it decides how long a visit is.
 */
export type ReadMarks = {
  /** The characters of `diaryId` this page turned from unread to read during the visit. */
  kept(diaryId: string): readonly ReadRange[];
  /** Hears every change to what is kept; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The tracker learned the reader's coverage of `diaryId` (`readRanges` or a report's answer). */
  learned(diaryId: string, ranges: readonly ReadRange[]): void;
  /**
   * A report of `sent` succeeded with the server's whole coverage `answer`: what of `sent`
   * the page did not know was read before is kept, unless it knew nothing of this diary yet
   * (D1: fewer marks rather than old text marked as new).
   */
  reported(diaryId: string, sent: readonly ReadRange[], answer: readonly ReadRange[]): void;
};

const NONE: readonly ReadRange[] = [];

export function createReadMarks(): ReadMarks {
  /** Every coverage this page was told of, per diary, since the visit began. */
  const known = new Map<string, Coverage>();
  /** The kept characters per diary; a new array on each change, so a render can compare. */
  const kept = new Map<string, readonly ReadRange[]>();
  const listeners = new Set<() => void>();

  const learn = (diaryId: string, ranges: readonly ReadRange[]) =>
    known.set(diaryId, union(known.get(diaryId) ?? new Map(), coverageOf(ranges)));

  return {
    kept: (diaryId) => kept.get(diaryId) ?? NONE,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    learned: learn,
    reported(diaryId, sent, answer) {
      const before = known.get(diaryId);
      learn(diaryId, answer);
      if (!before) return;
      const fresh = difference(coverageOf(sent), before);
      if (!fresh.size) return;
      kept.set(diaryId, rangesOf(union(coverageOf(kept.get(diaryId) ?? NONE), fresh)));
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The other person's text that a live broadcast brought into view and that is not read yet
 * (read-marks-until-leaving D5): drawn light at once, though still unread, so watching
 * them write never lights each new character solid first. One per open diary.
 */
export type Arrivals = {
  /** A live commit inserted `inserted`; what of it is in `visible` now is drawn light. */
  arrived(inserted: readonly VisibleRun[], visible: readonly VisibleRun[]): void;
  /**
   * Keeps only what is still in `visible` and not `read`: text that left view unread is
   * solid again, and text read is kept by `ReadMarks` instead. True when anything changed.
   */
  settle(visible: readonly VisibleRun[], read: readonly ReadRange[] | null): boolean;
  /** What is drawn light now. */
  light(): readonly ReadRange[];
};

const coverageOfRuns = (runs: readonly VisibleRun[]) =>
  coverageOf(runs.map((r) => ({ clientId: r.client, from: r.clock, to: r.clock + r.length })));

export function createArrivals(): Arrivals {
  let light: Coverage = new Map();
  let ranges: readonly ReadRange[] = NONE;
  return {
    arrived(inserted, visible) {
      const seen = intersection(coverageOfRuns(inserted), coverageOfRuns(visible));
      if (!seen.size) return;
      light = union(light, seen);
      ranges = rangesOf(light);
    },
    settle(visible, read) {
      if (!light.size) return false;
      const next = difference(intersection(light, coverageOfRuns(visible)), coverageOf(read ?? []));
      const was = ranges;
      light = next;
      ranges = rangesOf(next);
      return JSON.stringify(was) !== JSON.stringify(ranges);
    },
    light: () => ranges,
  };
}
