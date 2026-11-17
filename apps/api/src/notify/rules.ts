import { addDays, asleepAt, dateIn, isoDateIn, startOf, type Sleep } from '@between-pages/time';

// The timing rules of email reminders (email-reminders D4, D7): constants, not settings.

/** New content waits this long unread before a mail (D4). */
export const UNREAD_FOR_MS = 60 * 60_000;
/** Two "有新内容" mails are at least this far apart (D4). */
export const GAP_MS = 4 * 60 * 60_000;
/** At most this many "有新内容" mails per local date (D4). */
export const PER_DAY = 2;
/** How often the worker decides who gets a mail (D4). */
export const JUDGE_EVERY_MS = 5 * 60_000;
/** A category refused for good is not tried again for a day; nor a backup reason mailed twice (D7, D10). */
export const PAUSE_MS = 24 * 60 * 60_000;
/** A record still sending after this long gives up: Resend keeps an idempotency key 24 hours (D10). */
export const GIVE_UP_MS = 24 * 60 * 60_000;
/** A record taken by a worker is not taken by another for this long. */
export const LEASE_MS = 2 * 60_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** Quiet hours of someone with a zone and no sleep schedule (D4). */
const DEFAULT_SLEEP: Sleep = { start: 23 * 60, end: 8 * 60 };
const QUIET_STEP_MS = 15 * 60_000;

export type Recipient = { timezone: string | null; sleep: Sleep | null };

/** Whether `now` is in the recipient's quiet hours; never for someone without a zone (D4). */
export function quietAt(now: number, who: Recipient): boolean {
  return who.timezone !== null && asleepAt(now, who.timezone, who.sleep ?? DEFAULT_SLEEP);
}

/** The first quarter hour at or after `now` outside quiet hours. */
export function quietUntil(now: number, who: Recipient): number {
  let at = now;
  while (quietAt(at, who) && at - now < 24 * 60 * 60_000) at += QUIET_STEP_MS;
  return at;
}

/** The recipient's local date, in UTC for someone who never reported a zone (D4). */
export const localDateOf = (now: number, who: Recipient) => isoDateIn(now, who.timezone);

/** When the recipient's next local day starts. */
export function nextLocalDay(now: number, who: Recipient): number {
  const zone = who.timezone ?? 'UTC';
  return startOf(addDays(dateIn(now, zone), 1), zone);
}

/** The wait before retrying an unknown outcome: 1 minute, doubling, at most an hour (D10). */
export const backoffMs = (attempts: number) =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

/** Resend's quota resets at the next UTC day or month (D10). */
export function quotaResets(now: number, period: 'day' | 'month'): number {
  const d = new Date(now);
  return period === 'day'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
