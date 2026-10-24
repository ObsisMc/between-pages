import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const isYjs = process.env.COLLAB_ENGINE === 'yjs';
const { Client } = await import(isYjs ? '../../yjs/client.mjs' : '../client.mjs');
import { ROOT } from '../model.mjs';
const { Document } = await import(isYjs ? '../../yjs/model.mjs' : '../model.mjs');
const { PostgresAuthority } = await import(isYjs ? '../../yjs/postgres.mjs' : '../postgres.mjs');
const tablePrefix = isYjs ? 'yjs_probe' : 'collab_probe';

const url = process.env.COLLAB_TEST_DATABASE_URL;
if (!url) throw new Error('Set COLLAB_TEST_DATABASE_URL to a disposable PostgreSQL test database.');
const pool = PostgresAuthority.pool(url);
await PostgresAuthority.migrate(pool);
test.after(() => pool.end());
async function fixture() {
  const id = `test-${randomUUID()}`;
  const server = new PostgresAuthority(pool, id); await server.create();
  return { id, server, a: await Client.open('A'), b: await Client.open('B') };
}
async function counts(id) {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::int FROM ${tablePrefix}_operations WHERE doc_id=$1) operations,
    (SELECT count(*)::int FROM ${tablePrefix}_outbox WHERE doc_id=$1) outbox,
    (SELECT version FROM ${tablePrefix}_documents WHERE id=$1) version`, [id]);
  return rows[0];
}

test('PG: two service instances serialize concurrent writes with atomic outbox', async () => {
  const { id, server, a, b } = await fixture(); const other = new PostgresAuthority(pool, id);
  const opA = await a.insert(ROOT, '甲甲'), opB = await b.insert(ROOT, '乙乙');
  await Promise.all([server.submit('A', opA), other.submit('B', opB)]);
  await a.sync(server); await b.sync(other);
  assert.equal(a.text, b.text); assert.ok(a.text.includes('甲甲')); assert.ok(a.text.includes('乙乙'));
  assert.deepEqual(await counts(id), { operations: 2, outbox: 2, version: 2 });
});
test('PG: parallel retries across instances create exactly one operation and task', async () => {
  const { id, server, a } = await fixture(); const op = await a.insert(ROOT, '仅一次');
  await Promise.all(Array.from({ length: 20 }, () => new PostgresAuthority(pool, id).submit('A', op)));
  assert.deepEqual(await counts(id), { operations: 1, outbox: 1, version: 1 });
  assert.equal(new Document(await server.read('A')).text(), '仅一次');
});
test('PG: attempted foreign deletion rolls back and leaves outbox unchanged', async () => {
  const { id, server, a } = await fixture(); await a.insert(ROOT, 'A所有'); await a.sync(server);
  const atom = a.document().visible()[0];
  await assert.rejects(server.submit('B', { id: randomUUID(), kind: 'edit', clock: 2,
    after: ROOT, text: '覆盖', deleteIds: [atom.id] }), e => e.code === 'FOREIGN_TEXT');
  assert.deepEqual(await counts(id), { operations: 1, outbox: 1, version: 1 });
  assert.equal(new Document(await server.read('A')).text(), 'A所有');
});
test('PG: failure after SQL writes before COMMIT rolls back document, operation and outbox', async () => {
  const { id, server, a } = await fixture(); await a.insert(ROOT, '不能丢'); server.failBeforeCommit = true;
  await assert.rejects(a.sync(server), /INJECTED_BEFORE_COMMIT/);
  assert.deepEqual(await counts(id), { operations: 0, outbox: 0, version: 0 });
  assert.equal(a.text, '不能丢'); assert.equal(a.status, 'waiting-for-server');
  server.failBeforeCommit = false; await a.sync(server);
  assert.deepEqual(await counts(id), { operations: 1, outbox: 1, version: 1 });
});
test('PG: commit followed by lost ACK survives fresh service and pool', async () => {
  const { id, server, a } = await fixture(); await a.insert(ROOT, '确认丢了字还在'); server.dropAck = true;
  await assert.rejects(a.sync(server), /ACK_LOST_AFTER_COMMIT/);
  assert.equal(a.pending.length, 1); assert.equal(a.text, '确认丢了字还在');
  const newPool = PostgresAuthority.pool(url);
  try {
    const restarted = new PostgresAuthority(newPool, id); await a.sync(restarted);
    assert.equal(a.pending.length, 0); assert.equal(a.text, '确认丢了字还在');
    assert.deepEqual(await counts(id), { operations: 1, outbox: 1, version: 1 });
  } finally { await newPool.end(); }
});
test('PG: offline edits remain visible through old read and merge after service restart', async () => {
  const { id, server, a, b } = await fixture();
  await a.insert(ROOT, '原文'); await a.sync(server); await b.sync(server);
  const stale = await server.read('A'); await a.insert(ROOT, '离线续写');
  await b.insert(b.document().visible()[0].id, '对方插入'); await b.sync(server);
  await a.receive(stale); assert.equal(a.document().text('A'), '离线续写原文');
  const restarted = new PostgresAuthority(pool, id); await a.sync(restarted); await b.sync(restarted);
  assert.equal(a.text, b.text); assert.equal(a.document().text('A'), '离线续写原文');
  assert.equal(a.document().text('B'), '对方插入');
});
test('PG: nonmember cannot read or submit and no transaction is left open', async () => {
  const { server, a } = await fixture(); const op = await a.insert(ROOT, '自己的');
  await assert.rejects(server.read('C'), e => e.code === 'FORBIDDEN');
  await assert.rejects(server.submit('C', op), e => e.code === 'FORBIDDEN');
  await a.sync(server); assert.equal(a.text, '自己的');
});

for (const phase of ['beforeCommit', 'afterCommit']) {
  test(`PG: actual service SIGKILL at ${phase} preserves correct commit boundary`, async () => {
    const { fork } = await import('node:child_process');
    const { once } = await import('node:events');
    const { id, server, a } = await fixture(); const op = await a.insert(ROOT, '进程崩溃也可重试');
    const child = fork(new URL('./crash-worker.mjs', import.meta.url), [], { silent: true });
    try {
      const reached = once(child, 'message', { signal: AbortSignal.timeout(10000) });
      child.send({ docId: id, actor: 'A', op, phase });
      assert.deepEqual((await reached)[0], { phase });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const expected = phase === 'beforeCommit' ? 0 : 1;
      assert.deepEqual(await counts(id), { operations: expected, outbox: expected, version: expected });
      assert.equal(a.pending.length, 1); assert.equal(a.text, '进程崩溃也可重试');
      await a.sync(new PostgresAuthority(pool, id));
      assert.equal(a.pending.length, 0); assert.equal(a.text, '进程崩溃也可重试');
      assert.deepEqual(await counts(id), { operations: 1, outbox: 1, version: 1 });
    } finally { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); }
  });
}

test('PG: batch permission failure rolls back all operations and all outbox rows', async () => {
  const { id, server, a, b } = await fixture(); await a.insert(ROOT, '原文'); await a.sync(server);
  const first = await b.insert(ROOT, '合法插入');
  const second = { id: randomUUID(), kind: 'edit', clock: 2, after: ROOT, text: '', deleteIds: [a.document().visible()[0].id] };
  await assert.rejects(server.submitBatch('B', [first, second]), e => e.code === 'FOREIGN_TEXT');
  assert.deepEqual(await counts(id), { operations: 1, outbox: 1, version: 1 });
});
test('PG: dependent offline batch commits once across parallel retries', async () => {
  const { id, server, a } = await fixture();
  const first = await a.insert(ROOT, '前'), second = await a.insert(a.document().visible()[0].id, '后');
  await Promise.all(Array.from({ length: 8 }, () => new PostgresAuthority(pool, id).submitBatch('A', [first, second])));
  await a.sync(server); assert.equal(a.text, '前后'); assert.equal(a.pending.length, 0);
  assert.deepEqual(await counts(id), { operations: 2, outbox: 2, version: 2 });
});

test('PG: clock poisoning is rejected without changing version or backup tasks', async () => {
  const { id, server, a } = await fixture();
  await assert.rejects(server.submit('B', { id: randomUUID(), kind: 'edit', clock: 1e12,
    after: ROOT, text: 'poison', deleteIds: [] }), e => e.code === 'CLOCK_AHEAD');
  assert.deepEqual(await counts(id), { operations: 0, outbox: 0, version: 0 });
  await a.insert(ROOT, '正常'); await a.sync(server); assert.equal(a.text, '正常');
});
