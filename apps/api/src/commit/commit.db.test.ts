import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiaryDoc } from '@between-pages/collab';
import type { Store } from '../store/store.ts';
import { openTestStore, query, testDatabaseUrl } from '../../test/db.ts';
import { client, countRows, createUser, edit, operation, textOf } from '../../test/diary.ts';
import { createCommitService, type SubmitBatch } from './commit.ts';

// The commit chain against real PostgreSQL, without the transport (kernel ADR D9, D11).

let store: Store;
let close: (() => Promise<void>) | undefined;
beforeAll(() => {
  if (testDatabaseUrl) ({ store, close } = openTestStore());
});
afterAll(async () => {
  await close?.();
});

async function newDiary(owner?: string) {
  const ownerId = owner ?? (await createUser());
  const { diaryId } = await store.openPersonal({
    ownerId,
    diaryDate: '2026-10-26',
    timezone: 'Asia/Shanghai',
    baseline: Y.encodeStateAsUpdate(createDiaryDoc()),
  });
  const [row] = await query<{ generation_id: string }>(
    'select generation_id from diaries where id = $1',
    [diaryId],
  );
  return { ownerId, diaryId, generationId: row!.generation_id };
}

const batchOf = (
  diary: { diaryId: string; generationId: string },
  operations: SubmitBatch['operations'],
  batchId = randomUUID(),
): SubmitBatch => ({
  diaryId: diary.diaryId,
  generationId: diary.generationId,
  batchId,
  operations,
});

const committedText = async (diaryId: string) => {
  const view = await store.read(async (q) => {
    const diary = (await q.findDiary(diaryId))!;
    return Y.encodeStateAsUpdate(await q.state(diaryId, diary.generationId, diary.version));
  });
  return textOf(view);
};

const version = async (diaryId: string) =>
  (await query<{ version: string }>('select version from diaries where id = $1', [diaryId]))[0]!
    .version;

