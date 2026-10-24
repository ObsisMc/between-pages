import pg from 'pg';
import { acceptBatch } from './authority.mjs';
import { Rejection } from './model.mjs';
export class PostgresAuthority {
  constructor(pool, docId) { this.pool = pool; this.docId = docId; }
  static pool(url) { return new pg.Pool({ connectionString: url, max: 8 }); }
  static async migrate(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collab_probe_documents (
        id text PRIMARY KEY, members text[] NOT NULL, version integer NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS collab_probe_operations (
        doc_id text NOT NULL REFERENCES collab_probe_documents(id),
        seq integer NOT NULL, op_id text NOT NULL, actor text NOT NULL, operation jsonb NOT NULL,
        PRIMARY KEY(doc_id, seq), UNIQUE(doc_id, op_id));
      CREATE TABLE IF NOT EXISTS collab_probe_outbox (
        doc_id text NOT NULL REFERENCES collab_probe_documents(id), version integer NOT NULL,
        PRIMARY KEY(doc_id, version));`);
  }
  async create(members = ['A', 'B']) {
    await this.pool.query('INSERT INTO collab_probe_documents(id,members) VALUES($1,$2)', [this.docId, members]);
  }
  async read(actor) {
    // Membership check and record read share a single query snapshot.
    const result = await this.pool.query(`SELECT d.members,
      COALESCE(jsonb_agg(jsonb_build_object('actor',o.actor,'op',o.operation,'seq',o.seq)
      ORDER BY o.seq) FILTER (WHERE o.seq IS NOT NULL),'[]'::jsonb) records
      FROM collab_probe_documents d LEFT JOIN collab_probe_operations o ON o.doc_id=d.id
      WHERE d.id=$1 GROUP BY d.id`, [this.docId]);
    if (!result.rows[0]?.members.includes(actor)) throw new Rejection('FORBIDDEN');
    return result.rows[0].records;
  }
  async submit(actor, op) {
    return (await this.submitBatch(actor, [op]))[0];
  }
  async submitBatch(actor, operations) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const { rows } = await connection.query('SELECT members FROM collab_probe_documents WHERE id=$1 FOR UPDATE', [this.docId]);
      if (!rows[0]?.members.includes(actor)) throw new Rejection('FORBIDDEN');
      const entries = await connection.query('SELECT actor,operation AS op,seq FROM collab_probe_operations WHERE doc_id=$1 ORDER BY seq', [this.docId]);
      const result = acceptBatch({ members: rows[0].members, records: entries.rows }, actor, operations);
      for (const record of result.added) {
        await connection.query('INSERT INTO collab_probe_operations VALUES($1,$2,$3,$4,$5)',
          [this.docId, record.seq, record.op.id, actor, record.op]);
        await connection.query('UPDATE collab_probe_documents SET version=$2 WHERE id=$1', [this.docId, record.seq]);
        await connection.query('INSERT INTO collab_probe_outbox VALUES($1,$2)', [this.docId, record.seq]);
      }
      if (this.failBeforeCommit) throw new Error('INJECTED_BEFORE_COMMIT');
      await this.beforeCommit?.();
      await connection.query('COMMIT');
      await this.afterCommit?.();
      if (this.dropAck) throw new Error('ACK_LOST_AFTER_COMMIT');
      return result.records;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
}
