import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

// One pool per process; callers own the returned handle and must close() it.
export function createDb(databaseUrl: string): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
