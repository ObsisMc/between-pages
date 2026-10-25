import { spawnSync } from 'node:child_process';
import { root } from './lib.ts';

// Usage: npm run check -- <docs|pairs|commits|stack|all> [range]
// The one entry point local runs and CI share. Every gate in a group runs and all
// failures are reported; hooks must be installed before any group runs.
const range = process.argv[3];
const gate = (script: string, ...args: string[]) => ['node', `checks/${script}.ts`, ...args];

// Same commands as AGENTS.md#commands and the CI jobs.
const STACK = [
  ['npm', 'run', 'format:check'],
  ['npm', 'run', 'lint'],
  ['npm', 'run', 'typecheck'],
  // Local runs get a disposable PostgreSQL; CI runs test:coverage against its service.
  ['npm', 'run', process.env.CI ? 'test:coverage' : 'test:db'],
  ['npm', 'run', 'test:prototypes'],
  ['npm', 'run', process.env.CI ? 'test:e2e' : 'test:e2e:db'],
];

const GROUPS: Record<string, string[][]> = {
  docs: [
    gate('verify-module-readmes'),
    gate('verify-md-links'),
    gate('verify-decision-format'),
    gate('verify-agents-md-budget'),
    gate('verify-openapi-current'),
    gate('verify-migrations-current'),
    gate('verify-auth-boundary'),
    gate('verify-adr-index'),
    gate('verify-adr-tags'),
  ],
  pairs: [
    gate('verify-doc-pairs', ...(range ? [range] : [])),
    gate('verify-roadmap-current', ...(range ? [range] : [])),
    gate('verify-adr-immutable', ...(range ? [range] : [])),
  ],
  commits: [gate('verify-commit-convention', ...(range ? [range] : []))],
  stack: STACK,
};
GROUPS.all = [...GROUPS.docs!, ...GROUPS.pairs!, ...GROUPS.commits!, ...STACK];

const group = process.argv[2] ?? '';
const commands = GROUPS[group];
if (!commands) {
  console.error(`usage: npm run check -- <${Object.keys(GROUPS).join('|')}> [range]`);
  process.exit(2);
}

const run = ([cmd, ...args]: string[]) =>
  spawnSync(cmd!, args, { cwd: root, stdio: 'inherit' }).status === 0;

if (!run(gate('verify-hooks-installed'))) process.exit(1);
const failed = commands.filter((command) => !run(command)).map((command) => command.join(' '));
if (failed.length) {
  console.error(`\ncheck ${group}: ${failed.length} failed\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`check ${group}: all passed`);