describe.runIf(testDatabaseUrl)('commit chain', () => {
  it('[adr:diary-collaboration-kernel#6] commits a batch with its operations, character ranges, bindings and backup task in one version', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const tab = client(101);
    const first = operation(edit(tab, (t) => t.insert(0, '今天晴')));
    const second = operation(edit(tab, (t) => t.insert(3, '，去公园')));

    const outcome = await commit.commit(diary.ownerId, batchOf(diary, [first, second]));

    expect(outcome).toMatchObject({ ok: true, replayed: false });
    if (!outcome.ok) return;
    expect(outcome.receipt).toMatchObject({
      operationIds: [first.operationId, second.operationId],
      generationId: diary.generationId,
      seq: 1,
    });
    expect(await version(diary.diaryId)).toBe('1');
    expect(await committedText(diary.diaryId)).toBe('今天晴，去公园');
    expect(
      await query('select client_id::int, user_id from diary_client_bindings where diary_id = $1', [
        diary.diaryId,
      ]),
    ).toEqual([{ client_id: 101, user_id: diary.ownerId }]);
    expect(
      await query(
        `select r.clock_start::int, r.clock_end::int, o.batch_index
         from diary_character_ranges r
         join diary_client_bindings b using (diary_id, client_id)
         join diary_operations o
           on o.author_id = b.user_id and o.diary_id = r.diary_id and o.operation_id = r.operation_id
         where r.diary_id = $1 order by r.clock_start`,
        [diary.diaryId],
      ),
    ).toEqual([
      { clock_start: 0, clock_end: 3, batch_index: 0 },
      { clock_start: 3, clock_end: 7, batch_index: 1 },
    ]);
    expect(
      await query('select version::int, target, status from backup_outbox where diary_id = $1', [
        diary.diaryId,
      ]),
    ).toEqual([{ version: 1, target: 'personal', status: 'pending' }]);
  });

  it('[adr:diary-collaboration-kernel#8] rejects the whole batch when one operation fails and keeps no prefix', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const tab = client(102);
    const kept = operation(edit(tab, (t) => t.insert(0, 'kept ')));
    expect((await commit.commit(diary.ownerId, batchOf(diary, [kept]))).ok).toBe(true);
    const valid = operation(edit(tab, (t) => t.insert(5, 'valid ')));
    const malformed = operation(new Uint8Array([9, 9, 9, 255]));

    const outcome = await commit.commit(diary.ownerId, batchOf(diary, [valid, malformed]));

    expect(outcome).toEqual({
      ok: false,
      code: 'EDIT_REJECTED',
      reason: 'MALFORMED_UPDATE',
      index: 1,
    });
    expect(await version(diary.diaryId)).toBe('1');
    expect(await countRows('diary_operations', diary.diaryId)).toBe(1);
    // The rejected candidate held "valid "; the next batch must not build on it.
    const next = client(103, kept.update);
    const after = await commit.commit(
      diary.ownerId,
      batchOf(diary, [operation(edit(next, (t) => t.insert(5, 'next')))]),
    );
    expect(after.ok).toBe(true);
    expect(await committedText(diary.diaryId)).toBe('kept next');
  });

  it('[adr:diary-collaboration-kernel#2] rejects text under a clientID bound to another user', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const other = await createUser('other');
    await query(
      'insert into diary_client_bindings (diary_id, client_id, user_id) values ($1, 104, $2)',
      [diary.diaryId, other],
    );
    const forged = operation(edit(client(104), (t) => t.insert(0, 'not mine')));

    expect(await commit.commit(diary.ownerId, batchOf(diary, [forged]))).toMatchObject({
      ok: false,
      code: 'EDIT_REJECTED',
      reason: 'FOREIGN_CLIENT_ID',
    });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(0);
  });

  it('[adr:diary-collaboration-kernel#10] returns the original receipt when a committed batch is sent again', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const batch = batchOf(diary, [operation(edit(client(105), (t) => t.insert(0, 'once')))]);
    const first = await commit.commit(diary.ownerId, batch);

    const again = await commit.commit(diary.ownerId, batch);

    expect(again).toEqual({
      ok: true,
      receipt: first.ok && first.receipt,
      replayed: true,
      event: null,
    });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    expect(await countRows('backup_outbox', diary.diaryId)).toBe(1);
    expect(await committedText(diary.diaryId)).toBe('once');
  });

  it('[adr:diary-collaboration-kernel#10] refuses a batch ID reused with another payload, and an operation reused in another batch', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const tab = client(106);
    const op = operation(edit(tab, (t) => t.insert(0, 'a')));
    const batch = batchOf(diary, [op]);
    await commit.commit(diary.ownerId, batch);
    const later = operation(edit(tab, (t) => t.insert(1, 'b')));

    expect(await commit.commit(diary.ownerId, { ...batch, operations: [op, later] })).toEqual({
      ok: false,
      code: 'BATCH_CONFLICT',
    });
    expect(await commit.commit(diary.ownerId, batchOf(diary, [op, later]))).toEqual({
      ok: false,
      code: 'OPERATION_ALREADY_COMMITTED',
    });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
  });

  it('[adr:diary-collaboration-kernel#10] commits once when the same batch arrives twice at the same moment', async () => {
    const diary = await newDiary();
    const batch = batchOf(diary, [operation(edit(client(107), (t) => t.insert(0, 'twice')))]);
    // Two services stand for two connections, so neither shares the other's memory.
    const results = await Promise.all([
      createCommitService(store).commit(diary.ownerId, batch),
      createCommitService(store).commit(diary.ownerId, batch),
    ]);

    expect(results.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.ok && results[0].receipt).toEqual(results[1]!.ok && results[1].receipt);
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    expect(await committedText(diary.diaryId)).toBe('twice');
  });

  it('[adr:diary-collaboration-kernel#6] rolls back every row when a write fails before COMMIT, and the retry commits once', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const trigger = `bp_test_fail_outbox_${diary.diaryId.replaceAll('-', '')}`;
    await query(`create function ${trigger}() returns trigger as $$
      begin if new.diary_id = '${diary.diaryId}' then raise exception 'planted failure'; end if; return new; end
      $$ language plpgsql`);
    await query(`create trigger ${trigger} before insert on backup_outbox
      for each row execute function ${trigger}()`);
    const batch = batchOf(diary, [operation(edit(client(108), (t) => t.insert(0, 'retry me')))]);
    try {
      await expect(commit.commit(diary.ownerId, batch)).rejects.toThrow();
    } finally {
      await query(`drop trigger ${trigger} on backup_outbox`);
      await query(`drop function ${trigger}()`);
    }
    for (const table of [
      'diary_commits',
      'diary_operations',
      'diary_character_ranges',
      'diary_client_bindings',
    ])
      expect(await countRows(table, diary.diaryId), table).toBe(0);
    expect(await version(diary.diaryId)).toBe('0');

    expect(await commit.commit(diary.ownerId, batch)).toMatchObject({ ok: true, replayed: false });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    expect(await committedText(diary.diaryId)).toBe('retry me');
  });

  it('reloads from PG when another process committed since its memory was built', async () => {
    const diary = await newDiary();
    const here = createCommitService(store);
    const elsewhere = createCommitService(store);
    const tab = client(109);
    await here.commit(
      diary.ownerId,
      batchOf(diary, [operation(edit(tab, (t) => t.insert(0, 'a')))]),
    );
    await elsewhere.commit(
      diary.ownerId,
      batchOf(diary, [operation(edit(tab, (t) => t.insert(1, 'b')))]),
    );

    // `here` still holds version 1; the update below depends on "b", which only PG has.
    const outcome = await here.commit(
      diary.ownerId,
      batchOf(diary, [operation(edit(tab, (t) => t.insert(2, 'c')))]),
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(await committedText(diary.diaryId)).toBe('abc');
  });

  it('answers STALE_CONTEXT for another generation and NOT_FOUND for a diary the caller does not own', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const op = operation(edit(client(110), (t) => t.insert(0, 'x')));

    expect(
      await commit.commit(diary.ownerId, { ...batchOf(diary, [op]), generationId: randomUUID() }),
    ).toEqual({ ok: false, code: 'STALE_CONTEXT' });
    expect(await commit.commit(await createUser(), batchOf(diary, [op]))).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(
      await commit.commit(diary.ownerId, { ...batchOf(diary, [op]), diaryId: randomUUID() }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('keeps a snapshot every 100 versions that rebuilds the same text', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const tab = client(111);
    for (let i = 0; i < 101; i++)
      await commit.commit(
        diary.ownerId,
        batchOf(diary, [operation(edit(tab, (t) => t.insert(t.length, `${i % 10}`)))]),
      );

    expect(
      await query('select version::int from diary_snapshots where diary_id = $1', [diary.diaryId]),
    ).toEqual([{ version: 100 }]);
    // Replay from the baseline only, ignoring the snapshot, must agree with the snapshot path.
    const replayed = createDiaryDoc();
    for (const row of await query<{ delta: Buffer }>(
      'select delta from diary_commits where diary_id = $1 order by version',
      [diary.diaryId],
    ))
      Y.applyUpdate(replayed, row.delta);
    expect(await committedText(diary.diaryId)).toBe(replayed.getText('body').toString());
    expect(await committedText(diary.diaryId)).toHaveLength(101);
  });
});

describe.runIf(testDatabaseUrl)('receipts', () => {
  it('finds the whole batch by its ID or by any operation ID, for its author only', async () => {
    const commit = createCommitService(store);
    const diary = await newDiary();
    const tab = client(112);
    const ops = [
      operation(edit(tab, (t) => t.insert(0, 'x'))),
      operation(edit(tab, (t) => t.insert(1, 'y'))),
    ];
    const batch = batchOf(diary, ops);
    const outcome = await commit.commit(diary.ownerId, batch);
    const receipt = outcome.ok && outcome.receipt;

    expect(await commit.receipt(diary.ownerId, diary.diaryId, { batchId: batch.batchId })).toEqual(
      receipt,
    );
    expect(
      await commit.receipt(diary.ownerId, diary.diaryId, { operationId: ops[1]!.operationId }),
    ).toEqual(receipt);
    expect(
      await commit.receipt(diary.ownerId, diary.diaryId, { batchId: randomUUID() }),
    ).toBeNull();
    expect(
      await commit.receipt(await createUser(), diary.diaryId, { batchId: batch.batchId }),
    ).toBe('NOT_FOUND');
  });
});
