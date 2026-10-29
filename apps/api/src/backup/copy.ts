import { historyPoints, IDLE_MS, nextPointIn } from '../history/history.ts';
import type { Reader } from '../reader/reader.ts';
import type { CommitPoint } from '../store/store.ts';
import type { CopyStore, Covers } from '../store/copy.ts';
import { renderDay, type DayDoc } from './render.ts';

// What one day's Doc in one person's Drive holds (server-backup-and-google-docs D5–D7). Text
// comes only through the authorized-state reader, so the partner's part is the version their
// share allows the viewer and nothing else (invariant 5). A part is written at its newest
// history point; a frozen share's stop is one at once. "现在备份" takes the newest commit.

export type DayContent = {
  /** Null when no part has reached a history point yet, or the user sees no diary that day. */
  written: {
    doc: DayDoc;
    covers: Covers;
    /** The newest version the Doc holds, as "已备份到 Google 9:22" shows it. */
    coveredAt: Date;
  } | null;
  /** A history point still forming: look at the day again then. */
  recheckAt: Date | null;
};

export function createCopyService(store: CopyStore, reader: Reader, idleMs = IDLE_MS) {
  /** The commit a part shows, or null before its first history point. */
  function shown(timeline: readonly CommitPoint[], now: Date, settled: boolean, force: boolean) {
    if (force || settled) return timeline.at(-1) ?? null;
    const point = historyPoints(timeline, now, idleMs).at(-1);
    return point ? timeline.find((c) => c.publicId === point.publicId)! : null;
  }

  async function runsAt(viewer: string, diaryId: string, commit: CommitPoint) {
    const version = await reader.version(viewer, diaryId, commit.publicId);
    return version!.runs;
  }

  return {
    intake: (onlyFor?: readonly string[]) => store.intake(onlyFor),

    /** The day's Doc for `userId` at `now`; `force` is "现在备份". */
    async content(
      userId: string,
      diaryDate: string,
      now: Date,
      force: boolean,
    ): Promise<DayContent> {
      const source = await reader.dayCopy(userId, diaryDate);
      const mine = source.mine && shown(source.mine.timeline, now, false, force);
      const partner =
        source.partner &&
        shown(source.partner.timeline, now, source.partner.share === 'frozen', force);
      const forming = [
        source.mine && nextPointIn(source.mine.timeline, now, idleMs),
        source.partner?.share === 'live' && nextPointIn(source.partner.timeline, now, idleMs),
      ].filter((ms): ms is number => typeof ms === 'number');
      const recheckAt =
        !force && forming.length ? new Date(now.getTime() + Math.min(...forming)) : null;
      if (!mine && !partner) return { written: null, recheckAt };

      const people = await store.people(userId);
      const covers: Covers = {};
      const doc = renderDay({
        date: diaryDate,
        viewer: people.viewer,
        partner: people.partner,
        mine: mine && (await runsAt(userId, source.mine!.diaryId, mine)),
        partnerDiary: partner && {
          runs: await runsAt(userId, source.partner!.diaryId, partner),
          frozen: source.partner!.share === 'frozen',
        },
      });
      if (mine)
        covers.mine = {
          diaryId: source.mine!.diaryId,
          version: mine.version,
          at: mine.committedAt.toISOString(),
        };
      if (partner)
        covers.partner = {
          diaryId: source.partner!.diaryId,
          epochId: source.partner!.epochId,
          version: partner.version,
          at: partner.committedAt.toISOString(),
        };
      const times = [mine, partner].filter((c) => c !== null).map((c) => c.committedAt.getTime());
      return { written: { doc, covers, coveredAt: new Date(Math.max(...times)) }, recheckAt };
    },
  };
}

export type CopyService = ReturnType<typeof createCopyService>;
