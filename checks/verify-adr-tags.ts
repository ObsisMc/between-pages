import { findTags, loadAdrs } from './adr-lib.ts';
import { report } from './lib.ts';

// Every [adr:<slug>#<n>] marker in a test or check must name a dated ADR and one of
// its numbered constraints; otherwise the implementation column counts nothing real.
const adrs = new Map(loadAdrs().map((a) => [a.ref, a]));
const problems: string[] = [];
for (const tag of findTags()) {
  const adr = adrs.get(tag.ref);
  const where = `${tag.file}:${tag.line}: [adr:${tag.ref}#${tag.constraint}]`;
  if (!adr || adr.legacy) problems.push(`${where} names no dated ADR`);
  else if (!adr.constraints.includes(tag.constraint))
    problems.push(`${where} — ${adr.path} has no constraint ${tag.constraint}`);
}
report(
  'verify-adr-tags',
  problems,
  'point the marker at an existing ADR slug and constraint number',
);
