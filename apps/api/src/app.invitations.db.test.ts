import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Invitations addressed to a Google sign-in email, through the real router and PostgreSQL
// (in-app-invitation-by-email 验收标准). Each person gets an auth-layer address, verified
// unless a test says otherwise; addresses are unique per run because files share one database.

const ORIGIN = 'http://localhost:5173';
const sessions = testSessions();
const logs: string[] = [];
let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  app = await buildApp({
    publicOrigin: ORIGIN,
    currentUser: sessions.currentUser,
    db: database.db,
    logger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } },
  });
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});

type Person = { id: string; cookie: string; email: string };
const run = randomUUID().slice(0, 8);
async function person(name: string, { verified = true } = {}): Promise<Person> {
  const signed = await sessions.signIn(name);
  const email = `${name}.${run}.${signed.id.slice(0, 8)}@example.test`;
  await query('insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, $4)', [
    signed.id,
    name,
    email,
    verified,
  ]);
  return { ...signed, email };
}
const path = (template: string, params: Record<string, string>) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, v), template);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;

const invite = (who: Person, recipientEmail?: string, requestId: string = randomUUID()) =>
  send(who, routes.createInvitation.path, {
    requestId,
    sharingSelection: null,
    ...(recipientEmail === undefined ? {} : { recipientEmail }),
  });
const created = async (res: Awaited<ReturnType<typeof invite>>) => {
  expect(res.statusCode).toBe(200);
  return routes.createInvitation.response.parse(res.json());
};
const bindingOf = async (who: Person) => {
  const res = await get(who, routes.binding.path);
  expect(res.statusCode).toBe(200);
  return routes.binding.response.parse(res.json());
};
const incoming = async (who: Person) => (await bindingOf(who)).invitationsForMe;
const preview = (who: Person, body: object) => send(who, routes.previewInvitation.path, body);
const accept = (who: Person, body: object) =>
  send(who, routes.acceptInvitation.path, { sharingSelection: null, ...body });
const dismiss = (who: Person, inviteId: string) =>
  send(who, path(routes.dismissInvitation.path, { inviteId }), {});

/** An answer without the fields that differ by nature between two invitations. */
const shape = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, v) =>
    key === 'id' || key === 'expiresAt' ? '…' : key === 'recipientEmail' && v ? '@' : v,
  );

