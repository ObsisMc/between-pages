import * as Y from 'yjs';

/** The only shared type in a diary document (ADR-0006 §11). */
export const BODY = 'body';

/** Server-side record of which user each Yjs clientID belongs to, per diary (kernel ADR D3). */
export type ClientBindings = ReadonlyMap<number, string>;

/**
 * A document for normal running. Garbage collection stays off so deleted items keep
 * their content for undo, unread anchors and the owner's archive (kernel ADR D12);
 * only an isolated baseline copy collects garbage.
 */
export function createDiaryDoc(): Y.Doc {
  return new Y.Doc({ gc: false });
}
