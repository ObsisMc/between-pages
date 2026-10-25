import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Domain users (authentication-and-sessions ADR): written only by our code, keyed by the
// same UUID the auth layer issues. No email, no login method, and no foreign key into
// the auth_* tables, so the auth layer can change without touching diaries or authorship.
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

// Auth layer tables, owned by Better Auth; exported so drizzle-kit migrates them with ours.
export * from './auth-schema.ts';
