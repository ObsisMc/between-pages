import { dirname, join, normalize } from 'node:path/posix';
import ts from 'typescript';
import { read, repoFiles, report } from './lib.ts';

// Imports follow docs/architecture.md#dependency-direction and, inside a package, the
// sub-module split of the diary collaboration kernel ADR (D11). Anything not listed is
// forbidden. Type-only imports count: a type dependency is still a dependency.

/** Workspaces, the other workspaces each may import, and for packages the only externals. */
const WORKSPACES: { dir: string; imports: string[]; externals?: string[] }[] = [
  { dir: 'apps/api', imports: ['packages/contracts', 'packages/collab'] },
  { dir: 'apps/web', imports: ['packages/contracts', 'packages/collab'] },
  { dir: 'packages/collab', imports: [], externals: ['yjs'] },
  { dir: 'packages/contracts', imports: [], externals: ['zod'] },
];
const TEST_EXTERNALS = ['vitest'];

/**
 * Sub-modules: the first path segment under `dir` (a directory, or a file name up to its
 * first dot), with tests belonging to the sub-module they sit in. Each maps to the
 * sub-modules it may import; `*` is any. A file in no listed sub-module is reported, so
 * new ones get a rule.
 */
const SUBMODULES: { dir: string; units: Record<string, string[]> }[] = [
  {
    dir: 'packages/collab/src',
    units: {
      doc: [],
      validate: ['doc'],
      baseline: ['doc'],
      digest: [],
      authorship: ['doc'],
      index: ['*'],
      kernel: ['*'], // cross-sub-module tests through the public surface
    },
  },
  {
    // Kernel ADR D11: transport (routes, ws) → services (commit, diaries, reader, history,
    // outbox, events) → storage (store), never upwards; `reader` is the only producer of
    // what a partner sees, and `history` groups the timeline it authorizes; transport never reaches the store, and
    // events imports no other service; `errors` is a leaf the layers may use. The
    // relationship services of spaces-and-invitations sit in the same service layer:
    // `sharing` owns ranges and what they share (kernel D5 opening and freezing), which
    // `bindings` runs inside its binding and unbinding transactions and `diaries` asks
    // when creating a diary. `app` and
    // `server` compose everything, so tests through the real router (app.*.test.ts)
    // belong to `app`.
    dir: 'apps/api/src',
    units: {
      app: ['*'],
      server: ['*'],
      openapi: ['app', 'db'],
      config: [],
      errors: [],
      auth: ['config', 'db', 'errors'],
      db: [],
      routes: [
        'errors',
        'commit',
        'diaries',
        'history',
        'reader',
        'reading',
        'bindings',
        'sharing',
        'backup',
        'clocks',
        'space-records',
        'wishes',
        'anniversaries',
      ],
      ws: ['auth', 'errors', 'commit', 'diaries', 'reader', 'events'],
      // server-backup-and-google-docs: `google` calls Google and seals or opens tokens, knowing
      // no database; `backup` is the Drive connection and what each day's Doc holds, reading
      // text only through `reader` and history points through `history`; `worker` is the
      // worker process, the only one that opens tokens (invariant 11).
      google: [],
      backup: ['store', 'google', 'reader', 'history', 'errors', 'config'],
      worker: ['*'],
      commit: ['store', 'outbox', 'events', 'errors'],
      diaries: ['store', 'sharing', 'errors'],
      reader: ['store', 'events', 'errors'],
      reading: ['store', 'errors'],
      history: ['store', 'reader', 'errors'],
      outbox: ['store', 'errors'],
      events: [],
      bindings: ['store', 'sharing', 'events', 'errors'],
      sharing: ['store', 'events', 'errors'],
      // two-clocks: the caller's own zone and sleep schedule, and the partner's while bound.
      clocks: ['store'],
      // space-records: membership, the open binding, history and unread for every space
      // feature, knowing none of them; a feature (`wishes`, `anniversaries`) writes only
      // through it and never imports another feature; transport composes them where they
      // meet (a gift's anniversary). `link-preview` reads a link and knows no database.
      'space-records': ['store'],
      wishes: ['space-records', 'store'],
      anniversaries: ['space-records', 'store'],
      'link-preview': [],
      store: ['db', 'errors'],
    },
  },
  {
    // Kernel ADR D11: editor-binding knows neither the network nor IndexedDB, and the
    // journal knows neither the editor nor the network, so both import no other web
    // sub-module; the sender reaches the network only through the transport it is given,
    // and the sync client owns the socket and the API calls it needs. `history` reads the
    // server's rendered versions and knows no editor or journal. `diary` is the screen that
    // wires them together, and nothing below imports it. The relationship screens
    // (spaces-and-invitations D12) know no diary module: `sharing-range` edits a range and
    // imports nothing, `relationship` owns the relationship queries the `join` and `space`
    // pages reuse.
    dir: 'apps/web/src',
    units: {
      main: ['*'],
      routes: [
        'auth',
        'shell',
        'pages',
        'diary',
        'join',
        'space',
        'backup',
        'two-clocks',
        'wishes',
        'anniversaries',
      ],
      api: [],
      auth: ['api'],
      pages: [
        'api',
        'auth',
        'avatar',
        'backup',
        'join',
        'relationship',
        'shared-diaries',
        'space-common',
        'two-clocks',
        'ui',
        'windows',
      ],
      // digital-paper-interface 落地顺序 2: the shadcn components know no other module.
      ui: [],
      // digital-paper-interface D4: the paired windows draw the mascots and know no data.
      windows: ['avatar'],
      // digital-paper-interface D1: the site header and which pages it lists; the account menu
      // signs out and forgets a kept invitation.
      shell: ['ui', 'api', 'auth', 'avatar', 'join', 'relationship', 'space-common'],
      'editor-binding': [],
      journal: [],
      sender: ['journal'],
      'sync-client': ['api'],
      history: ['api'],
      // unread-and-day-page: the initial avatar knows no other module.
      avatar: [],
      'sharing-range': [],
      relationship: ['api', 'sharing-range'],
      join: ['api', 'auth', 'relationship', 'sharing-range'],
      space: ['api', 'auth', 'relationship', 'sharing-range', 'shared-diaries'],
      'shared-diaries': ['api'],
      // server-backup-and-google-docs D9: the backup page, the Google callback and the home banner.
      backup: ['api'],
      // two-clocks: the home time area, the clocks page and the browser's zone report; the
      // page sits in the shell's page container (digital-paper-interface 落地顺序 4).
      'two-clocks': ['api', 'shell', 'ui'],
      // space-records: the entry dot, seen reports, unread jumps and the read-only notice
      // every space feature uses; features import it and never each other.
      'space-common': ['api', 'ui'],
      wishes: ['api', 'space-common', 'shell', 'ui'],
      anniversaries: ['api', 'space-common', 'shell', 'ui'],
      // book-frontend-workspace: `day-text` renders one diary's text read-only and knows no
      // other module; `day-feed` is the continuous list of them and the date index, which
      // `diary` mounts beside the day editor (digital-paper-interface D2, 落地顺序 2).
      'day-text': [],
      'day-feed': ['api', 'avatar', 'day-text', 'read-tracker'],
      diary: [
        'api',
        'auth',
        'day-feed',
        'editor-binding',
        'journal',
        'sender',
        'sync-client',
        'history',
        'read-tracker',
        'avatar',
        'ui',
        'shell',
      ],
      'read-tracker': ['api'],
    },
  },
];

