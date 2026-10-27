import * as Y from 'yjs';
import { BODY, type ClientBindings } from './doc.ts';

/** Visible text written under one clientID with consecutive clocks, in document order. */
export type AuthorRun = { author: string; client: number; clock: number; text: string };

/**
 * Derives the author of every visible character from its item ID and the server's
 * clientID bindings (invariant 2); nothing in the document itself names an author.
 * Throws when a visible character's clientID is unbound: validation binds every
 * clientID before its text is accepted, so this is corrupt state, not user input.
 */
export function authorRuns(doc: Y.Doc, bindings: ClientBindings): AuthorRun[] {
  const runs: AuthorRun[] = [];
  for (let item = doc.getText(BODY)._start; item; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
    const { client, clock } = item.id;
    const text = item.content.str;
    const last = runs.at(-1);
    if (last?.client === client && last.clock + last.text.length === clock) {
      last.text += text;
      continue;
    }
    const author = bindings.get(client);
    if (author === undefined) throw new Error(`clientID ${client} has no bound author`);
    runs.push({ author, client, clock, text });
  }
  return runs;
}
