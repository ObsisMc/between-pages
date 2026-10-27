import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { authorRuns } from './authorship.ts';
import { BODY, createDiaryDoc } from './doc.ts';

function writer(clientID: number, from: Y.Doc): Y.Doc {
  const doc = createDiaryDoc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  doc.clientID = clientID;
  return doc;
}

describe('authorRuns', () => {
  it('[adr:diary-collaboration-kernel#2] derives authors of interleaved visible text from clientID bindings', () => {
    const a = writer(1, createDiaryDoc());
    a.getText(BODY).insert(0, '今天晴，去了公园');
    const b = writer(2, a);
    b.getText(BODY).insert(3, '（我也去了）');
    b.getText(BODY).delete(4, 1);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    const runs = authorRuns(
      a,
      new Map([
        [1, 'user-a'],
        [2, 'user-b'],
      ]),
    );

    expect(runs).toEqual([
      { author: 'user-a', client: 1, clock: 0, text: '今天晴' },
      { author: 'user-b', client: 2, clock: 0, text: '（' },
      { author: 'user-b', client: 2, clock: 2, text: '也去了）' },
      { author: 'user-a', client: 1, clock: 3, text: '，去了公园' },
    ]);
    expect(runs.map((run) => run.text).join('')).toBe(a.getText(BODY).toString());
  });

  it('throws when visible text has no bound author', () => {
    const doc = writer(7, createDiaryDoc());
    doc.getText(BODY).insert(0, 'orphan');

    expect(() => authorRuns(doc, new Map())).toThrow('clientID 7 has no bound author');
  });
});
