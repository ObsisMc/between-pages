import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.ts';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies every pending migration in apps/api/drizzle; already-applied ones are skipped. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const database = createDb(databaseUrl);
  try {
    await migrate(database.db, { migrationsFolder });
  } finally {
    await database.close();
  }
}
