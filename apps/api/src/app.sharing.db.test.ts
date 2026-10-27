import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiaryDoc } from '@between-pages/collab';
import type { DateSelection } from '@between-pages/contracts';
import { createBindingService, type BindingService } from './bindings/bindings.ts';
import { createCommitService, type CommitService } from './commit/commit.ts';
import { createDiaryService } from './diaries/diaries.ts';
import type { RelationStore } from './store/relations.ts';
import type { Store } from './store/store.ts';
import { openTestRelationStore, query, testDatabaseUrl } from '../test/db.ts';
import { client, createUser, edit, operation, textOf } from '../test/diary.ts';
import { createEvents } from './events/events.ts';
import { createSharingService, type SharingService } from './sharing/sharing.ts';

// Opening and freezing (kernel D4, D5) across the services as app.ts composes them, on real
// PostgreSQL and without the transport: what a saved range, a binding, an unbinding and a
// new diary write. The route-level answers are in app.spaces.db.test.ts.

let opened: ReturnType<typeof openTestRelationStore> | undefined;
let relations: RelationStore;
let store: Store;
let sharing: SharingService;
let bindings: BindingService;
let commit: CommitService;
beforeAll(() => {
  if (!testDatabaseUrl) return;
  opened = openTestRelationStore();
  ({ relations, store } = opened);
  sharing = createSharingService(relations, store, createEvents());
  bindings = createBindingService(relations, sharing);
  commit = createCommitService(store);
});
afterAll(async () => {
  await opened?.close();
});

const NOW = new Date('2026-10-27T08:00:00Z');
const OCTOBER: DateSelection = { include: [{ from: '2026-10-01', to: '2026-10-31' }], exclude: [] };
const NOTHING: DateSelection = { include: [], exclude: [] };
const EMPTY = Y.encodeStateAsUpdate(createDiaryDoc());

async function bound(selectionA: DateSelection | null = null) {
  const a = await createUser('A');
  const b = await createUser('B');
  const created = await bindings.createInvitation(
    a,
    { requestId: randomUUID(), sharingSelection: selectionA },
    NOW,
  );
  if (typeof created === 'string' || !created.token) throw new Error('no invitation');
  const accepted = await bindings.accept(b, { token: created.token, sharingSelection: null }, NOW);
  if (typeof accepted === 'string' || 'code' in accepted) throw new Error('not bound');
  return { a, b, spaceId: accepted.binding.space.id, periodId: accepted.binding.periodId };
}

/** A private diary of `owner` on `date` holding `text`, written by one client in one commit each. */
async function diaryWith(owner: string, date: string, ...edits: ((t: Y.Text) => void)[]) {
  const { diaryId } = await store.openPersonal({
    ownerId: owner,
    diaryDate: date,
    timezone: 'Asia/Shanghai',
    baseline: EMPTY,
  });
  const writer = client(Math.floor(Math.random() * 2 ** 31));
  for (const change of edits) await write(owner, diaryId, writer, change);
  return { diaryId, writer };
}

async function write(owner: string, diaryId: string, writer: Y.Doc, change: (t: Y.Text) => void) {
  const [row] = await query<{ generation_id: string }>(
    'select generation_id from diaries where id = $1',
    [diaryId],
  );
  const outcome = await commit.commit(owner, {
    diaryId,
    batchId: randomUUID(),
    generationId: row!.generation_id,
    operations: [operation(edit(writer, change))],
  });
  if (!outcome.ok) throw new Error(`commit refused: ${outcome.code}`);
}

const save = (owner: string, spaceId: string, periodId: string, selection: DateSelection) =>
  sharing.mine(owner, spaceId).then((mine) => {
    if (mine === 'NOT_FOUND') throw new Error('no policy');
    return sharing.save(
      owner,
      spaceId,
      {
        requestId: randomUUID(),
        expectedPeriodId: periodId,
        expectedRevision: mine.revision,
        selection,
      },
      NOW,
    );
  });

type EpochRow = {
  id: string;
  diary_id: string;
  recipient_id: string;
  generation_id: string;
  closed_at: Date | null;
  frozen_version: string | null;
};
const epochsOf = (diaryId: string) =>
  query<EpochRow>(
    'select id, diary_id, recipient_id, generation_id, closed_at, frozen_version from share_epochs where diary_id = $1 order by closed_at nulls last, id',
    [diaryId],
  );
