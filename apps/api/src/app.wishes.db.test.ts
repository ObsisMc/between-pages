import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes, type ResponseOf } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Space records (space-records ADR) and wishes and gifts (wishes-and-gifts ADR) through the
// real router and real PostgreSQL.

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
type Wishes = ResponseOf<'wishes'>;
const person = (name: string): Promise<Person> => sessions.signIn(name);
const path = (template: string, id: string) => template.replace(/:\w+/, id);

const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;
const ok = <T>(
  res: { statusCode: number; json: () => unknown; body: string },
  parse: (v: unknown) => T,
) => {
  expect(res.statusCode, res.body).toBe(200);
  return parse(res.json());
};

const view = async (who: Person): Promise<Wishes> => {
  const res = await get(who, routes.wishes.path);
  expect(res.headers['cache-control']).toBe('no-store');
  return ok(res, (v) => routes.wishes.response.parse(v));
};
const unreadOf = async (who: Person) =>
  ok(await get(who, routes.spaceUnread.path), (v) => routes.spaceUnread.response.parse(v)).features
    .wishes;
const wishInput = { name: '灰色围巾', link: null, note: '要羊毛的', want: 4 };
const createWish = async (who: Person, input: object = wishInput) =>
  ok(await send(who, 'POST', routes.createWish.path, { requestId: randomUUID(), ...input }), (v) =>
    routes.createWish.response.parse(v),
  ).wish;
const prepare = async (who: Person, body: object) =>
  ok(await send(who, 'POST', routes.prepareGift.path, { requestId: randomUUID(), ...body }), (v) =>
    routes.prepareGift.response.parse(v),
  ).gift;
const writeCard = (
  who: Person,
  giftId: string,
  text: string,
  expectedRevision: number | null = null,
) => send(who, 'PUT', path(routes.saveGiftCard.path, giftId), { expectedRevision, text });
const reveal = (who: Person, giftId: string, requestId = randomUUID()) =>
  send(who, 'POST', path(routes.revealGift.path, giftId), { requestId });
const receive = (who: Person, wishId: string, requestId = randomUUID()) =>
  send(who, 'POST', path(routes.receiveWish.path, wishId), { requestId });
const seen = (who: Person, records: { type: string; id: string; mark: number }[]) =>
  send(who, 'POST', routes.reportSeen.path, { records });

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
const unbind = async (who: Person, binding: { space: { id: string }; periodId: string }) =>
  expect(
    (
      await send(who, 'POST', path(routes.unbind.path, binding.space.id), {
        expectedPeriodId: binding.periodId,
      })
    ).statusCode,
  ).toBe(200);
async function pair() {
  const a = await person('A');
  const b = await person('B');
  return { a, b, binding: await bind(a, b) };
}

