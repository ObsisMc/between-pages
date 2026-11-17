import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { literal, parse, type ClockRange } from './reading.ts';
import type { Tx } from './store.ts';

// SQL of email reminders (email-reminders 技术设计): settings, what each person was already
// told, and the send records. Reminder rules live in `notify`; this module only reads and
// writes rows, inside the transaction it is given.

export type Category = 'new_content' | 'anniversary' | 'backup';
export type MarkSource =
  'diary' | 'shared_page' | 'wish' | 'gift' | 'gift_card' | 'anniversary' | 'backup';

export type Settings = {
  newContent: boolean;
  anniversary: boolean;
  backup: boolean;
  hintDismissed: boolean;
};

export type Person = {
  id: string;
  displayName: string;
  timezone: string | null;
  sleep: { start: number; end: number } | null;
};

export type Pair = { periodId: string; partner: { id: string; displayName: string } };

export type MarkRow = {
  source: MarkSource;
  sourceId: string;
  firstSeenAt: Date | null;
  firstSeenPeriod: string | null;
  notifiedMark: number | null;
  notifiedKey: string | null;
  notifiedAt: Date | null;
};

/** What an accepted mail writes (D10 第 3 步), and where its preview came from. */
export type SendMarks = {
  diaries: { diaryId: string; ranges: ClockRange[] }[];
  records: { source: MarkSource; id: string; mark: number }[];
  key: { source: 'anniversary' | 'backup'; id: string; key: string } | null;
  preview: { diaryId: string; ranges: ClockRange[] } | null;
};

export type SendStatus = 'sending' | 'sent' | 'cancelled' | 'unknown' | 'failed' | 'abandoned';

export type SendRow = {
  id: string;
  userId: string;
  category: Category;
  localDate: string;
  status: SendStatus;
  rendered: {
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
  } | null;
  marks: SendMarks | null;
  requested: boolean;
  attempts: number;
  createdAt: Date;
};

export const DEFAULT_SETTINGS: Settings = {
  newContent: true,
  anniversary: true,
  backup: true,
  hintDismissed: false,
};

type RawSend = {
  id: string;
  user_id: string;
  category: Category;
  local_date: string;
  status: SendStatus;
  subject: string | null;
  html: string | null;
  text_body: string | null;
  headers: Record<string, string> | null;
  marks: SendMarks | null;
  requested: boolean;
  attempts: number;
  created_at: Date | string;
};

const sendOf = (r: RawSend): SendRow => ({
  id: r.id,
  userId: r.user_id,
  category: r.category,
  localDate: typeof r.local_date === 'string' ? r.local_date : String(r.local_date),
  status: r.status,
  rendered:
    r.subject !== null && r.html !== null && r.text_body !== null
      ? { subject: r.subject, html: r.html, text: r.text_body, headers: r.headers ?? {} }
      : null,
  marks: r.marks,
  requested: r.requested,
  attempts: r.attempts,
  createdAt: new Date(r.created_at),
});

const SEND_COLUMNS = sql.raw(
  'id, user_id, category, local_date::text as local_date, status, subject, html, text_body, headers, marks, requested, attempts, created_at',
);

/** Statements in one transaction; `tx` may also be the pool for single statements. */
export class MailQueries {
  readonly tx: Tx | Db;
  constructor(tx: Tx | Db) {
    this.tx = tx;
  }

  async settings(userId: string): Promise<Settings> {
    const { rows } = await this.tx.execute<{
      new_content: boolean;
      anniversary: boolean;
      backup: boolean;
      hint_dismissed_at: Date | null;
    }>(sql`
      select new_content, anniversary, backup, hint_dismissed_at
      from mail_settings where user_id = ${userId}::uuid`);
    const row = rows[0];
    return row
      ? {
          newContent: row.new_content,
          anniversary: row.anniversary,
          backup: row.backup,
          hintDismissed: row.hint_dismissed_at !== null,
        }
      : DEFAULT_SETTINGS;
  }

