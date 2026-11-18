import type { DriveConfig } from '../backup/backup.ts';
import type { CopyService } from '../backup/copy.ts';
import { ensureFolders } from '../backup/folders.ts';
import { replacedTitle, type DayDoc } from '../backup/render.ts';
import {
  DOC_TYPE,
  type DocBody,
  createFile,
  docRevision,
  fileState,
  rename,
  replaceBody,
} from '../google/docs.ts';
import { GoogleError, accessToken } from '../google/oauth.ts';
import { keyIdOf, openToken } from '../google/tokens.ts';
import type { ConnectionRow } from '../store/backup.ts';
import type { CopyStore, WorkOutcome, WorkRow } from '../store/copy.ts';

// Writing one day's Doc into one person's Drive (server-backup-and-google-docs D6–D8,
// technical design steps 3–4). The worker opens the refresh token only here, for one day,
// and keeps it and the access token in memory. A Doc is written only while it is still at
// the revision this app last wrote (invariant 8). One changed in Google keeps its content
// under a new name and a new Doc carries on; one deleted is made again (invariant 9).
// Nothing in Drive is ever deleted.

const RETRY_MAX_MS = 60 * 60_000;
/** Storage full waits for the user; a daily look resumes once they made room (D9). */
const STORAGE_FULL_MS = 24 * 60 * 60_000;

const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, RETRY_MAX_MS);

/** The Doc changed in Google, or is gone or in the bin; never written into. */
export class DocUnavailable extends Error {
  readonly reason: 'changed' | 'missing';
  constructor(reason: 'changed' | 'missing') {
    super(`doc_${reason}`);
    this.reason = reason;
  }
}

export type CopyDeps = { copy: CopyService; store: CopyStore; drive: DriveConfig };

/** The day's current Doc, created (and recorded before any write) when there is none. */
async function currentOrNew(
  deps: CopyDeps,
  connection: ConnectionRow,
  work: WorkRow,
  token: string,
  doc: DayDoc,
) {
  const find = () =>
    deps.store.currentDoc(connection.userId, connection.googleUserId, work.diaryDate);
  const found = await find();
  if (found) return found;
  const docId = await createFile(deps.drive.client.endpoints, token, {
    name: doc.title,
    type: DOC_TYPE,
    parentId: await ensureFolders(
      deps.drive.client.endpoints,
      deps.store,
      connection,
      token,
      doc.folders,
    ),
  });
  await deps.store.createdDoc({
    docId,
    userId: connection.userId,
    googleUserId: connection.googleUserId,
    diaryDate: work.diaryDate,
  });
  return (await find())!;
}

/** Replaces the body of `docId` if it is still the revision this app wrote last. */
export async function writeInto(
  deps: Pick<CopyDeps, 'drive'>,
  token: string,
  current: { docId: string; revisionId: string },
  doc: DocBody,
): Promise<string> {
  const endpoints = deps.drive.client.endpoints;
  if ((await fileState(endpoints, token, current.docId)) !== 'present')
    throw new DocUnavailable('missing');
  const state = await docRevision(endpoints, token, current.docId);
  if (!state) throw new DocUnavailable('missing');
  if (current.revisionId && state.revisionId !== current.revisionId)
    throw new DocUnavailable('changed');
  try {
    return await replaceBody(endpoints, token, current.docId, state, doc);
  } catch (error) {
    // Google refuses a write whose required revision is no longer current: changed between
    // the check above and the write (D8).
    if (error instanceof GoogleError && error.status === 400) {
      const now = await docRevision(endpoints, token, current.docId);
      if (now?.revisionId !== state.revisionId) throw new DocUnavailable('changed');
    }
    throw error;
  }
}

/** Writes the day and returns where; a changed or missing Doc is set aside once first. */
async function writeDoc(
  deps: CopyDeps,
  connection: ConnectionRow,
  work: WorkRow,
  token: string,
  doc: DayDoc,
): Promise<{ docId: string; revisionId: string }> {
  for (let attempt = 0; ; attempt++) {
    const current = await currentOrNew(deps, connection, work, token, doc);
    try {
      return { docId: current.docId, revisionId: await writeInto(deps, token, current, doc) };
    } catch (error) {
      if (!(error instanceof DocUnavailable) || attempt > 0) throw error;
      await setAside(deps, token, current.docId, work.diaryDate, error.reason);
    }
  }
}

