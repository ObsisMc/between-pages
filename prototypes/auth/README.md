# Spike: Better Auth with Fastify and PostgreSQL

Status: exploratory spike (2026-10-24) behind [ADR-0007](../../docs/adr/0007-authentication-and-sessions.md). Not production code.

Question: does Better Auth 1.7.12, configured explicitly, satisfy the login rules in [spec §3](../../docs/diary-spec.md) — stable user id, Google identity keyed by subject and never merged by email, revocable HttpOnly cookie sessions that also authenticate a WebSocket upgrade, and no Google tokens kept for login?

## Setup

- `server.mjs`: Fastify with Better Auth mounted at `/api/auth/*` using the official request/response bridge; PostgreSQL through a `pg` Pool with Better Auth's built-in migrations; `/api/me` and a raw `upgrade` handler resolve the session from the cookie.
- An `oauth2-mock-server` OIDC issuer stands in for Google through the `genericOAuth` plugin (provider id `google`, PKCE, ID-token verification required). Production would use `socialProviders.google`; both go through the same Better Auth account and session code.
- Hardening on top of defaults: `accountLinking.enabled: false`, `encryptOAuthTokens: true`, UUID ids, a `databaseHooks` filter that drops every provider token, and a unique index on `account ("providerId", "accountId")`.

```sh
npm run test:auth:pg     # Docker PostgreSQL 18; log: docs/validation/artifacts/auth-2026-10-24/
```

## Results (10/10 pass, PostgreSQL 18.6, Node 26.12.1)

| Check | Result |
| --- | --- |
| Full OIDC round trip sets the session cookie | `HttpOnly`, `SameSite=Lax`, redirect back to the web origin; user id is a UUID, the account row is `(google, <sub>)` |
| Same subject, changed email | Same user, one account row |
| Different subject, same email | Refused with `account_not_linked`; no session, no user, nothing linked to the existing owner |
| Provider tokens at rest | None stored (see findings) |
| Same new subject signing in twice concurrently | One user, one account |
| WebSocket upgrade | Accepted with the cookie (user id resolved), `401` without |
| Sign-out | A copied cookie is rejected on HTTP and on the upgrade afterwards |
| Untrusted `Origin` | Sign-out from another origin `403`, session survives; a callback URL on another origin is refused |
| `expiresIn` | A 2-second session is rejected after 3 seconds |

## Findings

- **`encryptOAuthTokens` does not cover the ID token.** Access and refresh tokens were stored encrypted, but the ID token (email, name) stayed a plain JWT. Login needs no Google API access, so the spike keeps no provider tokens at all.
- **No unique index on `(providerId, accountId)` by default.** The concurrent sign-in race still produced one user without it, because `user.email` is unique; that protection is incidental, so the index is added explicitly.
- **Better Auth's origin check covers only its own endpoints.** `getSession` does not check `Origin`; the app's own state-changing routes and the WebSocket upgrade must check it themselves (not exercised here).
- In 1.7 generic OAuth providers sign in through `/sign-in/social` and call back on `/callback/<id>`, and Fastify routes must be registered before `listen()`.

Not covered: the real Google endpoints and consent screen, `socialProviders.google` itself, the Drizzle adapter and `auth generate` schema, cookie `Secure` / `__Secure-` prefix over HTTPS, rate limiting, origin checks on app routes, invites and spaces.
