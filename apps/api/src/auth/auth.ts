import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import * as authSchema from '../db/auth-schema.ts';

const DAY = 60 * 60 * 24;
const LOGIN_SCOPES = ['openid', 'email', 'profile'];
const TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'idToken',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt',
] as const;

// Login needs to know who the user is, nothing more: no provider token is ever stored
// (authentication-and-sessions D5). encryptOAuthTokens stays on as a second line, but it
// leaves the ID token in plain text, so the hook is the real guarantee.
function withoutTokens<T extends Record<string, unknown>>(account: T): { data: T } {
  const data: Record<string, unknown> = { ...account };
  for (const field of TOKEN_FIELDS) if (field in data) data[field] = null;
  return { data: data as T };
}

/**
 * Better Auth for the configured provider (authentication-and-sessions D1, D3, D5, D6).
 * `dev` adds the genericOAuth plugin against the local mock issuer; parseConfig refuses
 * that outside localhost and in production, so no plugin runs in a real deployment.
 */
export function createAuth(config: Config, db: Db) {
  const origin = config.publicOrigin;
  return betterAuth({
    baseURL: origin,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    // transaction: user and account rows of a first sign-in commit together.
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true }),
    trustedOrigins: [origin],
    user: { modelName: 'auth_user' },
    verification: { modelName: 'auth_verification' },
    account: {
      modelName: 'auth_account',
      // Never merge two subjects because their emails match; a signed-in user may still
      // link another login explicitly. `enabled: false` would block that too.
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true },
      encryptOAuthTokens: true,
    },
    // Database sessions, no cookie cache: sign-out and revocation take effect at once.
    session: { modelName: 'auth_session', expiresIn: 30 * DAY, updateAge: DAY },
    advanced: {
      // Better Auth turns both checks off by default when it detects a test environment
      // (NODE_ENV=test). Pin them on so tests verify what production runs, and a stray
      // NODE_ENV cannot silently drop CSRF protection.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: { generateId: 'uuid' },
      useSecureCookies: new URL(origin).protocol === 'https:',
    },
    onAPIError: { errorURL: `${origin}/login` },
    databaseHooks: {
      account: {
        create: { before: async (account) => withoutTokens(account) },
        update: { before: async (account) => withoutTokens(account) },
      },
    },
    socialProviders:
      config.AUTH_PROVIDER === 'google'
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID!,
              clientSecret: config.GOOGLE_CLIENT_SECRET!,
              scope: LOGIN_SCOPES,
              prompt: 'select_account',
            },
          }
        : {},
    plugins:
      config.AUTH_PROVIDER === 'dev'
        ? [
            genericOAuth({
              config: [
                {
                  providerId: 'dev',
                  clientId: 'between-pages-dev',
                  clientSecret: 'between-pages-dev',
                  discoveryUrl: `${config.DEV_OIDC_ISSUER}/.well-known/openid-configuration`,
                  scopes: LOGIN_SCOPES,
                  pkce: true,
                  requireIdTokenVerification: true,
                },
              ],
            }),
          ]
        : [],
  });
}

export type Auth = ReturnType<typeof createAuth>;
