import { ADR_DIR, parseAdr, section } from './adr-lib.ts';
import { defaultRange, git, read, report } from './lib.ts';

// Usage: verify-adr-immutable.ts [range]   (default: origin/main...HEAD)
// Once a record has left 提议, only its 状态/关联 lines may change and its 实施记录 may
// only grow; anything else needs the `adr-amend` PR label (ADR_AMEND=true in CI).
const BYPASS = 'ADR_AMEND';
const range = process.argv[2] ?? defaultRange();
const [from, to] = range.includes('...') ? range.split('...') : range.split('..');
const base = range.includes('...') ? git('merge-base', from!, to || 'HEAD').trim() : from!;

const LOG = '## 实施记录';
const frozenPart = (text: string) => {
  const lines = text.split('\n');
  const start = lines.indexOf(LOG);
  const log = start < 0 ? [] : (section(lines, LOG) ?? []);
  const body = lines.filter(
    (l, i) => !/^- (状态|关联)：/.test(l) && (start < 0 || i < start || i > start + log.length),
  );
  return { body: body.join('\n').trimEnd(), log: log.join('\n').trim() };
};

const problems: string[] = [];
// Working tree against the base, so a local run also sees uncommitted edits.
const changed = git('diff', '--name-status', base, '--', ADR_DIR)
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'));
for (const [kind, path] of changed) {
  if (!path || path.endsWith('README.md') || kind === 'A') continue;
  const before = git('show', `${base}:${path}`);
  const file = path.slice(ADR_DIR.length + 1);
  const status = parseAdr(file, before).header.get('状态');
  // Records from before the header format had no 状态 line; all of them were accepted.
  if (status === '提议') continue;
  if (kind === 'D') {
    problems.push(`${path}: a ${status ?? 'legacy'} record was deleted`);
    continue;
  }
  const old = frozenPart(before);
  const now = frozenPart(read(path));
  if (old.body !== now.body)
    problems.push(`${path}: body changed (only 状态/关联 and appending 实施记录 are allowed)`);
  else if (!now.log.startsWith(old.log))
    problems.push(`${path}: 实施记录 entries were edited, not appended`);
}

if (problems.length && process.env[BYPASS] === 'true') {
  console.log(`verify-adr-immutable: bypassed by ${BYPASS} (${problems.length} record(s))`);
} else {
  report(
    'verify-adr-immutable',
    problems,
    'write a new ADR that supersedes this one, or add the adr-amend label with a reason in the PR',
  );
}
