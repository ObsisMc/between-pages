import * as Y from 'yjs';
import type { Change } from './intent.ts';

/** A pause this long ends a write session (kernel ADR D13, "暂停约 30 秒"). */
export const WRITE_SESSION_GAP_MS = 30_000;

type Session = { startedAt: Date; lastAt: number; resume: Y.RelativePosition };

/**
 * Assigns each operation its written time: the start of the write session it belongs to
 * (D13). A session continues only while the user keeps typing or deleting where the
 * previous operation left the caret, with no pause over the gap. A replace, an undo or
 * redo, and a change elsewhere start a new one, so new text never borrows an older time.
 * One instance per document: another diary or generation gets a new binding.
 */
export function createWriteSessions(text: Y.Text) {
  let session: Session | undefined;

  /** Call after the operation's transaction, with its changes and whether it was typed. */
  return function writtenAt(changes: readonly Change[], typed: boolean): Date {
    const now = new Date();
    const change = changes.length === 1 ? changes[0] : undefined;
    const startedAt =
      session && typed && change && continues(session, change, now) ? session.startedAt : now;
    // Assoc -1 ties the caret to the character before it, after which typing continues.
    const caret = change ? change.at + change.inserted.length : 0;
    const resume = Y.createRelativePositionFromTypeIndex(text, caret, -1);
    session = { startedAt, lastAt: now.getTime(), resume };
    return startedAt;
  };

  function continues(previous: Session, change: Change, now: Date): boolean {
    if (change.deleted && change.inserted) return false;
    if (now.getTime() - previous.lastAt > WRITE_SESSION_GAP_MS) return false;
    const resume = Y.createAbsolutePositionFromRelativePosition(previous.resume, text.doc!);
    // The caret before a change is where text goes in, or either edge of a deletion.
    return resume?.index === change.at || resume?.index === change.at + change.deleted.length;
  }
}
