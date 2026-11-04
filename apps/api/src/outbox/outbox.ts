import type { LiveEpoch } from '../store/boundaries.ts';
import type { LockedDocument } from '../store/store.ts';

/**
 * Registers the backup tasks one commit needs, inside the commit's transaction, so a
 * task exists exactly when its version does (ADR-0003, kernel D16, invariant 6). Every
 * commit of a diary gets its owner's personal target; a commit inside a live epoch also
 * gets the space target bound to that epoch, so a backup never outputs a version the
 * epoch did not authorize. Registering is not backing up: the worker records that.
 */
export async function registerBackups(
  locked: LockedDocument,
  version: number,
  live: LiveEpoch | null,
): Promise<void> {
  await locked.insertBackupTasks(version, live && { spaceId: live.spaceId, epochId: live.id });
}