  /** Writes the caller's own switches and, once, the time they closed the home notice. */
  async saveSettings(
    userId: string,
    change: Partial<Record<Category, boolean>> & { dismissHint?: boolean },
    now: Date,
  ): Promise<void> {
    const on = (c: Category) => change[c] ?? null;
    await this.tx.execute(sql`
      insert into mail_settings (user_id, new_content, anniversary, backup, hint_dismissed_at, updated_at)
      values (${userId}::uuid, coalesce(${on('new_content')}::boolean, true),
        coalesce(${on('anniversary')}::boolean, true), coalesce(${on('backup')}::boolean, true),
        ${change.dismissHint ? now : null}::timestamptz, ${now})
      on conflict (user_id) do update set
        new_content = coalesce(${on('new_content')}::boolean, mail_settings.new_content),
        anniversary = coalesce(${on('anniversary')}::boolean, mail_settings.anniversary),
        backup = coalesce(${on('backup')}::boolean, mail_settings.backup),
        hint_dismissed_at = coalesce(mail_settings.hint_dismissed_at, excluded.hint_dismissed_at),
        updated_at = excluded.updated_at`);
  }

  /** Turns one category off; never on (D8 退订). */
  async turnOff(userId: string, category: Category, now: Date): Promise<void> {
    await this.saveSettings(userId, { [category]: false }, now);
  }

