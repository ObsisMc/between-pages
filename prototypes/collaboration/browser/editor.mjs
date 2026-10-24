import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { Client } from '../client.mjs';
import { Document, ROOT, Rejection } from '../model.mjs';
import { IndexedJournal, mergeJournals } from './journal.mjs';
import { ranges, replacement, deletion, anchor, resolve } from './policy.mjs';

if ('serviceWorker' in navigator) { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; }
const params = new URLSearchParams(location.search);
const actor = params.get('actor') === 'B' ? 'B' : 'A';
const docId = params.get('doc') ?? 'manual';
const journal = await IndexedJournal.open(`${docId}:${actor}`);
const client = await Client.open(actor, journal);
const session = crypto.randomUUID();
const token = `probe-${actor}`;
const api = `/api/${encodeURIComponent(docId)}`;
const message = document.querySelector('#message');
let composing = null, finishingComposition = false, heldDelete = false, socket, syncing = null, frozen = false, syncAgain = false;
const undo = [], redo = [], peers = new Map();
const metrics = { render: [], editing: [], writes: [], frames: 0, compositions: 0 };
const schema = new Schema({
  nodes: { doc: { content: 'body' }, body: { content: 'text*', code: true,
    toDOM: () => ['div', { class: 'diary-text' }, 0] }, text: { inline: true } },
  marks: { author: { attrs: { actor: {} }, toDOM: mark => ['span', { 'data-author': mark.attrs.actor }, 0] } }
});
function pmDoc() {
  const texts = []; let last = null;
  for (const atom of ranges(client.document()).atoms) {
    if (last?.actor === atom.actor) last.text += atom.text;
    else { last = { actor: atom.actor, text: atom.text }; texts.push(last); }
  }
  return schema.node('doc', null, [schema.node('body', null,
    texts.map(x => schema.text(x.text, [schema.mark('author', { actor: x.actor })]))) ]);
}
function selectionAnchors() {
  const doc = client.document(), { anchor: a, head } = view.state.selection;
  return { a: anchor(doc, a - 1), b: anchor(doc, head - 1) };
}
function decorations(state) {
  const entries = []; const doc = client.document();
  for (const [id, peer] of peers) {
    if (peer.actor === actor) continue;
    const at = Math.min(state.doc.content.size - 1, resolve(doc, peer.head) + 1);
    entries.push(Decoration.widget(Math.max(1, at), () => {
      const caret = document.createElement('span'); caret.className = 'peer-caret';
      caret.dataset.actor = peer.actor; caret.dataset.session = id; caret.textContent = `│${peer.actor}`;
      return caret;
    }, { key: id, side: -1 }));
    const from = resolve(doc, peer.anchor), to = resolve(doc, peer.head);
    if (from !== to) entries.push(Decoration.inline(Math.min(from, to) + 1, Math.max(from, to) + 1,
      { class: 'peer-selection' }));
  }
  return DecorationSet.create(state.doc, entries);
}
const view = new EditorView(document.querySelector('#editor'), {
  state: EditorState.create({ schema, doc: pmDoc(), plugins: [keymap({
    'Mod-z': () => { history(false); return true; }, 'Mod-Shift-z': () => { history(true); return true; },
    'Mod-y': () => { history(true); return true; },
    Enter: () => { edit(view.state.selection.from - 1, view.state.selection.to - 1, '\n'); return true; }
  })] }),
  decorations,
  dispatchTransaction(tr) {
    if (!tr.docChanged || composing || finishingComposition) {
      view.updateState(view.state.apply(tr)); if (!composing) sendPosition(); return;
    }
    if (tr.steps.length !== 1 || tr.steps[0].from === undefined || !tr.steps[0].slice) {
      warn('Unsupported experimental transaction'); render(); return;
    }
    const step = tr.steps[0];
    edit(step.from - 1, step.to - 1, step.slice.content.textBetween(0, step.slice.content.size));
  },
  handleDOMEvents: {
    keydown(_view, event) {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
      if (composing) return false;
      event.preventDefault();
      if (!(event.repeat && heldDelete)) erase(event.key === 'Backspace' ? -1 : 1);
      return true;
    },
    keyup(_view, event) { if (['Backspace', 'Delete'].includes(event.key)) heldDelete = false; return false; },
    beforeinput(_view, event) {
      if (composing || event.isComposing) return false;
      if (['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) {
        event.preventDefault(); erase(event.inputType === 'deleteContentBackward' ? -1 : 1); return true;
      }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault(); edit(view.state.selection.from - 1, view.state.selection.to - 1, '\n'); return true;
      }
      return false;
    },
    paste(_view, event) {
      event.preventDefault(); edit(view.state.selection.from - 1, view.state.selection.to - 1,
        event.clipboardData.getData('text/plain')); return true;
    },
    cut(_view, event) {
      event.preventDefault(); const { from, to } = view.state.selection;
      try {
        replacement(client.document(), actor, from - 1, to - 1, '');
        event.clipboardData.setData('text/plain', client.text.slice(from - 1, to - 1)); edit(from - 1, to - 1, '');
      } catch (error) { warn(error.code); }
      return true;
    },
    copy(_view, event) {
      event.preventDefault(); const { from, to } = view.state.selection;
      event.clipboardData.setData('text/plain', client.text.slice(from - 1, to - 1)); return true;
    },
    drop(_view, event) { event.preventDefault(); return true; },
    compositionstart() {
      composing = { text: client.text, from: view.state.selection.from - 1, to: view.state.selection.to - 1,
        document: client.document() };
      metrics.compositions++; return false;
    },
    compositionend() {
      const original = composing; composing = null; finishingComposition = true;
      setTimeout(() => {
        finishingComposition = false;
        if (!original) return;
        const actual = view.state.doc.textContent;
        const suffix = original.text.slice(original.to), prefix = original.text.slice(0, original.from);
        if (!actual.startsWith(prefix) || !actual.endsWith(suffix)) {
          warn('COMPOSITION_RANGE_CHANGED'); render(); return;
        }
        const inserted = actual.slice(prefix.length, actual.length - suffix.length);
        edit(original.from, original.to, inserted, original.document);
      }, 0);
      return false;
    }
  }
});
function warn(text) { message.textContent = text; }
function setSelection(from, to = from) {
  const max = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,
    Math.max(1, Math.min(max, from + 1)), Math.max(1, Math.min(max, to + 1)))));
  view.focus();
}
function render(saved = null) {
  if (composing || finishingComposition) return;
  const started = performance.now(), scrollY = window.scrollY;
  saved ??= selectionAnchors();
  const document = client.document(), doc = pmDoc();
  const from = resolve(document, saved.a) + 1, to = resolve(document, saved.b) + 1;
  view.updateState(EditorState.create({ schema, doc, plugins: view.state.plugins,
    selection: TextSelection.create(doc, from, to) }));
  window.scrollTo(0, scrollY); updateStatus();
  metrics.render.push(performance.now() - started);
}
function updateStatus() {
  document.querySelector('#status').textContent = client.status;
  document.querySelector('#pending').textContent = client.pending.length;
}
function edit(from, to, text, baseline = null) {
  const started = performance.now();
  try {
    const doc = baseline ?? client.document();
    const operation = replacement(doc, actor, from, to, text.replace(/\r\n?/g, '\n'));
    if (!operation.text && !operation.deleteIds.length) { render(); return; }
    const oldRight = anchor(doc, to).right;
    // enqueue mutates the optimistic document synchronously, then awaits IndexedDB commit.
    const priorPending = client.pending.length;
    const writing = client.replace(operation.after, operation.text, operation.deleteIds);
    if (client.pending.length === priorPending) {
      writing.catch(error => { warn(error.code ?? error.message); updateStatus(); }); render(); return;
    }
    const op = client.pending.at(-1);
    const inserted = [...op.text];
    const caret = { left: inserted.length ? `${op.id}/${inserted.length - 1}` : operation.after, right: oldRight, bias: 'left' };
    undo.push(op.id); redo.length = 0; metrics.writes.push({ text: op.text, at: Date.now() });
    render({ a: caret, b: caret }); sendPosition();
    writing.then(() => { updateStatus(); flush(); }).catch(error => { warn(error.message); updateStatus(); });
    metrics.editing.push(performance.now() - started);
  } catch (error) { warn(error.code ?? error.message); render(); }
}
function erase(direction) {
  const { from, to } = view.state.selection;
  if (from !== to) { edit(from - 1, to - 1, ''); return; }
  const action = deletion(client.document(), actor, from - 1, direction);
  if (action.jump) { heldDelete = true; setSelection(action.caret); }
  else edit(action.from, action.to, '');
}
async function history(isRedo) {
  const source = isRedo ? redo : undo, target = isRedo ? undo : redo;
  if (!source.length) return;
  const opId = source.pop(), saved = selectionAnchors();
  const writing = client.toggle(opId, isRedo); target.push(opId); render(saved);
  try { await writing; await flush(); } catch (error) { warn(error.message); }
}
const transport = {
  async call(path, method, body) {
    const response = await fetch(`${api}/${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status < 500) throw new Rejection(result.error);
      throw new Error(result.error);
    }
    return result;
  },
  read: () => transport.call('records', 'GET'),
  submit: (_actor, op) => transport.call('operations', 'POST', op),
  submitBatch: (_actor, operations) => transport.call('batch', 'POST', { operations })
};
async function flush() {
  if (frozen || !navigator.onLine) return;
  if (syncing) { syncAgain = true; return syncing; }
  const run = async () => {
    try { await client.sync(transport); sendPosition(); }
    catch (error) { warn(error.message); updateStatus(); }
  };
  syncing = run().finally(() => { syncing = null; if (syncAgain) { syncAgain = false; queueMicrotask(flush); } });
  return syncing;
}
function sendPosition() {
  if (composing || finishingComposition || socket?.readyState !== WebSocket.OPEN) return;
  const position = selectionAnchors();
  socket.send(JSON.stringify({ type: 'presence', session, anchor: position.a, head: position.b }));
}
function connect() {
  if (frozen || !navigator.onLine) return;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  socket = new WebSocket(`${location.origin.replace('http', 'ws')}/live?doc=${encodeURIComponent(docId)}&token=${token}&session=${session}`);
  socket.onopen = () => { sendPosition(); flush(); };
  socket.onmessage = async event => {
    const data = JSON.parse(event.data);
    if (data.type === 'changed') await flush();
    if (data.type === 'presence') { peers.set(data.session, data); if (!composing) render(); }
    if (data.type === 'leave') { peers.delete(data.session); if (!composing) render(); }
  };
  socket.onclose = () => { peers.clear(); render(); if (!frozen) setTimeout(connect, 250); };
}
journal.channel.onmessage = async () => {
  try {
    const incoming = await journal.read();
    const saved = selectionAnchors();
    const merged = mergeJournals({ actor, committed: client.committed, pending: client.pending, recovery: client.recovery }, incoming);
    new Document([...merged.committed, ...merged.pending.map((op, i) => ({ actor, op, seq: merged.committed.length + i + 1 }))]);
    client.committed = merged.committed; client.pending = merged.pending; client.recovery = merged.recovery;
    render(saved); flush();
  } catch (error) { warn(error.code ?? error.message); }
};
window.addEventListener('online', () => { connect(); flush(); });
window.addEventListener('offline', () => { socket?.close(); updateStatus(); });
setInterval(() => { if (client.pending.length) flush(); }, 500);
const originalReceive = client.receive.bind(client);
client.receive = records => {
  const saved = selectionAnchors();
  const receiving = originalReceive(records);
  render(saved); return receiving;
};
render(); connect();
// Explicit diagnostic surface for reproducible tests; no production UI is shipped here.
window.probe = {
  client, view, journal, metrics, flush, setSelection, edit, history,
  state: () => ({ text: client.text, display: view.state.doc.textContent, pending: client.pending.length,
    status: client.status, selection: [view.state.selection.anchor - 1, view.state.selection.head - 1],
    composing: Boolean(composing), error: message.textContent, peers: [...peers.values()] }),
  freeze: value => { frozen = value; if (value) socket?.close(); else { connect(); flush(); } },
  persist: () => client.persistQueue,
  resolvedPeers: () => [...peers.values()].map(x => ({ actor: x.actor, at: resolve(client.document(), x.head) })),
  receiveOld: async records => { const saved = selectionAnchors(); await client.receive(records); render(saved); },
  records: () => structuredClone(client.committed)
};
window.probeReady = true;
