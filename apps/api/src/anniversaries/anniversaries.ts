import { randomUUID } from 'node:crypto';
import type { BodyOf, ResponseOf } from '@between-pages/contracts';
import {
  Refused,
  authorOnly,
  keyOf,
  requestDigest,
  type ReadContext,
  type RecordRef,
  type Refusal,
  type SpaceRecords,
  type Unseen,
  type WriteContext,
} from '../space-records/space-records.ts';
import type { Tx } from '../store/store.ts';
import {
  AnniversaryQueries,
  AnniversaryWrites,
  isSecondTogether,
  type AnniversaryRow,
  type ReminderStore,
} from '../store/anniversaries.ts';
import { addDays, dateIn, daysBetween, isoDate, startOf } from '@between-pages/time';
import { dayCount, nextOccurrence, years } from './dates.ts';

// Anniversaries (anniversaries ADR), written only through space-records. Every date is
// counted in its basis zone (partner-local-dates D1, D2): the caller's own birthday in the
// browser's zone, the rest in the partner's last reported zone while the two are bound,
// else in the browser's. The partner's zone decides dates but never leaves this module
// (partner-local-dates invariant 3).

type Anniversary = ResponseOf<'createAnniversary'>['anniversary'];
type AnniversaryGift = ResponseOf<'anniversary'>['years'][number]['gifts'][number];
type Fields = Pick<BodyOf<'editAnniversary'>, 'kind' | 'birthdayOf' | 'name' | 'note'>;

/** What dates are counted against: the browser's zone and, while bound, the partner's. */
type Clock = { zone: string; partnerZone: string | null; now: Date };

const ref = (id: string): RecordRef => ({ type: 'anniversary', id });
const KIND_ORDER = { birthday: 0, together: 1, other: 2 } as const;

const stamp = (by: string | null, at: Date | null) =>
  by && at ? { by, at: at.toISOString() } : null;

/** Default reminder (D3): only on the day for one's own birthday, else 7 days ahead. */
const defaultReminder = (row: AnniversaryRow, viewer: string) =>
  row.kind === 'birthday' && row.birthdayOf === viewer ? 0 : 7;

function basisOf(row: AnniversaryRow, viewer: string, clock: Clock) {
  if (row.kind === 'birthday' && row.birthdayOf === viewer)
    return { basis: 'own' as const, zone: clock.zone };
  return clock.partnerZone
    ? { basis: 'partner' as const, zone: clock.partnerZone }
    : { basis: 'unknown' as const, zone: clock.zone };
}

function body(
  row: AnniversaryRow,
  viewer: string,
  clock: Clock,
  reminder: number | null,
  unseen: Unseen,
): Anniversary {
  const { basis, zone } = basisOf(row, viewer, clock);
  const today = dateIn(clock.now.getTime(), zone);
  const next = nextOccurrence(row, today);
  const daysLeft = daysBetween(today, next.date);
  return {
    id: row.id,
    authorId: row.authorId,
    kind: row.kind,
    birthdayOf: row.birthdayOf,
    name: row.name,
    note: row.note,
    year: row.year,
    month: row.month,
    day: row.day,
    dateSet: stamp(row.dateSetBy, row.dateSetAt),
    showCount: row.showCount,
    countSet: stamp(row.countSetBy, row.countSetAt),
    reminder: reminder as Anniversary['reminder'],
    basis,
    dayCount: dayCount(row, today),
    next: {
      date: isoDate(next.date),
      startsAt: new Date(startOf(next.date, zone)).toISOString(),
      endsAt: new Date(startOf(addDays(next.date, 1), zone)).toISOString(),
      type: next.type,
      years: next.years,
      count: next.count,
      daysLeft,
    },
    due: reminder !== null && daysLeft <= reminder,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...unseen,
  };
}

/** Soonest first; on one day birthdays, then the together day, then the rest (D3). */
const soonest = (a: Anniversary, b: Anniversary) =>
  Date.parse(a.next.startsAt) - Date.parse(b.next.startsAt) ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

