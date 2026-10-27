import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiaryDoc } from '@between-pages/collab';
import { VersionUnreadable } from '../errors.ts';
import type { Store } from '../store/store.ts';
import { openTestStore, query, testDatabaseUrl } from '../../test/db.ts';
import { client, createUser, edit } from '../../test/diary.ts';
import { createReader } from '../reader/reader.ts';
import { PAGE_SIZE, createHistoryService } from './history.ts';

let store: Store;
let close: (() => Promise<void>) | undefined;
beforeAll(() => {
  if (testDatabaseUrl) ({ store, close } = openTestStore());
});
afterAll(async () => {
  await close?.();
});

async function newDiary() {
  const ownerId = await createUser();
  const { diaryId } = await store.openPersonal({
    ownerId,
    diaryDate: '2026-10-26',
    timezone: 'Asia/Shanghai',
    baseline: Y.encodeStateAsUpdate(createDiaryDoc()),
  });
  return { ownerId, diaryId };
}

/** Commits one update through the store and backdates it to `minutes` after 08:00 UTC. */
async function commitAt(diaryId: string, update: Uint8Array, clientID: number, minutes: number) {
  const result = await store.withDiaryLock(diaryId, (locked) =>
    locked.insertCommit({
      batchId: randomUUID(),
      authorId: locked.diary.ownerId,
      generationId: locked.diary.generationId,
      epochId: null,
      batchDigest: new Uint8Array(32),
      digestAlgorithm: 1,
      delta: update,
      operations: [
        { operationId: randomUUID(), updateSha256: new Uint8Array(32), writtenAt: new Date() },
      ],
      ranges: [[]],
      claimedClientIds: locked.diary.version === 0 ? [clientID] : [],
      state: () => update,
    }),
  );
  await query(
    `update diary_commits set committed_at = timestamptz '2026-10-26T08:00:00Z' + make_interval(mins => $3)
     where diary_id = $1 and version = $2`,
    [diaryId, result!.version, minutes],
  );
  return result!.receipt.publicId;
}

const later = new Date('2026-10-27T00:00:00Z');

describe.runIf(testDatabaseUrl)('history', () => {
  it('pages points newest first with an opaque cursor', async () => {
    const history = createHistoryService(createReader(store));
    const { ownerId, diaryId } = await newDiary();
    const tab = client(401);
    const ids: string[] = [];
    // Three minutes apart: every commit closes its own group.
    for (let i = 0; i < PAGE_SIZE + 2; i++)
      ids.push(
        await commitAt(
          diaryId,
          edit(tab, (t) => t.insert(t.length, 'x')),
          401,
          i * 3,
        ),
      );

    const first = await history.page(ownerId, diaryId, undefined, later);
    if (typeof first === 'string') throw new Error(first);
    const second = await history.page(ownerId, diaryId, first.nextCursor!, later);
    if (typeof second === 'string') throw new Error(second);

    expect(first.points).toHaveLength(PAGE_SIZE);
    expect(first.points[0]).toMatchObject({ publicId: ids.at(-1), authors: [ownerId] });
    expect(second).toMatchObject({ nextCursor: null });
    expect(first.nextPointInMs).toBeNull();
    // A minute after the last commit its group is still open: it closes a minute later.
    const lastCommit = Date.parse('2026-10-26T08:00:00Z') + (PAGE_SIZE + 1) * 3 * 60_000;
    expect(
      await history.page(ownerId, diaryId, undefined, new Date(lastCommit + 60_000)),
    ).toMatchObject({ nextPointInMs: 60_000 });
    expect([...first.points, ...second.points].map((p) => p.publicId)).toEqual(ids.toReversed());
    expect(await history.page(ownerId, diaryId, 'not-a-cursor', later)).toBe('BAD_CURSOR');
    expect(await history.page(await createUser(), diaryId, undefined, later)).toBe('NOT_FOUND');
  });

  it('renders a past version as author runs without changing the current one', async () => {
    const history = createHistoryService(createReader(store));
    const { ownerId, diaryId } = await newDiary();
    const tab = client(402);
    const morning = await commitAt(
      diaryId,
      edit(tab, (t) => t.insert(0, 'morning')),
      402,
      0,
    );
    await commitAt(
      diaryId,
      edit(tab, (t) => t.insert(7, ', evening')),
      402,
      30,
    );

    expect(await history.version(ownerId, diaryId, morning)).toMatchObject({
      publicId: morning,
      runs: [{ author: ownerId, text: 'morning' }],
    });
    expect(await history.version(ownerId, diaryId, randomUUID())).toBeNull();
    expect(await history.version(await createUser(), diaryId, morning)).toBeNull();
  });

  it('reports a version whose stored delta fails its sha256 as unreadable, not another version', async () => {
    const history = createHistoryService(createReader(store));
    const { ownerId, diaryId } = await newDiary();
    const publicId = await commitAt(
      diaryId,
      edit(client(403), (t) => t.insert(0, 'x')),
      403,
      0,
    );
    await query(`update diary_commits set delta_sha256 = '\\x00'::bytea where public_id = $1`, [
      publicId,
    ]);

    await expect(history.version(ownerId, diaryId, publicId)).rejects.toBeInstanceOf(
      VersionUnreadable,
    );
  });
});
