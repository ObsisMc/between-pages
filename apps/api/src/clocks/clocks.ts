import type { ResponseOf } from '@between-pages/contracts';
import type { ClockRow, ClockStore } from '../store/clocks.ts';

// Two-clocks settings (two-clocks ADR). The zone and schedule belong to the account; the
// partner's are returned only while the two are bound (D5), and a partner who never reported
// looks the same as one whose settings are hidden.

type Settings = ResponseOf<'reportTimezone'>;
type Sleep = NonNullable<Settings['sleep']>;

const settings = (row: ClockRow): Settings => ({
  timezone: row.timezone,
  sleep:
    row.sleepStartMinute === null || row.sleepEndMinute === null
      ? null
      : { start: row.sleepStartMinute, end: row.sleepEndMinute },
});

export function createClockService(store: ClockStore) {
  return {
    async view(caller: string): Promise<ResponseOf<'clocks'>> {
      const { me, partner } = await store.view(caller);
      return {
        me: settings(me),
        partner: partner && {
          user: { id: partner.id, displayName: partner.displayName },
          ...settings(partner),
        },
      };
    },

    /** Only the caller's own zone; the contract has already checked it is an IANA zone (D1). */
    async reportTimezone(caller: string, timezone: string, now: Date): Promise<Settings> {
      return settings(await store.setTimezone(caller, timezone, now));
    },

    async saveSleep(caller: string, sleep: Sleep | null): Promise<Settings> {
      return settings(await store.setSleep(caller, sleep));
    },
  };
}

export type ClockService = ReturnType<typeof createClockService>;
