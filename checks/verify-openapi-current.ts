import { execFileSync } from 'node:child_process';
import { report, root } from './lib.ts';

// The committed apps/api/openapi.json must equal what the registered routes produce, so
// the contract that future native clients read cannot silently drift from the server.
try {
  execFileSync('node', ['apps/api/scripts/generate-openapi.ts', '--check'], {
    cwd: root,
    stdio: 'pipe',
  });
} catch (error) {
  const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
  report(
    'verify-openapi-current',
    [stderr || 'apps/api/openapi.json does not match the routes'],
    'npm run openapi',
  );
}
