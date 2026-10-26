import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeCode, routes, syncSocket } from '@between-pages/contracts';
import { query, testDatabaseUrl } from '../../test/db.ts';
import {
  Jar,
  TEST_SECRET,
  WEB_ORIGIN,
  me,
  roundTrip,
  signIn,
  startGoogleApp,
  startHarness,
  type Harness,
} from '../../test/oidc.ts';

// Full sign-in round trips against real Better Auth, real PostgreSQL and the mock issuer.
// Names are unique per test because files run concurrently against one database.
const unique = (base: string) => `${base}-${randomUUID().slice(0, 8)}`;

let h: Harness;
beforeAll(async () => {
  if (testDatabaseUrl) h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
afterEach(() => {
  if (h) h.customize = (identity) => identity;
});

const accountsOf = (sub: string) =>
  query<{ provider_id: string; account_id: string; user_id: string }>(
    'select provider_id, account_id, user_id from auth_account where account_id = $1',
    [sub],
  );

describe.runIf(testDatabaseUrl)('sign-in', () => {
  it('sets an HttpOnly SameSite=Lax session and creates the domain user on first request', async () => {
    const name = unique('alice');
    const start = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: { origin: WEB_ORIGIN },
      payload: {
        provider: 'dev',
        callbackURL: `${WEB_ORIGIN}/`,
        disableRedirect: true,
        loginHint: name,
      },
    });
    expect(start.statusCode).toBe(200);
    const { jar, location } = await signIn(h, name);
    expect(location).toBe(`${WEB_ORIGIN}/`);
    expect(jar.header()).toContain('better-auth.session_token=');
    const { status, user } = await me(h, jar);
    expect(status).toBe(200);
    expect(user).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), displayName: name });
    const [domain] = await query('select id, display_name from users where id = $1', [user!.id]);
    expect(domain).toEqual({ id: user!.id, display_name: name });
  });

  it('[adr:authentication-and-sessions#2] keeps one user per subject even when the email changes', async () => {
    const name = unique('bob');
    const first = await me(h, (await signIn(h, name)).jar);
    h.customize = (identity) => ({ ...identity, email: `${name}-new@dev.local` });
    const second = await me(h, (await signIn(h, name)).jar);
    expect(second.user!.id).toBe(first.user!.id);
    expect(await accountsOf(`dev-${name}`)).toHaveLength(1);
  });

  it('[adr:authentication-and-sessions#2] creates one user when one new subject signs in twice at once', async () => {
    const name = unique('race');
    await Promise.allSettled([signIn(h, name), signIn(h, name)]);
    const accounts = await accountsOf(`dev-${name}`);
    expect(accounts).toHaveLength(1);
    const users = await query('select id from auth_user where id = $1', [accounts[0]!.user_id]);
    expect(users).toHaveLength(1);
  });

  it('[adr:authentication-and-sessions#3] refuses a different subject with an existing email', async () => {
    const name = unique('carol');
    const owner = await me(h, (await signIn(h, name)).jar);
    const countUsers = async () =>
      (await query<{ count: number }>('select count(*)::int as count from auth_user'))[0]!.count;
    const before = await countUsers();
    const intruder = await signIn(h, `${name}#2`);
    expect(intruder.location).toBe(`${WEB_ORIGIN}/login?error=account_not_linked`);
    expect((await me(h, intruder.jar)).status).toBe(401);
    expect(await accountsOf(`dev-${name}#2`)).toEqual([]);
    expect(await countUsers()).toBe(before);
    expect((await me(h, (await signIn(h, name)).jar)).user!.id).toBe(owner.user!.id);
  });

  it('[adr:authentication-and-sessions#5] stores no provider tokens and asks only for basic identity', async () => {
    const name = unique('dave');
    const { authorizeUrl } = await signIn(h, name);
    expect(authorizeUrl!.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
    const [account] = await query(
      'select access_token, refresh_token, id_token, access_token_expires_at from auth_account where account_id = $1',
      [`dev-${name}`],
    );
    expect(account).toEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
    });
  });

  it('writes the user and its login identity in one transaction', async () => {
    const name = unique('boom');
    // A failing account insert must not leave an orphan auth_user behind.
    await query(`create or replace function bp_test_fail_account() returns trigger as $$
      begin if new.account_id like 'dev-boom-%' then raise exception 'planted failure'; end if; return new; end
      $$ language plpgsql`);
    await query(`create or replace trigger bp_test_fail_account before insert on auth_account
      for each row execute function bp_test_fail_account()`);
    try {
      const { location } = await signIn(h, name);
      expect(location).toContain('/login?error=');
      expect(
        await query('select id from auth_user where email = $1', [`${name}@dev.local`]),
      ).toEqual([]);
    } finally {
      await query('drop trigger if exists bp_test_fail_account on auth_account');
      await query('drop function if exists bp_test_fail_account()');
    }
  });
});

