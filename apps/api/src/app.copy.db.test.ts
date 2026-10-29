import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routes, type DateSelection } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import type { DriveConfig } from './backup/backup.ts';
import { createCopyService } from './backup/copy.ts';
import { createDb, type Database } from './db/client.ts';
import { createReader } from './reader/reader.ts';
import { createCopyStore } from './store/copy.ts';
import { createStore } from './store/store.ts';
import { copyNext } from './worker/copy.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, edit, testSessions } from '../test/diary.ts';
import { startFakeGoogle, type FakeGoogle } from '../test/google.ts';
import { connectSocket } from '../test/socket.ts';

// The readable copy end to end (server-backup-and-google-docs D5–D9): commits through the
// real socket into PostgreSQL, the worker's intake and day writes, and a local stand-in for
// Drive and Docs. History points close once commits are older than the idle time, so tests
// move commits and due times into the past instead of waiting.

const ORIGIN = 'http://localhost:5173';
const DATE = '2026-10-20';
const SECRET = 'PRIVATE-WORDS';
const ALL: DateSelection = { include: [{ from: null, to: null }], exclude: [] };
const NOTHING: DateSelection = { include: [], exclude: [] };
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
let google: FakeGoogle;
let drive: DriveConfig;
let drain: (...people: Person[]) => Promise<void>;

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  google = await startFakeGoogle();
  drive = {
    client: {
      clientId: 'client-id',
      clientSecret: 'client-SECRET',
      redirectUri: `${ORIGIN}/backup/google/callback`,
      endpoints: google.endpoints,
    },
    tokenKey: randomBytes(32),
    testing: false,
  };
  database = createDb(testDatabaseUrl);
  app = await buildApp({
    publicOrigin: ORIGIN,
    currentUser: sessions.currentUser,
    db: database.db,
    drive,
  });
  const store = createCopyStore(database.db);
  const copy = createCopyService(store, createReader(createStore(database.db)));
  // The worker's loop for these people only: other test files share the database.
  drain = async (...people) => {
    await copy.intake(people.map((p) => p.id));
    while (await copyNext({ copy, store, drive }));
  };
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  await google?.close();
});
beforeEach(() => {
  if (!google) return;
  google.state.down = false;
  google.state.storageFull = false;
});

type Person = { id: string; cookie: string; permissionId: string };
const path = (template: string, params: Record<string, string>) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, v), template);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object = {}) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

async function person(name: string): Promise<Person> {
  return { ...(await sessions.signIn(name)), permissionId: `perm-${randomUUID()}` };
}

async function connect(who: Person) {
  const started = await send(who, 'POST', routes.startGoogleConnection.path);
  const { url } = routes.startGoogleConnection.response.parse(started.json());
  const finished = await send(
    who,
    'POST',
    routes.finishGoogleConnection.path,
    google.consent(url, who.permissionId),
  );
  expect(finished.statusCode).toBe(200);
}

/** A and B bound; A shares everything, B nothing. Returns A's range setter. */
async function pair(a: Person, b: Person) {
  const invited = routes.createInvitation.response.parse(
    (
      await send(a, 'POST', routes.createInvitation.path, {
        requestId: randomUUID(),
        sharingSelection: ALL,
      })
    ).json(),
  );
  const accepted = routes.acceptInvitation.response.parse(
    (
      await send(b, 'POST', routes.acceptInvitation.path, {
        token: invited.token,
        sharingSelection: NOTHING,
      })
    ).json(),
  );
  const { space, periodId } = accepted.binding;
  return async (selection: DateSelection) => {
    const res = await send(a, 'PUT', path(routes.saveMySharing.path, { spaceId: space.id }), {
      requestId: randomUUID(),
      expectedPeriodId: periodId,
      expectedRevision: 1,
      selection,
    });
    expect(res.statusCode).toBe(200);
  };
}

async function ownDiary(owner: Person, date = DATE) {
  const res = await send(owner, 'POST', routes.openDiary.path, { timezone: 'Asia/Shanghai', date });
  return routes.openDiary.response.parse(res.json()).diary.diaryId;
}

