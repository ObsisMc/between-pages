import { Document, Rejection, ROOT, copy, same } from './model.mjs';
const randomUUID = () => globalThis.crypto.randomUUID();

export class MemoryJournal {
  constructor() { this.saved = null; }
  async read() { return copy(this.saved); }
  async write(value) { if (this.fail) throw new Error('LOCAL_STORAGE_FULL'); this.saved = copy(value); }
}
// Platform-independent client; browser bindings and IndexedDB live in browser/.
export class Client {
  constructor(actor, journal, saved) {
    this.actor = actor; this.journal = journal;
    this.committed = saved?.committed ?? []; this.pending = saved?.pending ?? [];
    this.recovery = saved?.recovery ?? []; this.localError = null;
    this.persistQueue = Promise.resolve();
  }
  static async open(actor, journal = new MemoryJournal()) {
    const saved = await journal.read();
    if (saved && saved.actor !== actor) throw new Rejection('JOURNAL_ACCOUNT_MISMATCH');
    return new Client(actor, journal, saved);
  }
  async persist() {
    const snapshot = copy({ actor: this.actor, committed: this.committed, pending: this.pending, recovery: this.recovery });
    const write = this.persistQueue.catch(() => {}).then(() => this.journal.write(snapshot));
    this.persistQueue = write;
    try { await write; this.localError = null; }
    catch (error) { this.localError = error.message; throw error; }
  }
  document() {
    const base = this.committed.length ? Math.max(...this.committed.map(x => x.seq)) : 0;
    const signature = this.signature();
    if (this.cachedSignature === signature) return this.cachedDocument;
    this.cachedDocument = new Document([...this.committed,
      ...this.pending.map((op, i) => ({ actor: this.actor, op, seq: base + i + 1 }))]);
    this.cachedSignature = signature;
    return this.cachedDocument;
  }
  signature() {
    return [...this.committed.map(x => x.op.id), ...this.pending.map(x => x.id)].join('|');
  }
  get text() { return this.document().text(); }
  get status() {
    return this.localError ? 'local-save-failed' : this.recovery.length ? 'recovery-required'
      : this.pending.length ? 'waiting-for-server' : 'server-saved';
  }
  async enqueue(op) {
    const document = this.document();
    document.apply({ actor: this.actor, op, seq: this.committed.length + this.pending.length + 1 });
    this.pending.push(copy(op)); this.cachedSignature = this.signature();
    await this.persist(); return copy(op);
  }
  async insert(after = ROOT, text) {
    return this.enqueue({ kind: 'edit', id: randomUUID(), clock: this.document().clock + 1,
      after, text: text.replace(/\r\n?/g, '\n'), deleteIds: [] });
  }
  async remove(ids) {
    return this.enqueue({ kind: 'edit', id: randomUUID(), clock: this.document().clock + 1,
      after: ROOT, text: '', deleteIds: [...ids] });
  }
  async replace(after, text, deleteIds) {
    return this.enqueue({ kind: 'edit', id: randomUUID(), clock: this.document().clock + 1,
      after, text: text.replace(/\r\n?/g, '\n'), deleteIds: [...deleteIds] });
  }
  async toggle(target, active) { return this.enqueue({ kind: 'toggle', id: randomUUID(), target, active }); }
  async receive(records) {
    // Full/sparse/out-of-order transport snapshots are merged, never assigned over pending edits.
    const byId = new Map(this.committed.map(x => [x.op.id, x]));
    for (const record of records) {
      const old = byId.get(record.op.id);
      if (old && !same(old, record)) throw new Rejection('CONFLICTING_SERVER_RECORD');
      const pending = this.pending.find(x => x.id === record.op.id);
      if (pending && (record.actor !== this.actor || !same(pending, record.op)))
        throw new Rejection('CONFLICTING_SERVER_RECORD');
      byId.set(record.op.id, copy(record));
    }
    const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
    // Only promote contiguous authoritative records. A late gap never erases the local overlay.
    let count = 0;
    while (count < merged.length && merged[count].seq === count + 1) count++;
    if (count !== merged.length) {
      // Caller must retry/pull a complete journal; do not persist an incomplete base.
      throw new Rejection('SERVER_RECORD_GAP');
    }
    const pending = this.pending.filter(x => !byId.has(x.id));
    // Validation happens before mutation. Own pending ops may anchor to tombstones.
    new Document([...merged, ...pending.map((op, i) => ({ actor: this.actor, op, seq: merged.length + i + 1 }))]);
    this.committed = merged; this.pending = pending; await this.persist();
  }
  async sync(authority) {
    await this.receive(await authority.read(this.actor));
    if (authority.submitBatch) {
      while (this.pending.length) {
        try { await authority.submitBatch(this.actor, copy(this.pending.slice(0, 64))); }
        catch (error) { await this.handleRejection(error); throw error; }
        await this.receive(await authority.read(this.actor));
      }
      return;
    }
    for (const op of [...this.pending]) {
      try { await authority.submit(this.actor, op); }
      catch (error) {
        await this.handleRejection(error); throw error;
      }
      // A successful submit alone does not drop the local operation; pull committed proof.
      await this.receive(await authority.read(this.actor));
    }
  }
  async handleRejection(error) {
    if (!(error instanceof Rejection)) return;
    this.recovery.push({ id: randomUUID(), reason: error.code, text: this.text, operations: copy(this.pending) });
    this.pending = []; await this.persist();
  }
}
