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

/** Characters one operation inserted: `length` consecutive clocks of one clientID. */
export type CharacterRange = { client: number; clock: number; length: number };

/**
 * The characters each update newly inserts, per update in batch order, for the written
 * time records of `diary_character_ranges` (kernel ADR D15). `stateVector` is the
 * document's `Y.encodeStateVector` before the batch; the updates must be ones
 * `acceptBatch` accepted from that state, so their clocks continue it without gaps.
 * Items the document already had, as in a re-sent update, are not new and yield nothing;
 * deletion placeholders carry no character.
 */
export function insertedRanges(
  stateVector: Uint8Array,
  updates: readonly Uint8Array[],
): CharacterRange[][] {
  const known = Y.decodeStateVector(stateVector);
  return updates.map((update) => {
    const ranges: CharacterRange[] = [];
    for (const struct of Y.decodeUpdate(update).structs) {
      const { client, clock } = struct.id;
      const end = clock + struct.length;
      const start = Math.max(clock, known.get(client) ?? 0);
      if (start >= end) continue;
      known.set(client, end);
      if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentString)) continue;
      const last = ranges.at(-1);
      if (last?.client === client && last.clock + last.length === start) last.length += end - start;
      else ranges.push({ client, clock: start, length: end - start });
    }
    return ranges;
  });
}
