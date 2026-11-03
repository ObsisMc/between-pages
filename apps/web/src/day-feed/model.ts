import type { Day, ResponseOf } from '@between-pages/contracts';

// The right page's window of dates (book-frontend-workspace D4, D8), without any I/O: which
// dates are loaded, the cursors to load more in both directions, and the rules that decide
// what a diary on it shows.

export type DaysPage = ResponseOf<'days'>;

/** A date in the window; `day` is null for a jumped-to date with no diary the caller can see. */
export type Entry = { date: string; day: Day | null };

/**
 * A contiguous run of dates, newest first: every date the caller can see between the first
 * and the last entry is in it. `nextAfter` / `nextBefore` continue it upwards / downwards;
 * null when that end is the newest / oldest date there is.
 */
export type FeedWindow = { entries: Entry[]; nextAfter: string | null; nextBefore: string | null };

/** The calendar date `days` after `date` (before, when negative). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const newestFirst = (a: Entry, b: Entry) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/** `entries` that pass `keep`, with `days` added or replacing the entry of their date. */
function withDays(
  entries: readonly Entry[],
  days: readonly Day[],
  keep: (entry: Entry) => boolean = () => true,
) {
  const byDate = new Map(entries.filter(keep).map((entry) => [entry.date, entry]));
  for (const day of days) byDate.set(day.diaryDate, { date: day.diaryDate, day });
  return [...byDate.values()].sort(newestFirst);
}

/** The first page from the newest date. */
export const fromNewest = (page: DaysPage): FeedWindow => ({
  entries: withDays([], page.days),
  nextAfter: null,
  nextBefore: page.nextBefore,
});

/**
 * The window around `date` from the two pages asked side by side: `older` with `before` the
 * next day (the date and older), `newer` with `after` the date (D4). A date with no diary
 * the caller can see stays in it as an empty entry, never as a diary to create.
 */
export function jumpedTo(date: string, older: DaysPage, newer: DaysPage): FeedWindow {
  const placeholder = { date, day: null };
  return {
    entries: withDays([placeholder], [...newer.days, ...older.days]),
    nextAfter: newer.nextAfter,
    nextBefore: older.nextBefore,
  };
}

/** The window with the page asked `before` its `nextBefore`. */
export const withOlder = (window: FeedWindow, page: DaysPage): FeedWindow => ({
  ...window,
  entries: withDays(window.entries, page.days),
  nextBefore: page.nextBefore,
});

/** The window with the page asked `after` its `nextAfter`. */
export const withNewer = (window: FeedWindow, page: DaysPage): FeedWindow => ({
  ...window,
  entries: withDays(window.entries, page.days),
  nextAfter: page.nextAfter,
});

/**
 * What a refresh around the dates near the viewport asks (D8): from the newest while the
 * window reaches it and its top is near, so a new date shows up; else the page from the
 * newest date near downwards.
 */
export function refreshQuery(window: FeedWindow, newestNear: string | undefined) {
  const top = window.entries[0]?.date;
  if (newestNear === undefined || (window.nextAfter === null && newestNear === top)) return {};
  return { before: addDays(newestNear, 1) };
}

/**
 * The window with a refreshed page: every date the page covers (below `before`, down to its
 * last date, or to the oldest when it has no `nextBefore`) is as the page says, so a date
 * that no longer has a diary goes and a new one comes; the rest is unchanged. Empty entries
 * stay until their date has a diary.
 */
export function refreshed(
  window: FeedWindow,
  { before }: { before?: string },
  page: DaysPage,
): FeedWindow {
  const low = page.nextBefore === null ? undefined : page.days.at(-1)?.diaryDate;
  const covers = (date: string) =>
    (before === undefined || date < before) && (low === undefined || date >= low);
  const oldest = window.entries.at(-1)?.date;
  // A page reaching past the window's oldest date makes it the window's lower end.
  const reachesPast =
    window.nextBefore !== null && (low === undefined || (oldest !== undefined && low < oldest));
  return {
    entries: withDays(window.entries, page.days, (e) => e.day === null || !covers(e.date)),
    nextAfter: window.nextAfter,
    nextBefore: reachesPast ? page.nextBefore : window.nextBefore,
  };
}

export type Side = 'mine' | 'partner';

/** One diary of a date as the list describes it. */
export type DiaryRef = {
  side: Side;
  diaryId: string;
  /** The partner's share; absent for the own diary. */
  epochId?: string;
  frozen: boolean;
  updatedAt: string;
  hasText: boolean;
  unread: boolean;
  writing: boolean;
};

/** The diaries of a date, own first. */
export function diariesOf(day: Day): DiaryRef[] {
  const refs: DiaryRef[] = [];
  if (day.mine) refs.push({ side: 'mine', frozen: false, ...day.mine });
  if (day.partner)
    refs.push({ side: 'partner', frozen: day.partner.share === 'frozen', ...day.partner });
  return refs;
}

/**
 * Why a diary shows one row instead of its text (D8, invariant 9): the own diary of the date
 * open in the left page, or someone wrote after its newest history point. Null: its text.
 */
export type Collapse = 'editing' | 'writing-self' | 'writing-partner' | null;

export function collapseOf(date: string, diary: DiaryRef, editingDate: string | null): Collapse {
  if (diary.side === 'mine' && date === editingDate) return 'editing';
  if (diary.writing) return diary.side === 'mine' ? 'writing-self' : 'writing-partner';
  return null;
}

/** A diary's loaded text: the list's `updatedAt` it was read for, and whether it was frozen. */
export type LoadedVersion = { updatedAt: string; frozen: boolean };

/**
 * Whether a diary's text must be read (again) before it is shown (D8): never read, or the
 * list says it changed since. A frozen share no longer changes, so once read it never is.
 */
export const needsText = (diary: DiaryRef, loaded: LoadedVersion | null) =>
  !loaded || (!loaded.frozen && loaded.updatedAt !== diary.updatedAt);
