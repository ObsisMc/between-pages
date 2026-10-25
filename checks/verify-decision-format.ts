import {
  ADR_DIR,
  HEADER_FIELDS,
  SCOPES,
  STATUSES,
  loadAdrs,
  parseRelations,
  section,
  type Adr,
} from './adr-lib.ts';
import { read, report } from './lib.ts';

// Form of docs/adr/ records and of the links between them (docs/adr/README.md).
const SECTIONS = [
  '## 背景与问题',
  '## 决策依据',
  '## 决策',
  '## 不变量',
  '## 备选方案',
  '## 风险与代价',
  '## 补充信息',
];
const PLAN = ['## 落地顺序', '## 验收标准'];
// Sections a record carries only before it is implemented, and the one it gains after.
const BY_STATUS: Record<string, { require: string[]; forbid: string[] }> = {
  提议: { require: PLAN, forbid: ['## 验证'] },
  已采纳: { require: PLAN, forbid: ['## 验证'] },
  已实现: { require: ['## 验证'], forbid: PLAN },
};
const INACTIVE = new Set(['已取代', '已废弃']);

const adrs = loadAdrs();
const byRef = new Map<string, Adr>();
const problems: string[] = [];
const filled = (lines: string[] | undefined) => Boolean(lines?.some((l) => l.trim()));

for (const adr of adrs) {
  const p = (msg: string) => problems.push(`${adr.path}: ${msg}`);
  if (adr.nameError) p(adr.nameError);
  if (byRef.has(adr.ref)) p(`duplicate reference "${adr.ref}" (also ${byRef.get(adr.ref)!.path})`);
  byRef.set(adr.ref, adr);

  if (
    adr.legacy
      ? !/^# ADR-\d{4}：\S/.test(adr.lines[0] ?? '')
      : !/^# (?!ADR-)\S/.test(adr.lines[0] ?? '')
  )
    p(
      adr.legacy
        ? 'first line must be "# ADR-NNNN：<title>"'
        : 'first line must be "# <decision>" without a number',
    );
  for (const field of HEADER_FIELDS)
    if (!adr.header.has(field)) p(`missing header line "- ${field}：…"`);
  const status = adr.header.get('状态');
  if (status && !(STATUSES as readonly string[]).includes(status))
    p(`状态 "${status}" is not one of ${STATUSES.join(' | ')}`);
  const scope = adr.header.get('范围');
  if (scope && !SCOPES.includes(scope)) p(`范围 "${scope}" is not one of ${SCOPES.join(' | ')}`);
  const date = adr.header.get('日期') ?? '';
  if (adr.header.has('日期') && !/^\d{4}-\d{2}-\d{2}$/.test(date)) p('日期 must be YYYY-MM-DD');
  if (!adr.legacy && !adr.file.startsWith(date)) p(`file name date differs from 日期 ${date}`);
  if (adr.header.has('决策者') && !adr.header.get('决策者')) p('决策者 is empty');
  const relations = parseRelations(adr.header.get('关联') ?? '无');
  if (typeof relations === 'string') p(`关联: ${relations}`);

  if (adr.legacy) {
    // Frozen records keep their original body; only the header follows the new format.
    if (!adr.lines.includes('## 背景')) p('missing "## 背景"');
    const alt = adr.lines.find((l) => l.startsWith('## 替代方案'));
    if (!alt) p('missing "## 替代方案"');
    else if (!filled(section(adr.lines, alt))) p(`"${alt}" is empty`);
    continue;
  }
  const reassess = (section(adr.lines, '## 补充信息') ?? []).find((l) =>
    l.startsWith('- 重新评估条件：'),
  );
  if (!reassess || !reassess.replace('- 重新评估条件：', '').trim())
    p('补充信息 needs a non-empty "- 重新评估条件：…"');

  for (const heading of SECTIONS) if (!adr.lines.includes(heading)) p(`missing "${heading}"`);
  const lifecycle = BY_STATUS[status ?? ''];
  for (const heading of lifecycle?.require ?? [])
    if (!adr.lines.includes(heading)) p(`状态 ${status} needs "${heading}"`);
  for (const heading of lifecycle?.forbid ?? [])
    if (adr.lines.includes(heading)) p(`状态 ${status} must not have "${heading}"`);
  if (!(section(adr.lines, '## 决策') ?? []).some((l) => /^### D1[：:]\s*\S/.test(l)))
    p('"## 决策" needs numbered decisions starting with "### D1：<rule>"');
  if (adr.lines.includes('## 不变量')) checkNumbered(adr, '## 不变量', p);
  const alternatives = section(adr.lines, '## 备选方案') ?? [];
  const header = alternatives.find((l) => l.trimStart().startsWith('|'));
  if (!header || !/优势/.test(header) || !/否决理由/.test(header))
    p('"## 备选方案" must be a table with "优势" and "否决理由" columns');
  else if (alternatives.filter((l) => l.trimStart().startsWith('|')).length < 3)
    p('"## 备选方案" table has no alternatives');
}

/** Numbered items under `heading` must exist and run 1, 2, 3, … */
function checkNumbered(adr: Adr, heading: string, p: (msg: string) => void) {
  const expected = adr.invariants.map((_, i) => i + 1).join(',');
  if (!adr.invariants.length) p(`"${heading}" has no numbered items`);
  else if (adr.invariants.join(',') !== expected)
    p(`"${heading}" items must be numbered 1, 2, 3, …`);
}

// Supersession must be recorded on both sides, and status must agree with it.
for (const adr of adrs) {
  const p = (msg: string) => problems.push(`${adr.path}: ${msg}`);
  for (const rel of adr.relations) {
    const other = byRef.get(rel.ref);
    if (!other) {
      p(`关联 names unknown "${rel.ref}"`);
      continue;
    }
    if (other === adr) p('关联 names itself');
    if (
      rel.kind === 'supersedes' &&
      !other.relations.some(
        (r) => r.kind === 'supersededBy' && r.ref === adr.ref && r.part === rel.part,
      )
    )
      p(
        `取代 ${rel.ref}${rel.part ? ` 的${rel.part}` : ''}, but ${other.path} lacks "${rel.part}被 ${adr.ref} 取代"`,
      );
    if (
      rel.kind === 'supersededBy' &&
      !other.relations.some(
        (r) => r.kind === 'supersedes' && r.ref === adr.ref && r.part === rel.part,
      )
    )
      p(
        `${rel.part}被 ${rel.ref} 取代, but ${other.path} lacks "取代 ${adr.ref}${rel.part ? ` 的${rel.part}` : ''}"`,
      );
  }
  const whollyReplaced = adr.relations.some((r) => r.kind === 'supersededBy' && !r.part);
  if (whollyReplaced !== (adr.header.get('状态') === '已取代'))
    p('状态 must be 已取代 exactly when 关联 says "被 <ref> 取代" without a part');
}

// docs/architecture.md#current-decisions is the "what holds today" entry point.
const arch = read('docs/architecture.md').split('\n');
const current = section(arch, '## Current decisions');
if (!current) problems.push('docs/architecture.md: missing "## Current decisions"');
for (const line of current ?? []) {
  for (const [, file] of line.matchAll(/\]\(adr\/([^)#]+)\)/g)) {
    const adr = adrs.find((a) => a.file === file);
    const status = adr?.header.get('状态') ?? '';
    if (adr && INACTIVE.has(status))
      problems.push(`docs/architecture.md: Current decisions links ${adr.ref}, which is ${status}`);
  }
}

report('verify-decision-format', problems, `follow ${ADR_DIR}/README.md`);
