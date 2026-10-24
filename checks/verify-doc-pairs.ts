import { defaultRange, git, modules, report } from './lib.ts';

// Usage: verify-doc-pairs.ts [range]   (default: origin/main...HEAD)
// Strict mode: a module whose code changed in the range must also change its README.
// Bypass: DOCS_NOT_NEEDED=true, which CI sets from the `docs-not-needed` PR label.
// No translated pairs are configured (engineering docs are English only, ADR-0006).
const BYPASS = 'DOCS_NOT_NEEDED';
// Changes that do not alter a module's contract: tests and generated files.
const NOT_CODE = [/\.test\.tsx?$/, /\/openapi\.json$/, /\/README\.md$/];

const range = process.argv[2] ?? defaultRange();
// Committed changes in the range plus uncommitted ones, so the hook-free local run
// sees the same thing CI will after the commit.
const changed = new Set(
  [git('diff', '--name-only', range), git('diff', '--name-only', 'HEAD')]
    .join('\n')
    .split('\n')
    .filter(Boolean),
);

const problems: string[] = [];
for (const dir of modules) {
  const code = [...changed].filter(
    (f) => f.startsWith(`${dir}/`) && !NOT_CODE.some((pattern) => pattern.test(f)),
  );
  if (code.length && !changed.has(`${dir}/README.md`))
    problems.push(`${dir}/: code changed (${code.length} files) but README.md did not`);
}

if (problems.length && process.env[BYPASS] === 'true') {
  console.log(`verify-doc-pairs: bypassed by ${BYPASS} (${problems.length} module(s))`);
} else {
  report(
    'verify-doc-pairs',
    problems,
    `update the module README, or add the docs-not-needed label with a reason in the PR`,
  );
}
