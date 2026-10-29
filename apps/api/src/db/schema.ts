import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { DateSelection } from '@between-pages/contracts';

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
// PG's text form, e.g. {[0,5),[9,12)}; only src/store reads or writes it.
const int8multirange = customType<{ data: string }>({ dataType: () => 'int8multirange' });

// Diary tables of the collaboration kernel (kernel ADR D9): the personal part from phase 2,
// the sharing part (share epochs, commit epoch, space backup targets, read ranges) from
// phase 4. Only src/store writes these tables.
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

// One share of one diary with the owner's partner (kernel D5, spaces-and-invitations D4):
// its baseline is seq 0 of `generation_id`, and it authorizes that baseline and the later
// commits stamped with its ID. `closed_at` and `frozen_version` are set together when it
// freezes and never change again. At most one is live per diary, because a commit carries
// one epoch ID. `recipient_id` has no foreign key to users for the reason above: the
// owner's opening flow would otherwise wait on, and could deadlock with, the partner's
// own flow holding the partner's users row.
export const shareEpochs = pgTable(
  'share_epochs',
  {
    id: uuid('id').primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    diaryId: uuid('diary_id')
      .notNull()
      .references(() => diaries.id),
    periodId: uuid('period_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    generationId: uuid('generation_id').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    frozenVersion: int8('frozen_version'),
  },
  (t) => [
    foreignKey({
      name: 'share_epochs_period',
      columns: [t.periodId, t.spaceId],
      foreignColumns: [bindingPeriods.id, bindingPeriods.spaceId],
    }),
    foreignKey({
      name: 'share_epochs_generation',
      columns: [t.diaryId, t.generationId],
      foreignColumns: [diaryGenerations.diaryId, diaryGenerations.id],
    }),
    foreignKey({
      name: 'share_epochs_frozen',
      columns: [t.diaryId, t.frozenVersion],
      foreignColumns: [diaryCommits.diaryId, diaryCommits.version],
    }),
    uniqueIndex('share_epochs_one_live')
      .on(t.diaryId)
      .where(sql`${t.closedAt} is null`),
    index('share_epochs_recipient').on(t.recipientId, t.spaceId),
    check('share_epochs_close_fields', sql`num_nulls(${t.closedAt}, ${t.frozenVersion}) in (0, 2)`),
  ],
);

// One row per committed send batch; the batch receipt is this row (kernel D9). `delta` is
// re-encoded by the server, never the uploaded bytes. Batch columns are null together, on
// the seq-0 commit of a generation that opens a share (its delta is the baseline).
// `epoch_id` is the epoch live when it committed, null for a private commit (kernel D10).
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
    epochId: uuid('epoch_id').references((): AnyPgColumn => shareEpochs.id),
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
    index('diary_commits_epoch').on(t.epochId),
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

// Backup tasks registered in the commit transaction (ADR-0003, kernel D16): the owner's
// personal target for every commit, and the space target, with its space and epoch, for
// commits inside a live epoch. Registering a task never means the backup is done.
// `space_id` has no foreign key: a commit registers the task under the diary lock, and the
// key check would wait on the space row that relationship flows lock before diary rows.
export const backupOutbox = pgTable(
  'backup_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diaryId: uuid('diary_id').notNull(),
    version: int8('version').notNull(),
    target: text('target', { enum: ['personal', 'space'] }).notNull(),
    spaceId: uuid('space_id'),
    epochId: uuid('epoch_id').references(() => shareEpochs.id),
    status: text('status', { enum: ['pending', 'done'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the worker turned the task into day work for the Google copy (server-backup-and-google-docs). */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.diaryId, t.version],
      foreignColumns: [diaryCommits.diaryId, diaryCommits.version],
    }),
    unique('backup_outbox_target').on(t.diaryId, t.version, t.target),
    index('backup_outbox_pending')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      'backup_outbox_space_fields',
      sql`case ${t.target} when 'space' then num_nulls(${t.spaceId}, ${t.epochId}) = 0
        else num_nonnulls(${t.spaceId}, ${t.epochId}) = 0 end`,
    ),
  ],
);