/**
 * The one line of the home strip (invariant 5): a due day that is today, birthdays first,
 * else the soonest due.
 */
function homeOf(list: Anniversary[]): string | null {
  const due = list.filter((a) => a.due).sort(soonest);
  const today = due
    .filter((a) => a.next.daysLeft === 0)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return (today[0] ?? due[0])?.id ?? null;
}

async function present(
  ctx: { tx: Tx; caller: string; unseen: ReadContext['unseen'] },
  rows: AnniversaryRow[],
  clock: Clock,
): Promise<Anniversary[]> {
  const q = new AnniversaryQueries(ctx.tx);
  const [reminders, unseen] = await Promise.all([
    q.reminders(
      ctx.caller,
      rows.map((r) => r.id),
    ),
    ctx.unseen(rows.map((r) => ref(r.id))),
  ]);
  return rows.map((row) =>
    body(
      row,
      ctx.caller,
      clock,
      reminders.has(row.id) ? reminders.get(row.id)! : defaultReminder(row, ctx.caller),
      unseen.get(keyOf(ref(row.id)))!,
    ),
  );
}

/** The partner's zone only while the two are bound (partner-local-dates D2, two-clocks D5). */
const clockOf = async (
  ctx: { tx: Tx; partnerId: string },
  bound: boolean,
  zone: string,
  now: Date,
) => ({
  zone,
  now,
  partnerZone: bound ? await new AnniversaryQueries(ctx.tx).timezoneOf(ctx.partnerId) : null,
});

/** Checks a birthday belongs to one of the two (D1). */
function checkFields(ctx: WriteContext, fields: Fields) {
  if (fields.birthdayOf !== null && ![ctx.caller, ctx.partnerId].includes(fields.birthdayOf))
    throw new Refused('VALIDATION_FAILED');
}

/** The second together day is refused as RECORD_EXISTS (invariant 1). */
async function together<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isSecondTogether(error)) throw new Refused('RECORD_EXISTS');
    throw error;
  }
}

