import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { unsubscribeToken } from './mail/tokens.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// The email reminder routes through the real router and PostgreSQL (email-reminders D8):
// one's own settings, and the token-only unsubscribe that is the one write without an
// Origin check.

const ORIGIN = 'http://localhost:5173';
const KEY = randomBytes(32);
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
let keyless: FastifyInstance;
beforeAll(async () => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  const deps = { publicOrigin: ORIGIN, currentUser: sessions.currentUser, db: database.db };
  app = await buildApp({ ...deps, mailTokenKey: KEY });
  keyless = await buildApp(deps);
});
afterAll(async () => {
  await app?.close();
  await keyless?.close();
  await database?.close();
});

type Person = { id: string; cookie: string };
async function person(name: string): Promise<Person & { email: string }> {
  const signed = await sessions.signIn(name);
  const email = `${signed.id}@mail.test`;
  await query('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    signed.id,
    name,
    email,
  ]);
  return { ...signed, email };
}
const settingsOf = async (who: Person) => {
  const res = await app.inject({
    method: 'GET',
    url: routes.mail.path,
    headers: { cookie: who.cookie },
  });
  expect(res.statusCode).toBe(200);
  return routes.mail.response.parse(res.json()).mail;
};
const save = (who: Person, payload: object) =>
  app.inject({
    method: 'PUT',
    url: routes.saveMail.path,
    headers: { origin: ORIGIN, cookie: who.cookie },
    payload,
  });
const unsubscribe = (token: string, instance = app) =>
  instance.inject({
    method: 'POST',
    url: `${routes.unsubscribe.path}?token=${encodeURIComponent(token)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'List-Unsubscribe=One-Click',
  });

describe.runIf(testDatabaseUrl)('mail settings', () => {
  it('[adr:email-reminders#7] answers only the caller’s own switches and address, all on by default', async () => {
    const a = await person('A');
    const b = await person('B');
    expect(await settingsOf(a)).toEqual({
      newContent: true,
      anniversary: true,
      backup: true,
      address: a.email,
      hintDismissed: false,
    });
    const saved = await save(b, { newContent: false, dismissHint: true });
    expect(saved.statusCode).toBe(200);
    expect(routes.saveMail.response.parse(saved.json()).mail).toMatchObject({
      newContent: false,
      anniversary: true,
      address: b.email,
      hintDismissed: true,
    });
    expect(await settingsOf(a)).toMatchObject({ newContent: true, hintDismissed: false });
    // The notice stays closed when switches change later.
    await save(b, { newContent: true });
    expect(await settingsOf(b)).toMatchObject({ newContent: true, hintDismissed: true });
  });

  it('refuses an empty change and a signed-out caller', async () => {
    const a = await person('A');
    expect((await save(a, {})).statusCode).toBe(400);
    const anonymous = await app.inject({ method: 'GET', url: routes.mail.path });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe.runIf(testDatabaseUrl)('unsubscribe', () => {
  it('[adr:email-reminders#9] turns off only the token’s user and category, again changes nothing, and GETs change nothing', async () => {
    const a = await person('A');
    const b = await person('B');
    const token = unsubscribeToken(KEY, a.id, 'anniversary');

    const link = await app.inject({
      method: 'GET',
      url: `${routes.unsubscribeLink.path}?token=${token}`,
    });
    expect(link.statusCode).toBe(303);
    expect(link.headers.location).toBe(`${ORIGIN}/unsubscribe?token=${token}`);
    const category = await app.inject({
      method: 'GET',
      url: `${routes.unsubscribeCategory.path}?token=${token}`,
    });
    expect(routes.unsubscribeCategory.response.parse(category.json())).toEqual({
      category: 'anniversary',
    });
    expect(await settingsOf(a)).toMatchObject({ anniversary: true });

    for (let i = 0; i < 2; i++) {
      const res = await unsubscribe(token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ category: 'anniversary', unsubscribed: true });
    }
    expect(await settingsOf(a)).toMatchObject({
      newContent: true,
      anniversary: false,
      backup: true,
    });
    expect(await settingsOf(b)).toMatchObject({ anniversary: true });
  });

  it('[adr:email-reminders#9] answers 404 for a token not signed with this server’s key, or without a key', async () => {
    const a = await person('A');
    const forged = unsubscribeToken(randomBytes(32), a.id, 'new_content');
    expect((await unsubscribe(forged)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${routes.unsubscribeCategory.path}?token=${forged}`,
        })
      ).statusCode,
    ).toBe(404);
    const good = unsubscribeToken(KEY, a.id, 'new_content');
    expect((await unsubscribe(good, keyless)).statusCode).toBe(404);
    expect(await settingsOf(a)).toMatchObject({ newContent: true });
  });

  it('[adr:email-reminders#13] takes a one-click form without Origin; every other write still needs it', async () => {
    const a = await person('A');
    const res = await unsubscribe(unsubscribeToken(KEY, a.id, 'backup'));
    expect(res.statusCode).toBe(200);
    // The page's own JSON request works too, and reads no cookie.
    const page = await app.inject({
      method: 'POST',
      url: `${routes.unsubscribe.path}?token=${unsubscribeToken(KEY, a.id, 'new_content')}`,
      payload: {},
    });
    expect(page.statusCode).toBe(200);
    expect(await settingsOf(a)).toMatchObject({ newContent: false, backup: false });

    const noOrigin = await app.inject({
      method: 'PUT',
      url: routes.saveMail.path,
      headers: { cookie: a.cookie },
      payload: { backup: true },
    });
    expect(noOrigin.statusCode).toBe(403);
    // The form parser exists for the unsubscribe route alone.
    const form = await app.inject({
      method: 'PUT',
      url: routes.saveMail.path,
      headers: {
        origin: ORIGIN,
        cookie: a.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'backup=true',
    });
    expect(form.statusCode).toBe(400);
    expect(form.json()).toMatchObject({ error: { message: 'Unsupported Media Type' } });
  });
});
