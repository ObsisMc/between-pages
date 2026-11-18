import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createBackupService, type DriveConfig } from './backup/backup.ts';
import { createDb, type Database } from './db/client.ts';
import { DRIVE_FILE_SCOPE, GOOGLE_ENDPOINTS } from './google/oauth.ts';
import { createBackupStore } from './store/backup.ts';
import { createCopyStore } from './store/copy.ts';
import { createSharedPageService } from './shared-pages/shared-pages.ts';
import { createSpaceRecords } from './space-records/space-records.ts';
import { createSpaceRecordStore } from './store/space-records.ts';
import { createTogetherStore } from './store/together.ts';
import { revokeNext } from './worker/revoke.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Connecting and disconnecting Google Drive through the real router and PostgreSQL
// (server-backup-and-google-docs D9, D10), against a local stand-in for Google's token,
// revoke and Drive `about` endpoints. The stand-in checks PKCE as Google does.

const ORIGIN = 'http://localhost:5173';
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
let google: Server;
let logs = '';

type Grant = { challenge: string; account: { permissionId: string; emailAddress: string } };
const fake = {
  grants: new Map<string, Grant>(), // consent code → grant
  refreshTokens: new Set<string>(),
  revoked: [] as string[],
  failRevoke: false,
  account: { permissionId: 'perm-1', emailAddress: 'ray@example.com' },
};

const form = async (req: IncomingMessage) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
};

