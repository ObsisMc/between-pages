import { sql, type Column } from 'drizzle-orm';
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
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AnniversaryActionKind,
  AnniversaryKind,
  GiftActionKind,
  GiftOccasion,
  SharedPageActionKind,
  SpaceRecordType,
  WishActionKind,
  type DateSelection,
} from '@between-pages/contracts';

// Domain users (authentication-and-sessions ADR): written only by our code, keyed by the
// same UUID the auth layer issues. No email, no login method, and no foreign key into
// the auth_* tables, so the auth layer can change without touching diaries or authorship.
//
// The time zone and sleep schedule are the person's own two-clocks settings (two-clocks D1,
// D2): the zone is the last one their browser reported, the schedule two local minutes of
// the day on a 15-minute grid, both set or both empty.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    timezone: text('timezone'),
    timezoneUpdatedAt: timestamp('timezone_updated_at', { withTimezone: true }),
    sleepStartMinute: smallint('sleep_start_minute'),
    sleepEndMinute: smallint('sleep_end_minute'),
  },
  (t) => [
    check('users_timezone_fields', sql`num_nulls(${t.timezone}, ${t.timezoneUpdatedAt}) in (0, 2)`),
    check(
      'users_sleep_fields',
      sql`num_nulls(${t.sleepStartMinute}, ${t.sleepEndMinute}) in (0, 2)`,
    ),
    check(
      'users_sleep_grid',
      sql`${t.sleepStartMinute} between 0 and 1425 and ${t.sleepStartMinute} % 15 = 0
        and ${t.sleepEndMinute} between 0 and 1425 and ${t.sleepEndMinute} % 15 = 0
        and ${t.sleepStartMinute} <> ${t.sleepEndMinute}`,
    ),
  ],
);

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

