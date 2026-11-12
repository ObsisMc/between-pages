import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes, type ResponseOf } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, edit, testSessions, textOf } from '../test/diary.ts';
import { connectSocket } from '../test/socket.ts';

// Shared pages (shared-pages ADR) through the real router, the real sync socket and real
// PostgreSQL.

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

type Person = { id: string; cookie: string };
type Page = ResponseOf<'createSharedPage'>['page'];

const path = (template: string, id: string) => template.replace(/:\w+/, id);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function pair() {
  const a = await sessions.signIn('A');
  const b = await sessions.signIn('B');
  const invited = await send(a, 'POST', routes.createInvitation.path, {
    requestId: randomUUID(),
    sharingSelection: null,
  });
  const { token } = routes.createInvitation.response.parse(invited.json());
  const accepted = await send(b, 'POST', routes.acceptInvitation.path, {
    token,
    sharingSelection: null,
  });
  const binding = routes.acceptInvitation.response.parse(accepted.json()).binding;
  return { a, b, binding };
}
const unbind = async (who: Person, binding: { space: { id: string }; periodId: string }) =>
  expect(
    (
      await send(who, 'POST', path(routes.unbind.path, binding.space.id), {
        expectedPeriodId: binding.periodId,
      })
    ).statusCode,
  ).toBe(200);
