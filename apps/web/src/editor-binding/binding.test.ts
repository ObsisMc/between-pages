import {
  BODY,
  acceptBatch,
  authorRuns,
  buildBaseline,
  createDiaryDoc,
} from '@between-pages/collab';
import { MAX_MESSAGE_BYTES } from '@between-pages/contracts';
import { TextSelection } from 'prosemirror-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MAX_PASTE_BYTES } from './input.ts';
import { WRITE_SESSION_GAP_MS } from './write-session.ts';
import {
  FLASH_MS,
  createEditorBinding,
  type Caret,
  type EditorOperation,
  type Refusal,
} from './index.ts';

const ALICE = 'alice';
const BOB = 'bob';

/**
 * Alice's editor next to a stand-in for the server: every operation the editor emits is
 * checked with the server's own `acceptBatch`, and Bob's edits reach the editor only as
 * the re-encoded deltas the server would broadcast.
 */
const SLOTS: Record<string, string> = { [ALICE]: 'author-slot-1', [BOB]: 'author-slot-2' };

function setup(state?: { server: Y.Doc; bindings: Map<number, string> }) {
  const server = state?.server ?? createDiaryDoc();
  const bindings = state?.bindings ?? new Map<number, string>();
  const place = document.createElement('div');
  document.body.append(place);
  const operations: EditorOperation[] = [];
  const refusals: Refusal[] = [];
  const carets: (Caret | null)[] = [];
  const binding = createEditorBinding(place, {
    userId: ALICE,
    authorClass: (author) => SLOTS[author] ?? null,
    onCaret: (caret) => carets.push(caret),
    onOperation: (operation) => operations.push(operation),
    onRefuse: (refusal) => refusals.push(refusal),
  });
  if (state) binding.applyUpdate(Y.encodeStateAsUpdate(server), bindings);
  const { view } = binding;
  let committed = 0;

  const editor = {
    binding,
    view,
    operations,
    refusals,
    carets,
    server,
    bindings,
    text: () => view.state.doc.textContent,
    serverText: () => server.getText(BODY).toString(),
    authors: () => authorRuns(server, bindings).map((run) => [run.author, run.text]),
    select(from: number, to = from) {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1, to + 1)),
      );
    },
    caret: () => [view.state.selection.from - 1, view.state.selection.to - 1],
    /** What ProseMirror dispatches for typed text. */
    type(content: string) {
      for (const char of content) view.dispatch(view.state.tr.insertText(char));
    },
    press(key: string, init: KeyboardEventInit = {}) {
      const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      view.dom.dispatchEvent(down);
    },
    release(key: string) {
      view.dom.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    },
    paste(content: string) {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
      });
      view.dom.dispatchEvent(event);
    },
    /** Sends the operations emitted since the last call to the server, which must accept. */
    commit() {
      const updates = operations.slice(committed).map((operation) => operation.update);
      committed = operations.length;
      if (!updates.length) return;
      const result = acceptBatch(server, updates, ALICE, bindings);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) for (const client of result.claimedClientIds) bindings.set(client, ALICE);
    },
    /** Bob edits his own copy of the server state; the editor receives the server's delta. */
    bob(edit: (text: Y.Text) => void) {
      const copy = createDiaryDoc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
      let update: Uint8Array | undefined;
      copy.on('update', (u: Uint8Array) => (update = u));
      edit(copy.getText(BODY));
      const result = acceptBatch(server, [update!], BOB, bindings);
      if (!result.ok) throw new Error(result.reason);
      for (const client of result.claimedClientIds) bindings.set(client, BOB);
      binding.applyUpdate(result.delta, bindings);
    },
  };
  return editor;
}

/** Alice wrote "今天很累，" and Bob then added "抱抱！" after it, as committed state. */
function alongsideBob() {
  const editor = setup();
  editor.type('今天很累，');
  editor.commit();
  editor.bob((text) => text.insert(5, '抱抱！'));
  return editor;
}

