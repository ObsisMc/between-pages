import { describe, expect, it, vi } from 'vitest';
import { AuthRequestError, signIn, signOut } from './auth.ts';

describe('signIn', () => {
  it('asks Better Auth for the provider URL with both return addresses', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ url: 'https://idp.example/authorize' }));
    await expect(signIn('dev', 'alice', fetchImpl)).resolves.toBe('https://idp.example/authorize');
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/auth/sign-in/social');
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'dev',
      callbackURL: `${window.location.origin}/`,
      errorCallbackURL: `${window.location.origin}/login`,
      disableRedirect: true,
      loginHint: 'alice',
    });
  });

  it('fails when the server refuses or returns no URL', async () => {
    await expect(
      signIn(
        'google',
        undefined,
        vi.fn(async () => new Response(null, { status: 403 })),
      ),
    ).rejects.toBeInstanceOf(AuthRequestError);
    await expect(
      signIn(
        'google',
        undefined,
        vi.fn(async () => Response.json({})),
      ),
    ).rejects.toBeInstanceOf(AuthRequestError);
  });
});

describe('signOut', () => {
  it('posts to sign-out and fails on an error status', async () => {
    const ok = vi.fn(async () => Response.json({ success: true }));
    await signOut(ok);
    expect(ok).toHaveBeenCalledWith(
      '/api/auth/sign-out',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(
      signOut(vi.fn(async () => new Response(null, { status: 500 }))),
    ).rejects.toBeInstanceOf(AuthRequestError);
  });
});