const diaryRow = async (diaryId: string) =>
  (
    await query<{ generation_id: string; version: string }>(
      'select generation_id, version from diaries where id = $1',
      [diaryId],
    )
  )[0]!;

describe.runIf(testDatabaseUrl)('opening a range', () => {
  it('[adr:diary-collaboration-kernel#12] opens covered diaries from a clean baseline at seq 0 of a new generation', async () => {
    const { a, b, spaceId, periodId } = await bound();
    const shared = await diaryWith(
      a,
      '2026-10-05',
      (t) => t.insert(0, 'hello '),
      (t) => t.insert(6, 'PRIVATE-WORDS'),
      (t) => t.delete(6, 13),
    );
    const outside = await diaryWith(a, '2026-09-30', (t) => t.insert(0, 'september'));
    const before = await diaryRow(shared.diaryId);

    expect(await save(a, spaceId, periodId, OCTOBER)).toMatchObject({ revision: 1 });

    const [epoch] = await epochsOf(shared.diaryId);
    expect(epoch).toMatchObject({ recipient_id: b, closed_at: null });
    const after = await diaryRow(shared.diaryId);
    expect(after.generation_id).toBe(epoch!.generation_id);
    expect(after.generation_id).not.toBe(before.generation_id);
    const [baseline] = await query<{
      seq: number;
      epoch_id: string;
      delta: Buffer;
      batch_id: null;
    }>(
      'select seq, epoch_id, delta, batch_id from diary_commits where diary_id = $1 and generation_id = $2',
      [shared.diaryId, after.generation_id],
    );
    expect(baseline).toMatchObject({ seq: 0, epoch_id: epoch!.id, batch_id: null });
    expect(textOf(new Uint8Array(baseline!.delta))).toBe('hello ');
    expect(baseline!.delta.includes('PRIVATE-WORDS')).toBe(false);
    expect(
      await query(
        'select target, space_id, epoch_id from backup_outbox where diary_id = $1 and version = $2 order by target',
        [shared.diaryId, after.version],
      ),
    ).toEqual([
      { target: 'personal', space_id: null, epoch_id: null },
      { target: 'space', space_id: spaceId, epoch_id: epoch!.id },
    ]);
    expect(await epochsOf(outside.diaryId)).toEqual([]);
  });

  it('[adr:diary-collaboration-kernel#18] keeps every visible character’s ID and author in the new generation', async () => {
    const { a, spaceId, periodId } = await bound();
    const { diaryId, writer } = await diaryWith(a, '2026-10-06', (t) => t.insert(0, 'abc'));

    await save(a, spaceId, periodId, OCTOBER);

    const state = await store.read(async (q) => {
      const diary = (await q.findDiary(diaryId))!;
      return Y.encodeStateAsUpdate(await q.state(diaryId, diary.generationId, diary.version));
    });
    const doc = createDiaryDoc();
    Y.applyUpdate(doc, state);
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(writer));
    expect(
      await query('select user_id from diary_client_bindings where diary_id = $1', [diaryId]),
    ).toEqual([{ user_id: a }]);
  });

  it('[adr:diary-collaboration-kernel#11] freezes a diary the range no longer covers at its last version, and reopens it as a new epoch', async () => {
    const { a, spaceId, periodId } = await bound();
    const { diaryId, writer } = await diaryWith(a, '2026-10-07', (t) => t.insert(0, 'one'));
    await save(a, spaceId, periodId, OCTOBER);
    const live = await diaryRow(diaryId);

    await save(a, spaceId, periodId, NOTHING);
    const [frozen] = await epochsOf(diaryId);
    expect(frozen!.closed_at).not.toBeNull();
    expect(frozen!.frozen_version).toBe(live.version);
    expect((await diaryRow(diaryId)).generation_id).toBe(live.generation_id);

    await write(a, diaryId, writer, (t) => t.insert(3, ' two'));
    await save(a, spaceId, periodId, OCTOBER);

    const [old, reopened] = await epochsOf(diaryId);
    expect(old).toEqual(frozen);
    expect(reopened).toMatchObject({ closed_at: null });
    expect(reopened!.generation_id).not.toBe(live.generation_id);
  });

  it('[adr:diary-collaboration-kernel#17] saving the same days again opens no new epoch and keeps the generation', async () => {
    const { a, spaceId, periodId } = await bound();
    const { diaryId } = await diaryWith(a, '2026-10-08', (t) => t.insert(0, 'same'));
    await save(a, spaceId, periodId, OCTOBER);
    const live = await diaryRow(diaryId);

    const split: DateSelection = {
      include: [
        { from: '2026-10-16', to: '2026-10-31' },
        { from: '2026-10-01', to: '2026-10-15' },
      ],
      exclude: [],
    };
    expect(await save(a, spaceId, periodId, split)).toMatchObject({ revision: 2 });

    expect(await epochsOf(diaryId)).toHaveLength(1);
    expect(await diaryRow(diaryId)).toEqual(live);
  });

  it('[adr:diary-collaboration-kernel#17] a retried request returns its first result and opens nothing twice', async () => {
    const { a, spaceId, periodId } = await bound();
    const { diaryId } = await diaryWith(a, '2026-10-09', (t) => t.insert(0, 'once'));
    const request = { requestId: randomUUID(), expectedPeriodId: periodId, expectedRevision: 0 };

    const first = await sharing.save(a, spaceId, { ...request, selection: OCTOBER }, NOW);
    const again = await sharing.save(a, spaceId, { ...request, selection: OCTOBER }, NOW);

    expect(again).toEqual(first);
    expect(await epochsOf(diaryId)).toHaveLength(1);
  });

  it('[adr:diary-collaboration-kernel#17] one diary without a clean baseline opens nothing and stores no range', async () => {
    const { a, spaceId, periodId } = await bound();
    const good = await diaryWith(a, '2026-10-10', (t) => t.insert(0, 'good'));
    const broken = await diaryWith(a, '2026-10-11', (t) => t.insert(0, 'broken'));
    await query("update diary_commits set delta_sha256 = '\\x00' where diary_id = $1", [
      broken.diaryId,
    ]);
    const goodBefore = await diaryRow(good.diaryId);

    expect(await save(a, spaceId, periodId, OCTOBER)).toEqual({
      code: 'SHARE_OPEN_FAILED',
      dates: ['2026-10-11'],
    });

    expect(await epochsOf(good.diaryId)).toEqual([]);
    expect(await diaryRow(good.diaryId)).toEqual(goodBefore);
    expect(await sharing.mine(a, spaceId)).toMatchObject({ revision: 0, confirmedPeriodId: null });
  });

  it('[adr:diary-collaboration-kernel#16] rebuilds under the lock a diary committed to after phase 1, keeping that text', async () => {
    const { a, spaceId, periodId } = await bound();
    const { diaryId, writer } = await diaryWith(a, '2026-10-12', (t) => t.insert(0, 'early'));
    const { prepared, failed } = await sharing.prepare(a, OCTOBER);
    expect(failed).toEqual([]);

    await write(a, diaryId, writer, (t) => t.insert(5, ' late'));
    const applied = await relations.withUsersLocked([a], async (locked) => {
      const space = (await locked.lockSpace(spaceId))!;
      return sharing.apply(locked, {
        ownerId: a,
        space,
        periodId,
        selection: OCTOBER,
        prepared,
        at: NOW,
      });
    });

    expect(applied).toMatchObject({ opened: 1, frozen: 0, rebuilt: 1 });
    const { generation_id } = await diaryRow(diaryId);
    const [baseline] = await query<{ delta: Buffer }>(
      'select delta from diary_commits where diary_id = $1 and generation_id = $2 and seq = 0',
      [diaryId, generation_id],
    );
    expect(textOf(new Uint8Array(baseline!.delta))).toBe('early late');
  });
});

