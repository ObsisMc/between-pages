import type { ResponseOf } from '@between-pages/contracts';

// The anniversary line of the home strip (anniversaries D3, partner-local-dates D1–D3): one
// anniversary, counted in its basis zone. Days until the last 24 hours, then hours to the
// day's start there, then "今天是…" until the day ends there.

export type HomeAnniversary = ResponseOf<'anniversaries'>['anniversaries'][number];

const HOUR = 3_600_000;

/**
 * What the day is, as the home line names it (D3). `there` drops "TA 的" from the partner's
 * birthday where the line already says it is on their side.
 */
export function eventText(a: HomeAnniversary, me: string, there = false): string {
  const { type, years, count } = a.next;
  if (a.kind === 'birthday') {
    const whose = a.birthdayOf === me ? '你的' : there ? '' : 'TA 的';
    return type === 'yearly' && years ? `${whose} ${years} 岁生日`.trim() : `${whose}生日`;
  }
  const what = a.kind === 'together' ? '在一起' : a.name!;
  if (type === 'count') return `${what}第 ${count} 天`;
  if (years) return `${what} ${years} 周年`;
  return a.kind === 'together' ? '在一起的日子' : what;
}

export type Line = { text: string; wishes: boolean };

/**
 * The line at `now`, or null once the day has ended (the next answer brings the next one).
 * Only the caller's own birthday comes without the link to the partner's wishes.
 */
export function homeLine(a: HomeAnniversary, me: string, now: number): Line | null {
  const startsAt = Date.parse(a.next.startsAt);
  const endsAt = Date.parse(a.next.endsAt);
  if (now >= endsAt) return null;
  const event = eventText(a, me);
  const there = a.basis === 'partner';
  // A space between Chinese and a following Latin letter or digit, as elsewhere.
  const spaced = (text: string) => (/^[A-Za-z0-9]/.test(text) ? ` ${text}` : text);
  const note =
    a.basis === 'unknown'
      ? '（TA 那边的时区未知，按你这边的日期）'
      : there
        ? '（按 TA 那边的日期）'
        : '';
  const wishes = !(a.kind === 'birthday' && a.birthdayOf === me);
  if (now >= startsAt) return { text: `今天是${spaced(event)}${note}`, wishes };
  const left = startsAt - now;
  if (left < 24 * HOUR) {
    const hours = left < HOUR ? '不到 1 小时' : ` ${Math.ceil(left / HOUR)} 小时`;
    return {
      text: there
        ? `TA 那边还有${hours}到${spaced(eventText(a, me, true))}`
        : `${event}还有${hours}${note}`,
      wishes,
    };
  }
  return { text: `${event}还有 ${a.next.daysLeft} 天${note}`, wishes };
}
