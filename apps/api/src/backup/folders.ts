import { FOLDER_TYPE, createFile, fileState } from '../google/docs.ts';
import type { GoogleEndpoints } from '../google/oauth.ts';
import type { CopyStore } from '../store/copy.ts';

// The app's folders in one person's Drive (server-backup-and-google-docs D6, D8): the API
// makes the root when a connection is made, the worker the year and month before a Doc.
// A folder is known by the Drive file ID recorded for it, never looked up by name, so one
// the user renamed or moved in Drive keeps being used; only one deleted or in the bin is
// made again, at its parent, with every level below it.

/**
 * The folder at the end of `path` (`Between Pages`, then `YYYY`, then `MM`) in this
 * account's Drive, making the levels that are missing. Returns its Drive file ID.
 */
export async function ensureFolders(
  endpoints: GoogleEndpoints,
  store: Pick<CopyStore, 'folders' | 'saveFolder'>,
  account: { userId: string; googleUserId: string },
  token: string,
  path: readonly string[],
): Promise<string> {
  const known = await store.folders(account.userId, account.googleUserId);
  let parentId: string | null = null;
  let key = '';
  let rebuilt = false;
  for (const name of path) {
    key = key ? `${key}/${name}` : name;
    let folderId = rebuilt ? undefined : known.get(key);
    if (folderId && (await fileState(endpoints, token, folderId)) !== 'present')
      folderId = undefined;
    if (!folderId) {
      folderId = await createFile(endpoints, token, { name, type: FOLDER_TYPE, parentId });
      await store.saveFolder(account.userId, account.googleUserId, key, folderId);
      rebuilt = true;
    }
    parentId = folderId;
  }
  return parentId!;
}
