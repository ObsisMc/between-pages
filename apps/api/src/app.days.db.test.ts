import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorRuns } from '@between-pages/collab';
import { routes, type DateSelection, type Day, type ReadRange } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, edit, testSessions } from '../test/diary.ts';
import { connectSocket } from '../test/socket.ts';

// The day list and one day through the real router, socket and PostgreSQL
// (unread-and-day-page D2, D3): own and shared diaries merged by date, and the list's
// unread mark by character identity, counting only text a history point already holds.
// A history point closes once its commits are older than the idle time, so tests move
// commits into the past instead of waiting.

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
const NOTHING: DateSelection = { include: [], exclude: [] };
const SECRET = 'PRIVATE-WORDS';
const DATE = '2026-10-20';

type Person = { id: string; cookie: string };
const path = (template: string, params: Record<string, string>) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, v), template);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

/** A and B bound; A shares `aShares`, B shares `bShares`. */
async function pair(aShares: DateSelection = ALL, bShares: DateSelection = NOTHING) {
  const a = await sessions.signIn('A');
  const b = await sessions.signIn('B');
  const invited = routes.createInvitation.response.parse(
    (
      await send(a, 'POST', routes.createInvitation.path, {
        requestId: randomUUID(),
        sharingSelection: aShares,
      })
    ).json(),
  );
  const accepted = routes.acceptInvitation.response.parse(
    (
      await send(b, 'POST', routes.acceptInvitation.path, {
        token: invited.token,
        sharingSelection: bShares,
      })
    ).json(),
  );
  const { space, periodId } = accepted.binding;
  let revision = 1;
  /** A saves a new range. */
  const saveRange = async (selection: DateSelection) => {
    const res = await send(a, 'PUT', path(routes.saveMySharing.path, { spaceId: space.id }), {
      requestId: randomUUID(),
      expectedPeriodId: periodId,
      expectedRevision: revision,
      selection,
    });
    revision = routes.saveMySharing.response.parse(res.json()).revision;
  };
  return { a, b, saveRange };
}

async function ownDiary(owner: Person, date = DATE) {
  const res = await send(owner, 'POST', routes.openDiary.path, { timezone: 'Asia/Shanghai', date });
  return routes.openDiary.response.parse(res.json()).diary.diaryId;
}

async function days(who: Person, before?: string) {
  return daysAt(who, before ? `?before=${before}` : '');
}

async function daysAt(who: Person, search: string) {
  const res = await get(who, routes.days.path + search);
  expect(res.statusCode).toBe(200);
  return routes.days.response.parse(res.json());
}

async function nextUnread(who: Person, search = '') {
  const res = await get(who, routes.nextUnread.path + search);
  expect(res.statusCode).toBe(200);
  return routes.nextUnread.response.parse(res.json()).date;
}

async function day(who: Person, date = DATE): Promise<Day> {
  const res = await get(who, path(routes.day.path, { date }));
  expect(res.statusCode).toBe(200);
  return routes.day.response.parse(res.json()).day;
}

/** The text view `who` reads: the own diary, or the partner's share by its epoch. */
async function view(who: Person, diaryId: string, epochId?: string) {
  if (!epochId)
    return routes.diary.response.parse(
      (await get(who, path(routes.diary.path, { diaryId }))).json(),
    ).diary;
  return routes.sharedDiary.response.parse(
    (await get(who, path(routes.sharedDiary.path, { diaryId, epochId }))).json(),
  ).diary;
}

let nextClient = 7000;
/**
 * Writes one change as `who` from a new editor instance on the text they read now, and
 * waits for its ACK; returns the instance's clientID.
 */
