import type { ClockRange, ReadingStore } from '../store/reading.ts';
import type { Store } from '../store/store.ts';

/**
 * Each person's own reading progress (kernel D15): the characters they saw, by identity,
 * so it holds across devices and reopened shares. Only the diary's owner and a person it
 * was ever shared with may keep progress on it; it is returned to its reader alone and
 * never becomes a read receipt for anyone else (invariant 26).
 */
export function createReadingService(store: Store, reading: ReadingStore) {
  /** Whether `viewer` may read the diary at all: its owner, or a recipient of any of its epochs. */
  const readable = (viewer: string, diaryId: string) =>
    store.read(async (queries) => {
      const diary = await queries.findDiary(diaryId);
      if (!diary) return false;
      return (
        diary.ownerId === viewer ||
        (await queries.epochs.recipientEpochs(diaryId, viewer)).length > 0
      );
    });

  return {
    async ranges(viewer: string, diaryId: string): Promise<ClockRange[] | null> {
      return (await readable(viewer, diaryId)) ? reading.ranges(viewer, diaryId) : null;
    },

    /** Adds what `viewer` saw; null when the diary is not theirs to read. */
    async report(
      viewer: string,
      diaryId: string,
      ranges: readonly ClockRange[],
    ): Promise<ClockRange[] | null> {
      return (await readable(viewer, diaryId)) ? reading.add(viewer, diaryId, ranges) : null;
    },
  };
}

export type ReadingService = ReturnType<typeof createReadingService>;
