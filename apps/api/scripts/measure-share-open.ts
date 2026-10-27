// Kernel ADR K18: opening many diaries at once, against a disposable PostgreSQL.
// Usage: bash scripts/with-test-postgres.sh node apps/api/scripts/measure-share-open.ts [diaries] [runs]
// Prints one JSON line per run: phase-1 time, phase-2 transaction time (it holds the diary
// locks), how many diaries phase 2 rebuilt under the lock, how long a commit that arrived
// during phase 2 waited, and the time to freeze them all again. Never point it at a
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
import { createSharingService } from '../src/sharing/sharing.ts';
import { createRelationStore } from '../src/store/relations.ts';
import { createStore } from '../src/store/store.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const diaryCount = Number(process.argv[2] ?? 1000);
const runs = Number(process.argv[3] ?? 3);
/** Diaries written to, and diaries created, between the phases. */
const WRITTEN_BETWEEN = 10;
const CREATED_BETWEEN = 5;
const ALL: DateSelection = { include: [{ from: null, to: null }], exclude: [] };

await runMigrations(url);
const database = createDb(url);
const store = createStore(database.db);
const relations = createRelationStore(database.db);
const sharing = createSharingService(relations, store, createEvents());
const bindings = createBindingService(relations, sharing);
const commit = createCommitService(store);
const EMPTY = Y.encodeStateAsUpdate(createDiaryDoc());

const dateBefore = (days: number) =>
  new Date(Date.parse('2026-10-27T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);

async function user(name: string) {
  const id = randomUUID();
  await database.pool.query('insert into users (id, display_name) values ($1, $2)', [id, name]);
  return id;
}

async function write(owner: string, diaryId: string, doc: Y.Doc, change: (t: Y.Text) => void) {
  const generationId = (
    await database.pool.query<{ g: string }>('select generation_id g from diaries where id = $1', [
      diaryId,
    ])
  ).rows[0]!.g;
  let update: Uint8Array | undefined;
  doc.once('update', (u: Uint8Array) => (update = u));
  change(doc.getText(BODY));
  return commit.commit(owner, {
    diaryId,
    batchId: randomUUID(),
    generationId,
    operations: [
      { operationId: randomUUID(), update: new Uint8Array(update!), writtenAt: new Date() },
    ],
  });
}

/** A private diary with about 300 visible characters and a deleted private passage. */
async function seed(owner: string, date: string) {
  const { diaryId } = await store.openPersonal({
    ownerId: owner,
    diaryDate: date,
    timezone: 'UTC',
    baseline: EMPTY,
  });
  const doc = createDiaryDoc();
  await write(owner, diaryId, doc, (t) => t.insert(0, '今天写下的字。'.repeat(40)));
  await write(owner, diaryId, doc, (t) => t.insert(10, '私人段落，稍后删除。'.repeat(5)));
  await write(owner, diaryId, doc, (t) => t.delete(10, 50));
  return { diaryId, doc };
}

async function measure(run: number) {
  const a = await user(`A${run}`);
  const b = await user(`B${run}`);
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

  const seeded = [];
  for (let i = 0; i < diaryCount; i++) seeded.push(await seed(a, dateBefore(i + CREATED_BETWEEN)));

  let started = performance.now();
  const { prepared, failed } = await sharing.prepare(a, ALL);
  const phase1Ms = performance.now() - started;
  if (failed.length) throw new Error(`baselines failed: ${failed.join()}`);

  // Commits and new diaries that land after phase 1 read their diaries.
  for (const { diaryId, doc } of seeded.slice(0, WRITTEN_BETWEEN))
    await write(a, diaryId, doc, (t) => t.insert(0, '补一句。'));
  for (let i = 0; i < CREATED_BETWEEN; i++) await seed(a, dateBefore(i));

  const target = seeded.at(-1)!;
  let commitWaitMs = 0;
  let applyMs = 0;
  let racing: Promise<unknown> | undefined;
  started = performance.now();
  const applied = await relations.withUsersLocked([a], async (locked) => {
    const row = (await locked.lockSpace(space.id))!;
    await locked.confirmSelection({
      spaceId: space.id,
      ownerId: a,
      periodId,
      requestId: randomUUID(),
      selection: ALL,
      at: new Date(),
    });
    const result = await sharing.apply(locked, {
      ownerId: a,
      space: row,
      periodId,
      selection: ALL,
      prepared,
      at: new Date(),
    });
    applyMs = performance.now() - started;
    // A commit arriving while the diary rows are held waits for this COMMIT, then finds
    // its generation replaced (STALE_CONTEXT): it lands in neither generation.
    const sent = performance.now();
    racing = write(a, target.diaryId, target.doc, (t) => t.insert(0, '竞争。')).then((outcome) => {
      commitWaitMs = performance.now() - sent;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return result;
  });
  // The transaction minus the 50 ms it holds on purpose for the racing commit.
  const phase2Ms = performance.now() - started - 50;
  const raced = (await racing) as { ok: boolean; code?: string };

  // Shrinking to nothing freezes every share in one transaction, as unbinding does.
  started = performance.now();
  const frozen = await relations.withUsersLocked([a], async (locked) =>
    sharing.apply(locked, {
      ownerId: a,
      space: (await locked.lockSpace(space.id))!,
      periodId,
      selection: null,
      prepared: new Map(),
      at: new Date(),
    }),
  );
  const freezeMs = performance.now() - started;

  const written = await database.pool.query<{ epochs: number; commits: number }>(
    `select (select count(*)::int from share_epochs e join diaries d on d.id = e.diary_id where d.owner_id = $1) epochs,
            (select count(*)::int from diary_commits c join diaries d on d.id = c.diary_id where d.owner_id = $1 and c.seq = 0 and c.epoch_id is not null) commits`,
    [a],
  );
  return {
    run,
    diaries: diaryCount + CREATED_BETWEEN,
    phase1Ms: Math.round(phase1Ms),
    phase2ApplyMs: Math.round(applyMs),
    phase2Ms: Math.round(phase2Ms),
    opened: applied.opened,
    rebuilt: applied.rebuilt,
    epochsWritten: written.rows[0]!.epochs,
    baselineCommitsWritten: written.rows[0]!.commits,
    frozen: frozen.frozen,
    freezeMs: Math.round(freezeMs),
    racingCommit: raced.ok ? 'committed' : raced.code,
    racingCommitWaitMs: Math.round(commitWaitMs),
  };
}

console.log(JSON.stringify({ node: process.version, cpus: cpus().length, cpu: cpus()[0]?.model }));
for (let run = 1; run <= runs; run++) console.log(JSON.stringify(await measure(run)));
await database.close();
