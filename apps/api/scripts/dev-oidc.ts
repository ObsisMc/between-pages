import { Events, OAuth2Server } from 'oauth2-mock-server';

// Local stand-in for Google (authentication-and-sessions D11), used by `npm run dev:oidc`,
// the integration tests and the end-to-end tests. Signs in whoever the login page names:
// the name arrives as `login_hint` and becomes
//   sub = dev-<name>, email = <name up to any "#">@dev.local, name = <name>
// so "alice" and "alice#2" are two subjects sharing one email (the email-conflict case).

export interface DevIdentity {
  sub: string;
  email: string;
  name: string;
}

export function identityFor(hint: string | null | undefined): DevIdentity {
  const name = (hint ?? '').trim() || 'dev';
  const local =
    name
      .split('#')[0]!
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '') || 'dev';
  return { sub: `dev-${name}`, email: `${local}@dev.local`, name };
}

export interface MockOidc {
  issuer: string;
  stop(): Promise<void>;
}

/**
 * Starts the mock issuer at `issuer`. `customize` lets tests change the issued identity
 * (for example a new email for the same subject); it is not used by `npm run dev:oidc`.
 */
export async function startMockOidc(
  issuer: string,
  customize: (identity: DevIdentity) => DevIdentity = (identity) => identity,
): Promise<MockOidc> {
  const url = new URL(issuer);
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');
  // Authorization codes are minted at /authorize, where login_hint is visible, and spent
  // at /token, where it is not; remember which name each code belongs to.
  const hintByCode = new Map<string, string>();
  server.service.on(Events.BeforeAuthorizeRedirect, (redirect, req) => {
    const hint = new URL(req.url ?? '/', issuer).searchParams.get('login_hint') ?? '';
    const code = redirect.url.searchParams.get('code');
    if (code) hintByCode.set(code, hint);
  });
  server.service.on(Events.BeforeTokenSigning, (token, req) => {
    const code = (req.body as Record<string, string> | undefined)?.code;
    const identity = customize(identityFor(code ? hintByCode.get(code) : undefined));
    Object.assign(token.payload, { ...identity, email_verified: true });
  });
  server.service.on(Events.BeforeUserinfo, (response) => {
    response.body = { ...identityFor(undefined), email_verified: true };
  });
  await server.start(Number(url.port), url.hostname);
  // Discovery and tokens must name the configured address, not the bound socket's.
  server.issuer.url = url.origin;
  return { issuer: url.origin, stop: () => server.stop() };
}

if (import.meta.main) {
  const issuer = process.env.DEV_OIDC_ISSUER ?? 'http://127.0.0.1:4010';
  await startMockOidc(issuer);
  console.log(`development OIDC issuer on ${issuer} (local development and tests only)`);
}
