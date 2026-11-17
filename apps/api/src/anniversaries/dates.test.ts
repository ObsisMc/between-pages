import { describe, expect, it } from 'vitest';
import { dateIn, isoDate, startOf } from '@between-pages/time';
import { dayCount, inYear, nextOccurrence, years } from './dates.ts';

// Calendar math of anniversaries (anniversaries D1–D3, partner-local-dates D1, D3).

const d = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return { year, month, day };
};
const counting = (start: string) => ({ ...d(start), showCount: true });
const next = (a: Parameters<typeof nextOccurrence>[0], today: string) => {
  const o = nextOccurrence(a, d(today));
  return { ...o, date: isoDate(o.date) };
};

describe('anniversary dates', () => {
  it('[adr:anniversaries#1] 2 月 29 日 falls on 2 月 28 日 in a common year', () => {
    expect(isoDate(inYear({ month: 2, day: 29 }, 2027))).toBe('2027-02-28');
    expect(isoDate(inYear({ month: 2, day: 29 }, 2028))).toBe('2028-02-29');
    expect(isoDate(inYear({ month: 2, day: 29 }, 2100))).toBe('2100-02-28');
    expect(next({ year: 2000, month: 2, day: 29, showCount: false }, '2027-02-28')).toMatchObject({
      date: '2027-02-28',
      years: 27,
    });
  });

  it('comes on this year’s day until it has passed, then next year’s; a future year comes on itself', () => {
    const birthday = { year: null, month: 10, day: 31, showCount: false };
    expect(next(birthday, '2026-10-31')).toMatchObject({ date: '2026-10-31', years: null });
    expect(next(birthday, '2026-11-01').date).toBe('2027-10-31');
    expect(next({ ...birthday, year: 2030 }, '2026-11-01')).toMatchObject({
      date: '2030-10-31',
      years: 0,
    });
  });

  it('[adr:anniversaries#3] counts the day itself as day 1, and round days are every 100th plus 520 and 1314', () => {
    const together = counting('2024-01-01');
    expect(dayCount(together, d('2023-12-31'))).toBeNull();
    expect(dayCount(together, d('2024-01-01'))).toBe(1);
    expect(dayCount(together, d('2025-01-01'))).toBe(367);
    expect(dayCount({ ...together, showCount: false }, d('2025-01-01'))).toBeNull();
    // Day 96: day 100 comes before the yearly day.
    expect(next(together, '2024-04-05')).toMatchObject({
      date: '2024-04-09',
      type: 'count',
      count: 100,
    });
    // Day 501: 520 before 600.
    expect(next(together, '2025-05-15')).toMatchObject({ type: 'count', count: 520 });
    // Day 1301: 1314 before 1400.
    expect(next(together, '2027-07-24')).toMatchObject({ type: 'count', count: 1314 });
    // The yearly day wins when it comes first.
    expect(next(together, '2024-12-30')).toMatchObject({
      date: '2025-01-01',
      type: 'yearly',
      years: 1,
    });
  });

  it('[adr:partner-local-dates#1] the same instant is a different date in each zone, and a day starts at local midnight', () => {
    const instant = Date.parse('2026-10-31T03:00:00Z');
    expect(isoDate(dateIn(instant, 'Asia/Shanghai'))).toBe('2026-10-31');
    expect(isoDate(dateIn(instant, 'America/Los_Angeles'))).toBe('2026-10-30');
    expect(new Date(startOf(d('2026-10-31'), 'Asia/Shanghai')).toISOString()).toBe(
      '2026-10-30T16:00:00.000Z',
    );
    // The day daylight saving ends in Los Angeles still starts at midnight PDT.
    expect(new Date(startOf(d('2026-11-01'), 'America/Los_Angeles')).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    // Where midnight is skipped, the day starts at the first instant that belongs to it.
    const gap = startOf(d('2026-09-06'), 'America/Santiago');
    expect(isoDate(dateIn(gap, 'America/Santiago'))).toBe('2026-09-06');
    expect(isoDate(dateIn(gap - 1, 'America/Santiago'))).toBe('2026-09-05');
  });

  it('lists every year from the first to this one, newest first', () => {
    expect(years({ month: 2, day: 29 }, 2023, 2025).map(isoDate)).toEqual([
      '2025-02-28',
      '2024-02-29',
      '2023-02-28',
    ]);
  });
});
