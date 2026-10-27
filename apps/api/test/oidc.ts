import { createServer } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth/auth.ts';
import { createCurrentUser } from '../src/auth/current-user.ts';
import { parseConfig, type Config } from '../src/config.ts';
import { createDb, type Database } from '../src/db/client.ts';
import { startMockOidc, type DevIdentity, type MockOidc } from '../scripts/dev-oidc.ts';
import { testDatabaseUrl } from './db.ts';

export const WEB_ORIGIN = 'http://localhost:5173';
export const TEST_SECRET = 'test-only-secret-never-used-outside-tests-0123';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

/** Cookie jar over light-my-request responses, keyed by cookie name. */
export class Jar {
  private cookies = new Map<string, string>();
  store(res: LightMyRequestResponse) {
    const header = res.headers['set-cookie'];
    for (const cookie of Array.isArray(header) ? header : header ? [header] : []) {
      const pair = cookie.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  copy() {
    const jar = new Jar();
    jar.cookies = new Map(this.cookies);
    return jar;
  }
}

export interface Harness {
  app: FastifyInstance;
  database: Database;
  config: Config;
  oidc: MockOidc;
  /** Lets a test change the identity the mock issues, e.g. a new email for one subject. */
  customize: (identity: DevIdentity) => DevIdentity;
  /** Lines the API logged, for secret-leak checks. */
  logs: string[];
  close(): Promise<void>;
}

// Real app, real Better Auth, real PostgreSQL, mock OIDC issuer: the same `dev` path the
// local login uses (authentication-and-sessions D11).
export async function startHarness(): Promise<Harness> {
  const issuer = `http://127.0.0.1:${await freePort()}`;
  const harness = { customize: (identity: DevIdentity) => identity, logs: [] as string[] };
  const oidc = await startMockOidc(issuer, (identity) => harness.customize(identity));
  const config = parseConfig({
    DATABASE_URL: testDatabaseUrl,
    PUBLIC_ORIGIN: WEB_ORIGIN,
    BETTER_AUTH_SECRET: TEST_SECRET,
    AUTH_PROVIDER: 'dev',
    DEV_OIDC_ISSUER: issuer,
  });
  const database = createDb(config.DATABASE_URL);
  const auth = createAuth(config, database.db);
  const app = await buildApp({
    publicOrigin: config.publicOrigin,
    currentUser: createCurrentUser(auth, database.db),
    db: database.db,
    authHandler: (request) => auth.handler(request),
    sessionEnded: (listener) => auth.onSessionEnded(listener),
    logger: { level: 'debug', stream: { write: (line: string) => harness.logs.push(line) } },
  });
  return Object.assign(harness, {
    app,
    database,
    config,
    oidc,
    async close() {
      await app.close();
      await database.close();
      await oidc.stop();
    },
  });
}

export interface RoundTrip {
  /** Status of the POST that starts the flow. */
  startStatus: number;
  /** The provider authorization URL, when the flow started. */
  authorizeUrl?: URL | undefined;
  /** Where the final callback redirected the browser. */
  location?: string | undefined;
}

/** Browser-style round trip: start (sign-in or link), visit the issuer, follow the callback. */
export async function roundTrip(
  h: Harness,
  path: '/api/auth/sign-in/social' | '/api/auth/link-social',
  name: string,
  jar: Jar,
): Promise<RoundTrip> {
  const start = await h.app.inject({
    method: 'POST',
    url: path,
    headers: { origin: WEB_ORIGIN, cookie: jar.header() },
    payload: {
      provider: 'dev',
      callbackURL: `${WEB_ORIGIN}/`,
      errorCallbackURL: `${WEB_ORIGIN}/login`,
      disableRedirect: true,
      loginHint: name,
    },
  });
  jar.store(start);
  if (start.statusCode !== 200) return { startStatus: start.statusCode };
  const authorizeUrl = new URL((start.json() as { url: string }).url);
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const callback = new URL(authorize.headers.get('location')!);
  const done = await h.app.inject({
    method: 'GET',
    url: callback.pathname + callback.search,
    headers: { cookie: jar.header() },
  });
  jar.store(done);
  return {
    startStatus: start.statusCode,
    authorizeUrl,
    location: done.headers.location as string | undefined,
  };
}

export async function signIn(h: Harness, name: string) {
  const jar = new Jar();
  const trip = await roundTrip(h, '/api/auth/sign-in/social', name, jar);
  return { jar, ...trip };
}

export async function me(h: Harness, jar: Jar) {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: jar.header() },
  });
  return {
    status: res.statusCode,
    user:
      res.statusCode === 200
        ? (res.json() as { user: { id: string; displayName: string } }).user
        : null,
  };
}

/** The app configured for real Google (no network needed to build the authorization URL). */
export async function startGoogleApp() {
  const config = parseConfig({
    DATABASE_URL: testDatabaseUrl,
    PUBLIC_ORIGIN: WEB_ORIGIN,
    BETTER_AUTH_SECRET: TEST_SECRET,
    AUTH_PROVIDER: 'google',
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-only-client-secret',
  });
  const database = createDb(config.DATABASE_URL);
  const auth = createAuth(config, database.db);
  const app = await buildApp({
    publicOrigin: config.publicOrigin,
    currentUser: createCurrentUser(auth, database.db),
    db: database.db,
    authHandler: (request) => auth.handler(request),
  });
  return {
    app,
    async close() {
      await app.close();
      await database.close();
    },
  };
}
