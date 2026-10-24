import * as Y from 'yjs';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';

// Two schemas: one paragraph per line (y-prosemirror default shape), or one paragraph
// with hard_break nodes for newlines.
export const paragraphs = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
});
export const breaks = new Schema({
  nodes: {
    doc: { content: 'paragraph' }, paragraph: { content: 'inline*' }, text: { group: 'inline' },
    hard_break: { group: 'inline', inline: true },
  },
});

// A client runs the real y-prosemirror diff (updateYFragment) that ySyncPlugin uses
// to turn each ProseMirror transaction into Yjs operations.
export class Client {
  constructor(userId, schema, authority) {
    this.userId = userId; this.schema = schema; this.authority = authority;
    this.doc = new Y.Doc({ gc: false });
    this.frag = this.doc.getXmlFragment('prosemirror');
    authority.register(userId, this.doc.clientID);
    this.outbox = [];
    this.doc.on('update', (update, origin) => { if (origin !== 'remote') this.outbox.push(update); });
  }
  pm() {
    return this.frag.length ? yXmlFragmentToProseMirrorRootNode(this.frag, this.schema)
      : this.schema.topNodeType.createAndFill();
  }
  edit(change) {
    const tr = EditorState.create({ doc: this.pm() }).tr;
    change(tr, this.schema);
    this.doc.transact(() => updateYFragment(this.doc, this.frag, tr.doc, { mapping: new Map(), isOMark: new Map() }));
  }
  // Send pending updates; returns rejection codes (empty when all accepted).
  flush() {
    const rejected = [];
    for (const update of this.outbox.splice(0)) {
      try { this.authority.accept(this.userId, update); } catch (e) { rejected.push(e.code ?? e.message); }
    }
    return rejected;
  }
  pull() { Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.authority.doc, Y.encodeStateVector(this.doc)), 'remote'); }
}

// Visible text runs with the user who created each character (from Yjs item IDs).
export function runs(doc, owner) {
  const out = [];
  const push = (user, text) => {
    const last = out.at(-1);
    if (last && last[0] === user) last[1] += text; else out.push([user, text]);
  };
  const walk = type => {
    if (type instanceof Y.XmlText) {
      for (let n = type._start; n; n = n.right)
        if (!n.deleted && n.content.str) push(owner.get(n.id.client), n.content.str);
      return;
    }
    type.toArray().forEach((child, i) => {
      if (child instanceof Y.XmlElement && child.nodeName === 'paragraph' && (i > 0)) push(owner.get(child._item.id.client), '¶');
      if (child instanceof Y.XmlElement && child.nodeName === 'hard_break') push(owner.get(child._item.id.client), '↵');
      else walk(child);
    });
  };
  walk(doc.getXmlFragment('prosemirror'));
  return out;
}
