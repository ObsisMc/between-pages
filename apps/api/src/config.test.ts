import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config.ts';

const local = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:54320/db',
  PUBLIC_ORIGIN: 'http://localhost:5173/',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  AUTH_PROVIDER: 'dev',
};

describe('parseConfig', () => {
  it('accepts the local development configuration and normalizes the origin', () => {
    const config = parseConfig(local);
    expect(config.publicOrigin).toBe('http://localhost:5173');
    expect(config.DEV_OIDC_ISSUER).toBe('http://127.0.0.1:4010');
    expect(config.PORT).toBe(3000);
  });

  it('[adr:authentication-and-sessions#12] refuses development login in production', () => {
    expect(() => parseConfig({ ...local, NODE_ENV: 'production' })).toThrow(/dev is not allowed/);
  });

  it('takes a shorter history idle time only alongside development login', () => {
    expect(parseConfig({ ...local, HISTORY_IDLE_MS: '3000' }).HISTORY_IDLE_MS).toBe(3000);
    expect(() =>
      parseConfig({
        ...local,
        AUTH_PROVIDER: 'google',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        HISTORY_IDLE_MS: '3000',
      }),
    ).toThrow(/HISTORY_IDLE_MS: allowed only with AUTH_PROVIDER=dev/);
  });

  it('[adr:authentication-and-sessions#12] refuses development login on a non-local origin', () => {
    expect(() => parseConfig({ ...local, PUBLIC_ORIGIN: 'https://between-pages.example' })).toThrow(
      /localhost or 127.0.0.1/,
    );
  });

  const messageOf = (env: Record<string, string>) => {
    try {
      parseConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error('expected parseConfig to throw');
  };

  it('names every missing or invalid variable', () => {
    const message = messageOf({ AUTH_PROVIDER: 'google', BETTER_AUTH_SECRET: 'short' });
    for (const name of ['DATABASE_URL', 'PUBLIC_ORIGIN', 'BETTER_AUTH_SECRET'])
      expect(message).toContain(name);
  });

  it('requires the Google credentials when the provider is Google', () => {
    const message = messageOf({ ...local, AUTH_PROVIDER: 'google' });
    for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
      expect(message).toContain(name);
  });

  it('accepts Google with its credentials on https', () => {
    const config = parseConfig({
      ...local,
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://between-pages.example',
      AUTH_PROVIDER: 'google',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    expect(config.AUTH_PROVIDER).toBe('google');
  });
});