const insertedStrings = (update: Uint8Array) =>
  Y.decodeUpdate(update)
    .structs.filter((s): s is Y.Item => s instanceof Y.Item)
    .map((item) => (item.content as Y.ContentString).str);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('editor binding', () => {
  it('turns each insert, delete and replace into one operation the server accepts', () => {
    const editor = setup();
    editor.type('Hello');
    editor.press('Backspace');
    editor.select(0, 4);
    editor.type('J');

    expect(editor.operations.map((op) => op.intent)).toEqual([
      [{ kind: 'insert', text: 'H', before: '', after: '' }],
      [{ kind: 'insert', text: 'e', before: 'H', after: '' }],
      [{ kind: 'insert', text: 'l', before: 'He', after: '' }],
      [{ kind: 'insert', text: 'l', before: 'Hel', after: '' }],
      [{ kind: 'insert', text: 'o', before: 'Hell', after: '' }],
      [{ kind: 'delete', text: 'o', before: 'Hell', after: '' }],
      [{ kind: 'replace', deleted: 'Hell', inserted: 'J', before: '', after: '' }],
    ]);
    editor.commit();
    expect(editor.text()).toBe('J');
    expect(editor.serverText()).toBe('J');
  });

  it('keeps about 20 graphemes of context around a change', () => {
    const editor = setup();
    editor.paste('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯');
    editor.select(22);
    editor.type('😀');

    expect(editor.operations.at(-1)!.intent).toEqual([
      {
        kind: 'insert',
        text: '😀',
        before: '三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑',
        after: '寅卯',
      },
    ]);
  });

  it('translates the steps themselves, so repeated characters keep their identity', () => {
    // A string diff cannot tell Alice's "哈" from Bob's "哈哈" and deletes Bob's.
    const editor = setup();
    editor.type('哈');
    editor.commit();
    editor.bob((text) => text.insert(1, '哈哈'));
    editor.select(1);
    editor.press('Backspace');
    editor.commit();

    expect(editor.authors()).toEqual([[BOB, '哈哈']]);
  });

  it('applies every step of a multi-step transaction in one operation', () => {
    const editor = setup();
    editor.type('ac');
    const { view } = editor;
    view.dispatch(view.state.tr.insertText('b', 2).insertText('d', 4));
    editor.commit();

    expect(editor.operations).toHaveLength(3);
    expect(editor.operations[2]!.intent.map((i) => i.kind === 'insert' && i.text)).toEqual([
      'b',
      'd',
    ]);
    expect(editor.serverText()).toBe('abcd');
  });

  it('shows remote deltas and keeps the caret on the same text', () => {
    const editor = alongsideBob();
    editor.select(2);
    editor.bob((text) => text.insert(0, '早，'));

    expect(editor.text()).toBe('早，今天很累，抱抱！');
    expect(editor.caret()).toEqual([4, 4]);
    expect(editor.operations).toHaveLength(5);
  });

  it('refuses text with an author the server has not named', () => {
    const editor = setup();
    const stranger = createDiaryDoc();
    stranger.getText(BODY).insert(0, 'x');

    expect(() => editor.binding.applyUpdate(Y.encodeStateAsUpdate(stranger), new Map())).toThrow(
      'has no bound author',
    );
    expect(editor.text()).toBe('');
  });

  it('refuses control characters the server would reject', () => {
    const editor = setup();
    editor.type('a\u0007');

    expect(editor.refusals).toEqual(['CONTROL_CHARACTER']);
    expect(editor.text()).toBe('a');
  });
});

describe('characters by identity', () => {
  it('[adr:diary-collaboration-kernel#26] names the other person’s characters in an index range by clientID and clock', () => {
    const editor = alongsideBob(); // 今天很累，抱抱！ — Bob's from index 5
    const bob = [...editor.bindings].find(([, user]) => user === BOB)![0];

    expect(editor.binding.othersCharacters(0, 20)).toEqual([
      { client: bob, clock: 0, length: 3, index: 5 },
    ]);
    expect(editor.binding.othersCharacters(6, 7)).toEqual([
      { client: bob, clock: 1, length: 1, index: 6 },
    ]);
    expect(editor.binding.othersCharacters(0, 5)).toEqual([]);
  });
});

