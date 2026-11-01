import { authorRuns, createDiaryDoc } from '@between-pages/collab';
import type { ClientBinding } from '@between-pages/contracts';
import * as Y from 'yjs';

/** One author's consecutive characters, with the text index of its first one. */
export type TextRun = {
  author: string;
  client: number;
  clock: number;
  text: string;
  index: number;
};

/**
 * The text of a diary state as the server sent it (`DiaryState` or `SharedDiaryState`),
 * as author runs in text order. Authors come from the server's bindings only (kernel D3);
 * text whose clientID has none throws, as `authorRuns` does.
 */
export function decodeText({
  state,
  bindings,
}: {
  state: string;
  bindings: readonly ClientBinding[];
}): TextRun[] {
  const doc = createDiaryDoc();
  try {
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(state), (c) => c.charCodeAt(0)),
    );
    let index = 0;
    return authorRuns(doc, new Map(bindings.map((b) => [b.clientId, b.userId]))).map((run) => {
      const indexed = { ...run, index };
      index += run.text.length;
      return indexed;
    });
  } finally {
    doc.destroy();
  }
}
