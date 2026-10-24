import { createServer } from 'node:net';
import Fastify from 'fastify';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';

// Spike: Better Auth mounted in Fastify, PostgreSQL storage, an OIDC provider standing
// in for Google. Production would use socialProviders.google instead of genericOAuth;
// both create users and accounts through the same Better Auth sign-in path.
export async function createAuthServer({ databaseUrl, issuerUrl, webOrigin, sessionSeconds = 3600 }) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const app = Fastify();
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;

  const auth = betterAuth({
    baseURL,
    basePath: '/api/auth',
    secret: 'spike-only-secret-not-a-deployment-value-0123456789',
    database: pool,
    trustedOrigins: [webOrigin],
    // Auth tables are namespaced; the app's own `users` table (below) is the domain model.
    user: { modelName: 'auth_user' },
    verification: { modelName: 'auth_verification' },
    // Identity is the provider subject. Never merge two subjects because emails match
    // (no implicit linking), but let a signed-in user attach another provider explicitly.
    // `enabled: false` would also block that explicit link.
    account: {
      modelName: 'auth_account',
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true },
      encryptOAuthTokens: true,
    },
    session: {
      modelName: 'auth_session',
      expiresIn: sessionSeconds,
      updateAge: Math.min(sessionSeconds, 86400),
    },
    advanced: { database: { generateId: 'uuid' } },
    // Login needs no Google API access, so keep no provider tokens at all. encryptOAuthTokens
    // covers access/refresh tokens but stores the ID token (email, name) as a plain JWT.
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: withoutTokens(account) }) },
        update: { before: async (account) => ({ data: withoutTokens(account) }) },
      },
    },
    plugins: [
      genericOAuth({
        config: [{
          providerId: 'google',
          clientId: 'spike-client',
          clientSecret: 'spike-secret',
          discoveryUrl: `${issuerUrl}/.well-known/openid-configuration`,
          scopes: ['openid', 'email', 'profile'],
          pkce: true,
          requireIdTokenVerification: true,
        }, {
          // A second OAuth provider, to show identities are not Google-specific.
          providerId: 'other',
          clientId: 'spike-other-client',
          clientSecret: 'spike-other-secret',
          discoveryUrl: `${issuerUrl}/.well-known/openid-configuration`,
          scopes: ['openid', 'email', 'profile'],
          pkce: true,
          requireIdTokenVerification: true,
        }],
      }),
    ],
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  // Better Auth looks accounts up by (providerId, accountId) but creates no unique index,
  // so two concurrent first sign-ins of one subject could create two users.
  await pool.query(
    'create unique index if not exists auth_account_provider_subject_key on auth_account ("providerId", "accountId")',
  );
  // Domain users: what diaries, spaces and authorship reference. No email, no provider, and
  // no foreign key into the auth tables, so the auth layer can change without touching it.
  await pool.query(`create table if not exists users (
    id uuid primary key,
    display_name text not null,
    created_at timestamptz not null default now()
  )`);

  // The one way app code learns who is calling. Creates the domain row on first use, so a
  // failure between "auth user created" and "domain user created" heals on the next request.
  async function currentUser(headers) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) return null;
    const { rows: [user] } = await pool.query(
      `insert into users (id, display_name) values ($1, $2)
       on conflict (id) do update set id = excluded.id returning id, display_name`,
      [session.user.id, session.user.name || 'Unnamed'],
    );
    return { id: user.id, displayName: user.display_name, email: session.user.email };
  }

  // Official Fastify pattern: hand Better Auth a Web Request, copy its Response back.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const request = new Request(new URL(req.url, baseURL), {
        method: req.method,
        headers: fromNodeHeaders(req.headers),
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
      const response = await auth.handler(request);
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        if (key !== 'set-cookie') reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  // The app's own routes resolve the session from the same cookie.
  app.get('/api/me', async (req, reply) => {
    const user = await currentUser(req.headers);
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED' });
    return { userId: user.id, displayName: user.displayName, email: user.email };
  });

  // WebSocket upgrade authenticated by the session cookie before the socket is accepted.
  app.server.on('upgrade', async (req, socket) => {
    const user = await currentUser(req.headers);
    if (!user) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.end(`HTTP/1.1 418 Spike-Accepted\r\nX-User-Id: ${user.id}\r\nConnection: close\r\n\r\n`);
  });

  await app.listen({ port, host: '127.0.0.1' });
  return {
    app, auth, pool, baseURL,
    async close() { await app.close(); await pool.end(); },
  };
}

// Better Auth needs its public baseURL before Fastify can listen, and Fastify cannot add
// routes after listening, so reserve a port first.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt'];
function withoutTokens(account) {
  const copy = { ...account };
  for (const field of TOKEN_FIELDS) if (field in copy) copy[field] = null;
  return copy;
}
