import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADR_DIR, findTags, loadAdrs, renderIndex, withIndex } from './adr-lib.ts';
import { read, root } from './lib.ts';

// Rewrites the generated index in docs/adr/README.md (npm run adr:index).
const path = `${ADR_DIR}/README.md`;
writeFileSync(join(root, path), withIndex(read(path), renderIndex(loadAdrs(), findTags())));
