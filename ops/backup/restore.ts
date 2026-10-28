import { parseArgs } from 'node:util';
import { IMAGE, PGDATA, backupFor, parseBackups, parseTarget, required, sh } from './lib.ts';
import { verify } from './verify.ts';

// The one restore command (server-backup-and-google-docs D4), also run by the weekly drill:
// fetch the newest backup that finished before the target, replay WAL up to it, promote.

export type Restored = { container: string; volume: string; port: number; backup: string };

/** The restored database, reached with the live database's credentials (the same cluster). */
export function restoredUrl(port: number): string {
  const url = new URL(required('LIVE_DATABASE_URL'));
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString();
}

/** Docker arguments that give a container the backup env and, in tests, a local file store. */
function storageArgs(envFile: string): string[] {
  const args = ['--env-file', envFile];
  const dir = process.env.BACKUP_FILE_DIR;
  if (dir) args.push('-v', `${dir}:${required('WALG_FILE_PREFIX')}`);
  return args;
}

const DATA = '/var/lib/postgresql';

async function waitPromoted(container: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await sh('docker', ['inspect', '-f', '{{.State.Running}}', container]);
    if (state.trim() !== 'true') {
      const logs = await sh('docker', ['logs', '--tail', '40', container], { stderr: true }).catch(
        () => '',
      );
      throw new Error(`the restored database stopped during recovery:\n${logs}`);
    }
    const answer = await sh('docker', [
      'exec',
      container,
      'psql',
      '-U',
      'between_pages',
      '-d',
      'between_pages',
      '-Atc',
      'select pg_is_in_recovery()',
    ]).catch(() => '');
    if (answer.trim() === 'f') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`recovery did not finish within ${timeoutMs / 1000} s`);
}

/**
 * Restores into `volume` (a new one when omitted; an existing one must be empty).
 * `drill` turns archiving off, so a practice restore never adds a timeline to the bucket.
 * Leaves the database running on a local port; the caller stops it or removes it.
 */
export async function restore(options: {
  to: Date | 'latest';
  volume?: string | undefined;
  drill: boolean;
  envFile: string;
  timeoutMs?: number;
}): Promise<Restored> {
  const storage = storageArgs(options.envFile);
  const backups = parseBackups(
    await sh('docker', [
      'run',
      '--rm',
      ...storage,
      IMAGE,
      'wal-g',
      'backup-list',
      '--json',
      '--detail',
    ]),
  );
  const backup = backupFor(backups, options.to);
  if (!backup) throw new Error(`no backup finished before ${String(options.to)}`);

  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const volume = options.volume ?? `between-pages-restore-${stamp}`;
  const container = `between-pages-restore-${stamp}`;
  await sh('docker', ['volume', 'create', volume]);
  try {
    return await recover(options, storage, backup.backup_name, volume, container);
  } catch (error) {
    // A failed restore leaves nothing running; a volume it created itself goes too.
    await sh('docker', ['rm', '-f', container]).catch(() => '');
    if (!options.volume) await sh('docker', ['volume', 'rm', volume]).catch(() => '');
    throw error;
  }
}

async function recover(
  options: { to: Date | 'latest'; drill: boolean; timeoutMs?: number },
  storage: string[],
  backup: string,
  volume: string,
  container: string,
): Promise<Restored> {
  const listing = await sh('docker', [
    'run',
    '--rm',
    '-v',
    `${volume}:${DATA}`,
    IMAGE,
    'ls',
    '-A',
    DATA,
  ]);
  if (listing.trim())
    throw new Error(`volume ${volume} is not empty; restore only into an empty one`);
  await sh('docker', [
    'run',
    '--rm',
    '-v',
    `${volume}:${DATA}`,
    IMAGE,
    'sh',
    '-c',
    `mkdir -p ${PGDATA} && chown -R postgres:postgres ${DATA} && chmod 700 ${PGDATA}`,
  ]);
  await sh('docker', [
    'run',
    '--rm',
    '-u',
    'postgres',
    ...storage,
    '-v',
    `${volume}:${DATA}`,
    IMAGE,
    'sh',
    '-c',
    `wal-g backup-fetch ${PGDATA} ${backup} && touch ${PGDATA}/recovery.signal`,
  ]);

  const settings = [
    `archive_mode=${options.drill ? 'off' : 'on'}`,
    'archive_command=wal-g wal-push %p',
    'archive_timeout=60',
    'restore_command=wal-g wal-fetch %f %p',
    ...(options.to === 'latest'
      ? []
      : [
          `recovery_target_time=${options.to.toISOString().replace('T', ' ').replace('Z', '+00')}`,
          'recovery_target_action=promote',
        ]),
  ];
  await sh('docker', [
    'run',
    '-d',
    '--name',
    container,
    ...storage,
    '-v',
    `${volume}:${DATA}`,
    '-p',
    '127.0.0.1::5432',
    IMAGE,
    'postgres',
    ...settings.flatMap((s) => ['-c', s]),
  ]);
  await waitPromoted(container, options.timeoutMs ?? 30 * 60_000);
  const port = Number(
    (await sh('docker', ['port', container, '5432/tcp'])).trim().split(':').pop(),
  );
  return { container, volume, port, backup };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { to: { type: 'string', default: 'latest' }, volume: { type: 'string' } },
  });
  const started = Date.now();
  const restored = await restore({
    to: parseTarget(values.to!),
    volume: values.volume,
    drill: false,
    envFile: required('BACKUP_ENV_FILE'),
  });
  const report = await verify({ databaseUrl: restoredUrl(restored.port) });
  // A clean shutdown leaves an ordinary primary in the volume for compose to start.
  await sh('docker', ['stop', restored.container]);
  await sh('docker', ['rm', restored.container]);
  if (report.problems.length) {
    console.error(`the restored database failed its checks:\n${report.problems.join('\n')}`);
    process.exitCode = 1;
  }
  console.log(
    `restored ${restored.backup} up to ${values.to} into volume ${restored.volume} in ${Math.round((Date.now() - started) / 1000)} s.\n` +
      `${report.counts.users} users, ${report.counts.diaries} diaries, ${report.counts.commits} commits.\n` +
      'Next: docker compose up -d postgres, then node ops/backup/backup.ts once (ops/backup/README.md).',
  );
}
