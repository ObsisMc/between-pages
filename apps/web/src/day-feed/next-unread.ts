import type { FeedWindow } from './model.ts';

// Where the feed's round unread buttons go (book-frontend-workspace D5), without any I/O:
// first what is unread on the loaded dates, from the viewport in that direction, then the
// server's `next-unread` from the loaded range's end. All history text never comes into the
// browser for this.

/** ↑ looks among newer dates, ↓ among older ones. */
export type Direction = 'newer' | 'older';

/**
 * Something unread on a loaded date, in page order (newest first): an unread passage of a
 * loaded text (the in-diary rule), or a diary the list marks unread whose text or coverage
 * is not loaded (`settled` false) or which is collapsed. `place` is where it is against the
 * feed's viewport.
 */
export type Spot = { date: string; place: 'above' | 'inside' | 'below'; settled: boolean };

/** A `next-unread` query: dates older than `before`, or newer than `after`. */
export type Ask = { before: string } | { after: string };

/** What the server answered for an ask; `failed` when it could not be asked. */
export type Answer = { date: string | null } | 'failed';

/** Where a button goes: a spot by its index, a date not loaded, or nowhere (no button). */
export type Next = { spot: number } | { date: string } | null;

/**
 * Where the button for `direction` goes, and the ask its answer depends on: null when the
 * loaded dates decided it, or the window reaches that end. `answer` is the remembered answer
 * to an ask, undefined while there is none; until there is, and when it failed or is null,
 * there is no button (失败与恢复: never "没有未读").
 */
export function nextUnread(
  direction: Direction,
  spots: readonly Spot[],
  window: FeedWindow | null,
  answer: (ask: Ask) => Answer | undefined,
): { next: Next; ask: Ask | null } {
  if (direction === 'older') {
    const below = spots.findIndex((spot) => spot.place === 'below');
    if (below >= 0) return { next: { spot: below }, ask: null };
  } else {
    // The nearest date above, at its first unread spot.
    const date = spots.findLast((spot) => spot.place === 'above')?.date;
    if (date !== undefined)
      return { next: { spot: spots.findIndex((spot) => spot.date === date) }, ask: null };
  }
  const ask = askFrom(direction, window);
  if (!ask) return { next: null, ask: null };
  const known = answer(ask);
  const date = known && known !== 'failed' ? known.date : null;
  return { next: date === null ? null : { date }, ask };
}

/** The ask beyond the loaded range's end in `direction`; null when the window reaches it. */
function askFrom(direction: Direction, window: FeedWindow | null): Ask | null {
  const entries = window?.entries ?? [];
  const [newest, oldest] = [entries[0]?.date, entries.at(-1)?.date];
  if (direction === 'older')
    return window?.nextBefore && oldest !== undefined ? { before: oldest } : null;
  return window?.nextAfter && newest !== undefined ? { after: newest } : null;
}

/**
 * Where a jump to a date not loaded lands once the date is shown: the index of its first
 * spot once that one is settled, 'wait' while its first is a diary still loading, null when
 * the date shows nothing unread (read meanwhile).
 */
export function landing(date: string, spots: readonly Spot[]): number | 'wait' | null {
  const first = spots.findIndex((spot) => spot.date === date);
  if (first < 0) return null;
  return spots[first]!.settled ? first : 'wait';
}