describe.runIf(testDatabaseUrl)('linking', () => {
  it('[adr:authentication-and-sessions#4] links another login only while signed in', async () => {
    const name = unique('erin');
    const { jar } = await signIn(h, name);
    const owner = (await me(h, jar)).user!.id;
    const other = unique('erin-alt');
    const linked = await roundTrip(h, '/api/auth/link-social', other, jar);
    expect(linked.location).toBe(`${WEB_ORIGIN}/`);
    expect((await accountsOf(`dev-${other}`)).map((a) => a.user_id)).toEqual([owner]);
    expect((await me(h, (await signIn(h, other)).jar)).user!.id).toBe(owner);

    const anonymous = await roundTrip(h, '/api/auth/link-social', unique('nobody'), new Jar());
    expect(anonymous.startStatus).toBe(401);
  });

  it("[adr:authentication-and-sessions#4] cannot take over another user's login identity", async () => {
    const taken = unique('frank');
    const owner = (await me(h, (await signIn(h, taken)).jar)).user!.id;
    const { jar } = await signIn(h, unique('grace'));
    await roundTrip(h, '/api/auth/link-social', taken, jar);
    expect((await accountsOf(`dev-${taken}`)).map((a) => a.user_id)).toEqual([owner]);
  });
});

describe.runIf(testDatabaseUrl)('sessions', () => {
  it('[adr:authentication-and-sessions#6] invalidates a copied cookie on sign-out', async () => {
    const { jar } = await signIn(h, unique('heidi'));
    const copied = jar.copy();
    const out = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: WEB_ORIGIN, cookie: jar.header() },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect((await me(h, copied)).status).toBe(401);
  });

  it('[adr:authentication-and-sessions#7] keeps a session alive when sign-out comes from another origin', async () => {
    const { jar } = await signIn(h, unique('ivan'));
    const forged = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: 'https://evil.example', cookie: jar.header() },
      payload: {},
    });
    expect(forged.statusCode).toBe(403);
    expect((await me(h, jar)).status).toBe(200);
  });

  it('[adr:authentication-and-sessions#6] [adr:authentication-and-sessions#8] ends socket writes and handshakes with the session', async () => {
    const { jar } = await signIn(h, unique('lena'));
    const opened = await h.app.inject({
      method: 'POST',
      url: routes.openDiary.path,
      headers: { origin: WEB_ORIGIN, cookie: jar.header() },
      payload: { timezone: 'Asia/Shanghai' },
    });
    const { diary } = routes.openDiary.response.parse(opened.json());
    const upgrade = { headers: { origin: WEB_ORIGIN, cookie: jar.header() } };
    const socket = await h.app.injectWS(syncSocket.path, upgrade);
    const closed = new Promise<number>((resolve) => socket.on('close', resolve));

    await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: WEB_ORIGIN, cookie: jar.header() },
      payload: {},
    });
    socket.send(
      JSON.stringify({
        v: 1,
        type: 'submit',
        diaryId: diary.diaryId,
        batchId: randomUUID(),
        generationId: diary.generationId,
        operations: [
          { operationId: randomUUID(), update: 'AAA=', writtenAt: new Date().toISOString() },
        ],
      }),
    );

    expect(await closed).toBe(closeCode.UNAUTHENTICATED);
    await expect(h.app.injectWS(syncSocket.path, upgrade)).rejects.toThrow('401');
    expect(await query('select 1 from diary_commits where diary_id = $1', [diary.diaryId])).toEqual(
      [],
    );
  });

  it('writes last_seen_at at most once per interval', async () => {
    const { jar } = await signIn(h, unique('judy'));
    const id = (await me(h, jar)).user!.id;
    const row = async () =>
      (
        await query<{ last_seen_at: Date; version: string }>(
          'select last_seen_at, xmin::text as version from users where id = $1',
          [id],
        )
      )[0]!;
    const first = await row();
    await me(h, jar);
    expect(await row()).toEqual(first);
    await query(`update users set last_seen_at = now() - interval '10 minutes' where id = $1`, [
      id,
    ]);
    const stale = await row();
    await me(h, jar);
    expect((await row()).last_seen_at.getTime()).toBeGreaterThan(stale.last_seen_at.getTime());
  });
});

describe.runIf(testDatabaseUrl)('secrets', () => {
  it('[adr:authentication-and-sessions#11] never logs the auth secret and keeps .env out of git', async () => {
    const printed: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      }),
    );
    try {
      const name = unique('kim');
      const { jar } = await signIn(h, name);
      await signIn(h, `${name}#2`); // an error path too
      await me(h, jar);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const everything = [...h.logs, ...printed].join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    expect(everything).not.toContain(TEST_SECRET);
    expect(() => execFileSync('git', ['check-ignore', '-q', '.env'])).not.toThrow();
  });
});

describe.runIf(testDatabaseUrl)('google provider', () => {
  it('[adr:authentication-and-sessions#5] asks Google only for basic identity, each scope once', async () => {
    const google = await startGoogleApp();
    try {
      const start = await google.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: { origin: WEB_ORIGIN },
        payload: { provider: 'google', callbackURL: `${WEB_ORIGIN}/`, disableRedirect: true },
      });
      expect(start.statusCode).toBe(200);
      const url = new URL((start.json() as { url: string }).url);
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('redirect_uri')).toBe(`${WEB_ORIGIN}/api/auth/callback/google`);
      expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([
        'email',
        'openid',
        'profile',
      ]);
    } finally {
      await google.close();
    }
  });
});
