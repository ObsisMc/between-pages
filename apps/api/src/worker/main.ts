import { driveConfig } from '../backup/drive-config.ts';
import { createCopyService } from '../backup/copy.ts';
import { createTogetherCopy } from '../backup/together.ts';
import { createAnniversaryService } from '../anniversaries/anniversaries.ts';
import { createSharedPageService } from '../shared-pages/shared-pages.ts';
import { createSpaceRecords } from '../space-records/space-records.ts';
import { createReminderStore } from '../store/anniversaries.ts';
import { createSpaceRecordStore } from '../store/space-records.ts';
import { createTogetherStore } from '../store/together.ts';
import { createWishService } from '../wishes/wishes.ts';
import { parseConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { createReader } from '../reader/reader.ts';
import { createBackupStore } from '../store/backup.ts';
import { createCopyStore } from '../store/copy.ts';
import { createStore } from '../store/store.ts';
import { createPreviewStore } from '../store/wishes.ts';
import { JUDGE_EVERY_MS } from '../notify/rules.ts';
import { checkDrives } from './check.ts';
import { copyNext } from './copy.ts';
import { reminders } from './notify.ts';
import { previewNext } from './preview.ts';
import { revokeNext } from './revoke.ts';
import { togetherNext } from './together.ts';

// The worker process (ADR-0006 item 20, server-backup-and-google-docs): same code base as the
// API, started on its own (`npm run start:worker`). It is the only process that opens Drive
// tokens. It also reads wish links for their previews (wishes-and-gifts D7) and sends email
// reminders (email-reminders D10), with or without Drive. It logs what it did, never a
// token, code, link, address or diary text.

const POLL_MS = 5_000;
/** The daily check runs at start and then once a day (D8). */
const CHECK_MS = 24 * 60 * 60_000;

const config = parseConfig(process.env);
const drive = driveConfig(config);
const database = createDb(config.DATABASE_URL);
const backup = createBackupStore(database.db);
const copyStore = createCopyStore(database.db);
const previews = createPreviewStore(database.db);
// History points form by the same rule as the API's, so a Doc holds what history shows.
const copy = createCopyService(
  copyStore,
  createReader(createStore(database.db)),
  config.HISTORY_IDLE_MS,
);
// The `Together` Docs read through the same per-viewer services the API answers with
// (google-copy-beyond-diaries invariant 1).
const records = createSpaceRecords(createSpaceRecordStore(database.db));
const togetherStore = createTogetherStore(database.db);
const together = createTogetherCopy(
  togetherStore,
  {
    pages: createSharedPageService(records),
    wishes: createWishService(records),
    anniversaries: createAnniversaryService(records, createReminderStore(database.db)),
  },
  config.HISTORY_IDLE_MS,
);
const notify = reminders(config, database.db, drive);
let stopping = false;
let checkedAt = 0;
let judgedAt = 0;

async function tick() {
  while (!stopping && (await previewNext(previews)) > 0);
  if (notify) {
    if (!stopping && Date.now() - judgedAt >= JUDGE_EVERY_MS) {
      judgedAt = Date.now();
      await notify.judge(new Date());
    }
    while (!stopping && (await notify.sendNext(new Date())));
  }
  if (!drive) return;
  while (!stopping && (await revokeNext(backup, drive)))
    console.log('worker: revoked a Drive grant');
  while (!stopping && (await copy.intake()) > 0);
  while (!stopping && (await copyNext({ copy, store: copyStore, drive })));
  while (!stopping && (await together.intake(new Date())) > 0);
  while (
    !stopping &&
    (await togetherNext({ copy: together, store: togetherStore, copyStore, drive }))
  );
  if (!stopping && Date.now() - checkedAt >= CHECK_MS) {
    checkedAt = Date.now();
    await checkDrives({ store: copyStore, together: togetherStore, drive });
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}
console.log(
  drive ? 'worker: started' : 'worker: Google Drive is not configured; reading link previews only',
);
if (!notify) console.log('worker: RESEND_API_KEY is not set; email reminders are off');
while (!stopping) {
  try {
    await tick();
  } catch (error) {
    console.error(`worker: ${(error as Error).message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
await database.close();
