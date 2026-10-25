import { findTags, loadAdrs } from './adr-lib.ts';
import { report } from './lib.ts';

// Every [adr:<slug>#<n>] marker in a test or check must name a dated ADR and one of
// its numbered invariants; otherwise the implementation column counts nothing real.
const adrs = new Map(loadAdrs().map((a) => [a.ref, a]));
const problems: string[] = [];
for (const tag of findTags()) {
  const adr = adrs.get(tag.ref);
  const where = `${tag.file}:${tag.line}: [adr:${tag.ref}#${tag.invariant}]`;
  if (!adr || adr.legacy) problems.push(`${where} names no dated ADR`);
  else if (!adr.invariants.includes(tag.invariant))
    problems.push(`${where} — ${adr.path} has no invariant ${tag.invariant}`);
}
report(
  'verify-adr-tags',
  problems,
  'point the marker at an existing ADR slug and invariant number',
);
