import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routes, type DateSelection } from '@between-pages/contracts';
import { buildApp } from '../app.ts';
import { createAddresses } from '../auth/email.ts';
import { parseConfig } from '../config.ts';
import { createDb, type Database } from '../db/client.ts';
import { createMailer } from '../mail/resend.ts';
import { createMailStore } from '../store/mail.ts';
import { reminderScope, reminders } from './notify.ts';
import { query, testDatabaseUrl } from '../../test/db.ts';
import { client, edit, testSessions } from '../../test/diary.ts';
import { startFakeResend, type FakeResend } from '../../test/resend.ts';
import { connectSocket } from '../../test/socket.ts';
import type { Scope } from '../notify/compose.ts';
import { createNotify, type Notify } from '../notify/notify.ts';

// Email reminders end to end on real PostgreSQL, the real router and socket for writing,
// a stand-in Resend and an injected clock (email-reminders 验收标准). Times are put days
// ahead of the real clock, so every commit already counts as a history point.

const ORIGIN = 'http://localhost:5173';
const KEY = randomBytes(32);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
let fake: FakeResend;
let notify: Notify;
const logs: string[] = [];

const notifierWith = (scope: Scope) =>
  createNotify({
    store: createMailStore(database.db),
    scope,
    addresses: createAddresses(database.db),
    mailer: createMailer({
      apiKey: 're_test',
      from: 'Between Pages <remind@mail.test>',
      baseUrl: fake.url,
    }),
    tokenKey: KEY,
    origin: ORIGIN,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  database = createDb(testDatabaseUrl);
  fake = await startFakeResend();
  app = await buildApp({
    publicOrigin: ORIGIN,
    currentUser: sessions.currentUser,
    db: database.db,
    mailTokenKey: KEY,
  });
  notify = notifierWith(reminderScope(null));
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  await fake?.close();
});

// Each test starts on its own UTC day, at 01:00, well after any earlier test's mails.
let base = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
beforeEach(() => {
  base += 10 * 24 * HOUR;
  fake?.reset();
});
const at = (minutes: number) => new Date(base + HOUR + minutes * MINUTE);

type Person = { id: string; cookie: string; email: string };
const path = (template: string, params: Record<string, string>) =>
  Object.entries(params).reduce((p, [k, v]) => p.replace(`:${k}`, v), template);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

async function person(name: string): Promise<Person> {
  const signed = await sessions.signIn(name);
  const email = `${name.toLowerCase()}-${signed.id}@mail.test`;
  await query('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    signed.id,
    name,
    email,
  ]);
  return { ...signed, email };
}

const JUNE: DateSelection = { include: [{ from: '2026-06-01', to: '2026-06-30' }], exclude: [] };

/** 小红 (A) and 小明 (B) bound; A shares June, B shares nothing. */
async function couple(aShares: DateSelection = JUNE) {
  const a = await person('小红');
  const b = await person('小明');
  const invited = routes.createInvitation.response.parse(
    (
      await send(a, 'POST', routes.createInvitation.path, {
        requestId: randomUUID(),
        sharingSelection: aShares,
      })
    ).json(),
  );
  const accepted = routes.acceptInvitation.response.parse(
    (
      await send(b, 'POST', routes.acceptInvitation.path, {
        token: invited.token,
        sharingSelection: { include: [], exclude: [] },
      })
    ).json(),
  );
  const { space, periodId } = accepted.binding;
  const unbind = async () =>
    expect(
      (
        await send(a, 'POST', path(routes.unbind.path, { spaceId: space.id }), {
          expectedPeriodId: periodId,
        })
      ).statusCode,
    ).toBe(200);
  const saveRange = async (selection: DateSelection) =>
    expect(
      (
        await send(a, 'PUT', path(routes.saveMySharing.path, { spaceId: space.id }), {
          requestId: randomUUID(),
          expectedPeriodId: periodId,
          expectedRevision: 1,
          selection,
        })
      ).statusCode,
    ).toBe(200);
  return { a, b, unbind, saveRange };
}

