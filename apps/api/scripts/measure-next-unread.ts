// book-frontend-workspace D5: how long `next-unread` takes when nothing is unread, the
// common case that walks every candidate, against a disposable PostgreSQL.
// Usage: bash scripts/with-test-postgres.sh node apps/api/scripts/measure-next-unread.ts [days] [runs]
// A and B each write one diary a day for `days` days, share all of them, and every other
// day write a line in the other's diary of that date; B has read everything and every
// commit is a history point. Prints one JSON line with the cold search (empty memo), the
// warm searches (memo filled) and one day-list page for comparison. Never point it at a
// database holding real diaries.
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import * as Y from 'yjs';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import type { DateSelection } from '@between-pages/contracts';
import { createBindingService } from '../src/bindings/bindings.ts';
import { createCommitService } from '../src/commit/commit.ts';
import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createEvents } from '../src/events/events.ts';
import { createHistoryService } from '../src/history/history.ts';
import { createReader } from '../src/reader/reader.ts';
import { createSharingService } from '../src/sharing/sharing.ts';
import { createRelationStore } from '../src/store/relations.ts';
import { createStore } from '../src/store/store.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const days = Number(process.argv[2] ?? 1095);
const runs = Number(process.argv[3] ?? 20);
const ALL: DateSelection = { include: [{ from: null, to: null }], exclude: [] };
/** About 1,400 characters a diary. */
const TEXT = '今天写下的字，想告诉你的事。'.repeat(100);

await runMigrations(url);
const database = createDb(url);
const store = createStore(database.db);
const relations = createRelationStore(database.db);
const sharing = createSharingService(relations, store, createEvents());
const bindings = createBindingService(relations, sharing);
const commit = createCommitService(store);
const EMPTY = Y.encodeStateAsUpdate(createDiaryDoc());

const dateBefore = (n: number) =>
  new Date(Date.parse('2026-10-31T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10);

async function user(name: string) {
  const id = randomUUID();
  await database.pool.query('insert into users (id, display_name) values ($1, $2)', [id, name]);
  return id;
}

/** One commit by `actor` on the diary's current text, into the live epoch when given. */
async function write(actor: string, diaryId: string, epochId: string | undefined, text: string) {
  const { generationId, doc } = await store.read(async (queries) => {
    const diary = (await queries.findDiary(diaryId))!;
    return {
      generationId: diary.generationId,
      doc: await queries.state(diaryId, diary.generationId, diary.version),
    };
  });
  const writer = new Y.Doc();
  Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
  let update: Uint8Array | undefined;
  writer.once('update', (u: Uint8Array) => (update = u));
  writer.getText(BODY).insert(writer.getText(BODY).length, text);
  const outcome = await commit.commit(actor, {
    diaryId,
    batchId: randomUUID(),
    generationId,
    epochId,
    operations: [
      { operationId: randomUUID(), update: new Uint8Array(update!), writtenAt: new Date() },
    ],
  });
  if (!outcome.ok) throw new Error(`commit refused: ${outcome.code}`);
}

async function shareAll(owner: string, spaceId: string, periodId: string) {
  const { prepared, failed } = await sharing.prepare(owner, ALL);
  if (failed.length) throw new Error(`baselines failed: ${failed.join()}`);
  await relations.withUsersLocked([owner], async (locked) => {
    const space = (await locked.lockSpace(spaceId))!;
    await locked.confirmSelection({
      spaceId,
      ownerId: owner,
      periodId,
      requestId: randomUUID(),
      selection: ALL,
      at: new Date(),
    });
    await sharing.apply(locked, {
      ownerId: owner,
      space,
      periodId,
      selection: ALL,
      prepared,
      at: new Date(),
    });
  });
}

const a = await user('A');
const b = await user('B');
const invitation = await bindings.createInvitation(
  a,
  { requestId: randomUUID(), sharingSelection: null },
  new Date(),
);
if (typeof invitation === 'string') throw new Error(invitation);
const accepted = await bindings.accept(
  b,
  { token: invitation.token!, sharingSelection: null },
  new Date(),
);
if (typeof accepted === 'string' || 'code' in accepted) throw new Error('not bound');
const { space, periodId } = accepted.binding;

const started = performance.now();
const diaries = { [a]: [] as string[], [b]: [] as string[] };
for (let n = 0; n < days; n++)
  for (const owner of [a, b]) {
    const { diaryId } = await store.openPersonal({
      ownerId: owner,
      diaryDate: dateBefore(n),
      timezone: 'UTC',
      baseline: EMPTY,
    });
    await write(owner, diaryId, undefined, TEXT);
    diaries[owner]!.push(diaryId);
  }
await shareAll(a, space.id, periodId);
await shareAll(b, space.id, periodId);
const epochs = await store.read(async (queries) => ({
  toA: await queries.epochs.sharedWith(a, null),
  toB: await queries.epochs.sharedWith(b, null),
}));
for (let n = 0; n < days; n += 2) {
  const forA = epochs.toA.find((e) => e.diaryId === diaries[b]![n])!;
  const forB = epochs.toB.find((e) => e.diaryId === diaries[a]![n])!;
  await write(a, forA.diaryId, forA.id, '我也来写一句。');
  await write(b, forB.diaryId, forB.id, '我也来写一句。');
}
// Every commit a history point, and B has read every other writer's characters.
await database.pool.query(
  `update diary_commits set committed_at = committed_at - interval '1 day'`,
);
await database.pool.query(
  `insert into diary_read_ranges (user_id, diary_id, client_id, clocks)
   select $1, b.diary_id, b.client_id, '{[0,10000000)}'::int8multirange
   from diary_client_bindings b where b.user_id <> $1`,
  [b],
);
const seedMs = performance.now() - started;

const reader = createReader(store);
const history = createHistoryService(reader);
const time = async (run: () => Promise<unknown>) => {
  const at = performance.now();
  const result = await run();
  return { ms: performance.now() - at, result };
};
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

const cold = await time(() => reader.nextUnread(b, {}, history.settled(new Date())));
if (cold.result !== null) throw new Error(`expected nothing unread, got ${String(cold.result)}`);
const warm: number[] = [];
for (let i = 0; i < runs; i++)
  warm.push((await time(() => reader.nextUnread(b, {}, history.settled(new Date())))).ms);
warm.sort((x, y) => x - y);
const page = await time(() => reader.days(b, {}, history.settled(new Date())));

const candidates = await database.pool.query<{ n: number }>(
  `select count(distinct d.id)::int n from diaries d
   left join share_epochs e on e.diary_id = d.id and e.recipient_id = $1
   where e.id is not null
      or exists (select 1 from diary_client_bindings c where c.diary_id = d.id and c.user_id <> $1 and d.owner_id = $1)`,
  [b],
);
console.log(
  JSON.stringify({
    node: process.version,
    cpus: cpus().length,
    cpu: cpus()[0]?.model,
    days,
    diaries: days * 2,
    candidates: candidates.rows[0]!.n,
    seedMs: Math.round(seedMs),
    coldMs: Math.round(cold.ms),
    warmP50Ms: Math.round(percentile(warm, 50)),
    warmP95Ms: Math.round(percentile(warm, 95)),
    dayPageMs: Math.round(page.ms),
  }),
);
await database.close();
