import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Pokes and pets through the real router and real PostgreSQL (window-mascots ADR).

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

const send = (who: Person, url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;

const waiting = async (who: Person) => {
  const res = await app.inject({
    method: 'GET',
    url: routes.pokes.path,
    headers: { cookie: who.cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return routes.pokes.response.parse(res.json()).received;
};
const poke = (who: Person, kind: 'poke' | 'pet' = 'poke') =>
  send(who, routes.sendPoke.path, { kind });
const seen = async (who: Person, pokes: number, pets: number) => {
  const res = await send(who, routes.seenPokes.path, { pokes, pets });
  expect(res.statusCode).toBe(200);
  return routes.seenPokes.response.parse(res.json()).received;
};
/** Lets the next send of each kind count, as if a second had passed (the limit is D4's). */
const aSecondLater = () =>
  database.db.execute(sql`update mascot_pokes
    set poke_sent_at = poke_sent_at - interval '2 seconds',
        pet_sent_at = pet_sent_at - interval '2 seconds'`);

async function bind(a: Person, b: Person) {
  const invited = await send(a, routes.createInvitation.path, {
    requestId: randomUUID(),
    sharingSelection: null,
  });
  const { token } = routes.createInvitation.response.parse(invited.json());
  const accepted = await send(b, routes.acceptInvitation.path, { token, sharingSelection: null });
  expect(accepted.statusCode).toBe(200);
  return routes.acceptInvitation.response.parse(accepted.json()).binding;
}
const unbind = async (who: Person, spaceId: string, expectedPeriodId: string) =>
  expect(
    (await send(who, routes.unbind.path.replace(':spaceId', spaceId), { expectedPeriodId }))
      .statusCode,
  ).toBe(200);

describe.runIf(testDatabaseUrl)('pokes', () => {
  it('[adr:window-mascots#2] [adr:window-mascots#3] reach only the current partner, and tell the sender nothing of them', async () => {
    const a = await person('A');
    const b = await person('B');
    const c = await person('C');
    expect(await waiting(a)).toBeNull();
    expect(codeOf(await poke(a))).toBe('NOT_FOUND');

    const first = await bind(a, b);
    const sent = await poke(a);
    expect(sent.statusCode).toBe(200);
    // The sender's answer is their own waiting pokes: nothing of the partner's row.
    expect(routes.sendPoke.response.parse(sent.json())).toEqual({ received: null });
    expect(await waiting(b)).toMatchObject({ pokes: 1, pets: 0 });
    expect(await waiting(a)).toBeNull();
    expect(await waiting(c)).toBeNull();
    expect(codeOf(await poke(c))).toBe('NOT_FOUND');

    // After unbinding nobody can send or see; a rebind starts from nothing.
    await unbind(a, first.space.id, first.periodId);
    expect(codeOf(await poke(a))).toBe('NOT_FOUND');
    expect(codeOf(await poke(b))).toBe('NOT_FOUND');
    expect(await waiting(b)).toBeNull();
    await bind(b, a);
    expect(await waiting(b)).toBeNull();
    expect((await poke(b, 'pet')).statusCode).toBe(200);
    expect(await waiting(a)).toMatchObject({ pokes: 0, pets: 1 });
  });

  it('[adr:window-mascots#6] counts one of each kind a second per sender, answering the same either way', async () => {
    const a = await person('A');
    const b = await person('B');
    await bind(a, b);
    const answers = [];
    for (const kind of ['poke', 'poke', 'poke', 'pet', 'pet'] as const) {
      const res = await poke(a, kind);
      answers.push([res.statusCode, res.json()]);
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(await waiting(b)).toMatchObject({ pokes: 1, pets: 1 });

    await aSecondLater();
    await poke(a);
    expect(await waiting(b)).toMatchObject({ pokes: 2, pets: 1 });
  });

  it('[adr:window-mascots#4] [adr:window-mascots#8] shows each one once: what is shown is taken off, what arrived meanwhile stays, an emptied row is gone', async () => {
    const a = await person('A');
    const b = await person('B');
    const binding = await bind(a, b);
    await poke(a);
    await poke(a, 'pet');
    const shown = await waiting(b);
    expect(shown).toMatchObject({ pokes: 1, pets: 1 });

    // A poke arrives between showing and confirming: it stays for the next look.
    await aSecondLater();
    await poke(a);
    expect(await seen(b, shown!.pokes, shown!.pets)).toMatchObject({ pokes: 1, pets: 0 });
    expect(await waiting(b)).toMatchObject({ pokes: 1, pets: 0 });

    expect(await seen(b, 1, 0)).toBeNull();
    expect(await waiting(b)).toBeNull();
    const rows = await database.db.execute(
      sql`select 1 from mascot_pokes where period_id = ${binding.periodId}::uuid`,
    );
    expect(rows.rowCount).toBe(0);
    // Confirming more than waits never goes below nothing.
    expect(await seen(b, 5, 5)).toBeNull();
  });

  it('refuses a request that names anyone or counts the wrong way', async () => {
    const a = await person('A');
    const b = await person('B');
    await bind(a, b);
    expect(codeOf(await send(a, routes.sendPoke.path, { kind: 'hug' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(await send(a, routes.sendPoke.path, { kind: 'poke', to: b.id }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codeOf(await send(b, routes.seenPokes.path, { pokes: -1, pets: 0 }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
