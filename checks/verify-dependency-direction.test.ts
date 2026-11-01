import { describe, expect, it } from 'vitest';
import { violations } from './verify-dependency-direction.ts';

const file = (path: string, source: string) => ({ path, source });

describe('verify-dependency-direction', () => {
  it('accepts the directions architecture.md draws', () => {
    expect(
      violations([
        file('apps/api/src/app.ts', "import { routes } from '@between-pages/contracts';"),
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
        file(
          'apps/api/src/bindings/bindings.ts',
          "import { normalizeSelection } from '../sharing/selection.ts';",
        ),
        file('apps/api/src/app.sync.db.test.ts', "import { buildApp } from './app.ts';"),
        file(
          'apps/web/src/editor-binding/binding.ts',
          "import { BODY } from '@between-pages/collab';\nimport { schema } from './schema.ts';",
        ),
        file('apps/web/src/sender/sender.ts', "import { openJournal } from '../journal/index.ts';"),
        file(
          'apps/web/src/sync-client/sync-client.ts',
          "import { callApi } from '../api/client.ts';",
        ),
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
      'apps/web/src/pages/x.ts',
      "import { buildApp } from '../../../api/src/app.ts';",
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
      'the sharing service importing the binding service',
      'apps/api/src/sharing/sharing.ts',
      "import type { BindingService } from '../bindings/bindings.ts';",
    ],
    [
      'api transport reaching the relationship store past the services',
      'apps/api/src/routes/spaces.ts',
      "import { createRelationStore } from '../store/relations.ts';",
    ],
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
    ['an unlisted api sub-module', 'apps/api/src/mailer/mailer.ts', 'export const x = 1;'],
    [
      'the editor binding reaching the network',
      'apps/web/src/editor-binding/binding.ts',
      "import { callApi } from '../api/client.ts';",
    ],
    [
      'the journal reaching the editor',
      'apps/web/src/journal/journal.ts',
      "import type { EditIntent } from '../editor-binding/intent.ts';",
    ],
    [
      'the sender opening a socket itself',
      'apps/web/src/sender/sender.ts',
      "import { createSyncClient } from '../sync-client/index.ts';",
    ],
    [
      'a building block importing the screen that wires it',
      'apps/web/src/journal/journal.ts',
      "import { DiaryPage } from '../diary/index.ts';",
    ],
    [
      'the history view reaching the journal',
      'apps/web/src/history/HistoryPreview.tsx',
      "import { openJournal } from '../journal/index.ts';",
    ],
    [
      'the day feed opening the editor session',
      'apps/web/src/day-feed/DayFeed.tsx',
      "import { createDiarySession } from '../diary/session.ts';",
    ],
    ['an unlisted web sub-module', 'apps/web/src/reader/reader.ts', 'export const x = 1;'],
  ])('rejects %s', (_, path, source) => {
    expect(violations([file(path, source)])).toHaveLength(1);
  });
});
