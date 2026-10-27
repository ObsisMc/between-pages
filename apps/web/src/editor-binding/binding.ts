import { BODY, createDiaryDoc, type ClientBindings } from '@between-pages/collab';
import { keymap } from 'prosemirror-keymap';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { Mapping, Transform, type Step } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { hasControlCharacter, pasteFits, plainText } from './input.ts';
import { changesOf, intentOf, type Change, type EditIntent } from './intent.ts';
import { erase, ownsRange, spansOf, type Span } from './protection.ts';
import { docOf, indexOf, lengthOf, schema, textOf } from './schema.ts';
import { createWriteSessions } from './write-session.ts';

/** One change in the editor: one Yjs transaction and what it meant (kernel ADR D13, D7). */
export type EditorOperation = {
  operationId: string;
  /** The transaction exactly as the `update` event emitted it, the form `acceptBatch` takes. */
  update: Uint8Array;
  /** Start of the write session the operation belongs to; for display only (D13, D15). */
  writtenAt: Date;
  /** Its contiguous changes in document order; one, except for some undo steps. */
  intent: EditIntent[];
};

/** Input the editor refused. The text is unchanged and the user should be told why. */
export type Refusal =
  /** It would delete or change the other person's characters (invariant 3). */
  | 'FOREIGN_TEXT'
  /** The paste would not fit one message; the clipboard is untouched (D13). */
  | 'PASTE_TOO_LARGE'
  /** Text the server rejects, which would stop the send queue. */
  | 'CONTROL_CHARACTER';

export type EditorBindingOptions = {
  /** The session user; characters bound to anyone else are the other person's. */
  userId: string;
  /** Called synchronously for every operation, in order; nothing else records it. */
  onOperation: (operation: EditorOperation) => void;
  onRefuse: (refusal: Refusal) => void;
};

export type EditorBinding = {
  /** For mounting and focus; every transaction dispatched to it passes the same checks. */
  view: EditorView;
  /**
   * Applies an update this instance did not make (committed deltas, or the journal's
   * pending operations of an earlier instance) with the bindings naming its authors. It is
   * shown at once, or after an active composition ends; personal undo never includes it.
   * Throws when the update carries text whose clientID has no author.
   */
  applyUpdate(update: Uint8Array, bindings: ClientBindings): void;
  /** Read-only stops every edit path, undo included; applied updates are still shown. */
  setEditable(editable: boolean): void;
  destroy(): void;
};

// Transaction origins: edits translated from editor steps, and updates applied from outside.
// Undo and redo run with the UndoManager as origin.
const LOCAL = Symbol('editor edit');
const APPLIED = Symbol('applied update');
// Marks a ProseMirror transaction that follows `Y.Text` instead of proposing an edit.
const MIRROR = 'editor-binding/mirror';

type Edit = { from: number; to: number; inserted: string };
/** An IME composition in progress: the editor shows it, `Y.Text` does not have it yet. */
type Composition = { start: Node; steps: Step[]; deferred: Transform };

/**
 * Binds a new ProseMirror view in `place` to a new `Y.Text('body')`. One binding per diary
 * generation: a new generation needs a new document with a new clientID and an undo
 * history that starts empty (D3, D4, D8), so the caller destroys this one and creates
 * another. Before the first `applyUpdate` the text is empty.
 */
