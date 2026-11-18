import { createHash } from 'node:crypto';
import type { DriveConfig } from '../backup/backup.ts';
import { ensureFolders } from '../backup/folders.ts';
import { deletedName, replacedName, type TogetherDoc } from '../backup/render-together.ts';
import type { TogetherCopy } from '../backup/together.ts';
import { DOC_TYPE, createFile, docRevision, docText, rename } from '../google/docs.ts';
import { accessToken } from '../google/oauth.ts';
import { keyIdOf, openToken } from '../google/tokens.ts';
import type { ConnectionRow } from '../store/backup.ts';
import type { CopyStore } from '../store/copy.ts';
import type { ItemDocRow, ItemWorkRow, TogetherStore } from '../store/together.ts';
import { DocUnavailable, failed, writeInto } from './copy.ts';

// Writing one `Together` Doc into one person's Drive (google-copy-beyond-diaries D4–D7), on
// the day Docs' write path: the folder by its recorded ID, the Doc recorded before its first
// write, the whole body replaced only at the revision the app last wrote, a Doc changed in
// Google set aside under a new name and one deleted made again. A page title change is a
// Drive rename, recorded as an intent first: should the worker stop between the rename and
// recording the revision it produced, the next run accepts that revision only while the Doc
// still has the intended name and the text the app wrote. A page deleted in the app gets
// its last content, then its "已在应用中删除" name, and is never written again.