// What a commit chain hangs on (shared-pages D6): the `diary_*` tables below hold one
// document's chain, and their `diary_id` means this ID. `version` is the internal commit
// counter and never leaves the server (kernel D2). `generation_id` points at the current
// generation; it has no foreign key because the generation row references the document,
// and both are written in the creating transaction.
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  version: int8('version').notNull().default(0),
  generationId: uuid('generation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One personal diary per owner and date (spaces-and-invitations D1, kernel D1); its ID is
// its document's. Queries that start here cannot reach any other kind of document.
export const diaries = pgTable(
  'diaries',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => documents.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    diaryDate: date('diary_date', { mode: 'string' }).notNull(),
    createdTimezone: text('created_timezone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
      .references(() => documents.id),
    sourceVersion: int8('source_version').notNull(),
    baseline: bytea('baseline').notNull(),
    baselineSha256: bytea('baseline_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('diary_generations_diary_id').on(t.diaryId, t.id)],
);

// Which user each Yjs clientID belongs to, per document; written only inside a commit
// transaction under the diary lock (kernel D3).
export const diaryClientBindings = pgTable(
  'diary_client_bindings',
  {
    diaryId: uuid('diary_id')
      .notNull()
      .references(() => documents.id),
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
    /** A link's token digest; null for an addressed invitation (in-app-invitation-by-email D1). */
    tokenHash: bytea('token_hash').unique(),
    /** An addressed invitation's recipient, trimmed and lower-cased (D2); null for a link. */
    recipientEmail: text('recipient_email'),
    /** When the recipient dismissed it; only they stop seeing it (D4). */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
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
    check('binding_invitations_one_way', sql`num_nulls(${t.tokenHash}, ${t.recipientEmail}) = 1`),
    check(
      'binding_invitations_dismiss_directed',
      sql`${t.dismissedAt} is null or ${t.recipientEmail} is not null`,
    ),
    index('binding_invitations_recipient')
      .on(t.recipientEmail)
      .where(sql`${t.revokedAt} is null and ${t.acceptedAt} is null`),
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
// One Google account is connected by at most one user at a time, a revoking connection
// included, so two people's copies never land in one Drive (google-copy-beyond-diaries D9).
export const googleConnections = pgTable('google_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  googleUserId: text('google_user_id').notNull().unique('google_connections_account'),
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
      enum: [
        'doc_replaced',
        'doc_recreated',
        'storage_full',
        'revoke_failed',
        'reconnect_needed',
        'copy_failing',
        'check_failed',
        'account_in_use',
      ],
    }).notNull(),
    diaryDate: date('diary_date'),
    /** The page or summary an entry is about (google-copy-beyond-diaries D8): `page:<id>`, `wishes`, ... */
    item: text('item'),
    /**
     * The Google account an `account_in_use` entry names: its connection row was deleted by
     * migration `0014`, so only this entry still says which Drive holds the earlier copies (D9).
     */
    email: text('email'),
  },
  (t) => [index('backup_events_user').on(t.userId, t.at)],
);

// The space's records that changed since the worker last looked (google-copy-beyond-diaries,
// 技术设计): written in the transaction of each change by space-records, the page commit,
// bindings and the link-preview write-back. A null record type means every `Together` Doc of
// the space (unbinding, rebinding). `private_to` is copied from the write: a private change
// queues work only for that person (D3). No foreign keys: the writers hold the period FOR
// SHARE or a document lock, and a key check would lock rows relationship flows lock first.
export const spaceCopyOutbox = pgTable(
  'space_copy_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    recordType: text('record_type'),
    recordId: uuid('record_id'),
    privateTo: uuid('private_to'),
    status: text('status', { enum: ['pending', 'done'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('space_copy_outbox_pending')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('space_copy_outbox_record', sql`num_nulls(${t.recordType}, ${t.recordId}) in (0, 2)`),
  ],
);

// A page or summary Doc waiting to be written into one person's Drive (D5), merged per person
// and item (`page:<id>`, `wishes`, `gifts`, `anniversaries`). A summary is due two minutes
// after its latest change, at the latest ten after `first_at`; a page is looked at at once
// and waits for its history point as a day does. No foreign key, as for the outbox.
export const googleItemWork = pgTable(
  'google_item_work',
  {
    userId: uuid('user_id').notNull(),
    item: text('item').notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull().defaultNow(),
    /** When this batch of changes was first queued (D5's ten-minute bound). */
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    /** "现在备份": write without waiting for a history point or the two minutes. */
    now: boolean('now').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.item] })],
);

// A page or summary Doc in one Drive (D4–D7). At most one `current` per person, account and
// item; `replaced` was changed in Google (D6), `deleted` holds a page deleted in the app and
// is never written or made again (D7). `title` is the page title the Doc last got, kept for
// the backup page once the page is gone; `rename_intent` is a Drive rename under way, so a
// crash between it and recording the revision it produced is not taken for an edit.
export const googleItemDocs = pgTable(
  'google_item_docs',
  {
    docId: text('doc_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    googleUserId: text('google_user_id').notNull(),
    item: text('item').notNull(),
    state: text('state', { enum: ['current', 'replaced', 'deleted'] }).notNull(),
    title: text('title'),
    /** The name the rename gives, the revision before it and the sha256 (hex) of the text then. */
    renameIntent: jsonb('rename_intent').$type<{
      name: string;
      revisionId: string;
      textSha256: string;
    }>(),
    /** The revision the app's last write produced; a write requires it. */
    revisionId: text('revision_id').notNull(),
    contentSha256: bytea('content_sha256').notNull(),
    /** What the Doc reaches, as "已备份到 Google 9:22" shows it. */
    coveredAt: timestamp('covered_at', { withTimezone: true }).notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('google_item_docs_current')
      .on(t.userId, t.googleUserId, t.item)
      .where(sql`${t.state} = 'current'`),
  ],
);

// Shared tables of the space features beyond the diary (space-records ADR). Only
// src/store/space-records.ts writes them, always in the transaction that changes the record
// they describe (D4). One sequence numbers both histories, so "seen up to" is one number per
// record (D8). The record they point at lives in a feature table ("功能 + 记录 ID"), without
// a foreign key: every write goes through the space-records service, which checks it.
//
// No space record row has a foreign key to users or spaces: the key check would take FOR KEY
// SHARE on a row the relationship flows lock FOR UPDATE, while a record write already holds
// the open period FOR SHARE that unbinding waits for (D5), which could deadlock.
export const spaceRecordSeq = pgSequence('space_record_seq');
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
/** Record types of every feature, and the actions each registered (D4). */
const recordTypeCheck = (column: Column) =>
  sql`${column} in (${sql.raw(quoted(SpaceRecordType.options))})`;
const ACTION_KINDS: Record<string, readonly string[]> = {
  wish: WishActionKind.options,
  gift: GiftActionKind.options,
  anniversary: AnniversaryActionKind.options,
  shared_page: SharedPageActionKind.options,
};
const recordSeq = () =>
  int8('seq')
    .primaryKey()
    .default(sql`nextval('space_record_seq')`);

// Creation, edits and deletion of a record by its author (D3, D6), append-only.
export const spaceChanges = pgTable(
  'space_changes',
  {
    seq: recordSeq(),
    spaceId: uuid('space_id').notNull(),
    recordType: text('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    kind: text('kind', { enum: ['create', 'edit', 'delete'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    /** Set while the record is private to this user (D9); the row never changes after. */
    privateTo: uuid('private_to'),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
    /** A creation is sent once: the same request ID returns the record it made (D4). */
    requestId: uuid('request_id'),
    requestDigest: text('request_digest'),
  },
  (t) => [
    unique('space_changes_request').on(t.actorId, t.requestId),
    index('space_changes_record').on(t.recordType, t.recordId),
    index('space_changes_space').on(t.spaceId, t.seq),
    check('space_changes_kind', sql`${t.kind} in ('create', 'edit', 'delete')`),
    check('space_changes_record_type', recordTypeCheck(t.recordType)),
    check(
      'space_changes_request_fields',
      sql`num_nulls(${t.requestId}, ${t.requestDigest}) in (0, 2)`,
    ),
  ],
);

// Actions on a record (D4): the record keeps the current state, this keeps every step,
// append-only; an undo is a step of its own.
export const spaceActions = pgTable(
  'space_actions',
  {
    seq: recordSeq(),
    spaceId: uuid('space_id').notNull(),
    recordType: text('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    kind: text('kind').notNull(),
    actorId: uuid('actor_id').notNull(),
    privateTo: uuid('private_to'),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: uuid('request_id').notNull(),
    requestDigest: text('request_digest').notNull(),
  },
  (t) => [
    unique('space_actions_request').on(t.actorId, t.requestId),
    index('space_actions_record').on(t.recordType, t.recordId),
    index('space_actions_space').on(t.spaceId, t.seq),
    check(
      'space_actions_kind',
      sql.raw(
        Object.entries(ACTION_KINDS)
          .map(([type, kinds]) => `(record_type = '${type}' and kind in (${quoted(kinds)}))`)
          .join(' or '),
      ),
    ),
  ],
);

// What each person has seen of a record: the newest change or action of the partner on
// it that was on their screen (D8). Only the reader writes their rows.
export const spaceReads = pgTable(
  'space_reads',
  {
    userId: uuid('user_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    recordType: text('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    seq: int8('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.recordType, t.recordId] }),
    check('space_reads_record_type', recordTypeCheck(t.recordType)),
  ],
);

// Columns every space record carries (space-records 数据与模块). `private_to` is set while
// the record exists only for that user (D9); `revision` counts the author's edits (D3).
const spaceRecordColumns = () => ({
  id: uuid('id').primaryKey(),
  spaceId: uuid('space_id').notNull(),
  authorId: uuid('author_id').notNull(),
  createdPeriodId: uuid('created_period_id').notNull(),
  privateTo: uuid('private_to'),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
});
const deletionCheck = (t: { deletedAt: Column; deletedBy: Column }) =>
  sql`num_nulls(${t.deletedAt}, ${t.deletedBy}) in (0, 2)`;
// What the worker read from a link (wishes-and-gifts D7): text and an image address only.
// `preview_read_at` is null until it tried; it stays null with no link.
const previewColumns = () => ({
  previewTitle: text('preview_title'),
  previewSite: text('preview_site'),
  previewImage: text('preview_image'),
  previewReadAt: timestamp('preview_read_at', { withTimezone: true }),
});

// A page two people write together (shared-pages D1), on its own document. `title_*` is the
// current state of the "renamed" action (D3); `revision` counts renames, not text.
export const sharedPages = pgTable(
  'shared_pages',
  {
    ...spaceRecordColumns(),
    id: uuid('id')
      .primaryKey()
      .references(() => documents.id),
    title: text('title').notNull().default(''),
    titleBy: uuid('title_by'),
    titleAt: timestamp('title_at', { withTimezone: true }),
  },
  (t) => [
    index('shared_pages_space').on(t.spaceId),
    check('shared_pages_deletion', deletionCheck(t)),
    check('shared_pages_title', sql`char_length(${t.title}) <= 60`),
    check('shared_pages_title_stamp', sql`num_nulls(${t.titleBy}, ${t.titleAt}) in (0, 2)`),
  ],
);

// Wishes (wishes-and-gifts D1). `received_*` is the current state of the wisher's "收到了"
// (D4): the wish has then left the list for the gift wall.
export const wishes = pgTable(
  'wishes',
  {
    ...spaceRecordColumns(),
    name: text('name').notNull(),
    link: text('link'),
    note: text('note'),
    want: smallint('want'),
    ...previewColumns(),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: uuid('received_by'),
  },
  (t) => [
    index('wishes_space').on(t.spaceId),
    index('wishes_preview_pending')
      .on(t.createdAt)
      .where(sql`${t.link} is not null and ${t.previewReadAt} is null`),
    check('wishes_want', sql`${t.want} between 1 and 5`),
    check('wishes_not_private', sql`${t.privateTo} is null`),
    check('wishes_deleted', deletionCheck(t)),
    check('wishes_received', sql`num_nulls(${t.receivedAt}, ${t.receivedBy}) in (0, 2)`),
  ],
);

// Gifts (D2, D4, D5): private to the giver while `preparing`, on the gift wall once
// `revealed`. At most one gift in preparation per wish (invariant 3).
export const gifts = pgTable(
  'gifts',
  {
    ...spaceRecordColumns(),
    giverId: uuid('giver_id').notNull(),
    receiverId: uuid('receiver_id').notNull(),
    wishId: uuid('wish_id').references(() => wishes.id),
    name: text('name').notNull(),
    link: text('link'),
    ...previewColumns(),
    status: text('status', { enum: ['preparing', 'revealed'] }).notNull(),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
    revealedBy: uuid('revealed_by'),
    giftDate: date('gift_date'),
    dateSetBy: uuid('date_set_by'),
    dateSetAt: timestamp('date_set_at', { withTimezone: true }),
    occasion: text('occasion').$type<(typeof GiftOccasion.options)[number]>(),
    /** An anniversary as the occasion, with its name then, kept after it is deleted (anniversaries D4). */
    occasionAnniversaryId: uuid('occasion_anniversary_id').references(() => anniversaries.id),
    occasionName: text('occasion_name'),
    occasionSetBy: uuid('occasion_set_by'),
    occasionSetAt: timestamp('occasion_set_at', { withTimezone: true }),
  },
  (t) => [
    index('gifts_space').on(t.spaceId),
    uniqueIndex('gifts_preparing_wish')
      .on(t.wishId)
      .where(sql`${t.status} = 'preparing' and ${t.deletedAt} is null`),
    index('gifts_preview_pending')
      .on(t.createdAt)
      .where(sql`${t.link} is not null and ${t.previewReadAt} is null`),
    check(
      'gifts_status',
      sql`case ${t.status}
        when 'preparing' then ${t.privateTo} is not distinct from ${t.giverId}
          and num_nonnulls(${t.revealedAt}, ${t.revealedBy}, ${t.giftDate}) = 0
        when 'revealed' then ${t.privateTo} is null
          and num_nulls(${t.revealedAt}, ${t.revealedBy}, ${t.giftDate}) = 0
        else false end`,
    ),
    check('gifts_parties', sql`${t.giverId} <> ${t.receiverId}`),
    check('gifts_occasion', sql`${t.occasion} in (${sql.raw(quoted(GiftOccasion.options))})`),
    check('gifts_occasion_one', sql`${t.occasion} is null or ${t.occasionAnniversaryId} is null`),
    check(
      'gifts_occasion_name',
      sql`num_nulls(${t.occasionAnniversaryId}, ${t.occasionName}) in (0, 2)`,
    ),
    index('gifts_occasion_anniversary').on(t.occasionAnniversaryId),
    check('gifts_date_set', sql`num_nulls(${t.dateSetBy}, ${t.dateSetAt}) in (0, 2)`),
    check('gifts_occasion_set', sql`num_nulls(${t.occasionSetBy}, ${t.occasionSetAt}) in (0, 2)`),
    check('gifts_deleted', deletionCheck(t)),
  ],
);

// The giver's card of a gift (D3): a record of its own, because the gift may have been
// created by the receiver's "收到了", while the card's text is always the giver's.
export const giftCards = pgTable(
  'gift_cards',
  {
    ...spaceRecordColumns(),
    giftId: uuid('gift_id')
      .notNull()
      .references(() => gifts.id),
    body: text('body').notNull(),
  },
  (t) => [unique('gift_cards_gift').on(t.giftId), check('gift_cards_deleted', deletionCheck(t))],
);

// Anniversaries (anniversaries D1, D2, D7), repeating every year on the same month and day.
// The author owns kind, whose birthday, name and note; either of the two sets the date and
// the day count, whose current state lives here with who set it last.
export const anniversaries = pgTable(
  'anniversaries',
  {
    ...spaceRecordColumns(),
    kind: text('kind').$type<(typeof AnniversaryKind.options)[number]>().notNull(),
    birthdayOf: uuid('birthday_of'),
    name: text('name'),
    note: text('note'),
    year: smallint('year'),
    month: smallint('month').notNull(),
    day: smallint('day').notNull(),
    dateSetBy: uuid('date_set_by'),
    dateSetAt: timestamp('date_set_at', { withTimezone: true }),
    showCount: boolean('show_count').notNull(),
    countSetBy: uuid('count_set_by'),
    countSetAt: timestamp('count_set_at', { withTimezone: true }),
  },
  (t) => [
    index('anniversaries_space').on(t.spaceId),
    // At most one together day per space (invariant 1).
    uniqueIndex('anniversaries_together')
      .on(t.spaceId)
      .where(sql`${t.kind} = 'together' and ${t.deletedAt} is null`),
    check('anniversaries_kind', sql`${t.kind} in (${sql.raw(quoted(AnniversaryKind.options))})`),
    check(
      'anniversaries_kind_fields',
      sql`(${t.kind} = 'birthday') = (${t.birthdayOf} is not null)
        and (${t.kind} = 'other') = (${t.name} is not null)
        and (${t.kind} = 'birthday' or ${t.year} is not null)`,
    ),
    // A real calendar day; 2 月 29 日 without a year is a leap-day birthday.
    check(
      'anniversaries_date',
      sql`${t.month} between 1 and 12 and ${t.day} between 1 and 31
        and make_date(coalesce(${t.year}, 2000), ${t.month}, 1) + (${t.day} - 1)
          < make_date(coalesce(${t.year}, 2000), ${t.month}, 1) + interval '1 month'`,
    ),
    check('anniversaries_count', sql`not ${t.showCount} or ${t.year} is not null`),
    check('anniversaries_not_private', sql`${t.privateTo} is null`),
    check('anniversaries_date_set', sql`num_nulls(${t.dateSetBy}, ${t.dateSetAt}) in (0, 2)`),
    check('anniversaries_count_set', sql`num_nulls(${t.countSetBy}, ${t.countSetAt}) in (0, 2)`),
    check('anniversaries_deleted', deletionCheck(t)),
  ],
);

// Each person's own reminder per anniversary (D3, invariant 4): a personal setting, not a
// space record, so it has no history and stays editable after unbinding. No row means the
// default: 7 days, only the day itself for one's own birthday. `days` null is no reminder.
export const anniversaryReminders = pgTable(
  'anniversary_reminders',
  {
    userId: uuid('user_id').notNull(),
    anniversaryId: uuid('anniversary_id').notNull(),
    days: smallint('days'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.anniversaryId] }),
    check('anniversary_reminders_days', sql`${t.days} in (0, 1, 3, 7, 14, 30)`),
  ],
);

// What one person's partner sent them on the home and they have not seen yet (window-mascots
// D3): one row per binding period and recipient, counts only, deleted once both are shown.
// The sent-at columns only space out the partner's sends (one of each kind a second, D4); no
// history of who poked when is kept.
export const mascotPokes = pgTable(
  'mascot_pokes',
  {
    periodId: uuid('period_id')
      .notNull()
      .references(() => bindingPeriods.id),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id),
    pokes: integer('pokes').notNull().default(0),
    pets: integer('pets').notNull().default(0),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
    pokeSentAt: timestamp('poke_sent_at', { withTimezone: true }),
    petSentAt: timestamp('pet_sent_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.periodId, t.recipientId] }),
    check('mascot_pokes_counts', sql`${t.pokes} >= 0 and ${t.pets} >= 0`),
  ],
);

// Email reminders (email-reminders 技术设计). Settings default to on: no row is all three on.
// `hint_dismissed_at` is when the person closed the home notice that reminders are on (D8).
export const mailSettings = pgTable('mail_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  newContent: boolean('new_content').notNull().default(true),
  anniversary: boolean('anniversary').notNull().default(true),
  backup: boolean('backup').notNull().default(true),
  hintDismissedAt: timestamp('hint_dismissed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per person and source (D3, D4): a diary, a space record (a deletion note keeps
// its record's type and ID), an anniversary, or the backup (empty source ID). First seen
// is when something new there was first found, in the binding period it was found in, so
// a rebind starts the hour again. The notified mark is the record's `mark` a mail was
// accepted with; the key is an anniversary's target date or a backup reason, with when.
// The backup's first seen is when its current attention began, with no period.
export const mailMarks = pgTable(
  'mail_marks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    firstSeenPeriod: uuid('first_seen_period'),
    notifiedMark: integer('notified_mark'),
    notifiedKey: text('notified_key'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.source, t.sourceId] }),
    check(
      'mail_marks_source',
      sql`${t.source} in ('diary', 'shared_page', 'wish', 'gift', 'gift_card', 'anniversary', 'backup')`,
    ),
  ],
);

// The characters of a diary an accepted mail already reported to its reader (D3): the same
// form and merging as `diary_read_ranges`.
export const mailNotifiedRanges = pgTable(
  'mail_notified_ranges',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    diaryId: uuid('diary_id')
      .notNull()
      .references(() => diaries.id),
    clientId: int8('client_id').notNull(),
    clocks: int8multirange('clocks').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.diaryId, t.clientId] })],
);