async function write(
  who: Person,
  diaryId: string,
  change: (text: Y.Text) => void,
  epochId?: string,
): Promise<number> {
  const state = await view(who, diaryId, epochId);
  const socket = await connectSocket(app, who.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId,
    generationId: state.generationId,
    ...(epochId ? { epochId } : {}),
    knownSeq: state.seq,
  });
  expect(await socket.next()).toMatchObject({ type: 'synced' });
  const clientID = nextClient++;
  const batchId = randomUUID();
  socket.send({
    v: 1,
    type: 'submit',
    diaryId,
    batchId,
    generationId: state.generationId,
    ...(epochId ? { epochId } : {}),
    operations: [
      {
        operationId: randomUUID(),
        update: base64(edit(client(clientID, bytesOf(state.state)), change)),
        writtenAt: '2026-10-20T09:00:00+08:00',
      },
    ],
  });
  for (;;) {
    const answer = await socket.next();
    if (answer.type === 'ack' && answer.receipt.batchId === batchId) break;
    if (answer.type === 'error') throw new Error(answer.code);
  }
  socket.close();
  return clientID;
}

/** Moves every commit of the diary an hour back, so each has become a history point. */
async function settle(diaryId: string) {
  await query(
    `update diary_commits set committed_at = committed_at - interval '1 hour' where diary_id = $1`,
    [diaryId],
  );
}

/**
 * The unread characters the diary page would find, computed as the browser does from the
 * served text and the reader's coverage: the other author's visible characters not read.
 */
async function pageUnread(who: Person, diaryId: string, epochId?: string) {
  const state = await view(who, diaryId, epochId);
  const doc = client(1, bytesOf(state.state));
  const read = routes.readRanges.response.parse(
    (await get(who, path(routes.readRanges.path, { diaryId }))).json(),
  ).ranges;
  const bindings = new Map(state.bindings.map((x) => [x.clientId, x.userId]));
  return authorRuns(doc, bindings)
    .filter((run) => run.author !== who.id)
    .flatMap((run) =>
      Array.from({ length: run.text.length }, (_, i) => run.clock + i).filter(
        (clock) => !read.some((r) => r.clientId === run.client && r.from <= clock && clock < r.to),
      ),
    );
}

const report = (who: Person, diaryId: string, ranges: ReadRange[]) =>
  send(who, 'POST', path(routes.reportRead.path, { diaryId }), { ranges });

