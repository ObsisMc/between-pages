import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { Client, MemoryJournal, Document } from './client.mjs';
import { MemoryAuthority } from './authority.mjs';
import { ROOT } from '../collaboration/model.mjs';
import { Rejection } from '../collaboration/model.mjs';
import { decode, encode } from './model.mjs';

async function fixture() {
  const server = new MemoryAuthority(), a = await Client.open('A'), b = await Client.open('B');
  await a.insert(ROOT, '甲乙'); await a.sync(server); await b.sync(server);
  return { server, a, b };
}
const edit = (after = ROOT, text = '攻击', deleteIds = []) => ({ kind: 'edit', id: randomUUID(), clock: 2, after, text, deleteIds });
test('Yjs authority updates materialize in an independent vanilla Y.Doc', async () => {
  const { server, a, b } = await fixture();
  await b.insert(a.document().visible()[0].id, '抱抱'); await b.sync(server); await a.sync(server);
  assert.equal(a.text, '甲抱抱乙');
  assert.equal(a.document().text('A'), '甲乙'); assert.equal(a.document().text('B'), '抱抱');
  const replica = new Y.Doc();
  const records = await server.read('A');
  // Reverse order and duplicates are valid for authoritative Yjs updates.
  for (const record of [...records].reverse()) Y.applyUpdate(replica, decode(record.update));
  for (const record of records) Y.applyUpdate(replica, decode(record.update));
  assert.equal(replica.getArray('characters').toArray().map(atom => atom.text).join(''), '甲抱抱乙');
  replica.destroy();
});
test('Unrestricted Yjs applyUpdate is not an author permission boundary', async () => {
  const { server } = await fixture(), records = await server.read('A');
  const victim = new Y.Doc(), attacker = new Y.Doc();
  Y.applyUpdate(victim, decode(records[0].update));
  Y.applyUpdate(attacker, Y.encodeStateAsUpdate(victim));
  attacker.getArray('characters').delete(0, 1);
  Y.applyUpdate(victim, Y.encodeStateAsUpdate(attacker));
  assert.equal(victim.getArray('characters').toArray().map(atom => atom.text).join(''), '乙');
  assert.equal(new Document(await server.read('A')).text(), '甲乙');
  victim.destroy(); attacker.destroy();
});
for (const attack of ['delete', 'replace', 'actor', 'authorId', 'update', 'clientID', 'foreign-undo', 'collision', 'unknown-root']) {
  test(`Yjs server rejects ${attack} without changing authoritative bytes`, async () => {
    const { server, a } = await fixture(); const prior = await server.read('A');
    const id = a.document().visible()[0].id;
    let op = edit();
    if (attack === 'delete') op = edit(ROOT, '', [id]);
    if (attack === 'replace') op = edit(ROOT, '替换', [id]);
    if (['actor', 'authorId', 'clientID'].includes(attack)) op[attack] = 'A';
    if (attack === 'update') {
      const malicious = new Y.Doc(); Y.applyUpdate(malicious, decode(prior[0].update));
      malicious.getArray('characters').delete(0, 1);
      op.update = encode(Y.encodeStateAsUpdate(malicious)); malicious.destroy();
    }
    if (attack === 'foreign-undo') op = { kind: 'toggle', id: randomUUID(), target: prior[0].op.id, active: false };
    if (attack === 'collision') op.id = prior[0].op.id;
    if (attack === 'unknown-root') op.after = 'fake/0';
    await assert.rejects(server.submit('B', op));
    assert.deepEqual(await server.read('A'), prior);
  });
}
test('Yjs batch validation is atomic; valid prefix is never published', async () => {
  const { server, a } = await fixture(), prior = await server.read('A');
  await assert.rejects(server.submitBatch('B', [edit(), edit(ROOT, '', [a.document().visible()[0].id])]));
  assert.deepEqual(await server.read('A'), prior);
});
test('Yjs own delete / undo / redo never removes partner inline reply', async () => {
  const { server, a, b } = await fixture(), original = a.committed[0].op.id;
  await b.insert(a.document().visible()[0].id, '猫'); await b.sync(server); await a.sync(server);
  await a.toggle(original, false); await a.sync(server); assert.equal(a.text, '猫');
  await a.toggle(original, true); await a.sync(server); assert.equal(a.text, '甲猫乙');
  const deletion = await a.remove(a.document().visible().filter(atom => atom.actor === 'A').map(atom => atom.id));
  await a.sync(server); assert.equal(a.text, '猫');
  await a.toggle(deletion.id, false); await a.sync(server); assert.equal(a.text, '甲猫乙');
});
test('Yjs offline continuation survives stale snapshots, local reopen and lost ACK', async () => {
  const { server, a, b } = await fixture(); const stale = await server.read('A');
  const first = await a.insert(a.document().visible().at(-1).id, '离线');
  await a.insert(`${first.id}/1`, '续写👩🏽‍💻');
  await b.insert(ROOT, '远端'); await b.sync(server);
  const expected = a.document().text('A');
  await a.receive(stale); assert.equal(a.document().text('A'), expected);
  const reopened = await Client.open('A', a.journal);
  assert.equal(reopened.document().text('A'), expected);
  server.dropAck = true; await assert.rejects(reopened.sync(server), /ACK_LOST/);
  assert.equal(reopened.document().text('A'), expected); assert.equal(reopened.pending.length, 2);
  server.dropAck = false;
  const restarted = new MemoryAuthority(undefined, server.disk);
  await reopened.sync(restarted); await b.sync(restarted);
  assert.equal(reopened.text, b.text); assert.equal(reopened.document().text('A'), expected);
  assert.equal(new Set(reopened.document().visible().map(atom => atom.id)).size, reopened.document().visible().length);
});
test('Yjs failed local persistence retains visible pending and surfaces failure', async () => {
  const journal = new MemoryJournal(), client = await Client.open('A', journal);
  journal.fail = true; await assert.rejects(client.insert(ROOT, '未写入磁盘'), /LOCAL_STORAGE_FULL/);
  assert.equal(client.text, '未写入磁盘'); assert.equal(client.status, 'local-save-failed');
  journal.fail = false; await client.persist();
  assert.equal((await Client.open('A', journal)).text, '未写入磁盘');
});
test('Yjs malformed queued metadata is rejected before replacing the local queue', async () => {
  const { server, b } = await fixture();
  const op = await b.insert(ROOT, '合法输入');
  await b.insert(`${op.id}/3`, '后续');
  const before = b.text;
  // Simulate a stale incompatible/malformed queued operation from a faulty client.
  b.pending[0].authorId = 'A';
  await assert.rejects(b.sync(server));
  // receive validates before changing pending; this malformed queue remains intact.
  assert.equal(b.pending.length, 2); assert.equal(b.recovery.length, 0);
  delete b.pending[0].authorId;
  assert.equal(b.text, before); await b.sync(server);
  assert.equal(b.document().text('B'), '合法输入后续');
});
test('Yjs server rejection preserves full draft and dependent operations in recovery journal', async () => {
  const { server, b } = await fixture();
  const first = await b.insert(ROOT, '离线'); await b.insert(`${first.id}/1`, '后续');
  const before = b.text;
  const rejecting = { read: actor => server.read(actor), submitBatch: async () => { throw new Rejection('PROTOCOL_UPGRADE_REQUIRED'); } };
  await assert.rejects(b.sync(rejecting), error => error.code === 'PROTOCOL_UPGRADE_REQUIRED');
  assert.equal(b.status, 'recovery-required'); assert.equal(b.recovery[0].text, before);
  assert.equal(b.recovery[0].operations.length, 2);
  const reopened = await Client.open('B', b.journal);
  assert.equal(reopened.recovery[0].text, before); assert.equal(reopened.status, 'recovery-required');
});
test('Yjs nonmembers cannot read or write', async () => {
  const { server } = await fixture();
  await assert.rejects(server.read('C'), error => error.code === 'FORBIDDEN');
  await assert.rejects(server.submit('C', edit()), error => error.code === 'FORBIDDEN');
});
test('Yjs sparse and old receipts never replace pending or regress committed state', async () => {
  const { server, a, b } = await fixture();
  await a.insert(ROOT, '第二次'); await a.sync(server);
  const late = a.committed.at(-1), oldBase = b.committed;
  await b.insert(ROOT, '待发');
  const fresh = await Client.open('B'); await fresh.insert(ROOT, '仍在');
  await assert.rejects(fresh.receive([late]), error => error.code === 'SERVER_RECORD_GAP');
  assert.equal(fresh.text, '仍在'); assert.equal(fresh.committed.length, 0);
  await b.receive(await server.read('B')); const expected = b.text;
  await b.receive(oldBase); assert.equal(b.text, expected);
  assert.equal(b.pending.length, 1); await b.sync(server);
  assert.equal(b.document().text('B'), '待发');
});
test('Yjs tombstone anchor survives own delete while offline peer reply arrives later', async () => {
  const { server, a, b } = await fixture(), target = a.document().visible()[0].id;
  await b.insert(target, '回复');
  await a.remove([target]); await a.sync(server);
  await b.sync(server); await a.sync(server);
  assert.equal(a.text, '回复乙'); assert.equal(b.text, a.text);
  assert.equal(a.document().text('B'), '回复');
});
test('Yjs mixed schedules preserve provenance, own undo and three-device convergence', async () => {
  let steps = 0;
  for (let seed = 1; seed <= 15; seed++) {
    let randomState = seed;
    const random = n => { randomState = (Math.imul(randomState, 1103515245) + 12345) >>> 0; return randomState % n; };
    const server = new MemoryAuthority();
    const clients = [await Client.open('A'), await Client.open('B'), await Client.open('A')];
    const authored = new Map();
    for (let turn = 0; turn < 35; turn++) {
      const device = random(clients.length), client = clients[device], doc = client.document();
      const own = doc.visible().filter(atom => atom.actor === client.actor);
      const edits = [...doc.records.values()].filter(record => record.actor === client.actor && record.op.kind === 'edit');
      if (turn % 5 === 0 && own.length) await client.remove([own[random(own.length)].id]);
      else if (turn % 7 === 0 && edits.length) {
        const target = edits[random(edits.length)].op.id;
        await client.toggle(target, !doc.active.get(target));
      } else {
        const atoms = doc.visible(), after = atoms.length ? atoms[random(atoms.length)].id : ROOT;
        const op = await client.insert(after, `文${turn}`);
        [...op.text].forEach((text, i) => authored.set(`${op.id}/${i}`, { actor: client.actor, text, insertion: op.id }));
      }
      if (turn % 3 === 0) {
        server.dropAck = turn % 9 === 0;
        try { await client.sync(server); } catch (error) { assert.match(error.message, /ACK_LOST/); }
        server.dropAck = false;
      }
      if (turn % 4 === 0) clients[device] = await Client.open(client.actor, client.journal);
      steps++;
    }
    for (const client of clients) await client.sync(server);
    for (const client of clients) await client.sync(server);
    assert.ok(clients.every(client => client.text === clients[0].text));
    const records = await server.read('A'), active = new Map(), deleted = new Set();
    for (const { op } of records) {
      if (op.kind === 'edit') active.set(op.id, true);
      else active.set(op.target, op.active);
    }
    for (const { op } of records) if (op.kind === 'edit' && active.get(op.id))
      for (const id of op.deleteIds) deleted.add(id);
    const expected = new Map([...authored].filter(([id, atom]) => active.get(atom.insertion) && !deleted.has(id)));
    const actual = new Map(clients[0].document().visible().map(atom => [atom.id, { actor: atom.actor, text: atom.text, insertion: atom.insertion }]));
    assert.deepEqual(actual, expected);
  }
  console.log(`YJS_MIXED_SCHEDULES seeds=15 steps=${steps} devices=3`);
});
test('Yjs deterministic network schedules retain every accepted authored insertion', async () => {
  let steps = 0;
  for (let seed = 1; seed <= 30; seed++) {
    let value = seed;
    const random = n => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % n; };
    const server = new MemoryAuthority(); let a = await Client.open('A'), b = await Client.open('B');
    const expected = new Map(); let stale = [];
    for (let i = 0; i < 40; i++) {
      let client = random(2) ? a : b;
      const visible = client.document().visible(), after = visible.length ? visible[random(visible.length)].id : ROOT;
      const op = await client.insert(after, `${client.actor}${i}猫`);
      for (const [offset, text] of [...op.text].entries()) expected.set(`${op.id}/${offset}`, [client.actor, text]);
      if (random(3) === 0) await client.receive(stale);
      if (random(3) === 0) await client.sync(server);
      if (random(4) === 0) stale = await server.read('A');
      if (random(5) === 0) {
        if (client.actor === 'A') a = await Client.open('A', a.journal);
        else b = await Client.open('B', b.journal);
      }
      steps++;
    }
    await a.sync(server); await b.sync(server); await a.sync(server);
    assert.equal(a.text, b.text);
    assert.deepEqual(new Map(a.document().visible().map(atom => [atom.id, [atom.actor, atom.text]])), expected);
    assert.equal(a.pending.length + b.pending.length, 0);
    assert.equal(new Document(await server.read('A')).text(), a.text);
  }
  console.log(`YJS_RANDOM_SCHEDULES seeds=30 insertion_steps=${steps}`);
});
