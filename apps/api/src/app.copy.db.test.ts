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
import { checkDrives } from './worker/check.ts';
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
let dailyCheck: () => Promise<void>;

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
  dailyCheck = () => checkDrives({ store, drive });
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
    expect(await dayCopy(a)).toEqual({
      connected: true,
      docUrl: null,
      mine: null,
      partner: null,
      problem: null,
    });

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
    expect(status.progress).toMatchObject({ waitingDays: 0, failing: [] });
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
    expect(await dayCopy(b)).toEqual({
      connected: false,
      docUrl: null,
      mine: null,
      partner: null,
      problem: null,
    });
    expect((await backup(b)).progress).toBeNull();
  });

  it('[adr:server-backup-and-google-docs#10] commits while Google is down, says so on every page, and writes once it is back', async () => {
    const a = await person('Ann');
    await connect(a);
    const diaryId = await ownDiary(a);
    google.state.down = true;
    await write(a, diaryId, (t) => t.insert(0, 'Offline Google.'));
    await settle(diaryId);
    await drain(a);
    await settle(diaryId);
    await drain(a);
    expect(google.docs(a.permissionId)).toEqual([]);
    let status = await backup(a);
    expect(status.progress).toMatchObject({
      waitingDays: 1,
      failing: [{ diaryDate: DATE, failure: 'unreachable' }],
    });
    expect(status.events.filter((e) => e.kind === 'copy_failing')).toEqual([
      expect.objectContaining({ diaryDate: DATE }),
    ]);
    expect(status.attention).toBeNull();
    expect((await dayCopy(a)).problem).toBe('unreachable');

    // A day of failing puts a banner on the home page.
    await query(
      `update backup_events set at = at - interval '25 hours' where user_id = $1 and kind = 'copy_failing'`,
      [a.id],
    );
    expect((await backup(a)).attention).toBe('failing');

    google.state.down = false;
    await settle(diaryId);
    await drain(a);
    expect(google.docs(a.permissionId)).toHaveLength(1);
    status = await backup(a);
    expect(status.progress).toMatchObject({ waitingDays: 0, failing: [] });
    expect(status.attention).toBeNull();
    expect((await dayCopy(a)).problem).toBeNull();
  });

  it('tells a lost connection apart from a refusal, and shows both', async () => {
    const a = await person('Ann');
    await connect(a);
    const lost = await ownDiary(a, '2026-10-18');
    google.state.drop = true;
    await write(a, lost, (t) => t.insert(0, 'Network gone.'));
    await settle(lost);
    await drain(a);
    google.state.drop = false;
    google.state.refuseCreate = true;
    const refused = await ownDiary(a, '2026-10-17');
    await write(a, refused, (t) => t.insert(0, 'Refused.'));
    await settle(refused);
    // Only the refused day is due now; the other keeps its lost-connection result.
    await query(
      `update google_day_work set ready_at = now() + interval '1 hour' where user_id = $1 and diary_date = '2026-10-18'`,
      [a.id],
    );
    await drain(a);
    google.state.refuseCreate = false;
    expect((await backup(a)).progress!.failing).toEqual([
      { diaryDate: '2026-10-18', failure: 'unreachable' },
      { diaryDate: '2026-10-17', failure: 'failed' },
    ]);
    expect((await dayCopy(a, '2026-10-17')).problem).toBe('failed');
    expect((await dayCopy(a, '2026-10-18')).problem).toBe('unreachable');
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
    expect((await dayCopy(a)).problem).toBe('reconnect');

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
    expect((await dayCopy(a)).problem).toBe('storage_full');

    google.state.storageFull = false;
    await send(a, 'POST', routes.runBackup.path);
    await drain(a);
    expect(google.docs(a.permissionId)).toHaveLength(1);
    expect((await backup(a)).attention).toBeNull();
  });
});

