import type { DriveConfig } from '../backup/backup.ts';
import { GoogleError, revoke } from '../google/oauth.ts';
import { openToken } from '../google/tokens.ts';
import type { BackupStore } from '../store/backup.ts';

// Disconnecting (server-backup-and-google-docs D10.6): the worker revokes the grant at Google,
// then deletes the ciphertext. When Google cannot be reached for about a day, or the token
// can no longer be opened, the ciphertext is deleted anyway and the backup page asks the user
// to remove the app under their Google account's third-party access.

const MAX_ATTEMPTS = 30;
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 60 * 60_000);

/** Handles one due revocation; false when none is due. */
export async function revokeNext(
  store: BackupStore,
  drive: DriveConfig,
  now = new Date(),
): Promise<boolean> {
  const handled = await store.withDueRevocation(now, async (row, outcome) => {
    const token = openToken(drive.tokenKey, {
      ciphertext: row.refreshToken,
      nonce: row.tokenNonce,
      keyId: row.keyId,
    });
    if (!token) {
      await outcome.gaveUp();
      return true;
    }
    try {
      await revoke(drive.client, token);
      await outcome.revoked();
    } catch (error) {
      const reason = error instanceof GoogleError ? error.code : 'network';
      if (row.attempts + 1 >= MAX_ATTEMPTS) await outcome.gaveUp();
      else await outcome.retry(reason, new Date(now.getTime() + backoffMs(row.attempts)));
    }
    return true;
  });
  return handled ?? false;
}
