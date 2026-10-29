import {
  GoogleError,
  authorizationUrl,
  driveAccount,
  exchangeCode,
  newAuthorization,
  stateSha256,
  type GoogleClient,
} from '../google/oauth.ts';
import { docUrl, folderUrl } from '../google/docs.ts';
import { keyIdOf, sealToken } from '../google/tokens.ts';
import type { BackupStore } from '../store/backup.ts';
import type { ConnectionRow } from '../store/backup.ts';
import type { CopyStore, WorkFailure } from '../store/copy.ts';

// The Drive connection and the readable copy's progress as the API serves them
// (server-backup-and-google-docs D9, D10). The API seals the refresh token it receives and
// never opens one: revoking and using tokens is the worker's (invariant 11). Everything here
// concerns the caller's own connection and Drive only (invariant 14).

export type DriveConfig = {
  client: GoogleClient;
  tokenKey: Buffer;
  /** The Google app is in Testing: grants stop working after seven days (D9). */
  testing: boolean;
};

const AUTHORIZATION_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TESTING_GRANT_MS = 7 * DAY_MS;
/** From the sixth day of a Testing-mode grant, the home page asks to reconnect (D9). */
const EXPIRY_WARNING_MS = 2 * DAY_MS;
/** A run of failed writes this long puts a banner on the home page (D9, Ray 2026-10-29). */
const FAILING_BANNER_MS = DAY_MS;

export type BackupStatus = {
  google: {
    state: 'unavailable' | 'disconnected' | 'connected' | 'reconnect' | 'disconnecting';
    email: string | null;
    connectedAt: Date | null;
    expiresAt: Date | null;
    /** While disconnecting: telling Google failed so far and is being retried. */
    retrying: boolean;
  };
  progress: {
    waitingDays: number;
    failing: { diaryDate: string; failure: 'unreachable' | 'failed' }[];
    backedUpTo: Date | null;
    folderUrl: string | null;
  } | null;
  attention: 'reconnect' | 'storage_full' | 'failing' | 'expiring' | null;
  events: { at: Date; kind: string; diaryDate: string | null }[];
};

export type DayCopyStatus = {
  connected: boolean;
  docUrl: string | null;
  mine: string | null;
  partner: string | null;
  problem: 'reconnect' | WorkFailure | null;
};

export type ConnectRefusal =
  'GOOGLE_UNAVAILABLE' | 'GOOGLE_STATE_INVALID' | 'GOOGLE_EXCHANGE_FAILED' | 'GOOGLE_DISCONNECTING';

export function createBackupService(
  store: BackupStore,
  copy: CopyStore,
  drive: DriveConfig | null,
) {
  /** Whether the grant still works, and when a Testing-mode grant ends. */
  function grant(row: ConnectionRow, driveConfig: DriveConfig, now: Date) {
    // A token sealed under a key this server no longer has can never be used (D10.7).
    const usable = row.status === 'active' && row.keyId === keyIdOf(driveConfig.tokenKey);
    const expiresAt = driveConfig.testing
      ? new Date(row.connectedAt.getTime() + TESTING_GRANT_MS)
      : null;
    const expired = expiresAt !== null && expiresAt <= now;
    return {
      state: usable && !expired ? ('connected' as const) : ('reconnect' as const),
      expiresAt,
    };
  }

  async function status(userId: string, now = new Date()): Promise<BackupStatus> {
    const events = await store.events(userId);
    const without = (state: BackupStatus['google']['state'], retrying = false): BackupStatus => ({
      google: { state, email: null, connectedAt: null, expiresAt: null, retrying },
      progress: null,
      attention: null,
      events,
    });
    if (!drive) return without('unavailable');
    const row = await store.connection(userId);
    if (!row) return without('disconnected');
    if (row.status === 'revoking') return without('disconnecting', row.attempts > 0);
    const { state, expiresAt } = grant(row, drive, now);
    const progress = await copy.progress(userId, row.googleUserId);
    const expiring = expiresAt !== null && expiresAt.getTime() - now.getTime() <= EXPIRY_WARNING_MS;
    const longFailing =
      progress.failingSince !== null &&
      now.getTime() - progress.failingSince.getTime() >= FAILING_BANNER_MS;
    return {
      google: {
        state,
        email: row.email,
        connectedAt: row.connectedAt,
        expiresAt,
        retrying: false,
      },
      progress: {
        waitingDays: progress.waitingDays,
        failing: progress.failing,
        backedUpTo: progress.backedUpTo,
        folderUrl: progress.rootFolderId && folderUrl(progress.rootFolderId),
      },
      attention:
        state === 'reconnect'
          ? 'reconnect'
          : progress.storageFull
            ? 'storage_full'
            : longFailing
              ? 'failing'
              : expiring
                ? 'expiring'
                : null,
      events,
    };
  }

  return {
    status,

    /** "现在备份": queues what commits registered and makes every waiting day due now (D9). */
    async runNow(userId: string, now = new Date()): Promise<BackupStatus> {
      if (drive) {
        await copy.intake([userId]);
        await copy.runNow(userId, now);
      }
      return status(userId, now);
    },

    /** One date in the caller's own Drive, for the day page (D9). */
    async day(userId: string, diaryDate: string, now = new Date()): Promise<DayCopyStatus> {
      const row = drive && (await store.connection(userId));
      if (!drive || !row || row.status === 'revoking')
        return { connected: false, docUrl: null, mine: null, partner: null, problem: null };
      const doc = await copy.currentDoc(userId, row.googleUserId, diaryDate);
      const written = doc && doc.revisionId !== '' ? doc : null;
      return {
        connected: true,
        docUrl: written && docUrl(written.docId),
        mine: written?.covers.mine?.at ?? null,
        partner: written?.covers.partner?.at ?? null,
        problem:
          grant(row, drive, now).state === 'reconnect'
            ? 'reconnect'
            : await copy.dayFailure(userId, diaryDate),
      };
    },

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
