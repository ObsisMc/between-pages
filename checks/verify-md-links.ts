import { dirname, join, normalize } from 'node:path';
import { exists, read, repoFiles, report } from './lib.ts';

// Relative links and images in Markdown must point at files that exist. Anchors are not
// checked; external URLs are not fetched.
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const problems: string[] = [];

for (const file of repoFiles().filter((f) => f.endsWith('.md'))) {
  let inFence = false;
  read(file)
    .split('\n')
    .forEach((line, i) => {
      if (line.trimStart().startsWith('```')) inFence = !inFence;
      if (inFence) return;
      for (const [, target] of line.matchAll(LINK)) {
        if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
        const path = normalize(join(dirname(file), decodeURI(target.split('#')[0] ?? '')));
        if (!exists(path)) problems.push(`${file}:${i + 1}: broken link → ${target}`);
      }
    });
}
report('verify-md-links', problems, 'point the link at an existing file or remove it');
