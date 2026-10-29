import { z } from 'zod';
import { TimeZone } from './diaries.ts';
import { UserSummary } from './users.ts';

// Two-clocks wire shapes (two-clocks ADR). The zone and the sleep schedule are the person's
// own settings; the partner's appear only while the two are bound (D5), and the answer for
// an unbound or never-reported partner carries nothing that tells the two apart.

/** Minutes after local midnight on a 15-minute grid (D2). */
const LocalMinute = z
  .number()
  .int()
  .min(0)
  .max(1425)
  .refine((minute) => minute % 15 === 0, 'must be on a 15-minute grid');

/** Usual sleep from `start` to `end` in the person's local time; may cross midnight. */
export const SleepSchedule = z
  .strictObject({ start: LocalMinute, end: LocalMinute })
  .refine((sleep) => sleep.start !== sleep.end, 'start and end must differ')
  .meta({ id: 'SleepSchedule' });

export const ClockSettings = z
  .object({ timezone: TimeZone.nullable(), sleep: SleepSchedule.nullable() })
  .meta({ id: 'ClockSettings' });

export const PartnerClock = z
  .object({ user: UserSummary, timezone: TimeZone.nullable(), sleep: SleepSchedule.nullable() })
  .meta({ id: 'PartnerClock' });

/** `partner` is null unless the caller has a current binding (D5). */
export const ClocksResponse = z
  .object({ me: ClockSettings, partner: PartnerClock.nullable() })
  .meta({ id: 'ClocksResponse' });

export const ReportTimezoneRequest = z
  .strictObject({ timezone: TimeZone })
  .meta({ id: 'ReportTimezoneRequest' });

/** `sleep: null` clears the schedule. */
export const SaveSleepRequest = z
  .strictObject({ sleep: SleepSchedule.nullable() })
  .meta({ id: 'SaveSleepRequest' });