async function diaryOf(owner: Person, date: string) {
  const res = await send(owner, 'POST', routes.openDiary.path, { timezone: 'UTC', date });
  return routes.openDiary.response.parse(res.json()).diary.diaryId;
}

let nextClient = 91_000;
/** One change as `owner` in their own diary from a new editor instance; its clientID. */
async function write(owner: Person, diaryId: string, change: (text: Y.Text) => void) {
  const state = routes.diary.response.parse(
    (await get(owner, path(routes.diary.path, { diaryId }))).json(),
  ).diary;
  const socket = await connectSocket(app, owner.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId,
    generationId: state.generationId,
    knownSeq: state.seq,
  });
  expect(await socket.next()).toMatchObject({ type: 'synced' });
  const clientID = nextClient++;
  const batchId = randomUUID();
  socket.send({
    v: 1,
    type: 'submit',
    diaryId,
    batchId,
    generationId: state.generationId,
    operations: [
      {
        operationId: randomUUID(),
        update: base64(edit(client(clientID, bytesOf(state.state)), change)),
        writtenAt: '2026-06-20T09:00:00Z',
      },
    ],
  });
  for (;;) {
    const answer = await socket.next();
    if (answer.type === 'ack' && answer.receipt.batchId === batchId) break;
    if (answer.type === 'error') throw new Error(answer.code);
  }
  socket.close();
  return clientID;
}

const append = (text: string) => (t: Y.Text) => t.insert(t.length, text);

/** Mails the stand-in received for `who`. */
const mailsTo = (who: Person) => fake.requests.filter((r) => r.body.to === who.email);
const sends = (who: Person) =>
  query<{ id: string; category: string; status: string; error_code: string | null }>(
    'select id, category, status, error_code from mail_sends where user_id = $1 order by created_at',
    [who.id],
  );
/** Judges at `minutes` and sends whatever is due then. */
async function round(minutes: number, notifier = notify) {
  await notifier.judge(at(minutes));
  while (await notifier.sendNext(at(minutes)));
}

