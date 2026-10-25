import { read, repoFiles, report } from './lib.ts';

// [adr:authentication-and-sessions#10] App code learns who is calling only through the
// current-user entry point and never reads or writes Better Auth's tables. Only
// apps/api/src/auth/ and apps/api/src/db/ may touch the auth layer; tests are exempt
// because they check the auth tables on purpose.
const ALLOWED = ['apps/api/src/auth/', 'apps/api/src/db/'];
const FORBIDDEN: [RegExp, string][] = [
  [/\bauth_(user|account|session|verification)\b/, 'names an auth table'],
  [/from ['"][^'"]*auth-schema(\.ts)?['"]/, 'imports the auth schema'],
  [/from ['"]better-auth(\/[^'"]*)?['"]/, 'imports better-auth'],
];

const problems: string[] = [];
const files = repoFiles().filter(
  (f) =>
    f.startsWith('apps/api/src/') &&
    /\.(ts|tsx)$/.test(f) &&
    !/\.test\.tsx?$/.test(f) &&
    !ALLOWED.some((dir) => f.startsWith(dir)),
);
for (const file of files) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const [pattern, what] of FORBIDDEN)
        if (pattern.test(line)) problems.push(`${file}:${i + 1}: ${what}`);
    });
}
report(
  'verify-auth-boundary',
  problems,
  'get the caller from request.user (set by requireUser) or move the code under apps/api/src/auth/',
);