const SOURCE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/;
const TEST = /\.test\.tsx?$/;

export type SourceFile = { path: string; source: string };

export function violations(files: readonly SourceFile[]): string[] {
  const byName = new Map(
    WORKSPACES.map((w) => [JSON.parse(read(`${w.dir}/package.json`)).name as string, w.dir]),
  );
  const problems: string[] = [];
  for (const { path, source } of files) {
    const from = workspaceOf(path);
    const submodules = SUBMODULES.find((s) => path.startsWith(`${s.dir}/`));
    const unit = submodules && unitOf(submodules.dir, path);
    if (submodules && unit && !(unit in submodules.units))
      problems.push(`${path}: not in a sub-module listed for ${submodules.dir}`);

    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      const fail = (why: string) => problems.push(`${path}: imports '${specifier}' — ${why}`);
      if (specifier.startsWith('.')) {
        const target = normalize(join(dirname(path), specifier));
        if (target.startsWith('prototypes/') && !path.startsWith('prototypes/'))
          fail('nothing outside prototypes/ imports from it');
        const to = workspaceOf(target)?.dir;
        if (from && to && to !== from.dir && !from.imports.includes(to))
          fail(`${from.dir} may not import ${to}`);
        if (submodules && unit && target.startsWith(`${submodules.dir}/`)) {
          const targetUnit = unitOf(submodules.dir, target);
          const allowed = submodules.units[unit] ?? [];
          if (
            targetUnit &&
            targetUnit !== unit &&
            !allowed.includes('*') &&
            !allowed.includes(targetUnit)
          )
            fail(`sub-module ${unit} may not import ${targetUnit}`);
        }
        continue;
      }
      const name = packageName(specifier);
      const workspace = byName.get(name);
      if (workspace) {
        if (from && workspace !== from.dir && !from.imports.includes(workspace))
          fail(`${from.dir} may not import ${workspace}`);
        continue;
      }
      const externals = from?.externals;
      if (
        externals &&
        !externals.includes(name) &&
        !(TEST.test(path) && TEST_EXTERNALS.includes(name))
      )
        fail(`${from.dir} may use only ${externals.join(', ')}`);
    }
  }
  return problems;
}

const workspaceOf = (path: string) => WORKSPACES.find((w) => path.startsWith(`${w.dir}/`));

function unitOf(dir: string, path: string): string | undefined {
  return path
    .slice(dir.length + 1)
    .split('/')[0]
    ?.split('.')[0];
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

if (import.meta.main) {
  const files = repoFiles()
    .filter((f) => SOURCE.test(f) && !f.startsWith('prototypes/'))
    .map((path) => ({ path, source: read(path) }));
  report(
    'verify-dependency-direction',
    violations(files),
    'import only what docs/architecture.md#dependency-direction and the module README allow; move shared code down into a package',
  );
}
