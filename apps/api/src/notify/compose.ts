import type { ResponseOf } from '@between-pages/contracts';
import { previewOf, type BackupMail, type Mail } from '../mail/render.ts';
import type { FreshDiary } from '../reader/reader.ts';
import type { MarkRow, MarkSource, Pair, Person, SendMarks } from '../store/mail.ts';
import type { ClockRange } from '../store/reading.ts';
import type { Tx } from '../store/store.ts';

// What a reminder would say right now (email-reminders D3, D5–D7), from the services that
// own each rule: list unread from `reader`, the entry dots' lists from `wishes` and
// `shared-pages`, `due` from `anniversaries`, the home banner's reason from `backup`. Nothing
// here decides unread itself; it only takes away what accepted mails already reported.

/** A record an entry dot counts, as `wishes` and `shared-pages` list them (space-records D8). */
type UnreadItem = { type: string; id: string; mark: number };

/** The services a reminder reads, built over one snapshot's transaction. */
export type Sources = {
  freshDiaries(
    viewer: string,
    notified: ReadonlyMap<string, readonly ClockRange[]>,
    now: Date,
  ): Promise<FreshDiary[]>;
  wishItems(viewer: string): Promise<readonly UnreadItem[] | 'NOT_FOUND'>;
  pageItems(viewer: string): Promise<readonly UnreadItem[] | 'NOT_FOUND'>;
  anniversaries(
    viewer: string,
    zone: string,
    now: Date,
  ): Promise<ResponseOf<'anniversaries'> | 'NOT_FOUND'>;
  backupAttention(viewer: string, now: Date): Promise<BackupMail['reason'] | null>;
};

/** Builds `Sources` over a transaction; inner transactions become its savepoints. */
export type Scope = (tx: Tx) => Sources;

export type Content = { mail: Mail; marks: SendMarks };

/** The sources "有新内容" watches: diaries and the space records of D3. */
export const CONTENT_SOURCES: MarkSource[] = ['diary', 'shared_page', 'wish', 'gift', 'gift_card'];

const keyOf = (source: string, id: string) => `${source}:${id}`;
const plain = ({ clientId, from, to }: ClockRange): ClockRange => ({ clientId, from, to });

export type NewContent = {
  /** Null when nothing is new. */
  content: Content | null;
  /** Each source holding something new, for first-seen times (D4). */
  sources: { source: MarkSource; id: string }[];
  /** Every diary with another author's text, read or not, for the preview check (D10). */
  diaries: FreshDiary[];
};

/** "有新内容" as of this snapshot: what is new and not yet reported, and its mail (D3, D5). */
export async function newContent(
  sources: Sources,
  viewer: Person,
  pair: Pair,
  marks: readonly MarkRow[],
  notified: ReadonlyMap<string, readonly ClockRange[]>,
  now: Date,
  thisYear: number,
): Promise<NewContent> {
  const all = await sources.freshDiaries(viewer.id, notified, now);
  const diaries = all.filter((d) => d.fresh.length > 0);
  const told = new Map(
    marks.flatMap((m) =>
      m.notifiedMark === null ? [] : [[keyOf(m.source, m.sourceId), m.notifiedMark] as const],
    ),
  );
  const fresh = (items: readonly UnreadItem[] | 'NOT_FOUND') =>
    items === 'NOT_FOUND'
      ? []
      : items.filter((item) => item.mark > (told.get(keyOf(item.type, item.id)) ?? 0));
  const wishes = fresh(await sources.wishItems(viewer.id));
  const pages = fresh(await sources.pageItems(viewer.id));
  const records = [...pages, ...wishes].map((item) => ({
    source: item.type as MarkSource,
    id: item.id,
    mark: item.mark,
  }));
  const found = [
    ...diaries.map((d) => ({ source: 'diary' as const, id: d.diaryId })),
    ...records.map(({ source, id }) => ({ source, id })),
  ];
  if (!found.length) return { content: null, sources: [], diaries: all };

  const latest = diaries.toSorted((a, b) => b.diaryDate.localeCompare(a.diaryDate))[0];
  const first = latest?.fresh[0];
  return {
    content: {
      mail: {
        category: 'new_content',
        partnerName: pair.partner.displayName,
        diaryDates: diaries.map((d) => d.diaryDate),
        sharedPages: pages.length > 0,
        wishes: wishes.length > 0,
        preview: latest && first ? { date: latest.diaryDate, text: first.text } : null,
        thisYear,
      },
      marks: {
        diaries: diaries.map((d) => ({ diaryId: d.diaryId, ranges: d.fresh.map(plain) })),
        records,
        key: null,
        preview:
          latest && first
            ? {
                diaryId: latest.diaryId,
                ranges: [
                  {
                    clientId: first.clientId,
                    from: first.from,
                    to: first.from + previewOf(first.text).units,
                  },
                ],
              }
            : null,
      },
    },
    sources: found,
    diaries: all,
  };
}