// One mail (D10). Its ID is Resend's idempotency key. The rendering is written before the
// first request and cleared once accepted or stopped; `marks` are what acceptance writes.
// At most one `sending` row per person and category, whoever creates it.
export const mailSends = pgTable(
  'mail_sends',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    category: text('category').notNull(),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('sending'),
    subject: text('subject'),
    html: text('html'),
    textBody: text('text_body'),
    headers: jsonb('headers').$type<Record<string, string>>(),
    marks: jsonb('marks'),
    requested: boolean('requested').notNull().default(false),
    lastRequestedAt: timestamp('last_requested_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    errorCode: text('error_code'),
    providerId: text('provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    check('mail_sends_category', sql`${t.category} in ('new_content', 'anniversary', 'backup')`),
    check(
      'mail_sends_status',
      sql`${t.status} in ('sending', 'sent', 'cancelled', 'unknown', 'failed', 'abandoned')`,
    ),
    uniqueIndex('mail_sends_one_sending')
      .on(t.userId, t.category)
      .where(sql`${t.status} = 'sending'`),
    index('mail_sends_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'sending'`),
    index('mail_sends_recent').on(t.userId, t.category, t.createdAt),
  ],
);

// Auth layer tables, owned by Better Auth; exported so drizzle-kit migrates them with ours.
export * from './auth-schema.ts';
