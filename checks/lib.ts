import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
export const read = (path: string) => readFileSync(join(root, path), 'utf8');
export const exists = (path: string) => existsSync(join(root, path));
export const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Directories that carry a README contract and fall under the docs-move-with-code gate.
export const modules: string[] = JSON.parse(read('checks/modules.json'));

// Default comparison range for branch-level checks.
export const BASE_REF = process.env.CHECK_BASE_REF ?? 'origin/main';
export const defaultRange = () => `${BASE_REF}...HEAD`;

/** Tracked plus untracked-but-not-ignored files, so new files are checked before commit. */
export const repoFiles = () =>
  git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter((f) => f && exists(f));

/** Prints every problem and exits 1 when there are any; exits 0 silently otherwise. */
export function report(gate: string, problems: string[], fix?: string): void {
  if (!problems.length) return;
  console.error(`✗ ${gate}`);
  for (const p of problems) console.error(`  ${p}`);
  if (fix) console.error(`  fix: ${fix}`);
  process.exit(1);
}