describe.runIf(testDatabaseUrl)('binding and unbinding', () => {
  it('[adr:diary-collaboration-kernel#17] accepting an invitation opens both people’s covered diaries in the binding transaction', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    const fromA = await diaryWith(a, '2026-10-01', (t) => t.insert(0, 'a'));
    const fromB = await diaryWith(b, '2026-10-02', (t) => t.insert(0, 'b'));
    const created = await bindings.createInvitation(
      a,
      { requestId: randomUUID(), sharingSelection: OCTOBER },
      NOW,
    );
    if (typeof created === 'string') throw new Error(created);

    const accepted = await bindings.accept(
      b,
      { token: created.token!, sharingSelection: OCTOBER },
      NOW,
    );

    expect(accepted).toMatchObject({ restored: false });
    expect(await epochsOf(fromA.diaryId)).toEqual([expect.objectContaining({ recipient_id: b })]);
    expect(await epochsOf(fromB.diaryId)).toEqual([expect.objectContaining({ recipient_id: a })]);
  });

  it('[adr:diary-collaboration-kernel#17] a failed baseline at binding leaves the two unbound', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    const broken = await diaryWith(b, '2026-10-03', (t) => t.insert(0, 'b'));
    await query("update diary_commits set delta_sha256 = '\\x00' where diary_id = $1", [
      broken.diaryId,
    ]);
    const created = await bindings.createInvitation(
      a,
      { requestId: randomUUID(), sharingSelection: null },
      NOW,
    );
    if (typeof created === 'string') throw new Error(created);

    expect(
      await bindings.accept(b, { token: created.token!, sharingSelection: OCTOBER }, NOW),
    ).toEqual({ code: 'SHARE_OPEN_FAILED', dates: ['2026-10-03'] });
    expect(await bindings.binding(b, NOW)).toMatchObject({ binding: null });
    expect(await bindings.binding(a, NOW)).toMatchObject({ binding: null });
  });

  it('[adr:diary-collaboration-kernel#11] unbinding freezes every live share; rebinding without a range reopens none', async () => {
    const { a, b, spaceId, periodId } = await bound(OCTOBER);
    const { diaryId } = await diaryWith(a, '2026-10-13', (t) => t.insert(0, 'ours'));
    await save(a, spaceId, periodId, OCTOBER);
    const live = await diaryRow(diaryId);

    await bindings.unbind(b, spaceId, periodId, NOW);

    const [frozen] = await epochsOf(diaryId);
    expect(frozen).toMatchObject({ frozen_version: live.version });
    expect(frozen!.closed_at).not.toBeNull();

    const again = await bindings.createInvitation(
      a,
      { requestId: randomUUID(), sharingSelection: null },
      NOW,
    );
    if (typeof again === 'string') throw new Error(again);
    expect(
      await bindings.accept(b, { token: again.token!, sharingSelection: null }, NOW),
    ).toMatchObject({ restored: true });
    expect(await epochsOf(diaryId)).toEqual([frozen]);
  });
});

