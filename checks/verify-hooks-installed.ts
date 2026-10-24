import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { git, read, report, root } from './lib.ts';

// Hooks are a gate only if every clone runs them: the tracked files exist and are
// executable, `npm ci` still wires them up, and this clone points git at them.
const HOOKS = ['pre-commit', 'commit-msg'];
const problems: string[] = [];

for (const hook of HOOKS) {
  try {
    accessSync(join(root, '.githooks', hook), constants.X_OK);
  } catch {
    problems.push(`.githooks/${hook}: missing or not executable`);
  }
}
const prepare =
  (JSON.parse(read('package.json')) as { scripts?: Record<string, string> }).scripts?.prepare ?? '';
if (!prepare.includes('checks/install-hooks.ts'))
  problems.push('package.json: "prepare" no longer runs checks/install-hooks.ts');

let hooksPath = '';
try {
  hooksPath = git('config', '--get', 'core.hooksPath').trim();
} catch {
  // unset: reported below
}
if (hooksPath !== '.githooks')
  problems.push(`git core.hooksPath is "${hooksPath}", expected ".githooks"`);

report('verify-hooks-installed', problems, 'npm ci (or: node checks/install-hooks.ts)');
