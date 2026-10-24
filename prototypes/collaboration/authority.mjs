import { Document, Rejection, copy, same, shape } from './model.mjs';

// No actor, seq, author style or binary document update is accepted from the wire.
export function accept(state, actor, op) {
  const result = acceptBatch(state, actor, [op]);
  return { state: result.state, record: result.records[0], duplicate: result.added.length === 0 };
}
export function acceptBatch(state, actor, operations) {
  if (!state.members.includes(actor)) throw new Rejection('FORBIDDEN');
  if (!Array.isArray(operations) || !operations.length || operations.length > 64)
    throw new Rejection('INVALID_BATCH');
  // Validate in one isolated candidate document. No state is published before the whole batch passes.
  const document = new Document(state.records), records = [], added = [];
  for (const op of operations) {
    shape(op);
    const old = document.records.get(op.id);
    if (old) {
      if (old.actor !== actor || !same(old.op, op)) throw new Rejection('OPERATION_ID_COLLISION');
      records.push(copy(old)); continue;
    }
    const record = { actor, op: copy(op), seq: state.records.length + added.length + 1 };
    document.apply(record); records.push(record); added.push(record);
  }
  return { state: { ...state, records: [...state.records, ...added] }, records, added };
}
export class MemoryAuthority {
  constructor(members = ['A', 'B'], disk = { records: [], members }) { this.disk = disk; }
  async submit(actor, op) {
    return (await this.submitBatch(actor, [op]))[0];
  }
  async submitBatch(actor, operations) {
    const result = acceptBatch(this.disk, actor, operations);
    if (this.failBeforeCommit) throw new Error('DATABASE_UNAVAILABLE');
    this.disk.records = copy(result.state.records);
    if (this.dropAck) throw new Error('ACK_LOST');
    return copy(result.records);
  }
  async read(actor) {
    if (!this.disk.members.includes(actor)) throw new Rejection('FORBIDDEN');
    return copy(this.disk.records);
  }
}
