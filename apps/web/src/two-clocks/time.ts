// Time math for two clocks (two-clocks D2–D4). Everything works on real instants (epoch
// milliseconds) and converts to wall time through Intl, so daylight-saving days and sleep
// that crosses midnight come out right; nothing subtracts fixed zone offsets.

export type Sleep = { start: number; end: number };
export type Interval = { start: number; end: number };
type LocalDate = { year: number; month: number; day: number };

const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const partsFormat = (zone: string) => {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, format);
  }
  return format;
};

/** Wall-clock fields of `instant` in `zone`. */
export function localParts(instant: number, zone: string) {
  const parts = Object.fromEntries(
    partsFormat(zone)
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

const offsetAt = (instant: number, zone: string) => {
  const p = localParts(instant, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
};

/**
 * The instant at `minute` after local midnight of `date` in `zone`. A wall time skipped by
 * a spring-forward gap maps to the instant just after the gap.
 */
export function localToInstant(date: LocalDate, minute: number, zone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minute);
  const first = wall - offsetAt(wall, zone);
  const second = wall - offsetAt(first, zone);
  // The two guesses straddle a gap only when the wall time does not exist there.
  return offsetAt(second, zone) === offsetAt(first, zone) ? second : Math.max(first, second);
}

const addDays = (date: LocalDate, days: number): LocalDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};

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

/** Whether `now` falls in the usual sleep of someone in `zone` (D4 "大概在睡"). */
export function asleepAt(now: number, zone: string, sleep: Sleep): boolean {
  const p = localParts(now, zone);
  const minute = p.hour * 60 + p.minute;
  return sleep.start < sleep.end
    ? minute >= sleep.start && minute < sleep.end
    : minute >= sleep.start || minute < sleep.end;
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
