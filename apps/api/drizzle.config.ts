import { defineConfig } from 'drizzle-kit';

// Generation only (npm run db:generate); migrations are applied by src/db/migrate.ts so
// production does not need drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
