import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Two-clocks routes through the real router and real PostgreSQL (two-clocks ADR).

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
const person = (name: string): Promise<Person> => sessions.signIn(name);

const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;

const clocks = async (who: Person) => {
  const res = await get(who, routes.clocks.path);
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return routes.clocks.response.parse(res.json());
};
const report = (who: Person, timezone: string) =>
  send(who, 'PUT', routes.reportTimezone.path, { timezone });
const saveSleep = (who: Person, sleep: { start: number; end: number } | null) =>
  send(who, 'PUT', routes.saveSleep.path, { sleep });

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
const unbind = async (who: Person, spaceId: string, expectedPeriodId: string) =>
  expect(
    (
      await send(who, 'POST', routes.unbind.path.replace(':spaceId', spaceId), {
        expectedPeriodId,
      })
    ).statusCode,
  ).toBe(200);

describe.runIf(testDatabaseUrl)('two clocks', () => {
  it('[adr:two-clocks#2] stores only an IANA zone, and only for the caller', async () => {
    const a = await person('A');

    const stored = await report(a, 'Asia/Tokyo');
    expect(stored.statusCode).toBe(200);
    expect(routes.reportTimezone.response.parse(stored.json())).toEqual({
      timezone: 'Asia/Tokyo',
      sleep: null,
    });
    expect((await clocks(a)).me.timezone).toBe('Asia/Tokyo');

    for (const timezone of ['+09:00', 'Mars/Olympus', ''])
      expect(codeOf(await report(a, timezone))).toBe('VALIDATION_FAILED');
    const forSomeoneElse = await send(a, 'PUT', routes.reportTimezone.path, {
      timezone: 'Asia/Shanghai',
      userId: randomUUID(),
    });
    expect(codeOf(forSomeoneElse)).toBe('VALIDATION_FAILED');
    expect((await clocks(a)).me.timezone).toBe('Asia/Tokyo');
  });

  it('[adr:two-clocks#3] keeps a sleep schedule on the 15-minute grid, crossing midnight', async () => {
    const a = await person('A');

    const crossing = await saveSleep(a, { start: 1410, end: 450 });
    expect(routes.saveSleep.response.parse(crossing.json()).sleep).toEqual({
      start: 1410,
      end: 450,
    });
    for (const sleep of [
      { start: 1410, end: 1410 },
      { start: 10, end: 480 },
      { start: 0, end: 1440 },
    ])
      expect(codeOf(await saveSleep(a, sleep))).toBe('VALIDATION_FAILED');
    expect((await clocks(a)).me.sleep).toEqual({ start: 1410, end: 450 });

    expect((await saveSleep(a, null)).statusCode).toBe(200);
    expect((await clocks(a)).me.sleep).toBeNull();
  });

  it('[adr:two-clocks#1] shows the partner only while bound, and never to anyone else', async () => {
    const a = await person('A');
    const b = await person('B');
    const c = await person('C');
    await report(b, 'Asia/Tokyo');
    await saveSleep(b, { start: 0, end: 480 });
    expect((await clocks(a)).partner).toBeNull();

    const first = await bind(a, b);
    expect((await clocks(a)).partner).toEqual({
      user: { id: b.id, displayName: 'B' },
      timezone: 'Asia/Tokyo',
      sleep: { start: 0, end: 480 },
    });
    expect((await clocks(b)).partner?.user.id).toBe(a.id);
    expect((await clocks(c)).partner).toBeNull();

    await unbind(a, first.space.id, first.periodId);
    await report(b, 'Europe/London');
    for (const who of [a, b, c]) expect((await clocks(who)).partner).toBeNull();

    const restored = await bind(b, a);
    expect(restored.space.id).toBe(first.space.id);
    expect((await clocks(a)).partner?.timezone).toBe('Europe/London');
  });

  it('[adr:two-clocks#1] answers a bound partner who never reported like one with nothing set', async () => {
    const a = await person('A');
    const b = await person('B');
    await bind(a, b);

    expect((await clocks(a)).partner).toEqual({
      user: { id: b.id, displayName: 'B' },
      timezone: null,
      sleep: null,
    });
  });

  it('refuses every clocks route without a session', async () => {
    for (const route of [routes.clocks, routes.reportTimezone, routes.saveSleep]) {
      const res = await app.inject({
        method: route.method,
        url: route.path,
        headers: { origin: ORIGIN },
        ...(route.method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode).toBe(401);
    }
  });
});
