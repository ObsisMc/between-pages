import { ping, required, sh } from './lib.ts';
import { restore, restoredUrl, type Restored } from './restore.ts';
import { verify } from './verify.ts';

// Weekly drill (server-backup-and-google-docs D3): restore the latest backup into a
// throwaway container with archiving off, check it, remove it. Healthchecks hears success
// only when every check passed.

/** Commits newer than this may still be in a WAL segment that has not been archived yet. */
const ARCHIVE_SLACK_MS = 5 * 60_000;

export async function drill(envFile: string, now = new Date()): Promise<string> {
  let restored: Restored | undefined;
  try {
    const started = Date.now();
    restored = await restore({ to: 'latest', drill: true, envFile });
    const report = await verify({
      databaseUrl: restoredUrl(restored.port),
      live: {
        url: required('LIVE_DATABASE_URL'),
        until: new Date(now.getTime() - ARCHIVE_SLACK_MS),
      },
      stateFile: process.env.DRILL_STATE_FILE,
    });
    if (report.problems.length) throw new Error(report.problems.slice(0, 20).join('\n'));
    const c = report.counts;
    return `restored ${restored.backup} in ${Math.round((Date.now() - started) / 1000)} s: ${c.users} users, ${c.spaces} spaces, ${c.diaries} diaries, ${c.commits} commits`;
  } finally {
    if (restored) {
      await sh('docker', ['rm', '-f', restored.container]).catch(() => '');
      await sh('docker', ['volume', 'rm', restored.volume]).catch(() => '');
    }
  }
}

if (import.meta.main) {
  const url = process.env.HC_DRILL_URL;
  await ping(url, 'start');
  try {
    const summary = await drill(required('BACKUP_ENV_FILE'));
    console.log(`drill ok: ${summary}`);
    await ping(url, 'success', summary);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`drill failed: ${message}`);
    await ping(url, 'fail', message);
    process.exitCode = 1;
  }
}
