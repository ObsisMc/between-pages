import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import { createDb } from '../../apps/api/src/db/client.ts';
import { runMigrations } from '../../apps/api/src/db/migrate.ts';
import { createCommitService } from '../../apps/api/src/commit/commit.ts';
import { createStore } from '../../apps/api/src/store/store.ts';
import { dailyBackup } from './backup.ts';
import { drill } from './drill.ts';
import { IMAGE, parseBackups, sh } from './lib.ts';
import { restore, restoredUrl } from './restore.ts';
import { verify } from './verify.ts';

// The whole cycle on a disposable database through the real overlay, with WAL-G writing to
// a local directory instead of R2: archive, daily backup, point-in-time and latest restore,
// checks and the drill. Needs Docker; run with `npm run test:backup`.

const enabled = process.env.BACKUP_DOCKER_TEST === '1';
let dir = '';
let liveUrl = '';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** One diary with one committed line, written through the real commit chain. */
async function writeDiary(date: string, line: string): Promise<string> {
  const database = createDb(liveUrl);
  try {
    const store = createStore(database.db);
    const owner = randomUUID();
    await liveQuery('insert into users (id, display_name) values ($1, $2)', [owner, 'writer']);
    const { diaryId } = await store.openPersonal({
      ownerId: owner,
      diaryDate: date,
      timezone: 'UTC',
      baseline: Y.encodeStateAsUpdate(createDiaryDoc()),
    });
    const generationId = await store.read(async (q) => (await q.findDiary(diaryId))!.generationId);
    const doc = createDiaryDoc();
    doc.clientID = 4242;
    let update: Uint8Array | undefined;
    doc.on('update', (u: Uint8Array) => (update = u));
    doc.getText(BODY).insert(0, line);
    const outcome = await createCommitService(store).commit(owner, {
      diaryId,
      generationId,
      batchId: randomUUID(),
      operations: [
        { operationId: randomUUID(), update: new Uint8Array(update!), writtenAt: new Date() },
      ],
    });
    if (!outcome.ok) throw new Error(`commit refused: ${JSON.stringify(outcome)}`);
    return diaryId;
  } finally {
    await database.close();
  }
}

