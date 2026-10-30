import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes, type ResponseOf } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Anniversaries (anniversaries ADR) and the dates they and gifts count in
// (partner-local-dates ADR) through the real router and real PostgreSQL. "Today" is the
// real today: each expectation is computed in the zone it should be counted in.

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
type Anniversary = ResponseOf<'createAnniversary'>['anniversary'];
const LA = 'America/Los_Angeles';
const SHANGHAI = 'Asia/Shanghai';
// UTC+14 and UTC−11 with no daylight saving: always on different dates.
const AHEAD = 'Pacific/Kiritimati';
const BEHIND = 'Pacific/Pago_Pago';

const path = (template: string, id: string) => template.replace(/:\w+/, id);
const withZone = (url: string, zone: string) => `${url}?timezone=${encodeURIComponent(zone)}`;
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

/** Today's date in `zone`, as numbers. */
const todayIn = (zone: string, shiftDays = 0) => {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: zone })
    .format(Date.now() + shiftDays * 86_400_000)
    .split('-')
    .map(Number) as [number, number, number];
  return { year, month, day };
};
const iso = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

const view = async (who: Person, zone = LA) => {
  const res = await get(who, withZone(routes.anniversaries.path, zone));
  expect(res.headers['cache-control']).toBe('no-store');
  return ok(res, (v) => routes.anniversaries.response.parse(v));
};
const create = (who: Person, body: object, zone = LA) =>
  send(who, 'POST', withZone(routes.createAnniversary.path, zone), {
    requestId: randomUUID(),
    birthdayOf: null,
    name: null,
    note: null,
    ...body,
  });
const created = async (who: Person, body: object, zone = LA): Promise<Anniversary> =>
  ok(await create(who, body, zone), (v) => routes.createAnniversary.response.parse(v)).anniversary;
const reportZone = async (who: Person, timezone: string) =>
  expect((await send(who, 'PUT', routes.reportTimezone.path, { timezone })).statusCode).toBe(200);
const unreadOf = async (who: Person) =>
  ok(await get(who, routes.spaceUnread.path), (v) => routes.spaceUnread.response.parse(v)).features
    .anniversaries;

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

