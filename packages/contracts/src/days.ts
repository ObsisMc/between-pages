import { z } from 'zod';
import { ShareState } from './diaries.ts';

// The merged home list and the day page (unread-and-day-page D2, D3): one entry per date
// the caller can see, with their own diary and the partner's shared one side by side.
// Everything about the partner's diary comes from the authorized-state reader (kernel D17):
// nothing here describes the partner's range or a diary they did not share.

const Uuid = z.uuid();

/** Days dated before `before`; omitted means from the newest. */
export const DaysQuery = z.strictObject({ before: z.iso.date().optional() });

export const DayParams = z.object({ date: z.iso.date() });

/** The caller's own diary of the day. */
export const OwnDay = z
  .object({
    diaryId: Uuid,
    /** As `DiarySummary.excerpt`: empty for a blank diary, null when the text is unreadable. */
    excerpt: z.string().nullable(),
    /** The last written commit, or the creation time before any. */
    updatedAt: z.iso.datetime({ offset: true }),
    /** Some non-blank text; false when the text is unreadable. */
    hasText: z.boolean(),
    /** The partner's text the caller has not read, counting only text already in a history point (D2). */
    unread: z.boolean(),
    /** In a live share the partner can read now. */
    sharedWithPartner: z.boolean(),
  })
  .meta({ id: 'OwnDay' });

/** The partner's diary of the day as shared with the caller: its live share, or else its last frozen one. */
export const PartnerDay = z
  .object({
    diaryId: Uuid,
    epochId: Uuid,
    share: ShareState,
    excerpt: z.string().nullable(),
    /** The last authorized commit. */
    updatedAt: z.iso.datetime({ offset: true }),
    hasText: z.boolean(),
    /** As `OwnDay.unread`; a frozen share counts all of its text. */
    unread: z.boolean(),
  })
  .meta({ id: 'PartnerDay' });

export const Day = z
  .object({ diaryDate: z.iso.date(), mine: OwnDay.nullable(), partner: PartnerDay.nullable() })
  .meta({ id: 'Day' });
export type Day = z.infer<typeof Day>;

/** Newest date first, each date with a diary on at least one side; `nextBefore` asks for the next page. */
export const DaysPage = z
  .object({ days: z.array(Day), nextBefore: z.iso.date().nullable() })
  .meta({ id: 'DaysPage' });

/** One date; both sides null when the caller can see no diary on it. */
export const DayResponse = z.object({ day: Day }).meta({ id: 'DayResponse' });
