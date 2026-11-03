import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { diaryReadRanges } from '../db/schema.ts';
import type { Tx } from './store.ts';

// Each reader's own read coverage (kernel D15): per (reader, diary, clientID) one
// int8multirange of clocks. A report only ever adds to the reporter's own rows, in one
// statement, so two devices reporting at once both count and nothing else is locked.

export type ClockRange = { clientId: number; from: number; to: number };

const RANGE = /\[(\d+),(\d+)\)/g;

function parse(clientId: number, clocks: string): ClockRange[] {
  return [...clocks.matchAll(RANGE)].map(([, from, to]) => ({
    clientId,
    from: Number(from),
    to: Number(to),
  }));
}

/** PG's multirange text for these ranges; PG merges any that overlap or touch. */
const literal = (ranges: readonly ClockRange[]) =>
  `{${ranges.map((r) => `[${r.from},${r.to})`).join(',')}}`;

/** The reader's coverage of the diary, by clientID; in `tx`'s snapshot when given one. */
export async function coverage(
  tx: Db | Tx,
  userId: string,
  diaryId: string,
): Promise<ClockRange[]> {
  const rows = await tx
    .select({
      clientId: diaryReadRanges.clientId,
      clocks: sql<string>`${diaryReadRanges.clocks}::text`,
    })
    .from(diaryReadRanges)
    .where(and(eq(diaryReadRanges.userId, userId), eq(diaryReadRanges.diaryId, diaryId)))
    .orderBy(diaryReadRanges.clientId);
  return rows.flatMap((row) => parse(row.clientId, row.clocks));
}

/** As `coverage`, for many diaries in one query; a diary with none is absent. */
export async function coverageIn(
  tx: Db | Tx,
  userId: string,
  diaryIds: readonly string[],
): Promise<Map<string, ClockRange[]>> {
  const rows = await tx
    .select({
      diaryId: diaryReadRanges.diaryId,
      clientId: diaryReadRanges.clientId,
      clocks: sql<string>`${diaryReadRanges.clocks}::text`,
    })
    .from(diaryReadRanges)
    .where(and(eq(diaryReadRanges.userId, userId), inArray(diaryReadRanges.diaryId, [...diaryIds])))
    .orderBy(diaryReadRanges.diaryId, diaryReadRanges.clientId);
  const out = new Map<string, ClockRange[]>();
  for (const row of rows) {
    const ranges = out.get(row.diaryId);
    if (ranges) ranges.push(...parse(row.clientId, row.clocks));
    else out.set(row.diaryId, parse(row.clientId, row.clocks));
  }
  return out;
}

export function createReadingStore(db: Db) {
  const ranges = (userId: string, diaryId: string) => coverage(db, userId, diaryId);

  return {
    ranges,

    /** Unions `added` into the reader's coverage of the diary and returns all of it. */
    async add(
      userId: string,
      diaryId: string,
      added: readonly ClockRange[],
    ): Promise<ClockRange[]> {
      const byClient = Map.groupBy(added, (range) => range.clientId);
      await db
        .insert(diaryReadRanges)
        .values(
          [...byClient].map(([clientId, own]) => ({
            userId,
            diaryId,
            clientId,
            clocks: literal(own),
          })),
        )
        .onConflictDoUpdate({
          target: [diaryReadRanges.userId, diaryReadRanges.diaryId, diaryReadRanges.clientId],
          set: { clocks: sql`${diaryReadRanges.clocks} + excluded.clocks` },
        });
      return ranges(userId, diaryId);
    },
  };
}

export type ReadingStore = ReturnType<typeof createReadingStore>;
