import { z } from 'zod';

// Shapes shared by every space feature beyond the diary (space-records ADR). Each feature
// defines its own records and actions; these are the unread summary for the entry dots and
// the report of records seen on screen (D8).

/** Every record type of every space feature; a feature adds its own here (wishes-and-gifts). */
export const SpaceRecordType = z
  .enum(['wish', 'gift', 'gift_card', 'anniversary', 'shared_page'])
  .meta({ id: 'SpaceRecordType' });
export type SpaceRecordType = z.infer<typeof SpaceRecordType>;

/**
 * How the caller has not seen a record yet (D8): the partner created it, edited it, or did
 * an action on it. Null when it holds nothing new for the caller.
 */
export const RecordUnread = z.enum(['new', 'edited', 'acted']).nullable();

/**
 * Who last changed a piece of current state, and when the server committed it (D4). Shown
 * as "A 改了 · 10 月 31 日".
 */
export const Stamp = z
  .object({ by: z.uuid(), at: z.iso.datetime({ offset: true }) })
  .meta({ id: 'Stamp' });

/** Unread records and deletion notes per feature, for the entry dots (D8). */
export const SpaceUnreadResponse = z
  .object({
    features: z.object({
      wishes: z.number().int().nonnegative(),
      anniversaries: z.number().int().nonnegative(),
      sharedPages: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'SpaceUnreadResponse' });

/**
 * One record seen on screen for about a second. `mark` is the one the record came with: the
 * number of the partner's changes and actions on it the caller could see then, so a change
 * that arrived after the screen loaded stays unread (D8).
 */
export const SeenRecord = z.strictObject({
  type: SpaceRecordType,
  id: z.uuid(),
  mark: z.number().int().nonnegative(),
});

export const ReportSeenRequest = z
  .strictObject({ records: z.array(SeenRecord).min(1).max(200) })
  .meta({ id: 'ReportSeenRequest' });

export const ReportSeenResponse = z
  .object({ recorded: z.literal(true) })
  .meta({ id: 'ReportSeenResponse' });
