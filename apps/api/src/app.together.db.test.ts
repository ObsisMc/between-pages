import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorBody, routes, type ResponseOf } from '@between-pages/contracts';
import { createAnniversaryService } from './anniversaries/anniversaries.ts';
import { buildApp } from './app.ts';
import type { DriveConfig } from './backup/backup.ts';
import { createTogetherCopy } from './backup/together.ts';
import { createDb, type Database } from './db/client.ts';
import { DOC_TYPE, FOLDER_TYPE } from './google/docs.ts';
import { createSharedPageService } from './shared-pages/shared-pages.ts';
import { createSpaceRecords } from './space-records/space-records.ts';
import { createReminderStore } from './store/anniversaries.ts';
import { createCopyStore } from './store/copy.ts';
import { createSpaceRecordStore } from './store/space-records.ts';
import { createTogetherStore } from './store/together.ts';
import { createWishService } from './wishes/wishes.ts';
import { checkDrives } from './worker/check.ts';
import { togetherNext } from './worker/together.ts';
import { query, testDatabaseUrl } from '../test/db.ts';
import { client, edit, testSessions } from '../test/diary.ts';
import { startFakeGoogle, type FakeFile, type FakeGoogle } from '../test/google.ts';
import { connectSocket } from '../test/socket.ts';

// The `Together` Docs end to end (google-copy-beyond-diaries): writes through the real
// routes and sync socket into PostgreSQL, the worker's outbox intake and item writes, and a
// local stand-in for Drive and Docs. Time moves by handing the worker a later `now`: a
// summary waits two minutes, a page for its history point (two minutes of quiet).

const ORIGIN = 'http://localhost:5173';
const sessions = testSessions();
let database: Database;
let app: FastifyInstance;
let google: FakeGoogle;
let drive: DriveConfig;
let together: ReturnType<typeof createTogetherCopy>;
let deps: Parameters<typeof togetherNext>[0];
let pages: ReturnType<typeof createSharedPageService>;

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  google = await startFakeGoogle();
  drive = {
    client: {
      clientId: 'client-id',
      clientSecret: 'client-SECRET',
      redirectUri: `${ORIGIN}/backup/google/callback`,
      endpoints: google.endpoints,
    },
    tokenKey: randomBytes(32),
    testing: false,
  };
  database = createDb(testDatabaseUrl);
  app = await buildApp({
    publicOrigin: ORIGIN,
    currentUser: sessions.currentUser,
    db: database.db,
    drive,
  });
  const records = createSpaceRecords(createSpaceRecordStore(database.db));
  pages = createSharedPageService(records);
  const store = createTogetherStore(database.db);
  together = createTogetherCopy(store, {
    pages,
    wishes: createWishService(records),
    anniversaries: createAnniversaryService(records, createReminderStore(database.db)),
  });
  deps = { copy: together, store, copyStore: createCopyStore(database.db), drive };
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  await google?.close();
});
beforeEach(() => {
  if (!google) return;
  google.state.down = false;
  google.state.storageFull = false;
  google.state.renameBumpsRevision = false;
});

type Person = { id: string; cookie: string; permissionId: string; name: string };
type Binding = ResponseOf<'acceptInvitation'>['binding'];
const MINUTE = 60_000;
const path = (template: string, id: string) => template.replace(/:\w+/, id);
const get = (who: Person, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
const send = (who: Person, method: 'POST' | 'PUT', url: string, payload: object = {}) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: who.cookie }, payload });
const ok = async <T>(res: Promise<{ statusCode: number; body: string; json(): unknown }>) => {
  const answer = await res;
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json() as T;
};

async function person(name: string): Promise<Person> {
  return { ...(await sessions.signIn(name)), permissionId: `perm-${randomUUID()}`, name };
}

async function connect(who: Person, permissionId = who.permissionId) {
  const started = await send(who, 'POST', routes.startGoogleConnection.path);
  const { url } = routes.startGoogleConnection.response.parse(started.json());
  return send(who, 'POST', routes.finishGoogleConnection.path, google.consent(url, permissionId));
}

async function invite(a: Person, b: Person): Promise<Binding> {
  const { token } = await ok<{ token: string }>(
    send(a, 'POST', routes.createInvitation.path, {
      requestId: randomUUID(),
      sharingSelection: null,
    }),
  );
  return (
    await ok<ResponseOf<'acceptInvitation'>>(
      send(b, 'POST', routes.acceptInvitation.path, { token, sharingSelection: null }),
    )
  ).binding;
}

