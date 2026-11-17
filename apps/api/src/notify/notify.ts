import { randomUUID } from 'node:crypto';
import { dateIn } from '@between-pages/time';
import type { Addresses } from '../auth/email.ts';
import { renderMail, type Rendered } from '../mail/render.ts';
import type { Mailer } from '../mail/resend.ts';
import { unsubscribeToken } from '../mail/tokens.ts';
import {
  MailQueries,
  type Category,
  type MailStore,
  type Person,
  type SendMarks,
  type SendRow,
  type Settings,
} from '../store/mail.ts';
import type { Tx } from '../store/store.ts';
import {
  CONTENT_SOURCES,
  anniversary,
  backup,
  newContent,
  stillStands,
  type Content,
  type Scope,
  type Sources,
} from './compose.ts';
import {
  GAP_MS,
  GIVE_UP_MS,
  LEASE_MS,
  PAUSE_MS,
  PER_DAY,
  UNREAD_FOR_MS,
  backoffMs,
  localDateOf,
  nextLocalDay,
  quietAt,
  quietUntil,
  quotaResets,
} from './rules.ts';

// Email reminders in the worker (email-reminders D4, D9, D10). `judge` decides, every five
// minutes, who gets a mail and opens its send record; `sendNext` takes one due record,
// rechecks it in one snapshot, renders it before its first request and sends the same
// content on every retry under the record's ID. Only an accepted mail writes what it
// reported. Logs carry user and record IDs, categories and provider codes, never an
// address, a subject or diary text (invariant 10).

