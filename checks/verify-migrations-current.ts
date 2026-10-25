import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { report, root } from './lib.ts';

// apps/api/drizzle must already contain a migration for every change in the schema, so a
// schema edit cannot ship without the SQL that applies it. Generates into a scratch copy
// and fails unless drizzle-kit reports nothing to generate. drizzle-kit only accepts a
// relative --out and exits 0 even on errors, so success is read from its output.
const api = join(root, 'apps/api');
const scratch = `.migrations-check-${process.pid}`;
let current: boolean | undefined;
try {
  cpSync(join(api, 'drizzle'), join(api, scratch), { recursive: true });
  const output = execFileSync(
    join(root, 'node_modules/.bin/drizzle-kit'),
    ['generate', '--dialect', 'postgresql', '--schema', './src/db/schema.ts', '--out', scratch],
    { cwd: api, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  current = output.includes('No schema changes');
} finally {
  rmSync(join(api, scratch), { recursive: true, force: true });
}
// report() exits the process, so it runs only after the scratch copy is gone.
report(
  'verify-migrations-current',
  current ? [] : ['apps/api/src/db/schema.ts has changes with no migration in apps/api/drizzle'],
  'npm run db:generate -- --name <what-changed>',
);
