// Time-zone math both apps share (email-reminders D11). Everything works on real instants
// (epoch milliseconds) and converts to wall time through Intl, so daylight-saving days and
// sleep that crosses midnight come out right; nothing subtracts fixed zone offsets. A local
// date is a calendar day, compared and moved as such; only the start of a day is an instant.

export type LocalDate = { year: number; month: number; day: number };
export type WallTime = LocalDate & { hour: number; minute: number; second: number };
/** A usual sleep, in minutes after local midnight; `end` before `start` crosses midnight. */
export type Sleep = { start: number; end: number };

const DAY = 86_400_000;
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
export function localParts(instant: number, zone: string): WallTime {
  return Object.fromEntries(
    partsFormat(zone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as WallTime;
}

const offsetAt = (instant: number, zone: string) => {
  const p = localParts(instant, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
};

/** The calendar date at `instant` in `zone`. */
export function dateIn(instant: number, zone: string): LocalDate {
  const { year, month, day } = localParts(instant, zone);
  return { year, month, day };
}

/** `YYYY-MM-DD` of `instant` in `zone`, or in UTC for someone who never reported one. */
export const isoDateIn = (instant: number, zone: string | null) =>
  isoDate(dateIn(instant, zone ?? 'UTC'));

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

/** The first instant of `date` in `zone`; after the gap when midnight is skipped. */
export const startOf = (date: LocalDate, zone: string) => localToInstant(date, 0, zone);

const serial = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day) / DAY;
const fromSerial = (n: number): LocalDate => {
  const at = new Date(n * DAY);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
};
export const addDays = (d: LocalDate, days: number) => fromSerial(serial(d) + days);
export const daysBetween = (from: LocalDate, to: LocalDate) => serial(to) - serial(from);
export const isoDate = (d: LocalDate) =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/** Whether `instant` falls in the usual sleep of someone in `zone`. */
export function asleepAt(instant: number, zone: string, sleep: Sleep): boolean {
  const p = localParts(instant, zone);
  const minute = p.hour * 60 + p.minute;
  return sleep.start < sleep.end
    ? minute >= sleep.start && minute < sleep.end
    : minute >= sleep.start || minute < sleep.end;
}