  async person(userId: string): Promise<Person | null> {
    const { rows } = await this.tx.execute<{
      id: string;
      display_name: string;
      timezone: string | null;
      sleep_start_minute: number | null;
      sleep_end_minute: number | null;
    }>(sql`
      select id, display_name, timezone, sleep_start_minute, sleep_end_minute
      from users where id = ${userId}::uuid`);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      timezone: row.timezone,
      sleep:
        row.sleep_start_minute !== null && row.sleep_end_minute !== null
          ? { start: row.sleep_start_minute, end: row.sleep_end_minute }
          : null,
    };
  }

  /** The person's open binding with the partner's name, in this snapshot. */
  async pair(userId: string): Promise<Pair | null> {
    const { rows } = await this.tx.execute<{
      period_id: string;
      partner_id: string;
      display_name: string;
    }>(sql`
      select mine.period_id, other.user_id as partner_id, u.display_name
      from active_bindings mine
      join active_bindings other
        on other.period_id = mine.period_id and other.user_id <> mine.user_id
      join users u on u.id = other.user_id
      where mine.user_id = ${userId}::uuid`);
    const row = rows[0];
    return row
      ? { periodId: row.period_id, partner: { id: row.partner_id, displayName: row.display_name } }
      : null;
  }

  async marks(userId: string): Promise<MarkRow[]> {
    const { rows } = await this.tx.execute<{
      source: MarkSource;
      source_id: string;
      first_seen_at: Date | string | null;
      first_seen_period: string | null;
      notified_mark: number | null;
      notified_key: string | null;
      notified_at: Date | string | null;
    }>(sql`
      select source, source_id, first_seen_at, first_seen_period, notified_mark, notified_key,
        notified_at
      from mail_marks where user_id = ${userId}::uuid`);
    const date = (v: Date | string | null) => (v === null ? null : new Date(v));
    return rows.map((r) => ({
      source: r.source,
      sourceId: r.source_id,
      firstSeenAt: date(r.first_seen_at),
      firstSeenPeriod: r.first_seen_period,
      notifiedMark: r.notified_mark,
      notifiedKey: r.notified_key,
      notifiedAt: date(r.notified_at),
    }));
  }

  /** The characters accepted mails already reported to the person, by diary. */
  async notifiedRanges(userId: string): Promise<Map<string, ClockRange[]>> {
    const { rows } = await this.tx.execute<{ diary_id: string; client_id: number; clocks: string }>(
      sql`
      select diary_id, client_id, clocks::text as clocks from mail_notified_ranges
      where user_id = ${userId}::uuid order by diary_id, client_id`,
    );
    const out = new Map<string, ClockRange[]>();
    for (const row of rows) {
      const ranges = parse(Number(row.client_id), row.clocks);
      out.set(row.diary_id, [...(out.get(row.diary_id) ?? []), ...ranges]);
    }
    return out;
  }

  /** Records when something new was first found at a source, unless already found in `period`. */
  async firstSeen(
    userId: string,
    source: MarkSource,
    sourceId: string,
    at: Date,
    period: string | null,
  ): Promise<void> {
    await this.tx.execute(sql`
      insert into mail_marks (user_id, source, source_id, first_seen_at, first_seen_period)
      values (${userId}::uuid, ${source}, ${sourceId}, ${at}, ${period}::uuid)
      on conflict (user_id, source, source_id) do update set
        first_seen_at = excluded.first_seen_at, first_seen_period = excluded.first_seen_period
      where mail_marks.first_seen_at is null
        or mail_marks.first_seen_period is distinct from excluded.first_seen_period`);
  }

  /** Clears first seen at these sources but the ones in `keep` (`source:id`). */
  async forget(userId: string, sources: readonly MarkSource[], keep: readonly string[]) {
    await this.tx.execute(sql`
      update mail_marks set first_seen_at = null, first_seen_period = null
      where user_id = ${userId}::uuid and first_seen_at is not null
        and source in (${sql.join(
          sources.map((s) => sql`${s}`),
          sql`, `,
        )})
        and source || ':' || source_id not in (
          select jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb))`);
  }

  /** When the last mail of this category counting toward limits went out (D4). */
  async lastSent(userId: string, category: Category): Promise<Date | null> {
    const { rows } = await this.tx.execute<{ at: Date | string | null }>(sql`
      select max(case when status = 'sent' then sent_at else last_requested_at end) as at
      from mail_sends
      where user_id = ${userId}::uuid and category = ${category} and status in ('sent', 'unknown')`);
    const at = rows[0]?.at;
    return at ? new Date(at) : null;
  }

  /** How many mails of this category count toward the recipient's local date. */
  async sentOn(userId: string, category: Category, localDate: string): Promise<number> {
    const { rows } = await this.tx.execute<{ n: number }>(sql`
      select count(*)::int as n from mail_sends
      where user_id = ${userId}::uuid and category = ${category}
        and local_date = ${localDate}::date and status in ('sent', 'unknown')`);
    return rows[0]?.n ?? 0;
  }

  /** Whether a mail of this category was refused for good since `since`. */
  async failedSince(userId: string, category: Category, since: Date): Promise<boolean> {
    const { rows } = await this.tx.execute<{ found: boolean }>(sql`
      select exists (
        select 1 from mail_sends
        where user_id = ${userId}::uuid and category = ${category} and status = 'failed'
          and coalesce(sent_at, created_at) > ${since}
      ) as found`);
    return rows[0]?.found ?? false;
  }

  /** Opens a send record; false when one of this category is already sending. */
  async open(id: string, userId: string, category: Category, localDate: string, now: Date) {
    const { rows } = await this.tx.execute<{ id: string }>(sql`
      insert into mail_sends (id, user_id, category, local_date, next_attempt_at, created_at)
      values (${id}::uuid, ${userId}::uuid, ${category}, ${localDate}::date, ${now}, ${now})
      on conflict (user_id, category) where status = 'sending' do nothing
      returning id`);
    return rows.length > 0;
  }

  /**
   * Takes one due sending record and pushes its next attempt to `leaseUntil`, so no other
   * worker takes it meanwhile (D10 第 2 步).
   */
  async lease(now: Date, leaseUntil: Date): Promise<SendRow | null> {
    const { rows } = await this.tx.execute<RawSend>(sql`
      with due as (
        select id from mail_sends
        where status = 'sending' and next_attempt_at <= ${now}
        order by next_attempt_at limit 1
        for update skip locked
      )
      update mail_sends set next_attempt_at = ${leaseUntil}
      from due where mail_sends.id = due.id
      returning ${sql.raw(
        'mail_sends.id, user_id, category, local_date::text as local_date, status, subject, html, text_body, headers, marks, requested, attempts, created_at',
      )}`);
    return rows[0] ? sendOf(rows[0]) : null;
  }

  async send(id: string): Promise<SendRow | null> {
    const { rows } = await this.tx.execute<RawSend>(
      sql`select ${SEND_COLUMNS} from mail_sends where id = ${id}::uuid`,
    );
    return rows[0] ? sendOf(rows[0]) : null;
  }

  /** Stores the content of a first request, which is then fixed for every retry. */
  async prepare(id: string, rendered: NonNullable<SendRow['rendered']>, marks: SendMarks) {
    await this.tx.execute(sql`
      update mail_sends set subject = ${rendered.subject}, html = ${rendered.html},
        text_body = ${rendered.text}, headers = ${JSON.stringify(rendered.headers)}::jsonb,
        marks = ${JSON.stringify(marks)}::jsonb
      where id = ${id}::uuid and status = 'sending'`);
  }

  /** Records that a request is about to leave; written before the request, so a crash after it is known. */
  async requesting(id: string, now: Date, leaseUntil: Date) {
    await this.tx.execute(sql`
      update mail_sends set requested = true, last_requested_at = ${now},
        attempts = attempts + 1, next_attempt_at = ${leaseUntil}
      where id = ${id}::uuid and status = 'sending'`);
  }

  /** Accepted: the provider's ID, `sent`, the marks, and no stored rendering (D10 第 3 步). */
  async accept(id: string, userId: string, providerId: string, marks: SendMarks, now: Date) {
    const { rows } = await this.tx.execute<{ id: string }>(sql`
      update mail_sends set status = 'sent', provider_id = ${providerId}, sent_at = ${now},
        error_code = null, subject = null, html = null, text_body = null, headers = null
      where id = ${id}::uuid and status = 'sending'
      returning id`);
    if (!rows.length) return;
    for (const { diaryId, ranges } of marks.diaries) {
      const byClient = Map.groupBy(ranges, (r) => r.clientId);
      for (const [clientId, own] of byClient)
        await this.tx.execute(sql`
          insert into mail_notified_ranges (user_id, diary_id, client_id, clocks)
          values (${userId}::uuid, ${diaryId}::uuid, ${clientId}, ${literal(own)}::int8multirange)
          on conflict (user_id, diary_id, client_id) do update
            set clocks = mail_notified_ranges.clocks + excluded.clocks`);
    }
    for (const record of marks.records)
      await this.tx.execute(sql`
        insert into mail_marks (user_id, source, source_id, notified_mark)
        values (${userId}::uuid, ${record.source}, ${record.id}, ${record.mark})
        on conflict (user_id, source, source_id) do update
          set notified_mark = greatest(coalesce(mail_marks.notified_mark, 0), excluded.notified_mark)`);
    if (marks.key)
      await this.tx.execute(sql`
        insert into mail_marks (user_id, source, source_id, notified_key, notified_at)
        values (${userId}::uuid, ${marks.key.source}, ${marks.key.id}, ${marks.key.key}, ${now})
        on conflict (user_id, source, source_id) do update
          set notified_key = excluded.notified_key, notified_at = excluded.notified_at`);
  }

  /** Ends a record without acceptance; the stored rendering is cleared. */
  async close(
    id: string,
    status: Exclude<SendStatus, 'sending' | 'sent'>,
    code: string | null,
    now: Date,
  ) {
    await this.tx.execute(sql`
      update mail_sends set status = ${status}, error_code = ${code}, sent_at = ${now},
        subject = null, html = null, text_body = null, headers = null
      where id = ${id}::uuid and status = 'sending'`);
  }

  /** Comes back to the record at `at`. */
  async later(id: string, at: Date, code: string | null) {
    await this.tx.execute(sql`
      update mail_sends set next_attempt_at = ${at}, error_code = coalesce(${code}, error_code)
      where id = ${id}::uuid and status = 'sending'`);
  }
}

export function createMailStore(db: Db) {
  return {
    /** One snapshot, writable, for a reminder decision (D9 第 2 条). */
    snapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(fn, { isolationLevel: 'repeatable read' });
    },
    write<T>(fn: (q: MailQueries) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(new MailQueries(tx)));
    },
    queries: new MailQueries(db),
  };
}

export type MailStore = ReturnType<typeof createMailStore>;
