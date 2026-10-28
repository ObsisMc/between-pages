import {
  PGDATA,
  needsMonthly,
  parseBackups,
  ping,
  retentionCutoff,
  sh,
  type Backup,
} from './lib.ts';

// Daily job (server-backup-and-google-docs D2, D3): a backup of the live database, the
// month's first one full and permanent, retention by WAL-G itself, and a check that WAL
// archiving is not failing. Healthchecks hears success only when all of it worked.

const inDb = (...args: string[]) =>
  sh('docker', ['compose', 'exec', '-T', '-u', 'postgres', 'postgres', ...args]);

const listBackups = async (): Promise<Backup[]> =>
  parseBackups(await inDb('wal-g', 'backup-list', '--json', '--detail'));

/** The archiver's last failure is newer than its last success: WAL is piling up on the server. */
async function archiverFailing(): Promise<string | null> {
  const row = await inDb(
    'psql',
    '-At',
    '-c',
    `select coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false), last_failed_wal from pg_stat_archiver`,
  );
  const [failing, wal] = row.trim().split('|');
  return failing === 't' ? `WAL archiving is failing (last failed segment ${wal})` : null;
}

export async function dailyBackup(now = new Date()): Promise<string> {
  const monthly = needsMonthly(await listBackups(), now);
  await inDb('wal-g', 'backup-push', ...(monthly ? ['--full'] : []), PGDATA);
  const newest = (await listBackups()).sort((a, b) => b.start_time.localeCompare(a.start_time))[0];
  if (!newest) throw new Error('backup-push reported success but no backup is listed');
  if (monthly) await inDb('wal-g', 'backup-mark', newest.backup_name);
  const cutoff = retentionCutoff(now)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');
  await inDb('wal-g', 'delete', 'before', 'FIND_FULL', cutoff, '--confirm');
  const failing = await archiverFailing();
  if (failing) throw new Error(failing);
  return `${newest.backup_name}${monthly ? ' (full, permanent)' : ''}; kept back to ${cutoff}`;
}

if (import.meta.main) {
  const url = process.env.HC_BACKUP_URL;
  await ping(url, 'start');
  try {
    const summary = await dailyBackup();
    console.log(`backup ok: ${summary}`);
    await ping(url, 'success', summary);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`backup failed: ${message}`);
    await ping(url, 'fail', message);
    process.exitCode = 1;
  }
}
