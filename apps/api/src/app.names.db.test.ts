import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import type { CurrentUser } from './auth/guards.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, edit, testSessions } from '../test/diary.ts';
import { connectSocket } from '../test/socket.ts';

// Renaming through the real router and PostgreSQL (display-name 验收标准). The stand-in
// sessions read `display_name` on every request, as the real current-user entry point does.

const ORIGIN = 'http://localhost:5173';
const sessions = testSessions();
const currentUser: CurrentUser = async (headers) => {
  const user = await sessions.currentUser(headers);
  if (!user) return null;
  const [row] = await query<{ display_name: string }>(
    'select display_name from users where id = $1',
    [user.id],
  );
  return { ...user, displayName: row!.display_name };
};
let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  app = await buildApp({ publicOrigin: ORIGIN, currentUser, db: database.db });
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});

type Person = { id: string; cookie: string };
const person = (name: string): Promise<Person> => sessions.signIn(name);
const path = (template: string, params: Record<string, string>) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, v), template);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;
const rename = (who: Person, payload: object) => send(who, 'PATCH', routes.updateMe.path, payload);
const stored = async (who: Person) =>
  (
    await query<{ display_name: string }>('select display_name from users where id = $1', [who.id])
  )[0]!.display_name;
const copies = (spaceId: string) =>
  query<{ record_type: string | null; private_to: string | null; xmin: string }>(
    'select record_type, private_to, xmin::text from space_copy_outbox where space_id = $1 order by created_at',
    [spaceId],
  );

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** One commit to the owner's diary over the real socket; resolves on its ack. */
async function commit(owner: Person, diaryId: string) {
  const state = routes.diary.response.parse(
    (await get(owner, path(routes.diary.path, { diaryId }))).json(),
  ).diary;
  const socket = await connectSocket(app, owner.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId,
    generationId: state.generationId,
    knownSeq: state.seq,
  });
  expect(await socket.next()).toMatchObject({ type: 'synced' });
  const batchId = randomUUID();
  const doc = client(71_001, new Uint8Array(Buffer.from(state.state, 'base64')));
  socket.send({
    v: 1,
    type: 'submit',
    diaryId,
    batchId,
    generationId: state.generationId,
    operations: [
      {
        operationId: randomUUID(),
        update: base64(edit(doc, (text) => text.insert(text.length, '写一句'))),
        writtenAt: '2026-06-01T09:00:00Z',
      },
    ],
  });
  const answer = await socket.next();
  socket.close();
  return answer;
}

async function bind(a: Person, b: Person) {
  const invited = await send(a, 'POST', routes.createInvitation.path, {
    requestId: randomUUID(),
    sharingSelection: null,
  });
  const { token } = routes.createInvitation.response.parse(invited.json());
  const accepted = await send(b, 'POST', routes.acceptInvitation.path, {
    token,
    sharingSelection: null,
  });
  expect(accepted.statusCode).toBe(200);
  return routes.acceptInvitation.response.parse(accepted.json()).binding;
}

