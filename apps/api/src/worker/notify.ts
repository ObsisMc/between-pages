import { createAnniversaryService } from '../anniversaries/anniversaries.ts';
import { createAddresses } from '../auth/email.ts';
import { createBackupService, type DriveConfig } from '../backup/backup.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { createHistoryService } from '../history/history.ts';
import { createMailer } from '../mail/resend.ts';
import type { Scope } from '../notify/compose.ts';
import { createNotify, type NotifyDeps } from '../notify/notify.ts';
import { createReader, createReaderMemo } from '../reader/reader.ts';
import { createSharedPageService } from '../shared-pages/shared-pages.ts';
import { createSpaceRecords } from '../space-records/space-records.ts';
import { createReminderStore } from '../store/anniversaries.ts';
import { createBackupStore } from '../store/backup.ts';
import { createCopyStore } from '../store/copy.ts';
import { createTogetherStore } from '../store/together.ts';
import { createMailStore } from '../store/mail.ts';
import { createSpaceRecordStore } from '../store/space-records.ts';
import { createStore } from '../store/store.ts';
import { createWishService } from '../wishes/wishes.ts';

const RESEND_API = 'https://api.resend.com';

/**
 * The services a reminder reads (email-reminders D3, D6, D7), built over one snapshot's
 * transaction so they all see the same state. One reader memo is kept across snapshots, so
 * a diary's text is rebuilt only when it changed (D10).
 */
export function reminderScope(drive: DriveConfig | null, historyIdleMs?: number): Scope {
  const memo = createReaderMemo();
  return (tx) => {
    // A transaction works where the stores take the pool: their own transactions become
    // savepoints of it, so every read below shares its snapshot.
    const db = tx as unknown as Db;
    const reader = createReader(createStore(db), memo);
    const history = createHistoryService(reader, historyIdleMs);
    const records = createSpaceRecords(createSpaceRecordStore(db));
    const wishes = createWishService(records);
    const pages = createSharedPageService(records);
    const anniversaries = createAnniversaryService(records, createReminderStore(db));
    const backup = createBackupService(
      createBackupStore(db),
      createCopyStore(db),
      createTogetherStore(db),
      pages,
      drive,
    );
    return {
      freshDiaries: (viewer, notified, now) =>
        reader.freshDiaries(viewer, notified, history.settled(now)),
      wishItems: (viewer) => wishes.unreadItems(viewer),
      pageItems: (viewer) => pages.unreadItems(viewer),
      anniversaries: (viewer, zone, now) => anniversaries.view(viewer, zone, now),
      backupAttention: async (viewer, now) => (await backup.status(viewer, now)).attention,
    };
  };
}

/** Email reminders for this worker, or null without `RESEND_API_KEY` (invariant 11). */
export function reminders(
  config: Config,
  db: Db,
  drive: DriveConfig | null,
  logs?: Pick<NotifyDeps, 'log' | 'warn'>,
) {
  if (!config.RESEND_API_KEY) return null;
  return createNotify({
    store: createMailStore(db),
    scope: reminderScope(drive, config.HISTORY_IDLE_MS),
    addresses: createAddresses(db),
    mailer: createMailer({
      apiKey: config.RESEND_API_KEY,
      // Checked by parseConfig whenever RESEND_API_KEY is set.
      from: config.MAIL_FROM!,
      baseUrl: config.RESEND_BASE_URL ?? RESEND_API,
    }),
    tokenKey: Buffer.from(config.MAIL_TOKEN_KEY!, 'base64'),
    origin: config.publicOrigin,
    ...logs,
  });
}
