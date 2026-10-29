import { driveConfig } from '../backup/drive-config.ts';
import { createCopyService } from '../backup/copy.ts';
import { parseConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { createReader } from '../reader/reader.ts';
import { createBackupStore } from '../store/backup.ts';
import { createCopyStore } from '../store/copy.ts';
import { createStore } from '../store/store.ts';
import { checkDrives } from './check.ts';
import { copyNext } from './copy.ts';
import { revokeNext } from './revoke.ts';

// The worker process (ADR-0006 item 20, server-backup-and-google-docs): same code base as the
// API, started on its own (`npm run start:worker`). It is the only process that opens Drive
// tokens. It logs what it did, never a token, code or diary text.

const POLL_MS = 5_000;
/** The daily check runs at start and then once a day (D8). */
const CHECK_MS = 24 * 60 * 60_000;

const config = parseConfig(process.env);
const drive = driveConfig(config);
const database = createDb(config.DATABASE_URL);
const backup = createBackupStore(database.db);
const copyStore = createCopyStore(database.db);
// History points form by the same rule as the API's, so a Doc holds what history shows.
const copy = createCopyService(
  copyStore,
  createReader(createStore(database.db)),
  config.HISTORY_IDLE_MS,
);
let stopping = false;
let checkedAt = 0;

async function tick() {
  if (!drive) return;
  while (!stopping && (await revokeNext(backup, drive)))
    console.log('worker: revoked a Drive grant');
  while (!stopping && (await copy.intake()) > 0);
  while (!stopping && (await copyNext({ copy, store: copyStore, drive })));
  if (!stopping && Date.now() - checkedAt >= CHECK_MS) {
    checkedAt = Date.now();
    await checkDrives({ store: copyStore, drive });
  }
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
