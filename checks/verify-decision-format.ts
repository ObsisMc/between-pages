import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { read, report, root } from './lib.ts';

// Form of docs/adr/ records, as described in docs/adr/README.md#格式.
const DIR = 'docs/adr';
const NAME = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const problems: string[] = [];
const index = read(`${DIR}/README.md`);
for (const file of readdirSync(join(root, DIR)).filter((f) => f !== 'README.md')) {
  const path = `${DIR}/${file}`;
  if (!NAME.test(file)) {
    problems.push(`${path}: file name must be NNNN-kebab-topic.md`);
    continue;
  }
  const lines = read(path).split('\n');
  if (!/^# ADR-\d{4}：/.test(lines[0] ?? ''))
    problems.push(`${path}: first line must be "# ADR-NNNN：<title>"`);
  if (!lines.some((l) => l.startsWith('日期：') && l.includes('状态：')))
    problems.push(`${path}: missing the "日期：… 状态：…" line`);
  if (!lines.includes('## 背景')) problems.push(`${path}: missing "## 背景"`);
  const alt = lines.findIndex((l) => l.startsWith('## 替代方案'));
  if (alt < 0) problems.push(`${path}: missing "## 替代方案"`);
  else {
    const next = lines.findIndex((l, i) => i > alt && l.startsWith('## '));
    const body = lines.slice(alt + 1, next < 0 ? undefined : next);
    if (!body.some((l) => l.trim())) problems.push(`${path}: "## 替代方案" is empty`);
  }
  if (!index.includes(`(./${file})`)) problems.push(`${path}: not listed in ${DIR}/README.md`);
}
report('verify-decision-format', problems, `follow the format in ${DIR}/README.md`);