// What each reader has read of a diary, per clientID, as clock ranges (kernel D15). Keyed
// by character identity, not by epoch, so it survives reopening; devices report into one
// union. No foreign key to users, so reporting takes no lock on the users row.
export const diaryReadRanges = pgTable(
  'diary_read_ranges',
  {
    userId: uuid('user_id').notNull(),
    diaryId: uuid('diary_id')
      .notNull()
      .references(() => diaries.id),
    clientId: int8('client_id').notNull(),
    clocks: int8multirange('clocks').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.diaryId, t.clientId] })],
);

// Relationship and sharing range tables (spaces-and-invitations ADR D10, phase 1). Rules
// that span tables — each account belongs to at most one space, a policy owner is a
// participant, both bindings of a period commit together — hold through the binding
// transaction that locks both users rows first, not through constraints.

// The permanent two-person space; the pair is stored in UUID order so one pair has one row
// (D2). Unbinding never deletes it.
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey(),
    userLow: uuid('user_low')
      .notNull()
      .references(() => users.id),
    userHigh: uuid('user_high')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('spaces_pair').on(t.userLow, t.userHigh),
    index('spaces_user_high').on(t.userHigh),
    check('spaces_pair_ordered', sql`${t.userLow} < ${t.userHigh}`),
  ],
);

// One binding of a space, from confirmation to unbinding; a rebind adds a period and never
// reopens an old one (D2).
export const bindingPeriods = pgTable(
  'binding_periods',
  {
    id: uuid('id').primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: uuid('ended_by').references(() => users.id),
  },
  (t) => [
    unique('binding_periods_id_space').on(t.id, t.spaceId),
    uniqueIndex('binding_periods_one_open')
      .on(t.spaceId)
      .where(sql`${t.endedAt} is null`),
    check('binding_periods_end_fields', sql`num_nulls(${t.endedAt}, ${t.endedBy}) in (0, 2)`),
    check('binding_periods_end_order', sql`${t.endedAt} >= ${t.startedAt}`),
  ],
);

// The current binding of each user; the primary key keeps it to one per user. Rows exist
// only while their period is open.
export const activeBindings = pgTable(
  'active_bindings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    periodId: uuid('period_id').notNull(),
    spaceId: uuid('space_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'active_bindings_period',
      columns: [t.periodId, t.spaceId],
      foreignColumns: [bindingPeriods.id, bindingPeriods.spaceId],
    }),
  ],
);

// Invitation links (D8). Only the SHA-256 of the token is stored. An invitation is closed
// once revoked or accepted; rotation closes the previous one, expired or not, so the
// one-open rule does not depend on the current time.
export const bindingInvitations = pgTable(
  'binding_invitations',
  {
    id: uuid('id').primaryKey(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    requestId: uuid('request_id').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    /** The inviter's selection confirmed for this invitation; null restores the relationship only. */
    confirmedSelection: jsonb('confirmed_selection').$type<DateSelection>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
  },
  (t) => [
    unique('binding_invitations_request').on(t.createdBy, t.requestId),
    uniqueIndex('binding_invitations_one_open')
      .on(t.createdBy)
      .where(sql`${t.revokedAt} is null and ${t.acceptedAt} is null`),
    check('binding_invitations_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'binding_invitations_accept_fields',
      sql`num_nulls(${t.acceptedAt}, ${t.acceptedBy}) in (0, 2)`,
    ),
    check(
      'binding_invitations_closed_once',
      sql`${t.revokedAt} is null or ${t.acceptedAt} is null`,
    ),
  ],
);

// Each person's own sharing range in a space (D3, D5). Saving it configures a range; it is
// not a grant to read any diary text. `confirmed_period_id` is the period the selection was
// last confirmed for, so a confirmation never carries over to a later period.
export const sharingPolicies = pgTable(
  'sharing_policies',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    selection: jsonb('selection')
      .$type<DateSelection>()
      .notNull()
      .default({ include: [], exclude: [] }),
    revision: integer('revision').notNull().default(0),
    confirmedPeriodId: uuid('confirmed_period_id'),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.ownerId] }),
    foreignKey({
      name: 'sharing_policies_confirmed_period',
      columns: [t.confirmedPeriodId, t.spaceId],
      foreignColumns: [bindingPeriods.id, bindingPeriods.spaceId],
    }),
    check('sharing_policies_revision', sql`${t.revision} >= 0`),
  ],
);