export function createEditorBinding(
  place: HTMLElement,
  { userId, onOperation, onRefuse }: EditorBindingOptions,
): EditorBinding {
  const doc = createDiaryDoc();
  const text = doc.getText(BODY);
  const bound = new Map<number, string>();
  // clientIDs this instance wrote with: Yjs switches to a new one when it meets a collision.
  const own = new Set<number>();
  // Personal undo: only edits this instance made, never applied updates (D8).
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]) });
  const writtenAt = createWriteSessions(text);
  let composition: Composition | undefined;
  let changes: Change[] = [];
  let intent: EditIntent[] = [];
  let lastKind: EditIntent['kind'] | undefined;
  let heldAfterJump = false;
  let compositionTimer: ReturnType<typeof setTimeout> | undefined;

  text.observe((event, transaction) => {
    const origin = transaction.origin;
    if (origin === LOCAL || origin === undoManager) {
      const before = read(mirror());
      changes = changesOf(event.delta, before);
      intent = changes.map((change) => intentOf(change, before));
    }
    if (origin !== LOCAL) reflect(event.delta);
  });
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL && origin !== undoManager) return;
    const operationId = crypto.randomUUID();
    onOperation({ operationId, update, writtenAt: writtenAt(changes, origin === LOCAL), intent });
  });

  let editable = true;
  const view: EditorView = new EditorView(place, {
    editable: () => editable,
    state: EditorState.create({
      doc: docOf(''),
      plugins: [
        keymap({
          Enter: () => insert('\n'),
          'Shift-Enter': () => insert('\n'),
          'Mod-z': () => history('undo'),
          'Mod-Shift-z': () => history('redo'),
          'Mod-y': () => history('redo'),
        }),
      ],
    }),
    attributes: { role: 'textbox', 'aria-multiline': 'true', style: 'white-space: pre-wrap' },
    dispatchTransaction: dispatch,
    handleKeyDown: (_view, event) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
      // Word and line deletion run natively and arrive as steps, which are checked.
      if (event.ctrlKey || event.metaKey || event.altKey || view.composing) return false;
      // A held key that jumped over the other person's text deletes nothing more until it
      // is released (EDIT-05).
      if (heldAfterJump && event.repeat) return true;
      heldAfterJump = false;
      eraseAtCaret(event.key === 'Backspace' ? -1 : 1);
      return true;
    },
    handleDOMEvents: {
      keyup: (_view, event) => {
        if (event.key === 'Backspace' || event.key === 'Delete') heldAfterJump = false;
        return false;
      },
      beforeinput: (_view, event) => {
        const { inputType } = event as InputEvent;
        if (inputType === 'historyUndo' || inputType === 'historyRedo') {
          event.preventDefault();
          history(inputType === 'historyUndo' ? 'undo' : 'redo');
          return true;
        }
        if (
          (inputType === 'insertParagraph' || inputType === 'insertLineBreak') &&
          !view.composing
        ) {
          event.preventDefault();
          insert('\n');
          return true;
        }
        return false;
      },
      paste: (_view, event) => {
        event.preventDefault();
        paste(event.clipboardData?.getData('text/plain') ?? '');
        return true;
      },
      // Dropping would move or copy text past the paste rules; dragging out still copies.
      drop: (_view, event) => {
        event.preventDefault();
        return true;
      },
      compositionend: () => {
        // ProseMirror reads the last composed DOM change in a microtask after this event, as
        // a transaction marked with the composition; when there is none left to read, the
        // composition is complete once that microtask has run.
        clearTimeout(compositionTimer);
        compositionTimer = setTimeout(() => {
          if (composition && !view.composing) finishComposition();
        });
        return false;
      },
    },
  });

  function dispatch(tr: Transaction) {
    if (tr.getMeta(MIRROR) || !tr.docChanged) return view.updateState(view.state.apply(tr));
    if (!editable) return view.updateState(view.state);
    if (composition || view.composing || tr.getMeta('composition') !== undefined)
      return compose(tr);
    const edits = editsOf(tr);
    const refusal = touchesForeignText(tr)
      ? 'FOREIGN_TEXT'
      : edits.some((edit) => hasControlCharacter(edit.inserted))
        ? 'CONTROL_CHARACTER'
        : undefined;
    if (refusal) return refuse(refusal);
    commit(edits);
    view.updateState(view.state.apply(tr));
  }

  /**
   * Translates each step into `Y.Text` edits in the order they must be applied: steps in
   * sequence, and the ranges within one step right to left so earlier indexes still hold.
   */
  function editsOf(tr: Transaction): Edit[] {
    return tr.steps.flatMap((step, i) => {
      const before = tr.docs[i]!;
      const after = tr.docs[i + 1] ?? tr.doc;
      const ranges: Edit[] = [];
      step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        const inserted = textOf(after, indexOf(after, newStart), indexOf(after, newEnd));
        ranges.push({ from: indexOf(before, oldStart), to: indexOf(before, oldEnd), inserted });
      });
      return ranges.reverse();
    });
  }

  /** Whether any step removes a character that existed before the transaction and is not own. */
  function touchesForeignText(tr: Transaction): boolean {
    // Walking the authorship is linear in the text, so typing alone never pays for it.
    let spans: Span[] | undefined;
    return tr.steps.some((step, i) => {
      // Back to the original document; text an earlier step inserted maps to nothing.
      // (`Mapping.slice` bounds are ignored by `invert`, hence a mapping of the prefix.)
      const back = new Mapping(tr.mapping.maps.slice(0, i)).invert();
      let foreign = false;
      step.getMap().forEach((oldStart, oldEnd) => {
        const from = indexOf(tr.before, back.map(oldStart, 1));
        const to = indexOf(tr.before, back.map(oldEnd, -1));
        if (from >= to) return;
        spans ??= spansOf(doc, authors(), userId);
        if (!ownsRange(spans, from, to)) foreign = true;
      });
      return foreign;
    });
  }

  function commit(edits: Edit[]) {
    own.add(doc.clientID);
    const kind = edits.every((edit) => edit.from === edit.to)
      ? 'insert'
      : edits.every((edit) => !edit.inserted)
        ? 'delete'
        : 'replace';
    // Typing, deleting and replacing are separate undo steps however quickly they follow;
    // otherwise Yjs merges whatever falls within its 500 ms capture window.
    if (kind !== lastKind || kind === 'replace') undoManager.stopCapturing();
    lastKind = kind;
    doc.transact(() => edits.forEach(applyEdit), LOCAL);
  }

  function applyEdit({ from, to, inserted }: Edit) {
    if (to > from) text.delete(from, to - from);
    if (inserted) text.insert(from, inserted);
  }

  function refuse(refusal: Refusal) {
    // The DOM may already show the refused input; rendering the unchanged state resets it.
    view.updateState(view.state);
    onRefuse(refusal);
  }

  // Composition (EDIT-11): candidate text stays in the editor and only the confirmed result
  // becomes one operation, so pinyin never reaches `Y.Text` or the server. Updates arriving
  // meanwhile wait in `deferred` instead of disturbing the IME.
  function compose(tr: Transaction) {
    composition ??= beginComposition();
    composition.steps.push(...tr.steps);
    view.updateState(view.state.apply(tr));
    if (!view.composing) finishComposition();
  }

  function beginComposition(): Composition {
    return { start: view.state.doc, steps: [], deferred: new Transform(view.state.doc) };
  }

  function finishComposition() {
    clearTimeout(compositionTimer);
    const { deferred } = composition!;
    const net = netChange(composition!);
    const toCurrent = (index: number, assoc: number) =>
      indexOf(deferred.doc, deferred.mapping.map(index + 1, assoc));
    if (!net) {
      composition = undefined;
      if (deferred.docChanged)
        rebuild(toCurrent(indexOf(view.state.doc, view.state.selection.head), 1));
      return;
    }
    const from = toCurrent(net.from, 1);
    const edit = { from, to: Math.max(from, toCurrent(net.to, -1)), inserted: net.inserted };
    const refusal =
      edit.to > from && !ownsRange(spansOf(doc, authors(), userId), from, edit.to)
        ? 'FOREIGN_TEXT'
        : hasControlCharacter(edit.inserted)
          ? 'CONTROL_CHARACTER'
          : undefined;
    if (refusal) {
      composition = undefined;
      rebuild(from);
      return onRefuse(refusal);
    }
    // The observer still reads the pre-edit text from `deferred`, so clear afterwards.
    commit([edit]);
    composition = undefined;
    if (deferred.docChanged) rebuild(from + edit.inserted.length);
  }

  /**
   * The composition's overall replacement of its start text, from the ranges its steps
   * actually changed; undefined when it changed nothing.
   */
  function netChange({ start, steps }: Composition): Edit | undefined {
    const mapping = new Mapping(steps.map((step) => step.getMap()));
    let low = Infinity;
    let high = -Infinity;
    steps.forEach((step, i) => {
      const rest = mapping.slice(i + 1);
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        low = Math.min(low, rest.map(newStart, -1));
        high = Math.max(high, rest.map(newEnd, 1));
      });
    });
    if (low > high) return undefined;
    const back = mapping.invert();
    const end = view.state.doc;
    const from = indexOf(start, back.map(low, -1));
    const to = indexOf(start, back.map(high, 1));
    const inserted = textOf(end, indexOf(end, low), indexOf(end, high));
    return from === to && !inserted ? undefined : { from, to, inserted };
  }

  /** Shows `Y.Text` again, for when the editor displayed text the document does not have. */
  function rebuild(caret: number) {
    const content = text.length ? schema.text(text.toString()) : [];
    const tr = view.state.tr.replaceWith(1, view.state.doc.content.size - 1, content);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, text.length) + 1));
    view.dispatch(tr.setMeta(MIRROR, true));
  }

  /** The editor document that matches `Y.Text` before the current transaction. */
  function mirror(): Node {
    return composition ? composition.deferred.doc : view.state.doc;
  }

  function reflect(delta: Y.YTextEvent['delta']) {
    if (composition || view.composing) {
      composition ??= beginComposition();
      applyDelta(composition.deferred, delta);
      return;
    }
    const tr = view.state.tr;
    applyDelta(tr, delta);
    view.dispatch(tr.setMeta(MIRROR, true));
  }

  function applyDelta(tr: Transform, delta: Y.YTextEvent['delta']) {
    let pos = 1;
    for (const op of delta) {
      if (op.retain !== undefined) pos += op.retain;
      if (op.delete !== undefined) tr.delete(pos, pos + op.delete);
      if (typeof op.insert === 'string') {
        tr.insert(pos, schema.text(op.insert));
        pos += op.insert.length;
      }
    }
  }

  function eraseAtCaret(direction: -1 | 1) {
    const { state } = view;
    const { empty, from, to } = state.selection;
    if (!empty) return view.dispatch(state.tr.delete(from, to));
    const spans = spansOf(doc, authors(), userId);
    const read = (a: number, b: number) => textOf(state.doc, a, b);
    const result = erase(spans, read, lengthOf(state.doc), indexOf(state.doc, from), direction);
    if (!result) return;
    if ('caret' in result) {
      heldAfterJump = true;
      return view.dispatch(
        state.tr.setSelection(TextSelection.create(state.doc, result.caret + 1)),
      );
    }
    view.dispatch(state.tr.delete(result.from + 1, result.to + 1));
  }

  function insert(content: string): boolean {
    view.dispatch(view.state.tr.insertText(content));
    return true;
  }

  function paste(raw: string) {
    const content = plainText(raw);
    const { state } = view;
    const from = indexOf(state.doc, state.selection.from);
    const to = indexOf(state.doc, state.selection.to);
    const spans = from < to ? spansOf(doc, authors(), userId) : [];
    const replaced = spans.filter((span) => span.end > from && span.start < to).length;
    if (!pasteFits(content, replaced)) return onRefuse('PASTE_TOO_LARGE');
    view.dispatch(state.tr.insertText(content, state.selection.from, state.selection.to));
  }

  function history(direction: 'undo' | 'redo'): boolean {
    if (composition || view.composing || !editable) return false;
    own.add(doc.clientID);
    if (direction === 'undo') undoManager.undo();
    else undoManager.redo();
    // The next edit is a new step, not part of the one now on top of the stack.
    undoManager.stopCapturing();
    lastKind = undefined;
    return true;
  }

  /** The server's bindings, plus this instance's clientIDs before they are committed. */
  function authors(): ClientBindings {
    const all = new Map<number, string>();
    for (const client of own) all.set(client, userId);
    for (const [client, user] of bound) all.set(client, user);
    return all;
  }

  return {
    view,
    applyUpdate(update, bindings) {
      for (const [client, user] of bindings) bound.set(client, user);
      // Every visible character needs an author before it is shown, or the next edit's
      // authorship check would have nothing to go on.
      for (const struct of Y.decodeUpdate(update).structs) {
        const { client } = struct.id;
        if (struct instanceof Y.Item && struct.content instanceof Y.ContentString)
          if (!bound.has(client) && !own.has(client))
            throw new Error(`clientID ${client} has no bound author`);
      }
      Y.applyUpdate(doc, update, APPLIED);
    },
    setEditable(value) {
      editable = value;
      view.setProps({ editable: () => editable });
    },
    destroy() {
      clearTimeout(compositionTimer);
      undoManager.destroy();
      view.destroy();
      doc.destroy();
    },
  };
}

function read(doc: Node) {
  return (from: number, to: number) => textOf(doc, from, to);
}
