// Better Auth's own endpoints. They are not in the contract, so this file is the single
// exception to "call the API only through callApi" (authentication-and-sessions D9).

export type Provider = 'google' | 'dev';

export class AuthRequestError extends Error {}

/**
 * Starts a sign-in and returns the provider URL to send the browser to. Better Auth
 * returns to `/` on success and to `/login?error=<code>` on failure.
 */
export async function signIn(
  provider: Provider,
  loginHint?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const origin = window.location.origin;
  const res = await fetchImpl('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider,
      callbackURL: `${origin}/`,
      errorCallbackURL: `${origin}/login`,
      disableRedirect: true,
      ...(loginHint ? { loginHint } : {}),
    }),
  });
  if (!res.ok) throw new AuthRequestError(`sign-in failed with HTTP ${res.status}`);
  const { url } = (await res.json()) as { url?: string };
  if (!url) throw new AuthRequestError('sign-in returned no provider URL');
  return url;
}

/** Ends the current session; other devices stay signed in. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new AuthRequestError(`sign-out failed with HTTP ${res.status}`);
}
