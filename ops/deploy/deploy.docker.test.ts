import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE, repoRoot, sh } from '../backup/lib.ts';

// The production overlay on a disposable project, started through up.sh, with WAL-G writing to
// a local directory instead of R2. Needs Docker; run with `npm run test:deploy`.

const enabled = process.env.DEPLOY_DOCKER_TEST === '1';
const PROJECT = 'between-pages-deploy-test';
const NETWORK = 'between_pages_deploy_test_proxy';
const API = 'between-pages-deploy-test-api';
const WEB = 'between-pages-deploy-test-web';
const FILES = [
  'compose.yaml',
  'ops/backup/compose.backup.yaml',
  'ops/deploy/compose.production.yaml',
  'ops/backup/compose.test.yaml',
  'ops/deploy/compose.test.yaml',
].join(':');
const run = promisify(execFile);

let dir = '';
let backupEnv = '';
let appEnv = '';
const password = randomBytes(24).toString('hex');

const up = () =>
  run('ops/deploy/up.sh', {
    cwd: repoRoot,
    env: { ...process.env, BACKUP_ENV_FILE: backupEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
const compose = (...args: string[]) =>
  sh('docker', ['compose', '--env-file', backupEnv, ...args], { stderr: true });

const appEnvFile = (dbPassword: string) =>
  [
    'HOST=0.0.0.0',
    'PORT=3000',
    `DATABASE_URL=postgresql://between_pages:${dbPassword}@postgres:5432/between_pages`,
    'PUBLIC_ORIGIN=https://missu.example',
    'AUTH_PROVIDER=google',
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64')}`,
    'GOOGLE_CLIENT_ID=test-client',
    'GOOGLE_CLIENT_SECRET=test-secret',
    `GOOGLE_TOKEN_KEY=${randomBytes(32).toString('base64')}`,
  ].join('\n');

/** A request from inside the proxy network, where the site Caddy sits. */
async function fromProxy(url: string) {
  const script = `fetch(${JSON.stringify(url)}, { redirect: 'manual' }).then(async (r) =>
    console.log(JSON.stringify({ status: r.status, cache: r.headers.get('cache-control'), type: r.headers.get('content-type'), body: await r.text() })))`;
  const out = await sh('docker', ['exec', API, 'node', '-e', script]);
  return JSON.parse(out) as {
    status: number;
    cache: string | null;
    type: string | null;
    body: string;
  };
}

/** The real production settings, from the examples Ray copies. */
const productionConfig = async (env: NodeJS.ProcessEnv) => {
  const { stdout } = await run(
    'docker',
    [
      'compose',
      '--env-file',
      'ops/backup/backup.env.example',
      'config',
      '--no-env-resolution',
      '--format',
      'json',
    ],
    { cwd: repoRoot, env: { ...process.env, ...env } },
  );
  return JSON.parse(stdout) as {
    name: string;
    services: Record<
      string,
      {
        ports?: { host_ip?: string; published?: string }[];
        networks?: Record<string, unknown>;
        depends_on?: Record<string, { condition: string }>;
      }
    >;
    networks: Record<string, { name: string }>;
    volumes: Record<string, { name: string }>;
  };
};

describe.runIf(enabled)('production stack', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'between-pages-deploy-'));
    const store = join(dir, 'store');
    await mkdir(store);
    await chmod(store, 0o777);
    backupEnv = join(dir, 'backup.env');
    appEnv = join(dir, 'app.env');
    await writeFile(
      backupEnv,
      [
        `BACKUP_ENV_FILE=${backupEnv}`,
        `APP_ENV_FILE=${appEnv}`,
        `BACKUP_FILE_DIR=${store}`,
        `COMPOSE_FILE=${FILES}`,
        `COMPOSE_PROJECT_NAME=${PROJECT}`,
        `POSTGRES_PASSWORD=${password}`,
        'DB_PORT=54339',
        'WALG_FILE_PREFIX=/backup',
        `WALG_LIBSODIUM_KEY=${randomBytes(32).toString('hex')}`,
        'WALG_LIBSODIUM_KEY_TRANSFORM=hex',
        'WALG_COMPRESSION_METHOD=zstd',
        `LIVE_DATABASE_URL=postgresql://between_pages:${password}@127.0.0.1:54339/between_pages`,
        `DRILL_STATE_FILE=${join(dir, 'drill-state.json')}`,
      ].join('\n'),
    );
    await sh('docker', ['network', 'create', NETWORK]);
    // Wrong on purpose: the first start has to stop at the migration.
    await writeFile(appEnv, appEnvFile('wrong-password'));
  }, 60_000);

  afterAll(async () => {
    await compose('down', '-v', '--remove-orphans').catch(() => '');
    await sh('docker', ['network', 'rm', NETWORK]).catch(() => '');
    // Files the container wrote belong to its postgres user; remove them from inside.
    await sh('docker', ['run', '--rm', '-v', `${dir}:/d`, IMAGE, 'sh', '-c', 'rm -rf /d/*']).catch(
      () => '',
    );
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('[adr:production-deployment#2] refuses to start without POSTGRES_PASSWORD', async () => {
    await expect(productionConfig({})).rejects.toThrow(/POSTGRES_PASSWORD/);
  });

  it('[adr:production-deployment#3] [adr:production-deployment#4] [adr:production-deployment#6] keeps production apart from development and the database off the proxy', async () => {
    const config = await productionConfig({ POSTGRES_PASSWORD: 'x' });

    expect(config.name).toBe('between-pages-prod');
    expect(config.volumes.pgdata!.name).toBe('between-pages-prod_pgdata');
    expect(config.networks.proxy!.name).toBe('between_pages_proxy');
    expect(Object.keys(config.services.postgres!.networks!)).toEqual(['internal']);
    expect(Object.keys(config.services.web!.networks!)).toEqual(['proxy']);
    const published = Object.entries(config.services).filter(([, s]) => s.ports?.length);
    expect(published.map(([name]) => name)).toEqual(['postgres']);
    expect(config.services.postgres!.ports).toMatchObject([
      { host_ip: '127.0.0.1', published: '54330' },
    ]);
  });

  it('[adr:production-deployment#7] does not start the API when the migration fails', async () => {
    await expect(up()).rejects.toThrow();
    const states = await compose('ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}');
    expect(states).toMatch(/^migrate exited [1-9]/m);
    expect(states).not.toMatch(/^(api|worker) running/m);
  }, 1_800_000);

  it('starts the whole stack from an empty volume', async () => {
    await compose('down', '--remove-orphans');
    await writeFile(appEnv, appEnvFile(password));
    await up();

    const running = await compose('ps', '--status', 'running', '--services');
    expect(running.split('\n').filter(Boolean).sort()).toEqual([
      'api',
      'postgres',
      'web',
      'worker',
    ]);
    const health = await fromProxy(`http://${API}:3000/api/health`);
    expect(health.status).toBe(200);
    expect(await sh('docker', ['exec', API, 'printenv', 'NODE_ENV'])).toBe('production\n');
  }, 600_000);

  it('[adr:production-deployment#8] serves the app on any path and caches only hashed files for long', async () => {
    const page = await fromProxy(`http://${WEB}/days/2026-11-05`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root">');
    expect(page.cache).toBe('no-cache');

    const asset = /\/assets\/[^"]+\.js/.exec(page.body)![0];
    const hashed = await fromProxy(`http://${WEB}${asset}`);
    expect(hashed.status).toBe(200);
    expect(hashed.cache).toContain('immutable');

    const gone = await fromProxy(`http://${WEB}/assets/gone.js`);
    expect(gone.status).toBe(404);
    expect(gone.cache ?? '').not.toContain('immutable');
  }, 60_000);

  it('serves the tab icon and the manifest as files, not as the page', async () => {
    const icon = await fromProxy(`http://${WEB}/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.type).toContain('image/svg+xml');
    expect(icon.body).toContain('<svg');

    const manifest = await fromProxy(`http://${WEB}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.type).toContain('application/manifest+json');
    expect(JSON.parse(manifest.body)).toMatchObject({ display: 'standalone' });
  }, 60_000);

  it('[adr:production-deployment#4] leaves no route from the proxy network to the database', async () => {
    await expect(sh('docker', ['exec', WEB, 'nslookup', 'postgres'])).rejects.toThrow();
  }, 60_000);

  it('[adr:production-deployment#10] logs requests without their query string', async () => {
    await fromProxy(`http://${API}:3000/api/auth/callback/google?code=secret-code&state=secret`);
    const logs = await compose('logs', 'api');
    expect(logs).toContain('/api/auth/callback/google');
    expect(logs).not.toContain('secret-code');
  }, 60_000);

  it('keeps secrets and local files out of the image', async () => {
    const files = await sh('docker', ['exec', API, 'ls', '-a', '/app']);
    expect(files).not.toMatch(/^\.env/m);
    expect(files).not.toMatch(/^\.git$/m);
  }, 60_000);

  it('keeps the data across an update', async () => {
    const psql = (sql: string) => compose('exec', '-T', 'postgres', 'psql', '-At', '-c', sql);
    await psql("insert into users (id, display_name) values (gen_random_uuid(), 'kept')");
    await up();
    expect(await psql("select count(*) from users where display_name = 'kept'")).toContain('1');
  }, 600_000);

  it('backs up and drills the production database with the scripts Ray runs', async () => {
    const script = (name: string) =>
      run(process.execPath, [`--env-file=${backupEnv}`, `ops/backup/${name}.ts`], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });

    expect((await script('backup')).stdout).toContain('backup ok');
    expect((await script('drill')).stdout).toContain('drill ok');
  }, 600_000);
});
