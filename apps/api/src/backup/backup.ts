import {
  GoogleError,
  authorizationUrl,
  driveAccount,
  exchangeCode,
  newAuthorization,
  stateSha256,
  type GoogleClient,
} from '../google/oauth.ts';
import { keyIdOf, sealToken } from '../google/tokens.ts';
import type { BackupStore } from '../store/backup.ts';

// The Drive connection as the API serves it (server-backup-and-google-docs D9, D10). The API
// seals the refresh token it receives and never opens one: revoking and using tokens is the
// worker's (invariant 11). Everything here concerns the caller's own connection only.

export type DriveConfig = {
  client: GoogleClient;
  tokenKey: Buffer;
  /** The Google app is in Testing: grants stop working after seven days (D9). */
  testing: boolean;
};

const AUTHORIZATION_MS = 10 * 60_000;
const TESTING_GRANT_MS = 7 * 24 * 60 * 60_000;

export type BackupStatus = {
  google: {
    state: 'unavailable' | 'disconnected' | 'connected' | 'reconnect' | 'disconnecting';
    email: string | null;
    connectedAt: Date | null;
    expiresAt: Date | null;
  };
  events: { at: Date; kind: string; diaryDate: string | null }[];
};

export type ConnectRefusal =
  'GOOGLE_UNAVAILABLE' | 'GOOGLE_STATE_INVALID' | 'GOOGLE_EXCHANGE_FAILED' | 'GOOGLE_DISCONNECTING';

export function createBackupService(store: BackupStore, drive: DriveConfig | null) {
  async function status(userId: string, now = new Date()): Promise<BackupStatus> {
    const events = await store.events(userId);
    if (!drive)
      return {
        google: { state: 'unavailable', email: null, connectedAt: null, expiresAt: null },
        events,
      };
    const row = await store.connection(userId);
    if (!row)
      return {
        google: { state: 'disconnected', email: null, connectedAt: null, expiresAt: null },
        events,
      };
    if (row.status === 'revoking') {
      return {
        google: { state: 'disconnecting', email: null, connectedAt: null, expiresAt: null },
        events,
      };
    }
    // A token sealed under a key this server no longer has can never be used (D10.7).
    const usable = row.status === 'active' && row.keyId === keyIdOf(drive.tokenKey);
    const expiresAt = drive.testing ? new Date(row.connectedAt.getTime() + TESTING_GRANT_MS) : null;
    const expired = expiresAt !== null && expiresAt <= now;
    return {
      google: {
        state: usable && !expired ? 'connected' : 'reconnect',
        email: row.email,
        connectedAt: row.connectedAt,
        expiresAt,
      },
      events,
    };
  }

  return {
    status,

    /** The consent URL for a new authorization of the caller. */
    async start(userId: string, now = new Date()): Promise<{ url: string } | ConnectRefusal> {
      if (!drive) return 'GOOGLE_UNAVAILABLE';
      if ((await store.connection(userId))?.status === 'revoking') return 'GOOGLE_DISCONNECTING';
      const { state, codeVerifier, codeChallenge } = newAuthorization();
      await store.saveAuthorization(
        userId,
        stateSha256(state),
        codeVerifier,
        new Date(now.getTime() + AUTHORIZATION_MS),
      );
      return { url: authorizationUrl(drive.client, state, codeChallenge) };
    },

    /**
     * Completes the caller's own authorization: the state must be one the same user started
     * within ten minutes. The connected account is the one the grant belongs to.
     */
    async finish(
      userId: string,
      code: string,
      state: string,
      now = new Date(),
    ): Promise<BackupStatus | ConnectRefusal> {
      if (!drive) return 'GOOGLE_UNAVAILABLE';
      const codeVerifier = await store.takeAuthorization(userId, stateSha256(state), now);
      if (!codeVerifier) return 'GOOGLE_STATE_INVALID';
      let grant: { refreshToken: string; googleUserId: string; email: string };
      try {
        const tokens = await exchangeCode(drive.client, code, codeVerifier);
        grant = {
          refreshToken: tokens.refreshToken,
          ...(await driveAccount(drive.client, tokens.accessToken)),
        };
      } catch (error) {
        if (error instanceof GoogleError) return 'GOOGLE_EXCHANGE_FAILED';
        throw error;
      }
      const sealed = sealToken(drive.tokenKey, grant.refreshToken);
      const outcome = await store.connect({
        userId,
        googleUserId: grant.googleUserId,
        email: grant.email,
        refreshToken: sealed.ciphertext,
        tokenNonce: sealed.nonce,
        keyId: sealed.keyId,
        status: 'active',
        connectedAt: now,
      });
      if (outcome === 'disconnecting') return 'GOOGLE_DISCONNECTING';
      return status(userId, now);
    },

    /** Stops backing up at once; the worker revokes the grant. Drive files stay. */
    async disconnect(userId: string): Promise<BackupStatus> {
      await store.disconnect(userId);
      return status(userId);
    },
  };
}

export type BackupService = ReturnType<typeof createBackupService>;