// One row per committed range change, readable by its owner only; `(owner_id, request_id)`
// returns the original result when a lost response is retried (D5, D11).
export const sharingPolicyChanges = pgTable(
  'sharing_policy_changes',
  {
    id: uuid('id').primaryKey(),
    spaceId: uuid('space_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    requestId: uuid('request_id').notNull(),
    fromRevision: integer('from_revision').notNull(),
    toRevision: integer('to_revision').notNull(),
    selection: jsonb('selection').$type<DateSelection>().notNull(),
    periodId: uuid('period_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sharing_policy_changes_request').on(t.ownerId, t.requestId),
    foreignKey({
      name: 'sharing_policy_changes_policy',
      columns: [t.spaceId, t.ownerId],
      foreignColumns: [sharingPolicies.spaceId, sharingPolicies.ownerId],
    }),
    foreignKey({
      name: 'sharing_policy_changes_period',
      columns: [t.periodId, t.spaceId],
      foreignColumns: [bindingPeriods.id, bindingPeriods.spaceId],
    }),
    check('sharing_policy_changes_step', sql`${t.toRevision} = ${t.fromRevision} + 1`),
  ],
);

// The Google readable copy (server-backup-and-google-docs D5–D10). Only src/store reads or
// writes these tables. Every row names the Google account it belongs to, so connecting a
// different account starts new folders and Docs instead of writing into the old ones.

// One Drive connection per person. The refresh token is AES-256-GCM ciphertext; the key is
// only in the environment, named by `key_id`, and only the worker decrypts (D10).
export const googleConnections = pgTable('google_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  googleUserId: text('google_user_id').notNull(),
  email: text('email').notNull(),
  refreshToken: bytea('refresh_token').notNull(),
  tokenNonce: bytea('token_nonce').notNull(),
  keyId: text('key_id').notNull(),
  status: text('status', { enum: ['active', 'reconnect', 'revoking'] }).notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
});

// A started authorization, until its callback or ten minutes: the PKCE verifier and who
// started it, found by the sha256 of the state the browser carries (D10).
export const googleOauthStates = pgTable('google_oauth_states', {
  stateSha256: bytea('state_sha256').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  codeVerifier: text('code_verifier').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// The app's folders in one Drive: `Between Pages`, `2026`, `2026/10` (D6).
export const googleFolders = pgTable(
  'google_folders',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    googleUserId: text('google_user_id').notNull(),
    path: text('path').notNull(),
    folderId: text('folder_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.googleUserId, t.path] })],
);

// The day's Doc in one Drive. At most one `current` per person, account and date; a Doc
// edited in Google becomes `replaced` and keeps its row (D8).
export const googleDayDocs = pgTable(
  'google_day_docs',
  {
    docId: text('doc_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    googleUserId: text('google_user_id').notNull(),
    diaryDate: date('diary_date').notNull(),
    state: text('state', { enum: ['current', 'replaced'] }).notNull(),
    /** The revision the app's last write produced; a write requires it (Docs `requiredRevisionId`). */
    revisionId: text('revision_id').notNull(),
    contentSha256: bytea('content_sha256').notNull(),
    /** The versions the Doc shows: the owner's diary and the partner's share, when present. */
    covers: jsonb('covers')
      .$type<{
        mine?: { diaryId: string; version: number; at: string };
        partner?: { diaryId: string; epochId: string; version: number; at: string };
      }>()
      .notNull(),
    /** The history point the Doc reaches, as "backed up to Google 9:22" shows it. */
    coveredAt: timestamp('covered_at', { withTimezone: true }).notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('google_day_docs_current')
      .on(t.userId, t.googleUserId, t.diaryDate)
      .where(sql`${t.state} = 'current'`),
  ],
);

// Days waiting to be written into one person's Drive, merged per person and date (D7).
// `ready_at` is the earliest time to look; the worker still waits for the history point.
export const googleDayWork = pgTable(
  'google_day_work',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    diaryDate: date('diary_date').notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull().defaultNow(),
    /** "现在备份": write without waiting for the history point. */
    now: boolean('now').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.diaryDate] })],
);

// What the backup page lists under problems (D9), newest first, for its owner only.
export const backupEvents = pgTable(
  'backup_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', {
      enum: ['doc_replaced', 'doc_recreated', 'storage_full', 'revoke_failed', 'reconnect_needed'],
    }).notNull(),
    diaryDate: date('diary_date'),
  },
  (t) => [index('backup_events_user').on(t.userId, t.at)],
);

// Auth layer tables, owned by Better Auth; exported so drizzle-kit migrates them with ours.
export * from './auth-schema.ts';
