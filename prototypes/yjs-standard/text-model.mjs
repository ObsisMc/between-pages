import * as Y from 'yjs';
import { Authority } from './authority.mjs';

// Plain-text variant: the whole diary is one Y.Text, newlines are ordinary characters.
// A small custom ProseMirror binding would translate editor steps into these calls.
export function textClient(userId, authority) {
  const doc = new Y.Doc({ gc: false });
  authority.register(userId, doc.clientID);
  const text = doc.getText('body');
  const outbox = [];
  doc.on('update', (u, origin) => { if (origin !== 'remote') outbox.push(u); });
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([userId]), captureTimeout: 0 });
  return {
    doc, text, undo,
    insert: (i, s) => doc.transact(() => text.insert(i, s), userId),
    remove: (i, n) => doc.transact(() => text.delete(i, n), userId),
    flush() { const r = []; for (const u of outbox.splice(0)) { try { authority.accept(userId, u); } catch (e) { r.push(e.code); } } return r; },
    pull() { Y.applyUpdate(doc, Y.encodeStateAsUpdate(authority.doc, Y.encodeStateVector(doc)), 'remote'); },
  };
}
export function textRuns(doc, owner) {
  const out = [];
  for (let n = doc.getText('body')._start; n; n = n.right) {
    if (n.deleted || !n.content.str) continue;
    const u = owner.get(n.id.client), last = out.at(-1);
    if (last && last[0] === u) last[1] += n.content.str; else out.push([u, n.content.str]);
  }
  return out;
}
