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
import { ROOT_FOLDER, type CopyStore, type WorkFailure } from '../store/copy.ts';
import type { SharedPageService } from '../shared-pages/shared-pages.ts';
import {
  pageIdOf,
  pageItem,
  type Category,
  type Item,
  type TogetherStore,
} from '../store/together.ts';
import { ensureFolders } from './folders.ts';

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

/** A `Together` Doc as the backup page names it (google-copy-beyond-diaries D8). */
export type ItemRef = {
  kind: 'page' | 'wishes' | 'gifts' | 'anniversaries';
  pageId: string | null;
  title: string | null;
};

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
    categories: { category: 'diaries' | Category; waiting: number; backedUpTo: Date | null }[];
    failingItems: { item: ItemRef; failure: 'unreachable' | 'failed' }[];
  } | null;
  attention: 'reconnect' | 'storage_full' | 'failing' | 'expiring' | null;
  events: {
    at: Date;
    kind: string;
    diaryDate: string | null;
    item: ItemRef | null;
    email: string | null;
  }[];
};

export type DayCopyStatus = {
  connected: boolean;
  docUrl: string | null;
  mine: string | null;
  partner: string | null;
  problem: 'reconnect' | WorkFailure | null;
};

/** A shared page's Doc in the caller's own Drive (google-copy-beyond-diaries D8). */
export type PageCopyStatus = {
  connected: boolean;
  docUrl: string | null;
  coveredAt: Date | null;
  problem: 'reconnect' | WorkFailure | null;
};

export type ConnectRefusal =
  | 'GOOGLE_UNAVAILABLE'
  | 'GOOGLE_STATE_INVALID'
  | 'GOOGLE_EXCHANGE_FAILED'
  | 'GOOGLE_DISCONNECTING'
  | 'GOOGLE_ACCOUNT_IN_USE';

export function createBackupService(
  store: BackupStore,
  copy: CopyStore,
  together: TogetherStore,
  pages: Pick<SharedPageService, 'titles'>,
  drive: DriveConfig | null,
) {
  /**
   * Names the items the page shows: a page by its current title, or by the one its Doc
   * last got once the page is gone or unreadable (D8); null when never known.
   */
  async function itemRefs(userId: string, items: readonly Item[]) {
    const pageIds = [...new Set(items.flatMap((i) => pageIdOf(i) ?? []))];
    const current = pageIds.length ? await pages.titles(userId, pageIds) : new Map();
    const written = pageIds.length ? await together.writtenTitles(userId) : new Map();
    return (item: Item): ItemRef => {
      const pageId = pageIdOf(item);
      if (!pageId) return { kind: item as ItemRef['kind'], pageId: null, title: null };
      return {
        kind: 'page',
        pageId,
        title: current.get(pageId) ?? written.get(pageItem(pageId)) ?? null,
      };
    };
  }

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
    const rows = await store.events(userId);
    const named = await itemRefs(
      userId,
      rows.flatMap((e) => e.item ?? []),
    );
    const events = rows.map((e) => ({ ...e, item: e.item === null ? null : named(e.item) }));
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
    const items = await together.progress(userId, row.googleUserId);
    const failingNamed = await itemRefs(
      userId,
      items.failing.map((f) => f.item),
    );
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
        categories: [
          {
            category: 'diaries',
            waiting: progress.waitingDays,
            backedUpTo: progress.backedUpTo,
          },
          ...items.categories,
        ],
        failingItems: items.failing.map((f) => ({
          item: failingNamed(f.item),
          failure: f.failure,
        })),
      },
      // Days and `Together` items count alike for the banner and the backup mail (D8).
      attention:
        state === 'reconnect'
          ? 'reconnect'
          : progress.storageFull || items.storageFull
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

    /**
     * "现在备份": queues what commits and space records registered and makes every waiting
     * day, page and summary due now (D9; google-copy-beyond-diaries D5).
     */
    async runNow(userId: string, now = new Date()): Promise<BackupStatus> {
      if (drive) {
        await copy.intake([userId]);
        await copy.runNow(userId, now);
        await together.intake(now, [userId]);
        await together.runNow(userId, now);
      }
      return status(userId, now);
    },

    /** One shared page in the caller's own Drive, for the page itself (D8). */
    async page(userId: string, pageId: string, now = new Date()): Promise<PageCopyStatus> {
      const row = drive && (await store.connection(userId));
      if (!drive || !row || row.status === 'revoking')
        return { connected: false, docUrl: null, coveredAt: null, problem: null };
      const item = pageItem(pageId);
      const doc = await together.currentDoc(userId, row.googleUserId, item);
      const written = doc && doc.revisionId !== '' ? doc : null;
      return {
        connected: true,
        docUrl: written && docUrl(written.docId),
        coveredAt: written?.coveredAt ?? null,
        problem:
          grant(row, drive, now).state === 'reconnect'
            ? 'reconnect'
            : await together.itemFailure(userId, item),
      };
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
      let grant: {
        refreshToken: string;
        accessToken: string;
        googleUserId: string;
        email: string;
      };
      try {
        const tokens = await exchangeCode(drive.client, code, codeVerifier);
        grant = { ...tokens, ...(await driveAccount(drive.client, tokens.accessToken)) };
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
      // The account is another user's connection: the new grant is only dropped, never
      // revoked, since revoking it would end that user's grant too (D9).
      if (outcome === 'in_use') return 'GOOGLE_ACCOUNT_IN_USE';
      // The `Between Pages` folder is made now, with the access token the exchange returned,
      // so "在 Google Drive 打开文件夹" works before the first Doc is written (D7 落地说明,
      // F-07). Not making it is no reason to refuse the connection: the worker makes it
      // before its first Doc anyway.
      try {
        await ensureFolders(
          drive.client.endpoints,
          copy,
          { userId, googleUserId: grant.googleUserId },
          grant.accessToken,
          [ROOT_FOLDER],
        );
      } catch (error) {
        const detail =
          error instanceof GoogleError ? `${error.status} ${error.code}` : (error as Error).name;
        console.warn(`backup: making the Drive folder on connect failed: ${detail}`);
      }
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
