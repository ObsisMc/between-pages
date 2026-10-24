import { read, report } from './lib.ts';

const MAX_LINES = 120;
const MAX_WORDS = 1200;

const text = read('AGENTS.md');
const lines = text.trimEnd().split('\n').length;
const words = text.split(/\s+/).filter(Boolean).length;
const problems: string[] = [];
if (lines > MAX_LINES) problems.push(`AGENTS.md: ${lines} lines (ceiling ${MAX_LINES})`);
if (words > MAX_WORDS) problems.push(`AGENTS.md: ${words} words (ceiling ${MAX_WORDS})`);
report(
  'verify-agents-md-budget',
  problems,
  'move detail into docs/ or a module README, then condense; raise the ceiling only with a reason in the PR',
);