describe.runIf(testDatabaseUrl)('the day list', () => {
  it('[adr:unread-and-day-page#1] [adr:unread-and-day-page#4] counts the other author’s text once a history point holds it, never the viewer’s own', async () => {
    const { a, b } = await pair();
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'A writes. '));
    await settle(diaryId);
    const { epochId } = (await day(b)).partner!;

    // A's own text is never A's unread; B's is, but only once a point holds it.
    expect((await day(a)).mine).toMatchObject({ unread: false, hasText: true });
    await write(b, diaryId, (t) => t.insert(t.length, 'B answers.'), epochId);
    expect((await day(a)).mine!.unread).toBe(false);
    await settle(diaryId);
    expect((await day(a)).mine!.unread).toBe(true);

    // B's own text in A's diary is not B's unread; A's text is.
    expect((await day(b)).partner).toMatchObject({ share: 'live', unread: true });
    const [aText] = (await view(b, diaryId, epochId)).bindings.filter((x) => x.userId === a.id);
    await report(b, diaryId, [{ clientId: aText!.clientId, from: 0, to: 10 }]);
    expect((await day(b)).partner!.unread).toBe(false);

    // Text after the newest point leaves the mark as it was until a point holds it.
    await write(a, diaryId, (t) => t.insert(t.length, ' More.'));
    expect((await day(b)).partner!.unread).toBe(false);
    await settle(diaryId);
    expect((await day(b)).partner!.unread).toBe(true);
  });

  it('[adr:unread-and-day-page#2] judges by character identity: half read stays unread, retyped text is new', async () => {
    const { a, b } = await pair();
    const diaryId = await ownDiary(a);
    const writer = await write(a, diaryId, (t) => t.insert(0, 'abcdef'));
    await settle(diaryId);

    await report(b, diaryId, [{ clientId: writer, from: 0, to: 3 }]);
    expect((await day(b)).partner!.unread).toBe(true);
    await report(b, diaryId, [{ clientId: writer, from: 3, to: 6 }]);
    expect((await day(b)).partner!.unread).toBe(false);

    // The same letters deleted and typed again are new characters.
    await write(a, diaryId, (t) =>
      t.doc!.transact(() => {
        t.delete(3, 3);
        t.insert(3, 'def');
      }),
    );
    await settle(diaryId);
    expect((await day(b)).partner).toMatchObject({ excerpt: 'abcdef', unread: true });
  });

  it('[adr:unread-and-day-page#3] [adr:unread-and-day-page#5] leaves no unread for deleted text: written then deleted, or only deleted', async () => {
    const { a, b } = await pair();
    const diaryId = await ownDiary(a);
    const { epochId } = (await day(b)).partner!;

    // B writes and deletes before any point: A's list never lights.
    await write(b, diaryId, (t) => t.insert(0, 'oops'), epochId);
    await write(b, diaryId, (t) => t.delete(0, 4), epochId);
    await settle(diaryId);
    expect((await day(a)).mine).toMatchObject({ unread: false, hasText: false, excerpt: '' });

    // A reads all of B's text; B then only deletes some of it: nothing new to read.
    const writer = await write(b, diaryId, (t) => t.insert(0, 'kept words'), epochId);
    await settle(diaryId);
    expect((await day(a)).mine!.unread).toBe(true);
    expect(await pageUnread(a, diaryId)).toHaveLength(10);
    await report(a, diaryId, [{ clientId: writer, from: 0, to: 10 }]);
    await write(b, diaryId, (t) => t.delete(4, 6), epochId);
    await settle(diaryId);
    expect((await day(a)).mine).toMatchObject({ unread: false, excerpt: 'kept' });

    // Unread text deleted after the point is gone from the list too: the diary has none to jump to.
    await write(b, diaryId, (t) => t.insert(4, ' again'), epochId);
    await settle(diaryId);
    expect((await day(a)).mine!.unread).toBe(true);
    expect(await pageUnread(a, diaryId)).toHaveLength(6);
    await write(b, diaryId, (t) => t.delete(4, 6), epochId);
    expect((await day(a)).mine!.unread).toBe(false);
    expect(await pageUnread(a, diaryId)).toEqual([]);
  });

  it('[adr:unread-and-day-page#4] [adr:unread-and-day-page#12] counts a frozen share at once, and private text after the stop never shows', async () => {
    const { a, b, saveRange } = await pair();
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'before the stop'));
    await saveRange(NOTHING);

    // The stop made the frozen version a point: no idle wait.
    const frozen = (await day(b)).partner!;
    expect(frozen).toMatchObject({ share: 'frozen', unread: true, excerpt: 'before the stop' });
    expect((await day(a)).mine!.sharedWithPartner).toBe(false);

    const [writer] = (await view(b, diaryId, frozen.epochId)).bindings;
    await report(b, diaryId, [{ clientId: writer!.clientId, from: 0, to: 15 }]);
    await write(a, diaryId, (t) => t.insert(t.length, SECRET));
    await settle(diaryId);
    const res = await get(b, path(routes.day.path, { date: DATE }));
    expect(res.body).not.toContain(SECRET);
    expect(routes.day.response.parse(res.json()).day.partner).toMatchObject({
      share: 'frozen',
      unread: false,
      excerpt: 'before the stop',
    });
    expect((await days(b)).days[0]!.partner).toMatchObject({ unread: false });
  });

  it('[adr:unread-and-day-page#10] [adr:unread-and-day-page#12] shows no trace of a diary never shared with the viewer', async () => {
    const { a, b } = await pair(NOTHING, NOTHING);
    await ownDiary(a);
    await write(a, await ownDiary(a, '2026-10-21'), (t) => t.insert(0, SECRET));
    await ownDiary(b);
    const outsider = await sessions.signIn('C');

    // B sees their own diary of the date alone, and nothing of A's other date.
    const listed = await days(b);
    expect(listed).toEqual({
      days: [{ diaryDate: DATE, mine: expect.objectContaining({ unread: false }), partner: null }],
      nextBefore: null,
      nextAfter: null,
    });
    expect(await day(b, '2026-10-21')).toEqual({
      diaryDate: '2026-10-21',
      mine: null,
      partner: null,
    });
    expect((await days(outsider)).days).toEqual([]);
    expect(await day(outsider)).toEqual({ diaryDate: DATE, mine: null, partner: null });
    expect((await day(b)).mine!.sharedWithPartner).toBe(false);
  });

  it('merges both people’s dates newest first, 20 per page, each date once', async () => {
    const odd = { include: [{ from: '2026-09-01', to: '2026-09-30' }], exclude: [] };
    const { a, b } = await pair(odd, NOTHING);
    // A writes on the 1st–15th, B on the 11th–25th: 25 dates, 5 of them shared by both.
    for (let n = 1; n <= 15; n++) await ownDiary(a, `2026-09-${String(n).padStart(2, '0')}`);
    for (let n = 11; n <= 25; n++) await ownDiary(b, `2026-09-${String(n).padStart(2, '0')}`);

    const first = await days(b);
    const second = await days(b, first.nextBefore!);
    const dates = [...first.days, ...second.days].map((d) => d.diaryDate);
    expect(first.days).toHaveLength(20);
    expect(second.nextBefore).toBeNull();
    expect(dates).toEqual(
      Array.from({ length: 25 }, (_, i) => `2026-09-${String(25 - i).padStart(2, '0')}`),
    );
    const both = [...first.days, ...second.days].filter((d) => d.mine && d.partner);
    expect(both.map((d) => d.diaryDate)).toEqual([
      '2026-09-15',
      '2026-09-14',
      '2026-09-13',
      '2026-09-12',
      '2026-09-11',
    ]);
    // A shares, B does not: A's diaries say so, B's do not.
    expect((await day(a, '2026-09-12')).mine!.sharedWithPartner).toBe(true);
    expect(first.days[0]!.mine!.sharedWithPartner).toBe(false);
  });

  it('[adr:book-frontend-workspace#4] pages newer dates after an anchor, nearest first, still newest first in the page', async () => {
    const odd = { include: [{ from: '2026-09-01', to: '2026-09-30' }], exclude: [] };
    const { a, b } = await pair(odd, NOTHING);
    for (let n = 1; n <= 15; n++) await ownDiary(a, `2026-09-${String(n).padStart(2, '0')}`);
    for (let n = 11; n <= 25; n++) await ownDiary(b, `2026-09-${String(n).padStart(2, '0')}`);
    const dates = (page: { days: Day[] }) => page.days.map((d) => d.diaryDate);
    const sept = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;

    const up = await daysAt(b, '?after=2026-09-01');
    expect(dates(up)).toEqual(Array.from({ length: 20 }, (_, i) => sept(21 - i)));
    expect(up).toMatchObject({ nextBefore: null, nextAfter: '2026-09-21' });
    const top = await daysAt(b, `?after=${up.nextAfter}`);
    expect(dates(top)).toEqual(['2026-09-25', '2026-09-24', '2026-09-23', '2026-09-22']);
    expect(top).toMatchObject({ nextBefore: null, nextAfter: null });

    // Jumping to the 30th, a date with no diary: older ones below it, nothing above.
    const below = await daysAt(b, '?before=2026-10-01');
    const above = await daysAt(b, '?after=2026-09-30');
    expect(dates(below)[0]).toBe('2026-09-25');
    expect(above).toEqual({ days: [], nextBefore: null, nextAfter: null });
    expect(
      (await get(b, `${routes.days.path}?before=2026-09-10&after=2026-09-01`)).statusCode,
    ).toBe(400);
  });

  it('[adr:book-frontend-workspace#9] says a diary is being written until a history point holds its last text', async () => {
    const { a, b, saveRange } = await pair();
    const diaryId = await ownDiary(a);
    // An opened share alone has no author: nobody is writing.
    expect((await day(b)).partner).toMatchObject({ writing: false });

    await write(a, diaryId, (t) => t.insert(0, 'still typing'));
    expect((await day(a)).mine).toMatchObject({ writing: true });
    expect((await day(b)).partner).toMatchObject({ writing: true });
    await settle(diaryId);
    expect((await day(a)).mine).toMatchObject({ writing: false });
    expect((await day(b)).partner).toMatchObject({ writing: false });

    // The partner writing in A's diary counts for A too; a frozen share is never being written.
    const { epochId } = (await day(b)).partner!;
    await write(b, diaryId, (t) => t.insert(t.length, ' and B'), epochId);
    expect((await days(a)).days[0]!.mine).toMatchObject({ writing: true });
    await saveRange(NOTHING);
    await write(a, diaryId, (t) => t.insert(0, SECRET));
    expect((await day(b)).partner).toMatchObject({ share: 'frozen', writing: false });
  });
});

