import { BODY, createDiaryDoc } from '@between-pages/collab';
import * as Y from 'yjs';

/** Text written in turns by bound clientIDs: `[clientId, userId, text]`, each appended. */
export type Turn = [number, string, string];

/** The `state` and `bindings` of a diary as the server sends them, for the given turns. */
export function stateOf(turns: readonly Turn[]) {
  const doc = createDiaryDoc();
  for (const [client, , text] of turns) {
    doc.clientID = client;
    const body = doc.getText(BODY);
    body.insert(body.length, text);
  }
  const update = Y.encodeStateAsUpdate(doc);
  const bindings = [...new Map(turns.map(([clientId, userId]) => [clientId, userId]))].map(
    ([clientId, userId]) => ({ clientId, userId }),
  );
  return { state: btoa(String.fromCharCode(...update)), bindings };
}
