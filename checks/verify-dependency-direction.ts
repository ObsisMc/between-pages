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
 * Sub-modules: the first path segment under `dir` (file stem or directory), with tests
 * belonging to the sub-module they sit in. Each maps to the sub-modules it may import;
 * `*` is any. A file in no listed sub-module is reported, so new ones get a rule.
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
  const first = path.slice(dir.length + 1).split('/')[0];
  return first?.replace(/(?:\.test)?\.[cm]?[jt]sx?$/, '');
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