describe.runIf(testDatabaseUrl)('Docs changed or deleted in Google', () => {
  /** A with one written day; returns the Doc as it stands in Drive. */
  async function writtenDay(a: Person) {
    await connect(a);
    const diaryId = await ownDiary(a);
    await write(a, diaryId, (t) => t.insert(0, 'Original.'));
    await settle(diaryId);
    await drain(a);
    return { diaryId, doc: google.docs(a.permissionId)[0]! };
  }
  const events = async (who: Person) => (await backup(who)).events.map((e) => e.kind);
  const neverDeleted = () =>
    expect(google.state.calls.filter((c) => c.startsWith('DELETE '))).toEqual([]);

  it('[adr:server-backup-and-google-docs#8] keeps a Doc changed in Google under a new name and carries on in a new one', async () => {
    const a = await person('Ann');
    const { diaryId, doc } = await writtenDay(a);
    google.editInGoogle(doc.id, ' Edited in Google.');

    await write(a, diaryId, (t) => t.insert(t.length, ' Newer.'));
    await settle(diaryId);
    await drain(a);
    const old = google.state.files.get(doc.id)!;
    expect(old.text.endsWith('Original. Edited in Google.')).toBe(true);
    expect(old.name).toBe('2026-10-20 周二（在 Google 改过，已停止更新）');
    const fresh = google.docs(a.permissionId).find((d) => d.id !== doc.id)!;
    expect(fresh).toMatchObject({ name: '2026-10-20 周二', parents: old.parents });
    expect(fresh.text.endsWith('Original. Newer.')).toBe(true);
    expect(await events(a)).toContain('doc_replaced');
    expect((await dayCopy(a)).docUrl).toBe(`https://docs.google.com/document/d/${fresh.id}/edit`);

    // The new Doc is the one written from now on; the renamed one is left alone.
    await write(a, diaryId, (t) => t.insert(t.length, ' Again.'));
    await settle(diaryId);
    await drain(a);
    expect(google.docs(a.permissionId)).toHaveLength(2);
    expect(google.state.files.get(fresh.id)!.text.endsWith('Newer. Again.')).toBe(true);
    neverDeleted();
  });

  it('[adr:server-backup-and-google-docs#8] treats a change between its check and its write the same way', async () => {
    const a = await person('Ann');
    const { diaryId, doc } = await writtenDay(a);
    google.state.beforeBatch = (file) => google.editInGoogle(file.id, ' Just now.');

    await write(a, diaryId, (t) => t.insert(t.length, ' Newer.'));
    await settle(diaryId);
    await drain(a);
    expect(google.state.files.get(doc.id)!.text.endsWith('Original. Just now.')).toBe(true);
    expect(
      google
        .docs(a.permissionId)
        .map((d) => d.text.split('\n').at(-1))
        .sort(),
    ).toEqual(['Original. Just now.', 'Original. Newer.']);
  });

  it('[adr:server-backup-and-google-docs#9] makes a deleted Doc again on the next write, once', async () => {
    const a = await person('Ann');
    const { diaryId, doc } = await writtenDay(a);
    google.trash(doc.id);

    await write(a, diaryId, (t) => t.insert(t.length, ' Newer.'));
    await settle(diaryId);
    await drain(a);
    await drain(a);
    const live = google.docs(a.permissionId).filter((d) => !d.trashed);
    expect(live.map((d) => d.text.endsWith('Original. Newer.'))).toEqual([true]);
    expect(google.state.files.get(doc.id)!.trashed).toBe(true);
    expect((await events(a)).filter((k) => k === 'doc_recreated')).toHaveLength(1);
    neverDeleted();
  });

  it('[adr:server-backup-and-google-docs#9] makes a deleted month folder again with its Doc', async () => {
    const a = await person('Ann');
    const { diaryId, doc } = await writtenDay(a);
    const month = google.state.files.get(doc.parents[0]!)!;
    google.trash(month.id);
    google.trash(doc.id);

    await write(a, diaryId, (t) => t.insert(t.length, ' Newer.'));
    await settle(diaryId);
    await drain(a);
    const fresh = google.docs(a.permissionId).find((d) => !d.trashed)!;
    const newMonth = google.state.files.get(fresh.parents[0]!)!;
    expect(newMonth).toMatchObject({ name: '10', trashed: false, parents: month.parents });
    expect(newMonth.id).not.toBe(month.id);
  });

  it('records a daily check that could not read the Drive on the backup page', async () => {
    const a = await person('Ann');
    await writtenDay(a);
    google.state.failList = true;
    await dailyCheck();
    google.state.failList = false;
    expect(await events(a)).toContain('check_failed');
  });

  it('[adr:server-backup-and-google-docs#9] finds deleted and changed Docs in the daily check, without a new commit', async () => {
    const a = await person('Ann');
    const { doc } = await writtenDay(a);
    const other = await ownDiary(a, '2026-10-19');
    await write(a, other, (t) => t.insert(0, 'Earlier day.'));
    await settle(other);
    await drain(a);
    const earlier = google.docs(a.permissionId).find((d) => d.name.startsWith('2026-10-19'))!;
    const untouched = google.state.calls.length;

    // Nothing changed: the check lists files and reads no Doc.
    await dailyCheck();
    expect(google.state.calls.slice(untouched).filter((c) => c.includes('/documents/'))).toEqual(
      [],
    );

    google.remove(doc.id);
    google.editInGoogle(earlier.id, ' Edited.');
    await dailyCheck();
    await drain(a);
    const names = google
      .docs(a.permissionId)
      .map((d) => d.name)
      .sort();
    expect(names).toEqual([
      '2026-10-19 周一',
      '2026-10-19 周一（在 Google 改过，已停止更新）',
      '2026-10-20 周二',
    ]);
    expect(google.state.files.get(earlier.id)!.text.endsWith('Earlier day. Edited.')).toBe(true);
    expect(await events(a)).toEqual(expect.arrayContaining(['doc_recreated', 'doc_replaced']));
    neverDeleted();
  });
});