export type NotifyDeps = {
  store: MailStore;
  scope: Scope;
  addresses: Addresses;
  mailer: Mailer;
  tokenKey: Buffer;
  origin: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

const SWITCH: Record<Category, keyof Omit<Settings, 'hintDismissed'>> = {
  new_content: 'newContent',
  anniversary: 'anniversary',
  backup: 'backup',
};

const markKey = (s: { source: string; id: string }) => `${s.source}:${s.id}`;

export function createNotify(deps: NotifyDeps) {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const quotaLogged = new Set<string>();

  /**
   * One snapshot for a decision: the mail tables and every service the content comes from
   * read the same committed state (D9 第 2 条).
   */
  const snapshot = <T>(fn: (q: MailQueries, sources: Sources) => Promise<T>) =>
    deps.store.snapshot((tx: Tx) => fn(new MailQueries(tx), deps.scope(tx)));

  /** When this category may next go out to the recipient, or null for now (D4, D10). */
  async function waitUntil(
    q: MailQueries,
    person: Person,
    category: Category,
    t: number,
  ): Promise<number | null> {
    if (quietAt(t, person)) return quietUntil(t, person);
    if (category !== 'new_content') return null;
    const last = await q.lastSent(person.id, category);
    if (last && t - last.getTime() < GAP_MS) return last.getTime() + GAP_MS;
    if ((await q.sentOn(person.id, category, localDateOf(t, person))) >= PER_DAY)
      return nextLocalDay(t, person);
    return null;
  }

  async function open(q: MailQueries, person: Person, category: Category, now: Date) {
    const t = now.getTime();
    if (await q.failedSince(person.id, category, new Date(t - PAUSE_MS))) return;
    if ((await waitUntil(q, person, category, t)) !== null) return;
    if (await q.open(randomUUID(), person.id, category, localDateOf(t, person), now))
      log(`notify: opened a ${category} mail for user ${person.id}`);
  }

  /** The content of `category` as of this snapshot, or null when there is nothing to say. */
  async function compose(
    q: MailQueries,
    sources: Sources,
    person: Person,
    category: Category,
    now: Date,
  ) {
    const pair = await q.pair(person.id);
    const marks = await q.marks(person.id);
    if (category === 'backup') {
      const reason = await sources.backupAttention(person.id, now);
      const row = marks.find((m) => m.source === 'backup');
      return {
        content: backup(reason, row, row?.firstSeenAt ?? now, now, PAUSE_MS),
        current: null,
      };
    }
    if (!pair) return { content: null, current: null };
    if (category === 'anniversary')
      return { content: await anniversary(sources, person, pair, marks, now), current: null };
    const year = dateIn(now.getTime(), person.timezone ?? 'UTC').year;
    const current = await newContent(
      sources,
      person,
      pair,
      marks,
      await q.notifiedRanges(person.id),
      now,
      year,
    );
    return { content: current.content, current };
  }

  async function judgeOne(userId: string, now: Date) {
    const t = now.getTime();
    await snapshot(async (q, sources) => {
      const person = await q.person(userId);
      if (!person) return;
      const settings = await q.settings(userId);
      const pair = await q.pair(userId);
      const marks = await q.marks(userId);

      // D4 第 1–2 步: first-seen times, cleared once nothing is new, unbound, or switched off.
      if (settings.newContent && pair) {
        const year = dateIn(t, person.timezone ?? 'UTC').year;
        const found = await newContent(
          sources,
          person,
          pair,
          marks,
          await q.notifiedRanges(userId),
          now,
          year,
        );
        const seen = new Map(
          marks
            .filter((m) => m.firstSeenAt && m.firstSeenPeriod === pair.periodId)
            .map((m) => [markKey({ source: m.source, id: m.sourceId }), m.firstSeenAt!]),
        );
        for (const s of found.sources)
          await q.firstSeen(userId, s.source, s.id, now, pair.periodId);
        await q.forget(userId, CONTENT_SOURCES, found.sources.map(markKey));
        const earliest = Math.min(
          ...found.sources.map((s) => seen.get(markKey(s))?.getTime() ?? t),
        );
        if (found.content && earliest <= t - UNREAD_FOR_MS)
          await open(q, person, 'new_content', now);
      } else await q.forget(userId, CONTENT_SOURCES, []);

      if (settings.anniversary && pair) {
        const content = await anniversary(sources, person, pair, marks, now);
        if (content) await open(q, person, 'anniversary', now);
      }

      const reason = settings.backup ? await sources.backupAttention(userId, now) : null;
      if (!reason) await q.forget(userId, ['backup'], []);
      else {
        await q.firstSeen(userId, 'backup', '', now, null);
        const row = marks.find((m) => m.source === 'backup');
        if (backup(reason, row, row?.firstSeenAt ?? now, now, PAUSE_MS))
          await open(q, person, 'backup', now);
      }
    });
  }

  /**
   * D10 第 2 步 in one snapshot: recheck, then either store the content of a first request
   * or reuse the stored one. Returns what to send, or null when the record was put off or
   * closed.
   */
  async function prepare(
    row: SendRow,
    now: Date,
  ): Promise<{ rendered: Rendered; marks: SendMarks } | null> {
    const t = now.getTime();
    return snapshot(async (q, sources) => {
      const stop = async (code: string) => {
        await q.close(row.id, row.requested ? 'unknown' : 'cancelled', code, now);
        log(`notify: ${row.requested ? 'stopped' : 'cancelled'} mail ${row.id} (${code})`);
        return null;
      };
      const person = await q.person(row.userId);
      if (!person) return stop('no_user');
      if (!(await q.settings(row.userId))[SWITCH[row.category]]) return stop('switched_off');
      if (row.category !== 'backup' && !(await q.pair(row.userId))) return stop('unbound');
      const wait = await waitUntil(q, person, row.category, t);
      if (wait !== null) {
        await q.later(row.id, new Date(wait), null);
        return null;
      }
      const { content, current } = await compose(q, sources, person, row.category, now);
      const lease = new Date(t + LEASE_MS);
      if (!row.requested) {
        if (!content) return stop('nothing_new');
        const rendered = await renderMail(content.mail, {
          origin: deps.origin,
          token: unsubscribeToken(deps.tokenKey, row.userId, row.category),
        });
        await q.prepare(row.id, rendered, content.marks);
        await q.requesting(row.id, now, lease);
        return { rendered, marks: content.marks };
      }
      // Requested before: the stored content goes out again unchanged (invariant 8).
      const marks = row.marks!;
      if (!stands(row.category, marks, content, current)) return stop('nothing_new');
      if (current && !stillStands(marks, current).previewKept) return stop('preview_deleted');
      await q.requesting(row.id, now, lease);
      return { rendered: row.rendered!, marks };
    });
  }

  /** Whether what a requested mail reported is still new in some part (D10 复查不通过时). */
  function stands(
    category: Category,
    stored: SendMarks,
    content: Content | null,
    current: Awaited<ReturnType<typeof compose>>['current'],
  ): boolean {
    if (category === 'new_content') return !!current && stillStands(stored, current).anyNew;
    return content?.marks.key?.key === stored.key?.key && content?.marks.key?.id === stored.key?.id;
  }

  async function deliver(row: SendRow, now: Date) {
    const t = now.getTime();
    if (t - row.createdAt.getTime() >= GIVE_UP_MS) {
      const status = row.requested ? 'unknown' : 'abandoned';
      await deps.store.write((q) => q.close(row.id, status, 'gave_up', now));
      log(`notify: mail ${row.id} ${status} after 24 hours`);
      return;
    }
    const ready = await prepare(row, now);
    if (!ready) return;
    const to = await deps.addresses.emailOf(row.userId);
    if (!to) {
      await deps.store.write((q) => q.close(row.id, 'failed', 'no_address', now));
      warn(`notify: user ${row.userId} has no address; mail ${row.id} failed`);
      return;
    }
    const outcome = await deps.mailer.send(to, ready.rendered, row.id);
    const after = (ms: number, code: string) =>
      deps.store.write((q) => q.later(row.id, new Date(t + ms), code));
    switch (outcome.kind) {
      case 'accepted':
        await deps.store.write((q) =>
          q.accept(row.id, row.userId, outcome.providerId, ready.marks, now),
        );
        log(`notify: sent ${row.category} mail ${row.id} to user ${row.userId}`);
        return;
      case 'unknown':
        if (outcome.code === 'invalid_idempotent_request')
          warn(`notify: Resend saw other content under mail ${row.id}'s key`);
        await after(backoffMs(row.attempts + 1), outcome.code);
        log(`notify: mail ${row.id} outcome unknown (${outcome.code}); retrying`);
        return;
      case 'later':
        await after(outcome.afterMs, outcome.code);
        return;
      case 'quota': {
        const resets = quotaResets(t, outcome.period);
        await deps.store.write((q) => q.later(row.id, new Date(resets), outcome.code));
        const key = `${outcome.period} ${resets}`;
        if (!quotaLogged.has(key)) {
          quotaLogged.add(key);
          warn(`notify: Resend ${outcome.period} quota used up; mails wait until it resets`);
        }
        return;
      }
      case 'rejected':
        await deps.store.write((q) => q.close(row.id, 'failed', outcome.code, now));
        warn(`notify: Resend refused mail ${row.id} (${outcome.code}); paused for 24 hours`);
        return;
    }
  }

  return {
    /** Decides for everyone with an address who gets a mail now, and opens its record (D4, D6, D7). */
    async judge(now: Date): Promise<void> {
      for (const userId of await deps.addresses.recipients()) {
        try {
          await judgeOne(userId, now);
        } catch (error) {
          warn(`notify: judging user ${userId} failed: ${(error as Error).message}`);
        }
      }
    },

    /** Takes one due send record and works it; false when none is due. */
    async sendNext(now: Date): Promise<boolean> {
      const row = await deps.store.write((q) => q.lease(now, new Date(now.getTime() + LEASE_MS)));
      if (!row) return false;
      await deliver(row, now);
      return true;
    },
  };
}

export type Notify = ReturnType<typeof createNotify>;
