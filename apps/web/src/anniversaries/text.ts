import type { Anniversary, People } from './queries.ts';

// How the anniversaries page names things (anniversaries D1–D3, partner-local-dates D1–D3).

type Named = Pick<Anniversary, 'kind' | 'birthdayOf' | 'name'>;

export function nameOf(a: Named, people: People): string {
  if (a.kind === 'other') return a.name!;
  if (a.kind === 'together') return '在一起的日子';
  return a.birthdayOf === people.me.id ? '我的生日' : `${people.partner.displayName} 的生日`;
}

/** "2024 年 1 月 1 日", or without the year for a birthday that has none. */
export const dateText = (a: Pick<Anniversary, 'year' | 'month' | 'day'>) =>
  `${a.year === null ? '' : `${a.year} 年 `}${a.month} 月 ${a.day} 日`;

/** What the next day is: "28 岁生日", "2 周年", "第 1000 天", or just its day. */
export function nextText(a: Anniversary): string {
  const { type, years, count } = a.next;
  if (type === 'count') return `第 ${count} 天`;
  if (!years) return a.kind === 'birthday' ? '生日' : '这一天';
  return a.kind === 'birthday' ? `${years} 岁生日` : `${years} 周年`;
}

const HOUR = 3_600_000;

/** "今天", "还有 5 小时" in the last day, else "还有 N 天" (D3). */
export function countdownText(a: Anniversary, now: number): string {
  const startsAt = Date.parse(a.next.startsAt);
  if (now >= startsAt) return '就是今天';
  const left = startsAt - now;
  if (left < HOUR) return '还有不到 1 小时';
  if (left < 24 * HOUR) return `还有 ${Math.ceil(left / HOUR)} 小时`;
  return `还有 ${a.next.daysLeft} 天`;
}

/** Whose date counts, said where it is not the caller's own (partner-local-dates D1, D2). */
export const BASIS_TEXT: Record<Anniversary['basis'], string | null> = {
  own: null,
  partner: '按 TA 那边的日期',
  unknown: 'TA 那边的时区未知，按你这边的日期',
};

export const REMINDERS: { value: Anniversary['reminder']; text: string }[] = [
  { value: 0, text: '只在当天' },
  { value: 1, text: '提前 1 天' },
  { value: 3, text: '提前 3 天' },
  { value: 7, text: '提前 7 天' },
  { value: 14, text: '提前 14 天' },
  { value: 30, text: '提前 30 天' },
  { value: null, text: '不提醒' },
];