export function createAnniversaryService(records: SpaceRecords, reminders: ReminderStore) {
  const writes = (ctx: WriteContext) => new AnniversaryWrites(ctx.tx);
  const action = (route: string, input: unknown, requestId: string) => ({
    id: requestId,
    digest: requestDigest(route, input),
    source: 'action' as const,
  });

  /** One anniversary as the caller sees it after a write, in the write's transaction. */
  const answer = async (ctx: WriteContext, id: string, zone: string, now: Date) => {
    const row = await new AnniversaryQueries(ctx.tx).one(ctx.spaceId, id);
    if (!row) throw new Refused('NOT_FOUND');
    return (await present(ctx, [row], await clockOf(ctx, true, zone, now)))[0]!;
  };

  return {
    async view(
      caller: string,
      zone: string,
      now: Date,
    ): Promise<ResponseOf<'anniversaries'> | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) => {
        const q = new AnniversaryQueries(ctx.tx);
        const [rows, people] = await Promise.all([
          q.list(ctx.spaceId),
          q.people([caller, ctx.partnerId]),
        ]);
        const list = (await present(ctx, rows, await clockOf(ctx, !ctx.readOnly, zone, now))).sort(
          soonest,
        );
        const notes = await ctx.deletionNotes(['anniversary']);
        const deleted = new Map(
          (
            await q.byIds(
              ctx.spaceId,
              notes.map((n) => n.ref.id),
            )
          ).map((r) => [r.id, r]),
        );
        const person = (id: string) => people.find((p) => p.id === id)!;
        return {
          me: person(caller),
          partner: person(ctx.partnerId),
          readOnly: ctx.readOnly,
          anniversaries: list,
          home: ctx.readOnly ? null : homeOf(list),
          notes: notes
            .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
            .map((n) => {
              const row = deleted.get(n.ref.id)!;
              return {
                id: row.id,
                kind: row.kind,
                birthdayOf: row.birthdayOf,
                name: row.name,
                deleted: { by: n.deletedBy, at: n.deletedAt.toISOString() },
                unread: n.unread ? ('acted' as const) : null,
                mark: n.mark,
              };
            }),
        };
      });
    },

    /**
     * One anniversary with every year from its first (D5): the year it began, or for a
     * birthday without one the year it was recorded, up to this year in its basis zone.
     * `gifts` are the wall's gifts given for it, filed under their date's year.
     */
    async detail(
      caller: string,
      id: string,
      zone: string,
      now: Date,
      gifts: AnniversaryGift[],
    ): Promise<ResponseOf<'anniversary'> | 'NOT_FOUND'> {
      const found = await records.read(caller, async (ctx) => {
        const q = new AnniversaryQueries(ctx.tx);
        const row = await q.one(ctx.spaceId, id);
        if (!row) return 'NOT_FOUND' as const;
        const people = await q.people([caller, ctx.partnerId]);
        const clock = await clockOf(ctx, !ctx.readOnly, zone, now);
        const [anniversary] = await present(ctx, [row], clock);
        const thisYear = dateIn(now.getTime(), basisOf(row, caller, clock).zone).year;
        const first = row.year ?? row.createdAt.getUTCFullYear();
        const person = (pid: string) => people.find((p) => p.id === pid)!;
        return {
          me: person(caller),
          partner: person(ctx.partnerId),
          readOnly: ctx.readOnly,
          anniversary: anniversary!,
          years: years(row, first, thisYear).map((date) => ({
            year: date.year,
            date: isoDate(date),
            gifts: gifts.filter((g) => g.date.startsWith(`${date.year}-`)),
          })),
        };
      });
      return found;
    },

    /** Anniversaries and deletion notes holding something unseen, for the entry dot (space-records D8). */
    async unread(caller: string): Promise<number | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) => {
        const rows = await new AnniversaryQueries(ctx.tx).list(ctx.spaceId);
        const unseen = await ctx.unseen(rows.map((r) => ref(r.id)));
        const notes = await ctx.deletionNotes(['anniversary']);
        return (
          [...unseen.values()].filter((u) => u.unread !== null).length +
          notes.filter((n) => n.unread).length
        );
      });
    },

    /**
     * An anniversary of the caller's space as a gift's occasion, with the name the gift
     * keeps (D4): whose birthday, the together day, or its own name.
     */
    async occasion(
      caller: string,
      id: string,
    ): Promise<{ id: string; name: string } | 'NOT_FOUND'> {
      const found = await records.read(caller, async (ctx) => {
        const q = new AnniversaryQueries(ctx.tx);
        const row = await q.one(ctx.spaceId, id);
        if (!row) return 'NOT_FOUND' as const;
        if (row.kind === 'other') return { id, name: row.name! };
        if (row.kind === 'together') return { id, name: '在一起的日子' };
        const [owner] = await q.people([row.birthdayOf!]);
        return { id, name: `${owner!.displayName} 的生日` };
      });
      return found;
    },

    create(
      caller: string,
      input: BodyOf<'createAnniversary'>,
      zone: string,
      now: Date,
    ): Promise<Anniversary | Refusal> {
      const request = {
        id: input.requestId,
        digest: requestDigest('createAnniversary', input),
        source: 'change' as const,
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          checkFields(ctx, input);
          const row = await together(
            writes(ctx).insert({
              id: randomUUID(),
              spaceId: ctx.spaceId,
              authorId: caller,
              createdPeriodId: ctx.periodId,
              kind: input.kind,
              birthdayOf: input.birthdayOf,
              name: input.name,
              note: input.note || null,
              year: input.year,
              month: input.month,
              day: input.day,
              // The together day counts by default (D2).
              showCount: input.kind === 'together',
            }),
          );
          await ctx.changed(ref(row.id), 'create', null, request);
          return answer(ctx, row.id, zone, now);
        },
        (ctx, hit) => answer(ctx, hit.recordId, zone, now),
      );
    },

    edit(
      caller: string,
      id: string,
      input: BodyOf<'editAnniversary'>,
      zone: string,
      now: Date,
    ): Promise<Anniversary | Refusal> {
      return records.write(caller, null, async (ctx) => {
        const w = writes(ctx);
        const row = await w.lock(ctx.spaceId, id);
        if (!row) throw new Refused('NOT_FOUND');
        authorOnly(caller, row);
        if (row.revision !== input.expectedRevision) throw new Refused('RECORD_STALE');
        checkFields(ctx, input);
        if (input.kind !== 'birthday' && row.year === null) throw new Refused('VALIDATION_FAILED');
        await together(
          w.update(row.id, {
            kind: input.kind,
            birthdayOf: input.birthdayOf,
            name: input.name,
            note: input.note || null,
            revision: row.revision + 1,
            updatedAt: now,
          }),
        );
        await ctx.changed(ref(row.id), 'edit', null);
        return answer(ctx, row.id, zone, now);
      });
    },

    /** Gifts given for it keep the name they copied (D4, invariant 6). */
    remove(caller: string, id: string, requestId: string): Promise<true | Refusal> {
      const request = {
        id: requestId,
        digest: requestDigest('deleteAnniversary', { id }),
        source: 'change' as const,
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const row = await w.lock(ctx.spaceId, id);
          if (!row) throw new Refused('NOT_FOUND');
          authorOnly(caller, row);
          await w.update(row.id, { deletedAt: new Date(), deletedBy: caller });
          await ctx.changed(ref(row.id), 'delete', null, request);
          return true as const;
        },
        async () => true as const,
      );
    },

    /** Either of the two corrects the date or turns the count on or off (D7, invariant 2). */
    set(
      caller: string,
      id: string,
      set:
        | { kind: 'set_date'; year: number | null; month: number; day: number }
        | { kind: 'set_count'; showCount: boolean },
      requestId: string,
      zone: string,
      now: Date,
    ): Promise<Anniversary | Refusal> {
      const request = action(set.kind, { id, set }, requestId);
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const row = await w.lock(ctx.spaceId, id);
          if (!row) throw new Refused('NOT_FOUND');
          if (set.kind === 'set_date') {
            if (set.year === null && (row.kind !== 'birthday' || row.showCount))
              throw new Refused('VALIDATION_FAILED');
            await w.update(row.id, {
              year: set.year,
              month: set.month,
              day: set.day,
              dateSetBy: caller,
              dateSetAt: now,
            });
          } else {
            if (set.showCount && row.year === null) throw new Refused('VALIDATION_FAILED');
            await w.update(row.id, {
              showCount: set.showCount,
              countSetBy: caller,
              countSetAt: now,
            });
          }
          await ctx.acted(ref(row.id), set.kind, null, request);
          return answer(ctx, row.id, zone, now);
        },
        (ctx) => answer(ctx, id, zone, now),
      );
    },

    /** The caller's own reminder (D3, invariant 4): no history, no unread, allowed while unbound. */
    async saveReminder(
      caller: string,
      id: string,
      days: number | null,
      zone: string,
      now: Date,
    ): Promise<Anniversary | 'NOT_FOUND'> {
      const space = await records.read(caller, async (ctx) => ctx.spaceId);
      if (space === 'NOT_FOUND' || !(await reminders.save(caller, space, id, days)))
        return 'NOT_FOUND';
      return records.read(caller, async (ctx) => {
        const row = await new AnniversaryQueries(ctx.tx).one(ctx.spaceId, id);
        if (!row) return 'NOT_FOUND' as const;
        return (await present(ctx, [row], await clockOf(ctx, !ctx.readOnly, zone, now)))[0]!;
      });
    },
  };
}

export type AnniversaryService = ReturnType<typeof createAnniversaryService>;
