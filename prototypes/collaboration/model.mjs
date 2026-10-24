// Experimental stable-ID sequence. Not a production editor or a vetted CRDT.
export const ROOT = '^';
const EMPTY_DELETIONS = Object.freeze([]);
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
export const graphemes = text => Array.from(segmenter.segment(text), x => x.segment);
export const copy = value => structuredClone(value);
export class Rejection extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = code => { throw new Rejection(code); };
const exactKeys = (object, keys) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)
    || Object.keys(object).sort().join('|') !== [...keys].sort().join('|')) reject('INVALID_SHAPE');
};
const idPattern = /^[a-zA-Z0-9-]{1,100}$/;
export function shape(op) {
  if (!op || typeof op.id !== 'string' || !idPattern.test(op.id)) reject('INVALID_ID');
  if (op.kind === 'edit') {
    exactKeys(op, ['id', 'kind', 'clock', 'after', 'text', 'deleteIds']);
    if (!Number.isSafeInteger(op.clock) || op.clock < 1 || op.clock > 1e12) reject('INVALID_CLOCK');
    if (typeof op.after !== 'string' || typeof op.text !== 'string'
      || !op.text.isWellFormed() || op.text.length > 4096 || op.text.includes('\r')) reject('INVALID_TEXT');
    if (!Array.isArray(op.deleteIds) || op.deleteIds.length > 4096
      || op.deleteIds.some(x => typeof x !== 'string')
      || new Set(op.deleteIds).size !== op.deleteIds.length) reject('INVALID_TARGETS');
    if (!op.text && !op.deleteIds.length) reject('EMPTY_EDIT');
  } else if (op.kind === 'toggle') {
    exactKeys(op, ['id', 'kind', 'target', 'active']);
    if (typeof op.target !== 'string' || typeof op.active !== 'boolean') reject('INVALID_TOGGLE');
  } else reject('INVALID_KIND');
}
// Identity comparisons deliberately ignore transport seq but not authenticated actor.
export function same(a, b) {
  const ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
export class Document {
  constructor(records = []) {
    this.records = new Map(); this.atoms = new Map(); this.children = new Map([[ROOT, []]]);
    this.active = new Map(); this.clock = 0;
    // seq-order is authoritative for undo/redo; local pending records use later seqs.
    const remaining = [...records].sort((a, b) => a.seq - b.seq);
    while (remaining.length) {
      let progress = false;
      for (let i = 0; i < remaining.length;) {
        const record = remaining[i];
        if (this.dependenciesExist(record.op)) {
          this.apply(record); remaining.splice(i, 1); progress = true;
        } else i++;
      }
      if (!progress) reject('DEPENDENCY_MISSING');
    }
  }
  dependenciesExist(op) {
    if (op.kind === 'toggle') return this.records.has(op.target);
    return (op.after === ROOT || this.atoms.has(op.after))
      && op.deleteIds.every(id => this.atoms.has(id));
  }
  validate(actor, op) {
    shape(op);
    if (!this.dependenciesExist(op)) reject('DEPENDENCY_MISSING');
    if (this.records.has(op.id)) reject('OPERATION_ID_COLLISION');
    if (op.kind === 'toggle') {
      const target = this.records.get(op.target);
      if (target.actor !== actor) reject('FOREIGN_TEXT');
      if (target.op.kind !== 'edit') reject('INVALID_TOGGLE_TARGET');
    } else {
      // A client cannot jump the shared logical clock to its maximum and prevent future edits.
      // Offline chains are submitted in causal order, so legitimate edits advance by at most one.
      if (op.clock > this.clock + 1) reject('CLOCK_AHEAD');
      if (op.deleteIds.some(id => this.atoms.get(id).actor !== actor)) reject('FOREIGN_TEXT');
      if (op.after !== ROOT && op.clock <= this.atoms.get(op.after).clock) reject('INVALID_CLOCK');
    }
  }
  apply(record) {
    const { actor, op } = record;
    this.validate(actor, op);
    this.records.set(op.id, copy(record));
    if (op.kind === 'toggle') { this.active.set(op.target, op.active); return; }
    this.clock = Math.max(this.clock, op.clock); this.active.set(op.id, true);
    let parent = op.after;
    // Stable scalar IDs; editor boundaries are computed over the full visible text.
    // Per-insertion graphemes are insufficient when combining marks arrive in a later operation.
    for (const [index, text] of [...op.text].entries()) {
      const id = `${op.id}/${index}`;
      const atom = { id, parent, text, actor, insertion: op.id, clock: op.clock, deletions: [] };
      this.atoms.set(id, atom); this.children.set(id, []);
      const siblings = this.children.get(parent);
      siblings.push(id);
      if (siblings.length > 1) siblings.sort((a, b) => {
        const x = this.atoms.get(a), y = this.atoms.get(b);
        return y.clock - x.clock || (a < b ? -1 : a > b ? 1 : 0);
      });
      parent = id;
    }
    for (const id of op.deleteIds) this.atoms.get(id).deletions.push(op.id);
  }
  visible() {
    const output = [];
    const stack = [...this.children.get(ROOT)].reverse();
    while (stack.length) {
      const atom = this.atoms.get(stack.pop());
      if (this.active.get(atom.insertion)
        && !atom.deletions.some(id => this.active.get(id)))
        output.push({ ...atom, deletions: atom.deletions.length ? [...atom.deletions] : EMPTY_DELETIONS });
      const children = this.children.get(atom.id);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return output;
  }
  text(actor) { return this.visible().filter(x => !actor || x.actor === actor).map(x => x.text).join(''); }
}
