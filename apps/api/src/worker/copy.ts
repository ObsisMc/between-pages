import type { DriveConfig } from '../backup/backup.ts';
import type { CopyService } from '../backup/copy.ts';
import type { DayDoc } from '../backup/render.ts';
import {
  DOC_TYPE,
  FOLDER_TYPE,
  createFile,
  docRevision,
  fileState,
  replaceBody,
} from '../google/docs.ts';
import { GoogleError, accessToken } from '../google/oauth.ts';
import { keyIdOf, openToken } from '../google/tokens.ts';
import type { ConnectionRow } from '../store/backup.ts';
import type { CopyStore, WorkRow } from '../store/copy.ts';

// Writing one day's Doc into one person's Drive (server-backup-and-google-docs D6–D8,
// technical design steps 3–4). The worker opens the refresh token only here, for one day,
// and keeps it and the access token in memory. A Doc is written only while it is still at
// the revision this app last wrote (invariant 8); anything else leaves it untouched.

const RETRY_MAX_MS = 60 * 60_000;
/** Storage full waits for the user; a daily look resumes once they made room (D9). */
const STORAGE_FULL_MS = 24 * 60 * 60_000;

const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, RETRY_MAX_MS);

/** The Doc changed in Google or disappeared; never overwritten. */
class DocUnavailable extends Error {}

export type CopyDeps = { copy: CopyService; store: CopyStore; drive: DriveConfig };

/** Creates the missing folders of `Between Pages / YYYY / MM` and returns the month's. */
async function monthFolder(
  deps: CopyDeps,
  connection: ConnectionRow,
  token: string,
  doc: DayDoc,
): Promise<string> {
  const known = await deps.store.folders(connection.userId, connection.googleUserId);
  let parentId: string | null = null;
  let path = '';
  for (const name of doc.folders) {
    path = path ? `${path}/${name}` : name;
    let folderId = known.get(path);
    if (!folderId) {
      folderId = await createFile(deps.drive.client.endpoints, token, {
        name,
        type: FOLDER_TYPE,
        parentId,
      });
      await deps.store.saveFolder(connection.userId, connection.googleUserId, path, folderId);
    }
    parentId = folderId;
  }
  return parentId!;
}

/** Writes the Doc and returns its new revision; creates it first when the day has none. */
async function writeDoc(
  deps: CopyDeps,
  connection: ConnectionRow,
  work: WorkRow,
  token: string,
  doc: DayDoc,
): Promise<{ docId: string; revisionId: string }> {
  const endpoints = deps.drive.client.endpoints;
  let current = await deps.store.currentDoc(
    connection.userId,
    connection.googleUserId,
    work.diaryDate,
  );
  if (!current) {
    const docId = await createFile(endpoints, token, {
      name: doc.title,
      type: DOC_TYPE,
      parentId: await monthFolder(deps, connection, token, doc),
    });
    await deps.store.createdDoc({
      docId,
      userId: connection.userId,
      googleUserId: connection.googleUserId,
      diaryDate: work.diaryDate,
    });
    current = (await deps.store.currentDoc(
      connection.userId,
      connection.googleUserId,
      work.diaryDate,
    ))!;
  }
  if ((await fileState(endpoints, token, current.docId)) !== 'present')
    throw new DocUnavailable('doc_missing');
  const state = await docRevision(endpoints, token, current.docId);
  if (!state) throw new DocUnavailable('doc_missing');
  if (current.revisionId && state.revisionId !== current.revisionId)
    throw new DocUnavailable('doc_changed');
  try {
    return {
      docId: current.docId,
      revisionId: await replaceBody(endpoints, token, current.docId, state, doc),
    };
  } catch (error) {
    // Google refuses a write whose required revision is no longer current (D8).
    if (error instanceof GoogleError && error.status === 400) {
      const now = await docRevision(endpoints, token, current.docId);
      if (now?.revisionId !== state.revisionId) throw new DocUnavailable('doc_changed');
    }
    throw error;
  }
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
        return failed(deps, work, outcome, error, now);
      }
    },
  );
  return handled !== null;
}

async function failed(
  deps: CopyDeps,
  work: WorkRow,
  outcome: { later(at: Date, failure: string | null): Promise<void> },
  error: unknown,
  now: Date,
): Promise<void> {
  const at = (ms: number) => new Date(now.getTime() + ms);
  if (error instanceof DocUnavailable)
    return outcome.later(at(backoffMs(work.attempts)), error.message);
  if (!(error instanceof GoogleError)) {
    console.error(`worker: copying a day failed: ${(error as Error).message}`);
    return outcome.later(at(backoffMs(work.attempts)), 'internal');
  }
  // The grant was revoked or expired (Testing mode: seven days), or lacks drive.file.
  if (
    error.code === 'invalid_grant' ||
    error.status === 401 ||
    error.code === 'insufficientPermissions'
  )
    return deps.store.needsReconnect(work.userId);
  if (error.code === 'storageQuotaExceeded') {
    if (work.lastError !== 'storage_full')
      await deps.store.storageFull(work.userId, work.diaryDate);
    return outcome.later(at(STORAGE_FULL_MS), 'storage_full');
  }
  const wait = error.retryAfterMs ?? backoffMs(work.attempts);
  return outcome.later(at(Math.min(wait, RETRY_MAX_MS)), error.code);
}
