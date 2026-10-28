import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupFor, needsMonthly, parseTarget, ping, retentionCutoff, type Backup } from './lib.ts';

const backup = (name: string, finish: string, permanent = false): Backup => ({
  backup_name: name,
  start_time: finish,
  finish_time: finish,
  is_permanent: permanent,
});

describe('choosing a backup to restore from', () => {
  const backups = [
    backup('mon', '2026-10-26T03:00:10Z'),
    backup('tue', '2026-10-27T03:00:10Z'),
    backup('wed', '2026-10-28T03:00:10Z'),
  ];

  it('[adr:server-backup-and-google-docs#2] takes the newest backup finished before the target time', () => {
    expect(backupFor(backups, new Date('2026-10-27T21:04:00Z'))?.backup_name).toBe('tue');
    expect(backupFor(backups, new Date('2026-10-27T03:00:10Z'))?.backup_name).toBe('tue');
    expect(backupFor(backups, 'latest')?.backup_name).toBe('wed');
  });

  it('[adr:server-backup-and-google-docs#2] has none for a time older than every kept backup', () => {
    expect(backupFor(backups, new Date('2026-10-26T02:00:00Z'))).toBeNull();
    expect(backupFor([], 'latest')).toBeNull();
  });
});

describe('retention', () => {
  it('[adr:server-backup-and-google-docs#2] makes the first backup of each UTC month the permanent one', () => {
    const october = [
      backup('oct', '2026-10-01T03:00:00Z', true),
      backup('later', '2026-10-15T03:00:00Z'),
    ];
    expect(needsMonthly(october, new Date('2026-10-28T03:00:00Z'))).toBe(false);
    expect(needsMonthly(october, new Date('2026-11-01T03:00:00Z'))).toBe(true);
    expect(
      needsMonthly([backup('plain', '2026-11-01T03:00:00Z')], new Date('2026-11-02T03:00:00Z')),
    ).toBe(true);
  });

  it('[adr:server-backup-and-google-docs#2] deletes only what is older than 31 days, so all of the last 30 stay restorable', () => {
    expect(retentionCutoff(new Date('2026-10-31T03:00:00Z')).toISOString()).toBe(
      '2026-09-30T03:00:00.000Z',
    );
  });
});

describe('the --to argument', () => {
  it('accepts latest and times with a zone', () => {
    expect(parseTarget('latest')).toBe('latest');
    expect(parseTarget('2026-10-28 21:04 UTC')).toEqual(new Date('2026-10-28T21:04:00Z'));
    expect(parseTarget('2026-10-28T21:04:00+08:00')).toEqual(new Date('2026-10-28T13:04:00Z'));
  });

  it('refuses a time without a zone instead of guessing one', () => {
    expect(() => parseTarget('2026-10-28 21:04')).toThrow(/time zone/);
    expect(() => parseTarget('yesterday Z')).toThrow(/not a time/);
  });
});

describe('Healthchecks pings', () => {
  const received: { url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url!, body });
      res.end('OK');
    });
  });
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/check`;
  });
  afterAll(() => {
    server.close();
  });

  it('[adr:server-backup-and-google-docs#3] reports start, success and failure with its reason', async () => {
    await ping(base, 'start');
    await ping(base, 'success', 'ok');
    await ping(base, 'fail', 'WAL archiving is failing');
    expect(received).toEqual([
      { url: '/check/start', body: '' },
      { url: '/check', body: 'ok' },
      { url: '/check/fail', body: 'WAL archiving is failing' },
    ]);
  });

  it('never fails the job it reports on', async () => {
    await expect(ping('http://127.0.0.1:1/unreachable', 'success')).resolves.toBeUndefined();
    await expect(ping(undefined, 'fail', 'skipped without a URL')).resolves.toBeUndefined();
  });
});
