import * as Y from 'yjs';
import { BODY, authorRuns } from '@between-pages/collab';
import { VersionUnreadable } from '../errors.ts';
import type { DiaryEvent } from '../events/events.ts';
import type { EpochRow } from '../store/boundaries.ts';
import type { ClockRange } from '../store/reading.ts';
import type { CommitPoint, DiaryQueries, DiaryRow, Store } from '../store/store.ts';

// The authorized-state reader (kernel D17): the only producer of what a diary's partner
// sees. Its input is (diary, viewer, epoch or version). A partner reads an epoch's
// baseline and the commits stamped with that epoch, never past its frozen version, never
// a private commit, and opens or follows live only the diary's current generation. History
// computed elsewhere starts from the timeline this module authorizes. The day list is built
// here too, the viewer's own diaries beside the partner's, with its unread marks
// (unread-and-day-page D2, D3).

/** A partner's view of one shared diary (D10 "打开共享/冻结版本"). */
export type SharedView = {
  diaryId: string;
  diaryDate: string;
  ownerId: string;
  epochId: string;
  share: 'live' | 'frozen';
  generationId: string;
  seq: number;
  state: Uint8Array;
  bindings: Map<number, string>;
};

export type SharedCatchUp = {
  seq: number;
  commits: { seq: number; publicId: string; delta: Uint8Array }[];
  bindings: Map<number, string>;
};

/**
 * One subscription of a socket: the owner's (no epoch) or a partner's live epoch.
 * `stopped` is set once its epoch's stop notice reached it: no private caret follows.
 */
export type Subscription = {
  viewer: string;
  generationId: string;
  epochId: string | null;
  stopped?: boolean;
};

export type SharedSummary = {
  diaryId: string;
  diaryDate: string;
  ownerId: string;
  epochId: string;
  share: 'live' | 'frozen';
  excerpt: string | null;
  updatedAt: Date;
};

export type CharacterInfo = { author: string; writtenAt: Date; clockAdjusted: boolean };

/** The caller's own diary on the day list (unread-and-day-page D3). */
export type OwnDayCard = {
  diaryId: string;
  excerpt: string | null;
  updatedAt: Date;
  hasText: boolean;
  unread: boolean;
  sharedWithPartner: boolean;
};

/** The partner's diary on the day list, by its live share or else its last frozen one. */
export type PartnerDayCard = {
  diaryId: string;
  epochId: string;
  share: 'live' | 'frozen';
  excerpt: string | null;
  updatedAt: Date;
  hasText: boolean;
  unread: boolean;
};

export type DayCard = {
  diaryDate: string;
  mine: OwnDayCard | null;
  partner: PartnerDayCard | null;
};

/** What `dayCopy` finds: the timelines are authorized for the viewer, as history uses them. */
export type DayCopySource = {
  mine: { diaryId: string; timeline: CommitPoint[] } | null;
  partner: {
    diaryId: string;
    ownerId: string;
    epochId: string;
    share: 'live' | 'frozen';
    timeline: CommitPoint[];
  } | null;
};

/**
 * The commit of the newest history point of a timeline (kernel D6), or null before any;
 * the history service owns the grouping rule and its idle time.
 */
export type SettledPoint = (timeline: readonly CommitPoint[]) => CommitPoint | null;

export const SHARED_PAGE_SIZE = 30;
export const DAYS_PAGE_SIZE = 20;
/** Characters, not UTF-16 units, as on the owner's list. */
const EXCERPT_LENGTH = 80;
/** A writer clock this far ahead of the server's receipt is not shown (kernel D15). */
const CLOCK_TOLERANCE_MS = 60_000;

const excerptOf = (text: string) =>
  Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, EXCERPT_LENGTH).join('');

/** The last version an epoch authorizes: where it froze, or the diary's current one while live. */
const boundOf = (epoch: EpochRow, diary: DiaryRow) => epoch.frozenVersion ?? diary.version;

/** Bindings of the clientIDs that appear in `doc`, so no unauthorized writer instance is named. */
function bindingsIn(doc: Y.Doc, all: Map<number, string>): Map<number, string> {
  const out = new Map<number, string>();
  for (const client of Y.decodeStateVector(Y.encodeStateVector(doc)).keys()) {
    const user = all.get(client);
    if (user) out.set(client, user);
  }
  return out;
}

