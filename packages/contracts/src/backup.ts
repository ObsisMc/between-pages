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

export const BackupStatus = z
  .object({
    google: GoogleConnection,
    /** Newest first, at most 20. */
    events: z.array(BackupEvent),
  })
  .meta({ id: 'BackupStatus' });

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
