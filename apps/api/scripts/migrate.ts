import { runMigrations } from '../src/db/migrate.ts';

// Usage: npm run db:migrate   (reads DATABASE_URL, e.g. from the repo-root .env)
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — copy .env.example to .env and run: npm run db:up');
  process.exit(1);
}
await runMigrations(url);
console.log('migrations applied');
