import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Shared by the backup, restore and drill scripts (server-backup-and-google-docs D2–D4).
// They run on the host that holds the real database, from the repository checkout, with the
// variables of the backup env file (backup.env.example) in their environment.

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
/** Built by compose.backup.yaml; the same tag runs the live database and every restore. */
export const IMAGE = 'between-pages-postgres-walg:3.0.9';
export const PGDATA = '/var/lib/postgresql/18/docker';
/** Kept a day past the 30 promised, so the oldest promised minute still has a backup before it. */
export const RETENTION_DAYS = 31;

const run = promisify(execFile);

/** Runs a command, returning stdout; on failure the error carries its stderr, never the environment. */
export async function sh(
  cmd: string,
  args: string[],
  options: { stderr?: boolean } = {},
): Promise<string> {
  try {
    const { stdout, stderr } = await run(cmd, args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    return options.stderr ? stdout + stderr : stdout;
  } catch (error) {
    const { stderr, code } = error as { stderr?: string; code?: number };
    throw new Error(
      `${cmd} ${args[0] ?? ''} failed (${code}): ${(stderr ?? '').trim().slice(-2000)}`,
      { cause: error },
    );
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see ops/backup/backup.env.example)`);
  return value;
}

/** One entry of `wal-g backup-list --json --detail`. */
export type Backup = {
  backup_name: string;
  start_time: string;
  finish_time: string;
  is_permanent: boolean;
};

export const parseBackups = (json: string): Backup[] => (json.trim() ? JSON.parse(json) : []);

/**
 * The newest backup that finished at or before `target`, which recovery then replays to
 * `target`; null when the target is older than every kept backup.
 */
export function backupFor(backups: Backup[], target: Date | 'latest'): Backup | null {
  const done = backups
    .filter((b) => target === 'latest' || new Date(b.finish_time) <= target)
    .sort((a, b) => Date.parse(b.finish_time) - Date.parse(a.finish_time));
  return done[0] ?? null;
}

/** True when no permanent backup started in `now`'s UTC month: today's backup becomes it. */
export function needsMonthly(backups: Backup[], now: Date): boolean {
  const month = now.toISOString().slice(0, 7);
  return !backups.some((b) => b.is_permanent && b.start_time.slice(0, 7) === month);
}

export const retentionCutoff = (now: Date) =>
  new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

/**
 * Parses `--to`: "latest", or a time with its zone ("2026-10-28T21:04:00Z",
 * "2026-10-28 21:04 UTC"). A time without a zone is refused rather than guessed.
 */
export function parseTarget(value: string): Date | 'latest' {
  if (value === 'latest') return 'latest';
  const normalized = value.trim().replace(/ UTC$/i, 'Z').replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(normalized)) {
    throw new Error(`--to needs a time zone, e.g. "2026-10-28 21:04 UTC": ${value}`);
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`--to is not a time: ${value}`);
  return date;
}

/**
 * Reports to Healthchecks.io: `start`, success, or `fail` with a short reason. A missing URL
 * skips the ping (for local runs); a failed ping never fails the job it reports on.
 */
export async function ping(url: string | undefined, kind: 'start' | 'success' | 'fail', body = '') {
  if (!url) return;
  const target = kind === 'success' ? url : `${url.replace(/\/$/, '')}/${kind}`;
  try {
    await fetch(target, {
      method: 'POST',
      body: body.slice(0, 10_000),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(`healthchecks ping failed: ${(error as Error).message}`);
  }
}