describe('reading position', () => {
  it('[adr:unread-and-day-page#8] keeps an anchor on its character while the other person writes before it', () => {
    const editor = alongsideBob(); // 今天很累，抱抱！ — Bob's from index 5
    const anchor = editor.binding.anchorAt(6); // the second 抱

    editor.bob((text) => text.insert(0, '早上好。'));
    expect(editor.binding.indexOfAnchor(anchor)).toBe(10);
    editor.bob((text) => text.delete(9, 2)); // 抱抱 → the anchor's character is gone
    expect(editor.binding.indexOfAnchor(anchor)).toBe(9);
    expect(editor.text()).toBe('早上好。今天很累，！');
  });

  it('finds the next character the user wrote, past the other person’s', () => {
    const editor = alongsideBob();
    editor.bob((text) => text.insert(0, '早'));
    expect(editor.binding.ownCharacterFrom(0)).toBe(1);
    expect(editor.binding.ownCharacterFrom(3)).toBe(3);
    expect(editor.binding.ownCharacterFrom(6)).toBeNull();
  });

  it('highlights a passage briefly without changing the text', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const editor = alongsideBob();
    const operations = editor.operations.length;
    editor.binding.flash(5, 8);
    expect(editor.binding.view.dom.querySelector('.unread-flash')?.textContent).toBe('抱抱！');
    vi.advanceTimersByTime(FLASH_MS);
    expect(editor.binding.view.dom.querySelector('.unread-flash')).toBeNull();
    expect(editor.operations.length).toBe(operations);
  });
});

describe('authors on screen', () => {
  const colored = (editor: ReturnType<typeof setup>) =>
    [...editor.view.dom.querySelectorAll('[class*="author-slot"]')].map((el) => [
      el.className,
      el.textContent,
    ]);

  it('colors each author’s text by their slot, with no background', () => {
    const editor = alongsideBob();

    expect(colored(editor)).toEqual([
      ['author-slot-1', '今天很累，'],
      ['author-slot-2', '抱抱！'],
    ]);
    editor.type('嗯');
    expect(colored(editor).at(-1)).toEqual(['author-slot-1', '嗯']);
  });

  it('[adr:diary-collaboration-kernel#3] shows only the own text read-only, changing nothing, and restores both', () => {
    const editor = alongsideBob();
    editor.commit();
    const before = Y.encodeStateVector(editor.server);
    const made = editor.operations.length;

    editor.binding.setOwnTextOnly(true);
    expect(editor.view.dom.querySelector('.author-hidden')?.textContent).toBe('抱抱！');
    editor.select(5);
    editor.type('不该写入');
    editor.press('z', { ctrlKey: true });
    expect(editor.operations).toHaveLength(made);

    editor.binding.setOwnTextOnly(false);
    expect(editor.view.dom.querySelector('.author-hidden')).toBeNull();
    editor.type('好');
    expect(editor.operations).toHaveLength(made + 1);
    expect(Y.encodeStateVector(editor.server)).toEqual(before);
  });

  it('names the character at an index by identity and author', () => {
    const editor = alongsideBob();
    const bob = [...editor.bindings].find(([, user]) => user === BOB)![0];

    expect(editor.binding.characterAt(6)).toEqual({ client: bob, clock: 1, author: BOB });
    expect(editor.binding.characterAt(0)).toMatchObject({ clock: 0, author: ALICE });
    expect(editor.binding.characterAt(8)).toBeNull();
  });
});

