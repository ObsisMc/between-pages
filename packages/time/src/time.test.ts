import { describe, expect, it } from 'vitest';
import {
  addDays,
  asleepAt,
  dateIn,
  daysBetween,
  isoDate,
  isoDateIn,
  localParts,
  localToInstant,
  startOf,
} from './index.ts';

const HOUR = 3_600_000;
const d = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return { year, month, day };
};
const at = (iso: string) => Date.parse(iso);

describe('wall time', () => {
  it('gives the day clocks change its real length', () => {
    const spring = d('2027-03-14');
    const springDay =
      startOf(addDays(spring, 1), 'America/Los_Angeles') - startOf(spring, 'America/Los_Angeles');
    expect(springDay).toBe(23 * HOUR);
    const autumn = d('2026-10-25');
    expect(startOf(addDays(autumn, 1), 'Europe/London') - startOf(autumn, 'Europe/London')).toBe(
      25 * HOUR,
    );
  });

  it('maps a skipped wall time to just after the gap and a repeated one to its first instant', () => {
    const skipped = localToInstant(d('2027-03-14'), 150, 'America/Los_Angeles');
    expect(localParts(skipped, 'America/Los_Angeles')).toMatchObject({ hour: 3, minute: 30 });
    const repeated = localToInstant(d('2026-11-01'), 90, 'America/Los_Angeles');
    expect(new Date(repeated).toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('gives each zone its own date for one instant, and UTC when there is no zone', () => {
    const instant = at('2026-10-31T03:00:00Z');
    expect(isoDate(dateIn(instant, 'Asia/Shanghai'))).toBe('2026-10-31');
    expect(isoDateIn(instant, 'America/Los_Angeles')).toBe('2026-10-30');
    expect(isoDateIn(instant, null)).toBe('2026-10-31');
  });
});

describe('calendar days', () => {
  it('adds and counts days across 2 月 29 日', () => {
    expect(isoDate(addDays(d('2028-02-28'), 1))).toBe('2028-02-29');
    expect(isoDate(addDays(d('2027-02-28'), 1))).toBe('2027-03-01');
    expect(isoDate(addDays(d('2028-03-01'), -1))).toBe('2028-02-29');
    expect(daysBetween(d('2028-02-01'), d('2028-03-01'))).toBe(29);
    expect(daysBetween(d('2028-03-01'), d('2027-03-01'))).toBe(-366);
  });
});

describe('sleep', () => {
  it('knows a sleep that crosses midnight, in the sleeper’s zone', () => {
    const sleep = { start: 23 * 60 + 30, end: 7 * 60 + 30 };
    expect(asleepAt(at('2026-11-10T18:00:00Z'), 'Asia/Tokyo', sleep)).toBe(true); // 3:00
    expect(asleepAt(at('2026-11-10T14:45:00Z'), 'Asia/Tokyo', sleep)).toBe(true); // 23:45
    expect(asleepAt(at('2026-11-10T22:30:00Z'), 'Asia/Tokyo', sleep)).toBe(false); // 7:30
    expect(asleepAt(at('2026-11-10T03:00:00Z'), 'Asia/Tokyo', sleep)).toBe(false); // 12:00
  });

  it('knows a sleep within one day, and holds across a clock change', () => {
    const sleep = { start: 60, end: 9 * 60 };
    expect(asleepAt(at('2026-11-01T08:30:00Z'), 'America/Los_Angeles', sleep)).toBe(true); // 1:30 PST
    expect(asleepAt(at('2026-11-01T07:30:00Z'), 'America/Los_Angeles', sleep)).toBe(false); // 0:30 PDT
    expect(asleepAt(at('2026-11-01T17:00:00Z'), 'America/Los_Angeles', sleep)).toBe(false); // 9:00
  });
});
