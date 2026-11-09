import type { DateRange, DateSelection } from '@between-pages/contracts';

// Reading a date selection on screen (spaces-and-invitations D3). The server stores the
// canonical form; this only answers "is this day in it" and says it in words.

export const ALL_DAYS: DateSelection = { include: [{ from: null, to: null }], exclude: [] };
export const NO_DAYS: DateSelection = { include: [], exclude: [] };

const covers = (range: DateRange, day: string) =>
  (range.from === null || range.from <= day) && (range.to === null || day <= range.to);

/** A day is shared when an include range covers it and no exclude range does; exclusion wins. */
export const isShared = (selection: DateSelection, day: string) =>
  selection.include.some((r) => covers(r, day)) && !selection.exclude.some((r) => covers(r, day));

/** A day an exclude range covers, whether or not an include range does too. */
export const isExcluded = (selection: DateSelection, day: string) =>
  selection.exclude.some((r) => covers(r, day));

export const isAllDays = (selection: DateSelection) =>
  selection.exclude.length === 0 && selection.include.some((r) => r.from === null && r.to === null);

// Day arithmetic for "which days change": inclusive spans of day numbers, open ends infinite.
const DAY_MS = 86_400_000;
type Span = [number, number];
const dayNumber = (day: string | null, open: number) =>
  day === null ? open : Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayOf = (n: number) =>
  Number.isFinite(n) ? new Date(n * DAY_MS).toISOString().slice(0, 10) : null;

function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

function minus(spans: Span[], cut: Span[]): Span[] {
  let rest = spans;
  for (const [x, y] of cut)
    rest = rest.flatMap(([f, t]): Span[] =>
      y < f || x > t
        ? [[f, t]]
        : (
            [
              [f, x - 1],
              [y + 1, t],
            ] as Span[]
          ).filter(([a, b]) => a <= b),
    );
  return rest;
}

const spansOf = (ranges: readonly DateRange[]) =>
  merged(ranges.map((r): Span => [dayNumber(r.from, -Infinity), dayNumber(r.to, Infinity)]));

/** The days `a` shares and `b` does not, as ranges in date order. */
export function daysOnlyIn(a: DateSelection, b: DateSelection): DateRange[] {
  const shared = (s: DateSelection) => minus(spansOf(s.include), spansOf(s.exclude));
  return minus(shared(a), shared(b)).map(([from, to]) => ({ from: dayOf(from), to: dayOf(to) }));
}

function rangeText(range: DateRange): string {
  if (range.from === null && range.to === null) return '全部历史与以后';
  if (range.from === null) return `${range.to} 及以前`;
  if (range.to === null) return `${range.from} 起持续`;
  if (range.from === range.to) return range.from;
  return `${range.from} 至 ${range.to}`;
}

/** Ranges in one line, e.g. the days a change opens. */
export const describeRanges = (ranges: readonly DateRange[]) => ranges.map(rangeText).join('；');

/** The selection in one line, as the person who chose it should read it. */
export function describeSelection(selection: DateSelection): string {
  if (selection.include.length === 0) return '暂不共享任何日期';
  const shared = selection.include.map(rangeText).join('；');
  if (selection.exclude.length === 0) return `共享：${shared}`;
  return `共享：${shared}；排除：${selection.exclude.map(rangeText).join('；')}`;
}
