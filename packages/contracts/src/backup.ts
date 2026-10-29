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
  })
  .meta({ id: 'GoogleConnection' });

export const BackupEventKind = z.enum([
  'doc_replaced',
  'doc_recreated',
  'storage_full',
  'revoke_failed',
  'reconnect_needed',
]);

export const BackupEvent = z
  .object({
    at: z.iso.datetime(),
    kind: BackupEventKind,
    diaryDate: z.iso.date().nullable(),
  })
  .meta({ id: 'BackupEvent' });

/** How far the readable copy is (D9); only while a connection exists. */
export const BackupProgress = z
  .object({
    /** Days whose Doc is not yet written up to their newest history point. */
    waitingDays: z.number().int().nonnegative(),
    /** Google could not be reached or refused for a while; retrying on its own. */
    retrying: z.boolean(),
    /** The newest version any Doc holds: "全部日记已备份到 9:22 的版本". */
    backedUpTo: z.iso.datetime().nullable(),
    /** The app's `Between Pages` folder in Drive, once created. */
    folderUrl: z.url().nullable(),
  })
  .meta({ id: 'BackupProgress' });

/**
 * Why the home page shows a banner: only when the user has to act (D9). `expiring`: the
 * Testing-mode grant ends within a day.
 */
export const BackupAttention = z.enum(['reconnect', 'storage_full', 'expiring']);

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
  })
  .meta({ id: 'DayGoogleCopy' });

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