/** Two people, bound and both connected to their own Drive. */
async function couple() {
  const a = await person('Ann');
  const b = await person('Bo');
  const binding = await invite(a, b);
  for (const who of [a, b]) expect((await connect(who)).statusCode).toBe(200);
  return { a, b, binding };
}

/**
 * The worker for these people: their outbox rows become work now, and every item due by
 * `minutes` from now is written, history points formed by then.
 */
async function drain(people: Person[], minutes = 11) {
  await together.intake(
    new Date(),
    people.map((p) => p.id),
  );
  const at = new Date(Date.now() + minutes * MINUTE);
  while (await togetherNext(deps, at));
}

/** The legend in slot order: the pair's user IDs sorted, as on the day Doc. */
const legend = (...pair: Person[]) =>
  [...pair]
    .sort((x, y) => (x.id < y.id ? -1 : 1))
    .map((p) => `■ ${p.name}`)
    .join('   ');
const docs = (who: Person) => google.docs(who.permissionId);
const docNamed = (who: Person, name: string) => docs(who).find((d) => d.name === name);
const folderPath = (file: FakeFile): string[] => {
  const parent = file.parents[0] && google.state.files.get(file.parents[0]);
  return parent ? [...folderPath(parent), parent.name] : [];
};
const workOf = async (who: Person) =>
  (
    await query<{ item: string }>(
      `select item from google_item_work where user_id = $1 order by item`,
      [who.id],
    )
  ).map((r) => r.item);
const backup = async (who: Person) =>
  routes.backup.response.parse((await get(who, routes.backup.path)).json()).backup;
const openPage = async (who: Person, id: string) =>
  routes.sharedPage.response.parse((await get(who, path(routes.sharedPage.path, id))).json());

const createPage = async (who: Person, title: string) =>
  (
    await ok<ResponseOf<'createSharedPage'>>(
      send(who, 'POST', routes.createSharedPage.path, { requestId: randomUUID(), title }),
    )
  ).page;

let nextClient = 7100;
/** Types into a page from a new editor instance over the real socket, and waits for the ACK. */
async function typeInPage(who: Person, pageId: string, text: string) {
  const view = await openPage(who, pageId);
  const socket = await connectSocket(app, who.cookie, ORIGIN);
  socket.send({
    v: 1,
    type: 'subscribe',
    diaryId: pageId,
    generationId: view.generationId,
    knownSeq: view.seq,
  });
  expect(await socket.next()).toMatchObject({ type: 'synced' });
  const batchId = randomUUID();
  const doc = client(nextClient++, Buffer.from(view.state, 'base64'));
  socket.send({
    v: 1,
    type: 'submit',
    diaryId: pageId,
    batchId,
    generationId: view.generationId,
    operations: [
      {
        operationId: randomUUID(),
        update: Buffer.from(edit(doc, (t) => t.insert(t.length, text))).toString('base64'),
        writtenAt: '2026-11-18T09:00:00+08:00',
      },
    ],
  });
  for (;;) {
    const answer = await socket.next();
    if (answer.type === 'ack' && answer.receipt.batchId === batchId) break;
    if (answer.type === 'error') throw new Error(answer.code);
  }
  socket.close();
}

const createWish = async (who: Person, name: string) =>
  (
    await ok<ResponseOf<'createWish'>>(
      send(who, 'POST', routes.createWish.path, {
        requestId: randomUUID(),
        name,
        link: null,
        note: null,
        want: 3,
      }),
    )
  ).wish;
const prepare = async (giver: Person, wishId: string) =>
  (
    await ok<ResponseOf<'prepareGift'>>(
      send(giver, 'POST', routes.prepareGift.path, { requestId: randomUUID(), wishId }),
    )
  ).gift;
const card = async (giver: Person, giftId: string, expectedRevision: number | null, text: string) =>
  (
    await ok<ResponseOf<'saveGiftCard'>>(
      send(giver, 'PUT', path(routes.saveGiftCard.path, giftId), { expectedRevision, text }),
    )
  ).gift;

/** What a person's Drive and backup state look like, to compare before and after a step. */
async function footprint(who: Person) {
  const status = await backup(who);
  return {
    docs: docs(who).map((d) => ({ id: d.id, name: d.name, text: d.text, revision: d.revision })),
    work: await workOf(who),
    progress: status.progress,
    events: status.events,
  };
}

