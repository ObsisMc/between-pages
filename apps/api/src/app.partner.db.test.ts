import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY } from '@between-pages/collab';
import {
  ApiErrorBody,
  routes,
  type DateSelection,
  type ServerMessage,
} from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, edit, testSessions } from '../test/diary.ts';
import { connectSocket, type Socket } from '../test/socket.ts';

// The partner's side of a shared diary through the real router, socket and PostgreSQL
// (kernel D5, D6, D10, D17; acceptance K5, K6, K9, K10). Every payload a partner receives
// is decoded and searched for text written privately.

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
const NOTHING: DateSelection = { include: [], exclude: [] };
const SECRET = 'PRIVATE-V11-WORDS';

type Person = { id: string; cookie: string };
const path = (template: string, params: Record<string, string | number>) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, String(v)), template);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const codeOf = (res: { json: () => unknown }) => ApiErrorBody.parse(res.json()).error.code;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const textOf = (...updates: Uint8Array[]) => {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc.getText(BODY).toString();
};
/** Whether raw bytes carry the private text anywhere, encoded as Yjs stores strings (UTF-8). */
const leaks = (bytes: Uint8Array) => Buffer.from(bytes).includes(SECRET);

/** A and B bound; A shares every date, B none. A's diary for `date` opens on creation. */
async function pair() {
  const a = await sessions.signIn('A');
  const b = await sessions.signIn('B');
  const invited = routes.createInvitation.response.parse(
    (
      await send(a, 'POST', routes.createInvitation.path, {
        requestId: randomUUID(),
        sharingSelection: ALL,
      })
    ).json(),
  );
  const accepted = routes.acceptInvitation.response.parse(
    (
      await send(b, 'POST', routes.acceptInvitation.path, {
        token: invited.token,
        sharingSelection: NOTHING,
      })
    ).json(),
  );
  const { space, periodId } = accepted.binding;
  let revision = 1;
  const saveRange = async (selection: DateSelection) => {
    const res = await send(a, 'PUT', path(routes.saveMySharing.path, { spaceId: space.id }), {
      requestId: randomUUID(),
      expectedPeriodId: periodId,
      expectedRevision: revision,
      selection,
    });
    revision = routes.saveMySharing.response.parse(res.json()).revision;
  };
  return { a, b, spaceId: space.id, periodId, saveRange };
}

async function ownDiary(owner: Person, date = '2026-10-20') {
  const res = await send(owner, 'POST', routes.openDiary.path, { timezone: 'Asia/Shanghai', date });
  return routes.openDiary.response.parse(res.json()).diary;
}

async function ownerView(owner: Person, diaryId: string) {
  return routes.diary.response.parse(
    (await get(owner, path(routes.diary.path, { diaryId }))).json(),
  ).diary;
}

async function sharedList(who: Person, spaceId: string) {
  return routes.sharedDiaries.response.parse(
    (await get(who, path(routes.sharedDiaries.path, { spaceId }))).json(),
  ).diaries;
}

const openShared = (who: Person, diaryId: string, epochId: string) =>
  get(who, path(routes.sharedDiary.path, { diaryId, epochId }));
async function shared(who: Person, diaryId: string, epochId: string) {
  return routes.sharedDiary.response.parse((await openShared(who, diaryId, epochId)).json()).diary;
}

/** A writer instance loaded from a served state, with its own new clientID. */
function writerFrom(state: string, clientID: number) {
  return client(clientID, bytesOf(state));
}

function submitMessage(
  diary: { diaryId: string; generationId: string },
  updates: Uint8Array[],
  epochId?: string,
) {
  return {
    v: 1,
    type: 'submit',
    diaryId: diary.diaryId,
    batchId: randomUUID(),
    generationId: diary.generationId,
    ...(epochId ? { epochId } : {}),
    operations: updates.map((update) => ({
      operationId: randomUUID(),
      update: base64(update),
      writtenAt: '2026-10-20T09:00:00+08:00',
    })),
  };
}

