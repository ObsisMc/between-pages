import { copy, same, Rejection } from '../model.mjs';
const union = (left, right, key, conflict = true) => {
  const entries = new Map(left.map(x => [key(x), x]));
  for (const value of right) {
    const id = key(value);
    if (conflict && entries.has(id) && !same(entries.get(id), value)) throw new Rejection('JOURNAL_CONFLICT');
    entries.set(id, value);
  }
  return [...entries.values()];
};
export function mergeJournals(a, b) {
  if (!a) return copy(b);
  if (a.actor !== b.actor) throw new Rejection('JOURNAL_ACCOUNT_MISMATCH');
  const committed = union(a.committed, b.committed, x => x.op.id).sort((x, y) => x.seq - y.seq);
  const recovery = union(a.recovery, b.recovery, x => x.id);
  const retired = new Set([...committed.map(x => x.op.id), ...recovery.flatMap(x => x.operations.map(op => op.id))]);
  const pending = union(a.pending, b.pending, x => x.id).filter(x => !retired.has(x.id));
  return { actor: b.actor, committed, pending, recovery };
}
export class IndexedJournal {
  constructor(database, key) {
    this.database = database; this.key = key;
    this.channel = new BroadcastChannel(`between-pages-probe:${key}`);
  }
  static async open(key) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('between-pages-validation-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('journals');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    database.onversionchange = () => database.close();
    return new IndexedJournal(database, key);
  }
  async read() {
    return new Promise((resolve, reject) => {
      const request = this.database.transaction('journals').objectStore('journals').get(this.key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  async write(value) {
    if (this.fail) throw new Error('INJECTED_INDEXEDDB_FAILURE');
    await new Promise((resolve, reject) => {
      const transaction = this.database.transaction('journals', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('journals');
      const request = store.get(this.key);
      let error;
      request.onsuccess = () => {
        try { store.put(mergeJournals(request.result, value), this.key); }
        catch (cause) { error = cause; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(error ?? transaction.error ?? new Error('INDEXEDDB_ABORTED'));
      transaction.onerror = () => {}; // onabort is the final outcome, not request success.
    });
    this.channel.postMessage('changed');
  }
  close() { this.channel.close(); this.database.close(); }
}
