import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.ts';
import { migrationsFolder, runMigrations } from './migrate.ts';
import { query, testDatabaseUrl } from '../../test/db.ts';

/** The migrations folder cut after `lastTag`, standing in for an older release. */
function migrationsUpTo(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((e) => e.tag === lastTag);
  if (end < 0) throw new Error(`no migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

/** A fresh database next to the test database, dropped by the returned function. */
async function scratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `upgrade_${randomUUID().replaceAll('-', '')}`;
  await query(`create database ${name}`);
  const url = new URL(testDatabaseUrl!);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => query(`drop database ${name} with (force)`).then() };
}

describe.runIf(testDatabaseUrl)('database schema', () => {
  it('re-applies migrations without error once they are applied', async () => {
    await expect(runMigrations(testDatabaseUrl!)).resolves.toBeUndefined();
  });

  it('moves every diary onto its document without changing its commit chain', async () => {
    const scratch = await scratchDatabase();
    const database = createDb(scratch.url);
    try {
      await migrate(database.db, { migrationsFolder: migrationsUpTo('0010_mascot_pokes') });
      const [userId, diaryId, generationId] = [randomUUID(), randomUUID(), randomUUID()];
      await database.pool.query(`insert into users (id, display_name) values ($1, 'writer')`, [
        userId,
      ]);
      await database.pool.query(
        `insert into diaries (id, owner_id, diary_date, created_timezone, version, generation_id, created_at)
         values ($1, $2, '2026-10-26', 'Asia/Shanghai', 7, $3, '2026-10-26T01:00:00Z')`,
        [diaryId, userId, generationId],
      );
      await database.pool.query(
        `insert into diary_generations (id, diary_id, source_version, baseline, baseline_sha256)
         values ($1, $2, 0, '\\x00', '\\x00')`,
        [generationId, diaryId],
      );

      await runMigrations(scratch.url);

      const moved = await database.pool.query(
        `select c.version, c.generation_id, c.created_at = d.created_at as same_time, g.id as generation
         from diaries d
         join documents c on c.id = d.id
         join diary_generations g on g.diary_id = c.id`,
      );
      expect(moved.rows).toEqual([
        { version: '7', generation_id: generationId, same_time: true, generation: generationId },
      ]);
      // A diary cannot exist without its document (shared-pages D6).
      await expect(
        database.pool.query(
          `insert into diaries (id, owner_id, diary_date, created_timezone)
           values ($1, $2, '2026-10-27', 'Asia/Shanghai')`,
          [randomUUID(), userId],
        ),
      ).rejects.toThrow(/diaries_id_documents_id_fk/);
    } finally {
      await database.close();
      await scratch.drop();
    }
  });

  it('adds the relationship tables to a database that already has users and diaries', async () => {
    const scratch = await scratchDatabase();
    const older = migrationsUpTo('0002_personal_diaries');
    const database = createDb(scratch.url);
    try {
      await migrate(database.db, { migrationsFolder: older });
      const [userId, diaryId, generationId] = [randomUUID(), randomUUID(), randomUUID()];
      await database.pool.query(`insert into users (id, display_name) values ($1, 'writer')`, [
        userId,
      ]);
      await database.pool.query(
        `insert into auth_user (id, name, email) values ($1, 'writer', 'writer@example.test')`,
        [userId],
      );
      await database.pool.query(
        `insert into diaries (id, owner_id, diary_date, created_timezone, generation_id)
         values ($1, $2, '2026-10-26', 'Asia/Shanghai', $3)`,
        [diaryId, userId, generationId],
      );

      await runMigrations(scratch.url);

      const kept = await database.pool.query(
        `select u.display_name, a.email, d.diary_date::text
         from users u join auth_user a on a.id = u.id join diaries d on d.owner_id = u.id`,
      );
      expect(kept.rows).toEqual([
        { display_name: 'writer', email: 'writer@example.test', diary_date: '2026-10-26' },
      ]);
      const tables = await database.pool.query(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name = any($1) order by table_name`,
        [
          [
            'active_bindings',
            'binding_invitations',
            'binding_periods',
            'sharing_policies',
            'sharing_policy_changes',
            'spaces',
          ],
        ],
      );
      expect(tables.rowCount).toBe(6);
    } finally {
      await database.close();
      rmSync(older, { recursive: true, force: true });
      await scratch.drop();
    }
  });

  it('[adr:authentication-and-sessions#1] keeps domain users free of auth data', async () => {
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'users' order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'id',
      'display_name',
      'created_at',
      'last_seen_at',
      // two-clocks D1, D2: the person's own zone and sleep schedule, not login data.
      'timezone',
      'timezone_updated_at',
      'sleep_start_minute',
      'sleep_end_minute',
    ]);
    const userForeignKeys = await query(
      `select conname from pg_constraint where conrelid = 'public.users'::regclass and contype = 'f'`,
    );
    expect(userForeignKeys).toEqual([]);
  });

  it('[adr:authentication-and-sessions#1] has no domain table referencing an auth table', async () => {
    const violations = await query<{ from_table: string; to_table: string }>(
      `select c.conrelid::regclass::text as from_table, c.confrelid::regclass::text as to_table
       from pg_constraint c
       where c.contype = 'f'
         and c.confrelid::regclass::text like 'auth\\_%'
         and c.conrelid::regclass::text not like 'auth\\_%'`,
    );
    expect(violations).toEqual([]);
  });
});
