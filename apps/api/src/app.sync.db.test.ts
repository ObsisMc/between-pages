import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_BYTES, closeCode, routes } from '@between-pages/contracts';
import { buildApp } from './app.ts';
import { createDb, type Database } from './db/client.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, countRows, edit, testSessions } from '../test/diary.ts';
import { connectSocket } from '../test/socket.ts';

// The collaboration socket through the real router and real PostgreSQL (kernel D9, D10).

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
    sessionEnded: sessions.onSessionEnded,
  });
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});
afterEach(() => {
  vi.useRealTimers();
});

const connect = (cookie: string, origin = ORIGIN) => connectSocket(app, cookie, origin);
type Socket = Awaited<ReturnType<typeof connect>>;

async function openDiary(cookie: string) {
  const res = await app.inject({
    method: 'POST',
    url: routes.openDiary.path,
    headers: { origin: ORIGIN, cookie },
    payload: { timezone: 'Asia/Shanghai', date: '2026-10-20' },
  });
  return routes.openDiary.response.parse(res.json()).diary;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function submit(
  diary: { diaryId: string; generationId: string },
  updates: Uint8Array[],
  batchId = randomUUID(),
) {
  return {
    v: 1,
    type: 'submit',
    diaryId: diary.diaryId,
    batchId,
    generationId: diary.generationId,
    operations: updates.map((update) => ({
      operationId: randomUUID(),
      update: base64(update),
      writtenAt: '2026-10-20T09:00:00+08:00',
    })),
  };
}

async function subscribed(cookie: string, diary: { diaryId: string; generationId: string }) {
  const socket = await connect(cookie);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId: diary.diaryId,
    generationId: diary.generationId,
    knownSeq: 0,
  });
  expect(await socket.next()).toMatchObject({ type: 'synced', seq: 0 });
  return socket;
}

const close = (...sockets: Socket[]) => sockets.forEach((s) => s.close());

describe.runIf(testDatabaseUrl)('handshake', () => {
  it('[adr:authentication-and-sessions#7] refuses another Origin and a missing session before upgrading', async () => {
    const { cookie } = await sessions.signIn();

    await expect(connect(cookie, 'https://evil.example')).rejects.toThrow('403');
    await expect(connect('')).rejects.toThrow('401');
    sessions.revoke(cookie);
    await expect(connect(cookie)).rejects.toThrow('401');
  });
});

describe.runIf(testDatabaseUrl)('commits over the socket', () => {
  it('[adr:diary-collaboration-kernel#6] acknowledges after commit and then broadcasts the server-encoded delta', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const writer = await subscribed(owner.cookie, diary);
    const reader = await subscribed(owner.cookie, diary);
    const message = submit(diary, [edit(client(501), (t) => t.insert(0, '晚安'))]);

    writer.send(message);
    const ack = await writer.next();
    const echoed = await writer.next();
    const heard = await reader.next();

    expect(ack).toMatchObject({
      type: 'ack',
      replayed: false,
      receipt: { batchId: message.batchId, seq: 1 },
    });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    expect(echoed).toEqual(heard);
    expect(heard).toMatchObject({
      type: 'commit',
      seq: 1,
      bindings: [{ clientId: 501, userId: owner.id }],
    });
    const replica = client(0);
    Y.applyUpdate(replica, Buffer.from(heard.type === 'commit' ? heard.delta : '', 'base64'));
    expect(replica.getText('body').toString()).toBe('晚安');
    close(writer, reader);
  });

  it('[adr:diary-collaboration-kernel#7] [adr:diary-collaboration-kernel#8] rejects a batch with one bad operation as a whole and broadcasts nothing of it', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const writer = await subscribed(owner.cookie, diary);
    const reader = await subscribed(owner.cookie, diary);
    const tab = client(502);
    const good = edit(tab, (t) => t.insert(0, 'good '));

    writer.send(submit(diary, [good, new Uint8Array([9, 9, 9, 255])]));
    expect(await writer.next()).toMatchObject({
      type: 'error',
      code: 'EDIT_REJECTED',
      reason: 'MALFORMED_UPDATE',
      index: 1,
    });
    writer.send(submit(diary, [good]));
    await writer.next(); // ack

    // The first thing the reader hears is the later batch, at seq 1.
    expect(await reader.next()).toMatchObject({ type: 'commit', seq: 1 });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    close(writer, reader);
  });

  it('[adr:diary-collaboration-kernel#10] commits once when two connections deliver the same batch at once', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const first = await connect(owner.cookie);
    const second = await connect(owner.cookie);
    const message = submit(diary, [edit(client(503), (t) => t.insert(0, 'same'))]);

    first.send(message);
    second.send(message);
    const acks = [await first.next(), await second.next()];

    expect(acks.map((a) => a.type === 'ack' && a.replayed).sort()).toEqual([false, true]);
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    expect(await countRows('backup_outbox', diary.diaryId)).toBe(1);
    close(first, second);
  });

  it('[adr:diary-collaboration-kernel#10] answers a resend after a lost ACK with the original receipt, also by receipt query', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const message = submit(diary, [edit(client(504), (t) => t.insert(0, 'kept once'))]);
    const lost = await connect(owner.cookie);
    lost.send(message);
    const original = await lost.next(); // the client never processes this one
    lost.close();

    const retry = await connect(owner.cookie);
    retry.send(message);
    const replay = await retry.next();
    const queried = await app.inject({
      method: 'GET',
      url: `${routes.receipt.path.replace(':diaryId', diary.diaryId)}?operationId=${message.operations[0]!.operationId}`,
      headers: { cookie: owner.cookie },
    });

    expect(replay).toEqual({ ...original, replayed: true });
    expect(routes.receipt.response.parse(queried.json()).receipt).toEqual(
      original.type === 'ack' && original.receipt,
    );
    expect(await countRows('diary_commits', diary.diaryId)).toBe(1);
    close(retry);
  });

  it('catches a reconnecting client up from its known seq', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const writer = await connect(owner.cookie);
    const tab = client(505);
    for (const text of ['a', 'b', 'c']) {
      writer.send(submit(diary, [edit(tab, (t) => t.insert(t.length, text))]));
      await writer.next();
    }

    const late = await connect(owner.cookie);
    late.send({
      v: 1,
      type: 'subscribe',
      diaryId: diary.diaryId,
      generationId: diary.generationId,
      knownSeq: 1,
    });

    expect(await late.next()).toMatchObject({
      type: 'synced',
      seq: 3,
      commits: [{ seq: 2 }, { seq: 3 }],
    });
    close(writer, late);
  });

  it('answers STALE_CONTEXT for another generation and NOT_FOUND for a diary of someone else', async () => {
    const owner = await sessions.signIn();
    const stranger = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const socket = await connect(stranger.cookie);
    const mine = await connect(owner.cookie);

    socket.send({
      v: 1,
      type: 'subscribe',
      diaryId: diary.diaryId,
      generationId: diary.generationId,
      knownSeq: 0,
    });
    socket.send(submit(diary, [edit(client(506), (t) => t.insert(0, 'intrusion'))]));
    mine.send({
      v: 1,
      type: 'subscribe',
      diaryId: diary.diaryId,
      generationId: randomUUID(),
      knownSeq: 0,
    });

    expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    expect(await mine.next()).toMatchObject({ type: 'error', code: 'STALE_CONTEXT' });
    expect(await countRows('diary_commits', diary.diaryId)).toBe(0);
    close(socket, mine);
  });
});

