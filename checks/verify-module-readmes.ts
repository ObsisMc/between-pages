import { exists, modules, read, report } from './lib.ts';

// Must match the required headings in docs/engineering-standards.md#module-readmes.
const REQUIRED = [
  '## Public surface',
  '## Invariants',
  '## Allowed dependencies',
  '## How to test',
  '## Known limitations',
];

const problems: string[] = [];
for (const dir of modules) {
  const path = `${dir}/README.md`;
  if (!exists(path)) {
    problems.push(`${dir}/: no README.md`);
    continue;
  }
  const headings = new Set(
    read(path)
      .split('\n')
      .map((line) => line.trim()),
  );
  for (const heading of REQUIRED)
    if (!headings.has(heading)) problems.push(`${path}: missing heading "${heading}"`);
}
report('verify-module-readmes', problems, 'copy the headings from apps/api/README.md');
