import type { DateRange, DateSelection } from '@between-pages/contracts';

// Canonical form of a date selection (spaces-and-invitations D3): each list sorted and
// merged where ranges overlap or touch, so two selections that name the same days compare
// equal regardless of how the client ordered or split them. Calendar days only: no time
// zone takes part.

const DAY_MS = 24 * 3600 * 1000;

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

// An open start sorts first; ISO dates compare as strings.
const byStart = (a: DateRange, b: DateRange) =>
  a.from === b.from ? 0 : a.from === null ? -1 : b.from === null ? 1 : a.from < b.from ? -1 : 1;

/** True when `range` starts no later than the day after `end` (null `end`: no upper bound). */
const reaches = (end: string | null, range: DateRange) =>
  end === null || range.from === null || range.from <= nextDay(end);

const later = (a: string | null, b: string | null) =>
  a === null || b === null ? null : a > b ? a : b;

function merged(ranges: readonly DateRange[]): DateRange[] {
  const out: DateRange[] = [];
  for (const range of [...ranges].sort(byStart)) {
    const last = out.at(-1);
    if (last && reaches(last.to, range)) last.to = later(last.to, range.to);
    else out.push({ from: range.from, to: range.to });
  }
  return out;
}

export function normalizeSelection(selection: DateSelection): DateSelection {
  return { include: merged(selection.include), exclude: merged(selection.exclude) };
}

export const sameSelection = (a: DateSelection, b: DateSelection) =>
  JSON.stringify(normalizeSelection(a)) === JSON.stringify(normalizeSelection(b));

const within = (range: DateRange, date: string) =>
  (range.from === null || range.from <= date) && (range.to === null || date <= range.to);

/** Whether `date` (YYYY-MM-DD) is a shared day: in some include range and in no exclude range (D3). */
export const covers = (selection: DateSelection, date: string) =>
  selection.include.some((r) => within(r, date)) && !selection.exclude.some((r) => within(r, date));