/** Whether some clock in `[from, to)` lies outside every range of `covered`, sorted by `from`. */
function uncovered(from: number, to: number, covered: readonly ClockRange[]): boolean {
  let at = from;
  for (const range of covered) {
    if (range.to <= at) continue;
    if (range.from > at) return true;
    at = range.to;
    if (at >= to) return false;
  }
  return at < to;
}

/**
 * Whether `viewer` has list unread in `doc` (unread-and-day-page D2): a visible character
 * another author wrote that is neither in the viewer's read coverage nor inserted after
 * `cutoff`, the version of the newest history point. Character identity decides, never a
 * version or time comparison of the whole diary (invariant 2).
 */
async function listUnread(
  queries: DiaryQueries,
  viewer: string,
  diaryId: string,
  doc: Y.Doc,
  cutoff: number,
  bound: number,
): Promise<boolean> {
  const others = authorRuns(doc, await queries.bindings(diaryId)).filter(
    (run) => run.author !== viewer,
  );
  if (!others.length) return false;
  const covered = await queries.readRanges(viewer, diaryId);
  if (cutoff < bound) covered.push(...(await queries.insertedAfter(diaryId, cutoff)));
  const byClient = Map.groupBy(
    covered.sort((a, b) => a.from - b.from),
    (range) => range.clientId,
  );
  return others.some((run) =>
    uncovered(run.clock, run.clock + run.text.length, byClient.get(run.client) ?? []),
  );
}

/** The list facts of one text; an unreadable one keeps its card without them. */
async function summarize(
  build: () => Promise<Y.Doc>,
  unread: (doc: Y.Doc) => Promise<boolean>,
): Promise<{ excerpt: string | null; hasText: boolean; unread: boolean }> {
  let doc: Y.Doc;
  try {
    doc = await build();
  } catch (error) {
    if (!(error instanceof VersionUnreadable)) throw error;
    return { excerpt: null, hasText: false, unread: false };
  }
  const excerpt = excerptOf(doc.getText(BODY).toString());
  return { excerpt, hasText: excerpt !== '', unread: await unread(doc) };
}

const dayAfter = (date: string) =>
  new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);

function clientsOf(deltas: readonly Uint8Array[], all: Map<number, string>) {
  const out = new Map<number, string>();
  for (const delta of deltas)
    for (const struct of Y.decodeUpdate(delta).structs) {
      const user = all.get(struct.id.client);
      if (user) out.set(struct.id.client, user);
    }
  return out;
}

/**
 * The commits `viewer` may see, in version order: all for the owner; for the partner,
 * each epoch's commits up to its bound, which excludes every private commit (D6).
 */
async function authorizedTimeline(
  queries: DiaryQueries,
  viewer: string,
  diary: DiaryRow,
): Promise<CommitPoint[] | null> {
  const timeline = await queries.timeline(diary.id);
  if (diary.ownerId === viewer) return timeline;
  const epochs = await queries.epochs.recipientEpochs(diary.id, viewer);
  if (!epochs.length) return null;
  const bounds = new Map(epochs.map((e) => [e.id, boundOf(e, diary)]));
  return timeline.filter(
    (c) => c.epochId !== null && bounds.has(c.epochId) && c.version <= bounds.get(c.epochId)!,
  );
}

/** The viewer's own diary on the day list; partner text counts once a history point holds it. */
async function ownCard(
  queries: DiaryQueries,
  viewer: string,
  row: DiaryRow & { updatedAt: Date },
  sharedWithPartner: boolean,
  settled: SettledPoint,
): Promise<OwnDayCard> {
  const facts = await summarize(
    () => queries.state(row.id, row.generationId, row.version),
    async (doc) => {
      const point = settled(await queries.timeline(row.id));
      return listUnread(queries, viewer, row.id, doc, point?.version ?? -1, row.version);
    },
  );
  return { diaryId: row.id, updatedAt: row.updatedAt, sharedWithPartner, ...facts };
}

/**
 * The partner's diary on the day list, from the epoch's authorized text only (D17). Its
 * history points are those of the viewer's authorized timeline; a frozen share became a
 * point when it stopped, so all of its text counts (D2).
 */