describe('carets', () => {
  const caretOf = (doc: Y.Doc, index: number) => {
    const bytes = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(doc.getText(BODY), index),
    );
    return { anchor: bytes, head: bytes };
  };

  it('[adr:diary-collaboration-kernel#25] shows a caret on text not received yet only once that text arrives', () => {
    const editor = setup();
    editor.type('早安');
    editor.commit();
    // Bob types in his copy and puts his caret inside his new text, before it reaches Alice.
    const copy = createDiaryDoc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(editor.server));
    let update: Uint8Array | undefined;
    copy.on('update', (u: Uint8Array) => (update = u));
    copy.getText(BODY).insert(2, '！？');
    const ahead = caretOf(copy, 3);

    editor.binding.showCaret(BOB, ahead, { name: 'bob', className: 'author-slot-2' });
    expect(editor.view.dom.querySelector('.remote-caret')).toBeNull();

    const result = acceptBatch(editor.server, [update!], BOB, editor.bindings);
    if (!result.ok) throw new Error(result.reason);
    for (const client of result.claimedClientIds) editor.bindings.set(client, BOB);
    editor.binding.applyUpdate(result.delta, editor.bindings);

    const shown = editor.view.dom.querySelector('.remote-caret');
    expect(shown?.getAttribute('data-name')).toBe('bob');
    expect(shown?.previousSibling?.textContent).toBe('！');
    editor.binding.showCaret(BOB, null, { name: 'bob', className: null });
    expect(editor.view.dom.querySelector('.remote-caret')).toBeNull();
  });

  it('reports the own caret as a relative position after the user moves it, and its leaving', () => {
    const place = document.createElement('div');
    document.body.append(place);
    const carets: ({ anchor: Uint8Array; head: Uint8Array } | null)[] = [];
    const binding = createEditorBinding(place, {
      userId: ALICE,
      onCaret: (caret) => carets.push(caret),
      onOperation: () => undefined,
      onRefuse: () => undefined,
    });
    binding.view.focus();
    binding.view.dispatch(binding.view.state.tr.insertText('你好'));
    const last = carets.at(-1)!;
    expect(last).not.toBeNull();
    expect(Y.decodeRelativePosition(last.head)).toMatchObject({ assoc: 0 });

    binding.view.dom.dispatchEvent(new FocusEvent('blur'));
    expect(carets.at(-1)).toBeNull();
    binding.destroy();
  });
});

describe('author protection', () => {
  it("[adr:diary-collaboration-kernel#3] Backspace jumps over the other person's text without deleting it", () => {
    const editor = alongsideBob();
    editor.press('Backspace');

    expect(editor.caret()).toEqual([5, 5]);
    editor.press('Backspace');
    editor.commit();
    expect(editor.text()).toBe('今天很累抱抱！');
    expect(editor.authors()).toEqual([
      [ALICE, '今天很累'],
      [BOB, '抱抱！'],
    ]);
  });

  it('[adr:diary-collaboration-kernel#3] Delete jumps forward, and stops at the edge without own text', () => {
    const editor = alongsideBob();
    editor.select(5);
    editor.press('Delete');

    expect(editor.caret()).toEqual([8, 8]);
    expect(editor.operations).toHaveLength(5);
    editor.select(0);
    editor.bob((text) => text.insert(0, '嗨'));
    editor.select(1);
    editor.press('Backspace');
    expect(editor.caret()).toEqual([0, 0]);
    expect(editor.text()).toBe('嗨今天很累，抱抱！');
  });

  it('[adr:diary-collaboration-kernel#3] a held key stops at the jump until it is released', () => {
    const editor = alongsideBob();
    editor.type('好');
    editor.select(6);
    editor.press('Backspace');
    editor.press('Backspace', { repeat: true });
    editor.press('Backspace', { repeat: true });

    expect(editor.text()).toBe('今天很累，抱抱！好');
    expect(editor.caret()).toEqual([5, 5]);
    editor.release('Backspace');
    editor.press('Backspace');
    expect(editor.text()).toBe('今天很累抱抱！好');
  });

  it('[adr:diary-collaboration-kernel#3] refuses deleting, typing, cutting or pasting over a mixed selection', () => {
    const editor = alongsideBob();
    const { view } = editor;
    editor.select(3, 7);
    editor.press('Backspace');
    editor.type('x');
    editor.paste('y');
    view.dispatch(view.state.tr.deleteSelection()); // what ProseMirror's cut dispatches

    expect(editor.refusals).toEqual(Array(4).fill('FOREIGN_TEXT'));
    expect(editor.text()).toBe('今天很累，抱抱！');
    expect(editor.operations).toHaveLength(5);
  });

  it("[adr:diary-collaboration-kernel#3] inserts and line breaks inside the other person's text are the writer's", () => {
    const editor = alongsideBob();
    editor.select(6);
    editor.press('Enter');
    editor.type('嗯');
    editor.commit();

    expect(editor.authors()).toEqual([
      [ALICE, '今天很累，'],
      [BOB, '抱'],
      [ALICE, '\n嗯'],
      [BOB, '抱！'],
    ]);
  });

  it('blocks dropping dragged text', () => {
    const editor = alongsideBob();
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
  });
});

