import { z } from 'zod';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const Env = z
  .object({
    NODE_ENV: z.string().default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    PUBLIC_ORIGIN: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    AUTH_PROVIDER: z.enum(['google', 'dev']),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    DEV_OIDC_ISSUER: z.url().default('http://127.0.0.1:4010'),
    /** End-to-end tests only: closes history points sooner than the two-minute rule. */
    HISTORY_IDLE_MS: z.coerce.number().int().positive().optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.AUTH_PROVIDER === 'google') {
      if (!env.GOOGLE_CLIENT_ID) issue('GOOGLE_CLIENT_ID', 'required when AUTH_PROVIDER=google');
      if (!env.GOOGLE_CLIENT_SECRET)
        issue('GOOGLE_CLIENT_SECRET', 'required when AUTH_PROVIDER=google');
    }
    // Development login is a mock identity provider; it must never be reachable from a
    // real deployment (authentication-and-sessions D11, invariant 12).
    if (env.AUTH_PROVIDER === 'dev') {
      if (env.NODE_ENV === 'production') issue('AUTH_PROVIDER', 'dev is not allowed in production');
      if (!LOCAL_HOSTS.has(new URL(env.PUBLIC_ORIGIN).hostname))
        issue('AUTH_PROVIDER', 'dev requires PUBLIC_ORIGIN on localhost or 127.0.0.1');
    }
    // A shorter history rule is a test setting; tying it to the mock login keeps it out of
    // anything real, whose history must follow kernel D6.
    if (env.HISTORY_IDLE_MS !== undefined && env.AUTH_PROVIDER !== 'dev')
      issue('HISTORY_IDLE_MS', 'allowed only with AUTH_PROVIDER=dev');
  });

export type Config = z.infer<typeof Env> & { publicOrigin: string };

export class ConfigError extends Error {}

/** Parses the environment once at startup; throws ConfigError naming every bad variable. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = Env.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  // Origins have no trailing slash; browsers send them that way in the Origin header.
  return { ...result.data, publicOrigin: new URL(result.data.PUBLIC_ORIGIN).origin };
}