describe.runIf(testDatabaseUrl)('有新内容', () => {
  it('[adr:email-reminders#1] [adr:email-reminders#3] names only shared dates, previews 50 characters of new diary text, and counts a frozen share', async () => {
    const { a, b, saveRange } = await couple();
    const shared = await diaryOf(a, '2026-06-20');
    const secret = await diaryOf(a, '2026-07-05');
    await write(a, shared, append(`今天下班路上看到一只很胖的橘猫，${'喵'.repeat(60)}`));
    await write(a, secret, append('PRIVATE-WORDS'));
    // The share freezes; what it holds still counts (D3).
    await saveRange({ include: [{ from: '2026-06-01', to: '2026-06-19' }], exclude: [] });

    await round(0);
    expect(mailsTo(b)).toHaveLength(0);
    await round(61);
    const [mail] = mailsTo(b);
    expect(mail!.body.subject).toBe('小红写了新内容');
    expect(mail!.body.text).toContain('6 月 20 日的日记');
    expect(mail!.body.text).toContain(`「今天下班路上看到一只很胖的橘猫，${'喵'.repeat(34)}……」`);
    for (const part of [mail!.body.text, mail!.body.html, mail!.body.subject]) {
      expect(part).not.toContain('PRIVATE-WORDS');
      expect(part).not.toContain('7 月 5 日');
    }
    expect(mail!.body.headers).toEqual({
      'List-Unsubscribe': expect.stringMatching(
        /^<http:\/\/localhost:5173\/api\/mail\/unsubscribe\?token=.+>$/,
      ),
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    // The author is told nothing.
    expect(mailsTo(a)).toHaveLength(0);
  });

  it('waits an hour of unread, and sends nothing for text read meanwhile', async () => {
    const { a, b } = await couple();
    const diaryId = await diaryOf(a, '2026-06-21');
    const clientId = await write(a, diaryId, append('一段话'));
    await round(0);
    await round(59);
    expect(mailsTo(b)).toHaveLength(0);
    await send(b, 'POST', path(routes.reportRead.path, { diaryId }), {
      ranges: [{ clientId, from: 0, to: 3 }],
    });
    await round(61);
    await round(200);
    expect(mailsTo(b)).toHaveLength(0);
    expect(await sends(b)).toEqual([]);
  });

  it('[adr:email-reminders#4] [adr:email-reminders#5] reports text once, keeps 4 hours between mails and 2 a local day', async () => {
    const { a, b } = await couple();
    const diaryId = await diaryOf(a, '2026-06-22');
    await write(a, diaryId, append('第一段'));
    await round(0);
    await round(60);
    expect(mailsTo(b)).toHaveLength(1);
    // Reported text never mails again, read or not.
    await round(300);
    expect(mailsTo(b)).toHaveLength(1);

    await write(a, diaryId, append('第二段'));
    await round(305);
    await round(366);
    expect(mailsTo(b)).toHaveLength(2);
    expect(mailsTo(b)[1]!.body.text).toContain('「第二段」');

    await write(a, diaryId, append('第三段'));
    await round(370);
    // More than an hour unread and 4 hours on, but the day already had 2.
    await round(370 + 5 * 60);
    expect(mailsTo(b)).toHaveLength(2);
    // The next UTC day (B never reported a zone).
    await round(23 * 60);
    expect(mailsTo(b)).toHaveLength(3);
    expect(mailsTo(b)[2]!.body.text).toContain('「第三段」');
  });

  it('[adr:email-reminders#6] stays quiet in the sleep schedule and sends when it ends', async () => {
    const { a, b } = await couple();
    await send(b, 'PUT', routes.reportTimezone.path, { timezone: 'Asia/Shanghai' });
    await send(b, 'PUT', routes.saveSleep.path, { sleep: { start: 0, end: 480 } });
    const diaryId = await diaryOf(a, '2026-06-23');
    await write(a, diaryId, append('晚安'));
    // 01:00 UTC is 09:00 in Shanghai: seen now, due an hour later at 10:00.
    await round(0);
    await notify.judge(at(61));
    // The record is opened; Shanghai's midnight comes before it is worked.
    const quiet = 15 * 60 + 30; // 00:30 in Shanghai
    while (await notify.sendNext(at(quiet)));
    expect(mailsTo(b)).toHaveLength(0);
    const [row] = await query<{ next_attempt_at: Date; requested: boolean }>(
      "select next_attempt_at, requested from mail_sends where user_id = $1 and status = 'sending'",
      [b.id],
    );
    expect(row!.requested).toBe(false);
    expect(row!.next_attempt_at.toISOString()).toBe(at(23 * 60).toISOString()); // 08:00 there
    await round(23 * 60);
    expect(mailsTo(b)).toHaveLength(1);
  });

  it('[adr:email-reminders#2] sends nothing once unbound, and cancels a mail waiting to go', async () => {
    const { a, b, unbind } = await couple();
    const diaryId = await diaryOf(a, '2026-06-24');
    await write(a, diaryId, append('再见'));
    await round(0);
    await notify.judge(at(61));
    await unbind();
    while (await notify.sendNext(at(61)));
    await round(200);
    expect(mailsTo(b)).toHaveLength(0);
    expect(await sends(b)).toEqual([
      expect.objectContaining({ status: 'cancelled', error_code: 'unbound' }),
    ]);
  });

  it('[adr:email-reminders#8] retries a lost answer with the same key and content; Resend delivers once', async () => {
    const { a, b } = await couple();
    const diaryId = await diaryOf(a, '2026-06-25');
    await write(a, diaryId, append('只发一次'));
    await round(0);
    fake.next('accept-then-drop');
    await round(61);
    expect(await sends(b)).toEqual([expect.objectContaining({ status: 'sending' })]);
    await round(64);
    const requests = mailsTo(b);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.key).toBe(requests[1]!.key);
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    expect([...fake.delivered.values()].filter((d) => d.body.to === b.email)).toHaveLength(1);
    expect(await sends(b)).toEqual([expect.objectContaining({ status: 'sent' })]);
  });

  it('[adr:email-reminders#14] an unknown outcome counts toward limits but leaves the text to mail again', async () => {
    const { a, b } = await couple();
    const diaryId = await diaryOf(a, '2026-06-26');
    await write(a, diaryId, append('不明'));
    await round(0);
    fake.next('drop');
    await round(61);
    // A day later the record gives up as unknown.
    await query(
      "update mail_sends set created_at = created_at - interval '25 hours' where user_id = $1",
      [b.id],
    );
    while (await notify.sendNext(at(63)));
    expect(await sends(b)).toEqual([
      expect.objectContaining({ status: 'unknown', error_code: 'gave_up' }),
    ]);
    const [{ n }] = (await query<{ n: number }>(
      'select count(*)::int as n from mail_notified_ranges where user_id = $1',
      [b.id],
    )) as [{ n: number }];
    expect(n).toBe(0);
    // It counts as the last mail: not before 4 hours after its request.
    await round(61 + 3 * 60);
    expect(mailsTo(b)).toHaveLength(1);
    await round(61 + 4 * 60 + 5);
    expect(mailsTo(b)).toHaveLength(2);
    expect(mailsTo(b)[1]!.body.text).toContain('「不明」');
  });

  it('stops for good, as unknown, when the previewed text was deleted after a request', async () => {
    const { a, b } = await couple();
    const diaryId = await diaryOf(a, '2026-06-27');
    await write(a, diaryId, append('删掉的字还在'));
    await round(0);
    fake.next('drop');
    await round(61);
    // The previewed characters go; some of what the mail lists is still new.
    await write(a, diaryId, (t) => t.delete(0, 2));
    await round(64);
    expect(mailsTo(b)).toHaveLength(1);
    expect(await sends(b)).toEqual([
      expect.objectContaining({ status: 'unknown', error_code: 'preview_deleted' }),
    ]);
  });

  it('opens one record when two workers judge at once', async () => {
    const { a, b } = await couple();
    const diaryId = await diaryOf(a, '2026-06-28');
    await write(a, diaryId, append('并发'));
    await round(0);
    const other = notifierWith(reminderScope(null));
    await Promise.all([notify.judge(at(61)), other.judge(at(61))]);
    expect(await sends(b)).toHaveLength(1);
  });

  it('[adr:email-reminders#1] lists wishes and shared pages as the entry dots do, never a gift in preparation', async () => {
    const { a, b } = await couple();
    const wish = routes.createWish.response.parse(
      (
        await send(b, 'POST', routes.createWish.path, {
          requestId: randomUUID(),
          name: '围巾',
          link: null,
          note: null,
          want: null,
        })
      ).json(),
    ).wish;
    // A prepares a gift for B's wish: private to A, so nothing new for B.
    await send(a, 'POST', routes.prepareGift.path, { requestId: randomUUID(), wishId: wish.id });
    await round(0);
    await round(61);
    expect(mailsTo(b)).toHaveLength(0);

    await send(a, 'POST', routes.createWish.path, {
      requestId: randomUUID(),
      name: 'SECRET-WISH-NAME',
      link: null,
      note: null,
      want: null,
    });
    await round(62);
    await round(123);
    const [mail] = mailsTo(b);
    expect(mail!.body.subject).toBe('小红更新了心愿与礼物');
    expect(mail!.body.text).toContain('心愿与礼物有更新');
    expect(mail!.body.text).not.toContain('SECRET-WISH-NAME');
    expect(mail!.body.text).toContain(`${ORIGIN}/wishes`);
    const dots = routes.spaceUnread.response.parse((await get(b, routes.spaceUnread.path)).json());
    expect(dots.features.wishes).toBe(1);

    await send(a, 'POST', routes.createSharedPage.path, { requestId: randomUUID(), title: '' });
    await round(130);
    await round(123 + 4 * 60);
    expect(mailsTo(b)[1]!.body.subject).toBe('小红更新了共享页面');
  });
});

describe.runIf(testDatabaseUrl)('纪念日与备份', () => {
  it('[adr:email-reminders#12] mails a due anniversary once per target date, by the partner’s local date', async () => {
    const { a, b } = await couple();
    // A reports Tokyo; on B's mail the day is counted there (partner-local-dates D1).
    await send(a, 'PUT', routes.reportTimezone.path, { timezone: 'Asia/Tokyo' });
    const day = new Date(at(0).getTime() + 3 * 24 * HOUR);
    const created = await send(a, 'POST', `${routes.createAnniversary.path}?timezone=UTC`, {
      requestId: randomUUID(),
      kind: 'other',
      birthdayOf: null,
      name: '第一次见面',
      note: null,
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
    });
    expect(created.statusCode).toBe(200);
    await round(0);
    await round(10);
    await round(24 * 60);
    const mails = mailsTo(b);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body.subject).toBe('第一次见面还有 3 天');
  });

  it('[adr:email-reminders#12] mails a backup reason once in 24 hours, again when it changes', async () => {
    const b = await person('小明');
    let reason: 'failing' | 'reconnect' | null = 'failing';
    const plain = reminderScope(null);
    const withBackup = notifierWith((tx) => ({
      ...plain(tx),
      backupAttention: async (viewer) => (viewer === b.id ? reason : null),
    }));
    await round(0, withBackup);
    expect(mailsTo(b).map((m) => m.body.subject)).toEqual(['Google 备份一天没成功，正在自动重试']);
    reason = null;
    await round(60, withBackup);
    reason = 'failing';
    await round(120, withBackup);
    expect(mailsTo(b)).toHaveLength(1);
    reason = 'reconnect';
    await round(180, withBackup);
    reason = 'failing';
    await round(25 * 60, withBackup);
    expect(mailsTo(b).map((m) => m.body.subject)).toEqual([
      'Google 备份一天没成功，正在自动重试',
      'Google 备份需要重新连接',
      'Google 备份一天没成功，正在自动重试',
    ]);
    expect(mailsTo(b)[0]!.body.text).toContain(`${ORIGIN}/backup`);
  });

  it('[adr:email-reminders#9] sends nothing of a category switched off', async () => {
    const { a, b } = await couple();
    await send(b, 'PUT', routes.saveMail.path, { newContent: false });
    const diaryId = await diaryOf(a, '2026-06-29');
    await write(a, diaryId, append('关了'));
    await round(0);
    await round(61);
    expect(mailsTo(b)).toHaveLength(0);
    // Turned on again, the hour starts over.
    await send(b, 'PUT', routes.saveMail.path, { newContent: true });
    await round(62);
    await round(100);
    expect(mailsTo(b)).toHaveLength(0);
    await round(123);
    expect(mailsTo(b)).toHaveLength(1);
  });
});

describe.runIf(testDatabaseUrl)('the worker without Resend', () => {
  it('[adr:email-reminders#11] does not remind at all without RESEND_API_KEY', () => {
    const config = parseConfig({
      DATABASE_URL: testDatabaseUrl,
      PUBLIC_ORIGIN: ORIGIN,
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AUTH_PROVIDER: 'dev',
    });
    expect(reminders(config, database.db, null)).toBeNull();
  });

  it('[adr:email-reminders#10] logs no address, subject or diary text', () => {
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join('\n');
    expect(all).not.toMatch(/@mail\.test/);
    expect(all).not.toMatch(/写了新内容|更新了|还有 \d+ 天|Google 备份/);
    expect(all).not.toMatch(/橘猫|第一段|不明」|删掉的字|SECRET/);
  });
});