async function partnerCard(
  queries: DiaryQueries,
  viewer: string,
  epoch: EpochRow,
  settled: SettledPoint,
): Promise<PartnerDayCard> {
  const diary = (await queries.findDiary(epoch.diaryId))!;
  const bound = boundOf(epoch, diary);
  const timeline = (await authorizedTimeline(queries, viewer, diary))!;
  const facts = await summarize(
    () => queries.state(diary.id, epoch.generationId, bound),
    (doc) => {
      const cutoff = epoch.closedAt ? bound : (settled(timeline)?.version ?? -1);
      return listUnread(queries, viewer, diary.id, doc, cutoff, bound);
    },
  );
  return {
    diaryId: diary.id,
    epochId: epoch.id,
    share: epoch.closedAt ? 'frozen' : 'live',
    updatedAt: timeline.filter((c) => c.epochId === epoch.id).at(-1)!.committedAt,
    ...facts,
  };
}

/** The day cards of `dates`, newest first, from the viewer's own diaries and their shares. */
async function dayCards(
  queries: DiaryQueries,
  viewer: string,
  dates: readonly string[],
  own: readonly (DiaryRow & { updatedAt: Date })[],
  shared: readonly (EpochRow & { diaryDate: string })[],
  settled: SettledPoint,
): Promise<DayCard[]> {
  const live = await queries.epochs.liveEpochs(own.map((row) => row.id));
  const cards: DayCard[] = [];
  for (const diaryDate of dates) {
    const row = own.find((r) => r.diaryDate === diaryDate);
    const epoch = shared.find((e) => e.diaryDate === diaryDate);
    cards.push({
      diaryDate,
      mine: row ? await ownCard(queries, viewer, row, live.has(row.id), settled) : null,
      partner: epoch ? await partnerCard(queries, viewer, epoch, settled) : null,
    });
  }
  return cards;
}

