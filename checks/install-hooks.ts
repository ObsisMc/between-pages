import { execFileSync } from 'node:child_process';

// Runs from the root "prepare" script, so `npm ci` / `npm install` enable the tracked
// hooks with no separate step. Outside a git checkout (e.g. a tarball) there is nothing
// to configure.
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
} catch {
  process.exit(0);
}
execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