describe.runIf(testDatabaseUrl)('the Together copy', () => {
  it('[adr:google-copy-beyond-diaries#1] [adr:google-copy-beyond-diaries#4] writes a page into each Drive once its history point forms, in its authors colors', async () => {
    const { a, b } = await couple();
    const page = await createPage(a, '旅行清单');
    await typeInPage(a, page.id, '机票');
    await typeInPage(b, page.id, '酒店');

    // Committed but no history point yet: no Doc, and the page says so.
    await drain([a, b], 0);
    expect(docNamed(a, '旅行清单')).toBeUndefined();
    expect((await openPage(a, page.id)).google).toEqual({
      connected: true,
      docUrl: null,
      coveredAt: null,
      problem: null,
    });

    await drain([a, b]);
    for (const who of [a, b]) {
      const doc = docNamed(who, '旅行清单')!;
      expect(folderPath(doc)).toEqual(['Between Pages', 'Together', 'Shared pages']);
      expect(doc.text).toBe(`旅行清单\n${legend(a, b)}\n机票酒店`);
      expect(doc.headings).toEqual([{ text: '旅行清单', level: 1 }]);
      // Each run in its author's slot color, the same in both Drives.
      const colorOf = (text: string) => doc.colors.find((c) => c.text === text)!.rgb;
      expect(colorOf('机票')).toEqual(colorOf('■ Ann'));
      expect(colorOf('酒店')).toEqual(colorOf('■ Bo'));
      expect(colorOf('酒店')).not.toEqual(colorOf('机票'));
      const view = await openPage(who, page.id);
      expect(view.google.docUrl).toBe(`https://docs.google.com/document/d/${doc.id}/edit`);
      expect(view.google.coveredAt).not.toBeNull();
    }
    const status = await backup(a);
    expect(status.progress!.categories.find((c) => c.category === 'shared_pages')).toMatchObject({
      waiting: 0,
    });
  });

  it('[adr:google-copy-beyond-diaries#4] writes a summary two minutes after its last change, at the latest ten after the first', async () => {
    const { a, b } = await couple();
    await drain([a, b]);
    const t0 = Date.now();
    await createWish(a, '围巾');
    await together.intake(new Date(t0), [a.id]);
    const readyAt = async () =>
      (
        await query<{ ready_at: Date }>(
          `select ready_at from google_item_work where user_id = $1 and item = 'wishes'`,
          [a.id],
        )
      )[0]!.ready_at.getTime();
    expect(await readyAt()).toBe(t0 + 2 * MINUTE);
    for (const minutes of [1.5, 5, 9]) {
      await createWish(a, `心愿 ${minutes}`);
      await together.intake(new Date(t0 + minutes * MINUTE), [a.id]);
    }
    expect(await readyAt()).toBe(t0 + 10 * MINUTE);

    // Before it is due nothing is written; "现在备份" writes it at once.
    while (await togetherNext(deps, new Date(t0 + 9 * MINUTE)));
    expect(docNamed(a, 'Wishes')!.text).not.toContain('围巾');
    await send(a, 'POST', routes.runBackup.path);
    while (await togetherNext(deps, new Date()));
    expect(docNamed(a, 'Wishes')!.text).toContain('围巾');
  });

  it('[adr:google-copy-beyond-diaries#2] a gift in preparation reaches only the giver, at every step until it is revealed', async () => {
    const { a, b } = await couple();
    const wish = await createWish(a, '灰色围巾');
    await drain([a, b]);
    const before = await footprint(a);
    expect(docNamed(a, 'Wishes')!.text).toContain('灰色围巾');

    // Each private step: the receiver's Docs, work, progress and problems stay the same.
    const steps: [string, () => Promise<unknown>][] = [];
    let giftId = '';
    let revision = 0;
    steps.push([
      'prepare',
      async () => {
        giftId = (await prepare(b, wish.id)).id;
      },
    ]);
    steps.push([
      'write the card',
      async () => {
        revision = (await card(b, giftId, null, '生日快乐')).card!.revision;
      },
    ]);
    steps.push(['edit the card', () => card(b, giftId, revision, '生日快乐，一直暖和')]);
    for (const [, step] of steps) {
      await step();
      await together.intake(new Date(), [a.id, b.id]);
      expect(await workOf(a)).toEqual([]);
      await drain([a, b]);
      expect(await footprint(a)).toEqual(before);
    }
    expect(docNamed(b, 'Gifts')!.text).toContain('准备中（还没揭晓，只在你的 Drive 里）');
    expect(docNamed(b, 'Gifts')!.text).toContain('卡片（Bo 写）：生日快乐，一直暖和');
    expect(docNamed(b, 'Wishes')!.text).toContain('灰色围巾  ♥♥♥  · 我在准备');

    // Stopping: gone from the giver's section, and the receiver never had it.
    await ok(send(b, 'POST', path(routes.deleteGift.path, giftId), { requestId: randomUUID() }));
    await together.intake(new Date(), [a.id, b.id]);
    expect(await workOf(a)).toEqual([]);
    await drain([a, b]);
    expect(await footprint(a)).toEqual(before);
    expect(docNamed(b, 'Gifts')!.text).not.toContain('准备中');
    expect(docNamed(b, 'Wishes')!.text).not.toContain('我在准备');

    // Revealed: on both walls, with its card.
    const again = await prepare(b, wish.id);
    await card(b, again.id, null, '惊喜');
    await drain([a, b]);
    expect(await footprint(a)).toEqual(before);
    await ok(send(b, 'POST', path(routes.revealGift.path, again.id), { requestId: randomUUID() }));
    await drain([a, b]);
    for (const who of [a, b]) {
      const gifts = docNamed(who, 'Gifts')!.text;
      expect(gifts).toContain('灰色围巾  Bo 送给 Ann');
      expect(gifts).toContain('卡片（Bo 写）：惊喜');
      expect(gifts).not.toContain('准备中');
      expect(docNamed(who, 'Wishes')!.text).not.toContain('灰色围巾');
    }
  });

  it('[adr:google-copy-beyond-diaries#3] writes each item into one Doc, and only when it changed', async () => {
    const { a, b } = await couple();
    await createWish(a, '书');
    await drain([a, b]);
    const count = () => docs(a).filter((d) => d.name === 'Wishes').length;
    const writes = () => google.state.calls.filter((c) => c.endsWith(':batchUpdate')).length;
    const before = writes();
    await send(a, 'POST', routes.runBackup.path);
    await drain([a]);
    await query(
      `insert into google_item_work (user_id, item) values ($1, 'wishes') on conflict do nothing`,
      [a.id],
    );
    await drain([a]);
    expect(count()).toBe(1);
    expect(writes()).toBe(before);
    const doc = docNamed(a, 'Wishes')!;
    await createWish(a, '笔');
    await drain([a]);
    expect(docNamed(a, 'Wishes')!.id).toBe(doc.id);
    expect(count()).toBe(1);
  });

  it('[adr:google-copy-beyond-diaries#5] sets a summary changed in Google aside, remakes a deleted one, and never deletes in Drive', async () => {
    const { a, b } = await couple();
    await createWish(a, '茶');
    await drain([a, b]);
    const first = docNamed(a, 'Wishes')!;
    google.editInGoogle(first.id, '我加的');
    await createWish(a, '杯子');
    await drain([a]);
    expect(google.state.files.get(first.id)!.name).toBe('Wishes（在 Google 改过，已停止更新）');
    expect(google.state.files.get(first.id)!.text).toContain('我加的');
    const second = docNamed(a, 'Wishes')!;
    expect(second.id).not.toBe(first.id);
    expect(second.text).toContain('杯子');
    expect((await backup(a)).events[0]).toMatchObject({
      kind: 'doc_replaced',
      item: { kind: 'wishes', pageId: null },
    });

    // Deleted in Drive: the daily check queues it and the next write makes a new one.
    google.remove(second.id);
    await checkDrives({ store: createCopyStore(database.db), together: deps.store, drive });
    await drain([a]);
    expect(docNamed(a, 'Wishes')!.id).not.toBe(second.id);
    expect((await backup(a)).events[0]).toMatchObject({ kind: 'doc_recreated' });
    expect(google.state.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('[adr:google-copy-beyond-diaries#3] [adr:google-copy-beyond-diaries#5] renames a page Doc with its title, and a rename left unrecorded is not taken for an edit', async () => {
    // Only A's Drive, so the one rename the hooks below see is A's.
    const a = await person('Ann');
    const b = await person('Bo');
    await invite(a, b);
    expect((await connect(a)).statusCode).toBe(200);
    const page = await createPage(a, '周末');
    await drain([a, b]);
    const doc = docNamed(a, '周末')!;
    google.state.renameBumpsRevision = true;

    // The worker stops between renaming and recording the revision the rename produced.
    await ok(
      send(b, 'PUT', path(routes.renameSharedPage.path, page.id), {
        requestId: randomUUID(),
        expectedRevision: page.revision,
        title: '周末计划',
      }),
    );
    google.state.afterRename = () => {
      google.state.down = true;
    };
    await drain([a]);
    expect(google.state.files.get(doc.id)!.name).toBe('周末计划');
    google.state.down = false;
    await query(`update google_item_work set ready_at = now() where user_id = $1`, [a.id]);
    await drain([a]);
    expect(docs(a).filter((d) => d.name.startsWith('周末'))).toHaveLength(1);
    expect(google.state.files.get(doc.id)).toMatchObject({
      name: '周末计划',
      text: `周末计划\n${legend(a, b)}\n`,
    });

    // The same, but someone edits the Doc meanwhile: that is an edit, set aside.
    await ok(
      send(a, 'PUT', path(routes.renameSharedPage.path, page.id), {
        requestId: randomUUID(),
        expectedRevision: page.revision + 1,
        title: '周末安排',
      }),
    );
    google.state.afterRename = (file) => {
      google.state.down = true;
      file.text += '手写';
    };
    await drain([a]);
    google.state.down = false;
    await query(`update google_item_work set ready_at = now() where user_id = $1`, [a.id]);
    await drain([a]);
    expect(google.state.files.get(doc.id)!.name).toBe('周末安排（在 Google 改过，已停止更新）');
    expect(docNamed(a, '周末安排')!.id).not.toBe(doc.id);
  });

  it('[adr:google-copy-beyond-diaries#6] [adr:google-copy-beyond-diaries#1] a page deleted in the app keeps its last text under a new name, and a deleted wish leaves its summary', async () => {
    const { a, b } = await couple();
    const page = await createPage(a, '清单');
    await typeInPage(a, page.id, '第一行');
    await drain([a, b]);
    const wish = await createWish(b, '耳机');
    await typeInPage(b, page.id, '最后一句');

    // Deleted before its last commit formed a history point: that commit is still written.
    await ok(
      send(b, 'POST', path(routes.deleteSharedPage.path, page.id), { requestId: randomUUID() }),
    );
    await ok(send(b, 'POST', path(routes.deleteWish.path, wish.id), { requestId: randomUUID() }));
    await drain([a, b], 0);
    for (const who of [a, b]) {
      const doc = docNamed(who, '清单（已在应用中删除）')!;
      expect(doc.text).toBe(`清单\n${legend(a, b)}\n第一行最后一句`);
    }
    expect((await get(a, path(routes.sharedPage.path, page.id))).statusCode).toBe(404);
    await drain([a, b]);
    expect(docNamed(b, 'Wishes')!.text).not.toContain('耳机');

    // Never written or made again: not by a later change, nor once deleted in Drive.
    const doc = docNamed(a, '清单（已在应用中删除）')!;
    google.trash(doc.id);
    await checkDrives({ store: createCopyStore(database.db), together: deps.store, drive });
    await query(
      `insert into google_item_work (user_id, item) values ($1, $2) on conflict do nothing`,
      [a.id, `page:${page.id}`],
    );
    await drain([a]);
    expect(docs(a).filter((d) => d.name.startsWith('清单'))).toHaveLength(1);

    // Only the space's two people reach the copy entry; anyone else finds nothing.
    const c = await person('Cy');
    expect(await pages.copySource(c.id, page.id)).toBeNull();
    expect(await pages.copySource(a.id, page.id)).toMatchObject({ deleted: true });
    // The backup page names the deleted page by the title its Doc last got.
    expect(await pages.titles(a.id, [page.id])).toEqual(new Map());
  });

  it('[adr:google-copy-beyond-diaries#7] [adr:google-copy-beyond-diaries#8] page and record writes queue no diary work and do not wait for Google', async () => {
    const { a, b } = await couple();
    google.state.down = true;
    const page = await createPage(a, '账本');
    await typeInPage(a, page.id, '午饭');
    await createWish(b, '伞');
    const [counts] = await query<{ outbox: number; days: number; space: number }>(
      `select (select count(*)::int from backup_outbox where diary_id = $1) outbox,
              (select count(*)::int from google_day_work where user_id in ($2, $3)) days,
              (select count(*)::int from space_copy_outbox
                where space_id = (select space_id from shared_pages where id = $1)) space`,
      [page.id, a.id, b.id],
    );
    expect(counts).toEqual({ outbox: 0, days: 0, space: 3 });

    // Google down: the failure is shown on the backup page and the page, and retried.
    await drain([a, b]);
    const status = await backup(a);
    expect(status.progress!.failingItems).toContainEqual({
      item: { kind: 'page', pageId: page.id, title: '账本' },
      failure: 'unreachable',
    });
    expect((await openPage(a, page.id)).google.problem).toBe('unreachable');
    expect(status.events.some((e) => e.kind === 'copy_failing')).toBe(true);

    // A full Drive on a page or summary puts up the same banner and mail as on a day (D8).
    google.state.down = false;
    google.state.storageFull = true;
    await createWish(a, '雨衣');
    await send(a, 'POST', routes.runBackup.path);
    while (await togetherNext(deps, new Date()));
    expect((await backup(a)).attention).toBe('storage_full');
  });

  it("[adr:google-copy-beyond-diaries#9] shows a person's backup state only to them", async () => {
    const a = await person('Ann');
    const b = await person('Bo');
    await invite(a, b);
    expect((await connect(a)).statusCode).toBe(200);
    const page = await createPage(a, '只看自己');
    await drain([a, b]);
    expect((await openPage(a, page.id)).google.connected).toBe(true);
    expect((await openPage(b, page.id)).google).toEqual({
      connected: false,
      docUrl: null,
      coveredAt: null,
      problem: null,
    });
    expect((await backup(b)).google.state).toBe('disconnected');
    expect(docs(b)).toEqual([]);
  });

  it('[adr:google-copy-beyond-diaries#10] marks every Together Doc after unbinding and clears the mark on rebinding', async () => {
    const { a, b, binding } = await couple();
    await createPage(a, '一起');
    await drain([a, b]);
    await ok(
      send(a, 'POST', path(routes.unbind.path, binding.space.id), {
        expectedPeriodId: binding.periodId,
      }),
    );
    await drain([a, b]);
    for (const who of [a, b])
      for (const name of ['一起', 'Wishes', 'Gifts', 'Anniversaries'])
        expect(docNamed(who, name)!.text.split('\n')[1]).toBe('（已解绑，内容不再更新）');
    await invite(b, a);
    await drain([a, b]);
    for (const who of [a, b])
      for (const name of ['一起', 'Wishes', 'Gifts', 'Anniversaries'])
        expect(docNamed(who, name)!.text).not.toContain('已解绑');
  });

  it('[adr:google-copy-beyond-diaries#11] writes only Docs and folders into Drive', async () => {
    const { a, b } = await couple();
    await createPage(a, '杂项');
    await createWish(a, '花');
    await ok(
      send(b, 'POST', `${routes.createAnniversary.path}?timezone=Asia%2FShanghai`, {
        requestId: randomUUID(),
        kind: 'together',
        birthdayOf: null,
        name: null,
        note: '那天下雨',
        year: 2024,
        month: 5,
        day: 20,
      }),
    );
    await drain([a, b]);
    expect(docNamed(a, 'Anniversaries')!.text).toContain(
      '在一起的日子  2024 年 5 月 20 日\n备注：那天下雨（Bo 记的）',
    );
    const mine = [...google.state.files.values()].filter((f) =>
      [a.permissionId, b.permissionId].includes(f.owner),
    );
    expect(new Set(mine.map((f) => f.mimeType))).toEqual(new Set([DOC_TYPE, FOLDER_TYPE]));
  });

  it('[adr:google-copy-beyond-diaries#12] refuses a Google account another user connected, keeping nothing and revoking nothing', async () => {
    const a = await person('Ann');
    const b = await person('Bo');
    await invite(a, b);
    expect((await connect(a)).statusCode).toBe(200);
    const revokes = () => google.state.calls.filter((c) => c.includes('/revoke')).length;
    const before = revokes();
    const refused = await connect(b, a.permissionId);
    expect(refused.statusCode).toBe(409);
    const error = ApiErrorBody.parse(refused.json()).error;
    expect(error.code).toBe('GOOGLE_ACCOUNT_IN_USE');
    expect(error.message).not.toContain('Ann');
    expect(await query(`select 1 from google_connections where user_id = $1`, [b.id])).toHaveLength(
      0,
    );
    expect(revokes()).toBe(before);
    expect((await backup(a)).google.state).toBe('connected');
    // Once the first connection is gone, the account can be connected again.
    await send(a, 'POST', routes.disconnectGoogle.path);
    await query(`delete from google_connections where user_id = $1`, [a.id]);
    expect((await connect(b, a.permissionId)).statusCode).toBe(200);
  });
});
