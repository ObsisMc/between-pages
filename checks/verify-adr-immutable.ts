import { ADR_DIR, parseAdr, section } from './adr-lib.ts';
import { defaultRange, git, read, report } from './lib.ts';

// Usage: verify-adr-immutable.ts [range]   (default: origin/main...HEAD)
// Once a record has left 提议 its decision is fixed (docs/adr/README.md#状态与生命周期):
// - 已采纳 / 已实现: 决策依据, 不变量 and 备选方案 do not change; other sections may be
//   corrected or synced with the code.
// - 已拒绝 / 已废弃 / 已取代 and the legacy 0001–0006 bodies: nothing but 状态/关联 changes.
// Anything else needs the `adr-amend` PR label (ADR_AMEND=true in CI).
const BYPASS = 'ADR_AMEND';
const FROZEN_SECTIONS = ['## 决策依据', '## 不变量', '### 约束', '## 备选方案'];
const FULLY_FROZEN = new Set(['已拒绝', '已废弃', '已取代']);

const range = process.argv[2] ?? defaultRange();
const [from, to] = range.includes('...') ? range.split('...') : range.split('..');
const base = range.includes('...') ? git('merge-base', from!, to || 'HEAD').trim() : from!;

const withoutStatusLines = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^- (状态|关联)：/.test(l))
    .join('\n')
    .trimEnd();
const frozenSections = (text: string) =>
  FROZEN_SECTIONS.map((h) => {
    const lines = section(text.split('\n'), h);
    return lines ? `${h}\n${lines.join('\n').trim()}` : '';
  }).join('\n\n');

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
  const old = parseAdr(file, before);
  const status = old.header.get('状态');
  if (status === '提议') continue;
  if (kind === 'D') {
    problems.push(`${path}: a ${status ?? 'legacy'} record was deleted`);
    continue;
  }
  const now = read(path);
  if (old.legacy || FULLY_FROZEN.has(status ?? '')) {
    if (withoutStatusLines(before) !== withoutStatusLines(now))
      problems.push(`${path}: body of a ${old.legacy ? 'legacy' : status} record changed`);
  } else if (frozenSections(before) !== frozenSections(now)) {
    problems.push(`${path}: 决策依据, 不变量 or 备选方案 of a ${status} record changed`);
  }
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