describe.runIf(testDatabaseUrl)('renaming', () => {
  it('[adr:display-name#2] refuses an invalid name and writes nothing; saves the trimmed one', async () => {
    const a = await person('alice');
    for (const displayName of ['   ', '一'.repeat(21), '小\n雨', '​‍', 42])
      expect(codeOf(await rename(a, { displayName }))).toBe('VALIDATION_FAILED');
    expect(await stored(a)).toBe('alice');

    const longest = '👩‍❤️‍👨' + '雨'.repeat(19);
    const saved = await rename(a, { displayName: ` ${longest} ` });
    expect(saved.statusCode).toBe(200);
    expect(routes.updateMe.response.parse(saved.json())).toEqual({
      user: { id: a.id, displayName: longest },
    });
    expect(await stored(a)).toBe(longest);
    // The same name again is saved as before.
    expect((await rename(a, { displayName: longest })).statusCode).toBe(200);
  });

  it('[adr:display-name#1] renames only the session’s user and takes no other field', async () => {
    const a = await person('alice');
    const b = await person('bob');
    for (const extra of [{ userId: b.id }, { id: b.id }, { email: 'x@y.test' }])
      expect(codeOf(await rename(a, { displayName: '小雨', ...extra }))).toBe('VALIDATION_FAILED');
    expect(await stored(a)).toBe('alice');
    expect(await stored(b)).toBe('bob');

    expect((await rename(a, { displayName: '小雨' })).statusCode).toBe(200);
    expect(await stored(a)).toBe('小雨');
    expect(await stored(b)).toBe('bob');

    const anonymous = await app.inject({
      method: 'PATCH',
      url: routes.updateMe.path,
      headers: { origin: ORIGIN },
      payload: { displayName: '小雨' },
    });
    expect(anonymous.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'PATCH',
      url: routes.updateMe.path,
      headers: { origin: 'https://evil.test', cookie: b.cookie },
      payload: { displayName: '小雨' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(await stored(b)).toBe('bob');
  });

  it('[adr:display-name#4] registers every Together Doc of the current space in the same commit, and nothing otherwise', async () => {
    const a = await person('alice');
    const b = await person('bob');
    // No space: nothing to register.
    expect((await rename(a, { displayName: 'alice 1' })).statusCode).toBe(200);
    const binding = await bind(a, b);
    const spaceId = binding.space.id;
    const before = (await copies(spaceId)).length;

    expect((await rename(a, { displayName: '小雨' })).statusCode).toBe(200);
    const after = await copies(spaceId);
    expect(after).toHaveLength(before + 1);
    const [row] = after.slice(-1);
    expect(row).toMatchObject({ record_type: null, private_to: null });
    const [user] = await query<{ xmin: string }>('select xmin::text from users where id = $1', [
      a.id,
    ]);
    expect(row!.xmin).toBe(user!.xmin);

    // The same name: nothing changes, nothing is registered.
    expect((await rename(a, { displayName: '小雨' })).statusCode).toBe(200);
    expect(await copies(spaceId)).toHaveLength(before + 1);

    // Unbound: the read-only Docs keep the names they have.
    const unbound = await send(a, 'POST', path(routes.unbind.path, { spaceId }), {
      expectedPeriodId: binding.periodId,
    });
    expect(unbound.statusCode).toBe(200);
    const archived = (await copies(spaceId)).length;
    expect((await rename(a, { displayName: '小雨 2' })).statusCode).toBe(200);
    expect((await rename(b, { displayName: '小明' })).statusCode).toBe(200);
    expect(await copies(spaceId)).toHaveLength(archived);
  });

  it('[adr:display-name#3] every answer that names the caller says the new name at once', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const binding = await bind(a, b);
    const spaceId = binding.space.id;
    const zone = '?timezone=UTC';
    const page = await send(a, 'POST', routes.createSharedPage.path, {
      requestId: randomUUID(),
      title: '一起的页',
    });
    expect(page.statusCode).toBe(200);
    expect((await rename(a, { displayName: '小雨' })).statusCode).toBe(200);
    const named = { id: a.id, displayName: '小雨' };

    expect(routes.me.response.parse((await get(a, routes.me.path)).json()).user).toEqual(named);
    const participants = (space: { participants: { user: unknown }[] }) =>
      space.participants.map((p) => p.user);
    expect(
      participants(
        routes.binding.response.parse((await get(b, routes.binding.path)).json()).binding!.space,
      ),
    ).toContainEqual(named);
    expect(
      participants(
        routes.space.response.parse((await get(b, path(routes.space.path, { spaceId }))).json())
          .space,
      ),
    ).toContainEqual(named);
    expect(
      routes.clocks.response.parse((await get(b, routes.clocks.path)).json()).partner?.user,
    ).toEqual(named);
    expect(routes.wishes.response.parse((await get(b, routes.wishes.path)).json()).partner).toEqual(
      named,
    );
    expect(
      routes.anniversaries.response.parse((await get(b, routes.anniversaries.path + zone)).json())
        .partner,
    ).toEqual(named);
    expect(
      routes.sharedPages.response.parse((await get(b, routes.sharedPages.path)).json()).partner,
    ).toEqual(named);

    // An invitation's preview reads the inviter's name when it is opened.
    const c = await person('carol');
    const d = await person('dave');
    const invited = await send(c, 'POST', routes.createInvitation.path, {
      requestId: randomUUID(),
      sharingSelection: null,
    });
    const { token } = routes.createInvitation.response.parse(invited.json());
    expect((await rename(c, { displayName: '小红' })).statusCode).toBe(200);
    const preview = await send(d, 'POST', routes.previewInvitation.path, { token });
    expect(routes.previewInvitation.response.parse(preview.json()).inviter).toEqual({
      id: c.id,
      displayName: '小红',
    });
  });

  it('[adr:display-name#5] leaves the partner’s unread and home dots as they were', async () => {
    const a = await person('alice');
    const b = await person('bob');
    await bind(a, b);
    const unreadOf = async () => ({
      space: routes.spaceUnread.response.parse((await get(b, routes.spaceUnread.path)).json()),
      days: routes.days.response.parse((await get(b, routes.days.path)).json()),
      pokes: routes.pokes.response.parse((await get(b, routes.pokes.path)).json()),
    });
    const before = await unreadOf();
    expect((await rename(a, { displayName: '小雨' })).statusCode).toBe(200);
    expect(await unreadOf()).toEqual(before);
  });

  it('waits behind a relationship flow holding the users row, and never blocks writing a diary', async () => {
    const waitingOnLock = async () => {
      for (;;) {
        const [row] = await query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'",
        );
        if (row!.n > 0) return;
      }
    };
    const a = await person('alice');
    // A relationship flow holds the row FOR UPDATE: the rename queues, then completes.
    {
      const flow = new pg.Client({ connectionString: testDatabaseUrl });
      await flow.connect();
      await flow.query('begin');
      await flow.query('select id from users where id = $1 for update', [a.id]);
      let done = false;
      const renaming = rename(a, { displayName: '小雨' }).then((res) => ((done = true), res));
      await waitingOnLock();
      expect(done).toBe(false);
      await flow.query('commit');
      await flow.end();
      expect((await renaming).statusCode).toBe(200);
      expect(await stored(a)).toBe('小雨');
    }
    // A rename holds the row (FOR NO KEY UPDATE): creating a diary and committing to it,
    // which take at most FOR KEY SHARE on it, go ahead.
    {
      const renaming = new pg.Client({ connectionString: testDatabaseUrl });
      await renaming.connect();
      await renaming.query('begin');
      await renaming.query("update users set display_name = '小雨 2' where id = $1", [a.id]);
      const opened = await send(a, 'POST', routes.openDiary.path, {
        timezone: 'UTC',
        date: '2026-06-01',
      });
      expect(opened.statusCode).toBe(200);
      const { diaryId } = routes.openDiary.response.parse(opened.json()).diary;
      expect(await commit(a, diaryId)).toMatchObject({ type: 'ack' });
      await renaming.query('rollback');
      await renaming.end();
    }
  });
});