export function createReader(store: Store) {
  /** The epoch if it shares this diary with `viewer`; anything else looks missing (D10). */
  async function epochFor(
    queries: DiaryQueries,
    viewer: string,
    diaryId: string,
    epochId: string,
  ): Promise<{ diary: DiaryRow; epoch: EpochRow } | null> {
    const diary = await queries.findDiary(diaryId);
    const epoch = diary && (await queries.epochs.epoch(epochId));
    if (!diary || !epoch || epoch.diaryId !== diaryId || epoch.recipientId !== viewer) return null;
    return { diary, epoch };
  }

  /** The epoch's authorized state at its bound: all commits up to it in its generation are its own. */
  async function epochState(queries: DiaryQueries, diary: DiaryRow, epoch: EpochRow) {
    const version = boundOf(epoch, diary);
    const doc = await queries.state(diary.id, epoch.generationId, version);
    const seq = (await queries.timeline(diary.id)).filter(
      (c) => c.epochId === epoch.id && c.version <= version,
    ).length;
    return { doc, seq: seq - 1 };
  }

  return {
    /** A shared diary as its partner opens it, live or frozen; null when not shared with `viewer`. */
    open(viewer: string, diaryId: string, epochId: string): Promise<SharedView | null> {
      return store.read(async (queries) => {
        const found = await epochFor(queries, viewer, diaryId, epochId);
        if (!found) return null;
        const { diary, epoch } = found;
        const { doc, seq } = await epochState(queries, diary, epoch);
        return {
          diaryId,
          diaryDate: diary.diaryDate,
          ownerId: diary.ownerId,
          epochId,
          share: epoch.closedAt ? 'frozen' : 'live',
          generationId: epoch.generationId,
          seq,
          state: Y.encodeStateAsUpdate(doc),
          bindings: bindingsIn(doc, await queries.bindings(diaryId)),
        };
      });
    },

    /**
     * The live epoch's commits after `knownSeq` (D10 catch-up). A frozen epoch, another
     * generation or a seq the server never reached is STALE_CONTEXT: the client reconciles
     * and opens what it may read now.
     */
    catchUp(
      viewer: string,
      diaryId: string,
      generationId: string,
      epochId: string,
      knownSeq: number,
    ): Promise<SharedCatchUp | 'NOT_FOUND' | 'STALE_CONTEXT'> {
      return store.read(async (queries) => {
        const found = await epochFor(queries, viewer, diaryId, epochId);
        if (!found) return 'NOT_FOUND';
        const { diary, epoch } = found;
        if (epoch.closedAt || epoch.generationId !== generationId) return 'STALE_CONTEXT';
        const seq = await queries.seq(diaryId, generationId);
        if (knownSeq > seq) return 'STALE_CONTEXT';
        const commits = await queries.deltasAfter(diary.id, generationId, knownSeq, epochId);
        return {
          seq,
          commits,
          bindings: clientsOf(
            commits.map((c) => c.delta),
            await queries.bindings(diaryId),
          ),
        };
      });
    },

    /**
     * Whether a socket subscription receives an event, decided from the event alone (D10):
     * the owner every commit of their generation; the partner only commits stamped with
     * their epoch, so a private commit never reaches them whenever the stop notice
     * arrives. Context changes go to the owner, and to the partner they concern; carets to
     * the other person in the same generation while their share is live.
     */
    deliverable(event: DiaryEvent, sub: Subscription, owner: boolean): boolean {
      // Carets go to the other person reading the same generation now (D8); a partner
      // whose share stopped is no longer reading it, and nobody gets their own back.
      if (event.type === 'cursor')
        return (
          event.generationId === sub.generationId &&
          event.user !== sub.viewer &&
          (owner || !sub.stopped)
        );
      if (event.type === 'context')
        return (
          owner ||
          (event.recipientId === sub.viewer &&
            (event.change === 'opened' || event.epochId === sub.epochId))
        );
      if (event.generationId !== sub.generationId) return false;
      return owner ? sub.epochId === null : sub.epochId !== null && event.epochId === sub.epochId;
    },

    /** The history `viewer` may see, without content; null when the diary is not theirs to read. */
    timeline(viewer: string, diaryId: string): Promise<CommitPoint[] | null> {
      return store.read(async (queries) => {
        const diary = await queries.findDiary(diaryId);
        return diary ? authorizedTimeline(queries, viewer, diary) : null;
      });
    },

    /**
     * One committed version as server-rendered author runs (D6), if `viewer` may see it.
     * Throws VersionUnreadable when its stored parts fail their sha256.
     */
    version(viewer: string, diaryId: string, publicId: string) {
      return store.read(async (queries) => {
        const diary = await queries.findDiary(diaryId);
        const timeline = diary && (await authorizedTimeline(queries, viewer, diary));
        const commit = timeline?.find((c) => c.publicId === publicId);
        if (!commit) return null;
        const doc = await queries.state(diaryId, commit.generationId, commit.version);
        const runs: { author: string; text: string }[] = [];
        for (const run of authorRuns(doc, await queries.bindings(diaryId))) {
          const last = runs.at(-1);
          if (last?.author === run.author) last.text += run.text;
          else runs.push({ author: run.author, text: run.text });
        }
        return { publicId, committedAt: commit.committedAt, runs };
      });
    },

    /**
     * The partner's diaries shared with `viewer` in the space, newest date first, one page
     * before `before`; each by its live share or else its last frozen one. Null when
     * `viewer` is not in the space.
     */
    sharedDiaries(
      viewer: string,
      spaceId: string,
      before: string | undefined,
    ): Promise<{ diaries: SharedSummary[]; nextBefore: string | null } | null> {
      return store.read(async (queries) => {
        if (!(await queries.epochs.isParticipant(spaceId, viewer))) return null;
        const shared = (await queries.epochs.sharedWith(viewer, spaceId))
          .filter((e) => before === undefined || e.diaryDate < before)
          .sort((a, b) => (a.diaryDate < b.diaryDate ? 1 : -1));
        const page = shared.slice(0, SHARED_PAGE_SIZE);
        const diaries: SharedSummary[] = [];
        for (const epoch of page) {
          const diary = (await queries.findDiary(epoch.diaryId))!;
          const bound = boundOf(epoch, diary);
          const timeline = (await queries.timeline(diary.id)).filter(
            (c) => c.epochId === epoch.id && c.version <= bound,
          );
          let excerpt: string | null;
          try {
            const doc = await queries.state(diary.id, epoch.generationId, bound);
            excerpt = excerptOf(doc.getText(BODY).toString());
          } catch (error) {
            if (!(error instanceof VersionUnreadable)) throw error;
            excerpt = null;
          }
          diaries.push({
            diaryId: diary.id,
            diaryDate: diary.diaryDate,
            ownerId: diary.ownerId,
            epochId: epoch.id,
            share: epoch.closedAt ? 'frozen' : 'live',
            excerpt,
            updatedAt: timeline.at(-1)!.committedAt,
          });
        }
        return {
          diaries,
          nextBefore: shared.length > SHARED_PAGE_SIZE ? page.at(-1)!.diaryDate : null,
        };
      });
    },

    /**
     * The dates with the viewer's own diary or one the partner shared with them, newest
     * first, one page of DAYS_PAGE_SIZE before `before` (unread-and-day-page D3). A diary
     * never shared with the viewer leaves no trace (invariant 10).
     */
    days(
      viewer: string,
      before: string | undefined,
      settled: SettledPoint,
    ): Promise<{ days: DayCard[]; nextBefore: string | null }> {
      return store.read(async (queries) => {
        // The newest DAYS_PAGE_SIZE + 1 own dates and every shared one hold the page's
        // dates and whether another page follows.
        const own = await queries.ownedDiaries(viewer, before ?? null, DAYS_PAGE_SIZE + 1);
        const shared = (await queries.epochs.sharedWith(viewer, null)).filter(
          (e) => before === undefined || e.diaryDate < before,
        );
        const dates = [...new Set([...own, ...shared].map((d) => d.diaryDate))].sort().reverse();
        const page = dates.slice(0, DAYS_PAGE_SIZE);
        return {
          days: await dayCards(queries, viewer, page, own, shared, settled),
          nextBefore: dates.length > DAYS_PAGE_SIZE ? page.at(-1)! : null,
        };
      });
    },

    /**
     * The diaries of one date that the viewer's Google copy holds (server-backup-and-google-docs
     * D5), each with the timeline the viewer may see: the own diary, and the partner's by its
     * live share or else its last frozen one. Versions are then read through `version`.
     */
    dayCopy(viewer: string, diaryDate: string): Promise<DayCopySource> {
      return store.read(async (queries) => {
        const [own] = (await queries.ownedDiaries(viewer, dayAfter(diaryDate), 1)).filter(
          (row) => row.diaryDate === diaryDate,
        );
        const [epoch] = (await queries.epochs.sharedWith(viewer, null)).filter(
          (e) => e.diaryDate === diaryDate,
        );
        const partnerDiary = epoch && (await queries.findDiary(epoch.diaryId))!;
        return {
          mine: own ? { diaryId: own.id, timeline: await queries.timeline(own.id) } : null,
          partner: partnerDiary
            ? {
                diaryId: partnerDiary.id,
                ownerId: partnerDiary.ownerId,
                epochId: epoch.id,
                share: epoch.closedAt ? 'frozen' : 'live',
                timeline: (await authorizedTimeline(queries, viewer, partnerDiary))!,
              }
            : null,
        };
      });
    },

    /** One date as on the day list; both sides null when the viewer can see no diary on it. */
    day(viewer: string, diaryDate: string, settled: SettledPoint): Promise<DayCard> {
      return store.read(async (queries) => {
        const own = (await queries.ownedDiaries(viewer, dayAfter(diaryDate), 1)).filter(
          (row) => row.diaryDate === diaryDate,
        );
        const shared = (await queries.epochs.sharedWith(viewer, null)).filter(
          (e) => e.diaryDate === diaryDate,
        );
        const [card] = await dayCards(queries, viewer, [diaryDate], own, shared, settled);
        return card!;
      });
    },

    /**
     * Who wrote a character visible in the text `viewer` reads, and when (D15): the owner's
     * current text, or the partner's epoch. Null for a character not visible there.
     */
    character(
      viewer: string,
      diaryId: string,
      epochId: string | undefined,
      clientId: number,
      clock: number,
    ): Promise<CharacterInfo | null> {
      return store.read(async (queries) => {
        let doc: Y.Doc;
        if (epochId === undefined) {
          const diary = await queries.findDiary(diaryId);
          if (diary?.ownerId !== viewer) return null;
          doc = await queries.state(diaryId, diary.generationId, diary.version);
        } else {
          const found = await epochFor(queries, viewer, diaryId, epochId);
          if (!found) return null;
          doc = (await epochState(queries, found.diary, found.epoch)).doc;
        }
        const bindings = await queries.bindings(diaryId);
        const visible = authorRuns(doc, bindings).some(
          (run) =>
            run.client === clientId && run.clock <= clock && clock < run.clock + run.text.length,
        );
        const origin = visible ? await queries.characterOrigin(diaryId, clientId, clock) : null;
        if (!origin) return null;
        const ahead = origin.writtenAt.getTime() - origin.receivedAt.getTime() > CLOCK_TOLERANCE_MS;
        return {
          author: origin.authorId,
          writtenAt: ahead ? origin.receivedAt : origin.writtenAt,
          clockAdjusted: ahead,
        };
      });
    },
  };
}

export type Reader = ReturnType<typeof createReader>;