describe('personal undo', () => {
  const undo = (editor: ReturnType<typeof setup>) => editor.press('z', { ctrlKey: true });
  const redo = (editor: ReturnType<typeof setup>) =>
    editor.press('z', { ctrlKey: true, shiftKey: true });

  it("[adr:diary-collaboration-kernel#3] [adr:diary-collaboration-kernel#19] undo and redo leave the other person's text alone", () => {
    const editor = setup();
    editor.type('今天很累');
    editor.commit();
    editor.bob((text) => text.insert(2, '（抱抱）'));
    undo(editor);
    editor.commit();

    expect(editor.authors()).toEqual([[BOB, '（抱抱）']]);
    redo(editor);
    editor.commit();
    expect(editor.text()).toBe('今天（抱抱）很累');
    expect(editor.authors().filter(([author]) => author === BOB)).toEqual([[BOB, '（抱抱）']]);
  });

  it('[adr:diary-collaboration-kernel#19] undo restores own deleted text as a new own operation', () => {
    const editor = setup();
    editor.type('写字');
    editor.press('Backspace');
    undo(editor);
    editor.commit();

    expect(editor.operations.at(-1)!.intent).toEqual([
      { kind: 'insert', text: '字', before: '写', after: '' },
    ]);
    // The restored character is new: Alice's again, under a later clock.
    expect(editor.serverText()).toBe('写字');
    expect(editor.authors()).toEqual([
      [ALICE, '写'],
      [ALICE, '字'],
    ]);
  });

  it('[adr:diary-collaboration-kernel#19] undo never reverts what the other person wrote', () => {
    const editor = setup();
    editor.bob((text) => text.insert(0, '抱抱'));
    undo(editor);

    expect(editor.text()).toBe('抱抱');
    expect(editor.operations).toEqual([]);
  });

  it("routes the browser's own undo and line-break input through the same paths", () => {
    const editor = setup();
    const input = (inputType: string) =>
      editor.view.dom.dispatchEvent(
        new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }),
      );
    editor.type('一');
    input('insertParagraph');
    expect(editor.text()).toBe('一\n');
    input('historyUndo'); // typing, line breaks included, is one undo step
    expect(editor.text()).toBe('');
    input('historyRedo');
    editor.commit();

    expect(editor.serverText()).toBe('一\n');
  });

  it('read-only makes no operation from typing, pasting or undo, and still shows remote text', () => {
    const editor = alongsideBob();
    editor.type('累');
    editor.commit();
    const before = editor.operations.length;
    editor.binding.setEditable(false);
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('false');

    editor.type('字');
    editor.paste('贴');
    editor.press('z', { ctrlKey: true });
    expect(editor.operations).toHaveLength(before);
    editor.bob((text) => text.insert(0, '早'));
    expect(editor.text()).toBe(editor.serverText());

    editor.binding.setEditable(true);
    editor.type('好');
    expect(editor.operations).toHaveLength(before + 1);
  });

  it('[adr:diary-collaboration-kernel#19] a new generation starts with an empty undo history', () => {
    const first = setup();
    first.type('上一起点');
    first.commit();
    const baseline = buildBaseline(Y.encodeStateAsUpdate(first.server));
    if (!baseline.ok) throw new Error(baseline.problem);
    first.binding.destroy();

    const server = createDiaryDoc();
    Y.applyUpdate(server, baseline.baseline);
    const next = setup({ server, bindings: first.bindings });
    undo(next);

    expect(next.text()).toBe('上一起点');
    expect(next.operations).toEqual([]);
  });
});