describe.runIf(testDatabaseUrl)('space records and wishes', () => {
  it('[adr:space-records#10] an account never bound gets no space feature', async () => {
    const loner = await person('C');
    expect(codeOf(await get(loner, routes.wishes.path))).toBe('NOT_FOUND');
    expect(codeOf(await get(loner, routes.spaceUnread.path))).toBe('NOT_FOUND');
    const created = await send(loner, 'POST', routes.createWish.path, {
      requestId: randomUUID(),
      ...wishInput,
    });
    expect(codeOf(created)).toBe('NOT_FOUND');
  });

  it('[adr:wishes-and-gifts#1] [adr:space-records#3] only the wisher changes or deletes a wish; want is 1–5', async () => {
    const { a, b } = await pair();
    const wish = await createWish(a);
    expect(wish).toMatchObject({ authorId: a.id, name: '灰色围巾', want: 4, revision: 1 });

    const edit = { expectedRevision: 1, ...wishInput, name: '蓝色围巾' };
    expect(codeOf(await send(b, 'PUT', path(routes.editWish.path, wish.id), edit))).toBe(
      'NOT_FOUND',
    );
    const removed = await send(b, 'POST', path(routes.deleteWish.path, wish.id), {
      requestId: randomUUID(),
    });
    expect(codeOf(removed)).toBe('NOT_FOUND');
    expect(codeOf(await receive(b, wish.id))).toBe('NOT_FOUND');

    for (const want of [0, 6, 2.5])
      expect(
        codeOf(await send(a, 'PUT', path(routes.editWish.path, wish.id), { ...edit, want })),
      ).toBe('VALIDATION_FAILED');
    const edited = ok(await send(a, 'PUT', path(routes.editWish.path, wish.id), edit), (v) =>
      routes.editWish.response.parse(v),
    ).wish;
    expect(edited).toMatchObject({ name: '蓝色围巾', revision: 2 });
    // [adr:space-records#3] an edit from an older revision does not overwrite the newer one.
    expect(codeOf(await send(a, 'PUT', path(routes.editWish.path, wish.id), edit))).toBe(
      'RECORD_STALE',
    );
    expect((await view(b)).theirs.map((w) => w.name)).toEqual(['蓝色围巾']);
  });

  it('[adr:space-records#2] the author comes from the session; a request naming one is refused', async () => {
    const { a, b } = await pair();
    const named = await send(a, 'POST', routes.createWish.path, {
      requestId: randomUUID(),
      ...wishInput,
      authorId: b.id,
    });
    expect(codeOf(named)).toBe('VALIDATION_FAILED');
    const wish = await createWish(a);
    const [row] = await query<{ author_id: string }>('select author_id from wishes where id = $1', [
      wish.id,
    ]);
    expect(row!.author_id).toBe(a.id);
  });

  it('a creation sent twice is stored once; the same request ID with other content is refused', async () => {
    const { a } = await pair();
    const body = { requestId: randomUUID(), ...wishInput };
    const first = await send(a, 'POST', routes.createWish.path, body);
    const again = await send(a, 'POST', routes.createWish.path, body);
    expect(again.json()).toEqual(first.json());
    const racing = { requestId: randomUUID(), ...wishInput };
    const both = await Promise.all(
      [1, 2].map(() => send(a, 'POST', routes.createWish.path, racing)),
    );
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await view(a)).mine).toHaveLength(2);
    const other = await send(a, 'POST', routes.createWish.path, { ...body, name: '别的' });
    expect(codeOf(other)).toBe('VALIDATION_FAILED');
  });

  it('[adr:wishes-and-gifts#2] [adr:space-records#11] the wisher’s answers are the same whether or not someone is preparing', async () => {
    const { a, b } = await pair();
    const wish = await createWish(a);
    const surpriseWish = await createWish(a, { ...wishInput, name: '耳机' });
    // A has seen the list, so later differences can only come from B's preparation.
    const before = await view(a);
    const beforeUnread = (await get(a, routes.spaceUnread.path)).body;

    const gift = await prepare(b, { wishId: wish.id });
    expect(gift).toMatchObject({
      status: 'preparing',
      giverId: b.id,
      receiverId: a.id,
      wishId: wish.id,
    });
    expect((await writeCard(b, gift.id, '生日快乐')).statusCode).toBe(200);
    await prepare(b, { wishId: null, name: '一本书' });
    expect((await view(b)).theirs.find((w) => w.id === wish.id)!.preparingGiftId).toBe(gift.id);

    expect((await get(a, routes.wishes.path)).body).toBe(JSON.stringify(before));
    expect((await get(a, routes.spaceUnread.path)).body).toBe(beforeUnread);

    // Deleting and receiving answer as they would with nobody preparing.
    const deletedPrepared = await send(a, 'POST', path(routes.deleteWish.path, surpriseWish.id), {
      requestId: randomUUID(),
    });
    const plain = await createWish(a, { ...wishInput, name: '杯子' });
    const deletedPlain = await send(a, 'POST', path(routes.deleteWish.path, plain.id), {
      requestId: randomUUID(),
    });
    expect([deletedPrepared.statusCode, deletedPrepared.body]).toEqual([
      deletedPlain.statusCode,
      deletedPlain.body,
    ]);
    const received = await receive(a, wish.id);
    const other = await createWish(a, { ...wishInput, name: '袜子' });
    const receivedPlain = await receive(a, other.id);
    expect(received.statusCode).toBe(receivedPlain.statusCode);
    expect(Object.keys(received.json() as object)).toEqual(
      Object.keys(receivedPlain.json() as object),
    );
  });

  it('[adr:wishes-and-gifts#3] a wish gets one gift in preparation and a gift is revealed once', async () => {
    const { a, b } = await pair();
    const wish = await createWish(a);
    const [one, two] = await Promise.all([
      prepare(b, { wishId: wish.id }),
      prepare(b, { wishId: wish.id }),
    ]);
    expect(one.id).toBe(two.id);
    expect((await view(b)).preparing).toHaveLength(1);

    const [byGiver, byWisher] = await Promise.all([reveal(b, one.id), receive(a, wish.id)]);
    expect([byGiver.statusCode, byWisher.statusCode].sort()).toEqual([200, 200].sort());
    const wall = (await view(a)).wall;
    expect(wall).toHaveLength(1);
    expect(wall[0]).toMatchObject({ id: one.id, status: 'revealed' });
    const reveals = await query<{ n: number }>(
      "select count(*)::int as n from space_actions where record_id = $1 and kind = 'reveal'",
      [one.id],
    );
    expect(reveals[0]!.n).toBe(1);
    // Revealed for good: revealing again changes nothing.
    expect(
      ok(await reveal(b, one.id), (v) => routes.revealGift.response.parse(v)).gift.revealed,
    ).toEqual(wall[0]!.revealed);
  });

  it('[adr:wishes-and-gifts#4] [adr:wishes-and-gifts#5] the three ways to reveal, and who sees the card', async () => {
    const { a, b } = await pair();
    // 1. The giver reveals a gift for a wish: it leaves the list, the card arrives with it.
    const scarf = await createWish(a);
    const forScarf = await prepare(b, { wishId: scarf.id });
    await writeCard(b, forScarf.id, '冬天快乐');
    expect(codeOf(await reveal(a, forScarf.id))).toBe('NOT_FOUND');
    expect(
      ok(await reveal(b, forScarf.id), (v) => routes.revealGift.response.parse(v)).gift.status,
    ).toBe('revealed');
    // 2. The wisher's "收到了" reveals what the partner was preparing.
    const book = await createWish(a, { ...wishInput, name: '书' });
    const forBook = await prepare(b, { wishId: book.id });
    await writeCard(b, forBook.id, '慢慢读');
    const got = ok(await receive(a, book.id), (v) => routes.receiveWish.response.parse(v));
    expect(got.giftId).toBe(forBook.id);
    // 3. "收到了" with nobody preparing: a gift from the partner, with no card yet.
    const mug = await createWish(a, { ...wishInput, name: '杯子' });
    const fromMug = ok(await receive(a, mug.id), (v) => routes.receiveWish.response.parse(v));
    // A surprise off the list only its giver can reveal.
    const surprise = await prepare(b, { wishId: null, name: '花' });
    expect(codeOf(await reveal(a, surprise.id))).toBe('NOT_FOUND');

    const mine = await view(a);
    expect(mine.mine).toEqual([]);
    const byId = new Map(mine.wall.map((g) => [g.id, g]));
    expect(byId.get(forScarf.id)!.card!.text).toBe('冬天快乐');
    expect(byId.get(forBook.id)!.card!.text).toBe('慢慢读');
    expect(byId.get(fromMug.giftId)).toMatchObject({
      giverId: b.id,
      receiverId: a.id,
      authorId: a.id,
      card: null,
    });
    expect(byId.has(surprise.id)).toBe(false);
    // The giver adds the card later; only the giver writes it.
    expect(codeOf(await writeCard(a, fromMug.giftId, '我写的'))).toBe('NOT_FOUND');
    expect((await writeCard(b, fromMug.giftId, '迟到的卡片')).statusCode).toBe(200);
    const later = (await view(a)).wall.find((g) => g.id === fromMug.giftId)!;
    expect(later.card).toMatchObject({ text: '迟到的卡片', unread: 'new' });
  });

  it('[adr:wishes-and-gifts#6] [adr:space-records#4] either person sets the wall date and occasion, each an action', async () => {
    const { a, b } = await pair();
    const wish = await createWish(a);
    const { giftId } = ok(await receive(a, wish.id), (v) => routes.receiveWish.response.parse(v));
    const date = (who: Person, d: string) =>
      send(who, 'PUT', path(routes.setGiftDate.path, giftId), { requestId: randomUUID(), date: d });
    expect((await date(b, '2026-10-01')).statusCode).toBe(200);
    const occasion = await send(a, 'PUT', path(routes.setGiftOccasion.path, giftId), {
      requestId: randomUUID(),
      occasion: 'holiday',
    });
    const gift = ok(occasion, (v) => routes.setGiftOccasion.response.parse(v)).gift;
    expect(gift).toMatchObject({ date: '2026-10-01', occasion: 'holiday' });
    expect(gift.dateSet!.by).toBe(b.id);
    expect(gift.occasionSet!.by).toBe(a.id);
    const actions = await query<{ kind: string; actor_id: string }>(
      'select kind, actor_id from space_actions where record_id = $1 order by seq',
      [giftId],
    );
    expect(actions).toEqual([
      { kind: 'set_date', actor_id: b.id },
      { kind: 'set_occasion', actor_id: a.id },
    ]);
    // Only registered action kinds are stored.
    await expect(
      query(
        `insert into space_actions (space_id, record_type, record_id, kind, actor_id, request_id, request_digest)
         select space_id, 'gift', id, 'repaint', author_id, gen_random_uuid(), 'x' from gifts where id = $1`,
        [giftId],
      ),
    ).rejects.toThrow(/space_actions_kind/);
  });

  it('[adr:space-records#4] an action whose history fails to append changes no state', async () => {
    const { a, b } = await pair();
    const wish = await createWish(a);
    const { giftId } = ok(await receive(a, wish.id), (v) => routes.receiveWish.response.parse(v));
    const requestId = randomUUID();
    await query(`create function fail_history() returns trigger language plpgsql as $$
      begin raise exception 'injected'; end $$`);
    await query(`create trigger fail_history before insert on space_actions for each row
      when (new.request_id = '${requestId}') execute function fail_history()`);
    try {
      const failed = await send(b, 'PUT', path(routes.setGiftDate.path, giftId), {
        requestId,
        date: '2020-01-01',
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      await query('drop trigger fail_history on space_actions');
      await query('drop function fail_history');
    }
    expect((await view(a)).wall[0]!.dateSet).toBeNull();
  });

  it('[adr:wishes-and-gifts#9] [adr:space-records#1] [adr:space-records#6] unbound: both read, nobody writes, the giver still sees the surprise; rebinding restores it', async () => {
    const { a, b, binding } = await pair();
    const wish = await createWish(a);
    const gift = await prepare(b, { wishId: null, name: '花' });
    await unbind(a, binding);

    const archived = await view(a);
    expect(archived).toMatchObject({ readOnly: true });
    expect(archived.mine.map((w) => w.id)).toEqual([wish.id]);
    expect((await view(b)).preparing.map((g) => g.id)).toEqual([gift.id]);
    expect(codeOf(await reveal(b, gift.id))).toBe('SPACE_READ_ONLY');
    expect(
      codeOf(
        await send(a, 'POST', routes.createWish.path, { requestId: randomUUID(), ...wishInput }),
      ),
    ).toBe('SPACE_READ_ONLY');
    // Someone else never reaches these records.
    const c = await person('C');
    const d = await person('D');
    await bind(c, d);
    expect((await view(c)).theirs).toEqual([]);
    expect(codeOf(await reveal(c, gift.id))).toBe('NOT_FOUND');
    expect(codeOf(await receive(c, wish.id))).toBe('NOT_FOUND');

    await bind(b, a);
    expect((await view(a)).readOnly).toBe(false);
    expect((await reveal(b, gift.id)).statusCode).toBe(200);
    expect((await view(a)).wall.map((g) => g.id)).toEqual([gift.id]);
  });

  it('[adr:space-records#5] a write and an unbinding wait for each other, so no write lands after the unbinding', async () => {
    const waitingOnLock = async () => {
      for (;;) {
        const [row] = await query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'",
        );
        if (row!.n > 0) return;
      }
    };
    // An unbinding holds the period row: a write that started meanwhile is refused once it commits.
    {
      const { a, binding } = await pair();
      const unbinding = new pg.Client({ connectionString: testDatabaseUrl });
      await unbinding.connect();
      await unbinding.query('begin');
      await unbinding.query(
        'update binding_periods set ended_at = now(), ended_by = $1 where id = $2',
        [a.id, binding.periodId],
      );
      const write = send(a, 'POST', routes.createWish.path, {
        requestId: randomUUID(),
        ...wishInput,
      });
      await waitingOnLock();
      await unbinding.query('commit');
      await unbinding.end();
      expect(codeOf(await write)).toBe('SPACE_READ_ONLY');
    }
    // A write holds the period FOR SHARE: the unbinding waits until it has committed.
    {
      const { a, b, binding } = await pair();
      const writing = new pg.Client({ connectionString: testDatabaseUrl });
      await writing.connect();
      await writing.query('begin');
      await writing.query('select id from binding_periods where id = $1 for share', [
        binding.periodId,
      ]);
      let ended = false;
      const unbinding = send(b, 'POST', path(routes.unbind.path, binding.space.id), {
        expectedPeriodId: binding.periodId,
      }).then((res) => ((ended = true), res));
      await waitingOnLock();
      expect(ended).toBe(false);
      await writing.query('commit');
      await writing.end();
      expect((await unbinding).statusCode).toBe(200);
      expect(
        codeOf(
          await send(a, 'POST', routes.createWish.path, { requestId: randomUUID(), ...wishInput }),
        ),
      ).toBe('SPACE_READ_ONLY');
    }
  });

  it('[adr:space-records#7] deleting a record the partner acted on leaves them a note; one they never touched does not', async () => {
    const { a, b } = await pair();
    const prepared = await createWish(a);
    const untouched = await createWish(a, { ...wishInput, name: '杯子' });
    const gift = await prepare(b, { wishId: prepared.id });
    await writeCard(b, gift.id, '给你');
    for (const wish of [prepared, untouched])
      await send(a, 'POST', path(routes.deleteWish.path, wish.id), { requestId: randomUUID() });

    const giver = await view(b);
    expect(giver.notes).toEqual([
      expect.objectContaining({
        type: 'wish',
        id: prepared.id,
        name: '灰色围巾',
        acted: 'prepared',
        unread: 'acted',
      }),
    ]);
    // The gift and its card stay, now a surprise off the list.
    expect(giver.preparing).toEqual([expect.objectContaining({ id: gift.id, wishId: null })]);
    expect(giver.preparing[0]!.card!.text).toBe('给你');
    expect((await view(a)).notes).toEqual([]);

    // A wall gift whose date the partner set, then deleted by its author.
    const mug = await createWish(a, { ...wishInput, name: '杯子' });
    const { giftId } = ok(await receive(a, mug.id), (v) => routes.receiveWish.response.parse(v));
    await send(b, 'PUT', path(routes.setGiftDate.path, giftId), {
      requestId: randomUUID(),
      date: '2026-01-01',
    });
    await send(a, 'POST', path(routes.deleteGift.path, giftId), { requestId: randomUUID() });
    expect((await view(b)).notes.map((n) => [n.type, n.acted])).toEqual([
      ['gift', 'acted'],
      ['wish', 'prepared'],
    ]);
  });

  it('[adr:space-records#9] unread is per record, read only up to what was on screen, and never shown to the other', async () => {
    const { a, b } = await pair();
    expect(await unreadOf(b)).toBe(0);
    const wish = await createWish(a);
    expect(await unreadOf(a)).toBe(0);
    expect(await unreadOf(b)).toBe(1);
    const loaded = (await view(b)).theirs[0]!;
    expect(loaded).toMatchObject({ unread: 'new', mark: 1 });

    // A edits after B's screen loaded; B's report covers only what B saw.
    await send(a, 'PUT', path(routes.editWish.path, wish.id), {
      expectedRevision: 1,
      ...wishInput,
      name: '红色围巾',
    });
    expect((await seen(b, [{ type: 'wish', id: wish.id, mark: loaded.mark }])).statusCode).toBe(
      200,
    );
    expect((await view(b)).theirs[0]).toMatchObject({ unread: 'edited', mark: 2 });
    expect(await unreadOf(b)).toBe(1);
    await seen(b, [{ type: 'wish', id: wish.id, mark: 2 }]);
    expect(await unreadOf(b)).toBe(0);
    // A lower mark from another device keeps the higher one.
    await seen(b, [{ type: 'wish', id: wish.id, mark: 1 }]);
    expect(await unreadOf(b)).toBe(0);
    // B's reading leaves A's answer as it was.
    expect((await view(a)).mine[0]).toMatchObject({ unread: null, mark: 0 });
  });
});
