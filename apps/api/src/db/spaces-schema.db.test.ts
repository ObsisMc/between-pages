import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { query, testDatabaseUrl } from '../../test/db.ts';
import { createUser } from '../../test/diary.ts';

// Constraints of the relationship and sharing range tables (spaces-and-invitations ADR D10)
// on real PostgreSQL. Rules that span tables are the binding transaction's, tested with it.

const rejectedBy = (constraint: string) => expect.objectContaining({ constraint });

async function pair(): Promise<[string, string]> {
  const ids = [await createUser('a'), await createUser('b')].sort();
  return [ids[0]!, ids[1]!];
}

async function space(): Promise<{ spaceId: string; low: string; high: string }> {
  const [low, high] = await pair();
  const spaceId = randomUUID();
  await query('insert into spaces (id, user_low, user_high) values ($1, $2, $3)', [
    spaceId,
    low,
    high,
  ]);
  return { spaceId, low, high };
}

async function period(spaceId: string): Promise<string> {
  const id = randomUUID();
  await query('insert into binding_periods (id, space_id) values ($1, $2)', [id, spaceId]);
  return id;
}

const endPeriod = (periodId: string, by: string) =>
  query('update binding_periods set ended_at = now(), ended_by = $2 where id = $1', [periodId, by]);