describe('IME composition', () => {
  const compositionEvent = (editor: ReturnType<typeof setup>, type: string) =>
    editor.view.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true }));

  it('emits only the confirmed text, once', () => {
    const editor = setup();
    editor.type('我');
    compositionEvent(editor, 'compositionstart');
    const { view } = editor;
    view.dispatch(view.state.tr.insertText('n'));
    view.dispatch(view.state.tr.insertText('ni', 2, 3));
    compositionEvent(editor, 'compositionend');
    // ProseMirror's read of the final DOM change, after the end event.
    view.dispatch(view.state.tr.insertText('你', 2, 4).setMeta('composition', 1));
    editor.commit();

    expect(editor.operations).toHaveLength(2);
    expect(editor.operations[1]!.intent).toEqual([
      { kind: 'insert', text: '你', before: '我', after: '' },
    ]);
    expect(insertedStrings(editor.operations[1]!.update)).toEqual(['你']);
    expect(editor.serverText()).toBe('我你');
    // The composed text takes its author's color once the composition ends.
    expect(editor.view.dom.querySelector('.author-slot-1')?.textContent).toBe('我你');
  });

  it('completes a composition whose last change was read before it ended', async () => {
    const editor = setup();
    compositionEvent(editor, 'compositionstart');
    const { view } = editor;
    view.dispatch(view.state.tr.insertText('h'));
    view.dispatch(view.state.tr.insertText('好', 1, 2));
    compositionEvent(editor, 'compositionend');
    expect(editor.operations).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve));
    editor.commit();

    expect(editor.operations).toHaveLength(1);
    expect(editor.serverText()).toBe('好');
  });

  it('holds remote deltas until the composition ends, then shows both', () => {
    const editor = alongsideBob();
    editor.select(5);
    compositionEvent(editor, 'compositionstart');
    const { view } = editor;
    view.dispatch(view.state.tr.insertText('z'));
    editor.bob((text) => text.insert(0, '早'));
    expect(editor.text()).toBe('今天很累，z抱抱！');
    view.dispatch(view.state.tr.insertText('在', 6, 7));
    compositionEvent(editor, 'compositionend');
    view.dispatch(view.state.tr.setMeta('composition', 1).insertText('在', 6, 7));
    editor.commit();

    expect(editor.text()).toBe('早今天很累，在抱抱！');
    expect(editor.serverText()).toBe(editor.text());
    expect(editor.caret()).toEqual([7, 7]);
    expect(insertedStrings(editor.operations.at(-1)!.update)).toEqual(['在']);
  });

  describe('the own caret the other person sees', () => {
    /** Where a sent caret lands in the committed text, as the other person's copy resolves it. */
    const landing = (editor: ReturnType<typeof setup>, caret: Caret | null) =>
      caret &&
      Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(caret.head),
        editor.server,
      )?.index;
    /** Shows each candidate in turn where the caret is, as an input method does. */
    const compose = (editor: ReturnType<typeof setup>, candidates: string[], shown = '') => {
      const { view } = editor;
      const at = view.state.selection.from - shown.length;
      for (const candidate of candidates) {
        view.dispatch(view.state.tr.insertText(candidate, at, at + shown.length));
        shown = candidate;
      }
      return shown;
    };
    /** "AB" committed, the caret between A and B, focused. */
    const betweenAB = () => {
      const editor = setup();
      editor.view.focus();
      editor.type('AB');
      editor.commit();
      editor.select(1);
      return editor;
    };
    const ended = () => new Promise((resolve) => setTimeout(resolve));

    // Candidates as each input method shows them; the last is replaced by the confirmed text
    // before the composition ends, as Chromium reads it.
    it.each([
      ['Chinese pinyin', ['n', 'ni', 'nih', 'niha', 'nihao'], '你好'],
      ['Japanese conversion', ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん', '日本'], '日本'],
      ['a dead key', ['´'], 'é'],
      ['Vietnamese Telex', ['v', 'vi', 'vie', 'viê', 'việt'], 'việt'],
      ['a keyboard composing whole Latin words', ['h', 'he', 'hel', 'hell', 'hello'], 'hello'],
    ])(
      '%s: stays where composing began, then follows the confirmed text',
      async (_method, candidates, confirmed) => {
        const editor = betweenAB();
        const before = editor.carets.length;
        compositionEvent(editor, 'compositionstart');
        const shown = compose(editor, candidates);
        compose(editor, [confirmed], shown);
        const during = editor.carets.slice(before);
        compositionEvent(editor, 'compositionend');
        await ended();
        editor.commit();

        expect(during.map((caret) => landing(editor, caret))).toEqual(during.map(() => 1));
        expect(editor.serverText()).toBe(`A${confirmed}B`);
        expect(landing(editor, editor.carets.at(-1)!)).toBe(1 + confirmed.length);
      },
    );

    it('Korean: follows each syllable as it is confirmed', async () => {
      const editor = betweenAB();
      // The input method confirms each syllable as its last candidate and starts the next.
      for (const candidates of [
        ['ㅎ', '하', '한'],
        ['ㄱ', '그', '글'],
      ]) {
        const confirmed = candidates.at(-1)!;
        compositionEvent(editor, 'compositionstart');
        compose(editor, candidates);
        compositionEvent(editor, 'compositionend');
        await ended();
        editor.commit();
        expect(landing(editor, editor.carets.at(-1)!)).toBe(
          editor.serverText().indexOf(confirmed) + 1,
        );
      }
      expect(editor.serverText()).toBe('A한글B');
    });

    it('returns to where it was when the composition is cancelled', async () => {
      const editor = betweenAB();
      compositionEvent(editor, 'compositionstart');
      const shown = compose(editor, ['n', 'ni']);
      compose(editor, [''], shown);
      compositionEvent(editor, 'compositionend');
      await ended();

      expect(editor.serverText()).toBe('AB');
      expect(landing(editor, editor.carets.at(-1)!)).toBe(1);
    });

    it('lands after the confirmed text when the other person wrote meanwhile', () => {
      const editor = alongsideBob();
      editor.view.focus();
      editor.select(5);
      compositionEvent(editor, 'compositionstart');
      const { view } = editor;
      view.dispatch(view.state.tr.insertText('z'));
      editor.bob((text) => text.insert(0, '早'));
      compositionEvent(editor, 'compositionend');
      view.dispatch(view.state.tr.setMeta('composition', 1).insertText('在', 6, 7));
      editor.commit();

      expect(editor.serverText()).toBe('早今天很累，在抱抱！');
      expect(landing(editor, editor.carets.at(-1)!)).toBe(7);
    });

    it("stays where the refused composition began over the other person's text", () => {
      const editor = alongsideBob();
      editor.view.focus();
      editor.select(4, 6);
      compositionEvent(editor, 'compositionstart');
      const { view } = editor;
      view.dispatch(view.state.tr.insertText('a'));
      compositionEvent(editor, 'compositionend');
      view.dispatch(view.state.tr.insertText('啊', 5, 6).setMeta('composition', 1));

      expect(editor.refusals).toEqual(['FOREIGN_TEXT']);
      expect(landing(editor, editor.carets.at(-1)!)).toBe(4);
    });
  });

  it("[adr:diary-collaboration-kernel#3] refuses a composition over the other person's text", () => {
    const editor = alongsideBob();
    editor.select(4, 6);
    compositionEvent(editor, 'compositionstart');
    const { view } = editor;
    view.dispatch(view.state.tr.insertText('a'));
    compositionEvent(editor, 'compositionend');
    view.dispatch(view.state.tr.insertText('啊', 5, 6).setMeta('composition', 1));

    expect(editor.refusals).toEqual(['FOREIGN_TEXT']);
    expect(editor.text()).toBe('今天很累，抱抱！');
    expect(editor.operations).toHaveLength(5);
  });
});

