// Calendar rules of anniversaries (anniversaries D1–D3), counted in one basis zone
// (partner-local-dates D1); the zone and day math itself is `@between-pages/time`.

import { addDays, daysBetween, type LocalDate } from '@between-pages/time';

export type Repeating = {
  year: number | null;
  month: number;
  day: number;
  showCount: boolean;
};
export type Occurrence = {
  date: LocalDate;
  type: 'yearly' | 'count';
  years: number | null;
  count: number | null;
};

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The anniversary's day in `year`: 2 月 29 日 falls on 2 月 28 日 in a common year (invariant 1). */
export function inYear(a: { month: number; day: number }, year: number): LocalDate {
  return a.month === 2 && a.day === 29 && !isLeap(year)
    ? { year, month: 2, day: 28 }
    : { year, month: a.month, day: a.day };
}

/** Round days of a count (D2, invariant 3): every 100th, and the 520th and 1314th. */
function nextRound(from: number): number {
  const hundred = Math.ceil(from / 100) * 100;
  return Math.min(hundred, ...[520, 1314].filter((n) => n >= from));
}

/** "第 N 天" on `today`, the day itself being day 1; null while off or before it begins. */
export function dayCount(a: Repeating, today: LocalDate): number | null {
  if (!a.showCount || a.year === null) return null;
  const n = daysBetween({ year: a.year, month: a.month, day: a.day }, today) + 1;
  return n >= 1 ? n : null;
}

/**
 * The first day on or after `today` to mark: the yearly day, or a round day of the count
 * when that comes first; the yearly day wins a tie. An anniversary whose year lies ahead
 * first comes on that day itself.
 */
export function nextOccurrence(a: Repeating, today: LocalDate): Occurrence {
  let date = inYear(a, today.year);
  if (daysBetween(today, date) < 0) date = inYear(a, today.year + 1);
  if (a.year !== null && date.year < a.year) date = inYear(a, a.year);
  const yearly: Occurrence = {
    date,
    type: 'yearly',
    years: a.year === null ? null : date.year - a.year,
    count: null,
  };
  if (!a.showCount || a.year === null) return yearly;
  const start = { year: a.year, month: a.month, day: a.day };
  const count = nextRound(Math.max(1, daysBetween(start, today) + 1));
  const round = addDays(start, count - 1);
  return daysBetween(round, date) > 0 ? { date: round, type: 'count', years: null, count } : yearly;
}

/** The anniversary's day in every year from `first` to `last`, newest first (D5). */
export function years(a: { month: number; day: number }, first: number, last: number): LocalDate[] {
  const out: LocalDate[] = [];
  for (let year = last; year >= first; year--) out.push(inYear(a, year));
  return out;
}
