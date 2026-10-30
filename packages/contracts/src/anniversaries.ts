import { z } from 'zod';
import { TimeZone } from './diaries.ts';
import { RecordUnread, Stamp } from './space-records.ts';
import { UserSummary } from './users.ts';

// Anniversaries wire shapes (anniversaries ADR, dates per partner-local-dates). Each date is
// counted in its basis zone: the caller's own birthday in the browser's zone, everything
// else in the partner's last reported one, falling back to the browser's while that is
// unknown (partner-local-dates D1, D2). The partner's zone itself never appears here
// (partner-local-dates invariant 3); only two clocks gives it.

const Uuid = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });
const Revision = z.number().int().positive();

export const AnniversaryKind = z
  .enum(['birthday', 'together', 'other'])
  .meta({ id: 'AnniversaryKind' });
export type AnniversaryKind = z.infer<typeof AnniversaryKind>;

/** Actions either of the two may do (D7); the database accepts only these. */
export const AnniversaryActionKind = z.enum(['set_date', 'set_count']);

/** Days of warning before the day (D3): 0 is only on the day itself, null is no reminder. */
export const ReminderDays = z.literal([0, 1, 3, 7, 14, 30]).nullable().meta({ id: 'ReminderDays' });

/**
 * Whose local date counts (partner-local-dates D1, D2): `own` for the caller's own birthday,
 * `partner` for the rest, `unknown` when the partner's zone is not available and the
 * caller's own date counts instead.
 */
export const DateBasis = z.enum(['own', 'partner', 'unknown']).meta({ id: 'DateBasis' });

const Year = z.number().int().min(1900).max(2100);
const Month = z.number().int().min(1).max(12);
const Day = z.number().int().min(1).max(31);

/** A real calendar day; 2 月 29 日 needs a leap year when the year is given (D1). */
const isCalendarDay = (d: { year: number | null; month: number; day: number }) => {
  const at = new Date(Date.UTC(d.year ?? 2000, d.month - 1, d.day));
  return at.getUTCMonth() === d.month - 1 && at.getUTCDate() === d.day;
};
const DateFields = { year: Year.nullable(), month: Month, day: Day };

/**
 * The next day to mark (D2, D3): a yearly anniversary (`years` counts them, the age for a
 * birthday with a year, null without one) or a round day of the count (`count`). `startsAt`
 * and `endsAt` bound that date in the basis zone, so the screen counts down without asking.
 */
export const Occurrence = z
  .object({
    date: z.iso.date(),
    startsAt: Timestamp,
    endsAt: Timestamp,
    type: z.enum(['yearly', 'count']),
    years: z.number().int().nonnegative().nullable(),
    count: z.number().int().positive().nullable(),
    /** Whole days from the basis today to `date`; 0 on the day itself. */
    daysLeft: z.number().int().nonnegative(),
  })
  .meta({ id: 'Occurrence' });

export const Anniversary = z
  .object({
    id: Uuid,
    authorId: Uuid,
    kind: AnniversaryKind,
    /** Whose birthday; null for the other kinds. */
    birthdayOf: Uuid.nullable(),
    /** The name of an `other` anniversary; null for the other kinds. */
    name: z.string().nullable(),
    note: z.string().nullable(),
    ...DateFields,
    dateSet: Stamp.nullable(),
    showCount: z.boolean(),
    countSet: Stamp.nullable(),
    /** The caller's own reminder setting (D3, invariant 4); never the partner's. */
    reminder: ReminderDays,
    basis: DateBasis,
    /** "第 N 天" in the basis zone, the day itself being day 1; null while it is off or not yet begun. */
    dayCount: z.number().int().positive().nullable(),
    next: Occurrence,
    /** Whether `next` is within the caller's reminder period (or is today). */
    due: z.boolean(),
    revision: Revision,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    unread: RecordUnread,
    mark: z.number().int().nonnegative(),
  })
  .meta({ id: 'Anniversary' });