describe('Unicode', () => {
  it.each([
    ['a family emoji', '👨‍👩‍👧‍👦'],
    ['a flag', '🇨🇳'],
    ['a skin tone', '👍🏽'],
    ['a combining accent', 'é'],
  ])('Backspace removes %s as one character', (_, cluster) => {
    const editor = setup();
    editor.paste(`中文${cluster}`);
    editor.press('Backspace');
    editor.commit();

    expect(editor.text()).toBe('中文');
    expect(editor.operations.at(-1)!.intent).toEqual([
      { kind: 'delete', text: cluster, before: '中文', after: '' },
    ]);
  });

  it('Delete removes the cluster after the caret as one character', () => {
    const editor = setup();
    editor.paste('🇯🇵and');
    editor.select(0);
    editor.press('Delete');
    editor.commit();

    expect(editor.serverText()).toBe('and');
  });
});

describe('paste', () => {
  it('pastes plain text with ordinary line breaks', () => {
    const editor = setup();
    editor.paste('第一行\r\n第二行\r第三\u0000行\t！');
    editor.commit();

    expect(editor.serverText()).toBe('第一行\n第二行\n第三行\t！');
    expect(editor.operations).toHaveLength(1);
  });

  it('replaces an own selection in one operation', () => {
    const editor = setup();
    editor.type('今天累');
    editor.select(2, 3);
    editor.paste('开心');
    editor.commit();

    expect(editor.operations.at(-1)!.intent).toEqual([
      { kind: 'replace', deleted: '累', inserted: '开心', before: '今天', after: '' },
    ]);
    expect(editor.serverText()).toBe('今天开心');
  });

  it('accepts the largest paste whose operation still fits one submit message', () => {
    const editor = setup();
    editor.paste('字'.repeat(Math.floor(MAX_PASTE_BYTES / 3)));
    const [operation] = editor.operations;
    const message = JSON.stringify({
      v: 1,
      type: 'submit',
      diaryId: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      generationId: crypto.randomUUID(),
      operations: [
        {
          operationId: operation!.operationId,
          update: Buffer.from(operation!.update).toString('base64'),
          writtenAt: operation!.writtenAt.toISOString(),
        },
      ],
    });

    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it('refuses a larger paste at input and creates no operation', () => {
    const editor = setup();
    editor.paste('a'.repeat(MAX_PASTE_BYTES + 1));

    expect(editor.refusals).toEqual(['PASTE_TOO_LARGE']);
    expect(editor.operations).toEqual([]);
    expect(editor.text()).toBe('');
  });
});

describe('written time', () => {
  const times = (editor: ReturnType<typeof setup>) =>
    editor.operations.map((op) => op.writtenAt.toISOString().slice(11, 19));

  it('gives continuous typing the time its write session started', () => {
    const editor = setup();
    editor.type('今天');
    vi.setSystemTime(new Date('2026-10-26T09:00:20Z'));
    editor.press('Backspace');
    editor.type('日');
    vi.setSystemTime(new Date('2026-10-26T09:00:20Z').getTime() + WRITE_SESSION_GAP_MS + 1);
    editor.type('记');

    expect(times(editor)).toEqual(['09:00:00', '09:00:00', '09:00:00', '09:00:00', '09:00:50']);
  });

  it('starts a new session at another place or for a replacement', () => {
    const editor = setup();
    editor.type('ab');
    vi.setSystemTime(new Date('2026-10-26T09:00:05Z'));
    editor.select(0);
    editor.type('x');
    vi.setSystemTime(new Date('2026-10-26T09:00:06Z'));
    editor.select(0, 1);
    editor.type('y');

    expect(times(editor)).toEqual(['09:00:00', '09:00:00', '09:00:05', '09:00:06']);
  });
});
