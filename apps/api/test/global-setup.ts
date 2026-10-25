import { runMigrations } from '../src/db/migrate.ts';

// Database tests (*.db.test.ts) run against TEST_DATABASE_URL, migrated once per run.
// Locally they are skipped with a notice when no database is given; in CI a missing
// database is an error, so the suite can never pass by silently skipping them.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    await runMigrations(url);
    return;
  }
  if (process.env.CI) throw new Error('TEST_DATABASE_URL is required in CI');
  console.warn('TEST_DATABASE_URL not set: skipping *.db.test.ts (run: npm run test:db)');
}