describe.runIf(testDatabaseUrl)('sessions on an open socket', () => {
  it('[adr:authentication-and-sessions#8] [adr:diary-collaboration-kernel#24] refuses a write after the session ends and closes the connection', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const socket = await connect(owner.cookie);
    sessions.revoke(owner.cookie);

    socket.send(submit(diary, [edit(client(507), (t) => t.insert(0, 'after sign-out'))]));

    expect(await socket.closed).toBe(closeCode.UNAUTHENTICATED);
    expect(await countRows('diary_commits', diary.diaryId)).toBe(0);
  });

  it('[adr:diary-collaboration-kernel#24] closes a connection as soon as its session ends, without waiting for a write', async () => {
    const owner = await sessions.signIn();
    const other = await sessions.signIn();
    const socket = await connect(owner.cookie);
    const untouched = await connect(other.cookie);

    sessions.revoke(owner.cookie);

    expect(await socket.closed).toBe(closeCode.UNAUTHENTICATED);
    expect(await untouched.quiet(50)).toEqual([]);
    untouched.close();
  });

  it('[adr:diary-collaboration-kernel#24] closes an idle connection within 60 seconds of its session ending unannounced', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const owner = await sessions.signIn();
    const socket = await connect(owner.cookie);
    // Expiry or another instance: the session is gone but no event says so.
    sessions.expire(owner.cookie);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await socket.closed).toBe(closeCode.UNAUTHENTICATED);
  });
});

describe.runIf(testDatabaseUrl)('protocol', () => {
  it('answers each malformed message with its error code and keeps serving', async () => {
    const owner = await sessions.signIn();
    const diary = await openDiary(owner.cookie);
    const socket = await connect(owner.cookie);
    const valid = submit(diary, [edit(client(508), (t) => t.insert(0, 'x'))]);

    socket.send('not json');
    socket.send({ ...valid, v: 2 });
    socket.send({ ...valid, actor: randomUUID() });
    socket.send(JSON.stringify(valid).padEnd(MAX_MESSAGE_BYTES + 1, ' '));
    socket.send(valid);

    const codes = [];
    for (let i = 0; i < 4; i++) {
      const message = await socket.next();
      codes.push(message.type === 'error' && message.code);
    }
    expect(codes).toEqual([
      'VALIDATION_FAILED',
      'PROTOCOL_UNSUPPORTED',
      'VALIDATION_FAILED',
      'PAYLOAD_TOO_LARGE',
    ]);
    expect(await socket.next()).toMatchObject({ type: 'ack' });
    expect(
      await query('select count(*)::int as n from diary_commits where diary_id = $1', [
        diary.diaryId,
      ]),
    ).toEqual([{ n: 1 }]);
    close(socket);
  });
});
