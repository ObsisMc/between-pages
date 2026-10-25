import { ADR_DIR, findTags, loadAdrs, renderIndex, withIndex } from './adr-lib.ts';
import { read, report } from './lib.ts';

// The index in docs/adr/README.md is generated; it must match the records and the
// [adr:…] markers, so status and implementation progress cannot be hand-edited.
const path = `${ADR_DIR}/README.md`;
const current = read(path);
const problems: string[] = [];
try {
  if (withIndex(current, renderIndex(loadAdrs(), findTags())) !== current)
    problems.push(`${path}: index is out of date`);
} catch (error) {
  problems.push((error as Error).message);
}
report('verify-adr-index', problems, 'npm run adr:index');