async function subscribe(
  who: Person,
  diary: { diaryId: string; generationId: string },
  epochId?: string,
  knownSeq = 0,
): Promise<{ socket: Socket; first: ServerMessage }> {
  const socket = await connectSocket(app, who.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId: diary.diaryId,
    generationId: diary.generationId,
    ...(epochId ? { epochId } : {}),
    knownSeq,
  });
  return { socket, first: await socket.next() };
}

/** Submits and waits for this batch's answer, skipping broadcasts. */
async function submitted(socket: Socket, message: ReturnType<typeof submitMessage>) {
  socket.send(message);
  for (;;) {
    const answer = await socket.next();
    if (
      (answer.type === 'ack' && answer.receipt.batchId === message.batchId) ||
      answer.type === 'error'
    )
      return answer;
  }
}

async function historyOf(who: Person, diaryId: string) {
  const res = await get(who, path(routes.history.path, { diaryId }));
  return res.statusCode === 200 ? routes.history.response.parse(res.json()).points : codeOf(res);
}

describe.runIf(testDatabaseUrl)('the partner reads and writes a live share', () => {
  it('[adr:diary-collaboration-kernel#14] lists, opens and follows the share, and writes own text in the live epoch', async () => {
    const { a, b, spaceId } = await pair();
    const diary = await ownDiary(a);
    const ownerSide = await subscribe(a, diary);
    expect(ownerSide.first).toMatchObject({ type: 'synced', seq: 0 });
    const tab = writerFrom(diary.state, 4101);
    await submitted(ownerSide.socket, submitMessage(diary, [edit(tab, (t) => t.insert(0, 'A字'))]));
    await ownerSide.socket.next(); // own broadcast

    const [listed] = await sharedList(b, spaceId);
    expect(listed).toMatchObject({ diaryId: diary.diaryId, share: 'live', excerpt: 'A字' });
    const opened = await shared(b, diary.diaryId, listed!.epochId);
    expect(opened).toMatchObject({ share: 'live', seq: 1, ownerId: a.id });
    expect(textOf(bytesOf(opened.state))).toBe('A字');

    const partner = await subscribe(b, opened, opened.epochId, opened.seq);
    expect(partner.first).toMatchObject({ type: 'synced', seq: 1, commits: [] });
    const pen = writerFrom(opened.state, 4201);
    const written = await submitted(
      partner.socket,
      submitMessage(opened, [edit(pen, (t) => t.insert(2, 'B写'))], opened.epochId),
    );
    expect(written).toMatchObject({ type: 'ack', receipt: { seq: 2 } });
    const heard = await ownerSide.socket.next();
    expect(heard).toMatchObject({
      type: 'commit',
      seq: 2,
      bindings: [{ clientId: 4201, userId: b.id }],
    });

    const [row] = await query<{ epoch_id: string; author_id: string }>(
      'select epoch_id, author_id from diary_commits where diary_id = $1 and seq = 2',
      [diary.diaryId],
    );
    expect(row).toEqual({ epoch_id: opened.epochId, author_id: b.id });
    expect(
      await query(
        "select target, epoch_id from backup_outbox where diary_id = $1 and target = 'space' order by version",
        [diary.diaryId],
      ),
    ).toHaveLength(3); // the baseline, A's commit and B's

    // Author protection holds for the partner too.
    const forbidden = await submitted(
      partner.socket,
      submitMessage(opened, [edit(pen, (t) => t.delete(0, 1))], opened.epochId),
    );
    expect(forbidden).toMatchObject({ type: 'error', code: 'EDIT_REJECTED' });

    const own = await get(
      b,
      path(routes.character.path, { diaryId: diary.diaryId, clientId: 4201, clock: 0 }) +
        `?epochId=${opened.epochId}`,
    );
    expect(routes.character.response.parse(own.json())).toMatchObject({ author: b.id });
    const theirs = await get(
      b,
      path(routes.character.path, { diaryId: diary.diaryId, clientId: 4101, clock: 1 }) +
        `?epochId=${opened.epochId}`,
    );
    expect(routes.character.response.parse(theirs.json())).toMatchObject({
      author: a.id,
      writtenAt: '2026-10-20T01:00:00.000Z',
      clockAdjusted: false,
    });
    ownerSide.socket.close();
    partner.socket.close();
  });
});

