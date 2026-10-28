import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes, type DateSelection } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { testSessions } from '../test/diary.ts';

// Relationship and sharing range routes through the real router and real PostgreSQL
// (spaces-and-invitations D11, acceptance R1–R6).

const ORIGIN = 'http://localhost:5173';
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  app = await buildApp({
    publicOrigin: ORIGIN,
    currentUser: sessions.currentUser,
    db: database.db,
  });
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});

const ALL: DateSelection = { include: [{ from: null, to: null }], exclude: [] };
const OCTOBER: DateSelection = { include: [{ from: '2026-10-01', to: '2026-10-31' }], exclude: [] };

type Person = { id: string; cookie: string };
const person = (name = 'writer'): Promise<Person> => sessions.signIn(name);

const path = (template: string, params: Record<string, string> = {}) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, v), template);

const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });

const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;

async function invite(who: Person, sharingSelection: DateSelection | null = ALL) {
  const res = await send(who, 'POST', routes.createInvitation.path, {
    requestId: randomUUID(),
    sharingSelection,
  });
  expect(res.statusCode).toBe(200);
  return routes.createInvitation.response.parse(res.json());
}

const accept = (who: Person, token: string, sharingSelection: DateSelection | null = OCTOBER) =>
  send(who, 'POST', routes.acceptInvitation.path, { token, sharingSelection });

async function bind(a: Person, b: Person) {
  const { token } = await invite(a);
  const res = await accept(b, token!);
  expect(res.statusCode).toBe(200);
  return routes.acceptInvitation.response.parse(res.json());
}

const unbind = (who: Person, spaceId: string, expectedPeriodId: string) =>
  send(who, 'POST', path(routes.unbind.path, { spaceId }), { expectedPeriodId });

const mySharing = async (who: Person, spaceId: string) =>
  routes.mySharing.response.parse(
    (await get(who, path(routes.mySharing.path, { spaceId }))).json(),
  );

describe.runIf(testDatabaseUrl)('binding', () => {
  it('[adr:spaces-and-invitations#4] binds both people in one space with their own confirmed ranges', async () => {
    const a = await person('A');
    const b = await person('B');

    const { binding, restored } = await bind(a, b);

    expect(restored).toBe(false);
    expect(binding.space.state).toBe('active');
    expect(binding.space.participants.map((p) => p.user.id)).toEqual([a.id, b.id].sort());
    expect(binding.space.participants.map((p) => p.authorSlot)).toEqual([1, 2]);
    for (const who of [a, b]) {
      const mine = routes.binding.response.parse((await get(who, routes.binding.path)).json());
      expect(mine.binding).toEqual(binding);
      expect(mine.invitation).toBeNull();
    }
    expect(await mySharing(a, binding.space.id)).toEqual({
      selection: ALL,
      revision: 1,
      confirmedPeriodId: binding.periodId,
    });
    expect(await mySharing(b, binding.space.id)).toEqual({
      selection: OCTOBER,
      revision: 1,
      confirmedPeriodId: binding.periodId,
    });
  });

  it('[adr:spaces-and-invitations#5] binds without a range for whoever chose not to set one', async () => {
    const a = await person();
    const b = await person();
    const { token } = await invite(a, null);

    const { binding } = routes.acceptInvitation.response.parse(
      (await accept(b, token!, null)).json(),
    );

    for (const who of [a, b])
      expect(await mySharing(who, binding.space.id)).toEqual({
        selection: { include: [], exclude: [] },
        revision: 0,
        confirmedPeriodId: null,
      });
  });

  it('[adr:spaces-and-invitations#1] keeps the first partner: after unbinding, neither may bind anyone else', async () => {
    const [a, b, c, d] = await Promise.all([person(), person(), person(), person()]);
    const { binding } = await bind(a, b);
    await unbind(a, binding.space.id, binding.periodId);

    const ac = await accept(c, (await invite(a)).token!);
    const ca = await accept(a, (await invite(c)).token!);
    const bc = await accept(b, (await invite(c)).token!);
    for (const res of [ac, ca, bc]) expect(codeOf(res)).toBe('PARTNER_FIXED');

    // The other way round: C has a fixed partner of their own and E never bound before.
    await bind(c, d);
    const e = await person();
    const busy = await send(c, 'POST', routes.createInvitation.path, {
      requestId: randomUUID(),
      sharingSelection: null,
    });
    expect(codeOf(busy)).toBe('ALREADY_BOUND');
    expect(codeOf(await accept(c, (await invite(e)).token!))).toBe('ALREADY_BOUND');
    await unbind(c, ...(await currentBinding(c)));
    expect(codeOf(await accept(e, (await invite(c)).token!))).toBe('PARTNER_FIXED');
    expect(codeOf(await accept(c, (await invite(e)).token!))).toBe('PARTNER_FIXED');
  });

  it('[adr:spaces-and-invitations#2] restores the same space with a new period and keeps the old one', async () => {
    const a = await person();
    const b = await person();
    const first = await bind(a, b);
    await unbind(b, first.binding.space.id, first.binding.periodId);

    const { token } = await invite(b, null);
    const preview = routes.previewInvitation.response.parse(
      (await send(a, 'POST', routes.previewInvitation.path, { token })).json(),
    );
    const again = routes.acceptInvitation.response.parse((await accept(a, token!, null)).json());

    expect(preview.mode).toBe('restore');
    expect(again.restored).toBe(true);
    expect(again.binding.space.id).toBe(first.binding.space.id);
    expect(again.binding.periodId).not.toBe(first.binding.periodId);
    const detail = routes.space.response.parse(
      (await get(a, path(routes.space.path, { spaceId: first.binding.space.id }))).json(),
    );
    expect(detail.periods.map((p) => [p.id, p.endedAt === null])).toEqual([
      [first.binding.periodId, false],
      [again.binding.periodId, true],
    ]);
  });

  it('[adr:spaces-and-invitations#5] does not mark an old confirmation as confirmed for a restored period', async () => {
    const a = await person();
    const b = await person();
    const first = await bind(a, b);
    await unbind(a, first.binding.space.id, first.binding.periodId);

    const again = routes.acceptInvitation.response.parse(
      (await accept(b, (await invite(a, null)).token!, null)).json(),
    );

    expect(await mySharing(a, again.binding.space.id)).toEqual({
      selection: ALL,
      revision: 1,
      confirmedPeriodId: first.binding.periodId,
    });
  });
});