export type TogetherDeps = {
  copy: TogetherCopy;
  store: TogetherStore;
  copyStore: CopyStore;
  drive: DriveConfig;
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The Drive name a Doc row stands for; a rename under way already wrote its title in. */
const driveName = (doc: ItemDocRow) =>
  doc.renameIntent?.name ?? (doc.state === 'deleted' ? deletedName(doc.title!) : doc.title!);

/**
 * A rename the worker may have made but not recorded: Google's newer revision is the app's
 * own when the Doc still has the intended name and the text written before it. Returns the
 * row to write on, or why it cannot be.
 */
async function settleRename(
  deps: TogetherDeps,
  token: string,
  doc: ItemDocRow,
): Promise<ItemDocRow | 'changed' | 'missing'> {
  const intent = doc.renameIntent;
  if (!intent) return doc;
  const now = await docText(deps.drive.client.endpoints, token, doc.docId);
  if (!now) return 'missing';
  if (now.revisionId === doc.revisionId) return doc;
  if (now.title !== intent.name || sha256(now.text) !== intent.textSha256) return 'changed';
  const title = doc.state === 'deleted' ? doc.title! : intent.name;
  await deps.store.renamed(doc.docId, title, now.revisionId);
  return { ...doc, title, revisionId: now.revisionId, renameIntent: null };
}

/** Renames the Doc in Drive, the intent recorded before and cleared after (技术设计). */
async function renameDoc(
  deps: TogetherDeps,
  token: string,
  doc: { docId: string; revisionId: string },
  title: string,
  name: string,
  text: string,
  record: (intent: NonNullable<ItemDocRow['renameIntent']>) => Promise<void>,
): Promise<void> {
  const endpoints = deps.drive.client.endpoints;
  await record({ name, revisionId: doc.revisionId, textSha256: sha256(text) });
  await rename(endpoints, token, doc.docId, name);
  const after = await docRevision(endpoints, token, doc.docId);
  if (!after) throw new DocUnavailable('missing');
  await deps.store.renamed(doc.docId, title, after.revisionId);
}

/** A changed Doc keeps its content under a "changed in Google" name; a missing one is forgotten. */
export async function setAsideItem(
  deps: Pick<TogetherDeps, 'store' | 'drive'>,
  token: string,
  doc: ItemDocRow,
  reason: 'changed' | 'missing',
): Promise<void> {
  if (reason === 'changed') {
    await rename(deps.drive.client.endpoints, token, doc.docId, replacedName(driveName(doc)));
    await deps.store.replaceDoc(doc.docId);
  } else await deps.store.dropDoc(doc.docId);
}

/** The item's current Doc, made in its folder (and recorded before any write) when missing. */
async function currentOrNew(
  deps: TogetherDeps,
  connection: ConnectionRow,
  work: ItemWorkRow,
  token: string,
  doc: TogetherDoc,
): Promise<ItemDocRow> {
  const find = () => deps.store.currentDoc(connection.userId, connection.googleUserId, work.item);
  const found = await find();
  if (found) return found;
  const endpoints = deps.drive.client.endpoints;
  const docId = await createFile(endpoints, token, {
    name: doc.title,
    type: DOC_TYPE,
    parentId: await ensureFolders(endpoints, deps.copyStore, connection, token, doc.folders),
  });
  await deps.store.createdDoc({
    docId,
    userId: connection.userId,
    googleUserId: connection.googleUserId,
    item: work.item,
    title: doc.title,
  });
  return (await find())!;
}

/** Writes the item and returns the row written; a changed or missing Doc is set aside once. */
async function writeItem(
  deps: TogetherDeps,
  connection: ConnectionRow,
  work: ItemWorkRow,
  token: string,
  doc: TogetherDoc,
): Promise<ItemDocRow> {
  for (let attempt = 0; ; attempt++) {
    const found = await currentOrNew(deps, connection, work, token, doc);
    try {
      const current = await settleRename(deps, token, found);
      if (typeof current === 'string') throw new DocUnavailable(current);
      const revisionId = await writeInto(deps, token, current, doc);
      return { ...current, revisionId };
    } catch (error) {
      if (!(error instanceof DocUnavailable) || attempt > 0) throw error;
      await setAsideItem(deps, token, found, error.reason);
    }
  }
}

/** Handles one due page or summary; false when none is due. */
export async function togetherNext(deps: TogetherDeps, now = new Date()): Promise<boolean> {
  const handled = await deps.store.withDueItem(
    now,
    keyIdOf(deps.drive.tokenKey),
    async (work, connection, outcome) => {
      const finish = (recheckAt: Date | null) =>
        recheckAt ? outcome.later(recheckAt, null) : outcome.done();
      const tokenFor = async () => {
        const refreshToken = openToken(deps.drive.tokenKey, {
          ciphertext: connection.refreshToken,
          nonce: connection.tokenNonce,
          keyId: connection.keyId,
        });
        return refreshToken && accessToken(deps.drive.client, refreshToken);
      };
      try {
        // A page deleted in the app was written for the last time; only its rename can
        // still be owed (D7), and it is never made again.
        const final = await deps.store.deletedDoc(work.userId, connection.googleUserId, work.item);
        if (final) {
          if (final.renameIntent) {
            const token = await tokenFor();
            if (!token) return deps.copyStore.needsReconnect(work.userId);
            const endpoints = deps.drive.client.endpoints;
            await rename(endpoints, token, final.docId, final.renameIntent.name);
            const after = await docRevision(endpoints, token, final.docId);
            await deps.store.renamed(
              final.docId,
              final.title!,
              after?.revisionId ?? final.revisionId,
            );
          }
          return outcome.done();
        }

        const { written, recheckAt, deleted } = await deps.copy.content(
          work.userId,
          work.item,
          now,
          work.now,
        );
        if (!written) return finish(recheckAt);
        const current = await deps.store.currentDoc(
          work.userId,
          connection.googleUserId,
          work.item,
        );
        if (
          !deleted &&
          current?.revisionId &&
          !current.renameIntent &&
          Buffer.from(current.contentSha256).equals(written.doc.sha256)
        ) {
          await deps.store.recordCovers(current.docId, written.coveredAt);
          return finish(recheckAt);
        }

        const token = await tokenFor();
        if (!token) return deps.copyStore.needsReconnect(work.userId);
        const doc = await writeItem(deps, connection, work, token, written.doc);
        await deps.store.recordWrite(doc.docId, {
          revisionId: doc.revisionId,
          contentSha256: written.doc.sha256,
          coveredAt: written.coveredAt,
        });
        const title = written.doc.title;
        if (deleted)
          // Recorded together with its rename intent, so a retry only renames (D7).
          await renameDoc(deps, token, doc, title, deletedName(title), written.doc.text, (intent) =>
            deps.store.markDeleted(doc.docId, title, intent),
          );
        else if (doc.title !== title)
          await renameDoc(deps, token, doc, title, title, written.doc.text, (intent) =>
            deps.store.intendRename(doc.docId, intent),
          );
        return finish(deleted ? null : recheckAt);
      } catch (error) {
        return failed(
          {
            reconnect: () => deps.copyStore.needsReconnect(work.userId),
            storageFull: () => deps.store.storageFull(work.userId, work.item),
          },
          work,
          outcome,
          error,
          now,
          work.item,
        );
      }
    },
  );
  return handled !== null;
}
