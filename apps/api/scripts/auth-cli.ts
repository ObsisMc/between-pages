import { parseConfig } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';
import { createAuth } from '../src/auth/auth.ts';

// Entry point for Better Auth's CLI (`npm run auth:generate`), which reads the exported
// `auth` to derive the auth tables. Uses placeholder values: generation opens no
// connection and needs no secret. Both providers' tables are identical.
export const auth = createAuth(
  parseConfig({
    DATABASE_URL: 'postgresql://unused@127.0.0.1/unused',
    PUBLIC_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'schema-generation-only-placeholder-value',
    AUTH_PROVIDER: 'dev',
  }),
  createDb('postgresql://unused@127.0.0.1/unused').db,
);
