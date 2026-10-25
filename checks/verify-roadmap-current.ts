import { defaultRange, git, read, report } from './lib.ts';

// Usage: verify-roadmap-current.ts [range]   (default: origin/main...HEAD)
// docs/roadmap.md is the single record of project progress. Two rules keep it current:
//  1. a range with a `feat` commit touching apps/ or packages/ also changes the roadmap;
//  2. the README's one-line status carries the same 更新日期 as the roadmap.
// Bypass for rule 1: ROADMAP_NOT_NEEDED=true, which CI sets from the `roadmap-not-needed`
// PR label for features that do not move any roadmap item.
const BYPASS = 'ROADMAP_NOT_NEEDED';
const ROADMAP = 'docs/roadmap.md';
const FEAT = /^feat(\([^)]*\))?!?: /;
const PRODUCT = /^(apps|packages)\//;
const DATE = /更新日期：(\d{4}-\d{2}-\d{2})/;

const range = process.argv[2] ?? defaultRange();
const problems: string[] = [];

const features = git('rev-list', '--no-merges', range)
  .split('\n')
  .filter(Boolean)
  .filter((sha) => FEAT.test(git('log', '-1', '--format=%s', sha).trim()))
  .filter((sha) =>
    git('diff-tree', '--no-commit-id', '--name-only', '-r', sha)
      .split('\n')
      .some((f) => PRODUCT.test(f)),
  );
const roadmapChanged = git('diff', '--name-only', range).split('\n').includes(ROADMAP);
if (features.length && !roadmapChanged) {
  const subjects = features.map(
    (sha) => `${sha.slice(0, 7)} ${git('log', '-1', '--format=%s', sha).trim()}`,
  );
  if (process.env[BYPASS] === 'true') {
    console.log(`verify-roadmap-current: rule 1 bypassed by ${BYPASS} (${subjects.join('; ')})`);
  } else {
    problems.push(
      `${ROADMAP}: unchanged although this range adds features: ${subjects.join('; ')}`,
    );
  }
}

const statusSection = read('README.md').split('## 当前状态')[1]?.split('\n## ')[0] ?? '';
const readmeDate = DATE.exec(statusSection)?.[1];
const roadmapDate = DATE.exec(read(ROADMAP))?.[1];
if (!roadmapDate) problems.push(`${ROADMAP}: no "更新日期：YYYY-MM-DD" line`);
if (!readmeDate) problems.push('README.md: "## 当前状态" has no "更新日期：YYYY-MM-DD" line');
if (readmeDate && roadmapDate && readmeDate !== roadmapDate)
  problems.push(`README.md: status dated ${readmeDate} but ${ROADMAP} is dated ${roadmapDate}`);

report(
  'verify-roadmap-current',
  problems,
  `update the roadmap row and its 更新日期 (and the README status line), or add the roadmap-not-needed label with a reason`,
);
