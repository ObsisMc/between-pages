import { describe, expect, it } from 'vitest';
import {
  asleepAt,
  awakeTogether,
  clockText,
  dayPeriod,
  localDay,
  localToInstant,
  regionName,
} from './time.ts';

const HOUR = 3_600_000;
const utc = (...fields: [number, number, number, number, number?]) =>
  Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4] ?? 0);

describe('awakeTogether', () => {
  it('[adr:two-clocks#4] finds the evening a 17-hour difference leaves', () => {
    // Los Angeles (UTC-8) and Tokyo (UTC+9), both asleep 0:00–8:00: Tokyo sleeps 7:00–15:00
    // Los Angeles time, so both are awake from 15:00 to the end of the Los Angeles day.
    const now = utc(2026, 11, 10, 20);
    const together = awakeTogether(now, 'America/Los_Angeles', [
      { timezone: 'America/Los_Angeles', sleep: { start: 0, end: 480 } },
      { timezone: 'Asia/Tokyo', sleep: { start: 0, end: 480 } },
    ]);
    expect(together).toEqual([{ start: utc(2026, 11, 10, 23), end: utc(2026, 11, 11, 8) }]);
  });

  it('[adr:two-clocks#3] handles sleep that crosses midnight on both sides', () => {
    // Shanghai sleeps 23:30–7:30, London 23:00–7:00 (Shanghai 7:00–15:00).
    const now = utc(2026, 11, 10, 4);
    const together = awakeTogether(now, 'Asia/Shanghai', [
      { timezone: 'Asia/Shanghai', sleep: { start: 1410, end: 450 } },
      { timezone: 'Europe/London', sleep: { start: 1380, end: 420 } },
    ]);
    expect(together).toEqual([{ start: utc(2026, 11, 10, 7), end: utc(2026, 11, 10, 15, 30) }]);
  });

  it('[adr:two-clocks#4] stays right on the day the clocks spring forward', () => {
    // 2027-03-14 in Los Angeles has 23 hours; it sleeps 1:00 (PST) to 9:00 (PDT), and Tokyo's
    // night falls on 8:00–16:00 PDT.
    const now = utc(2027, 3, 14, 20);
    const together = awakeTogether(now, 'America/Los_Angeles', [
      { timezone: 'America/Los_Angeles', sleep: { start: 60, end: 540 } },
      { timezone: 'Asia/Tokyo', sleep: { start: 0, end: 480 } },
    ]);
    expect(together).toEqual([
      { start: utc(2027, 3, 14, 8), end: utc(2027, 3, 14, 9) },
      { start: utc(2027, 3, 14, 23), end: utc(2027, 3, 15, 7) },
    ]);
  });

  it('[adr:two-clocks#4] shows nothing when either person has no schedule or zone', () => {
    const now = utc(2026, 11, 10, 4);
    expect(
      awakeTogether(now, 'Asia/Shanghai', [
        { timezone: 'Asia/Shanghai', sleep: { start: 0, end: 480 } },
        { timezone: 'Asia/Tokyo', sleep: null },
      ]),
    ).toBeNull();
    expect(
      awakeTogether(now, 'Asia/Shanghai', [
        { timezone: 'Asia/Shanghai', sleep: { start: 0, end: 480 } },
        { timezone: null, sleep: { start: 0, end: 480 } },
      ]),
    ).toBeNull();
  });
});

describe('local time', () => {
  it('[adr:two-clocks#4] gives switch days their real length', () => {
    const spring = localDay(utc(2027, 3, 14, 20), 'America/Los_Angeles');
    expect(spring.end - spring.start).toBe(23 * HOUR);
    const autumn = localDay(utc(2026, 10, 25, 12), 'Europe/London');
    expect(autumn.end - autumn.start).toBe(25 * HOUR);
  });

  it('maps a wall time skipped by spring forward to just after the gap', () => {
    const skipped = localToInstant({ year: 2027, month: 3, day: 14 }, 150, 'America/Los_Angeles');
    expect(clockText(skipped, 'America/Los_Angeles')).toBe('3:30');
  });

  it('knows when someone is usually asleep, across midnight', () => {
    const sleep = { start: 1410, end: 450 };
    expect(asleepAt(utc(2026, 11, 10, 18), 'Asia/Tokyo', sleep)).toBe(true); // 3:00
    expect(asleepAt(utc(2026, 11, 10, 14, 45), 'Asia/Tokyo', sleep)).toBe(true); // 23:45
    expect(asleepAt(utc(2026, 11, 10, 3), 'Asia/Tokyo', sleep)).toBe(false); // 12:00
  });

  it('bands the hour into dawn, day, dusk and night', () => {
    const at = (hour: number) => dayPeriod(utc(2026, 11, 10, hour), 'UTC');
    expect([at(4), at(5), at(8), at(17), at(20)]).toEqual([
      'night',
      'dawn',
      'day',
      'dusk',
      'night',
    ]);
  });

  it('names a zone by its region and ends the day at 24:00', () => {
    expect(regionName('Asia/Tokyo')).toBe('日本标准时间');
    const day = localDay(utc(2026, 11, 10, 4), 'Asia/Shanghai');
    expect(clockText(day.end, 'Asia/Shanghai', day.end)).toBe('24:00');
    expect(clockText(day.start, 'Asia/Shanghai', day.end)).toBe('0:00');
  });
});