describe.runIf(testDatabaseUrl)('addressed invitations', () => {
  it('[adr:in-app-invitation-by-email#1] keeps one open invitation per inviter, a link or an address, never both', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const link = await created(await invite(a));
    expect(link.token).not.toBeNull();
    expect(link.invitation.recipientEmail).toBeNull();

    const addressed = await created(await invite(a, b.email));
    expect(addressed.token).toBeNull();
    expect(addressed.invitation.recipientEmail).toBe(b.email);
    expect((await bindingOf(a)).invitation).toMatchObject({
      id: addressed.invitation.id,
      state: 'pending',
    });
    // The link was closed: its token no longer previews as open.
    expect(codeOf(await preview(b, { token: link.token }))).toBe('INVITE_REVOKED');

    const linkAgain = await created(await invite(a));
    expect(await incoming(b)).toEqual([]);
    const open = await query<{ n: number }>(
      'select count(*)::int as n from binding_invitations where created_by = $1 and revoked_at is null and accepted_at is null',
      [a.id],
    );
    expect(open[0]!.n).toBe(1);
    expect((await bindingOf(a)).invitation?.id).toBe(linkAgain.invitation.id);
    await expect(
      query(
        `insert into binding_invitations (id, created_by, request_id, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [randomUUID(), a.id, randomUUID()],
      ),
    ).rejects.toThrow(/binding_invitations_one_way/);
  });

  it('[adr:in-app-invitation-by-email#2] [adr:in-app-invitation-by-email#10] lists an invitation only for the verified address, folding case and nothing else', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const c = await person('carol');
    const shouted = ` ${b.email.toUpperCase()} `;
    const sent = await created(await invite(a, shouted));
    expect(sent.invitation.recipientEmail).toBe(b.email);

    expect(await incoming(b)).toEqual([
      {
        id: sent.invitation.id,
        inviter: { id: a.id, displayName: 'alice' },
        expiresAt: sent.invitation.expiresAt,
        mode: 'new',
      },
    ]);
    expect(await incoming(c)).toEqual([]);
    const byId = { inviteId: sent.invitation.id };
    for (const res of [await preview(c, byId), await accept(c, byId)]) {
      expect(res.statusCode).toBe(404);
      expect(codeOf(res)).toBe('INVITE_INVALID');
      expect(res.body).not.toContain('alice');
    }
    expect(codeOf(await dismiss(c, sent.invitation.id))).toBe('NOT_FOUND');

    // Gmail spellings are different addresses.
    const dotted = await person('dotted');
    const local = dotted.email.split('@')[0]!;
    for (const other of [`${local}+diary@example.test`, `${local.replace('.', '')}@example.test`]) {
      await created(await invite(a, other));
      expect(await incoming(dotted)).toEqual([]);
    }

    // An unverified sign-in address matches nothing, even when it is the one typed.
    const unverified = await person('unverified', { verified: false });
    const toUnverified = await created(await invite(a, unverified.email));
    expect(await incoming(unverified)).toEqual([]);
    expect(codeOf(await preview(unverified, { inviteId: toUnverified.invitation.id }))).toBe(
      'INVITE_INVALID',
    );

    // A link's ID cannot be used as an addressed one.
    const link = await created(await invite(c));
    expect(codeOf(await preview(b, { inviteId: link.invitation.id }))).toBe('INVITE_INVALID');
    // The caller's own address is refused, which tells nothing about anyone else.
    expect(codeOf(await invite(a, a.email.toUpperCase()))).toBe('SELF_INVITE');
  });

  it('[adr:in-app-invitation-by-email#3] shows the inviter the same whether the address has an account, signed in or dismissed', async () => {
    // Nobody has this address.
    const a1 = await person('alice');
    const toNobody = await created(await invite(a1, `nobody.${randomUUID()}@example.test`));
    const nobody = shape({ created: toNobody, binding: await bindingOf(a1) });

    // Bob has an account, is signed in, sees the invitation and dismisses it.
    const a2 = await person('alice');
    const b = await person('bob');
    const toBob = await created(await invite(a2, b.email));
    expect(shape({ created: toBob, binding: await bindingOf(a2) })).toEqual(nobody);
    expect(await incoming(b)).toHaveLength(1);
    await preview(b, { inviteId: toBob.invitation.id });
    expect((await dismiss(b, toBob.invitation.id)).statusCode).toBe(200);
    expect(shape({ created: toBob, binding: await bindingOf(a2) })).toEqual(nobody);
  });

  it('[adr:in-app-invitation-by-email#4] lives seven days, can be revoked and is consumed once; listing and previewing bind nothing', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const sent = await created(await invite(a, b.email));
    const byId = { inviteId: sent.invitation.id };
    const previewed = await preview(b, byId);
    expect(routes.previewInvitation.response.parse(previewed.json())).toEqual({
      inviter: { id: a.id, displayName: 'alice' },
      expiresAt: sent.invitation.expiresAt,
      mode: 'new',
    });
    expect(
      Date.parse(sent.invitation.expiresAt) - Date.parse(new Date().toISOString()),
    ).toBeGreaterThan(7 * 24 * 3600_000 - 60_000);
    expect((await bindingOf(b)).binding).toBeNull();
    expect((await bindingOf(a)).binding).toBeNull();

    expect((await send(a, path(routes.revokeInvitation.path, byId), {})).statusCode).toBe(200);
    expect(await incoming(b)).toEqual([]);
    expect(codeOf(await accept(b, byId))).toBe('INVITE_REVOKED');

    const again = await created(await invite(a, b.email));
    await query(
      "update binding_invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1",
      [again.invitation.id],
    );
    expect(await incoming(b)).toEqual([]);
    expect(codeOf(await accept(b, { inviteId: again.invitation.id }))).toBe('INVITE_EXPIRED');

    const third = await created(await invite(a, b.email));
    expect((await accept(b, { inviteId: third.invitation.id })).statusCode).toBe(200);
    expect(codeOf(await accept(b, { inviteId: third.invitation.id }))).toBe('INVITE_USED');
  });

  it('[adr:in-app-invitation-by-email#5] accepts by ID in the one binding transaction, and lists what cannot be accepted with the usual refusal', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const bLink = await created(await invite(b));
    const sent = await created(await invite(a, b.email));
    const res = await accept(b, {
      inviteId: sent.invitation.id,
      sharingSelection: { include: [{ from: '2026-06-01', to: null }], exclude: [] },
    });
    expect(res.statusCode).toBe(200);
    const { binding, restored } = routes.acceptInvitation.response.parse(res.json());
    expect(restored).toBe(false);
    expect((await bindingOf(a)).binding?.periodId).toBe(binding.periodId);
    expect((await bindingOf(b)).invitation).toBeNull();
    expect(codeOf(await preview(a, { token: bLink.token }))).toBe('INVITE_REVOKED');
    const [policy] = await query<{ selection: unknown; confirmed_period_id: string }>(
      'select selection, confirmed_period_id from sharing_policies where space_id = $1 and owner_id = $2',
      [binding.space.id, b.id],
    );
    expect(policy).toEqual({
      selection: { include: [{ from: '2026-06-01', to: null }], exclude: [] },
      confirmed_period_id: binding.periodId,
    });

    // Bound now: another inviter's addressed invitation is still listed, and refused.
    const d = await person('dave');
    const late = await created(await invite(d, b.email));
    expect((await incoming(b)).map((i) => i.id)).toEqual([late.invitation.id]);
    expect(codeOf(await preview(b, { inviteId: late.invitation.id }))).toBe('ALREADY_BOUND');
    expect(codeOf(await accept(b, { inviteId: late.invitation.id }))).toBe('ALREADY_BOUND');
    expect((await dismiss(b, late.invitation.id)).statusCode).toBe(200);
    expect(await incoming(b)).toEqual([]);

    // Unbound and invited again by the same person: it restores their space.
    expect(
      (
        await send(a, path(routes.unbind.path, { spaceId: binding.space.id }), {
          expectedPeriodId: binding.periodId,
        })
      ).statusCode,
    ).toBe(200);
    const restore = await created(await invite(a, b.email));
    expect(await incoming(b)).toEqual([expect.objectContaining({ mode: 'restore' })]);
    const restoredRes = await accept(b, { inviteId: restore.invitation.id });
    expect(routes.acceptInvitation.response.parse(restoredRes.json()).restored).toBe(true);
  });

  it('[adr:in-app-invitation-by-email#6] never shows the address to the recipient or anyone else, nor logs it', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const sent = await created(await invite(a, b.email));
    const recipientViews = [
      await get(b, routes.binding.path),
      await preview(b, { inviteId: sent.invitation.id }),
      await get(b, routes.me.path),
    ];
    for (const res of recipientViews) expect(res.body).not.toContain(b.email);
    const invalid = await invite(a, `not an address ${b.email}`);
    expect(codeOf(invalid)).toBe('VALIDATION_FAILED');
    expect(invalid.body).not.toContain(b.email);
    expect((await accept(b, { inviteId: sent.invitation.id })).statusCode).toBe(200);
    expect((await get(b, routes.spaces.path)).body).not.toContain(b.email);
    expect(logs.join('\n')).not.toContain(b.email.split('@')[0]);
  });

  it('[adr:in-app-invitation-by-email#7] dismissing hides it from the recipient only, again changes nothing, and a new one shows', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const sent = await created(await invite(a, b.email));
    const byId = { inviteId: sent.invitation.id };
    const inviterBefore = await bindingOf(a);

    expect(
      routes.dismissInvitation.response.parse((await dismiss(b, sent.invitation.id)).json()),
    ).toEqual({ dismissed: true });
    expect(await incoming(b)).toEqual([]);
    expect(codeOf(await preview(b, byId))).toBe('INVITE_INVALID');
    expect(codeOf(await accept(b, byId))).toBe('INVITE_INVALID');
    expect(await bindingOf(a)).toEqual(inviterBefore);
    expect((await dismiss(b, sent.invitation.id)).statusCode).toBe(200);
    // Only the recipient can dismiss, and the inviter cannot.
    expect(codeOf(await dismiss(a, sent.invitation.id))).toBe('NOT_FOUND');
    expect(codeOf(await dismiss(b, randomUUID()))).toBe('NOT_FOUND');

    const resent = await created(await invite(a, b.email));
    expect((await incoming(b)).map((i) => i.id)).toEqual([resent.invitation.id]);
  });

  it('[adr:in-app-invitation-by-email#8] allows five addressed invitations in 24 hours; retries and links do not count', async () => {
    const a = await person('alice');
    let last = '';
    for (let n = 0; n < 5; n++) {
      last = randomUUID();
      await created(await invite(a, `friend${n}.${run}@example.test`, last));
    }
    const retried = await created(await invite(a, `friend4.${run}@example.test`, last));
    expect(retried.token).toBeNull();
    const sixth = await invite(a, `friend5.${run}@example.test`);
    expect(sixth.statusCode).toBe(429);
    expect(codeOf(sixth)).toBe('INVITE_LIMIT');
    // The same request ID with another address is a different request.
    expect(codeOf(await invite(a, `other.${run}@example.test`, last))).toBe('VALIDATION_FAILED');
    expect((await created(await invite(a))).token).not.toBeNull();

    // Older ones leave the window.
    await query(
      "update binding_invitations set created_at = now() - interval '25 hours' where created_by = $1 and recipient_email is not null",
      [a.id],
    );
    await created(await invite(a, `friend5.${run}@example.test`));
  });

  it('[adr:in-app-invitation-by-email#9] mails nothing and queues nothing', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const sent = await created(await invite(a, b.email));
    await dismiss(b, sent.invitation.id);
    const again = await created(await invite(a, b.email));
    expect((await accept(b, { inviteId: again.invitation.id })).statusCode).toBe(200);
    const mails = await query<{ n: number }>(
      'select count(*)::int as n from mail_sends where user_id = any($1)',
      [[a.id, b.id]],
    );
    expect(mails[0]!.n).toBe(0);
  });

  it('refuses a request naming both a token and an ID, or a malformed address', async () => {
    const a = await person('alice');
    const b = await person('bob');
    const link = await created(await invite(a));
    const sent = await created(await invite(b, a.email));
    expect(codeOf(await preview(a, { token: link.token, inviteId: sent.invitation.id }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codeOf(await invite(a, 'no-at-sign'))).toBe('VALIDATION_FAILED');
    expect(codeOf(await invite(a, `${'x'.repeat(250)}@example.test`))).toBe('VALIDATION_FAILED');
  });
});
