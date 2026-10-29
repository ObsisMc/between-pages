import { driveConfig } from '../backup/drive-config.ts';
import { parseConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { createBackupStore } from '../store/backup.ts';
import { revokeNext } from './revoke.ts';

// The worker process (ADR-0006 item 20, server-backup-and-google-docs): same code base as the
// API, started on its own (`npm run start:worker`). It is the only process that opens Drive
// tokens. It logs what it did, never a token, code or diary text.

const POLL_MS = 5_000;

const config = parseConfig(process.env);
const drive = driveConfig(config);
const database = createDb(config.DATABASE_URL);
const backup = createBackupStore(database.db);
let stopping = false;

async function tick() {
  if (!drive) return;
  while (!stopping && (await revokeNext(backup, drive)))
    console.log('worker: revoked a Drive grant');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}
console.log(drive ? 'worker: started' : 'worker: Google Drive is not configured; idle');
while (!stopping) {
  try {
    await tick();
  } catch (error) {
    console.error(`worker: ${(error as Error).message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
await database.close();
