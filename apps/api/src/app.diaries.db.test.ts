import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Personal diary routes through the real router and real PostgreSQL (kernel D10).

const ORIGIN = 'http://localhost:5173';
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  app = await buildApp({
    publicOrigin: ORIGIN,
    currentUser: sessions.currentUser,
    db: database.db,
  });
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});

const openDiary = (cookie: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: routes.openDiary.path,
    headers: { origin: ORIGIN, cookie },
    payload,
  });

const get = (cookie: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie } });

describe.runIf(testDatabaseUrl)('opening diaries', () => {
  it('[adr:diary-collaboration-kernel#1] gives 20 concurrent opens of today one diary (DATE-03)', async () => {
    const { cookie } = await sessions.signIn();
    const other = await sessions.signIn();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => openDiary(cookie, { timezone: 'Asia/Shanghai' })),
    );
    const bodies = responses.map((res) => routes.openDiary.response.parse(res.json()));
    const elsewhere = routes.openDiary.response.parse(
      (await openDiary(other.cookie, { timezone: 'Asia/Shanghai' })).json(),
    );

    expect(responses.map((res) => res.statusCode)).toEqual(Array(20).fill(200));
    expect(new Set(bodies.map((b) => b.diary.diaryId)).size).toBe(1);
    expect(bodies.filter((b) => b.created)).toHaveLength(1);
    expect(elsewhere.diary.diaryId).not.toBe(bodies[0]!.diary.diaryId);
    expect(elsewhere.diary.diaryDate).toBe(bodies[0]!.diary.diaryDate);
  });

  it('serves the opened diary by ID to its owner and NOT_FOUND to anyone else (DATE-02)', async () => {
    const owner = await sessions.signIn();
    const stranger = await sessions.signIn();
    const opened = routes.openDiary.response.parse(
      (await openDiary(owner.cookie, { timezone: 'Asia/Shanghai', date: '2026-10-01' })).json(),
    );
    const url = routes.diary.path.replace(':diaryId', opened.diary.diaryId);

    const mine = await get(owner.cookie, url);
    const theirs = await get(stranger.cookie, url);
    const missing = await get(owner.cookie, routes.diary.path.replace(':diaryId', randomUUID()));

    expect(routes.diary.response.parse(mine.json()).diary).toEqual(opened.diary);
    expect(opened.diary).toMatchObject({ ownerId: owner.id, diaryDate: '2026-10-01', seq: 0 });
    for (const res of [theirs, missing]) {
      expect(res.statusCode).toBe(404);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe('NOT_FOUND');
    }
  });

  it('refuses an unknown time zone, an offset, a future date and a client-chosen owner (DATE-05)', async () => {
    const { cookie } = await sessions.signIn();

    for (const payload of [
      { timezone: 'Mars/Olympus' },
      { timezone: '+08:00' },
      { timezone: 'Asia/Shanghai', date: '2999-01-01' },
      { timezone: 'Asia/Shanghai', ownerId: randomUUID() },
    ]) {
      const res = await openDiary(cookie, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe.runIf(testDatabaseUrl)('receipts and history routes', () => {
  it('answers an unknown batch with a null receipt and refuses a query naming both IDs', async () => {
    const { cookie } = await sessions.signIn();
    const opened = routes.openDiary.response.parse(
      (await openDiary(cookie, { timezone: 'Asia/Shanghai' })).json(),
    );
    const base = routes.receipt.path.replace(':diaryId', opened.diary.diaryId);

    const unknown = await get(cookie, `${base}?batchId=${randomUUID()}`);
    const both = await get(cookie, `${base}?batchId=${randomUUID()}&operationId=${randomUUID()}`);

    expect(routes.receipt.response.parse(unknown.json())).toEqual({ receipt: null });
    expect(both.statusCode).toBe(400);
  });

  it('serves an empty history for a new diary and refuses a cursor it never issued', async () => {
    const { cookie } = await sessions.signIn();
    const opened = routes.openDiary.response.parse(
      (await openDiary(cookie, { timezone: 'Asia/Shanghai' })).json(),
    );
    const url = routes.history.path.replace(':diaryId', opened.diary.diaryId);

    expect(routes.history.response.parse((await get(cookie, url)).json())).toEqual({
      points: [],
      nextCursor: null,
    });
    expect((await get(cookie, `${url}?cursor=forged`)).statusCode).toBe(400);
  });
});
