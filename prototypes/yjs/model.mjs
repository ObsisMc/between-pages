import * as Y from 'yjs';
import { ROOT, Rejection, copy, same, shape } from '../collaboration/model.mjs';

export const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
export const decode = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const reject = code => { throw new Rejection(code); };

// Authority-generated Yjs sequence. Never apply a client-supplied Yjs update here.
// Stable application IDs remain in tombstones so offline intentions can still target them.
// No Yjs private structs/clientID-as-user identity or custom insertion tree is used.
export class Document {
  constructor(records = []) {
    this.ydoc = new Y.Doc();
    this.sequence = this.ydoc.getArray('characters');
    this.operations = this.ydoc.getMap('operations');
    this.flags = this.ydoc.getMap('active');
    this.refresh();
    for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
      if (record.update) {
        Y.applyUpdate(this.ydoc, decode(record.update));
        if (!same(this.operations.get(record.op.id), { actor: record.actor, op: record.op, seq: record.seq }))
          reject('INVALID_SERVER_UPDATE');
        this.refresh();
      } else this.apply(record); // Local speculative intentions; never uploaded as binary.
    }
  }
  refresh() {
    this.records = new Map(this.operations.entries());
    this.active = new Map(this.flags.entries());
    this.atoms = new Map(this.sequence.toArray().map(atom => [atom.id, atom]));
    this.clock = 0;
    for (const record of this.records.values()) this.clock = Math.max(this.clock, record.op.clock ?? 0);
  }
  validate(actor, op) {
    shape(op);
    if (this.records.has(op.id)) reject('OPERATION_ID_COLLISION');
    if (op.kind === 'toggle') {
      const target = this.records.get(op.target);
      if (!target) reject('DEPENDENCY_MISSING');
      if (target.actor !== actor) reject('FOREIGN_TEXT');
      if (target.op.kind !== 'edit') reject('INVALID_TOGGLE_TARGET');
      return;
    }
    if ((op.after !== ROOT && !this.atoms.has(op.after)) || op.deleteIds.some(id => !this.atoms.has(id)))
      reject('DEPENDENCY_MISSING');
    if (op.clock > this.clock + 1) reject('CLOCK_AHEAD');
    if (op.after !== ROOT && op.clock <= this.atoms.get(op.after).clock) reject('INVALID_CLOCK');
    if (op.deleteIds.some(id => this.atoms.get(id).actor !== actor)) reject('FOREIGN_TEXT');
  }
  apply(record) {
    const { actor, op, seq } = record;
    this.validate(actor, op);
    const before = Y.encodeStateVector(this.ydoc);
    this.ydoc.transact(() => {
      this.operations.set(op.id, copy({ actor, op, seq }));
      if (op.kind === 'toggle') { this.flags.set(op.target, op.active); return; }
      this.flags.set(op.id, true);
      const index = op.after === ROOT ? 0 : this.sequence.toArray().findIndex(atom => atom.id === op.after) + 1;
      let parent = op.after;
      const atoms = [...op.text].map((text, offset) => {
        const atom = { id: `${op.id}/${offset}`, parent, text, actor, insertion: op.id, clock: op.clock };
        parent = atom.id; return atom;
      });
      if (atoms.length) this.sequence.insert(index, atoms);
    }, 'authority');
    const result = { actor, op: copy(op), seq, update: encode(Y.encodeStateAsUpdate(this.ydoc, before)) };
    this.refresh(); return result;
  }
  visible() {
    const deleted = new Set();
    for (const { op } of this.records.values())
      if (op.kind === 'edit' && this.active.get(op.id)) for (const id of op.deleteIds) deleted.add(id);
    return this.sequence.toArray().filter(atom => this.active.get(atom.insertion) && !deleted.has(atom.id));
  }
  text(actor) { return this.visible().filter(atom => !actor || atom.actor === actor).map(atom => atom.text).join(''); }
}