describe.runIf(testDatabaseUrl)('private history stays private', () => {
  it('[adr:diary-collaboration-kernel#12] [adr:diary-collaboration-kernel#14] [adr:diary-collaboration-kernel#15] the partner never receives V11 at any exit, and sees no trace of private commits in seq or history', async () => {
    const { a, b, spaceId, saveRange } = await pair();
    const diary = await ownDiary(a);
    const ownerSide = await subscribe(a, diary);
    const tab = writerFrom(diary.state, 5101);
    await submitted(
      ownerSide.socket,
      submitMessage(diary, [edit(tab, (t) => t.insert(0, 'shared '))]),
    );
    const e1 = (await sharedList(b, spaceId))[0]!.epochId;
    const partner = await subscribe(b, diary, e1, 1);
    expect(partner.first).toMatchObject({ type: 'synced', seq: 1 });

    // Stop: B is told, then hears nothing of A's private V11 (written) and V12 (deleted).
    await saveRange(NOTHING);
    expect(await partner.socket.next()).toMatchObject({
      type: 'context',
      change: 'stopped',
      epochId: e1,
    });
    await submitted(
      ownerSide.socket,
      submitMessage(diary, [edit(tab, (t) => t.insert(7, SECRET))]),
    );
    await submitted(
      ownerSide.socket,
      submitMessage(diary, [edit(tab, (t) => t.delete(7, SECRET.length))]),
    );
    const privatePoints = await query<{ public_id: string }>(
      'select public_id from diary_commits where diary_id = $1 and epoch_id is null',
      [diary.diaryId],
    );
    expect(privatePoints).toHaveLength(2);

    // Reopen: a new epoch and generation from a clean baseline.
    await saveRange(ALL);
    const opened = await partner.socket.next();
    expect(opened).toMatchObject({ type: 'context', change: 'opened' });
    if (opened.type !== 'context') throw new Error('expected context');
    expect(await partner.socket.quiet(100)).toEqual([]);
    const e2 = opened.epochId;
    expect(e2).not.toBe(e1);

    // Exit 1, opening: the live share and the frozen one.
    const live = await shared(b, diary.diaryId, e2);
    expect(live).toMatchObject({ share: 'live', seq: 0, generationId: opened.generationId });
    expect(leaks(bytesOf(live.state))).toBe(false);
    expect(textOf(bytesOf(live.state))).toBe('shared ');
    const frozen = await shared(b, diary.diaryId, e1);
    expect(frozen).toMatchObject({ share: 'frozen', seq: 1 });
    expect(leaks(bytesOf(frozen.state))).toBe(false);

    // Exit 2, catch-up: nothing after the baseline; the old epoch and generation refuse.
    const following = await subscribe(b, live, e2, 0);
    expect(following.first).toMatchObject({ type: 'synced', seq: 0, commits: [] });
    expect((await subscribe(b, diary, e1, 1)).first).toMatchObject({ code: 'STALE_CONTEXT' });
    expect((await subscribe(b, diary, e2, 0)).first).toMatchObject({ code: 'STALE_CONTEXT' });

    // Exit 3, broadcast: A's next commit reaches B as seq 1 of the new epoch, no gap.
    const reopened = await ownerView(a, diary.diaryId);
    const ownerAgain = await subscribe(a, reopened);
    const tab2 = writerFrom(reopened.state, 5102);
    await submitted(
      ownerAgain.socket,
      submitMessage(reopened, [edit(tab2, (t) => t.insert(7, 'again'))]),
    );
    const heard = await following.socket.next();
    expect(heard).toMatchObject({ type: 'commit', seq: 1 });
    if (heard.type !== 'commit') throw new Error('expected commit');
    expect(leaks(bytesOf(heard.delta))).toBe(false);
    expect(textOf(bytesOf(live.state), bytesOf(heard.delta))).toBe('shared again');

    // Exit 4, history: only E1 and E2 commits, private ones neither listed nor readable.
    const points = await historyOf(b, diary.diaryId);
    if (typeof points === 'string') throw new Error(points);
    const ids = points.map((p) => p.publicId);
    for (const { public_id } of privatePoints) {
      expect(ids).not.toContain(public_id);
      const res = await get(
        b,
        path(routes.historyVersion.path, { diaryId: diary.diaryId, publicId: public_id }),
      );
      expect(res.statusCode).toBe(404);
    }
    for (const id of ids) {
      const res = await get(
        b,
        path(routes.historyVersion.path, { diaryId: diary.diaryId, publicId: id }),
      );
      expect(res.body.includes(SECRET)).toBe(false);
    }
    const ownerPoints = await historyOf(a, diary.diaryId);
    if (typeof ownerPoints === 'string') throw new Error(ownerPoints);
    expect(ownerPoints.length).toBeGreaterThan(points.length);

    // Exit 5, the list: still one entry, live, without the private text.
    const listed = await get(b, path(routes.sharedDiaries.path, { spaceId }));
    expect(listed.body.includes(SECRET)).toBe(false);
    expect(routes.sharedDiaries.response.parse(listed.json()).diaries).toEqual([
      expect.objectContaining({ epochId: e2, share: 'live' }),
    ]);
    for (const socket of [ownerSide, partner, following, ownerAgain]) socket.socket.close();
  });
});

