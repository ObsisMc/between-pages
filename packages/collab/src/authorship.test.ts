import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { authorRuns, insertedRanges } from './authorship.ts';
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

/** One local transaction, captured the way an editor binding emits it. */
function edit(doc: Y.Doc, change: (text: Y.Text) => void): Uint8Array {
  let update: Uint8Array | undefined;
  const capture = (u: Uint8Array) => (update = u);
  doc.on('update', capture);
  change(doc.getText(BODY));
  doc.off('update', capture);
  if (!update) throw new Error('the change produced no update');
  return update;
}

describe('insertedRanges', () => {
  it('attributes each new character to the update that inserted it', () => {
    const server = writer(1, createDiaryDoc());
    server.getText(BODY).insert(0, 'kept');
    const before = Y.encodeStateVector(server);
    const tab = writer(2, server);
    const first = edit(tab, (t) => t.insert(4, ' 今天😀'));
    const second = edit(tab, (t) => t.insert(0, 'x'));
    const third = edit(tab, (t) => t.delete(0, 1));

    expect(insertedRanges(before, [first, second, third])).toEqual([
      [{ client: 2, clock: 0, length: 5 }],
      [{ client: 2, clock: 5, length: 1 }],
      [],
    ]);
  });

  it('yields nothing for items the document already has, as in a re-sent update', () => {
    const tab = writer(3, createDiaryDoc());
    const update = edit(tab, (t) => t.insert(0, 'once'));
    const server = createDiaryDoc();
    Y.applyUpdate(server, update);

    expect(insertedRanges(Y.encodeStateVector(server), [update])).toEqual([[]]);
    expect(insertedRanges(Y.encodeStateVector(createDiaryDoc()), [update, update])).toEqual([
      [{ client: 3, clock: 0, length: 4 }],
      [],
    ]);
  });
});
