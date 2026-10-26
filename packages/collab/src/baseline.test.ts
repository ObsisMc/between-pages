import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildBaseline, verifyBaseline } from './baseline.ts';
import { BODY, createDiaryDoc } from './doc.ts';

const SECRET = 'private-and-deleted';

/** Committed state whose deleted text is still held, as under normal `gc: false` running. */
function committedWithDeletion(): Uint8Array {
  const doc = createDiaryDoc();
  const text = doc.getText(BODY);
  text.insert(0, `kept ${SECRET} kept 😀`);
  text.delete(5, SECRET.length + 1);
  return Y.encodeStateAsUpdate(doc);
}

const contains = (bytes: Uint8Array, needle: string) =>
  Buffer.from(bytes).includes(Buffer.from(needle));

describe('buildBaseline', () => {
  it('[adr:diary-collaboration-kernel#18] drops deleted text and keeps the visible text', () => {
    const committed = committedWithDeletion();
    expect(contains(committed, SECRET)).toBe(true);

    const result = buildBaseline(committed);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(contains(result.baseline, SECRET)).toBe(false);
    const loaded = createDiaryDoc();
    Y.applyUpdate(loaded, result.baseline);
    expect(loaded.getText(BODY).toString()).toBe('kept kept 😀');
  });

  it('builds a baseline for an empty diary', () => {
    const result = buildBaseline(Y.encodeStateAsUpdate(createDiaryDoc()));

    expect(result.ok).toBe(true);
  });
});

describe('verifyBaseline', () => {
  it('[adr:diary-collaboration-kernel#18] finds deleted items that still carry text', () => {
    const uncleaned = committedWithDeletion();

    expect(verifyBaseline(uncleaned, uncleaned)).toBe('DELETED_CONTENT_RETAINED');
  });

  it('[adr:diary-collaboration-kernel#18] finds a baseline whose visible text differs from its source', () => {
    const source = committedWithDeletion();
    const other = createDiaryDoc();
    other.getText(BODY).insert(0, 'something else');

    expect(verifyBaseline(source, Y.encodeStateAsUpdate(other))).toBe('TEXT_CHANGED');
  });
});
