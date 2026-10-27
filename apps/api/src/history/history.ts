import { authorRuns } from '@between-pages/collab';
import type { CommitPoint, Store } from '../store/store.ts';

/** Continuous editing forms one history point per this span (kernel D6). */
export const GROUP_MS = 5 * 60_000;
/** This long without a text commit ends a group with its last commit (kernel D6). */
export const IDLE_MS = 2 * 60_000;
export const PAGE_SIZE = 50;

export type HistoryPoint = { publicId: string; committedAt: Date; authors: string[] };

type Group = { first: CommitPoint; last: CommitPoint; authors: Set<string> };

/**
 * Groups commits as kernel D6 does: a group starts at a commit and takes later ones while
 * each is within `idleMs` of the previous and GROUP_MS of the group's first, inside one
 * generation (sharing boundaries never merge).
 */
function groupsOf(timeline: readonly CommitPoint[], idleMs: number): Group[] {
  const groups: Group[] = [];
  for (const commit of timeline) {
    const group = groups.at(-1);
    const at = commit.committedAt.getTime();
    if (
      group &&
      group.first.generationId === commit.generationId &&
      at - group.last.committedAt.getTime() < idleMs &&
      at - group.first.committedAt.getTime() < GROUP_MS
    ) {
      group.last = commit;
      if (commit.authorId) group.authors.add(commit.authorId);
      continue;
    }
    groups.push({
      first: commit,
      last: commit,
      authors: new Set(commit.authorId ? [commit.authorId] : []),
    });
  }
  return groups;
}

/** When a group closes unless another commit joins it first. */
const closesAt = ({ first, last }: Group, idleMs: number) =>
  Math.min(last.committedAt.getTime() + idleMs, first.committedAt.getTime() + GROUP_MS);

/** The newest group while it is still open at `now`: it has no point yet. */
function openGroup(groups: readonly Group[], now: Date, idleMs: number): Group | undefined {
  const newest = groups.at(-1);
  return newest && now.getTime() < closesAt(newest, idleMs) ? newest : undefined;
}

/**
 * History points computed at read time (kernel D6), oldest first; each is its group's
 * last commit. The newest group becomes a point only once closed by `now`, so a point
 * never changes after it appears.
 */
export function historyPoints(
  timeline: readonly CommitPoint[],
  now: Date,
  idleMs = IDLE_MS,
): HistoryPoint[] {
  const groups = groupsOf(timeline, idleMs);
  if (openGroup(groups, now, idleMs)) groups.pop();
  return groups.map(({ last, authors }) => ({
    publicId: last.publicId,
    committedAt: last.committedAt,
    authors: [...authors].sort(),
  }));
}

/**
 * Milliseconds from `now` until the open group becomes a point if no commit joins it, or
 * null when no group is open; lets a client fetch the new point when it appears.
 */
export function nextPointIn(
  timeline: readonly CommitPoint[],
  now: Date,
  idleMs = IDLE_MS,
): number | null {
  const open = openGroup(groupsOf(timeline, idleMs), now, idleMs);
  return open ? closesAt(open, idleMs) - now.getTime() : null;
}

// Opaque to clients; inside it is the (commit time, publicId) of the last point served.
const encodeCursor = (point: HistoryPoint) =>
  Buffer.from(JSON.stringify([point.committedAt.toISOString(), point.publicId])).toString(
    'base64url',
  );

function decodeCursor(cursor: string): [number, string] | null {
  try {
    const [at, publicId] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown[];
    const time = typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isNaN(time) || typeof publicId !== 'string' ? null : [time, publicId];
  } catch {
    // Malformed base64 or JSON: the client sent something this server never issued.
    return null;
  }
}

const newestFirst = (a: HistoryPoint, b: HistoryPoint) =>
  b.committedAt.getTime() - a.committedAt.getTime() || (a.publicId < b.publicId ? 1 : -1);

/**
 * The owner's read-only history (kernel D6). Phase 2 has no sharing, so only the owner
 * reads it; anyone else gets NOT_FOUND. Phase 4 filters commits by the viewer's epochs
 * before grouping, so counts and pages never reflect private commits (invariant 15).
 */
/** `idleMs` is shortened only by the end-to-end suite (`HISTORY_IDLE_MS`, dev login only). */
export function createHistoryService(store: Store, idleMs = IDLE_MS) {
  return {
    /** One page, newest first. Authorization and points are recomputed for every page. */
    async page(
      viewer: string,
      diaryId: string,
      cursor: string | undefined,
      now: Date,
    ): Promise<
      | { points: HistoryPoint[]; nextCursor: string | null; nextPointInMs: number | null }
      | 'NOT_FOUND'
      | 'BAD_CURSOR'
    > {
      const after = cursor === undefined ? null : decodeCursor(cursor);
      if (cursor !== undefined && !after) return 'BAD_CURSOR';
      const timeline = await store.read(async (queries) => {
        const diary = await queries.findDiary(diaryId);
        return diary?.ownerId === viewer ? queries.timeline(diaryId) : null;
      });
      if (!timeline) return 'NOT_FOUND';
      const all = historyPoints(timeline, now, idleMs).sort(newestFirst);
      const rest = after
        ? all.filter(
            (p) =>
              p.committedAt.getTime() < after[0] ||
              (p.committedAt.getTime() === after[0] && p.publicId < after[1]),
          )
        : all;
      const points = rest.slice(0, PAGE_SIZE);
      return {
        points,
        nextCursor: rest.length > PAGE_SIZE ? encodeCursor(points.at(-1)!) : null,
        nextPointInMs: nextPointIn(timeline, now, idleMs),
      };
    },

    /**
     * One committed version rendered on the server as author runs: no CRDT data leaves
     * (D6). Throws VersionUnreadable when its stored parts fail their sha256.
     */
    async version(viewer: string, diaryId: string, publicId: string) {
      return store.read(async (queries) => {
        const diary = await queries.findDiary(diaryId);
        if (diary?.ownerId !== viewer) return null;
        const commit = (await queries.timeline(diaryId)).find((c) => c.publicId === publicId);
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
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
