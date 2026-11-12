import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiaryDoc } from '@between-pages/collab';
import { createDb, type Database } from '../db/client.ts';
import { VersionUnreadable } from '../errors.ts';
import { query, testDatabaseUrl } from '../../test/db.ts';
import { client, createUser, edit } from '../../test/diary.ts';
import { COMMIT_LOCK_TIMEOUT, createStore, type Store } from './store.ts';

// Storage on real PostgreSQL: uniqueness, the lock order of kernel ADR D9 and integrity.

let database: Database;
let store: Store;
beforeAll(() => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  store = createStore(database.db);
});
afterAll(async () => {
  await database?.close();
});

const EMPTY = Y.encodeStateAsUpdate(createDiaryDoc());
const open = (ownerId: string, diaryDate = '2026-10-26') =>
  store.openPersonal({ ownerId, diaryDate, timezone: 'Asia/Shanghai', baseline: EMPTY });

/** A second connection that holds `lock` until released, standing in for another flow. */
async function holdLock(lock: string, params: unknown[]) {
  const other = new pg.Client({ connectionString: testDatabaseUrl });
  await other.connect();
  await other.query('begin');
  await other.query(lock, params);
  return async () => {
    await other.query('commit');
    await other.end();
  };
}

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

async function commitText(diaryId: string, text: string) {
  const update = edit(client(201), (t) => t.insert(0, text));
  return store.withDocumentLock(diaryId, (locked) =>
    locked.insertCommit({
      batchId: randomUUID(),
      authorId: locked.document.ownerId!,
      generationId: locked.document.generationId,
      epochId: null,
      batchDigest: new Uint8Array(32),
      digestAlgorithm: 1,
      delta: update,
      operations: [
        { operationId: randomUUID(), updateSha256: new Uint8Array(32), writtenAt: new Date() },
      ],
      ranges: [[{ client: 201, clock: 0, length: text.length }]],
      claimedClientIds: [201],
      state: () => update,
    }),
  );
}

describe.runIf(testDatabaseUrl)('personal diaries', () => {
  it('[adr:diary-collaboration-kernel#1] creates one diary when 20 requests open the same owner and date at once', async () => {
    const owner = await createUser();
    const other = await createUser();

    const results = await Promise.all(Array.from({ length: 20 }, () => open(owner)));
    const elsewhere = await open(other);

    expect(new Set(results.map((r) => r.diaryId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(elsewhere.diaryId).not.toBe(results[0]!.diaryId);
    const rows = await query<{ id: string; generations: number }>(
      `select d.id, (select count(*)::int from diary_generations g where g.diary_id = d.id) as generations
       from diaries d where owner_id = $1`,
      [owner],
    );
    expect(rows).toEqual([{ id: results[0]!.diaryId, generations: 1 }]);
  });

  it('creates a diary only after the owner row is free of a FOR UPDATE lock', async () => {
    const owner = await createUser();
    const release = await holdLock('select 1 from users where id = $1 for update', [owner]);
    const creating = open(owner);
    try {
      expect(await settledWithin(creating, 300)).toBe(false);
    } finally {
      await release();
    }
    expect((await creating).created).toBe(true);
  });
});

describe.runIf(testDatabaseUrl)('commit lock', () => {
  it('commits while another flow holds the owner row, because a commit locks only the diary row', async () => {
    const owner = await createUser();
    const { diaryId } = await open(owner);
    const release = await holdLock('select 1 from users where id = $1 for update', [owner]);
    try {
      expect(await settledWithin(commitText(diaryId, 'still saves'), 2000)).toBe(true);
    } finally {
      await release();
    }
  });

  it(
    `gives up after ${COMMIT_LOCK_TIMEOUT} on a held diary row and writes nothing`,
    { timeout: 15_000 },
    async () => {
      const owner = await createUser();
      const { diaryId } = await open(owner);
      const release = await holdLock('select 1 from documents where id = $1 for update', [diaryId]);
      const started = Date.now();
      try {
        await expect(commitText(diaryId, 'too late')).rejects.toThrow();
      } finally {
        await release();
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(await query('select 1 from diary_commits where diary_id = $1', [diaryId])).toEqual([]);
    },
  );

  it('waits for a held diary row and commits after it is released', async () => {
    const owner = await createUser();
    const { diaryId } = await open(owner);
    const release = await holdLock('select 1 from documents where id = $1 for update', [diaryId]);
    const committing = commitText(diaryId, 'after');
    try {
      expect(await settledWithin(committing, 300)).toBe(false);
    } finally {
      await release();
    }
    expect(await committing).toMatchObject({ version: 1, receipt: { seq: 1 } });
  });
});

describe.runIf(testDatabaseUrl)('stored state', () => {
  it('rebuilds a version from the baseline and its deltas', async () => {
    const { diaryId } = await open(await createUser());
    await commitText(diaryId, 'hello');

    const text = await store.read(async (q) => {
      const diary = (await q.findDiary(diaryId))!;
      return (await q.state(diaryId, diary.generationId, diary.version)).getText('body').toString();
    });

    expect(text).toBe('hello');
  });

  it('refuses to rebuild from a delta that fails its sha256', async () => {
    const { diaryId } = await open(await createUser());
    await commitText(diaryId, 'hello');
    await query(`update diary_commits set delta = delta || '\\x00'::bytea where diary_id = $1`, [
      diaryId,
    ]);

    const rebuilding = store.read(async (q) => {
      const diary = (await q.findDiary(diaryId))!;
      return q.state(diaryId, diary.generationId, diary.version);
    });

    await expect(rebuilding).rejects.toBeInstanceOf(VersionUnreadable);
  });
});