async function currentBinding(who: Person): Promise<[string, string]> {
  const { binding } = routes.binding.response.parse((await get(who, routes.binding.path)).json());
  return [binding!.space.id, binding!.periodId];
}

describe.runIf(testDatabaseUrl)('invitations', () => {
  it('[adr:spaces-and-invitations#3] neither previewing nor a second acceptance binds anyone', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    const { token } = await invite(a);

    const preview = await send(b, 'POST', routes.previewInvitation.path, { token });
    expect(routes.previewInvitation.response.parse(preview.json())).toMatchObject({
      inviter: { id: a.id, displayName: 'writer' },
      mode: 'new',
    });
    expect(
      routes.binding.response.parse((await get(b, routes.binding.path)).json()).binding,
    ).toBeNull();

    expect((await accept(b, token!)).statusCode).toBe(200);
    expect(codeOf(await accept(c, token!))).toBe('INVITE_USED');
    expect(codeOf(await accept(b, token!))).toBe('INVITE_USED');
  });

  it('[adr:spaces-and-invitations#3] rotates, revokes and refuses the inviter and unknown tokens', async () => {
    const a = await person();
    const b = await person();
    const first = await invite(a);
    const second = await invite(a);
    const revoke = (id: string) =>
      send(a, 'POST', path(routes.revokeInvitation.path, { inviteId: id }), {});

    expect(codeOf(await accept(b, first.token!))).toBe('INVITE_REVOKED');
    expect(codeOf(await accept(a, second.token!))).toBe('SELF_INVITE');
    expect((await revoke(second.invitation.id)).statusCode).toBe(200);
    expect((await revoke(second.invitation.id)).statusCode).toBe(200);
    expect(codeOf(await accept(b, second.token!))).toBe('INVITE_REVOKED');
    const unknown = await accept(b, 'A'.repeat(43));
    expect([unknown.statusCode, codeOf(unknown)]).toEqual([404, 'INVITE_INVALID']);
    expect(
      codeOf(
        await send(
          b,
          'POST',
          path(routes.revokeInvitation.path, { inviteId: first.invitation.id }),
          {},
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('[adr:spaces-and-invitations#8] returns a retried invitation without its token and refuses another selection under the same request ID', async () => {
    const a = await person();
    const requestId = randomUUID();
    const create = (sharingSelection: DateSelection | null) =>
      send(a, 'POST', routes.createInvitation.path, { requestId, sharingSelection });

    const first = routes.createInvitation.response.parse((await create(ALL)).json());
    const retried = routes.createInvitation.response.parse((await create(ALL)).json());
    const changed = await create(OCTOBER);

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(retried).toEqual({ invitation: first.invitation, token: null });
    expect(codeOf(changed)).toBe('VALIDATION_FAILED');
  });

  it('[adr:spaces-and-invitations#10] stores only the hash of a token and answers no-store', async () => {
    const a = await person();
    const res = await send(a, 'POST', routes.createInvitation.path, {
      requestId: randomUUID(),
      sharingSelection: ALL,
    });
    const { token, invitation } = routes.createInvitation.response.parse(res.json());

    expect(res.headers['cache-control']).toBe('no-store');
    const rows = await query<{ row: string }>(
      'select row_to_json(i)::text as row from binding_invitations i where id = $1',
      [invitation.id],
    );
    expect(rows[0]!.row).not.toContain(token!);
    expect(rows[0]!.row).not.toContain(Buffer.from(token!, 'base64url').toString('hex'));
  });
});

describe.runIf(testDatabaseUrl)('concurrent binding', () => {
  it('[adr:spaces-and-invitations#4] lets exactly one of 20 people take the same invitation', async () => {
    const a = await person();
    const others = await Promise.all(Array.from({ length: 20 }, () => person()));
    const { token } = await invite(a);

    const results = await Promise.all(others.map((who) => accept(who, token!)));

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(new Set(results.filter((r) => r.statusCode !== 200).map(codeOf))).toEqual(
      new Set(['INVITE_USED']),
    );
    const bound = await query<{ n: number }>(
      `select count(*)::int as n from active_bindings where user_id = any($1)`,
      [[a.id, ...others.map((o) => o.id)]],
    );
    expect(bound).toEqual([{ n: 2 }]);
  });

  it('[adr:spaces-and-invitations#4] binds A to only one of B and C when A accepts both at once', async () => {
    const [a, b, c] = await Promise.all([person(), person(), person()]);
    const [fromB, fromC] = [await invite(b), await invite(c)];

    const results = await Promise.all([accept(a, fromB.token!), accept(a, fromC.token!)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const spaces = await query<{ n: number }>(
      'select count(*)::int as n from spaces where user_low = $1 or user_high = $1',
      [a.id],
    );
    expect(spaces).toEqual([{ n: 1 }]);
  });

  it('[adr:spaces-and-invitations#4] creates one space when A and B accept each other at once', async () => {
    const a = await person();
    const b = await person();
    const [fromA, fromB] = [await invite(a), await invite(b)];

    const results = await Promise.all([accept(b, fromA.token!), accept(a, fromB.token!)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const periods = await query<{ n: number }>(
      `select count(*)::int as n from binding_periods p join spaces s on s.id = p.space_id
       where s.user_low = $1 or s.user_high = $1`,
      [a.id],
    );
    expect(periods).toEqual([{ n: 1 }]);
  });

  it('[adr:spaces-and-invitations#11] leaves no half binding when the second binding row fails', async () => {
    const a = await person();
    const b = await person();
    const { token, invitation } = await invite(a);
    const trigger = `fail_${b.id.replaceAll('-', '')}`;
    await query(`create function ${trigger}() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end $$`);
    await query(`create trigger ${trigger} before insert on active_bindings for each row
      when (new.user_id = '${b.id}') execute function ${trigger}()`);
    try {
      const res = await accept(b, token!);
      expect([res.statusCode, codeOf(res)]).toEqual([500, 'INTERNAL']);
    } finally {
      await query(`drop trigger ${trigger} on active_bindings`);
      await query(`drop function ${trigger}()`);
    }

    const left = await query(
      `select (select count(*)::int from spaces where user_low = any($1) or user_high = any($1)) as spaces,
              (select count(*)::int from active_bindings where user_id = any($1)) as bindings,
              (select accepted_at from binding_invitations where id = $2) as accepted_at,
              (select count(*)::int from sharing_policies where owner_id = any($1)) as policies`,
      [[a.id, b.id], invitation.id],
    );
    expect(left).toEqual([{ spaces: 0, bindings: 0, accepted_at: null, policies: 0 }]);
    expect((await accept(b, token!)).statusCode).toBe(200);
  });
});

describe.runIf(testDatabaseUrl)('unbinding', () => {
  it('[adr:spaces-and-invitations#7] ends the period for both and keeps the space, its history and both ranges', async () => {
    const a = await person();
    const b = await person();
    const { binding } = await bind(a, b);

    const res = await unbind(b, binding.space.id, binding.periodId);

    expect(routes.unbind.response.parse(res.json())).toEqual({
      spaceId: binding.space.id,
      closedPeriodId: binding.periodId,
    });
    for (const who of [a, b]) {
      expect(
        routes.binding.response.parse((await get(who, routes.binding.path)).json()).binding,
      ).toBeNull();
      const { spaces } = routes.spaces.response.parse((await get(who, routes.spaces.path)).json());
      expect(spaces.map((s) => [s.id, s.state])).toEqual([[binding.space.id, 'archived']]);
    }
    expect((await mySharing(a, binding.space.id)).selection).toEqual(ALL);
    expect((await mySharing(b, binding.space.id)).selection).toEqual(OCTOBER);
  });

  it('[adr:spaces-and-invitations#8] replays an old unbind without ending the restored period', async () => {
    const a = await person();
    const b = await person();
    const first = await bind(a, b);
    await unbind(a, first.binding.space.id, first.binding.periodId);
    const again = await bind(b, a);

    const replay = await unbind(a, first.binding.space.id, first.binding.periodId);

    expect(routes.unbind.response.parse(replay.json()).closedPeriodId).toBe(first.binding.periodId);
    expect(await currentBinding(a)).toEqual([again.binding.space.id, again.binding.periodId]);
  });
});

describe.runIf(testDatabaseUrl)('sharing ranges', () => {
  const save = (
    who: Person,
    spaceId: string,
    body: {
      requestId?: string;
      expectedPeriodId: string;
      expectedRevision: number;
      selection: DateSelection;
    },
  ) =>
    send(who, 'PUT', path(routes.saveMySharing.path, { spaceId }), {
      requestId: randomUUID(),
      ...body,
    });

  it('[adr:spaces-and-invitations#6] stores single days, ranges, open ends and exclusions in canonical form', async () => {
    const a = await person();
    const b = await person();
    const { binding } = await bind(a, b);

    const res = await save(a, binding.space.id, {
      expectedPeriodId: binding.periodId,
      expectedRevision: 1,
      selection: {
        include: [
          { from: '2026-11-01', to: null },
          { from: '2026-10-03', to: '2026-10-03' },
          { from: '2026-10-01', to: '2026-10-02' },
        ],
        exclude: [{ from: '2026-12-25', to: '2026-12-25' }],
      },
    });

    expect(routes.saveMySharing.response.parse(res.json()).revision).toBe(2);
    expect(await mySharing(a, binding.space.id)).toEqual({
      selection: {
        include: [
          { from: '2026-10-01', to: '2026-10-03' },
          { from: '2026-11-01', to: null },
        ],
        exclude: [{ from: '2026-12-25', to: '2026-12-25' }],
      },
      revision: 2,
      confirmedPeriodId: binding.periodId,
    });
  });

  it('[adr:diary-collaboration-kernel#17] answers SHARE_OPEN_FAILED with the failing dates and stores nothing', async () => {
    const a = await person();
    const b = await person();
    // B confirmed October when binding, so September is private until B saves ALL.
    const { binding } = await bind(a, b);
    const opened = await send(b, 'POST', routes.openDiary.path, {
      timezone: 'Asia/Shanghai',
      date: '2026-09-15',
    });
    const { diary } = routes.openDiary.response.parse(opened.json());
    await query("update diary_generations set baseline_sha256 = '\\x00' where diary_id = $1", [
      diary.diaryId,
    ]);

    const res = await save(b, binding.space.id, {
      expectedPeriodId: binding.periodId,
      expectedRevision: 1,
      selection: ALL,
    });

    expect(res.statusCode).toBe(409);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'SHARE_OPEN_FAILED',
      dates: ['2026-09-15'],
    });
    expect(await mySharing(b, binding.space.id)).toMatchObject({ revision: 1, selection: OCTOBER });
  });

  it('[adr:spaces-and-invitations#8] returns a retried save, refuses a changed one and an outdated revision', async () => {
    const a = await person();
    const b = await person();
    const { binding } = await bind(a, b);
    const body = {
      requestId: randomUUID(),
      expectedPeriodId: binding.periodId,
      expectedRevision: 1,
      selection: OCTOBER,
    };

    const first = routes.saveMySharing.response.parse(
      (await save(a, binding.space.id, body)).json(),
    );
    const retried = routes.saveMySharing.response.parse(
      (await save(a, binding.space.id, body)).json(),
    );
    const changed = await save(a, binding.space.id, { ...body, selection: ALL });
    const outdated = await save(a, binding.space.id, { ...body, requestId: randomUUID() });

    expect(retried).toEqual(first);
    expect([changed.statusCode, codeOf(changed)]).toEqual([400, 'VALIDATION_FAILED']);
    expect([outdated.statusCode, codeOf(outdated)]).toEqual([409, 'POLICY_CONFLICT']);
    expect((await mySharing(a, binding.space.id)).revision).toBe(2);
  });

  it('[adr:spaces-and-invitations#8] refuses a save for an ended period and does not replay it into a new one', async () => {
    const a = await person();
    const b = await person();
    const first = await bind(a, b);
    await unbind(a, first.binding.space.id, first.binding.periodId);

    const closed = await save(a, first.binding.space.id, {
      expectedPeriodId: first.binding.periodId,
      expectedRevision: 1,
      selection: OCTOBER,
    });
    const again = await bind(a, b);
    const stale = await save(a, first.binding.space.id, {
      expectedPeriodId: first.binding.periodId,
      expectedRevision: 2,
      selection: OCTOBER,
    });

    expect(codeOf(closed)).toBe('PERIOD_CLOSED');
    expect(codeOf(stale)).toBe('PERIOD_CLOSED');
    expect((await mySharing(a, again.binding.space.id)).confirmedPeriodId).toBe(
      again.binding.periodId,
    );
  });
});

describe.runIf(testDatabaseUrl)('privacy', () => {
  it('[adr:spaces-and-invitations#9] shows a space and its periods to its two participants only', async () => {
    const [a, b, c] = await Promise.all([person(), person(), person()]);
    const { binding } = await bind(a, b);
    const spaceId = binding.space.id;

    const asThird = [
      await get(c, path(routes.space.path, { spaceId })),
      await get(c, path(routes.mySharing.path, { spaceId })),
      await unbind(c, spaceId, binding.periodId),
      await send(c, 'PUT', path(routes.saveMySharing.path, { spaceId }), {
        requestId: randomUUID(),
        expectedPeriodId: binding.periodId,
        expectedRevision: 0,
        selection: ALL,
      }),
    ];

    for (const res of asThird) expect([res.statusCode, codeOf(res)]).toEqual([404, 'NOT_FOUND']);
    expect(routes.spaces.response.parse((await get(c, routes.spaces.path)).json()).spaces).toEqual(
      [],
    );
  });

  it('[adr:spaces-and-invitations#9] never puts a range into the partner’s or the preview’s answers', async () => {
    const a = await person();
    const b = await person();
    const { token } = await invite(a, {
      include: [{ from: '2026-07-07', to: '2026-07-07' }],
      exclude: [],
    });
    const preview = await send(b, 'POST', routes.previewInvitation.path, { token });
    const accepted = await accept(b, token!, {
      include: [{ from: '2026-08-08', to: null }],
      exclude: [],
    });
    const { binding } = routes.acceptInvitation.response.parse(accepted.json());

    const seenByB = [
      preview,
      accepted,
      await get(b, routes.binding.path),
      await get(b, routes.spaces.path),
      await get(b, path(routes.space.path, { spaceId: binding.space.id })),
      await get(b, path(routes.mySharing.path, { spaceId: binding.space.id })),
    ];
    for (const res of seenByB) expect(res.body).not.toContain('2026-07-07');
  });

  it('[adr:spaces-and-invitations#10] requires a session and the site origin on every relationship route', async () => {
    const a = await person();
    const writes = [
      routes.createInvitation,
      routes.previewInvitation,
      routes.acceptInvitation,
      routes.revokeInvitation,
      routes.unbind,
      routes.saveMySharing,
    ];
    const reads = [routes.binding, routes.spaces, routes.space, routes.mySharing];
    const url = (p: string) => path(p, { spaceId: randomUUID(), inviteId: randomUUID() });

    for (const route of [...writes, ...reads]) {
      const res = await app.inject({
        method: route.method,
        url: url(route.path),
        headers: { origin: ORIGIN },
        ...(route.method === 'GET' ? {} : { payload: {} }),
      });
      expect([route.path, res.statusCode]).toEqual([route.path, 401]);
    }
    for (const route of writes) {
      const res = await app.inject({
        method: route.method,
        url: url(route.path),
        headers: { cookie: a.cookie, origin: 'https://elsewhere.example' },
        payload: {},
      });
      expect([route.path, codeOf(res)]).toEqual([route.path, 'FORBIDDEN_ORIGIN']);
    }
  });

  it('refuses a request that names an actor or owner', async () => {
    const a = await person();
    const res = await send(a, 'POST', routes.createInvitation.path, {
      requestId: randomUUID(),
      sharingSelection: ALL,
      ownerId: randomUUID(),
    });
    expect([res.statusCode, codeOf(res)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});
