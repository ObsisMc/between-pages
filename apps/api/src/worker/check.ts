import type { DriveConfig } from '../backup/backup.ts';
import { docRevision, listFiles } from '../google/docs.ts';
import { GoogleError, accessToken } from '../google/oauth.ts';
import { keyIdOf, openToken } from '../google/tokens.ts';
import type { ConnectionRow } from '../store/backup.ts';
import type { CopyStore } from '../store/copy.ts';
import type { TogetherStore } from '../store/together.ts';
import { setAside } from './copy.ts';
import { setAsideItem } from './together.ts';

// The daily check (server-backup-and-google-docs D8): each Drive's file list, metadata only,
// against the Docs the app keeps writing. A Doc no longer listed (deleted or in the bin) is
// queued to be made again; one changed since the app's last write keeps its content under
// the "changed in Google" name and its day is queued for a new Doc. So a diary nobody edits
// again does not stay without its Doc. The `Together` Docs are checked alike
// (google-copy-beyond-diaries 技术设计), except a page's Doc deleted in the app, which is no
// longer current and so is never made again. Nothing in Drive is deleted.

export type CheckDeps = { store: CopyStore; together: TogetherStore; drive: DriveConfig };

/** Checks one Drive; a revoked or unreadable grant asks the user to reconnect instead. */
export async function checkDrive(deps: CheckDeps, connection: ConnectionRow): Promise<void> {
  const endpoints = deps.drive.client.endpoints;
  const refreshToken = openToken(deps.drive.tokenKey, {
    ciphertext: connection.refreshToken,
    nonce: connection.tokenNonce,
    keyId: connection.keyId,
  });
  if (!refreshToken) return deps.store.needsReconnect(connection.userId);
  let token: string;
  try {
    token = await accessToken(deps.drive.client, refreshToken);
  } catch (error) {
    if (error instanceof GoogleError && error.code === 'invalid_grant')
      return deps.store.needsReconnect(connection.userId);
    throw error;
  }
  const files = await listFiles(endpoints, token);
  /** Why a Doc can no longer be written, or null while it is as the app left it. */
  const problem = async (doc: { docId: string; writtenAt: Date; revisionId: string }) => {
    const modified = files.get(doc.docId);
    if (!modified) return 'missing' as const;
    if (modified <= doc.writtenAt) return null;
    // Drive's time only says something may have changed; the revision decides.
    const state = await docRevision(endpoints, token, doc.docId);
    if (!state) return 'missing' as const;
    return state.revisionId !== doc.revisionId ? ('changed' as const) : null;
  };
  for (const doc of await deps.store.currentDocs(connection.userId, connection.googleUserId)) {
    const reason = await problem(doc);
    if (!reason) continue;
    await setAside(deps, token, doc.docId, doc.diaryDate, reason);
    await deps.store.queueDay(connection.userId, doc.diaryDate);
  }
  for (const doc of await deps.together.currentDocs(connection.userId, connection.googleUserId)) {
    // A rename left unrecorded is settled by the next write, not taken for an edit here.
    const reason = doc.renameIntent && files.has(doc.docId) ? null : await problem(doc);
    if (reason) await setAsideItem({ ...deps, store: deps.together }, token, doc, reason);
    if (reason || doc.renameIntent) await deps.together.queueItem(connection.userId, doc.item);
  }
}

/**
 * Checks every working Drive this key opens; one failing Drive does not stop the others and
 * leaves an entry on its owner's backup page.
 */
export async function checkDrives(deps: CheckDeps): Promise<void> {
  for (const connection of await deps.store.activeConnections(keyIdOf(deps.drive.tokenKey))) {
    try {
      await checkDrive(deps, connection);
    } catch (error) {
      const reason = error instanceof GoogleError ? error.code : (error as Error).message;
      console.error(`worker: checking a Drive failed: ${reason}`);
      await deps.store.checkFailed(connection.userId);
    }
  }
}
