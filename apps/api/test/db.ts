import pg from 'pg';
import { createDb } from '../src/db/client.ts';
import { createRelationStore } from '../src/store/relations.ts';
import { createStore } from '../src/store/store.ts';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Runs one query against the migrated test database. */
export async function query<Row extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    return (await client.query<Row>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/**
 * A store over its own pool on the test database, for service tests that run without
 * the transport. The caller closes it.
 */
export function openTestStore() {
  const database = createDb(testDatabaseUrl!);
  return { store: createStore(database.db), close: () => database.close() };
}

/** The relationship and diary stores over one pool of their own on the test database. The caller closes it. */
export function openTestRelationStore() {
  const database = createDb(testDatabaseUrl!);
  return {
    relations: createRelationStore(database.db),
    store: createStore(database.db),
    close: () => database.close(),
  };
}
