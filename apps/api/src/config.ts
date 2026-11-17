import { z } from 'zod';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** An empty value counts as unset, so a template line left as `NAME=` changes nothing. */
const unsetIfEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

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
    /** 32 bytes, base64; seals Drive refresh tokens (server-backup-and-google-docs D10). */
    GOOGLE_TOKEN_KEY: z.base64().optional(),
    /** The Google app is in Testing, so Drive grants expire after seven days (D9). */
    GOOGLE_DRIVE_TESTING: z.enum(['true', 'false']).default('false'),
    /** Resend's API key; without it no reminder is sent (email-reminders 技术设计). */
    RESEND_API_KEY: unsetIfEmpty(z.string()),
    /** The sender, e.g. `Between Pages <remind@mail.ruihaozhang.com>`. */
    MAIL_FROM: unsetIfEmpty(z.string()),
    /** 32 bytes, base64; signs unsubscribe links (D8). */
    MAIL_TOKEN_KEY: unsetIfEmpty(z.base64()),
    /** Tests only: a stand-in for Resend; passed to the SDK, never read by it from the environment. */
    RESEND_BASE_URL: unsetIfEmpty(z.url()),
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
    if (env.GOOGLE_TOKEN_KEY && Buffer.from(env.GOOGLE_TOKEN_KEY, 'base64').length !== 32)
      issue('GOOGLE_TOKEN_KEY', 'must be 32 bytes, base64 (openssl rand -base64 32)');
    if (env.MAIL_TOKEN_KEY && Buffer.from(env.MAIL_TOKEN_KEY, 'base64').length !== 32)
      issue('MAIL_TOKEN_KEY', 'must be 32 bytes, base64 (openssl rand -base64 32)');
    // Every mail carries a working unsubscribe link and a sender (invariant 11).
    if (env.RESEND_API_KEY) {
      if (!env.MAIL_FROM) issue('MAIL_FROM', 'required when RESEND_API_KEY is set');
      if (!env.MAIL_TOKEN_KEY) issue('MAIL_TOKEN_KEY', 'required when RESEND_API_KEY is set');
    }
    // A shorter history rule is a test setting; tying it to the mock login keeps it out of
    // anything real, whose history must follow kernel D6.
    if (env.HISTORY_IDLE_MS !== undefined && env.AUTH_PROVIDER !== 'dev')
      issue('HISTORY_IDLE_MS', 'allowed only with AUTH_PROVIDER=dev');
  });

export type Config = z.infer<typeof Env> & { publicOrigin: string };

/**
 * Drive is available when the Google client and the token key are all set; the client is
 * the same one login uses, whatever AUTH_PROVIDER is.
 */
export const driveEnabled = (config: Config) =>
  Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_TOKEN_KEY);

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
