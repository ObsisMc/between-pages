import { describe, expect, it } from 'vitest';
import { violations } from './verify-dependency-direction.ts';

const file = (path: string, source: string) => ({ path, source });

describe('verify-dependency-direction', () => {
  it('accepts the directions architecture.md draws', () => {
    expect(
      violations([
        file('apps/api/src/app.ts', "import { routes } from '@between-pages/contracts';"),
        file('apps/web/src/editor.ts', "import { acceptBatch } from '@between-pages/collab';"),
        file(
          'packages/collab/src/validate.ts',
          "import * as Y from 'yjs';\nimport { BODY } from './doc.ts';",
        ),
        file('packages/collab/src/validate.test.ts', "import { it } from 'vitest';"),
        file('packages/collab/src/index.ts', "export * from './digest.ts';"),
        file('packages/contracts/src/routes.ts', "import { z } from 'zod';"),
        file(
          'apps/api/src/ws/sync.ts',
          "import type { CommitService } from '../commit/commit.ts';",
        ),
        file('apps/api/src/commit/commit.ts', "import type { Store } from '../store/store.ts';"),
        file('apps/api/src/app.sync.db.test.ts', "import { buildApp } from './app.ts';"),
      ]),
    ).toEqual([]);
  });

  it.each([
    [
      'a package importing an app',
      'packages/contracts/src/x.ts',
      "import type { App } from '@between-pages/api';",
    ],
    [
      'one app importing the other',
      'apps/web/src/x.ts',
      "import { buildApp } from '../../api/src/app.ts';",
    ],
    [
      'code importing a prototype',
      'apps/api/src/app.ts',
      "import { Authority } from '../../../prototypes/yjs-standard/authority.mjs';",
    ],
    [
      'collab using I/O',
      'packages/collab/src/digest.ts',
      "import { createHash } from 'node:crypto';",
    ],
    [
      'collab using a test runner outside tests',
      'packages/collab/src/doc.ts',
      "import { it } from 'vitest';",
    ],
    [
      'one collab sub-module importing a sibling',
      'packages/collab/src/validate.ts',
      "import { buildBaseline } from './baseline.ts';",
    ],
    [
      'the shared model importing a sub-module',
      'packages/collab/src/doc.ts',
      "export { sha256 } from './digest.ts';",
    ],
    ['an unlisted collab sub-module', 'packages/collab/src/helpers.ts', 'export const x = 1;'],
    [
      'api transport reaching the store past the services',
      'apps/api/src/routes/diaries.ts',
      "import { createStore } from '../store/store.ts';",
    ],
    [
      'the api store importing a service',
      'apps/api/src/store/store.ts',
      "import { registerBackups } from '../outbox/outbox.ts';",
    ],
    [
      'the api events module importing another service',
      'apps/api/src/events/events.ts',
      "import type { CommitService } from '../commit/commit.ts';",
    ],
    ['an unlisted api sub-module', 'apps/api/src/reader/reader.ts', 'export const x = 1;'],
  ])('rejects %s', (_, path, source) => {
    expect(violations([file(path, source)])).toHaveLength(1);
  });
});
