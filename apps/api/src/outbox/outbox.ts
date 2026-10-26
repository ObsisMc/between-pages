import type { LockedDiary } from '../store/store.ts';

/**
 * Registers the backup tasks one commit needs, inside the commit's transaction, so a
 * task exists exactly when its version does (ADR-0003, kernel D16, invariant 6). Every
 * commit of a diary gets its owner's personal target; phase 4 adds the space target for
 * commits inside a live epoch. Registering is not backing up: the worker records that.
 */
export async function registerBackups(locked: LockedDiary, version: number): Promise<void> {
  await locked.insertBackupTasks(version, ['personal']);
}
