import { charTop, firstCharEndingBelow } from '../day-text/index.ts';

/**
 * What is being read at the top of the scroller (book-frontend-workspace D8): the date, and
 * inside it the first character still on screen by identity (diary, clientID, clock), with
 * its distance from the scroller's top. Text above it may change height; the character
 * keeps its place.
 */
export type Anchor = {
  date: string;
  offset: number;
  character?: { diary: string; client: number; clock: number };
};

const first = <T extends Element>(elements: Iterable<T>, below: number) =>
  [...elements].find((el) => el.getBoundingClientRect().bottom > below);

export function captureAnchor(scroller: HTMLElement): Anchor | null {
  const top = scroller.getBoundingClientRect().top;
  const section = first(scroller.querySelectorAll<HTMLElement>('[data-date]'), top);
  if (!section) return null;
  const date = section.dataset.date!;
  const segment = first(section.querySelectorAll<HTMLElement>('[data-diary] [data-clock]'), top);
  const diary = segment?.closest<HTMLElement>('[data-diary]')?.dataset.diary;
  if (!segment || !diary) return { date, offset: section.getBoundingClientRect().top - top };
  const at = firstCharEndingBelow(segment, top) ?? 0;
  return {
    date,
    offset: charTop(segment, at) - top,
    character: {
      diary,
      client: Number(segment.dataset.client),
      clock: Number(segment.dataset.clock) + at,
    },
  };
}

/** Where the anchor is now, relative to the scroller's top; null when it is gone. */
function offsetOf(scroller: HTMLElement, anchor: Anchor): number | null {
  const top = scroller.getBoundingClientRect().top;
  const section = scroller.querySelector<HTMLElement>(`[data-date="${anchor.date}"]`);
  if (!section) return null;
  const character = anchor.character;
  if (character) {
    const diary = section.querySelector(`[data-diary="${character.diary}"]`);
    for (const segment of diary?.querySelectorAll<HTMLElement>(
      `[data-client="${character.client}"]`,
    ) ?? []) {
      const clock = Number(segment.dataset.clock);
      const length = (segment.textContent ?? '').length;
      if (character.clock >= clock && character.clock < clock + length)
        return charTop(segment, character.clock - clock) - top;
    }
    // Deleted, collapsed or not loaded any more: nothing to hold on to.
    return null;
  }
  return section.getBoundingClientRect().top - top;
}

/**
 * Scrolls so the anchor is as far from the scroller's top as it was; false when it is not
 * on the page (its date, or its character, is not shown), and then nothing moves.
 */
export function restoreAnchor(scroller: HTMLElement, anchor: Anchor): boolean {
  const offset = offsetOf(scroller, anchor);
  if (offset !== null && offset !== anchor.offset) scroller.scrollTop += offset - anchor.offset;
  return offset !== null;
}