describe.runIf(testDatabaseUrl)('anniversaries', () => {
  it('[adr:anniversaries#1] one together day per space; a date that does not exist is refused', async () => {
    const { a, b } = await pair();
    await created(a, { kind: 'together', year: 2024, month: 2, day: 29 });
    const second = await create(b, { kind: 'together', year: 2025, month: 1, day: 1 });
    expect(second.statusCode).toBe(409);
    expect(codeOf(second)).toBe('RECORD_EXISTS');
    for (const bad of [
      { kind: 'other', name: '认识', year: 2025, month: 2, day: 30 },
      { kind: 'other', name: '认识', year: 2025, month: 2, day: 29 },
      { kind: 'other', name: '认识', year: null, month: 5, day: 1 },
      { kind: 'birthday', year: null, month: 5, day: 1 },
    ])
      expect(codeOf(await create(a, bad))).toBe('VALIDATION_FAILED');
    // A birthday of someone outside the pair.
    expect(
      codeOf(
        await create(a, {
          kind: 'birthday',
          birthdayOf: randomUUID(),
          year: null,
          month: 5,
          day: 1,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    // A leap-day birthday without a year is a real day.
    expect(
      (await create(a, { kind: 'birthday', birthdayOf: b.id, year: null, month: 2, day: 29 }))
        .statusCode,
    ).toBe(200);
  });

  it('[adr:anniversaries#2] either person corrects the date, each an action; only the author changes the rest', async () => {
    const { a, b } = await pair();
    const met = await created(a, {
      kind: 'other',
      name: '第一次见面',
      year: 2023,
      month: 6,
      day: 1,
    });
    const edit = { expectedRevision: 1, kind: 'other', birthdayOf: null, name: '初见', note: null };
    const editUrl = withZone(path(routes.editAnniversary.path, met.id), LA);
    expect(codeOf(await send(b, 'PUT', editUrl, edit))).toBe('NOT_FOUND');
    const removed = await send(b, 'POST', path(routes.deleteAnniversary.path, met.id), {
      requestId: randomUUID(),
    });
    expect(codeOf(removed)).toBe('NOT_FOUND');

    const moved = ok(
      await send(b, 'PUT', withZone(path(routes.setAnniversaryDate.path, met.id), LA), {
        requestId: randomUUID(),
        year: 2023,
        month: 6,
        day: 2,
      }),
      (v) => routes.setAnniversaryDate.response.parse(v),
    ).anniversary;
    expect(moved).toMatchObject({ day: 2, dateSet: { by: b.id } });
    const counted = ok(
      await send(b, 'PUT', withZone(path(routes.setAnniversaryCount.path, met.id), LA), {
        requestId: randomUUID(),
        showCount: true,
      }),
      (v) => routes.setAnniversaryCount.response.parse(v),
    ).anniversary;
    expect(counted).toMatchObject({ showCount: true, countSet: { by: b.id } });
    const renamed = ok(await send(a, 'PUT', editUrl, edit), (v) =>
      routes.editAnniversary.response.parse(v),
    ).anniversary;
    expect(renamed).toMatchObject({ name: '初见', revision: 2 });

    const history = await query<{ kind: string; actor_id: string }>(
      'select kind, actor_id from space_actions where record_id = $1 order by seq',
      [met.id],
    );
    expect(history).toEqual([
      { kind: 'set_date', actor_id: b.id },
      { kind: 'set_count', actor_id: b.id },
    ]);
    // B never saw it, so it is new to B; B's actions are new to A.
    expect((await view(b)).anniversaries[0]!.unread).toBe('new');
    expect((await view(a)).anniversaries[0]!.unread).toBe('acted');
  });

  it('[adr:anniversaries#4] a reminder is only its owner’s, never unread for the other, and stays editable after unbinding', async () => {
    const { a, b, binding } = await pair();
    const day = await created(a, { kind: 'together', year: 2024, month: 1, day: 1 });
    const ownBirthday = await created(a, {
      kind: 'birthday',
      birthdayOf: a.id,
      year: null,
      month: 3,
      day: 3,
    });
    // Defaults: 7 days, only the day itself for one's own birthday.
    expect(day.reminder).toBe(7);
    expect(ownBirthday.reminder).toBe(0);
    const seen = (await view(b)).anniversaries;
    await send(b, 'POST', routes.reportSeen.path, {
      records: seen.map((x) => ({ type: 'anniversary', id: x.id, mark: x.mark })),
    });
    expect(await unreadOf(b)).toBe(0);

    const remind = (who: Person, days: number | null) =>
      send(who, 'PUT', withZone(path(routes.saveAnniversaryReminder.path, day.id), LA), { days });
    expect(
      ok(await remind(a, 30), (v) => routes.saveAnniversaryReminder.response.parse(v)).anniversary
        .reminder,
    ).toBe(30);
    expect(codeOf(await remind(a, 5))).toBe('VALIDATION_FAILED');
    expect((await view(b)).anniversaries.find((x) => x.id === day.id)!.reminder).toBe(7);
    expect(await unreadOf(b)).toBe(0);

    await unbind(a, binding);
    expect(
      ok(await remind(a, null), (v) => routes.saveAnniversaryReminder.response.parse(v)).anniversary
        .reminder,
    ).toBeNull();
    const unbound = await view(a);
    expect(unbound.readOnly).toBe(true);
    expect(unbound.home).toBeNull();
  });

  it('[adr:partner-local-dates#1] [adr:partner-local-dates#3] the partner’s birthday and the together day count in the partner’s date, one’s own birthday in one’s own', async () => {
    const { a, b } = await pair();
    // B is a day or two ahead of A: UTC+14 against UTC−11.
    await reportZone(a, BEHIND);
    await reportZone(b, AHEAD);
    const bToday = todayIn(AHEAD);
    const aToday = todayIn(BEHIND);
    const together = await created(a, { kind: 'together', ...bToday, year: 2020 }, BEHIND);
    const birthday = await created(
      a,
      { kind: 'birthday', birthdayOf: b.id, year: null, ...bToday },
      BEHIND,
    );
    expect(birthday).toMatchObject({ basis: 'partner', due: true });
    expect(birthday.next).toMatchObject({ date: iso(bToday), daysLeft: 0 });
    expect(birthday.next.startsAt).toBe(
      new Date(Date.UTC(bToday.year, bToday.month - 1, bToday.day) - 14 * 3_600_000).toISOString(),
    );
    expect(together).toMatchObject({
      basis: 'partner',
      next: { daysLeft: 0, years: bToday.year - 2020 },
    });
    // On the same day the birthday comes before the together day (D3).
    expect((await view(a, BEHIND)).home).toBe(birthday.id);
    // A's own birthday on A's today counts in A's own browser zone.
    const mine = await created(
      a,
      { kind: 'birthday', birthdayOf: a.id, year: null, ...aToday },
      BEHIND,
    );
    expect(mine).toMatchObject({ basis: 'own', next: { date: iso(aToday), daysLeft: 0 } });
    // B sees A's birthday in A's date: it is today there too.
    const forB = await view(b, AHEAD);
    expect(forB.anniversaries.find((x) => x.id === mine.id)).toMatchObject({
      basis: 'partner',
      next: { daysLeft: 0 },
    });
    // No answer carries the partner's zone.
    const body = (await get(a, withZone(routes.anniversaries.path, BEHIND))).body;
    expect(body).not.toContain(AHEAD);
  });

  it('[adr:partner-local-dates#2] a partner who never reported a zone and an unbound one count the same: in one’s own date', async () => {
    const { a, b, binding } = await pair();
    const tomorrow = todayIn(SHANGHAI, 1);
    const day = await created(
      a,
      { kind: 'other', name: '认识', ...tomorrow, year: 2020 },
      SHANGHAI,
    );
    const silent = (await view(a, SHANGHAI)).anniversaries[0]!;
    expect(silent).toMatchObject({ basis: 'unknown', next: { date: iso(tomorrow), daysLeft: 1 } });
    await reportZone(b, AHEAD);
    expect((await view(a, SHANGHAI)).anniversaries[0]!.basis).toBe('partner');
    await unbind(a, binding);
    const unbound = (await view(a, SHANGHAI)).anniversaries[0]!;
    expect(unbound.id).toBe(day.id);
    expect({ ...unbound, unread: null, mark: 0 }).toEqual({ ...silent, unread: null, mark: 0 });
  });

  it('[adr:partner-local-dates#5] a revealed gift is dated in the receiver’s date, else the revealer’s', async () => {
    const { a, b } = await pair();
    await reportZone(a, AHEAD);
    await reportZone(b, BEHIND);
    const surprise = async (giver: Person, name: string) => {
      const res = await send(giver, 'POST', routes.prepareGift.path, {
        requestId: randomUUID(),
        wishId: null,
        name,
      });
      const gift = ok(res, (v) => routes.prepareGift.response.parse(v)).gift;
      const revealed = await send(giver, 'POST', path(routes.revealGift.path, gift.id), {
        requestId: randomUUID(),
      });
      return ok(revealed, (v) => routes.revealGift.response.parse(v)).gift;
    };
    // B, behind, reveals to A, ahead: A's date.
    expect((await surprise(b, '花')).date).toBe(iso(todayIn(AHEAD)));
    // A receiver who never reported: the revealer's date.
    const c = await sessions.signIn('C');
    const d = await sessions.signIn('D');
    const invited = await send(c, 'POST', routes.createInvitation.path, {
      requestId: randomUUID(),
      sharingSelection: null,
    });
    const { token } = routes.createInvitation.response.parse(invited.json());
    await send(d, 'POST', routes.acceptInvitation.path, { token, sharingSelection: null });
    await reportZone(c, BEHIND);
    expect((await surprise(c, '书')).date).toBe(iso(todayIn(BEHIND)));
  });

  it('[adr:anniversaries#6] [adr:anniversaries#7] a gift for an anniversary keeps its name after deletion; its page lists years and gifts, never diaries', async () => {
    const { a, b } = await pair();
    const met = await created(a, {
      kind: 'other',
      name: '第一次见面',
      year: 2024,
      month: 6,
      day: 1,
    });
    const prepared = ok(
      await send(b, 'POST', routes.prepareGift.path, {
        requestId: randomUUID(),
        wishId: null,
        name: '花',
      }),
      (v) => routes.prepareGift.response.parse(v),
    ).gift;
    await send(b, 'POST', path(routes.revealGift.path, prepared.id), { requestId: randomUUID() });
    const occasion = (body: object) =>
      send(a, 'PUT', path(routes.setGiftOccasion.path, prepared.id), {
        requestId: randomUUID(),
        occasion: null,
        anniversaryId: null,
        ...body,
      });
    expect(codeOf(await occasion({ anniversaryId: randomUUID() }))).toBe('NOT_FOUND');
    expect(codeOf(await occasion({ occasion: 'holiday', anniversaryId: met.id }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      (
        await send(b, 'PUT', path(routes.setGiftDate.path, prepared.id), {
          requestId: randomUUID(),
          date: '2025-06-01',
        })
      ).statusCode,
    ).toBe(200);
    const linked = ok(await occasion({ anniversaryId: met.id }), (v) =>
      routes.setGiftOccasion.response.parse(v),
    ).gift;
    expect(linked).toMatchObject({
      occasion: null,
      anniversary: { id: met.id, name: '第一次见面' },
    });

    const page = ok(await get(a, withZone(path(routes.anniversary.path, met.id), LA)), (v) =>
      routes.anniversary.response.parse(v),
    );
    const thisYear = todayIn(LA).year;
    expect(page.years.map((y) => y.year)).toEqual(
      Array.from({ length: thisYear - 2023 }, (_, i) => thisYear - i),
    );
    expect(page.years.find((y) => y.year === 2025)).toEqual({
      year: 2025,
      date: '2025-06-01',
      gifts: [{ id: prepared.id, name: '花', giverId: b.id, date: '2025-06-01' }],
    });
    expect(Object.keys(page)).toEqual(['me', 'partner', 'readOnly', 'anniversary', 'years']);

    await send(a, 'POST', path(routes.deleteAnniversary.path, met.id), { requestId: randomUUID() });
    const wall = ok(await get(b, routes.wishes.path), (v) => routes.wishes.response.parse(v)).wall;
    expect(wall.find((g) => g.id === prepared.id)!.anniversary).toEqual({
      id: met.id,
      name: '第一次见面',
    });
    // B had set nothing on it, so B gets no deletion note; it is gone from the list.
    const forB = await view(b);
    expect(forB.anniversaries).toEqual([]);
    expect(forB.notes).toEqual([]);
  });

  it('[adr:space-records#7] deleting an anniversary whose date the partner corrected leaves them a note', async () => {
    const { a, b } = await pair();
    const met = await created(a, { kind: 'other', name: '认识', year: 2022, month: 9, day: 9 });
    await send(b, 'PUT', withZone(path(routes.setAnniversaryDate.path, met.id), LA), {
      requestId: randomUUID(),
      year: 2022,
      month: 9,
      day: 10,
    });
    await send(a, 'POST', path(routes.deleteAnniversary.path, met.id), { requestId: randomUUID() });
    const notes = (await view(b)).notes;
    expect(notes).toEqual([
      expect.objectContaining({ id: met.id, kind: 'other', name: '认识', unread: 'acted' }),
    ]);
    expect(await unreadOf(b)).toBe(1);
  });
});
