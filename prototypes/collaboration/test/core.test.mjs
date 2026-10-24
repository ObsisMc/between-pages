import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, MemoryJournal } from '../client.mjs';
import { FileJournal } from '../file-journal.mjs';
import { MemoryAuthority } from '../authority.mjs';
import { Document, ROOT, copy } from '../model.mjs';

async function fixture() {
  const server = new MemoryAuthority();
  const a = await Client.open('A'), b = await Client.open('B');
  await a.insert(ROOT, '今天很累，但是想到你就开心了。'); await a.sync(server); await b.sync(server);
  return { server, a, b };
}
const idAt = (client, index) => client.document().visible()[index].id;
const equal = (...clients) => clients.slice(1).forEach(x => assert.deepEqual(x.document().visible(), clients[0].document().visible()));
const code = expected => error => error.code === expected;

test('inline insertion keeps A/B/A provenance and reconstructs original sentence', async () => {
  const { server, a, b } = await fixture();
  await b.insert(idAt(b, 4), '抱抱！'); await b.sync(server); await a.sync(server);
  assert.equal(a.text, '今天很累，抱抱！但是想到你就开心了。');
  assert.equal(a.document().text('A'), '今天很累，但是想到你就开心了。');
  assert.equal(a.document().text('B'), '抱抱！'); equal(a, b);
});
test('authority rejects foreign deletion even when UI is bypassed', async () => {
  const { server, b } = await fixture(); const before = await server.read('A');
  await assert.rejects(server.submit('B', { id: 'attack', kind: 'edit', clock: 2,
    after: ROOT, text: '', deleteIds: [idAt(b, 0)] }), code('FOREIGN_TEXT'));
  assert.deepEqual(await server.read('A'), before);
});
test('atomic replacement cannot delete foreign text before adding own text', async () => {
  const { server, b } = await fixture();
  await assert.rejects(server.submit('B', { id: 'replace', kind: 'edit', clock: 2,
    after: ROOT, text: '伪造替换', deleteIds: [idAt(b, 0)] }), code('FOREIGN_TEXT'));
  assert.equal(new Document(await server.read('A')).text(), '今天很累，但是想到你就开心了。');
});
test('spoofed author, seq, whole-document update and extra keys are rejected', async () => {
  const { server } = await fixture();
  const op = { id: 'spoof', kind: 'edit', clock: 2, after: ROOT, text: '攻击', deleteIds: [] };
  for (const extra of [{ actor: 'A' }, { authorId: 'A' }, { seq: 1 }, { update: new Uint8Array([1]) }])
    await assert.rejects(server.submit('B', { ...op, ...extra }), code('INVALID_SHAPE'));
  await assert.rejects(server.submit('B', { id: 'binary', kind: 'binary', update: [1] }), code('INVALID_KIND'));
});
test('nonmember cannot read or write', async () => {
  const { server } = await fixture();
  await assert.rejects(server.read('C'), code('FORBIDDEN'));
  await assert.rejects(server.submit('C', {}), code('FORBIDDEN'));
});
test('foreign undo and cross-user id replay are rejected', async () => {
  const { server } = await fixture(); const [{ op }] = await server.read('A');
  await assert.rejects(server.submit('B', { kind: 'toggle', id: 'bad-undo', target: op.id, active: false }), code('FOREIGN_TEXT'));
  await assert.rejects(server.submit('B', op), code('OPERATION_ID_COLLISION'));
});
test('id replay with a changed payload is rejected; exact retry is idempotent', async () => {
  const { server } = await fixture(); const [{ op }] = await server.read('A');
  await server.submit('A', op);
  await assert.rejects(server.submit('A', { ...op, text: 'changed' }), code('OPERATION_ID_COLLISION'));
  assert.equal((await server.read('A')).length, 1);
});
test('simultaneous same-position runs remain whole, converge independent of receive order', async () => {
  const { server, a, b } = await fixture(); const anchor = idAt(a, 4);
  await a.insert(anchor, '甲甲甲'); await b.insert(anchor, '乙乙乙');
  const aBefore = a.text, bBefore = b.text;
  await b.sync(server); await a.sync(server); await b.sync(server);
  equal(a, b); assert.ok(a.text.includes('甲甲甲')); assert.ok(a.text.includes('乙乙乙'));
  assert.ok(aBefore.includes('甲甲甲')); assert.ok(bBefore.includes('乙乙乙'));
});
test('same-account devices preserve both edits and stable ids', async () => {
  const { server, a } = await fixture(); const a2 = await Client.open('A'); await a2.sync(server);
  await a.insert(ROOT, '手机'); await a2.insert(ROOT, '电脑');
  await a.sync(server); await a2.sync(server); await a.sync(server);
  equal(a, a2); assert.ok(a.text.includes('手机')); assert.ok(a.text.includes('电脑'));
});
test('offline pending survives new remote state and a stale snapshot without rollback', async () => {
  const { server, a, b } = await fixture(); const stale = await server.read('A');
  await a.insert(ROOT, '离线一'); await a.insert(idAt(a, 2), '离线二');
  const ownBefore = a.document().text('A');
  await b.insert(ROOT, '远端'); await b.sync(server);
  await a.receive(await server.read('A')); assert.equal(a.document().text('A'), ownBefore);
  await a.receive(stale); assert.equal(a.document().text('A'), ownBefore);
  assert.equal(a.pending.length, 2); await a.sync(server); await b.sync(server); equal(a, b);
});
test('ACK lost after commit: pending stays visible, retry does not duplicate', async () => {
  const { server, a } = await fixture(); await a.insert(ROOT, '别丢'); server.dropAck = true;
  await assert.rejects(a.sync(server), /ACK_LOST/);
  assert.ok(a.text.includes('别丢')); assert.equal(a.pending.length, 1);
  server.dropAck = false; await a.sync(server); assert.equal(a.pending.length, 0);
  assert.equal(a.text.match(/别丢/g).length, 1); assert.equal((await server.read('A')).length, 2);
});
test('failure before commit does not claim saved; retry retains original text', async () => {
  const { server, a } = await fixture(); await a.insert(ROOT, '等网络'); server.failBeforeCommit = true;
  await assert.rejects(a.sync(server), /DATABASE_UNAVAILABLE/);
  assert.equal(a.status, 'waiting-for-server'); assert.equal((await server.read('A')).length, 1);
  assert.ok(a.text.includes('等网络')); server.failBeforeCommit = false; await a.sync(server);
  assert.equal(a.status, 'server-saved'); assert.ok(a.text.includes('等网络'));
});
test('file-backed client restart restores offline pending and later merges remote edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'between-pages-'));
  try {
    const server = new MemoryAuthority(); const path = join(dir, 'journal.json');
    let a = await Client.open('A', new FileJournal(path)); const b = await Client.open('B');
    await a.insert(ROOT, '本机草稿'); a = null;
    await b.insert(ROOT, '对方在线'); await b.sync(server);
    const restarted = await Client.open('A', new FileJournal(path));
    assert.equal(restarted.text, '本机草稿'); await restarted.sync(server); await b.sync(server);
    equal(restarted, b); assert.equal(restarted.document().text('A'), '本机草稿');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('journal cannot be opened by a different user', async () => {
  const journal = new MemoryJournal(); const a = await Client.open('A', journal); await a.insert(ROOT, '私密');
  await assert.rejects(Client.open('B', journal), code('JOURNAL_ACCOUNT_MISMATCH'));
});
test('local storage failure stays visible and is explicitly reported', async () => {
  const journal = new MemoryJournal(); const a = await Client.open('A', journal); journal.fail = true;
  await assert.rejects(a.insert(ROOT, '仍在屏幕'), /LOCAL_STORAGE_FULL/);
  assert.equal(a.text, '仍在屏幕'); assert.equal(a.status, 'local-save-failed');
  journal.fail = false; await a.persist(); assert.equal((await Client.open('A', journal)).text, '仍在屏幕');
});
test('stale delete targets only original own ids; concurrent B insertion survives', async () => {
  const { server, a, b } = await fixture(); const targets = a.document().visible().slice(0, 5).map(x => x.id);
  await a.remove(targets); await b.insert(idAt(b, 2), '新插入'); await b.sync(server); await a.sync(server); await b.sync(server);
  equal(a, b); assert.equal(a.document().text('B'), '新插入');
});
test('delete tombstone remains a valid anchor for offline edits', async () => {
  const { server, a, b } = await fixture(); const anchor = idAt(a, 2);
  await b.insert(anchor, '依旧保留'); await a.remove([anchor]); await a.sync(server); await b.sync(server); await a.sync(server);
  equal(a, b); assert.ok(a.text.includes('依旧保留'));
});
test('undo own insertion leaves other author descendants; redo preserves them', async () => {
  const { server, a, b } = await fixture(); const target = (await server.read('A'))[0].op.id;
  await b.insert(idAt(b, 4), '抱抱'); await b.sync(server); await a.sync(server);
  await a.toggle(target, false); await a.sync(server); await b.sync(server);
  assert.equal(a.text, '抱抱'); await a.toggle(target, true); await a.sync(server); await b.sync(server);
  equal(a, b); assert.equal(a.text, '今天很累，抱抱但是想到你就开心了。');
});
test('undo deletion removes only its own deletion tag, not another device deletion', async () => {
  const { server, a } = await fixture(); const a2 = await Client.open('A'); await a2.sync(server);
  const id = idAt(a, 0); const op1 = await a.remove([id]); await a2.remove([id]);
  await a.sync(server); await a2.sync(server); await a.sync(server);
  await a.toggle(op1.id, false); await a.sync(server);
  assert.equal(a.text.startsWith('今'), false);
});
test('emoji families, modifiers, flags and combining marks survive scalar storage', async () => {
  const a = await Client.open('A'); const text = '👨‍👩‍👧‍👦👍🏽🇨🇳e\u0301';
  await a.insert(ROOT, text); assert.equal(a.text, text);
  await a.remove(a.document().visible().slice(0, [...'👨‍👩‍👧‍👦'].length).map(x => x.id));
  assert.equal(a.text, '👍🏽🇨🇳e\u0301');
});
test('missing dependency can be retried after its parent; no partial acceptance', async () => {
  const server = new MemoryAuthority(); const a = await Client.open('A');
  const parent = await a.insert(ROOT, '前'); const child = await a.insert(idAt(a, 0), '后');
  await assert.rejects(server.submit('A', child), code('DEPENDENCY_MISSING'));
  assert.equal((await server.read('A')).length, 0);
  await server.submit('A', parent); await server.submit('A', child); await a.sync(server); assert.equal(a.text, '前后');
});
test('out-of-order sparse snapshot is rejected without mutation; full retry catches up', async () => {
  const { server, a, b } = await fixture(); await a.insert(ROOT, '本地'); await a.sync(server);
  const empty = await Client.open('B'); const records = await server.read('B');
  await empty.insert(ROOT, '未发送'); const before = empty.text;
  await assert.rejects(empty.receive([records[1]]), code('SERVER_RECORD_GAP')); assert.equal(empty.text, before);
  await empty.receive([...records].reverse()); assert.ok(empty.text.includes('未发送'));
  await empty.sync(server); await b.sync(server); equal(empty, b);
});
test('malformed, too-large, invalid UTF16, unknown anchors and duplicate targets rejected', async () => {
  const server = new MemoryAuthority();
  const base = { id: 'bad', kind: 'edit', clock: 1, after: ROOT, text: 'ok', deleteIds: [] };
  for (const patch of [{ clock: NaN }, { clock: -1 }, { text: '\ud800' }, { text: 'x'.repeat(4097) },
    { text: '\r' }, { deleteIds: ['x', 'x'] }, { after: 'absent' }])
    await assert.rejects(server.submit('A', { ...base, ...patch }));
  assert.equal((await server.read('A')).length, 0);
});
test('server-side rejection preserves recoverable draft and blocks dependent writes', async () => {
  const { server, a } = await fixture(); await a.insert(ROOT, '待恢复');
  // Simulates changed permission policy rejecting an otherwise locally valid operation.
  const rejecting = { read: actor => server.read(actor), submit: async () => {
    const { Rejection } = await import('../model.mjs'); throw new Rejection('POLICY_CHANGED');
  } };
  await assert.rejects(a.sync(rejecting), code('POLICY_CHANGED'));
  assert.equal(a.recovery.length, 1); assert.ok(a.recovery[0].text.includes('待恢复'));
  assert.equal(a.recovery[0].operations.length, 1);
  assert.equal(a.status, 'recovery-required');
});

// Independent oracle: for insert-only fuzzing, every generated atom id and author must survive.
test('100 deterministic network schedules: offline clients, retries, stale snapshots, restarts', async () => {
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed; const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
    const server = new MemoryAuthority(); const journals = [new MemoryJournal(), new MemoryJournal(), new MemoryJournal()];
    const users = ['A', 'B', 'A']; const clients = await Promise.all(users.map((x, i) => Client.open(x, journals[i])));
    const oracle = new Map(); let stale = [];
    for (let step = 0; step < 60; step++) {
      const index = random(3), client = clients[index];
      if (random(4) !== 0) {
        const visible = client.document().visible(); const at = random(visible.length + 1);
        const text = String.fromCodePoint(0x4e00 + step); const op = await client.insert(at ? visible[at - 1].id : ROOT, text);
        oracle.set(`${op.id}/0`, { text, actor: users[index] });
      } else {
        await client.sync(server);
        if (random(2)) await client.receive(stale); else stale = await server.read(users[index]);
        clients[index] = await Client.open(users[index], journals[index]);
      }
    }
    for (let round = 0; round < 2; round++) for (const client of clients) await client.sync(server);
    equal(...clients);
    const actual = new Map(clients[0].document().visible().map(x => [x.id, { text: x.text, actor: x.actor }]));
    assert.deepEqual(actual, oracle, `seed ${seed}`);
  }
});

test('50 deterministic mixed schedules: own deletes/undo, offline and same-user devices', async () => {
  for (let seed = 101; seed <= 150; seed++) {
    let state = seed; const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
    const server = new MemoryAuthority(), users = ['A', 'B', 'A'];
    const clients = await Promise.all(users.map(x => Client.open(x)));
    for (let step = 0; step < 40; step++) {
      const index = random(3), client = clients[index], visible = client.document().visible();
      const own = visible.filter(x => x.actor === users[index]);
      const edits = [...client.document().records.values()].filter(x => x.actor === users[index] && x.op.kind === 'edit');
      const action = random(5);
      if (action === 0 && own.length) await client.remove([own[random(own.length)].id]);
      else if (action === 1 && edits.length) await client.toggle(edits[random(edits.length)].op.id, Boolean(random(2)));
      else {
        const at = random(visible.length + 1);
        await client.insert(at ? visible[at - 1].id : ROOT, String.fromCodePoint(0x5000 + step));
      }
      if (random(3) === 0) await client.sync(server);
    }
    for (let round = 0; round < 2; round++) for (const client of clients) await client.sync(server);
    equal(...clients);
    // Independent liveness oracle; never uses Document traversal or active-state methods.
    const atoms = new Map(), enabled = new Map(), deletion = new Map();
    for (const { actor, op } of await server.read('A')) {
      if (op.kind === 'toggle') { enabled.set(op.target, op.active); continue; }
      enabled.set(op.id, true);
      for (const [i, text] of [...op.text].entries()) atoms.set(`${op.id}/${i}`, { actor, text, insertion: op.id });
      for (const id of op.deleteIds) {
        assert.equal(atoms.get(id).actor, actor);
        deletion.set(id, [...(deletion.get(id) ?? []), op.id]);
      }
    }
    const expected = new Map([...atoms].filter(([id, atom]) => enabled.get(atom.insertion)
      && !(deletion.get(id) ?? []).some(op => enabled.get(op))).map(([id, { actor, text }]) => [id, { actor, text }]));
    const actual = new Map(clients[0].document().visible().map(({ id, actor, text }) => [id, { actor, text }]));
    assert.deepEqual(actual, expected, `mixed seed ${seed}`);
  }
});

test('non-string ids cannot exploit JavaScript coercion', async () => {
  const server = new MemoryAuthority();
  for (const id of [undefined, null, ['array-id'], {}, 123])
    await assert.rejects(server.submit('A', { id, kind: 'edit', clock: 1, after: ROOT, text: 'x', deleteIds: [] }), code('INVALID_ID'));
});

test('real HTTP: session-derived actor rejects spoofing and foreign edits; reconnect merges', async t => {
  const { once } = await import('node:events');
  const { createAuthorityServer, HttpAuthority } = await import('../http.mjs');
  const authority = new MemoryAuthority();
  const sessions = new Map([['Bearer test-a', 'A'], ['Bearer test-b', 'B'], ['Bearer outsider', 'C']]);
  const server = createAuthorityServer(authority, header => sessions.get(header));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/records`)).status, 401);
  const transportA = new HttpAuthority(url, 'test-a'), transportB = new HttpAuthority(url, 'test-b');
  const a = await Client.open('A'), b = await Client.open('B');
  const first = await a.insert(ROOT, '原文'); await a.sync(transportA); await b.sync(transportB);
  // Caller argument cannot impersonate A with B's session token.
  await assert.rejects(transportB.submit('A', { ...first, id: 'forged', actor: 'A' }), e => e.code === 'INVALID_SHAPE');
  await assert.rejects(transportB.submit('A', { id: 'foreign-http', kind: 'edit', clock: 2,
    after: ROOT, text: '', deleteIds: [idAt(b, 0)] }), e => e.code === 'FOREIGN_TEXT');
  await assert.rejects(new HttpAuthority(url, 'outsider').read(), e => e.code === 'FORBIDDEN');
  await a.insert(ROOT, '本机离线'); await b.insert(ROOT, '远端新增'); await b.sync(transportB);
  await a.sync(transportA); await b.sync(transportB); equal(a, b);
  assert.equal(a.document().text('A'), '本机离线原文'); assert.equal(a.document().text('B'), '远端新增');
});

test('atomic batch refuses a foreign second operation without committing the valid first', async () => {
  const { server, a, b } = await fixture();
  const valid = await b.insert(ROOT, '合法');
  const invalid = { id: 'batch-attack', kind: 'edit', clock: 3, after: ROOT, text: '', deleteIds: [idAt(a, 0)] };
  await assert.rejects(server.submitBatch('B', [valid, invalid]), e => e.code === 'FOREIGN_TEXT');
  assert.equal((await server.read('A')).length, 1); assert.equal(b.pending.length, 1);
});
test('batch dependencies preserve offline chains and lost-ACK retry is idempotent', async () => {
  const server = new MemoryAuthority(), a = await Client.open('A');
  await a.insert(ROOT, '前'); await a.insert(idAt(a, 0), '后');
  server.dropAck = true; await assert.rejects(a.sync(server), /ACK_LOST/);
  assert.equal(a.text, '前后'); assert.equal(a.pending.length, 2);
  server.dropAck = false; await a.sync(server);
  assert.equal(a.text, '前后'); assert.equal((await server.read('A')).length, 2);
});

test('malicious clock jump cannot poison the document and block another member input', async () => {
  const server = new MemoryAuthority();
  await assert.rejects(server.submit('B', { id: 'clock-attack', kind: 'edit', clock: 1e12,
    after: ROOT, text: 'poison', deleteIds: [] }), e => e.code === 'CLOCK_AHEAD');
  const a = await Client.open('A'); await a.insert(ROOT, '仍可输入'); await a.sync(server);
  assert.equal(a.text, '仍可输入'); assert.equal((await server.read('A')).length, 1);
});