/**
 * A changed Doc keeps its content under the "changed in Google" name and stops being the
 * day's current one; a missing one is forgotten. Either is a problem on the backup page.
 */
export async function setAside(
  deps: Pick<CopyDeps, 'store' | 'drive'>,
  token: string,
  docId: string,
  diaryDate: string,
  reason: 'changed' | 'missing',
): Promise<void> {
  if (reason === 'changed') {
    await rename(deps.drive.client.endpoints, token, docId, replacedTitle(diaryDate));
    await deps.store.replaceDoc(docId);
  } else await deps.store.dropDoc(docId);
}

/** Handles one due day; false when none is due. */
export async function copyNext(deps: CopyDeps, now = new Date()): Promise<boolean> {
  const handled = await deps.store.withDueWork(
    now,
    keyIdOf(deps.drive.tokenKey),
    async (work, connection, outcome) => {
      const finish = (recheckAt: Date | null) =>
        recheckAt ? outcome.later(recheckAt, null) : outcome.done();
      try {
        const { written, recheckAt } = await deps.copy.content(
          work.userId,
          work.diaryDate,
          now,
          work.now,
        );
        if (!written) return finish(recheckAt);
        const current = await deps.store.currentDoc(
          work.userId,
          connection.googleUserId,
          work.diaryDate,
        );
        if (current?.revisionId && Buffer.from(current.contentSha256).equals(written.doc.sha256)) {
          await deps.store.recordCovers(current.docId, written.covers, written.coveredAt);
          return finish(recheckAt);
        }

        const refreshToken = openToken(deps.drive.tokenKey, {
          ciphertext: connection.refreshToken,
          nonce: connection.tokenNonce,
          keyId: connection.keyId,
        });
        if (!refreshToken) return deps.store.needsReconnect(work.userId);
        const token = await accessToken(deps.drive.client, refreshToken);
        const { docId, revisionId } = await writeDoc(deps, connection, work, token, written.doc);
        await deps.store.recordWrite(docId, {
          revisionId,
          contentSha256: written.doc.sha256,
          covers: written.covers,
          coveredAt: written.coveredAt,
        });
        return finish(recheckAt);
      } catch (error) {
        return failed(
          {
            reconnect: () => deps.store.needsReconnect(work.userId),
            storageFull: () => deps.store.storageFull(work.userId, work.diaryDate),
          },
          work,
          outcome,
          error,
          now,
          work.diaryDate,
        );
      }
    },
  );
  return handled !== null;
}

/** Google did not answer, answered with a server error, or asked to slow down. */
const unreachable = (error: unknown) =>
  error instanceof GoogleError
    ? error.status === 429 || error.status === 408 || error.status >= 500
    : error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');

/**
 * Every failure leaves a reason the pages show (D9): `unreachable` while Google cannot be
 * reached, `failed` for anything else, `storage_full`; a revoked grant asks to reconnect.
 * The detail goes to the log only, never a token or diary text.
 */
export async function failed(
  on: { reconnect(): Promise<void>; storageFull(): Promise<void> },
  work: Pick<WorkRow, 'attempts' | 'lastError'>,
  outcome: WorkOutcome,
  error: unknown,
  now: Date,
  /** A date or an item: never a title or any text of it. */
  label: string,
): Promise<void> {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const detail =
    error instanceof GoogleError ? `${error.status} ${error.code}` : (error as Error).message;
  console.error(`worker: backing up ${label} failed: ${detail}`);
  if (error instanceof GoogleError) {
    // The grant was revoked or expired (Testing mode: seven days), or lacks drive.file.
    if (
      error.code === 'invalid_grant' ||
      error.status === 401 ||
      error.code === 'insufficientPermissions'
    )
      return on.reconnect();
    if (error.code === 'storageQuotaExceeded') {
      if (work.lastError !== 'storage_full') await on.storageFull();
      return outcome.later(at(STORAGE_FULL_MS), 'storage_full');
    }
  }
  const wait =
    (error instanceof GoogleError ? error.retryAfterMs : null) ?? backoffMs(work.attempts);
  return outcome.later(
    at(Math.min(wait, RETRY_MAX_MS)),
    unreachable(error) ? 'unreachable' : 'failed',
  );
}
