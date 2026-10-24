import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../client.mjs';
import { MemoryAuthority } from '../authority.mjs';
import { ROOT } from '../model.mjs';
import { ranges, deletion, replacement, anchor, resolve } from '../browser/policy.mjs';
import { mergeJournals } from '../browser/journal.mjs';
const snapshot = actor => ({ actor, committed: [], pending: [], recovery: [] });
test('cross-operation accents and flag pairs group over the entire text', async () => {
  const a = await Client.open('A'); await a.insert(ROOT, 'e');
  await a.insert(a.document().visible().at(-1).id, '\u0301');
  assert.equal(ranges(a.document()).groups.length, 1);
  assert.deepEqual(deletion(a.document(), 'A', 2, -1), { from: 0, to: 2, jump: false });
});
test('mixed-author grapheme cannot be partially deleted or replaced', async () => {
  const server = new MemoryAuthority(), a = await Client.open('A'), b = await Client.open('B');
  await a.insert(ROOT, 'e'); await a.sync(server); await b.sync(server);
  await b.insert(b.document().visible()[0].id, '\u0301'); await b.sync(server); await a.sync(server);
  assert.deepEqual(deletion(a.document(), 'A', 2, -1), { caret: 0, jump: true });
  assert.throws(() => replacement(a.document(), 'A', 0, 2, ''), e => e.code === 'FOREIGN_TEXT');
  assert.throws(() => replacement(a.document(), 'B', 1, 2, ''), e => e.code === 'GRAPHEME_BOUNDARY');
});
test('boundary insertion and foreign-only forward/backward jumps never erase', async () => {
  const a = await Client.open('A'); await a.insert(ROOT, '对方');
  assert.deepEqual(deletion(a.document(), 'B', 2, -1), { caret: 0, jump: true });
  assert.deepEqual(deletion(a.document(), 'B', 0, 1), { caret: 2, jump: true });
  assert.equal(replacement(a.document(), 'B', 1, 1, '插入').deleteIds.length, 0);
});
test('relative cursor follows text after front insert and has deterministic deletion fallback', async () => {
  const a = await Client.open('A'); await a.insert(ROOT, '甲乙'); const old = anchor(a.document(), 1);
  await a.insert(ROOT, '前'); assert.equal(resolve(a.document(), old), 2);
  await a.remove(a.document().visible().filter(x => ['甲', '乙'].includes(x.text)).map(x => x.id));
  assert.equal(resolve(a.document(), old), 0); // tombstone ancestry fallback, no invalid UTF16 index
});
test('transactional journal union retains distinct tab pending operations', () => {
  const a = snapshot('A'), b = snapshot('A');
  a.pending = [{ id: 'one' }]; b.pending = [{ id: 'two' }];
  assert.deepEqual(mergeJournals(a, b).pending, [{ id: 'one' }, { id: 'two' }]);
});
test('late stale local snapshot cannot resurrect a committed or rejected operation', () => {
  const old = snapshot('A'); old.pending = [{ id: 'one' }, { id: 'two' }];
  const current = snapshot('A'); current.committed = [{ actor: 'A', seq: 1, op: { id: 'one' } }];
  current.recovery = [{ id: 'draft', operations: [{ id: 'two' }] }];
  const result = mergeJournals(current, old); assert.deepEqual(result.pending, []); assert.equal(result.recovery.length, 1);
});
test('journal union rejects actor mismatch and same ID conflicting payload', () => {
  assert.throws(() => mergeJournals(snapshot('A'), snapshot('B')), e => e.code === 'JOURNAL_ACCOUNT_MISMATCH');
  const a = snapshot('A'), b = snapshot('A'); a.pending = [{ id: 'one', text: 'a' }]; b.pending = [{ id: 'one', text: 'b' }];
  assert.throws(() => mergeJournals(a, b), e => e.code === 'JOURNAL_CONFLICT');
});
test('cache invalidates when later input changes the document', async () => {
  const a = await Client.open('A'); await a.insert(ROOT, '甲');
  const old = ranges(a.document()); await a.insert(a.document().visible()[0].id, '乙');
  assert.equal(old.length, 1); assert.equal(ranges(a.document()).length, 2);
});
