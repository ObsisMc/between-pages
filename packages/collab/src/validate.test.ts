import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BODY, createDiaryDoc } from './doc.ts';
import { acceptBatch, type RejectReason } from './validate.ts';

const A = 'user-a';
const B = 'user-b';

function client(clientID: number, from?: Y.Doc): Y.Doc {
  const doc = createDiaryDoc();
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  // Set after loading: Yjs renews a clientID it finds in a loaded update.
  doc.clientID = clientID;
  return doc;
}

/** One local transaction, captured the way an editor binding emits it. */
function edit(doc: Y.Doc, change: (text: Y.Text, doc: Y.Doc) => void): Uint8Array {
  let update: Uint8Array | undefined;
  const capture = (u: Uint8Array) => (update = u);
  doc.on('update', capture);
  change(doc.getText(BODY), doc);
  doc.off('update', capture);
  if (!update) throw new Error('the change produced no update');
  return update;
}

/** A server holding "A writes. B replies." with clientID 1 bound to A and 2 to B. */
function sharedDiary() {
  const server = createDiaryDoc();
  const bindings = new Map([
    [1, A],
    [2, B],
  ]);
  const a = client(1);
  const b = client(2);
  const fromA = edit(a, (text) => text.insert(0, 'A writes. '));
  expect(acceptBatch(server, [fromA], A, bindings).ok).toBe(true);
  Y.applyUpdate(b, fromA);
  const fromB = edit(b, (text) => text.insert(text.length, 'B replies.'));
  expect(acceptBatch(server, [fromB], B, bindings).ok).toBe(true);
  Y.applyUpdate(a, fromB);
  return { server, bindings, a, b };
}

const bodyOf = (doc: Y.Doc) => doc.getText(BODY).toString();

