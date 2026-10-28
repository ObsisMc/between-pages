import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { BODY } from '@between-pages/collab';
import { createDb } from '../../apps/api/src/db/client.ts';
import { createStore } from '../../apps/api/src/store/store.ts';

// Checks of a restored database (server-backup-and-google-docs D3): every diary rebuilds
// with its stored sha256s, every visible character has an author and a write time, nothing
// went missing since the last drill, and the restore reaches the live database's last commit.

export type Counts = { users: number; spaces: number; diaries: number; commits: number };
export type Report = { counts: Counts; problems: string[] };

async function counts(client: pg.Client): Promise<Counts> {
  const { rows } = await client.query<Counts>(
    `select (select count(*)::int from users) as users, (select count(*)::int from spaces) as spaces,
            (select count(*)::int from diaries) as diaries, (select count(*)::int from diary_commits) as commits`,
  );
  return rows[0]!;
}

const lastCommit = async (client: pg.Client, notAfter?: Date) =>
  (
    await client.query<{ at: Date | null }>(
      'select max(committed_at) as at from diary_commits where $1::timestamptz is null or committed_at <= $1',
      [notAfter ?? null],
    )
  ).rows[0]!.at;

/** Visible characters whose clientID has no author or whose clock has no recorded write. */
async function unattributed(client: pg.Client, diaryId: string, text: import('yjs').Text) {
  const { rows } = await client.query<{
    client_id: string;
    clock_start: string;
    clock_end: string;
  }>('select client_id, clock_start, clock_end from diary_character_ranges where diary_id = $1', [
    diaryId,
  ]);
  const bindings = new Set(
    (
      await client.query<{ client_id: string }>(
        'select client_id from diary_client_bindings where diary_id = $1',
        [diaryId],
      )
    ).rows.map((r) => Number(r.client_id)),
  );
  const ranges = rows.map(
    (r) => [Number(r.client_id), Number(r.clock_start), Number(r.clock_end)] as const,
  );
  const missing: string[] = [];
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const { client: id, clock } = item.id;
    if (!bindings.has(id)) missing.push(`client ${id} has no author`);
    for (let c = clock; c < clock + item.length; c++) {
      if (!ranges.some(([rc, start, end]) => rc === id && c >= start && c < end)) {
        missing.push(`character ${id}:${c} has no write time`);
        break;
      }
    }
  }
  return missing;
}

export async function verify(options: {
  databaseUrl: string;
  /** The live database, when it is still there: the restore must reach its commits up to `liveUntil`. */
  live?: { url: string; until: Date };
  /** Counts of the previous drill, which must not shrink; written back on success. */
  stateFile?: string | undefined;
}): Promise<Report> {
  const problems: string[] = [];
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  const database = createDb(options.databaseUrl);
  try {
    const store = createStore(database.db);
    const diaries = (
      await client.query<{ id: string; generation_id: string; version: string }>(
        'select id, generation_id, version from diaries order by id',
      )
    ).rows;
    for (const diary of diaries) {
      try {
        const doc = await store.read((q) =>
          q.state(diary.id, diary.generation_id, Number(diary.version)),
        );
        for (const p of await unattributed(client, diary.id, doc.getText(BODY))) {
          problems.push(`diary ${diary.id}: ${p}`);
        }
      } catch (error) {
        problems.push(`diary ${diary.id} does not rebuild: ${(error as Error).message}`);
      }
    }

    const now = await counts(client);
    if (options.stateFile) {
      const before = await readFile(options.stateFile, 'utf8').then(
        (text) => JSON.parse(text) as Counts,
        () => null,
      );
      for (const key of Object.keys(now) as (keyof Counts)[]) {
        if (before && now[key] < before[key])
          problems.push(`${key}: ${now[key]}, fewer than the last drill's ${before[key]}`);
      }
    }

    if (options.live) {
      const liveClient = new pg.Client({ connectionString: options.live.url });
      await liveClient.connect();
      try {
        const expected = await lastCommit(liveClient, options.live.until);
        const reached = await lastCommit(client);
        if (expected && (!reached || reached < expected)) {
          problems.push(
            `the restore ends at ${reached?.toISOString() ?? 'no commit'}, before the live commit at ${expected.toISOString()}`,
          );
        }
      } finally {
        await liveClient.end();
      }
    }

    if (!problems.length && options.stateFile)
      await writeFile(options.stateFile, JSON.stringify(now));
    return { counts: now, problems };
  } finally {
    await client.end();
    await database.close();
  }
}
