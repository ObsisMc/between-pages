import pg from 'pg';

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
