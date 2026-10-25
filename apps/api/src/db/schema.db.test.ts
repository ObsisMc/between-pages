import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.ts';
import { query, testDatabaseUrl } from '../../test/db.ts';

describe.runIf(testDatabaseUrl)('database schema', () => {
  it('re-applies migrations without error once they are applied', async () => {
    await expect(runMigrations(testDatabaseUrl!)).resolves.toBeUndefined();
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
