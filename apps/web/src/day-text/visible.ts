/** A run of one clientID's characters, as `createReadTracker` takes them. */
export type CharacterRun = { client: number; clock: number; length: number };

/** The part of the window where text can be read, in client coordinates. */
export type Clip = { top: number; bottom: number };

/** The box of one character of a segment, or null where the browser gives no text geometry. */
function charRect(segment: Element, offset: number): DOMRect | null {
  const node = segment.firstChild;
  const range = document.createRange();
  if (!(node instanceof Text) || typeof range.getBoundingClientRect !== 'function') return null;
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  return range.getBoundingClientRect();
}

/** The first offset in `segment` whose character passes `test`; text runs top to bottom. */
function firstOffset(segment: Element, test: (rect: DOMRect) => boolean): number | null {
  let low = 0;
  let high = (segment.textContent ?? '').length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const rect = charRect(segment, middle);
    if (!rect) return null;
    if (test(rect)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The first character of a rendered segment whose box ends below `y`; null without geometry. */
export const firstCharEndingBelow = (segment: Element, y: number) =>
  firstOffset(segment, (rect) => rect.bottom > y);

/** Where a character of a rendered segment starts, or the segment's top without geometry. */
export function charTop(segment: Element, offset: number): number {
  const length = (segment.textContent ?? '').length;
  const rect = length ? charRect(segment, Math.min(offset, length - 1)) : null;
  return (rect ?? segment.getBoundingClientRect()).top;
}

/**
 * The other person's characters of one rendered `DayText` that are inside `clip` now
 * (book-frontend-workspace D5): only what has a box on screen, so hidden or clipped text,
 * text under an inert page (the 「目录」 covers it, contents-spread D1) and a segment the
 * browser cannot measure by character never count.
 */
export function visibleOthers(root: Element, clip: Clip): CharacterRun[] {
  if (clip.bottom <= clip.top || root.closest('[inert]')) return [];
  const runs: CharacterRun[] = [];
  for (const segment of root.querySelectorAll<HTMLElement>('[data-other]')) {
    const rect = segment.getBoundingClientRect();
    if (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.height === 0) continue;
    const client = Number(segment.dataset.client);
    const clock = Number(segment.dataset.clock);
    const length = (segment.textContent ?? '').length;
    if (rect.top >= clip.top && rect.bottom <= clip.bottom) {
      runs.push({ client, clock, length });
      continue;
    }
    const from = firstCharEndingBelow(segment, clip.top);
    const to = firstOffset(segment, (r) => r.top >= clip.bottom);
    if (from !== null && to !== null && to > from)
      runs.push({ client, clock: clock + from, length: to - from });
  }
  return runs;
}
