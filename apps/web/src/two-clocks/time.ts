// Time math for two clocks (two-clocks D2–D4), built on the shared zone math in
// `@between-pages/time`: today's interval, shared awake hours and their display text.

import { addDays, localParts, localToInstant, type Sleep } from '@between-pages/time';

export type Interval = { start: number; end: number };

const MINUTE = 60_000;

/** The viewer's local today as an interval of instants (23 or 25 hours on switch days). */
export function localDay(now: number, zone: string): Interval {
  const today = localParts(now, zone);
  return {
    start: localToInstant(today, 0, zone),
    end: localToInstant(addDays(today, 1), 0, zone),
  };
}

/** One person's sleep intervals around `day`, as instants. */
function sleepAround(day: Interval, zone: string, sleep: Sleep): Interval[] {
  const first = localParts(day.start, zone);
  const intervals: Interval[] = [];
  for (let shift = -1; shift <= 2; shift++) {
    const date = addDays(first, shift);
    const start = localToInstant(date, sleep.start, zone);
    const end = localToInstant(sleep.end > sleep.start ? date : addDays(date, 1), sleep.end, zone);
    intervals.push({ start, end });
  }
  return intervals;
}

/** `whole` minus every interval in `holes`, in order. */
function subtract(whole: Interval, holes: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = whole.start;
  for (const hole of [...holes].sort((a, b) => a.start - b.start)) {
    if (hole.end <= cursor || hole.start >= whole.end) continue;
    if (hole.start > cursor) free.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
    if (cursor >= whole.end) break;
  }
  if (cursor < whole.end) free.push({ start: cursor, end: whole.end });
  return free;
}

/**
 * The parts of the viewer's local today when both people are awake (D3), or null when either
 * has no zone or no sleep schedule, so nothing is guessed.
 */
export function awakeTogether(
  now: number,
  viewerZone: string,
  people: readonly { timezone: string | null; sleep: Sleep | null }[],
): Interval[] | null {
  if (people.some((p) => !p.timezone || !p.sleep)) return null;
  const day = localDay(now, viewerZone);
  const asleep = people.flatMap((p) => sleepAround(day, p.timezone!, p.sleep!));
  return subtract(day, asleep).filter((free) => free.end - free.start >= MINUTE);
}

export type DayPeriod = 'dawn' | 'day' | 'dusk' | 'night';

/** The tint band of a local hour; the bands are the ADR's default and may change in stage 4. */
export function dayPeriod(now: number, zone: string): DayPeriod {
  const { hour } = localParts(now, zone);
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  return 'night';
}

/**
 * "日本标准时间", "北美太平洋时间": the zone's long generic Chinese name. The short form names
 * cities, which Chromium's locale data lacks ("Los Angeles时间"), so it is not used.
 */
export function regionName(zone: string): string {
  return (
    new Intl.DateTimeFormat('zh-CN', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(0)
      .find((part) => part.type === 'timeZoneName')?.value ?? zone
  );
}

/** "3:12", or "24:00" for the end of the viewer's day. */
export function clockText(instant: number, zone: string, dayEnd?: number): string {
  if (instant === dayEnd) return '24:00';
  const p = localParts(instant, zone);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

/** "11 月 1 日 · 周日": the local date of `instant` in `zone`, so a crossed day shows. */
export function dayText(instant: number, zone: string): string {
  const { month, day } = localParts(instant, zone);
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, weekday: 'short' }).format(
    instant,
  );
  return `${month} 月 ${day} 日 · ${weekday}`;
}

/** "23:30" for a local minute of the day. */
export const minuteText = (minute: number) =>
  `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
