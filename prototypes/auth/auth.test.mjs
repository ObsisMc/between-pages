import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Events, OAuth2Server } from 'oauth2-mock-server';
import { createAuthServer } from './server.mjs';

// Runs against a disposable PostgreSQL: npm run test:auth:pg
const databaseUrl = process.env.COLLAB_TEST_DATABASE_URL;
const WEB = 'http://127.0.0.1:5173';
const idp = new OAuth2Server();
let server;
let identity; // claims the mock provider returns for the next sign-in

before(async () => {
  assert.ok(databaseUrl, 'COLLAB_TEST_DATABASE_URL is required (use npm run test:auth:pg)');
  await idp.issuer.keys.generate('RS256');
  await idp.start(0, '127.0.0.1');
  const claims = () => ({ ...identity, email_verified: true, name: identity.email });
  idp.service.on(Events.BeforeTokenSigning, (token) => Object.assign(token.payload, claims()));
  idp.service.on(Events.BeforeUserinfo, (res) => { res.body = claims(); });
  server = await createAuthServer({ databaseUrl, issuerUrl: idp.issuer.url, webOrigin: WEB });
});
after(async () => {
  await server?.close();
  await idp.stop();
});

/** Minimal cookie jar keyed by cookie name. */
const jar = () => {
  const cookies = new Map();
  return {
    store(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (value) cookies.set(name, value); else cookies.delete(name);
      }
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
};

async function call(path, { cookies, method = 'GET', body, origin = WEB } = {}) {
  const res = await fetch(new URL(path, server.baseURL), {
    method,
    redirect: 'manual',
    headers: {
      ...(cookies ? { cookie: cookies.header() } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  cookies?.store(res);
  return res;
}

/** Browser-style OIDC round trip from `path` (sign-in or link); returns the final callback. */
async function roundTrip(path, claims, provider, cookies) {
  identity = claims;
  const start = await call(path, {
    cookies, method: 'POST', body: { provider, callbackURL: `${WEB}/` },
  });
  if (start.status !== 200) return { start, done: null };
  const { url } = await start.json();
  const authorize = await fetch(url, { redirect: 'manual' });
  const callback = new URL(authorize.headers.get('location'));
  return { start, done: await call(callback.pathname + callback.search, { cookies }) };
}

async function signIn(claims, provider = 'google') {
  const cookies = jar();
  const { start, done } = await roundTrip('/api/auth/sign-in/social', claims, provider, cookies);
  assert.equal(start.status, 200, 'sign-in did not start');
  return { cookies, done };
}

const link = (cookies, claims, provider = 'other') =>
  roundTrip('/api/auth/link-social', claims, provider, cookies);

const me = async (cookies) => {
  const res = await call('/api/me', { cookies });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};
const rows = async (sql, params = []) => (await server.pool.query(sql, params)).rows;

function upgrade(cookies) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(server.baseURL);
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/ws',
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...(cookies ? { cookie: cookies.header() } : {}) },
    });
    req.on('response', (res) => resolve({ status: res.statusCode, userId: res.headers['x-user-id'] }));
    req.on('upgrade', (res) => resolve({ status: res.statusCode }));
    req.on('error', reject);
    req.end();
  });
}

