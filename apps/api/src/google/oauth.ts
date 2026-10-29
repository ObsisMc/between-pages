import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// Google's OAuth and Drive REST calls for the Drive connection (server-backup-and-google-docs
// D10). Plain fetch, no SDK; every response is validated where it enters the process. The
// only scope is drive.file (invariant 13); the account is identified through Drive itself.

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export type GoogleEndpoints = {
  authorize: string;
  token: string;
  revoke: string;
  drive: string;
  docs: string;
};

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
  docs: 'https://docs.googleapis.com/v1',
};

export type GoogleClient = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  endpoints: GoogleEndpoints;
};

/**
 * A Google refusal; `code` is Google's `error` field (e.g. invalid_grant), the API error's
 * first reason (e.g. storageQuotaExceeded) or the HTTP status. `retryAfterMs` is Google's
 * `Retry-After` when it sent one.
 */
export class GoogleError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(status: number, code: string, retryAfterMs: number | null = null) {
    super(`Google answered ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** A fresh state and PKCE pair (RFC 7636, S256). */
export function newAuthorization() {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { state, codeVerifier, codeChallenge };
}

export const stateSha256 = (state: string) => createHash('sha256').update(state).digest();

export function authorizationUrl(
  client: GoogleClient,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(client.endpoints.authorize);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: DRIVE_FILE_SCOPE,
    access_type: 'offline',
    // Always ask, so Google returns a refresh token even for an account that consented before.
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
const ErrorResponse = z.object({ error: z.string() }).loose();

async function post(url: string, form: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const parsed = ErrorResponse.safeParse(body);
    throw new GoogleError(
      response.status,
      parsed.success ? parsed.data.error : String(response.status),
    );
  }
  return body;
}

/** Exchanges the consent code; refuses a grant without a refresh token or without drive.file. */
export async function exchangeCode(client: GoogleClient, code: string, codeVerifier: string) {
  const tokens = TokenResponse.parse(
    await post(client.endpoints.token, {
      code,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
    }),
  );
  if (!tokens.refresh_token) throw new GoogleError(200, 'no_refresh_token');
  if (tokens.scope && !tokens.scope.split(' ').includes(DRIVE_FILE_SCOPE)) {
    throw new GoogleError(200, 'scope_not_granted');
  }
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

/** A short-lived access token; `invalid_grant` means revoked or expired (reconnect). */
export async function accessToken(client: GoogleClient, refreshToken: string): Promise<string> {
  const tokens = TokenResponse.parse(
    await post(client.endpoints.token, {
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
    }),
  );
  return tokens.access_token;
}

/** Revokes the grant; an already invalid token counts as revoked. */
export async function revoke(client: GoogleClient, token: string): Promise<void> {
  try {
    await post(client.endpoints.revoke, { token });
  } catch (error) {
    if (error instanceof GoogleError && error.status === 400 && error.code === 'invalid_token')
      return;
    throw error;
  }
}

const About = z.object({
  user: z.object({ permissionId: z.string().min(1), emailAddress: z.string().min(1) }),
});

/** The Drive account the token belongs to; Drive's `about` needs no scope beyond drive.file. */
export async function driveAccount(client: GoogleClient, token: string) {
  const response = await fetch(
    `${client.endpoints.drive}/about?fields=user(permissionId,emailAddress)`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new GoogleError(response.status, String(response.status));
  const { user } = About.parse(await response.json());
  return { googleUserId: user.permissionId, email: user.emailAddress };
}