async function liveQuery<Row extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: liveUrl });
  await client.connect();
  try {
    return (await client.query<Row>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Closes the current WAL segment and waits until WAL-G has archived it. */
async function archiveNow(): Promise<void> {
  const [before] = await liveQuery<{ n: string }>(
    'select archived_count as n from pg_stat_archiver',
  );
  await liveQuery('select pg_switch_wal()');
  for (let i = 0; i < 60; i++) {
    const [now] = await liveQuery<{ n: string }>(
      'select archived_count as n from pg_stat_archiver',
    );
    if (Number(now!.n) > Number(before!.n)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('the WAL segment was not archived');
}

async function diaryIds(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<{ id: string }>('select id from diaries order by id')).rows.map(
      (r) => r.id,
    );
  } finally {
    await client.end();
  }
}

describe.runIf(enabled)('server backup cycle', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'between-pages-backup-'));
    const store = join(dir, 'store');
    await sh('mkdir', ['-p', store]);
    await chmod(store, 0o777);
    const envFile = join(dir, 'backup.env');
    // Test-only key, generated per run.
    await writeFile(
      envFile,
      [
        'WALG_FILE_PREFIX=/backup',
        `WALG_LIBSODIUM_KEY=${randomBytes(32).toString('hex')}`,
        'WALG_LIBSODIUM_KEY_TRANSFORM=hex',
        'WALG_DELTA_MAX_STEPS=6',
        'WALG_COMPRESSION_METHOD=zstd',
      ].join('\n'),
    );
    const dbPort = await freePort();
    liveUrl = `postgresql://between_pages:local-dev-only@127.0.0.1:${dbPort}/between_pages`;
    Object.assign(process.env, {
      COMPOSE_FILE: 'compose.yaml:ops/backup/compose.backup.yaml:ops/backup/compose.test.yaml',
      COMPOSE_PROJECT_NAME: `between-pages-backup-test-${process.pid}`,
      DB_PORT: String(dbPort),
      BACKUP_ENV_FILE: envFile,
      BACKUP_FILE_DIR: store,
      WALG_FILE_PREFIX: '/backup',
      LIVE_DATABASE_URL: liveUrl,
      DRILL_STATE_FILE: join(dir, 'drill-state.json'),
    });
    await sh('docker', ['compose', 'up', '-d', '--build', '--wait', 'postgres']);
    await runMigrations(liveUrl);
  }, 600_000);

  afterAll(async () => {
    if (!enabled) return;
    await sh('docker', ['compose', 'down', '-v']).catch(() => '');
    // Files the container wrote belong to its postgres user; remove them from inside.
    await sh('docker', ['run', '--rm', '-v', `${dir}:/d`, IMAGE, 'sh', '-c', 'rm -rf /d/*']).catch(
      () => '',
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('[adr:server-backup-and-google-docs#1] [adr:server-backup-and-google-docs#2] archives encrypted WAL and restores to a time point and to the latest commit', async () => {
    const marker = `plaintext-marker-${randomUUID()}`;
    const first = await writeDiary('2026-10-01', `${marker} first`);
    const summary = await dailyBackup(new Date());
    expect(summary).toContain('(full, permanent)');

    const second = await writeDiary('2026-10-02', `${marker} second`);
    await archiveNow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const between = new Date();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const third = await writeDiary('2026-10-03', `${marker} third`);
    await archiveNow();

    // Nothing in the store reveals the diary text.
    const files = await sh('docker', [
      'run',
      '--rm',
      '-v',
      `${process.env.BACKUP_FILE_DIR}:/b`,
      IMAGE,
      'sh',
      '-c',
      `grep -rl "${marker}" /b || true`,
    ]);
    expect(files.trim()).toBe('');
    expect(await readdir(process.env.BACKUP_FILE_DIR!)).not.toHaveLength(0);

    const envFile = process.env.BACKUP_ENV_FILE!;
    const atTime = await restore({ to: between, drill: true, envFile });
    try {
      expect(await diaryIds(restoredUrl(atTime.port))).toEqual([first, second].sort());
      const report = await verify({ databaseUrl: restoredUrl(atTime.port) });
      expect(report.problems).toEqual([]);
    } finally {
      await sh('docker', ['rm', '-f', atTime.container]);
      await sh('docker', ['volume', 'rm', atTime.volume]);
    }

    const latest = await restore({ to: 'latest', drill: true, envFile });
    try {
      expect(await diaryIds(restoredUrl(latest.port))).toEqual([first, second, third].sort());
      expect((await verify({ databaseUrl: restoredUrl(latest.port) })).problems).toEqual([]);
    } finally {
      await sh('docker', ['rm', '-f', latest.container]);
      await sh('docker', ['volume', 'rm', latest.volume]);
    }
  }, 600_000);

  it('[adr:server-backup-and-google-docs#2] keeps one permanent backup a month and sends only changes on other days', async () => {
    await writeDiary('2026-10-04', 'another day');
    const summary = await dailyBackup(new Date());
    expect(summary).not.toContain('permanent');
    const backups = parseBackups(
      await sh('docker', [
        'compose',
        'exec',
        '-T',
        '-u',
        'postgres',
        'postgres',
        'wal-g',
        'backup-list',
        '--json',
        '--detail',
      ]),
    );
    expect(backups.filter((b) => b.is_permanent)).toHaveLength(1);
    expect(backups).toHaveLength(2);
  }, 600_000);

  it('[adr:server-backup-and-google-docs#3] the drill restores, checks against the live database and leaves nothing behind', async () => {
    const summary = await drill(process.env.BACKUP_ENV_FILE!, new Date(Date.now() + 10 * 60_000));
    expect(summary).toMatch(/4 diaries/);
    const state = JSON.parse(await readFile(process.env.DRILL_STATE_FILE!, 'utf8'));
    expect(state.diaries).toBe(4);
    // No restore container or volume is left behind.
    expect(await sh('docker', ['ps', '-aq', '--filter', 'name=between-pages-restore-'])).toBe('');
  }, 600_000);
});
