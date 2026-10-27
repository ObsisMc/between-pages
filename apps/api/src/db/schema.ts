import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Domain users (authentication-and-sessions ADR): written only by our code, keyed by the
// same UUID the auth layer issues. No email, no login method, and no foreign key into
// the auth_* tables, so the auth layer can change without touching diaries or authorship.
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  fromDriver: (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
});
// Internal versions, clocks and Yjs clientIDs (uint32) need more than int4.
const int8 = (name: string) => bigint(name, { mode: 'number' });

// Personal diary tables of the collaboration kernel (kernel ADR D9, phase 2). The sharing
// tables and columns (share epochs, commit epoch, space backup targets, read ranges) come
// with phase 4. Only src/store writes these tables.
//
// Rows a commit writes carry user IDs without a foreign key to users: checking one takes
// FOR KEY SHARE on the users row, so a commit would wait behind, and could deadlock with,
// the flows that lock users FOR UPDATE before diary rows (kernel D9 lock order). Those IDs
// come only from the session (authentication-and-sessions invariant 10).

// One personal diary per owner and date (spaces-and-invitations D1, kernel D1). `version`
// is the internal commit counter and never leaves the server (kernel D2).
// `generation_id` points at the current generation; it has no foreign key because the
// generation row references the diary, and both are written in the creating transaction.
export const diaries = pgTable(
  'diaries',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    diaryDate: date('diary_date', { mode: 'string' }).notNull(),
    createdTimezone: text('created_timezone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    version: int8('version').notNull().default(0),
    generationId: uuid('generation_id').notNull(),
  },
  (t) => [unique('diaries_owner_date').on(t.ownerId, t.diaryDate)],
);

// A synchronization generation: its clean baseline and the version it was built from.
// Old generations stay as read-only archive for the owner (kernel D4).
export const diaryGenerations = pgTable(
  'diary_generations',
  {
    id: uuid('id').primaryKey(),
    diaryId: uuid('diary_id')
      .notNull()
      .references(() => diaries.id),
    sourceVersion: int8('source_version').notNull(),
    baseline: bytea('baseline').notNull(),
    baselineSha256: bytea('baseline_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('diary_generations_diary_id').on(t.diaryId, t.id)],
);

// Which user each Yjs clientID belongs to, per diary; written only inside a commit
// transaction under the diary lock (kernel D3).
export const diaryClientBindings = pgTable(
  'diary_client_bindings',
  {
    diaryId: uuid('diary_id')
      .notNull()
      .references(() => diaries.id),
    clientId: int8('client_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.diaryId, t.clientId] })],
);

// One row per committed send batch; the batch receipt is this row (kernel D9). `delta` is
// re-encoded by the server, never the uploaded bytes. Batch columns are null together,
// for the generation baseline commits phase 4 adds.
export const diaryCommits = pgTable(
  'diary_commits',
  {
    diaryId: uuid('diary_id').notNull(),
    version: int8('version').notNull(),
    publicId: uuid('public_id').notNull().unique(),
    generationId: uuid('generation_id').notNull(),
    seq: integer('seq').notNull(),
    batchId: uuid('batch_id'),
    authorId: uuid('author_id'),
    batchDigest: bytea('batch_digest'),
    digestAlgorithm: smallint('digest_algorithm'),
    delta: bytea('delta').notNull(),
    deltaSha256: bytea('delta_sha256').notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.diaryId, t.version] }),
    foreignKey({
      columns: [t.diaryId, t.generationId],
      foreignColumns: [diaryGenerations.diaryId, diaryGenerations.id],
    }),
    unique('diary_commits_generation_seq').on(t.diaryId, t.generationId, t.seq),
    unique('diary_commits_batch').on(t.diaryId, t.batchId),
    check(
      'diary_commits_batch_fields',
      sql`num_nulls(${t.batchId}, ${t.authorId}, ${t.batchDigest}, ${t.digestAlgorithm}) in (0, 4)`,
    ),
  ],
);

// One row per operation of a committed batch. Only the sha256 of the uploaded update is
// kept, never its bytes (kernel D3). `written_at` is the client clock, for display only.
export const diaryOperations = pgTable(
  'diary_operations',
  {
    authorId: uuid('author_id').notNull(),
    diaryId: uuid('diary_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    version: int8('version').notNull(),
    batchIndex: integer('batch_index').notNull(),
    updateSha256: bytea('update_sha256').notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.authorId, t.diaryId, t.operationId] }),
    foreignKey({
      columns: [t.diaryId, t.version],
      foreignColumns: [diaryCommits.diaryId, diaryCommits.version],
    }),
    // A receipt lists its batch's operations.
    index('diary_operations_commit').on(t.diaryId, t.version, t.batchIndex),
  ],
);

// The characters each operation inserted, as clock ranges [clock_start, clock_end) of one
// clientID; the written time comes from the operation row (kernel D15). Kept across
// generations, because baselines keep character IDs.
export const diaryCharacterRanges = pgTable(
  'diary_character_ranges',
  {
    diaryId: uuid('diary_id').notNull(),
    clientId: int8('client_id').notNull(),
    clockStart: int8('clock_start').notNull(),
    clockEnd: int8('clock_end').notNull(),
    operationId: uuid('operation_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.diaryId, t.clientId, t.clockStart] }),
    foreignKey({
      columns: [t.diaryId, t.clientId],
      foreignColumns: [diaryClientBindings.diaryId, diaryClientBindings.clientId],
    }),
    check('diary_character_ranges_nonempty', sql`${t.clockEnd} > ${t.clockStart}`),
  ],
);

// Full state of the diary's generation at `version`, every 100 commits, so rebuilding a
// version replays at most that many deltas (kernel D9).
export const diarySnapshots = pgTable(
  'diary_snapshots',
  {
    diaryId: uuid('diary_id').notNull(),
    version: int8('version').notNull(),
    state: bytea('state').notNull(),
    stateSha256: bytea('state_sha256').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.diaryId, t.version] }),
    foreignKey({
      columns: [t.diaryId, t.version],
      foreignColumns: [diaryCommits.diaryId, diaryCommits.version],
    }),
  ],
);

// Backup tasks registered in the commit transaction (ADR-0003, kernel D16). Only the
// personal target exists until phase 4 adds the space target's columns; registering a
// task never means the backup is done.
export const backupOutbox = pgTable(
  'backup_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diaryId: uuid('diary_id').notNull(),
    version: int8('version').notNull(),
    target: text('target', { enum: ['personal'] }).notNull(),
    status: text('status', { enum: ['pending'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.diaryId, t.version],
      foreignColumns: [diaryCommits.diaryId, diaryCommits.version],
    }),
    unique('backup_outbox_target').on(t.diaryId, t.version, t.target),
  ],
);

// Auth layer tables, owned by Better Auth; exported so drizzle-kit migrates them with ours.
export * from './auth-schema.ts';
