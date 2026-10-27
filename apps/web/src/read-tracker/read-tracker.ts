import type { ReadRange } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { coverageOf, difference, intersection, rangesOf, union, type Coverage } from './ranges.ts';

// Reports what the reader actually saw (kernel D15): characters someone else wrote that
// stayed on a visible page for about a second. Only the reader's own progress is kept,
// on the server, merged across devices by character identity; nobody else learns of it.

/** How long text must stay on a visible page to count as read. */
export const DWELL_MS = 1_000;

/** The contract's cap per report; the rest goes with the next check. */
const MAX_RANGES = 1000;

/** Characters of one clientID: `length` from `clock` on, as the editor binding gives them. */
export type VisibleRun = { client: number; clock: number; length: number };

export type ReadTrackerOptions = {
  diaryId: string;
  /** The other person's characters on screen now; empty when none or nothing is shown. */
  visible: () => VisibleRun[];
};

export type ReadTracker = { stop(): void };

const coverageOfRuns = (runs: readonly VisibleRun[]) =>
  coverageOf(runs.map((r) => ({ clientId: r.client, from: r.clock, to: r.clock + r.length })));

/**
 * Text the reader has not read: what is visible now minus what they read on any device.
 * Deleted text is not visible, so it never counts; text typed again is new characters, so
 * it does (kernel D15 table).
 */
export function unread(visible: readonly VisibleRun[], read: readonly ReadRange[]): ReadRange[] {
  return rangesOf(difference(coverageOfRuns(visible), coverageOf(read)));
}

/** Checks every DWELL_MS; text seen on two checks in a row on a visible page is reported. */
export function createReadTracker({ diaryId, visible }: ReadTrackerOptions): ReadTracker {
  let reported: Coverage = new Map();
  let previous: Coverage = new Map();
  let sending = false;

  // Seeds what is already read, so it is not reported again; a failure only costs repeats.
  callApi('readRanges', { params: { diaryId } })
    .then(({ ranges }) => (reported = union(reported, coverageOf(ranges))))
    .catch(() => undefined);

  async function tick() {
    if (document.visibilityState !== 'visible') {
      previous = new Map();
      return;
    }
    const now = coverageOfRuns(visible());
    const seen = difference(intersection(now, previous), reported);
    previous = now;
    const ranges = rangesOf(seen).slice(0, MAX_RANGES);
    if (!ranges.length || sending) return;
    sending = true;
    try {
      const answer = await callApi('reportRead', { params: { diaryId }, body: { ranges } });
      reported = union(reported, coverageOf(answer.ranges));
    } catch {
      // Not reported this time; the next check finds the same text unreported.
    } finally {
      sending = false;
    }
  }

  const timer = setInterval(() => void tick(), DWELL_MS);
  return {
    stop: () => clearInterval(timer),
  };
}