describe.runIf(testDatabaseUrl)('stopping races writing', () => {
  it('[adr:diary-collaboration-kernel#11] [adr:diary-collaboration-kernel#16] a partner write racing a stop lands in the frozen version or is refused, never after it', async () => {
    const { a, b, spaceId, saveRange } = await pair();
    const diary = await ownDiary(a);
    const outcomes: string[] = [];
    for (let round = 0; round < 12; round++) {
      if (round > 0) await saveRange(ALL);
      const [listed] = await sharedList(b, spaceId);
      const view = await shared(b, diary.diaryId, listed!.epochId);
      const partner = await subscribe(b, view, view.epochId, view.seq);
      const pen = writerFrom(view.state, 6000 + round);
      const message = submitMessage(
        view,
        [edit(pen, (t) => t.insert(0, `r${round}`))],
        view.epochId,
      );

      // The submit starts a little later each round, so it lands on both sides of the
      // stop's COMMIT across the rounds.
      const stopping = saveRange(NOTHING);
      await new Promise((resolve) => setTimeout(resolve, round * 2));
      const [answer] = await Promise.all([submitted(partner.socket, message), stopping]);

      const [epoch] = await query<{ frozen_version: string }>(
        'select frozen_version from share_epochs where id = $1',
        [view.epochId],
      );
      const committed = await query<{ version: string; epoch_id: string }>(
        'select version, epoch_id from diary_commits where diary_id = $1 and batch_id = $2',
        [diary.diaryId, message.batchId],
      );
      if (answer.type === 'ack') {
        expect(committed).toHaveLength(1);
        expect(committed[0]!.epoch_id).toBe(view.epochId);
        expect(Number(committed[0]!.version)).toBeLessThanOrEqual(Number(epoch!.frozen_version));
        outcomes.push('frozen-in');
      } else {
        expect(answer).toMatchObject({ type: 'error', code: 'STALE_CONTEXT' });
        expect(committed).toEqual([]);
        outcomes.push('refused');
      }
      partner.socket.close();
    }
    expect(outcomes).toHaveLength(12);
  });

  it('[adr:diary-collaboration-kernel#13] a frozen version stays unchanged when the owner writes privately and reopens', async () => {
    const { a, b, spaceId, saveRange } = await pair();
    const diary = await ownDiary(a);
    const e1 = (await sharedList(b, spaceId))[0]!.epochId;
    await saveRange(NOTHING);
    const before = await shared(b, diary.diaryId, e1);

    const ownerSide = await subscribe(a, diary);
    await submitted(
      ownerSide.socket,
      submitMessage(diary, [edit(writerFrom(diary.state, 7101), (t) => t.insert(0, 'later'))]),
    );
    await saveRange(ALL);

    expect(await shared(b, diary.diaryId, e1)).toEqual(before);
    ownerSide.socket.close();
  });
});

