import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Store } from '../store/store.ts';
import { openTestStore, testDatabaseUrl } from '../../test/db.ts';
import { client, createUser, edit, textOf } from '../../test/diary.ts';
import { createDiaryService } from './diaries.ts';

let store: Store;
let close: (() => Promise<void>) | undefined;
beforeAll(() => {
  if (testDatabaseUrl) ({ store, close } = openTestStore());
});
afterAll(async () => {
  await close?.();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Commits `text` through the store, as the commit service would after validation. */
async function commitText(diaryId: string, clientID: number, text: string) {
  const update = edit(client(clientID), (t) => t.insert(0, text));
  return store.withDiaryLock(diaryId, (locked) =>
    locked.insertCommit({
      batchId: randomUUID(),
      authorId: locked.diary.ownerId,
      generationId: locked.diary.generationId,
      batchDigest: new Uint8Array(32),
      digestAlgorithm: 1,
      delta: update,
      operations: [
        { operationId: randomUUID(), updateSha256: new Uint8Array(32), writtenAt: new Date() },
      ],
      ranges: [[{ client: clientID, clock: 0, length: text.length }]],
      claimedClientIds: [clientID],
      state: () => update,
    }),
  );
}

describe.runIf(testDatabaseUrl)('opening a personal diary', () => {
  it('derives today from the server clock and the time zone, not the device (DATE-01)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-24T02:00:00Z') });
    const diaries = createDiaryService(store);
    const a = await createUser();
    const b = await createUser();

    const inShanghai = await diaries.open(a, { timezone: 'Asia/Shanghai' });
    const inLosAngeles = await diaries.open(b, { timezone: 'America/Los_Angeles' });

    expect(inShanghai !== 'FUTURE_DATE' && inShanghai.diary.diaryDate).toBe('2026-10-24');
    expect(inLosAngeles !== 'FUTURE_DATE' && inLosAngeles.diary.diaryDate).toBe('2026-10-23');
  });

  it('[adr:diary-collaboration-kernel#1] opens the same diary again, creates a missing past date and refuses a future one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-26T12:00:00Z') });
    const diaries = createDiaryService(store);
    const owner = await createUser();

    const first = await diaries.open(owner, { timezone: 'Asia/Shanghai' });
    const again = await diaries.open(owner, { timezone: 'Asia/Shanghai' });
    const past = await diaries.open(owner, { timezone: 'Asia/Shanghai', date: '2026-10-05' });
    const future = await diaries.open(owner, { timezone: 'Asia/Shanghai', date: '2026-10-27' });

    expect(first).toMatchObject({ created: true, diary: { diaryDate: '2026-10-26', seq: 0 } });
    expect(again).toMatchObject({ created: false });
    expect(again !== 'FUTURE_DATE' && first !== 'FUTURE_DATE' && again.diary.diaryId).toBe(
      first !== 'FUTURE_DATE' && first.diary.diaryId,
    );
    expect(past).toMatchObject({ created: true, diary: { diaryDate: '2026-10-05' } });
    expect(future).toBe('FUTURE_DATE');
  });

  it('returns the committed text, seq and author bindings, to the owner only', async () => {
    const diaries = createDiaryService(store);
    const owner = await createUser();
    const opened = await diaries.open(owner, { timezone: 'Asia/Shanghai', date: '2026-10-01' });
    if (opened === 'FUTURE_DATE') throw new Error('unexpected');
    await commitText(opened.diary.diaryId, 301, 'written');

    const view = await diaries.view(owner, opened.diary.diaryId);

    expect(view).toMatchObject({ seq: 1, bindings: new Map([[301, owner]]) });
    expect(textOf(view!.state)).toBe('written');
    expect(await diaries.view(await createUser(), opened.diary.diaryId)).toBeNull();
  });
});

describe.runIf(testDatabaseUrl)('catching up', () => {
  it('sends the commits after the known seq of the same generation', async () => {
    const diaries = createDiaryService(store);
    const owner = await createUser();
    const opened = await diaries.open(owner, { timezone: 'Asia/Shanghai', date: '2026-10-02' });
    if (opened === 'FUTURE_DATE') throw new Error('unexpected');
    const { diaryId, generationId } = opened.diary;
    await commitText(diaryId, 302, 'one');
    await commitText(diaryId, 303, 'two');

    const result = await diaries.catchUp(owner, diaryId, generationId, 1);

    expect(result).toMatchObject({ seq: 2, commits: [{ seq: 2 }] });
    if (typeof result === 'string') return;
    const doc = client(0);
    for (const commit of result.commits) Y.applyUpdate(doc, commit.delta);
    expect(doc.getText('body').toString()).toBe('two');
  });

  it('answers STALE_CONTEXT for another generation or a seq the server never reached, NOT_FOUND for others', async () => {
    const diaries = createDiaryService(store);
    const owner = await createUser();
    const opened = await diaries.open(owner, { timezone: 'Asia/Shanghai', date: '2026-10-03' });
    if (opened === 'FUTURE_DATE') throw new Error('unexpected');
    const { diaryId, generationId } = opened.diary;

    expect(await diaries.catchUp(owner, diaryId, randomUUID(), 0)).toBe('STALE_CONTEXT');
    expect(await diaries.catchUp(owner, diaryId, generationId, 5)).toBe('STALE_CONTEXT');
    expect(await diaries.catchUp(await createUser(), diaryId, generationId, 0)).toBe('NOT_FOUND');
  });
});
