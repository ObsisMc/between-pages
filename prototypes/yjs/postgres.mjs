import pg from 'pg';
import { Rejection } from '../collaboration/model.mjs';
import { acceptBatch } from './authority.mjs';

export class PostgresAuthority {
  constructor(pool, docId) { this.pool = pool; this.docId = docId; }
  static pool(url) { return new pg.Pool({ connectionString: url, max: 8 }); }
  static async migrate(pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS yjs_probe_documents (
      id text PRIMARY KEY, members text[] NOT NULL, version integer NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS yjs_probe_operations (
      doc_id text NOT NULL REFERENCES yjs_probe_documents(id), seq integer NOT NULL,
      op_id text NOT NULL, record jsonb NOT NULL, PRIMARY KEY(doc_id, seq), UNIQUE(doc_id, op_id));
      CREATE TABLE IF NOT EXISTS yjs_probe_outbox (
      doc_id text NOT NULL REFERENCES yjs_probe_documents(id), version integer NOT NULL,
      PRIMARY KEY(doc_id, version));`);
  }
  async create(members = ['A', 'B']) {
    await this.pool.query('INSERT INTO yjs_probe_documents(id,members) VALUES($1,$2)', [this.docId, members]);
  }
  async read(actor) {
    const { rows } = await this.pool.query(`SELECT d.members,
      COALESCE(jsonb_agg(o.record ORDER BY o.seq) FILTER (WHERE o.seq IS NOT NULL),'[]'::jsonb) records
      FROM yjs_probe_documents d LEFT JOIN yjs_probe_operations o ON o.doc_id=d.id
      WHERE d.id=$1 GROUP BY d.id`, [this.docId]);
    if (!rows[0]?.members.includes(actor)) throw new Rejection('FORBIDDEN');
    return rows[0].records;
  }
  async submit(actor, op) { return (await this.submitBatch(actor, [op]))[0]; }
  async submitBatch(actor, operations) {
    const connection = await this.pool.connect(); let committed = false;
    try {
      await connection.query('BEGIN');
      const { rows } = await connection.query('SELECT members FROM yjs_probe_documents WHERE id=$1 FOR UPDATE', [this.docId]);
      if (!rows[0]?.members.includes(actor)) throw new Rejection('FORBIDDEN');
      const history = await connection.query('SELECT record FROM yjs_probe_operations WHERE doc_id=$1 ORDER BY seq', [this.docId]);
      const result = acceptBatch({ members: rows[0].members, records: history.rows.map(row => row.record) }, actor, operations);
      for (const record of result.added) {
        await connection.query('INSERT INTO yjs_probe_operations VALUES($1,$2,$3,$4)', [this.docId, record.seq, record.op.id, record]);
        await connection.query('UPDATE yjs_probe_documents SET version=$2 WHERE id=$1', [this.docId, record.seq]);
        await connection.query('INSERT INTO yjs_probe_outbox VALUES($1,$2)', [this.docId, record.seq]);
      }
      if (this.failBeforeCommit) throw new Error('INJECTED_BEFORE_COMMIT');
      await this.beforeCommit?.();
      await connection.query('COMMIT'); committed = true;
      await this.afterCommit?.();
      if (this.dropAck) throw new Error('ACK_LOST_AFTER_COMMIT');
      return result.records;
    } catch (error) { if (!committed) await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
}