describe.runIf(testDatabaseUrl)('the nearest unread date', () => {
  it('[adr:book-frontend-workspace#5] finds list unread older or newer than a date, skipping what was read', async () => {
    const { a, b } = await pair();
    const written = new Map<string, number>();
    const ids = new Map<string, string>();
    for (const date of ['2026-08-01', '2026-08-10', '2026-08-20']) {
      const diaryId = await ownDiary(a, date);
      ids.set(date, diaryId);
      written.set(date, await write(a, diaryId, (t) => t.insert(0, 'hello')));
      await settle(diaryId);
    }
    await report(b, ids.get('2026-08-10')!, [
      { clientId: written.get('2026-08-10')!, from: 0, to: 5 },
    ]);

    expect(await nextUnread(b)).toBe('2026-08-20');
    expect(await nextUnread(b, '?before=2026-08-20')).toBe('2026-08-01');
    expect(await nextUnread(b, '?after=2026-08-01')).toBe('2026-08-20');
    expect(await nextUnread(b, '?before=2026-08-01')).toBeNull();
    expect(await nextUnread(b, '?after=2026-08-20')).toBeNull();
    // The writer has nothing unread in their own text.
    expect(await nextUnread(a)).toBeNull();

    // Reading changes the answer at once; text that is not yet in a point does not count.
    await report(b, ids.get('2026-08-20')!, [
      { clientId: written.get('2026-08-20')!, from: 0, to: 5 },
    ]);
    expect(await nextUnread(b)).toBe('2026-08-01');
    await write(a, ids.get('2026-08-20')!, (t) => t.insert(5, ' again'));
    expect(await nextUnread(b, '?after=2026-08-01')).toBeNull();
    await settle(ids.get('2026-08-20')!);
    expect(await nextUnread(b, '?after=2026-08-01')).toBe('2026-08-20');
    expect(
      (await get(b, `${routes.nextUnread.path}?before=2026-08-02&after=2026-08-01`)).statusCode,
    ).toBe(400);
  });

  it('[adr:book-frontend-workspace#5] [adr:book-frontend-workspace#7] finds the partner’s text in the own diary, never an unshared one', async () => {
    const { a, b } = await pair(NOTHING, ALL);
    // A shares nothing: A's text is no one's unread, and B's search never learns of it.
    await write(a, await ownDiary(a, '2026-07-05'), (t) => t.insert(0, SECRET));
    const bDiary = await ownDiary(b, '2026-07-01');
    const { epochId } = (await day(a, '2026-07-01')).partner!;
    await write(a, bDiary, (t) => t.insert(0, 'from A'), epochId);
    await settle(bDiary);

    expect(await nextUnread(b)).toBe('2026-07-01');
    expect(await nextUnread(b, '?after=2026-07-01')).toBeNull();
    expect(await nextUnread(a)).toBeNull();
  });
});
