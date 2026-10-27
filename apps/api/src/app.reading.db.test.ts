import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type DateSelection, type ReadRange } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Each reader's own read coverage through the real router and PostgreSQL (kernel D15,
// acceptance K15): merged across devices by character identity, kept across reopening,
// visible to its reader alone.

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

const ALL: DateSelection = { include: [{ from: null, to: null }], exclude: [] };
type Person = { id: string; cookie: string };
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const readPath = (diaryId: string) => routes.readRanges.path.replace(':diaryId', diaryId);
const report = (who: Person, diaryId: string, ranges: ReadRange[]) =>
  send(who, 'POST', readPath(diaryId), { ranges });
const coverage = async (who: Person, diaryId: string) => {
  const res = await app.inject({
    method: 'GET',
    url: readPath(diaryId),
    headers: { cookie: who.cookie },
  });
  return res.statusCode === 200
    ? routes.readRanges.response.parse(res.json()).ranges
    : res.statusCode;
};

/** A shares everything with B; A's diary of 2026-10-20 is shared from creation. */
async function shared() {
  const a = await sessions.signIn('A');
  const b = await sessions.signIn('B');
  const invited = routes.createInvitation.response.parse(
    (
      await send(a, 'POST', routes.createInvitation.path, {
        requestId: randomUUID(),
        sharingSelection: ALL,
      })
    ).json(),
  );
  const { binding } = routes.acceptInvitation.response.parse(
    (
      await send(b, 'POST', routes.acceptInvitation.path, {
        token: invited.token,
        sharingSelection: null,
      })
    ).json(),
  );
  const opened = await send(a, 'POST', routes.openDiary.path, {
    timezone: 'Asia/Shanghai',
    date: '2026-10-20',
  });
  const { diary } = routes.openDiary.response.parse(opened.json());
  return { a, b, diaryId: diary.diaryId, spaceId: binding.space.id, periodId: binding.periodId };
}

describe.runIf(testDatabaseUrl)('read coverage', () => {
  it('[adr:diary-collaboration-kernel#26] merges reports from several devices by character identity', async () => {
    const { b, diaryId } = await shared();

    await report(b, diaryId, [{ clientId: 7, from: 0, to: 5 }]);
    const merged = await report(b, diaryId, [
      { clientId: 7, from: 5, to: 9 },
      { clientId: 7, from: 20, to: 22 },
      { clientId: 8, from: 0, to: 3 },
    ]);

    const expected = [
      { clientId: 7, from: 0, to: 9 },
      { clientId: 7, from: 20, to: 22 },
      { clientId: 8, from: 0, to: 3 },
    ];
    expect(routes.reportRead.response.parse(merged.json()).ranges).toEqual(expected);
    expect(await coverage(b, diaryId)).toEqual(expected);
  });

  it('[adr:diary-collaboration-kernel#26] keeps coverage across a stop and reopen, and never shows one reader another’s', async () => {
    const { a, b, diaryId, spaceId, periodId } = await shared();
    await report(b, diaryId, [{ clientId: 7, from: 0, to: 4 }]);
    await report(a, diaryId, [{ clientId: 9, from: 0, to: 1 }]);
    const sharing = routes.saveMySharing.path.replace(':spaceId', spaceId);
    await send(a, 'PUT', sharing, {
      requestId: randomUUID(),
      expectedPeriodId: periodId,
      expectedRevision: 1,
      selection: { include: [], exclude: [] },
    });
    await send(a, 'PUT', sharing, {
      requestId: randomUUID(),
      expectedPeriodId: periodId,
      expectedRevision: 2,
      selection: ALL,
    });

    expect(await coverage(b, diaryId)).toEqual([{ clientId: 7, from: 0, to: 4 }]);
    expect(await coverage(a, diaryId)).toEqual([{ clientId: 9, from: 0, to: 1 }]);
    // Snapshots hold only Yjs state: no one's reading progress is ever in them.
    expect(await query('select 1 from diary_snapshots where diary_id = $1', [diaryId])).toEqual([]);
  });

  it('refuses someone the diary was never shared with, and an empty range', async () => {
    const { diaryId, b } = await shared();
    const c = await sessions.signIn('C');

    expect(await coverage(c, diaryId)).toBe(404);
    expect((await report(c, diaryId, [{ clientId: 1, from: 0, to: 1 }])).statusCode).toBe(404);
    expect((await report(b, diaryId, [{ clientId: 1, from: 3, to: 3 }])).statusCode).toBe(400);
    expect(await query('select 1 from diary_read_ranges where user_id = $1', [c.id])).toEqual([]);
  });
});
