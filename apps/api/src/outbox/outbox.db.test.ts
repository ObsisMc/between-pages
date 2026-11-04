import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiaryDoc } from '@between-pages/collab';
import type { LockedDocument, Store } from '../store/store.ts';
import { openTestStore, query, testDatabaseUrl } from '../../test/db.ts';
import { createUser } from '../../test/diary.ts';
import { registerBackups } from './outbox.ts';

let store: Store;
let close: (() => Promise<void>) | undefined;
beforeAll(() => {
  if (testDatabaseUrl) ({ store, close } = openTestStore());
});
afterAll(async () => {
  await close?.();
});

const EMPTY = Y.encodeStateAsUpdate(createDiaryDoc());

const emptyCommit = (locked: LockedDocument) =>
  locked.insertCommit({
    batchId: randomUUID(),
    authorId: locked.document.ownerId!,
    generationId: locked.document.generationId,
    epochId: null,
    batchDigest: new Uint8Array(32),
    digestAlgorithm: 1,
    delta: EMPTY,
    operations: [
      { operationId: randomUUID(), updateSha256: new Uint8Array(32), writtenAt: new Date() },
    ],
    ranges: [[]],
    claimedClientIds: [],
    state: () => EMPTY,
  });

async function newDiary() {
  const ownerId = await createUser();
  const { diaryId } = await store.openPersonal({
    ownerId,
    diaryDate: '2026-10-26',
    timezone: 'Asia/Shanghai',
    baseline: EMPTY,
  });
  return diaryId;
}

describe.runIf(testDatabaseUrl)('backup outbox', () => {
  it("registers the owner's personal backup as pending, bound to the committed version", async () => {
    const diaryId = await newDiary();

    await store.withDocumentLock(diaryId, async (locked) => {
      const { version } = await emptyCommit(locked);
      await registerBackups(locked, version, null);
    });

    expect(
      await query('select version::int, target, status from backup_outbox where diary_id = $1', [
        diaryId,
      ]),
    ).toEqual([{ version: 1, target: 'personal', status: 'pending' }]);
  });

  it('leaves no task when the commit transaction rolls back', async () => {
    const diaryId = await newDiary();

    const failing = store.withDocumentLock(diaryId, async (locked) => {
      const { version } = await emptyCommit(locked);
      await registerBackups(locked, version, null);
      throw new Error('a later write failed');
    });

    await expect(failing).rejects.toThrow('a later write failed');
    expect(await query('select 1 from backup_outbox where diary_id = $1', [diaryId])).toEqual([]);
  });

  it('refuses a second task for the same version and target', async () => {
    const diaryId = await newDiary();

    const twice = store.withDocumentLock(diaryId, async (locked) => {
      const { version } = await emptyCommit(locked);
      await registerBackups(locked, version, null);
      await registerBackups(locked, version, null);
    });

    await expect(twice).rejects.toThrow();
    expect(await query('select 1 from backup_outbox where diary_id = $1', [diaryId])).toEqual([]);
  });
});