/** The partner deleted an anniversary whose date or count the caller had set (space-records D6). */
export const AnniversaryNote = z
  .object({
    id: Uuid,
    kind: AnniversaryKind,
    birthdayOf: Uuid.nullable(),
    name: z.string().nullable(),
    deleted: Stamp,
    unread: RecordUnread,
    mark: z.number().int().nonnegative(),
  })
  .meta({ id: 'AnniversaryNote' });

/**
 * All anniversaries of the space, soonest first. `home` is the one line of the home strip
 * (D3, invariant 5): the due anniversary that is today, else the soonest; null if none is due.
 */
export const AnniversariesResponse = z
  .object({
    me: UserSummary,
    partner: UserSummary,
    readOnly: z.boolean(),
    anniversaries: z.array(Anniversary),
    home: Uuid.nullable(),
    notes: z.array(AnniversaryNote),
  })
  .meta({ id: 'AnniversariesResponse' });

/**
 * The browser's zone right now, for the caller's own birthday and the fallback
 * (partner-local-dates D2). Writes take it too, since they answer with the record.
 */
export const AnniversariesQuery = z.object({ timezone: TimeZone });

export const AnniversaryParams = z.object({ anniversaryId: Uuid });

/** A gift given for this anniversary, filed under the year of its wall date (D5). */
export const AnniversaryGift = z
  .object({ id: Uuid, name: z.string(), giverId: Uuid, date: z.iso.date() })
  .meta({ id: 'AnniversaryGift' });

/** One year of an anniversary (D5): its date that year, linking to the day page, and its gifts. */
export const AnniversaryYear = z
  .object({ year: z.number().int(), date: z.iso.date(), gifts: z.array(AnniversaryGift) })
  .meta({ id: 'AnniversaryYear' });

export const AnniversaryDetailResponse = z
  .object({
    me: UserSummary,
    partner: UserSummary,
    readOnly: z.boolean(),
    anniversary: Anniversary,
    /** From the first year (the record's year when there is none) to this year, newest first. */
    years: z.array(AnniversaryYear),
  })
  .meta({ id: 'AnniversaryDetailResponse' });

const Note = z.string().trim().max(200).nullable();
const Name = z.string().trim().min(1).max(30).nullable();
const Fields = {
  kind: AnniversaryKind,
  birthdayOf: Uuid.nullable(),
  name: Name,
  note: Note,
};
/** D1: a birthday names whose it is; `other` has a name; only a birthday may omit the year. */
const kindFits = (r: { kind: AnniversaryKind; birthdayOf: string | null; name: string | null }) =>
  (r.kind === 'birthday') === (r.birthdayOf !== null) && (r.kind === 'other') === (r.name !== null);

export const CreateAnniversaryRequest = z
  .strictObject({ requestId: Uuid, ...Fields, ...DateFields })
  .refine(kindFits, 'a birthday needs whose it is, an `other` one a name, and only they')
  .refine((r) => r.kind === 'birthday' || r.year !== null, 'only a birthday may omit the year')
  .refine(isCalendarDay, 'not a calendar day')
  .meta({ id: 'CreateAnniversaryRequest' });

/** The author's fields (D1, invariant 2); the date is an action of its own. */
export const EditAnniversaryRequest = z
  .strictObject({ expectedRevision: Revision, ...Fields })
  .refine(kindFits, 'a birthday needs whose it is, an `other` one a name, and only they')
  .meta({ id: 'EditAnniversaryRequest' });

export const SetAnniversaryDateRequest = z
  .strictObject({ requestId: Uuid, ...DateFields })
  .refine(isCalendarDay, 'not a calendar day')
  .meta({ id: 'SetAnniversaryDateRequest' });

export const SetAnniversaryCountRequest = z
  .strictObject({ requestId: Uuid, showCount: z.boolean() })
  .meta({ id: 'SetAnniversaryCountRequest' });

export const SaveReminderRequest = z
  .strictObject({ days: ReminderDays })
  .meta({ id: 'SaveReminderRequest' });

export const AnniversaryResponse = z
  .object({ anniversary: Anniversary })
  .meta({ id: 'AnniversaryResponse' });