describe('acceptBatch', () => {
  it('[adr:diary-collaboration-kernel#2] binds an unbound clientID to the session user', () => {
    const { server, bindings } = sharedDiary();
    const tab = client(3, server);
    const update = edit(tab, (text) => text.insert(0, '新的一天 😀\n\t'));

    const result = acceptBatch(server, [update], A, bindings);

    expect(result).toMatchObject({ ok: true, claimedClientIds: [3] });
    expect(bodyOf(server)).toBe('新的一天 😀\n\tA writes. B replies.');
  });

  it('[adr:diary-collaboration-kernel#2] rejects new text under a clientID bound to the other author', () => {
    const { server, bindings } = sharedDiary();
    // A forged or colliding clientID: A's session sends items carrying B's clientID.
    const forged = client(2, server);
    const update = edit(forged, (text) => text.insert(0, 'not B'));

    expect(acceptBatch(server, [update], A, bindings)).toEqual({
      ok: false,
      index: 0,
      reason: 'FOREIGN_CLIENT_ID',
    });
  });

  it('[adr:diary-collaboration-kernel#3] rejects deleting the other author’s text, even inside an own deletion', () => {
    const { server, bindings, a } = sharedDiary();
    const spanning = edit(a, (text) => text.delete(2, text.length - 2));

    expect(acceptBatch(server, [spanning], A, bindings)).toMatchObject({
      ok: false,
      reason: 'FOREIGN_DELETE',
    });
  });

  it('[adr:diary-collaboration-kernel#3] lets each author delete only their own text', () => {
    const { server, bindings, a, b } = sharedDiary();
    const own = edit(a, (text) => text.delete(0, 'A writes. '.length));
    const ownB = edit(b, (text) => text.delete(text.length - 1, 1));

    expect(acceptBatch(server, [own], A, bindings).ok).toBe(true);
    expect(acceptBatch(server, [ownB], B, bindings).ok).toBe(true);
    expect(bodyOf(server)).toBe('B replies');
  });

  it.each<[string, (text: Y.Text, doc: Y.Doc) => void, RejectReason]>([
    ['formatting', (t: Y.Text) => t.insert(0, 'x', { bold: true }), 'CONTENT_NOT_ALLOWED'],
    ['an embed', (t: Y.Text) => t.insertEmbed(0, { image: 'x' }), 'CONTENT_NOT_ALLOWED'],
    ['a nested type', (t: Y.Text) => t.insertEmbed(0, new Y.Map()), 'CONTENT_NOT_ALLOWED'],
    ['a text attribute', (t: Y.Text) => t.setAttribute('lang', 'en'), 'CONTENT_NOT_ALLOWED'],
    ['a carriage return', (t: Y.Text) => t.insert(0, 'a\r\nb'), 'CONTROL_CHARACTER'],
    ['a NUL character', (t: Y.Text) => t.insert(0, 'a\u0000'), 'CONTROL_CHARACTER'],
    [
      'another root type',
      (_: Y.Text, doc: Y.Doc) => doc.getText('other').insert(0, 'x'),
      'FOREIGN_TYPE',
    ],
    [
      'a map entry',
      (_: Y.Text, doc: Y.Doc) => doc.getMap('meta').set('author', B),
      'CONTENT_NOT_ALLOWED',
    ],
  ])('[adr:diary-collaboration-kernel#2] rejects %s', (_, change, reason) => {
    const { server, bindings, a } = sharedDiary();
    const update = edit(a, change);

    expect(acceptBatch(server, [update], A, bindings)).toMatchObject({ ok: false, reason });
  });

  it('rejects bytes that are not a Yjs update', () => {
    const { server, bindings } = sharedDiary();

    expect(acceptBatch(server, [Uint8Array.of(9, 9, 9, 255)], A, bindings)).toMatchObject({
      ok: false,
      reason: 'MALFORMED_UPDATE',
    });
  });

  it('rejects an update whose earlier clocks the server does not have', () => {
    const { server, bindings, a } = sharedDiary();
    edit(a, (text) => text.insert(0, 'unsent '));
    const later = edit(a, (text) => text.insert(0, 'then this '));

    expect(acceptBatch(server, [later], A, bindings)).toMatchObject({
      ok: false,
      reason: 'MISSING_DEPENDENCY',
    });
  });

  it('rejects an insert next to text the server has never seen', () => {
    const { server, bindings, a } = sharedDiary();
    const elsewhere = client(5, a);
    Y.applyUpdate(
      a,
      edit(elsewhere, (text) => text.insert(0, 'unsent ')),
    );
    const next = edit(a, (text) => text.insert(3, 'x'));

    expect(acceptBatch(server, [next], A, bindings)).toMatchObject({
      ok: false,
      reason: 'MISSING_DEPENDENCY',
    });
  });

  it('rejects deleting text the server has never seen', () => {
    const { server, bindings, a } = sharedDiary();
    edit(a, (text) => text.insert(0, 'unsent '));
    const deletion = edit(a, (text) => text.delete(0, 3));

    expect(acceptBatch(server, [deletion], A, bindings)).toMatchObject({
      ok: false,
      reason: 'MISSING_DEPENDENCY',
    });
  });

  it('lets a later update in the batch depend on an earlier one', () => {
    const { server, bindings, a, b } = sharedDiary();
    const insert = edit(a, (text) => text.insert(0, 'abc '));
    const remove = edit(a, (text) => text.delete(1, 1));

    const result = acceptBatch(server, [insert, remove], A, bindings);

    expect(result.ok).toBe(true);
    if (result.ok) Y.applyUpdate(b, result.delta);
    expect(bodyOf(b)).toBe('ac A writes. B replies.');
    expect(bodyOf(server)).toBe(bodyOf(b));
  });

  it('names the first failing update and returns no delta for the batch', () => {
    const { server, bindings, a } = sharedDiary();
    const valid = edit(a, (text) => text.insert(0, 'ok '));
    const foreign = edit(a, (text) => text.delete(text.length - 3, 3));

    expect(acceptBatch(server, [valid, foreign], A, bindings)).toEqual({
      ok: false,
      index: 1,
      reason: 'FOREIGN_DELETE',
    });
  });

  it('accepts a replay of known items and re-encodes nothing for it', () => {
    const { server, bindings } = sharedDiary();
    const replay = Y.encodeStateAsUpdate(server);
    const before = Y.encodeStateAsUpdate(server);

    const result = acceptBatch(server, [replay], A, bindings);

    // B's items in the replay are already known, so they pass without an owner check.
    expect(result).toMatchObject({ ok: true, claimedClientIds: [] });
    if (result.ok) expect(Y.decodeUpdate(result.delta).structs).toEqual([]);
    expect(Y.encodeStateAsUpdate(server)).toEqual(before);
  });
});