describe('Better Auth spike (Fastify + PostgreSQL + OIDC)', { timeout: 20_000 }, () => {
  it('signs in, issues an HttpOnly SameSite=Lax session cookie and keys the user by subject', async () => {
    const { cookies, done } = await signIn({ sub: 'subject-a', email: 'a@example.test' });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), `${WEB}/`);
    const session = done.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='));
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    const { status, body } = await me(cookies);
    assert.equal(status, 200);
    assert.match(body.userId, /^[0-9a-f-]{36}$/, 'application user id is a uuid, not the subject');
    const accounts = await rows('select "providerId", "accountId", "userId" from auth_account where "accountId" = $1', ['subject-a']);
    assert.deepEqual(accounts, [{ providerId: 'google', accountId: 'subject-a', userId: body.userId }]);
  });

  it('returns the same user for the same subject even after the email changes', async () => {
    const first = await me((await signIn({ sub: 'subject-b', email: 'b-old@example.test' })).cookies);
    const second = await me((await signIn({ sub: 'subject-b', email: 'b-new@example.test' })).cookies);
    assert.equal(second.body.userId, first.body.userId);
    assert.equal((await rows('select count(*)::int as n from auth_account where "accountId" = $1', ['subject-b']))[0].n, 1);
  });

  it('never merges a different subject into an existing user because the email matches', async () => {
    const owner = await me((await signIn({ sub: 'subject-c', email: 'shared@example.test' })).cookies);
    const usersBefore = (await rows('select count(*)::int as n from auth_user'))[0].n;
    const { cookies, done } = await signIn({ sub: 'subject-intruder', email: 'shared@example.test' });
    const intruder = await me(cookies);
    assert.notEqual(intruder.body?.userId, owner.body.userId, 'must not sign in as the existing user');
    const linked = await rows('select "userId" from auth_account where "accountId" = $1', ['subject-intruder']);
    assert.ok(linked.every((r) => r.userId !== owner.body.userId), 'no account row linked to the owner');
    console.log('SAME_EMAIL_OUTCOME', JSON.stringify({
      status: done.status, location: done.headers.get('location'), session: intruder.status,
      usersAdded: (await rows('select count(*)::int as n from auth_user'))[0].n - usersBefore,
    }));
  });

  it('keeps no provider tokens for the login account', async () => {
    const [account] = await rows(
      'select "accessToken", "idToken", "refreshToken", "scope" from auth_account where "accountId" = $1', ['subject-a']);
    assert.deepEqual(
      { access: account.accessToken, id: account.idToken, refresh: account.refreshToken },
      { access: null, id: null, refresh: null },
    );
  });

  it('creates one user when the same new subject signs in twice concurrently', async () => {
    const results = await Promise.allSettled([
      signIn({ sub: 'subject-race', email: 'race@example.test' }),
      signIn({ sub: 'subject-race', email: 'race@example.test' }),
    ]);
    const accounts = await rows('select "userId" from auth_account where "accountId" = $1', ['subject-race']);
    const users = await rows(`select id from auth_user where email = 'race@example.test'`);
    console.log('RACE_OUTCOME', JSON.stringify({
      fulfilled: results.filter((r) => r.status === 'fulfilled').length,
      statuses: results.map((r) => r.value?.done.status),
      accounts: accounts.length, users: users.length,
    }));
    assert.equal(accounts.length, 1);
    assert.equal(users.length, 1);
  });

  it('authenticates a WebSocket upgrade with the session cookie and rejects it without', async () => {
    const { cookies } = await signIn({ sub: 'subject-d', email: 'd@example.test' });
    const { body } = await me(cookies);
    assert.deepEqual(await upgrade(cookies), { status: 418, userId: body.userId });
    assert.equal((await upgrade(undefined)).status, 401);
  });

  it('stops accepting the session on HTTP and WebSocket after sign-out', async () => {
    const { cookies } = await signIn({ sub: 'subject-e', email: 'e@example.test' });
    const copied = cookies.header();
    const res = await call('/api/auth/sign-out', { cookies, method: 'POST', body: {} });
    assert.equal(res.status, 200);
    const replay = { header: () => copied, store() {} };
    assert.equal((await me(replay)).status, 401, 'a copied cookie must die with the session row');
    assert.equal((await upgrade(replay)).status, 401);
  });

  it('rejects state-changing auth calls from an untrusted origin', async () => {
    const { cookies } = await signIn({ sub: 'subject-f', email: 'f@example.test' });
    const forged = await call('/api/auth/sign-out', { cookies, method: 'POST', body: {}, origin: 'https://evil.example' });
    assert.equal(forged.status, 403);
    assert.equal((await me(cookies)).status, 200, 'the session survives the forged request');
    const forgedStart = await call('/api/auth/sign-in/social', {
      method: 'POST', body: { provider: 'google', callbackURL: 'https://evil.example/' },
    });
    assert.notEqual(forgedStart.status, 200, 'callback to an untrusted origin must be refused');
  });

  it('lets a signed-in user attach a second provider, then sign in with either', async () => {
    const { cookies } = await signIn({ sub: 'subject-h', email: 'h@example.test' });
    const owner = (await me(cookies)).body.userId;
    const { done } = await link(cookies, { sub: 'other-h', email: 'h-elsewhere@example.test' });
    assert.equal(done.status, 302);
    const accounts = await rows('select "providerId", "accountId" from auth_account where "userId" = $1 order by "providerId"', [owner]);
    assert.deepEqual(accounts.map((a) => `${a.providerId}:${a.accountId}`), ['google:subject-h', 'other:other-h']);
    const viaOther = await me((await signIn({ sub: 'other-h', email: 'h-elsewhere@example.test' }, 'other')).cookies);
    assert.equal(viaOther.body.userId, owner);
  });

  it('refuses linking without a session or to an identity another user already owns', async () => {
    const anonymous = await link(jar(), { sub: 'other-x', email: 'x@example.test' });
    assert.equal(anonymous.start.status, 401);
    const taken = await me((await signIn({ sub: 'other-taken', email: 'taken@example.test' }, 'other')).cookies);
    const { cookies } = await signIn({ sub: 'subject-i', email: 'i@example.test' });
    const mine = (await me(cookies)).body.userId;
    await link(cookies, { sub: 'other-taken', email: 'taken@example.test' });
    const owner = await rows('select "userId" from auth_account where "providerId" = $1 and "accountId" = $2', ['other', 'other-taken']);
    assert.deepEqual(owner, [{ userId: taken.body.userId }]);
    assert.notEqual(mine, taken.body.userId);
  });

  it('keeps the domain user free of provider and email data', async () => {
    const { cookies } = await signIn({ sub: 'subject-j', email: 'j@example.test' });
    const { body } = await me(cookies);
    const columns = await rows(`select column_name from information_schema.columns where table_name = 'users' order by ordinal_position`);
    assert.deepEqual(columns.map((c) => c.column_name), ['id', 'display_name', 'created_at']);
    const fks = await rows(`select conname from pg_constraint where conrelid = 'users'::regclass and contype = 'f'`);
    assert.deepEqual(fks, [], 'domain users must not depend on auth tables');
    assert.deepEqual(await rows('select id from users where id = $1', [body.userId]), [{ id: body.userId }]);
  });

  it('has a unique key on (providerId, accountId) so one subject cannot map to two users', async () => {
    const indexes = await rows(`select indexdef from pg_indexes where tablename = 'auth_account'`);
    console.log('ACCOUNT_INDEXES', JSON.stringify(indexes.map((r) => r.indexdef)));
    const unique = indexes.some((r) => /UNIQUE/i.test(r.indexdef) && /"providerId"/.test(r.indexdef) && /"accountId"/.test(r.indexdef));
    assert.ok(unique, 'no unique index on (providerId, accountId)');
  });
});

describe('Better Auth spike: session expiry', { timeout: 20_000 }, () => {
  it('rejects the session once expiresIn has passed', async () => {
    const short = await createAuthServer({ databaseUrl, issuerUrl: idp.issuer.url, webOrigin: WEB, sessionSeconds: 2 });
    const original = server;
    server = short;
    try {
      const { cookies } = await signIn({ sub: 'subject-g', email: 'g@example.test' });
      assert.equal((await me(cookies)).status, 200);
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal((await me(cookies)).status, 401);
    } finally {
      server = original;
      await short.close();
    }
  });
});
