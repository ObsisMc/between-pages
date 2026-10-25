import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { read, repoFiles, root } from './lib.ts';

// Parser for docs/adr/ records, shared by the verify-adr-* scripts and the index
// generator. The format itself is specified in docs/adr/README.md.
export const ADR_DIR = 'docs/adr';
export const STATUSES = ['提议', '已采纳', '已实现', '已拒绝', '已废弃', '已取代'] as const;
export const SCOPES = ['领域', '协同', '存储', '备份', '认证', '技术栈'];
export const HEADER_FIELDS = ['状态', '日期', '决策者', '范围', '关联'] as const;
// Frozen legacy records; every new record uses a dated name.
const LEGACY_NAME = /^(\d{4})-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md$/;
const LEGACY_LAST = 6;
const DATED_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
/**
 * Dated records still in the short MADR layout (numbered `### 约束`, no D sections) that
 * predates the design-document format. Each is rewritten in its own PR; remove its entry
 * in that PR so the full format applies from then on.
 */
export const PRE_DESIGN_FORMAT = new Set(['2026-10-24-authentication-and-sessions.md']);
export const TAG = /\[adr:([a-z0-9]+(?:-[a-z0-9]+)*)#(\d+)\]/g;

export interface Relation {
  kind: 'depends' | 'supersedes' | 'supersededBy';
  ref: string;
  /** Which part is (or was) replaced; empty for the whole record. */
  part: string;
}

export interface Adr {
  file: string;
  path: string;
  /** `ADR-NNNN` for legacy records, the slug for dated ones. */
  ref: string;
  legacy: boolean;
  title: string;
  header: Map<string, string>;
  relations: Relation[];
  lines: string[];
  /** Numbers of the items under `## 不变量` (`### 约束` for PRE_DESIGN_FORMAT records). */
  invariants: number[];
  nameError?: string;
}

export function parseRelations(value: string): Relation[] | string {
  if (value === '无') return [];
  const relations: Relation[] = [];
  for (const item of value.split('；').map((s) => s.trim())) {
    let m: RegExpExecArray | null;
    if ((m = /^(.*?)被 (\S+) 取代$/.exec(item)))
      relations.push({ kind: 'supersededBy', ref: m[2]!, part: m[1]!.trim() });
    else if ((m = /^取代 (\S+?)(?: 的(.+))?$/.exec(item)))
      relations.push({ kind: 'supersedes', ref: m[1]!, part: (m[2] ?? '').trim() });
    else if ((m = /^依赖 (\S+)$/.exec(item)))
      relations.push({ kind: 'depends', ref: m[1]!, part: '' });
    else return `unrecognized relation "${item}"`;
  }
  return relations;
}

/** Lines under a heading, up to the next heading of the same or higher level. */
export function section(lines: string[], heading: string): string[] | undefined {
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function parseAdr(file: string, text: string): Adr {
  const lines = text.split('\n');
  const datedMatch = DATED_NAME.exec(file);
  const legacyMatch = datedMatch ? null : LEGACY_NAME.exec(file);
  const legacy = Boolean(legacyMatch);
  const ref = legacyMatch ? `ADR-${legacyMatch[1]}` : (datedMatch?.[2] ?? file);
  const titleLine = lines[0] ?? '';
  const title = legacy ? titleLine.replace(/^# ADR-\d{4}：/, '') : titleLine.replace(/^# /, '');
  const header = new Map<string, string>();
  for (const line of lines.slice(1, 12)) {
    const m = /^- (状态|日期|决策者|范围|关联)：(.*)$/.exec(line);
    if (m) header.set(m[1]!, m[2]!.trim());
  }
  const parsed = parseRelations(header.get('关联') ?? '无');
  const invariantHeading = PRE_DESIGN_FORMAT.has(file) ? '### 约束' : '## 不变量';
  const invariants = (section(lines, invariantHeading) ?? [])
    .map((l) => /^(\d+)\. /.exec(l)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  const nameError = datedMatch
    ? undefined
    : legacyMatch && Number(legacyMatch[1]) <= LEGACY_LAST
      ? undefined
      : 'file name must be YYYY-MM-DD-<slug>.md (NNNN- names are frozen at 0001-0006)';
  return {
    file,
    path: `${ADR_DIR}/${file}`,
    ref,
    legacy,
    title,
    header,
    relations: typeof parsed === 'string' ? [] : parsed,
    lines,
    invariants,
    ...(nameError ? { nameError } : {}),
  };
}

export function loadAdrs(): Adr[] {
  return readdirSync(join(root, ADR_DIR))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => parseAdr(f, read(`${ADR_DIR}/${f}`)));
}

export interface TagUse {
  file: string;
  line: number;
  ref: string;
  invariant: number;
}

/**
 * `[adr:<slug>#<n>]` markers in test files and verify scripts. prototypes/ is skipped:
 * a spike shows a decision is feasible, not that the product implements it.
 */
export function findTags(): TagUse[] {
  const uses: TagUse[] = [];
  const scanned = repoFiles().filter(
    (f) =>
      !f.startsWith('prototypes/') &&
      (/\.test\.(?:ts|tsx|mjs|js)$/.test(f) || /^checks\/verify-.*\.ts$/.test(f)),
  );
  for (const file of scanned) {
    read(file)
      .split('\n')
      .forEach((text, i) => {
        for (const m of text.matchAll(TAG))
          uses.push({ file, line: i + 1, ref: m[1]!, invariant: Number(m[2]) });
      });
  }
  return uses;
}

const order = (a: Adr) => (a.legacy ? `0-${a.file}` : `1-${a.file}`);

export function renderIndex(adrs: Adr[], tags: TagUse[]): string {
  const rows = [...adrs]
    .sort((a, b) => order(a).localeCompare(order(b)))
    .map((adr) => {
      let progress = '—';
      if (!adr.legacy && adr.invariants.length) {
        const covered = new Set(tags.filter((t) => t.ref === adr.ref).map((t) => t.invariant));
        const done = adr.invariants.filter((n) => covered.has(n)).length;
        const label = done === 0 ? '未开始' : done === adr.invariants.length ? '已完成' : '部分';
        progress = `${done}/${adr.invariants.length} ${label}`;
      }
      const cells = [
        `[${adr.ref}](./${adr.file})`,
        adr.title,
        adr.header.get('状态') ?? '',
        adr.header.get('范围') ?? '',
        progress,
      ];
      return `| ${cells.join(' | ')} |`;
    });
  return ['| ADR | 标题 | 状态 | 范围 | 实施 |', '| --- | --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

export const INDEX_START = '<!-- adr-index:start -->';
export const INDEX_END = '<!-- adr-index:end -->';

/** README text with the index region replaced by a freshly rendered table. */
export function withIndex(readme: string, table: string): string {
  const start = readme.indexOf(INDEX_START);
  const end = readme.indexOf(INDEX_END);
  if (start < 0 || end < start) throw new Error(`${ADR_DIR}/README.md lost its index markers`);
  return `${readme.slice(0, start + INDEX_START.length)}\n${table}\n${readme.slice(end)}`;
}