const overlaps = (a: ClockRange, b: ClockRange) =>
  a.clientId === b.clientId && a.from < b.to && b.from < a.to;

/** Whether `inner` lies within the union of `outer` (same writer instance). */
function within(inner: ClockRange, outer: readonly ClockRange[]): boolean {
  let at = inner.from;
  for (const r of outer
    .filter((o) => o.clientId === inner.clientId)
    .toSorted((a, b) => a.from - b.from)) {
    if (r.to <= at) continue;
    if (r.from > at) return false;
    at = r.to;
    if (at >= inner.to) return true;
  }
  return at >= inner.to;
}

/**
 * For a mail already requested once (D10 复查): whether any of what it reported is still
 * new now, and whether every character of its preview still exists.
 */
export function stillStands(
  stored: SendMarks,
  now: NewContent,
): { anyNew: boolean; previewKept: boolean } {
  const current = now.content?.marks;
  const freshNow = new Map((current?.diaries ?? []).map((d) => [d.diaryId, d.ranges]));
  const recordsNow = new Set((current?.records ?? []).map((r) => keyOf(r.source, r.id)));
  const anyNew =
    stored.diaries.some((d) =>
      d.ranges.some((r) => (freshNow.get(d.diaryId) ?? []).some((f) => overlaps(r, f))),
    ) || stored.records.some((r) => recordsNow.has(keyOf(r.source, r.id)));
  const preview = stored.preview;
  const others = preview && now.diaries.find((d) => d.diaryId === preview.diaryId)?.others;
  const previewKept = !preview || preview.ranges.every((r) => within(r, others ?? []));
  return { anyNew, previewKept };
}

/** The first due anniversary not yet mailed for its target date (D6). */
export async function anniversary(
  sources: Sources,
  viewer: Person,
  pair: Pair,
  marks: readonly MarkRow[],
  now: Date,
): Promise<Content | null> {
  const view = await sources.anniversaries(viewer.id, viewer.timezone ?? 'UTC', now);
  if (view === 'NOT_FOUND' || view.readOnly) return null;
  const told = new Map(
    marks.filter((m) => m.source === 'anniversary').map((m) => [m.sourceId, m.notifiedKey]),
  );
  const a = view.anniversaries.find((x) => x.due && told.get(x.id) !== x.next.date);
  if (!a) return null;
  return {
    mail: {
      category: 'anniversary',
      anniversaryId: a.id,
      kind: a.kind,
      birthdayOf: a.birthdayOf === null ? null : a.birthdayOf === viewer.id ? 'me' : 'partner',
      name: a.name,
      type: a.next.type,
      years: a.next.years,
      count: a.next.count,
      daysLeft: a.next.daysLeft,
      partnerName: pair.partner.displayName,
    },
    marks: {
      diaries: [],
      records: [],
      key: { source: 'anniversary', id: a.id, key: a.next.date },
      preview: null,
    },
  };
}

/**
 * The backup mail for the current home-banner reason, unless this reason was mailed in the
 * current run of attention (`since`) or within a day (D7).
 */
export function backup(
  reason: BackupMail['reason'] | null,
  row: MarkRow | undefined,
  since: Date,
  now: Date,
  pauseMs: number,
): Content | null {
  if (!reason) return null;
  const mailed =
    row?.notifiedKey === reason &&
    row.notifiedAt !== null &&
    (row.notifiedAt >= since || now.getTime() - row.notifiedAt.getTime() < pauseMs);
  if (mailed) return null;
  return {
    mail: { category: 'backup', reason },
    marks: {
      diaries: [],
      records: [],
      key: { source: 'backup', id: '', key: reason },
      preview: null,
    },
  };
}