function startGoogle(): Promise<string> {
  google = createServer(async (req, res) => {
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/token') {
      const f = await form(req);
      const grant = fake.grants.get(f.get('code') ?? '');
      const verifier = f.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!grant || grant.challenge !== challenge) return json(400, { error: 'invalid_grant' });
      fake.grants.delete(f.get('code')!);
      const refresh = `refresh-SECRET-${randomUUID()}`;
      fake.refreshTokens.add(refresh);
      return json(200, {
        access_token: `access-${grant.account.permissionId}`,
        refresh_token: refresh,
        scope: DRIVE_FILE_SCOPE,
      });
    }
    if (req.url === '/revoke') {
      const token = (await form(req)).get('token') ?? '';
      if (fake.failRevoke) return json(503, { error: 'backend_error' });
      fake.revoked.push(token);
      return json(200, {});
    }
    if (req.url?.startsWith('/drive/about')) {
      const id = (req.headers.authorization ?? '').replace('Bearer access-', '');
      return json(200, { user: { permissionId: id, emailAddress: fake.account.emailAddress } });
    }
    json(404, { error: 'not_found' });
  });
  return new Promise((resolve) =>
    google.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(google.address() as { port: number }).port}`),
    ),
  );
}

let drive: DriveConfig;
beforeAll(async () => {
  if (!testDatabaseUrl) return;
  const base = await startGoogle();
  drive = {
    client: {
      clientId: 'client-id',
      clientSecret: 'client-SECRET',
      redirectUri: `${ORIGIN}/backup/google/callback`,
      endpoints: {
        ...GOOGLE_ENDPOINTS,
        token: `${base}/token`,
        revoke: `${base}/revoke`,
        drive: `${base}/drive`,
      },
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
    logger: {
      level: 'trace',
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs += chunk;
          done();
        },
      }),
    },
  });
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  google?.close();
});
beforeEach(() => {
  fake.failRevoke = false;
  fake.account = { permissionId: `perm-${randomUUID()}`, emailAddress: 'ray@example.com' };
});

type Person = { id: string; cookie: string };
const post = (who: Person, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const status = async (who: Person) =>
  routes.backup.response.parse(
    (
      await app.inject({ method: 'GET', url: routes.backup.path, headers: { cookie: who.cookie } })
    ).json(),
  ).backup;

/** Starts, has the fake Google consent, and returns what the browser would bring back. */
async function consent(who: Person) {
  const started = await post(who, routes.startGoogleConnection.path);
  expect(started.statusCode).toBe(200);
  const url = new URL(routes.startGoogleConnection.response.parse(started.json()).url);
  const code = `code-${randomUUID()}`;
  fake.grants.set(code, {
    challenge: url.searchParams.get('code_challenge')!,
    account: fake.account,
  });
  return { url, code, state: url.searchParams.get('state')! };
}

async function connect(who: Person) {
  const { code, state } = await consent(who);
  return post(who, routes.finishGoogleConnection.path, { code, state });
}

const bodiesOf = async (...responses: { body: string }[]) =>
  responses.map((r) => r.body).join('\n');

describe.runIf(testDatabaseUrl)('Google Drive connection', () => {
  it('[adr:server-backup-and-google-docs#13] asks only for drive.file, offline, with state and an S256 PKCE challenge', async () => {
    const ray = await sessions.signIn('Ray');
    const { url } = await consent(ray);
    expect(url.origin + url.pathname).toBe(GOOGLE_ENDPOINTS.authorize);
    expect(url.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/backup/google/callback`);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
  });

  it('[adr:server-backup-and-google-docs#13] connects the account the grant belongs to, for the user who started it', async () => {
    const ray = await sessions.signIn('Ray');
    const finished = await connect(ray);
    expect(finished.statusCode).toBe(200);
    expect(
      routes.finishGoogleConnection.response.parse(finished.json()).backup.google,
    ).toMatchObject({
      state: 'connected',
      email: 'ray@example.com',
    });
    const [row] = await query<{ google_user_id: string }>(
      'select google_user_id from google_connections where user_id = $1',
      [ray.id],
    );
    expect(row!.google_user_id).toBe(fake.account.permissionId);
  });

  it('[adr:server-backup-and-google-docs#13] refuses a state started by someone else, reused or unknown', async () => {
    const ray = await sessions.signIn('Ray');
    const other = await sessions.signIn('Other');
    const { code, state } = await consent(ray);

    const stolen = await post(other, routes.finishGoogleConnection.path, { code, state });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error.code).toBe('GOOGLE_STATE_INVALID');
    // The state was used up by the refused attempt, so the real owner must start again.
    const reused = await post(ray, routes.finishGoogleConnection.path, { code, state });
    expect(reused.json().error.code).toBe('GOOGLE_STATE_INVALID');
    const unknown = await post(ray, routes.finishGoogleConnection.path, {
      code,
      state: 'made-up-state',
    });
    expect(unknown.json().error.code).toBe('GOOGLE_STATE_INVALID');
    expect((await status(other)).google.state).toBe('disconnected');
  });

  it('refuses a code Google does not accept, keeping the caller disconnected', async () => {
    const ray = await sessions.signIn('Ray');
    const { state } = await consent(ray);
    const refused = await post(ray, routes.finishGoogleConnection.path, {
      code: 'wrong-code',
      state,
    });
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error.code).toBe('GOOGLE_EXCHANGE_FAILED');
    expect((await status(ray)).google.state).toBe('disconnected');
  });

  it('[adr:server-backup-and-google-docs#11] stores the refresh token only as ciphertext and never shows it in responses or logs', async () => {
    const ray = await sessions.signIn('Ray');
    const { code, state } = await consent(ray);
    const before = new Set(fake.refreshTokens);
    const finished = await post(ray, routes.finishGoogleConnection.path, { code, state });
    const token = [...fake.refreshTokens].find((t) => !before.has(t))!;
    const page = await app.inject({
      method: 'GET',
      url: routes.backup.path,
      headers: { cookie: ray.cookie },
    });

    const [row] = await query<{ refresh_token: Buffer }>(
      'select refresh_token from google_connections where user_id = $1',
      [ray.id],
    );
    expect(row!.refresh_token.includes(Buffer.from(token))).toBe(false);
    const seen = (await bodiesOf(finished, page)) + logs;
    for (const secret of [
      token,
      code,
      state,
      'client-SECRET',
      `access-${fake.account.permissionId}`,
    ]) {
      expect(seen).not.toContain(secret);
    }
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('[adr:server-backup-and-google-docs#11] opens tokens only in the worker', async () => {
    const src = fileURLToPath(new URL('.', import.meta.url));
    const files = (await readdir(src, { recursive: true })).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    const opening: string[] = [];
    for (const file of files) {
      if (file.startsWith('worker/') || file === 'google/tokens.ts') continue;
      if ((await readFile(join(src, file), 'utf8')).includes('openToken')) opening.push(file);
    }
    expect(opening).toEqual([]);
  });

  it('[adr:server-backup-and-google-docs#12] disconnecting revokes the grant at Google and deletes the ciphertext', async () => {
    const ray = await sessions.signIn('Ray');
    await connect(ray);
    const token = [...fake.refreshTokens].at(-1)!;
    const disconnected = await post(ray, routes.disconnectGoogle.path);
    expect(routes.disconnectGoogle.response.parse(disconnected.json()).backup.google.state).toBe(
      'disconnecting',
    );
    // Connecting again must wait: a later revoke would end the new grant too.
    expect((await post(ray, routes.startGoogleConnection.path)).json().error.code).toBe(
      'GOOGLE_DISCONNECTING',
    );

    const store = createBackupStore(database.db);
    while (await revokeNext(store, drive)) {
      /* drain */
    }
    expect(fake.revoked).toContain(token);
    expect(await query('select 1 from google_connections where user_id = $1', [ray.id])).toEqual(
      [],
    );
    expect((await status(ray)).google.state).toBe('disconnected');
    expect((await connect(ray)).statusCode).toBe(200);
  });

  it('[adr:server-backup-and-google-docs#12] gives up after a day of failures and asks the user to remove access by hand', async () => {
    const ray = await sessions.signIn('Ray');
    await connect(ray);
    await post(ray, routes.disconnectGoogle.path);
    fake.failRevoke = true;
    const store = createBackupStore(database.db);
    await revokeNext(store, drive);
    expect((await status(ray)).google).toMatchObject({ state: 'disconnecting', retrying: true });
    for (let attempt = 0; attempt < 30; attempt++) {
      await query(
        "update google_connections set next_attempt_at = now() - interval '1 second' where user_id = $1",
        [ray.id],
      );
      await revokeNext(store, drive);
    }
    expect(await query('select 1 from google_connections where user_id = $1', [ray.id])).toEqual(
      [],
    );
    expect((await status(ray)).events.map((e) => e.kind)).toEqual(['revoke_failed']);
  });

  it('[adr:server-backup-and-google-docs#14] shows each person only their own connection', async () => {
    const ray = await sessions.signIn('Ray');
    const partner = await sessions.signIn('Partner');
    await connect(ray);
    expect((await status(partner)).google).toEqual({
      state: 'disconnected',
      email: null,
      connectedAt: null,
      expiresAt: null,
      retrying: false,
    });
  });

  it('asks to reconnect when the token key changed or a Testing grant is past seven days', async () => {
    const ray = await sessions.signIn('Ray');
    await connect(ray);
    const testing = createBackupService(
      createBackupStore(database.db),
      createCopyStore(database.db),
      createTogetherStore(database.db),
      createSharedPageService(createSpaceRecords(createSpaceRecordStore(database.db))),
      {
        ...drive,
        testing: true,
      },
    );
    const day6 = await testing.status(ray.id, new Date(Date.now() + 6 * 24 * 3600_000));
    expect(day6.google.state).toBe('connected');
    expect(day6.google.expiresAt).not.toBeNull();
    expect(
      (await testing.status(ray.id, new Date(Date.now() + 8 * 24 * 3600_000))).google.state,
    ).toBe('reconnect');

    await query("update google_connections set key_id = 'another-key' where user_id = $1", [
      ray.id,
    ]);
    expect((await status(ray)).google.state).toBe('reconnect');
  });
});

describe.runIf(testDatabaseUrl)('without Google configured', () => {
  it('says unavailable and refuses to start', async () => {
    const plain = await buildApp({
      publicOrigin: ORIGIN,
      currentUser: sessions.currentUser,
      db: database.db,
    });
    const ray = await sessions.signIn('Ray');
    const started = await plain.inject({
      method: 'POST',
      url: routes.startGoogleConnection.path,
      headers: { origin: ORIGIN, cookie: ray.cookie },
      payload: {},
    });
    expect(started.json().error.code).toBe('GOOGLE_UNAVAILABLE');
    const page = await plain.inject({
      method: 'GET',
      url: routes.backup.path,
      headers: { cookie: ray.cookie },
    });
    expect(page.json().backup.google.state).toBe('unavailable');
    await plain.close();
  });
});
