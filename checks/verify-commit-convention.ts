import { readFileSync } from 'node:fs';
import { defaultRange, git, read, report } from './lib.ts';

// Usage:
//   verify-commit-convention.ts [range] [--dry-run]   every non-merge commit in the range
//   verify-commit-convention.ts --title <text>         one subject line
//   verify-commit-convention.ts --file <path>          a commit message file (commit-msg hook)
// Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/#specification)
// plus the house rules below, which are reported separately from spec violations.
const TYPES: string[] = JSON.parse(read('checks/commit-types.json'));
const MAX_SUBJECT = 72;
const EXAMPLE = 'feat(api): add diary creation endpoint';

const HEADER = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<desc>\S.*)$/;
const FOOTER = /^(?<token>BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z][\w-]*)(?:: | #)(?<value>.*)$/;

function problemsIn(message: string): string[] {
  const lines = message
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !l.startsWith('#'));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const subject = lines[0] ?? '';
  const match = HEADER.exec(subject);
  if (!match?.groups) return [`spec: "${subject}" is not "type(scope)!: description"`];
  const { type = '', desc = '' } = match.groups;
  const problems: string[] = [];
  if (!TYPES.includes(type))
    problems.push(`config: type "${type}" is not one of ${TYPES.join(', ')}`);
  if (lines.length > 1 && lines[1]?.trim())
    problems.push('spec: the body must start after one blank line');

  const paragraphs = lines
    .slice(2)
    .join('\n')
    .split(/\n\s*\n/);
  const last = paragraphs.at(-1)?.split('\n') ?? [];
  if (last.length && last.every((l) => FOOTER.test(l))) {
    for (const line of last) {
      const footer = FOOTER.exec(line)?.groups;
      const token = footer?.token?.toUpperCase().replace('-', ' ');
      if (token === 'BREAKING CHANGE' && !footer?.value?.trim())
        problems.push('spec: BREAKING CHANGE footer needs a description');
    }
  }
  if (
    /^breaking[ -]change:/im.test(lines.slice(1).join('\n')) &&
    !/^BREAKING[ -]CHANGE:/m.test(message)
  )
    problems.push('spec: the BREAKING CHANGE token must be uppercase');

  if (subject.length > MAX_SUBJECT)
    problems.push(`house: subject is ${subject.length} chars (max ${MAX_SUBJECT})`);
  if (/^[A-Z][a-z]/.test(desc)) problems.push('house: description must start lowercase');
  if (desc.endsWith('.')) problems.push('house: description must not end with a period');
  return problems;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const dryRun = args.includes('--dry-run');
const failures: string[] = [];

if (flag('--title') !== undefined) {
  for (const p of problemsIn(flag('--title') ?? '')) failures.push(p);
} else if (flag('--file') !== undefined) {
  const message = readFileSync(flag('--file') ?? '', 'utf8');
  // Merge commits keep git's own subject; fixup!/squash!/amend! are folded by rebase later.
  if (!/^(Merge |fixup! |squash! |amend! )/.test(message))
    for (const p of problemsIn(message)) failures.push(p);
} else {
  const range = args.find((a) => !a.startsWith('--')) ?? defaultRange();
  const shas = git('rev-list', '--no-merges', range).split('\n').filter(Boolean);
  for (const sha of shas) {
    const message = git('log', '-1', '--format=%B', sha);
    for (const p of problemsIn(message))
      failures.push(`${sha.slice(0, 7)} ${message.split('\n')[0]}: ${p}`);
  }
  if (dryRun) {
    const bad = new Set(failures.map((f) => f.slice(0, 7))).size;
    console.log(
      `verify-commit-convention (dry run): ${bad} of ${shas.length} commits in ${range} would fail`,
    );
    for (const f of failures) console.log(`  ${f}`);
    process.exit(0);
  }
}
report(
  'verify-commit-convention',
  failures,
  `reword the commit, e.g. "${EXAMPLE}" (types: checks/commit-types.json)`,
);
