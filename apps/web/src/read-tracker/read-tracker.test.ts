import { BODY, authorRuns, buildBaseline, createDiaryDoc } from '@between-pages/collab';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { stubApi } from '../../test/render.tsx';
import { DWELL_MS, createReadTracker, unread, type VisibleRun } from './index.ts';

const DIARY = '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
const READ = `/api/diaries/${DIARY}/read`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reportsTo(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)).ranges);
}

describe('createReadTracker', () => {
  it('[adr:diary-collaboration-kernel#26] reports text after it stayed on screen for a second, once', async () => {
    const fetchMock = stubApi({
      [`GET ${READ}`]: () => Response.json({ ranges: [] }),
      [`POST ${READ}`]: (init) => Response.json(JSON.parse(String(init!.body))),
    });
    let onScreen: VisibleRun[] = [{ client: 7, clock: 0, length: 4 }];
    const tracker = createReadTracker({ diaryId: DIARY, visible: () => onScreen });

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    expect(reportsTo(fetchMock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    expect(reportsTo(fetchMock)).toEqual([[{ clientId: 7, from: 0, to: 4 }]]);

    // Scrolled on: only the newly shown characters, after their own second.
    onScreen = [{ client: 7, clock: 2, length: 6 }];
    await vi.advanceTimersByTimeAsync(3 * DWELL_MS);
    expect(reportsTo(fetchMock)).toEqual([
      [{ clientId: 7, from: 0, to: 4 }],
      [{ clientId: 7, from: 4, to: 8 }],
    ]);
    tracker.stop();
  });

  it('reports nothing while the page is hidden, nor what was read on another device', async () => {
    const fetchMock = stubApi({
      [`GET ${READ}`]: () => Response.json({ ranges: [{ clientId: 7, from: 0, to: 4 }] }),
      [`POST ${READ}`]: (init) => Response.json(JSON.parse(String(init!.body))),
    });
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const tracker = createReadTracker({
      diaryId: DIARY,
      visible: () => [{ client: 7, clock: 0, length: 6 }],
    });

    await vi.advanceTimersByTimeAsync(5 * DWELL_MS);
    expect(reportsTo(fetchMock)).toEqual([]);
    hidden.mockReturnValue('visible');
    await vi.advanceTimersByTimeAsync(2 * DWELL_MS);
    expect(reportsTo(fetchMock)).toEqual([[{ clientId: 7, from: 4, to: 6 }]]);
    tracker.stop();
  });
});

describe('unread', () => {
  /** The other person's visible characters as the editor binding names them. */
  const othersIn = (doc: Y.Doc, bindings: Map<number, string>, reader: string): VisibleRun[] =>
    authorRuns(doc, bindings)
      .filter((run) => run.author !== reader)
      .map((run) => ({ client: run.client, clock: run.clock, length: run.text.length }));

  function write(doc: Y.Doc, change: (text: Y.Text) => void) {
    change(doc.getText(BODY));
  }

  it('[adr:diary-collaboration-kernel#26] across a reopen: read stays read, private additions and retyped text are unread, deleted text is gone', () => {
    const a = createDiaryDoc();
    a.clientID = 1;
    const bindings = new Map([[1, 'A']]);
    write(a, (t) => t.insert(0, '旧的字句'));
    const b = createDiaryDoc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.clientID = 2;
    bindings.set(2, 'B');
    write(b, (t) => t.insert(4, '乙'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    // B read A's four characters before sharing stopped.
    const read = [{ clientId: 1, from: 0, to: 4 }];

    // Privately, A adds text, deletes "字" and types it again (a new character).
    write(a, (t) => t.insert(5, '新'));
    write(a, (t) => t.delete(2, 1));
    write(a, (t) => t.insert(2, '字'));
    const reopened = buildBaseline(Y.encodeStateAsUpdate(a));
    if (!reopened.ok) throw new Error(reopened.problem);
    const view = createDiaryDoc();
    Y.applyUpdate(view, reopened.baseline);

    expect(view.getText(BODY).toString()).toBe('旧的字句乙新');
    expect(unread(othersIn(view, bindings, 'B'), read)).toEqual([
      { clientId: 1, from: 4, to: 6 }, // "新", then the retyped "字"
    ]);
    // B's own text never counts, and the deleted "字" (clock 2) is nowhere.
    expect(unread(othersIn(view, bindings, 'B'), [])).not.toContainEqual(
      expect.objectContaining({ from: 2, to: 3 }),
    );
  });
});
