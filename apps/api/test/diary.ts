import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import { query } from './db.ts';

/** A domain user row, as the current-user entry point would create on first sign-in. */
export async function createUser(name = 'writer'): Promise<string> {
  const id = randomUUID();
  await query('insert into users (id, display_name) values ($1, $2)', [id, name]);
  return id;
}

/** A writer instance loaded from `state`; Yjs renews a clientID it finds in loaded state, so it is set after. */
export function client(clientID: number, state?: Uint8Array): Y.Doc {
  const doc = createDiaryDoc();
  if (state) Y.applyUpdate(doc, state);
  doc.clientID = clientID;
  return doc;
}

/** One local transaction, captured the way an editor binding emits it. */
export function edit(doc: Y.Doc, change: (text: Y.Text) => void): Uint8Array<ArrayBuffer> {
  let update: Uint8Array | undefined;
  const capture = (u: Uint8Array) => (update = u);
  doc.on('update', capture);
  change(doc.getText(BODY));
  doc.off('update', capture);
  if (!update) throw new Error('the change produced no update');
  return new Uint8Array(update);
}

export const operation = (update: Uint8Array<ArrayBuffer>, operationId = randomUUID()) => ({
  operationId,
  update,
  writtenAt: new Date('2026-10-26T08:00:00Z'),
});

export const textOf = (state: Uint8Array) => {
  const doc = createDiaryDoc();
  Y.applyUpdate(doc, state);
  return doc.getText(BODY).toString();
};

/** Counts rows of one diary in a kernel table, re-reading PG rather than trusting a reply. */
export async function countRows(table: string, diaryId: string): Promise<number> {
  const [row] = await query<{ n: number }>(
    `select count(*)::int as n from ${table} where diary_id = $1`,
    [diaryId],
  );
  return row!.n;
}

/**
 * Stand-in sessions for app-level tests: a `session=<token>` cookie names a user until the
 * test revokes it, as sign-out or revocation would. The real Better Auth path is covered
 * in src/auth/auth.db.test.ts.
 */
export function testSessions() {
  const users = new Map<string, { id: string; displayName: string; sessionId: string }>();
  const ended = new Set<(sessionId: string) => void>();
  return {
    async signIn(name = 'writer') {
      const id = await createUser(name);
      const token = `t-${id}`;
      users.set(token, { id, displayName: name, sessionId: token });
      return { id, cookie: `session=${token}` };
    },
    /** Ends the session as sign-out does: no longer valid, then announced. */
    revoke(cookie: string) {
      const token = cookie.slice('session='.length);
      users.delete(token);
      for (const listener of ended) listener(token);
    },
    /** Ends the session silently, as expiry does: no event follows. */
    expire(cookie: string) {
      users.delete(cookie.slice('session='.length));
    },
    /** As `Auth.onSessionEnded`, for buildApp's `sessionEnded`. */
    onSessionEnded(listener: (sessionId: string) => void) {
      ended.add(listener);
    },
    currentUser: async (headers: { cookie?: string | undefined }) =>
      users.get(headers.cookie?.slice('session='.length) ?? '') ?? null,
  };
}
