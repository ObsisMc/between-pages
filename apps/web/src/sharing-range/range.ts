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

export const isAllDays = (selection: DateSelection) =>
  selection.exclude.length === 0 && selection.include.some((r) => r.from === null && r.to === null);

function rangeText(range: DateRange): string {
  if (range.from === null && range.to === null) return '全部历史与以后';
  if (range.from === null) return `${range.to} 及以前`;
  if (range.to === null) return `${range.from} 起持续`;
  if (range.from === range.to) return range.from;
  return `${range.from} 至 ${range.to}`;
}

/** The selection in one line, as the person who chose it should read it. */
export function describeSelection(selection: DateSelection): string {
  if (selection.include.length === 0) return '暂不共享任何日期';
  const shared = selection.include.map(rangeText).join('；');
  if (selection.exclude.length === 0) return `共享：${shared}`;
  return `共享：${shared}；排除：${selection.exclude.map(rangeText).join('；')}`;
}