function invite(createdBy: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    created_by: createdBy,
    request_id: randomUUID(),
    token_hash: Buffer.from(randomUUID()),
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    ...fields,
  };
  const columns = Object.keys(row);
  return query(
    `insert into binding_invitations (${columns.join(', ')})
     values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
}

describe.runIf(testDatabaseUrl)('spaces', () => {
  it('[adr:spaces-and-invitations#1] refuses a space whose two participants are the same user', async () => {
    const user = await createUser();

    await expect(
      query('insert into spaces (id, user_low, user_high) values ($1, $2, $2)', [
        randomUUID(),
        user,
      ]),
    ).rejects.toEqual(rejectedBy('spaces_pair_ordered'));
  });

  it('[adr:spaces-and-invitations#2] keeps one space per pair, in either order', async () => {
    const { low, high } = await space();

    await expect(
      query('insert into spaces (id, user_low, user_high) values ($1, $2, $3)', [
        randomUUID(),
        low,
        high,
      ]),
    ).rejects.toEqual(rejectedBy('spaces_pair'));
    await expect(
      query('insert into spaces (id, user_low, user_high) values ($1, $2, $3)', [
        randomUUID(),
        high,
        low,
      ]),
    ).rejects.toEqual(rejectedBy('spaces_pair_ordered'));
  });
});

describe.runIf(testDatabaseUrl)('binding periods', () => {
  it('[adr:spaces-and-invitations#2] allows one open period per space and a new one after it ends', async () => {
    const { spaceId, low } = await space();
    const first = await period(spaceId);

    await expect(period(spaceId)).rejects.toEqual(rejectedBy('binding_periods_one_open'));
    await endPeriod(first, low);
    await period(spaceId);

    const rows = await query<{ open: number; closed: number }>(
      `select count(*) filter (where ended_at is null)::int as open,
              count(*) filter (where ended_at is not null)::int as closed
       from binding_periods where space_id = $1`,
      [spaceId],
    );
    expect(rows).toEqual([{ open: 1, closed: 1 }]);
  });

  it('records who ended a period together with when', async () => {
    const { spaceId, low } = await space();
    const id = await period(spaceId);

    await expect(
      query('update binding_periods set ended_at = now() where id = $1', [id]),
    ).rejects.toEqual(rejectedBy('binding_periods_end_fields'));
    await expect(
      query('update binding_periods set ended_by = $2 where id = $1', [id, low]),
    ).rejects.toEqual(rejectedBy('binding_periods_end_fields'));
    await expect(
      query(
        `update binding_periods set ended_at = started_at - interval '1 second', ended_by = $2
         where id = $1`,
        [id, low],
      ),
    ).rejects.toEqual(rejectedBy('binding_periods_end_order'));
  });
});

describe.runIf(testDatabaseUrl)('active bindings', () => {
  it('keeps each user to one current binding', async () => {
    const first = await space();
    const second = await space();
    const firstPeriod = await period(first.spaceId);
    const secondPeriod = await period(second.spaceId);
    await query('insert into active_bindings (user_id, period_id, space_id) values ($1, $2, $3)', [
      first.low,
      firstPeriod,
      first.spaceId,
    ]);

    await expect(
      query('insert into active_bindings (user_id, period_id, space_id) values ($1, $2, $3)', [
        first.low,
        secondPeriod,
        second.spaceId,
      ]),
    ).rejects.toEqual(rejectedBy('active_bindings_pkey'));
  });

  it('refuses a binding whose period belongs to another space', async () => {
    const first = await space();
    const second = await space();
    const secondPeriod = await period(second.spaceId);

    await expect(
      query('insert into active_bindings (user_id, period_id, space_id) values ($1, $2, $3)', [
        first.low,
        secondPeriod,
        first.spaceId,
      ]),
    ).rejects.toEqual(rejectedBy('active_bindings_period'));
  });
});

describe.runIf(testDatabaseUrl)('binding invitations', () => {
  it('keeps one open invitation per inviter and allows a new one once it is closed', async () => {
    const inviter = await createUser();
    const id = randomUUID();
    await invite(inviter, { id });

    await expect(invite(inviter)).rejects.toEqual(rejectedBy('binding_invitations_one_open'));
    await query('update binding_invitations set revoked_at = now() where id = $1', [id]);
    await invite(inviter);
  });

  it('refuses a repeated request ID or token hash', async () => {
    const inviter = await createUser();
    const requestId = randomUUID();
    const tokenHash = Buffer.from(randomUUID());
    await invite(inviter, { request_id: requestId, token_hash: tokenHash, revoked_at: new Date() });

    await expect(invite(inviter, { request_id: requestId })).rejects.toEqual(
      rejectedBy('binding_invitations_request'),
    );
    await expect(invite(await createUser(), { token_hash: tokenHash })).rejects.toEqual(
      rejectedBy('binding_invitations_token_hash_unique'),
    );
  });

  it('[adr:spaces-and-invitations#3] closes an invitation once: accepted with its acceptor, never also revoked', async () => {
    const inviter = await createUser();
    const acceptor = await createUser();
    const now = new Date();

    await expect(invite(inviter, { accepted_at: now })).rejects.toEqual(
      rejectedBy('binding_invitations_accept_fields'),
    );
    await expect(
      invite(inviter, { accepted_at: now, accepted_by: acceptor, revoked_at: now }),
    ).rejects.toEqual(rejectedBy('binding_invitations_closed_once'));
    await expect(invite(inviter, { created_at: now, expires_at: now })).rejects.toEqual(
      rejectedBy('binding_invitations_expiry'),
    );
  });
});

describe.runIf(testDatabaseUrl)('sharing policies', () => {
  it('starts empty and unconfirmed, and refuses a negative revision', async () => {
    const { spaceId, low } = await space();
    await query('insert into sharing_policies (space_id, owner_id) values ($1, $2)', [
      spaceId,
      low,
    ]);

    const rows = await query(
      'select selection, revision, confirmed_period_id from sharing_policies where space_id = $1',
      [spaceId],
    );
    expect(rows).toEqual([
      { selection: { include: [], exclude: [] }, revision: 0, confirmed_period_id: null },
    ]);
    await expect(
      query('update sharing_policies set revision = -1 where space_id = $1', [spaceId]),
    ).rejects.toEqual(rejectedBy('sharing_policies_revision'));
  });

  it('refuses a confirmation for a period of another space', async () => {
    const own = await space();
    const other = await space();
    const otherPeriod = await period(other.spaceId);

    await expect(
      query(
        'insert into sharing_policies (space_id, owner_id, confirmed_period_id) values ($1, $2, $3)',
        [own.spaceId, own.low, otherPeriod],
      ),
    ).rejects.toEqual(rejectedBy('sharing_policies_confirmed_period'));
  });

  it('records each change once per request, one revision at a time, for an existing policy', async () => {
    const { spaceId, low, high } = await space();
    const periodId = await period(spaceId);
    await query('insert into sharing_policies (space_id, owner_id) values ($1, $2)', [
      spaceId,
      low,
    ]);
    const change = (owner: string, requestId: string, from: number, to: number) =>
      query(
        `insert into sharing_policy_changes
           (id, space_id, owner_id, request_id, from_revision, to_revision, selection, period_id)
         values ($1, $2, $3, $4, $5, $6, '{"include":[],"exclude":[]}', $7)`,
        [randomUUID(), spaceId, owner, requestId, from, to, periodId],
      );
    const requestId = randomUUID();
    await change(low, requestId, 0, 1);

    await expect(change(low, requestId, 1, 2)).rejects.toEqual(
      rejectedBy('sharing_policy_changes_request'),
    );
    await expect(change(low, randomUUID(), 1, 3)).rejects.toEqual(
      rejectedBy('sharing_policy_changes_step'),
    );
    await expect(change(high, randomUUID(), 0, 1)).rejects.toEqual(
      rejectedBy('sharing_policy_changes_policy'),
    );
  });
});
