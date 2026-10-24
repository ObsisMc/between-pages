import { Document } from './model.mjs';
import { Rejection, copy, same } from '../collaboration/model.mjs';

export function acceptBatch(state, actor, operations) {
  if (!state.members.includes(actor)) throw new Rejection('FORBIDDEN');
  if (!Array.isArray(operations) || !operations.length || operations.length > 64) throw new Rejection('INVALID_BATCH');
  const document = new Document(state.records), records = [], added = [];
  try {
    for (const op of operations) {
      const old = state.records.find(record => record.op.id === op?.id) ?? added.find(record => record.op.id === op?.id);
      if (old) {
        if (old.actor !== actor || !same(old.op, op)) throw new Rejection('OPERATION_ID_COLLISION');
        records.push(copy(old)); continue;
      }
      const record = document.apply({ actor, op: copy(op), seq: state.records.length + added.length + 1 });
      records.push(record); added.push(record);
    }
    return { records, added, state: { ...state, records: [...state.records, ...added] } };
  } finally { document.ydoc.destroy(); }
}
export class MemoryAuthority {
  constructor(members = ['A', 'B'], disk = { members, records: [] }) { this.disk = disk; }
  async create() {}
  async read(actor) {
    if (!this.disk.members.includes(actor)) throw new Rejection('FORBIDDEN');
    return copy(this.disk.records);
  }
  async submit(actor, op) { return (await this.submitBatch(actor, [op]))[0]; }
  async submitBatch(actor, operations) {
    const result = acceptBatch(this.disk, actor, operations);
    if (this.failBeforeCommit) throw new Error('DATABASE_UNAVAILABLE');
    this.disk.records = copy(result.state.records);
    await this.afterCommit?.();
    if (this.dropAck) throw new Error('ACK_LOST');
    return copy(result.records);
  }
}