describe.runIf(testDatabaseUrl)('diaries created later', () => {
  it('a diary created on a covered date opens on creation; one outside stays private', async () => {
    const { a, b, spaceId, periodId } = await bound();
    await save(a, spaceId, periodId, OCTOBER);
    const diaries = createDiaryService(store);

    const inside = await diaries.open(a, { timezone: 'Asia/Shanghai', date: '2026-10-20' });
    const outside = await diaries.open(a, { timezone: 'Asia/Shanghai', date: '2026-09-20' });
    if (inside === 'FUTURE_DATE' || outside === 'FUTURE_DATE') throw new Error('future');

    const [epoch] = await epochsOf(inside.diary.diaryId);
    expect(epoch).toMatchObject({ recipient_id: b, generation_id: inside.diary.generationId });
    expect(inside.diary.seq).toBe(0);
    expect(await epochsOf(outside.diary.diaryId)).toEqual([]);
  });

  it('[adr:spaces-and-invitations#5] a range confirmed for an earlier period opens nothing', async () => {
    const { a, b, spaceId, periodId } = await bound();
    await save(a, spaceId, periodId, OCTOBER);
    await bindings.unbind(a, spaceId, periodId, NOW);
    const again = await bindings.createInvitation(
      a,
      { requestId: randomUUID(), sharingSelection: null },
      NOW,
    );
    if (typeof again === 'string') throw new Error(again);
    await bindings.accept(b, { token: again.token!, sharingSelection: null }, NOW);

    const created = await createDiaryService(store).open(a, {
      timezone: 'Asia/Shanghai',
      date: '2026-10-21',
    });
    if (created === 'FUTURE_DATE') throw new Error('future');
    expect(await epochsOf(created.diary.diaryId)).toEqual([]);
  });
});