let nextClient = 9000;
/** Writes one change to the own diary from a new editor instance and waits for its ACK. */
async function write(who: Person, diaryId: string, change: (text: Y.Text) => void) {
  const state = routes.diary.response.parse(
    (await get(who, path(routes.diary.path, { diaryId }))).json(),
  ).diary;
  const socket = await connectSocket(app, who.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId,
    generationId: state.generationId,
    knownSeq: state.seq,
  });
  expect(await socket.next()).toMatchObject({ type: 'synced' });
  const batchId = randomUUID();
  socket.send({
    v: 1,
    type: 'submit',
    diaryId,
    batchId,
    generationId: state.generationId,
    operations: [
      {
        operationId: randomUUID(),
        update: base64(edit(client(nextClient++, bytesOf(state.state)), change)),
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
}

/** An hour passes: the diary's commits form history points and every waiting day is due. */
async function settle(diaryId: string) {
  await query(
    `update diary_commits set committed_at = committed_at - interval '1 hour' where diary_id = $1`,
    [diaryId],
  );
  await query(`update google_day_work set ready_at = now() - interval '1 second'`);
}

const backup = async (who: Person) =>
  routes.backup.response.parse((await get(who, routes.backup.path)).json()).backup;
const dayCopy = async (who: Person, date = DATE) =>
  routes.day.response.parse((await get(who, path(routes.day.path, { date }))).json()).google;
const writes = () => google.state.calls.filter((c) => c.endsWith(':batchUpdate')).length;

describe.runIf(testDatabaseUrl)('the Google copy', () => {
  it('[adr:server-backup-and-google-docs#7] [adr:server-backup-and-google-docs#15] writes the day once its history point forms, laid out as the day page', async () => {
    const a = await person('Ann');
    await connect(a);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'First words.'));

    // Saved, but no history point yet: nothing in Drive, the day is waiting.
    await drain(a);
    expect(google.docs(a.permissionId)).toEqual([]);
    expect((await backup(a)).progress).toMatchObject({ waitingDays: 1, backedUpTo: null });
    expect(await dayCopy(a)).toEqual({ connected: true, docUrl: null, mine: null, partner: null });

    await settle(diaryId);
    await drain(a);
    const [doc] = google.docs(a.permissionId);
    expect(doc).toMatchObject({
      name: '2026-10-20 周二',
      text: '2026 年 10 月 20 日 星期二\nAnn 的日记\nFirst words.',
      headings: [
        { text: '2026 年 10 月 20 日 星期二', level: 1 },
        { text: 'Ann 的日记', level: 2 },
      ],
    });
    const month = google.state.files.get(doc!.parents[0]!)!;
    const year = google.state.files.get(month.parents[0]!)!;
    expect([
      year.parents.length,
      google.state.files.get(year.parents[0]!)!.name,
      year.name,
      month.name,
    ]).toEqual([1, 'Between Pages', '2026', '10']);

    const status = await backup(a);
    expect(status.progress).toMatchObject({ waitingDays: 0, retrying: false });
    expect(status.progress!.backedUpTo).not.toBeNull();
    expect(status.progress!.folderUrl).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
    expect(await dayCopy(a)).toMatchObject({
      connected: true,
      docUrl: `https://docs.google.com/document/d/${doc!.id}/edit`,
      mine: status.progress!.backedUpTo,
      partner: null,
    });
  });

  it('[adr:server-backup-and-google-docs#6] writes a day again only when its content changed, into the same Doc', async () => {
    const a = await person('Ann');
    await connect(a);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Same.'));
    await settle(diaryId);
    await drain(a);
    const before = writes();

    // Written and then undone: the rendered day is unchanged, so Google gets no write.
    await write(a, diaryId, (t) => t.insert(t.length, '!'));
    await write(a, diaryId, (t) => t.delete(t.length - 1, 1));
    await settle(diaryId);
    await drain(a);
    await send(a, 'POST', routes.runBackup.path);
    await drain(a);
    expect(writes()).toBe(before);

    await write(a, diaryId, (t) => t.insert(t.length, ' More.'));
    await settle(diaryId);
    await drain(a);
    expect(writes()).toBe(before + 1);
    expect(google.docs(a.permissionId).map((d) => d.text.split('\n').at(-1))).toEqual([
      'Same. More.',
    ]);
  });

  it('[adr:server-backup-and-google-docs#5] puts only what the partner may read into their Drive, and a stopped share as stopped', async () => {
    const a = await person('Ann');
    const b = await person('Bo');
    const saveRange = await pair(a, b);
    await connect(b);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Shared words.'));
    await settle(diaryId);
    await drain(a, b);
    expect(google.docs(b.permissionId).map((d) => d.text)).toEqual(
      ['2026 年 10 月 20 日 星期二\n■ Ann   ■ Bo\nAnn 的日记\nShared words.'].map((t) =>
        a.id < b.id ? t : t.replace('■ Ann   ■ Bo', '■ Bo   ■ Ann'),
      ),
    );
    expect(await dayCopy(b)).toMatchObject({ mine: null, partner: expect.any(String) });

    // A stops sharing, then writes privately: B's Doc says stopped and never gets the words.
    await saveRange(NOTHING);
    await write(a, diaryId, (t) => t.insert(t.length, SECRET));
    await settle(diaryId);
    await drain(a, b);
    const [doc] = google.docs(b.permissionId);
    expect(doc!.text.endsWith('Ann 的日记\nShared words.\n（已停止共享）')).toBe(true);
    expect(
      JSON.stringify([...google.state.files.values()].filter((f) => f.owner === b.permissionId)),
    ).not.toContain(SECRET);

    // A diary never shared leaves nothing in B's Drive.
    const other = await ownDiary(a, '2026-10-21');
    await write(a, other, (t) => t.insert(0, SECRET));
    await settle(other);
    await drain(a, b);
    expect(google.docs(b.permissionId)).toHaveLength(1);
  });

  it('[adr:server-backup-and-google-docs#14] shows each person only their own Drive', async () => {
    const a = await person('Ann');
    const b = await person('Bo');
    await pair(a, b);
    await connect(a);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Words.'));
    await settle(diaryId);
    await drain(a, b);
    expect((await dayCopy(a)).docUrl).not.toBeNull();
    expect(await dayCopy(b)).toEqual({ connected: false, docUrl: null, mine: null, partner: null });
    expect((await backup(b)).progress).toBeNull();
  });

  it('[adr:server-backup-and-google-docs#10] commits while Google is down, retries, and writes once it is back', async () => {
    const a = await person('Ann');
    await connect(a);
    const diaryId = await ownDiary(a);
    google.state.down = true;
    await write(a, diaryId, (t) => t.insert(0, 'Offline Google.'));
    await settle(diaryId);
    await drain(a);
    expect(google.docs(a.permissionId)).toEqual([]);
    const status = await backup(a);
    expect(status.progress).toMatchObject({ waitingDays: 1, retrying: true });
    expect(status.attention).toBeNull();

    google.state.down = false;
    await settle(diaryId);
    await drain(a);
    expect(google.docs(a.permissionId)).toHaveLength(1);
    expect((await backup(a)).progress).toMatchObject({ waitingDays: 0, retrying: false });
  });

  it('writes at once on "现在备份", without waiting for the history point', async () => {
    const a = await person('Ann');
    await connect(a);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Right now.'));
    const run = await send(a, 'POST', routes.runBackup.path);
    expect(run.statusCode).toBe(200);
    await drain(a);
    expect(google.docs(a.permissionId).map((d) => d.text.endsWith('Right now.'))).toEqual([true]);
  });

  it('[adr:server-backup-and-google-docs#12] backs up every visible day on connecting, and keeps them waiting while a reconnect is needed', async () => {
    const a = await person('Ann');
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Before connecting.'));
    await settle(diaryId);
    await connect(a);
    await drain(a);
    expect(google.docs(a.permissionId)).toHaveLength(1);

    // The grant is revoked in Google: the page and the home banner ask to reconnect.
    google.state.refreshTokens.clear();
    await write(a, diaryId, (t) => t.insert(t.length, ' After.'));
    await settle(diaryId);
    await drain(a);
    const status = await backup(a);
    expect(status.google.state).toBe('reconnect');
    expect(status.attention).toBe('reconnect');
    expect(status.progress!.waitingDays).toBe(1);
    expect(status.events.map((e) => e.kind)).toContain('reconnect_needed');

    await connect(a);
    await drain(a);
    expect(
      google.docs(a.permissionId).map((d) => d.text.endsWith('Before connecting. After.')),
    ).toEqual([true]);
  });

  it('pauses on a full Drive and asks the user to make room', async () => {
    const a = await person('Ann');
    await connect(a);
    google.state.storageFull = true;
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'No room.'));
    await settle(diaryId);
    await drain(a);
    await drain(a);
    const status = await backup(a);
    expect(status.attention).toBe('storage_full');
    expect(status.events.filter((e) => e.kind === 'storage_full')).toHaveLength(1);

    google.state.storageFull = false;
    await send(a, 'POST', routes.runBackup.path);
    await drain(a);
    expect(google.docs(a.permissionId)).toHaveLength(1);
    expect((await backup(a)).attention).toBeNull();
  });

  it('[adr:server-backup-and-google-docs#8] never writes over a Doc someone changed in Google', async () => {
    const a = await person('Ann');
    await connect(a);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Original.'));
    await settle(diaryId);
    await drain(a);
    const [doc] = google.docs(a.permissionId);
    google.editInGoogle(doc!.id, ' Edited in Google.');

    await write(a, diaryId, (t) => t.insert(t.length, ' Newer.'));
    await settle(diaryId);
    await drain(a);
    expect(google.state.files.get(doc!.id)!.text.endsWith('Original. Edited in Google.')).toBe(
      true,
    );
  });
});