describe.runIf(testDatabaseUrl)('access', () => {
  it('[adr:diary-collaboration-kernel#14] a third person, a guessed epoch and the personal entry all answer NOT_FOUND', async () => {
    const { a, b, spaceId } = await pair();
    const c = await sessions.signIn('C');
    const diary = await ownDiary(a);
    const epochId = (await sharedList(b, spaceId))[0]!.epochId;
    const other = await ownDiary(b, '2026-10-21');

    expect((await openShared(c, diary.diaryId, epochId)).statusCode).toBe(404);
    expect((await openShared(b, other.diaryId, epochId)).statusCode).toBe(404);
    expect((await openShared(b, diary.diaryId, randomUUID())).statusCode).toBe(404);
    expect((await get(c, path(routes.sharedDiaries.path, { spaceId }))).statusCode).toBe(404);
    expect(await historyOf(c, diary.diaryId)).toBe('NOT_FOUND');
    expect((await get(b, path(routes.diary.path, { diaryId: diary.diaryId }))).statusCode).toBe(
      404,
    );
    expect(
      (
        await get(
          c,
          path(routes.character.path, { diaryId: diary.diaryId, clientId: 1, clock: 0 }) +
            `?epochId=${epochId}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await get(
          c,
          path(routes.receipt.path, { diaryId: diary.diaryId }) + `?batchId=${randomUUID()}`,
        )
      ).statusCode,
    ).toBe(404);

    expect((await subscribe(c, diary, epochId)).first).toMatchObject({ code: 'NOT_FOUND' });
    expect((await subscribe(b, diary)).first).toMatchObject({ code: 'NOT_FOUND' });
    const intruder = await connectSocket(app, c.cookie, ORIGIN);
    intruder.send(submitMessage(diary, [edit(client(8101), (t) => t.insert(0, 'x'))], epochId));
    expect(await intruder.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    // The partner may not write through the owner's personal entry.
    const sneaky = await connectSocket(app, b.cookie, ORIGIN);
    sneaky.send(submitMessage(diary, [edit(client(8102), (t) => t.insert(0, 'x'))]));
    expect(await sneaky.next()).toMatchObject({ type: 'error', code: 'STALE_CONTEXT' });
    intruder.close();
    sneaky.close();
  });
});

describe.runIf(testDatabaseUrl)('across generations and restarts', () => {
  it('[adr:diary-collaboration-kernel#18] [adr:diary-collaboration-kernel#27] keeps a character’s author and written time across a reopen, and frozen and history reads after a restart', async () => {
    const { a, b, spaceId, saveRange } = await pair();
    const diary = await ownDiary(a);
    const e1 = (await sharedList(b, spaceId))[0]!.epochId;
    const view = await shared(b, diary.diaryId, e1);
    const partner = await subscribe(b, view, e1, view.seq);
    await submitted(
      partner.socket,
      submitMessage(view, [edit(writerFrom(view.state, 9101), (t) => t.insert(0, 'B'))], e1),
    );
    partner.socket.close();
    const character = (epochId: string) =>
      get(
        b,
        path(routes.character.path, { diaryId: diary.diaryId, clientId: 9101, clock: 0 }) +
          `?epochId=${epochId}`,
      ).then((res) => routes.character.response.parse(res.json()));
    const before = await character(e1);

    await saveRange(NOTHING);
    await saveRange(ALL);
    const e2 = (await sharedList(b, spaceId))[0]!.epochId;
    expect(await character(e2)).toEqual(before);
    expect(await character(e1)).toEqual(before);

    const frozen = await shared(b, diary.diaryId, e1);
    const points = await historyOf(b, diary.diaryId);
    const restarted = await buildApp({
      publicOrigin: ORIGIN,
      currentUser: sessions.currentUser,
      db: database.db,
    });
    try {
      const again = await restarted.inject({
        method: 'GET',
        url: path(routes.sharedDiary.path, { diaryId: diary.diaryId, epochId: e1 }),
        headers: { cookie: b.cookie },
      });
      expect(routes.sharedDiary.response.parse(again.json()).diary).toEqual(frozen);
      const history = await restarted.inject({
        method: 'GET',
        url: path(routes.history.path, { diaryId: diary.diaryId }),
        headers: { cookie: b.cookie },
      });
      expect(routes.history.response.parse(history.json()).points).toEqual(points);
    } finally {
      await restarted.close();
    }
  });
});
