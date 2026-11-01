import { describe, expect, it } from 'vitest';
import { homeLine, type HomeAnniversary } from './anniversary-line.ts';

// The anniversary line of the home strip (anniversaries D3, partner-local-dates D3).

const ME = '6f1c1d0e-0000-4000-8000-000000000001';
const PARTNER = '6f1c1d0e-0000-4000-8000-000000000002';
// The partner's birthday starts at midnight in Shanghai: 16:00 UTC the day before.
const STARTS = Date.parse('2026-10-30T16:00:00Z');
const HOUR = 3_600_000;

const anniversary = (over: Partial<HomeAnniversary> = {}): HomeAnniversary => ({
  id: '0d0d0d0d-0000-4000-8000-000000000001',
  authorId: ME,
  kind: 'birthday',
  birthdayOf: PARTNER,
  name: null,
  note: null,
  year: null,
  month: 10,
  day: 31,
  dateSet: null,
  showCount: false,
  countSet: null,
  reminder: 7,
  basis: 'partner',
  dayCount: null,
  next: {
    date: '2026-10-31',
    startsAt: new Date(STARTS).toISOString(),
    endsAt: new Date(STARTS + 24 * HOUR).toISOString(),
    type: 'yearly',
    years: null,
    count: null,
    daysLeft: 1,
  },
  due: true,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  unread: null,
  mark: 0,
  ...over,
});

describe('homeLine', () => {
  it('[adr:partner-local-dates#4] counts hours to the day’s start on the partner’s side in the last 24 hours', () => {
    const a = anniversary();
    expect(homeLine(a, ME, STARTS - 30 * HOUR)).toEqual({
      text: 'TA 的生日还有 1 天（按 TA 那边的日期）',
      wishes: true,
    });
    expect(homeLine(a, ME, STARTS - 4.5 * HOUR)!.text).toBe('TA 那边还有 5 小时到生日');
    expect(homeLine(a, ME, STARTS - 20 * 60_000)!.text).toBe('TA 那边还有不到 1 小时到生日');
    expect(homeLine(a, ME, STARTS)!.text).toBe('今天是 TA 的生日（按 TA 那边的日期）');
    const together = anniversary({ kind: 'together', birthdayOf: null, year: 2024 });
    const second = { ...together, next: { ...together.next, years: 2 } };
    expect(homeLine(second, ME, STARTS - 2 * HOUR)!.text).toBe('TA 那边还有 2 小时到在一起 2 周年');
    expect(homeLine(a, ME, STARTS + 24 * HOUR)).toBeNull();
  });

  it('[adr:anniversaries#5] the caller’s own birthday comes in their own date and without the wishes link', () => {
    const own = anniversary({ birthdayOf: ME, basis: 'own', reminder: 0 });
    expect(homeLine(own, ME, STARTS - 3 * HOUR)).toEqual({
      text: '你的生日还有 3 小时',
      wishes: false,
    });
  });

  it('[adr:partner-local-dates#2] says so when the partner’s zone is unknown', () => {
    const together = anniversary({
      kind: 'together',
      birthdayOf: null,
      year: 2024,
      basis: 'unknown',
      next: { ...anniversary().next, type: 'count', count: 1000, daysLeft: 5 },
    });
    expect(homeLine(together, ME, STARTS - 100 * HOUR)!.text).toBe(
      '在一起第 1000 天还有 5 天（TA 那边的时区未知，按你这边的日期）',
    );
  });
});
