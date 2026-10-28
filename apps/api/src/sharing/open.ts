import * as Y from 'yjs';
import { buildBaseline } from '@between-pages/collab';
import type { DateSelection } from '@between-pages/contracts';
import { VersionUnreadable } from '../errors.ts';
import type { LiveEpoch } from '../store/boundaries.ts';
import type { LockedRelations } from '../store/relations.ts';
import type { DiaryQueries, DiaryRow, Store } from '../store/store.ts';
import { covers } from './selection.ts';

// Opening and freezing an owner's diaries for their partner (kernel D4, D5). Opening runs
// in two phases: `prepareOpen` builds and self-checks every clean baseline outside any
// lock and writes nothing; `applyOpen` runs inside the caller's relationship transaction,
// after the users, space and policy locks, locks the diary rows last, rebuilds any diary
// committed to since phase 1, and writes everything or nothing.

/** Some diaries could not get a clean baseline; nothing opened. Thrown inside the transaction so it rolls back. */
export class ShareOpenFailed extends Error {
  readonly dates: string[];
  constructor(dates: string[]) {
    super(`no clean baseline for ${dates.length} diaries`);
    this.dates = dates;
  }
}

type Built = { version: number; generationId: string; baseline: Uint8Array };

/** Phase 1's baselines by diary ID, each for the version and generation it read. */
export type Prepared = Map<string, Built>;

export type Applied = { opened: number; frozen: number; rebuilt: number };

/**
 * Builds the baseline of `diary` at its committed version (D4). A stored part failing its
 * sha256 is a failed build like a failed self-check: `null` either way.
 */
async function baselineOf(queries: DiaryQueries, diary: DiaryRow): Promise<Uint8Array | null> {
  let state: Uint8Array;
  try {
    state = Y.encodeStateAsUpdate(await queries.state(diary.id, diary.generationId, diary.version));
  } catch (error) {
    if (error instanceof VersionUnreadable) return null;
    throw error;
  }
  const built = buildBaseline(state);
  return built.ok ? built.baseline : null;
}

/** Diaries the selection covers that have no live epoch, and live epochs it no longer covers. */
function plan(
  diaries: readonly DiaryRow[],
  live: ReadonlyMap<string, LiveEpoch>,
  selection: DateSelection | null,
) {
  const shared = (diary: DiaryRow) => selection !== null && covers(selection, diary.diaryDate);
  return {
    open: diaries.filter((d) => shared(d) && !live.has(d.id)),
    freeze: diaries.filter((d) => !shared(d) && live.has(d.id)),
  };
}

/**
 * Phase 1 (D5): reads the owner's diaries in one snapshot without locks and builds the
 * baseline of each that `selection` would open. Writes nothing, so a crash here loses only
 * work. `failed` lists the dates whose baseline did not pass its self-check.
 */
export async function prepareOpen(
  store: Store,
  ownerId: string,
  selection: DateSelection,
): Promise<{ prepared: Prepared; failed: string[] }> {
  return store.read(async (queries) => {
    const diaries = await queries.epochs.ownerDiaries(ownerId);
    const live = await queries.epochs.liveEpochs(diaries.map((d) => d.id));
    const prepared: Prepared = new Map();
    const failed: string[] = [];
    for (const diary of plan(diaries, live, selection).open) {
      const baseline = await baselineOf(queries, diary);
      if (baseline)
        prepared.set(diary.id, {
          version: diary.version,
          generationId: diary.generationId,
          baseline,
        });
      else failed.push(diary.diaryDate);
    }
    return { prepared, failed };
  });
}

/**
 * Phase 2 (D5): makes the owner's live epochs match `selection` (null: share nothing)
 * inside the caller's transaction, which already holds the users rows, the space and the
 * policy. Plans again under those locks, since no diary is created and no epoch changes
 * without the owner's users row, then locks the diary rows, rechecks each prepared
 * baseline against the locked version and generation and rebuilds a stale one. Throws
 * ShareOpenFailed before writing anything when a rebuild fails.
 */
export async function applyOpen(
  locked: LockedRelations,
  input: {
    ownerId: string;
    spaceId: string;
    periodId: string;
    recipientId: string;
    selection: DateSelection | null;
    prepared: Prepared;
    at: Date;
  },
): Promise<Applied> {
  const diaries = await locked.epochs.ownerDiaries(input.ownerId);
  const live = await locked.epochs.liveEpochs(diaries.map((d) => d.id));
  const todo = plan(diaries, live, input.selection);
  const toOpen = new Set(todo.open.map((d) => d.id));
  const { rows, queries, boundaries } = await locked.lockDiaries([
    ...toOpen,
    ...todo.freeze.map((d) => d.id),
  ]);

  const baselines = new Map<string, Uint8Array>();
  const failed: string[] = [];
  let rebuilt = 0;
  for (const row of rows.filter((r) => toOpen.has(r.id))) {
    const built = input.prepared.get(row.id);
    if (built?.version === row.version && built.generationId === row.generationId) {
      baselines.set(row.id, built.baseline);
      continue;
    }
    rebuilt++;
    const baseline = await baselineOf(queries, row);
    if (baseline) baselines.set(row.id, baseline);
    else failed.push(row.diaryDate);
  }
  if (failed.length) throw new ShareOpenFailed(failed.sort());

  const context = {
    spaceId: input.spaceId,
    periodId: input.periodId,
    recipientId: input.recipientId,
  };
  const opening = rows.filter((row) => baselines.has(row.id));
  await boundaries.open(
    opening.map((diary) => ({ diary, baseline: baselines.get(diary.id)! })),
    { ...context, newGeneration: true, at: input.at },
  );
  const freezing = rows.filter((row) => !baselines.has(row.id)).map((row) => live.get(row.id)!.id);
  await boundaries.freeze(freezing, input.at);
  return { opened: opening.length, frozen: freezing.length, rebuilt };
}

/** Freezes every live epoch of the space at its diary's last commit (D5: unbinding). */
export async function freezeSpace(
  locked: LockedRelations,
  spaceId: string,
  at: Date,
): Promise<number> {
  const live = await locked.epochs.liveEpochsInSpace(spaceId);
  const { boundaries } = await locked.lockDiaries(live.map((epoch) => epoch.diaryId));
  await boundaries.freeze(
    live.map((epoch) => epoch.id),
    at,
  );
  return live.length;
}
