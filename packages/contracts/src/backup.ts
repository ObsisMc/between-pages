import { z } from 'zod';

// The backup page (server-backup-and-google-docs D9): the caller's own Google Drive
// connection and the problems worth showing. Visible to its owner only (invariant 14).

/**
 * `unavailable`: this server has no Google client or token key configured.
 * `disconnecting`: disconnected by the user, the grant not yet revoked at Google.
 * `reconnect`: the grant was revoked, expired or can no longer be decrypted.
 */
export const GoogleConnectionState = z.enum([
  'unavailable',
  'disconnected',
  'connected',
  'reconnect',
  'disconnecting',
]);

export const GoogleConnection = z
  .object({
    state: GoogleConnectionState,
    /** The connected Google account; null unless connected or waiting to reconnect. */
    email: z.string().nullable(),
    connectedAt: z.iso.datetime().nullable(),
    /** Only while the Google app is in Testing: when the grant stops working (D9). */
    expiresAt: z.iso.datetime().nullable(),
    /** While `disconnecting`: Google could not be told yet; the server keeps trying. */
    retrying: z.boolean(),
  })
  .meta({ id: 'GoogleConnection' });

export const BackupEventKind = z.enum([
  'doc_replaced',
  'doc_recreated',
  'storage_full',
  'revoke_failed',
  'reconnect_needed',
  /** A run of failed writes began on this date; retried on its own. */
  'copy_failing',
  /** The daily check could not read the Drive; tried again the next day. */
  'check_failed',
  /**
   * The connection shared its Google account with another user's and was removed when one
   * account became one user's (google-copy-beyond-diaries D9); `email` names that account.
   */
  'account_in_use',
]);

/**
 * A `Together` Doc (google-copy-beyond-diaries D4): one shared page, by its ID and title
 * (the current one, or the one its Doc last got once the page is gone; `''` untitled,
 * null when never known), or one of the three summaries.
 */
export const BackupItem = z
  .object({
    kind: z.enum(['page', 'wishes', 'gifts', 'anniversaries']),
    pageId: z.uuid().nullable(),
    title: z.string().nullable(),
  })
  .meta({ id: 'BackupItem' });

export const BackupEvent = z
  .object({
    at: z.iso.datetime(),
    kind: BackupEventKind,
    diaryDate: z.iso.date().nullable(),
    /** The page or summary the entry is about; null for a day or the whole Drive. */
    item: BackupItem.nullable(),
    /** Only on `account_in_use`. */
    email: z.string().nullable(),
  })
  .meta({ id: 'BackupEvent' });

/** What the backup page lists by kind (google-copy-beyond-diaries D8). */
export const BackupCategory = z
  .enum(['diaries', 'shared_pages', 'wishes', 'gifts', 'anniversaries'])
  .meta({ id: 'BackupCategory' });

/** How far the readable copy is (D9); only while a connection exists. */
export const BackupProgress = z
  .object({
    /** Days whose Doc is not yet written up to their newest history point. */
    waitingDays: z.number().int().nonnegative(),
    /**
     * Days whose last attempt failed, newest first, each retried on its own: `unreachable`
     * while Google cannot be reached, `failed` for any other reason. A full Drive is `attention`.
     */
    failing: z.array(
      z.object({ diaryDate: z.iso.date(), failure: z.enum(['unreachable', 'failed']) }),
    ),
    /** The newest version any Doc holds: "全部日记已备份到 9:22 的版本". */
    backedUpTo: z.iso.datetime().nullable(),
    /** The app's `Between Pages` folder in Drive, once created. */
    folderUrl: z.url().nullable(),
    /**
     * Each kind in the order the page shows them (D8): how many days or Docs wait, and the
     * newest state a Doc of it holds ("已备份到 9:22"); `diaries` repeats the two above.
     */
    categories: z.array(
      z.object({
        category: BackupCategory,
        waiting: z.number().int().nonnegative(),
        backedUpTo: z.iso.datetime().nullable(),
      }),
    ),
    /** Pages and summaries whose last attempt failed, as `failing` for days. */
    failingItems: z.array(
      z.object({ item: BackupItem, failure: z.enum(['unreachable', 'failed']) }),
    ),
  })
  .meta({ id: 'BackupProgress' });

/**
 * Why the home page shows a banner (D9): the user has to act (`reconnect`, `storage_full`,
 * `expiring`: the Testing-mode grant ends within two days), or writes have been failing for
 * a day (`failing`, Ray 2026-10-29).
 */
export const BackupAttention = z.enum(['reconnect', 'storage_full', 'failing', 'expiring']);

export const BackupStatus = z
  .object({
    google: GoogleConnection,
    progress: BackupProgress.nullable(),
    attention: BackupAttention.nullable(),
    /** Newest first, at most 20. */
    events: z.array(BackupEvent),
  })
  .meta({ id: 'BackupStatus' });

/**
 * One date in the caller's own Drive (D9): when the Doc last took each diary's version, by
 * its commit time, and where to open it. Never about the partner's Drive (invariant 14).
 */
export const DayGoogleCopy = z
  .object({
    /** A Drive connection exists, working or waiting to reconnect. */
    connected: z.boolean(),
    docUrl: z.url().nullable(),
    mine: z.iso.datetime().nullable(),
    partner: z.iso.datetime().nullable(),
    /**
     * Why newer versions of this day are not in the Doc yet: the grant needs reconnecting,
     * the Drive is full, Google cannot be reached, or the write failed otherwise; null when
     * nothing failed.
     */
    problem: z.enum(['reconnect', 'storage_full', 'unreachable', 'failed']).nullable(),
  })
  .meta({ id: 'DayGoogleCopy' });

/**
 * A shared page's Doc in the caller's own Drive (google-copy-beyond-diaries D8), as
 * `DayGoogleCopy` for a day: `coveredAt` is when the state the Doc holds was committed.
 */
export const PageGoogleCopy = z
  .object({
    connected: z.boolean(),
    docUrl: z.url().nullable(),
    coveredAt: z.iso.datetime().nullable(),
    problem: z.enum(['reconnect', 'storage_full', 'unreachable', 'failed']).nullable(),
  })
  .meta({ id: 'PageGoogleCopy' });

export const BackupResponse = z.object({ backup: BackupStatus }).meta({ id: 'BackupResponse' });

export const StartGoogleResponse = z
  .object({
    /** Google's consent page; the browser goes there and comes back to /backup/google/callback. */
    url: z.url(),
  })
  .meta({ id: 'StartGoogleResponse' });

export const FinishGoogleRequest = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(256),
  })
  .meta({ id: 'FinishGoogleRequest' });
