import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestRelationStore, testDatabaseUrl } from '../../test/db.ts';
import { createUser } from '../../test/diary.ts';
import { createSharingService } from '../sharing/sharing.ts';
import { INVITATION_TTL_MS, createBindingService, type BindingService } from './bindings.ts';

// The invitation clock without the transport: the seven-day limit and its equal boundary
// (spaces-and-invitations D8), with the time passed in as the routes do.

let opened: ReturnType<typeof openTestRelationStore> | undefined;
let bindings: BindingService;
beforeAll(() => {
  if (!testDatabaseUrl) return;
  opened = openTestRelationStore();
  bindings = createBindingService(
    opened.relations,
    createSharingService(opened.relations, opened.store),
  );
});
afterAll(async () => {
  await opened?.close();
});

const CREATED = new Date('2026-10-01T12:00:00Z');
const at = (offsetMs: number) => new Date(CREATED.getTime() + offsetMs);

async function invitation() {
  const inviter = await createUser();
  const created = await bindings.createInvitation(
    inviter,
    { requestId: randomUUID(), sharingSelection: null },
    CREATED,
  );
  if (typeof created === 'string') throw new Error(created);
  return { inviter, token: created.token!, id: created.invitation.id };
}

describe.runIf(testDatabaseUrl)('invitation expiry', () => {
  it('[adr:spaces-and-invitations#3] is valid until the last millisecond before seven days and expired at seven days', async () => {
    const { token } = await invitation();
    const acceptor = await createUser();

    expect(await bindings.preview(acceptor, token, at(INVITATION_TTL_MS - 1))).toMatchObject({
      mode: 'new',
    });
    expect(await bindings.preview(acceptor, token, at(INVITATION_TTL_MS))).toBe('INVITE_EXPIRED');
    expect(
      await bindings.accept(acceptor, { token, sharingSelection: null }, at(INVITATION_TTL_MS)),
    ).toBe('INVITE_EXPIRED');
  });

  it('[adr:spaces-and-invitations#3] reports an expired link as expired after a rotation closed it', async () => {
    const { inviter, token, id } = await invitation();
    const acceptor = await createUser();

    const rotated = await bindings.createInvitation(
      inviter,
      { requestId: randomUUID(), sharingSelection: null },
      at(INVITATION_TTL_MS + 1000),
    );

    expect(rotated).toMatchObject({ invitation: { state: 'pending' } });
    expect(await bindings.preview(acceptor, token, at(INVITATION_TTL_MS + 2000))).toBe(
      'INVITE_EXPIRED',
    );
    const current = await bindings.binding(inviter, at(INVITATION_TTL_MS + 2000));
    expect(current.invitation?.id).not.toBe(id);
  });

  it('shows the open invitation as expired once seven days have passed', async () => {
    const { inviter, id } = await invitation();

    expect((await bindings.binding(inviter, at(INVITATION_TTL_MS - 1))).invitation).toEqual({
      id,
      expiresAt: at(INVITATION_TTL_MS),
      state: 'pending',
    });
    expect((await bindings.binding(inviter, at(INVITATION_TTL_MS))).invitation?.state).toBe(
      'expired',
    );
  });
});