async function rebind(a: Person, b: Person) {
  const invited = await send(a, 'POST', routes.createInvitation.path, {
    requestId: randomUUID(),
    sharingSelection: null,
  });
  const { token } = routes.createInvitation.response.parse(invited.json());
  const accepted = await send(b, 'POST', routes.acceptInvitation.path, {
    token,
    sharingSelection: null,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
}

const create = async (who: Person, title = '旅行清单'): Promise<Page> => {
  const res = await send(who, 'POST', routes.createSharedPage.path, {
    requestId: randomUUID(),
    title,
  });
  expect(res.statusCode, res.body).toBe(200);
  return routes.createSharedPage.response.parse(res.json()).page;
};
const list = async (who: Person) => {
  const res = await get(who, routes.sharedPages.path);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return routes.sharedPages.response.parse(res.json());
};
const open = async (who: Person, id: string) => {
  const res = await get(who, path(routes.sharedPage.path, id));
  expect(res.statusCode, res.body).toBe(200);
  return routes.sharedPage.response.parse(res.json());
};
const rename = (who: Person, id: string, expectedRevision: number, title: string) =>
  send(who, 'PUT', path(routes.renameSharedPage.path, id), {
    requestId: randomUUID(),
    expectedRevision,
    title,
  });
const remove = (who: Person, id: string, requestId: string = randomUUID()) =>
  send(who, 'POST', path(routes.deleteSharedPage.path, id), { requestId });
const unreadOf = async (who: Person) =>
  routes.spaceUnread.response.parse((await get(who, routes.spaceUnread.path)).json()).features
    .sharedPages;
const seen = (who: Person, id: string, mark: number) =>
  send(who, 'POST', routes.reportSeen.path, { records: [{ type: 'shared_page', id, mark }] });
const wroteRows = async (pageId: string) => {
  const [row] = await query<{ n: number }>(
    `select count(*)::int n from space_actions
     where record_type = 'shared_page' and record_id = $1 and kind = 'wrote'`,
    [pageId],
  );
  return row!.n;
};

/** One writer of a page on the real socket, with their own Yjs client. */
async function writer(who: Person, pageId: string, seedClient: number) {
  const view = await open(who, pageId);
  const socket = await connectSocket(app, who.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId: pageId,
    generationId: view.generationId,
    knownSeq: view.seq,
  });
  const first = await socket.next();
  const doc = client(seedClient, Buffer.from(view.state, 'base64'));
  /** The answer to a submit: its own commit event comes back too, and others' may arrive. */
  const answer = async () => {
    for (;;) {
      const message = await socket.next();
      if (message.type !== 'commit') return message;
    }
  };
  return {
    socket,
    first,
    doc,
    submit(change: Parameters<typeof edit>[1], batchId: string = randomUUID()) {
      const update = edit(doc, change);
      socket.send({
        v: 1,
        type: 'submit',
        diaryId: pageId,
        batchId,
        generationId: view.generationId,
        operations: [
          {
            operationId: randomUUID(),
            update: base64(update),
            writtenAt: '2026-11-04T09:00:00+08:00',
          },
        ],
      });
      return answer();
    },
  };
}

describe.runIf(testDatabaseUrl)('shared pages', () => {
  it("[adr:shared-pages#1] both write the same page, and neither can delete the other's characters", async () => {
    const { a, b } = await pair();
    const page = await create(a);
    const mine = await writer(a, page.id, 301);
    expect(mine.first.type).toBe('synced');
    expect((await mine.submit((t) => t.insert(0, '机票'))).type).toBe('ack');

    const theirs = await writer(b, page.id, 302);
    expect(theirs.first).toMatchObject({ type: 'synced', seq: 1 });
    expect((await theirs.submit((t) => t.insert(2, '酒店'))).type).toBe('ack');
    await expect.poll(async () => (await open(a, page.id)).seq).toBe(2);
    const arrived = [await mine.socket.next(), await mine.socket.next()];
    expect(arrived).toContainEqual(expect.objectContaining({ type: 'commit', seq: 2 }));

    const foreign = await theirs.submit((t) => t.delete(0, 1));
    expect(foreign).toMatchObject({
      type: 'error',
      code: 'EDIT_REJECTED',
      reason: 'FOREIGN_DELETE',
    });
    expect(textOf(Buffer.from((await open(a, page.id)).state, 'base64'))).toBe('机票酒店');
    mine.socket.close();
    theirs.socket.close();
  });

  it('[adr:shared-pages#2] unbinding keeps a page, and the two get it back writable on rebinding', async () => {
    const { a, b, binding } = await pair();
    const page = await create(a);
    await unbind(b, binding);
    expect((await list(a)).readOnly).toBe(true);
    expect((await open(b, page.id)).readOnly).toBe(true);
    await rebind(a, b);
    expect((await list(b)).pages.map((p) => p.id)).toEqual([page.id]);
    const again = await writer(b, page.id, 303);
    expect((await again.submit((t) => t.insert(0, '回来了'))).type).toBe('ack');
    again.socket.close();
  });

  it('[adr:shared-pages#3] nothing is written after unbinding; a commit waits for it and is refused', async () => {
    const { a, b, binding } = await pair();
    const page = await create(a);
    const live = await writer(a, page.id, 304);

    const unbinding = new pg.Client({ connectionString: testDatabaseUrl });
    await unbinding.connect();
    await unbinding.query('begin');
    await unbinding.query(
      'update binding_periods set ended_at = now(), ended_by = $1 where id = $2',
      [a.id, binding.periodId],
    );
    const refused = live.submit((t) => t.insert(0, '晚了'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await unbinding.query('commit');
    await unbinding.end();
    expect(await refused).toMatchObject({ type: 'error', code: 'SPACE_READ_ONLY' });
    expect((await open(a, page.id)).seq).toBe(0);

    for (const res of [
      await send(a, 'POST', routes.createSharedPage.path, { requestId: randomUUID(), title: '' }),
      await rename(b, page.id, page.revision, '新名字'),
      await remove(b, page.id),
    ])
      expect(codeOf(res)).toBe('SPACE_READ_ONLY');
    live.socket.close();
  });

  it('[adr:shared-pages#4] either renames or deletes, the server names who, and a stale rename is refused', async () => {
    const { a, b } = await pair();
    const page = await create(a);
    const renamed = await rename(b, page.id, page.revision, '  新名字  ');
    expect(renamed.statusCode, renamed.body).toBe(200);
    const after = routes.renameSharedPage.response.parse(renamed.json()).page;
    expect(after).toMatchObject({ title: '新名字', authorId: a.id, revision: 2 });
    expect(after.renamed?.by).toBe(b.id);

    expect(codeOf(await rename(a, page.id, page.revision, '旧版本'))).toBe('RECORD_STALE');
    expect((await rename(a, page.id, 2, 'x'.repeat(61))).statusCode).toBe(400);
    const smuggled = await send(a, 'PUT', path(routes.renameSharedPage.path, page.id), {
      requestId: randomUUID(),
      expectedRevision: 2,
      title: '冒名',
      actorId: b.id,
    });
    expect(smuggled.statusCode).toBe(400);

    const requestId = randomUUID();
    expect((await remove(b, page.id, requestId)).statusCode).toBe(200);
    expect((await remove(b, page.id, requestId)).statusCode).toBe(200);
    const [row] = await query<{ deleted_by: string }>(
      'select deleted_by from shared_pages where id = $1',
      [page.id],
    );
    expect(row!.deleted_by).toBe(b.id);
    const history = await query<{ kind: string; actor_id: string }>(
      `select kind, actor_id from space_actions where record_id = $1
       union all select kind, actor_id from space_changes where record_id = $1`,
      [page.id],
    );
    expect(history).toEqual(
      expect.arrayContaining([
        { kind: 'renamed', actor_id: b.id },
        { kind: 'delete', actor_id: b.id },
      ]),
    );
  });

  it('[adr:shared-pages#5] a third person finds nothing, and a deleted page is gone but for receipts', async () => {
    const { a, b } = await pair();
    const third = await sessions.signIn('C');
    const stranger = await pair();
    const page = await create(a);
    const live = await writer(a, page.id, 305);
    const batchId = randomUUID();
    expect((await live.submit((t) => t.insert(0, '字'), batchId)).type).toBe('ack');
    const view = await open(a, page.id);

    for (const who of [third, stranger.a]) {
      expect((await get(who, path(routes.sharedPage.path, page.id))).statusCode).toBe(404);
      expect((await rename(who, page.id, 1, '偷改')).statusCode).toBe(404);
      expect((await remove(who, page.id)).statusCode).toBe(404);
      const receipt = await get(who, `/api/diaries/${page.id}/receipt?batchId=${batchId}`);
      expect(receipt.statusCode).toBe(404);
      const socket = await connectSocket(app, who.cookie, ORIGIN);
      socket.send({
        v: 1,
        type: 'subscribe',
        diaryId: page.id,
        generationId: view.generationId,
        knownSeq: 0,
      });
      expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
      socket.send({
        v: 1,
        type: 'submit',
        diaryId: page.id,
        batchId: randomUUID(),
        generationId: view.generationId,
        operations: [
          {
            operationId: randomUUID(),
            update: base64(edit(client(306), (t) => t.insert(0, '闯入'))),
            writtenAt: '2026-11-04T09:00:00+08:00',
          },
        ],
      });
      expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
      socket.close();
    }

    expect((await remove(b, page.id)).statusCode).toBe(200);
    for (const who of [a, b]) {
      expect((await get(who, path(routes.sharedPage.path, page.id))).statusCode).toBe(404);
      expect((await list(who)).pages).toEqual([]);
    }
    expect(await live.submit((t) => t.insert(0, '再写'))).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    const receipt = await get(a, `/api/diaries/${page.id}/receipt?batchId=${batchId}`);
    expect(routes.receipt.response.parse(receipt.json()).receipt?.batchId).toBe(batchId);
    live.socket.close();
  });

  it('[adr:shared-pages#6] deleting tells the partner only if they wrote or renamed, and keeps the data', async () => {
    const { a, b } = await pair();
    const untouched = await create(a, '没动过');
    const written = await create(a, '写过');
    const renamed = await create(a, '改过');
    const live = await writer(b, written.id, 307);
    expect((await live.submit((t) => t.insert(0, '我的字'))).type).toBe('ack');
    live.socket.close();
    expect((await rename(b, renamed.id, 1, '改过的名字')).statusCode).toBe(200);

    for (const id of [untouched.id, written.id, renamed.id])
      expect((await remove(a, id)).statusCode).toBe(200);

    const notes = (await list(b)).notes;
    expect(notes.map((n) => [n.title, n.wrote, n.unread])).toEqual(
      expect.arrayContaining([
        ['改过的名字', false, true],
        ['写过', true, true],
      ]),
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]!.deleted.by).toBe(a.id);
    expect(await unreadOf(b)).toBe(2);
    expect((await list(a)).notes).toEqual([]);
    const [kept] = await query<{ n: number }>(
      'select count(*)::int n from diary_commits where diary_id = $1',
      [written.id],
    );
    expect(kept!.n).toBe(1);
  });

  it('[adr:shared-pages#7] a page stays out of diaries, their unread and the backup outbox', async () => {
    const { a, b } = await pair();
    const before = routes.days.response.parse((await get(b, routes.days.path)).json());
    const page = await create(a);
    const live = await writer(a, page.id, 308);
    expect((await live.submit((t) => t.insert(0, '不是日记'))).type).toBe('ack');
    live.socket.close();

    expect((await get(a, `/api/diaries/${page.id}`)).statusCode).toBe(404);
    expect((await get(a, `/api/diaries/${page.id}/history`)).statusCode).toBe(404);
    expect((await get(a, `/api/diaries/${page.id}/read`)).statusCode).toBe(404);
    for (const who of [a, b]) {
      const days = routes.days.response.parse((await get(who, routes.days.path)).json());
      expect(days.days).toEqual(before.days);
      const diaries = routes.diaries.response.parse((await get(who, routes.diaries.path)).json());
      expect(diaries.diaries).toEqual([]);
    }
    const [row] = await query<{ n: number }>(
      'select count(*)::int n from backup_outbox where diary_id = $1',
      [page.id],
    );
    expect(row!.n).toBe(0);
  });

  it('[adr:shared-pages#8] wrote adds one row a round, however much is written before it is seen', async () => {
    const { a, b } = await pair();
    const page = await create(a);
    const live = await writer(a, page.id, 309);
    for (const text of ['一', '二', '三'])
      expect((await live.submit((t) => t.insert(0, text))).type).toBe('ack');
    expect(await wroteRows(page.id)).toBe(1);

    const { page: seenPage } = await open(b, page.id);
    expect((await seen(b, page.id, seenPage.mark)).statusCode).toBe(200);
    expect(await wroteRows(page.id)).toBe(1);
    expect((await live.submit((t) => t.insert(0, '四'))).type).toBe('ack');
    expect((await live.submit((t) => t.insert(0, '五'))).type).toBe('ack');
    expect(await wroteRows(page.id)).toBe(2);
    live.socket.close();
  });

  it("[adr:shared-pages#9] the partner's new text is unread until opened, one's own never is, and the writer learns nothing", async () => {
    const { a, b } = await pair();
    const page = await create(a);
    expect(await unreadOf(a)).toBe(0);
    expect(await unreadOf(b)).toBe(1);
    expect((await list(b)).pages[0]!.unread).toBe('new');

    const first = await open(b, page.id);
    expect((await seen(b, page.id, first.page.mark)).statusCode).toBe(200);
    expect(await unreadOf(b)).toBe(0);

    const live = await writer(a, page.id, 310);
    expect((await live.submit((t) => t.insert(0, '新内容'))).type).toBe('ack');
    live.socket.close();
    expect(await unreadOf(a)).toBe(0);
    expect(await unreadOf(b)).toBe(1);

    const before = await list(a);
    const second = await open(b, page.id);
    expect((await seen(b, page.id, second.page.mark)).statusCode).toBe(200);
    expect(await unreadOf(b)).toBe(0);
    expect(await list(a)).toEqual(before);
  });

  it('[adr:shared-pages#11] a commit takes the open period before the document, as an unbinding does', async () => {
    const { a, binding } = await pair();
    const page = await create(a);
    const live = await writer(a, page.id, 311);
    const unbinding = new pg.Client({ connectionString: testDatabaseUrl });
    await unbinding.connect();
    await unbinding.query('begin');
    await unbinding.query('select 1 from binding_periods where id = $1 for update', [
      binding.periodId,
    ]);
    const answered = live.submit((t) => t.insert(0, '等锁'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Waiting on the period, the commit holds no document lock yet.
    const free = await query<{ id: string }>(
      'select id from documents where id = $1 for update nowait',
      [page.id],
    );
    expect(free).toHaveLength(1);
    await unbinding.query('commit');
    await unbinding.end();
    expect((await answered).type).toBe('ack');
    live.socket.close();
  });

  it('lists the newest first and replays a creation by its request ID', async () => {
    const { a, b } = await pair();
    const older = await create(a, '旧的');
    const newer = await create(b, '');
    expect((await list(a)).pages.map((p) => p.id)).toEqual([newer.id, older.id]);
    expect((await rename(a, older.id, 1, '改名后最新')).statusCode).toBe(200);
    expect((await list(a)).pages.map((p) => p.id)).toEqual([older.id, newer.id]);

    const requestId = randomUUID();
    const one = await send(a, 'POST', routes.createSharedPage.path, { requestId, title: '一次' });
    const two = await send(a, 'POST', routes.createSharedPage.path, { requestId, title: '一次' });
    expect(two.json()).toMatchObject({ page: { id: one.json().page.id } });
    const other = await send(a, 'POST', routes.createSharedPage.path, { requestId, title: '两次' });
    expect(codeOf(other)).toBe('VALIDATION_FAILED');
  });

  it('gives an account never bound nothing', async () => {
    const alone = await sessions.signIn('alone');
    expect((await get(alone, routes.sharedPages.path)).statusCode).toBe(404);
    expect(
      (
        await send(alone, 'POST', routes.createSharedPage.path, {
          requestId: randomUUID(),
          title: '',
        })
      ).statusCode,
    ).toBe(404);
  });
});
