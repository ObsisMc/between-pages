import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureAnchor, restoreAnchor } from './anchor.ts';

afterEach(() => vi.restoreAllMocks());

/** A scroller with one date: a line of another diary above the anchored one. */
function feedDom() {
  const scroller = document.createElement('div');
  scroller.innerHTML = `
    <section data-date="2026-10-27">
      <div data-diary="a"><span data-client="9" data-clock="0">上面</span></div>
      <div data-diary="b"><span data-client="2" data-clock="4">正在读的这一行</span></div>
    </section>`;
  let scrollTop = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => (scrollTop = value),
  });
  return scroller;
}

describe('the reading anchor', () => {
  it('keeps the character being read in place when text above it grows', () => {
    const scroller = feedDom();
    const tops: Record<string, number> = { 上面: -40, 正在读的这一行: 30 };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this === scroller) return new DOMRect(0, 0, 300, 600);
      // The date runs from the line above to well below the window's top.
      if (this.tagName === 'SECTION') return new DOMRect(0, -40 - scroller.scrollTop, 300, 400);
      return new DOMRect(0, (tops[this.textContent ?? ''] ?? -100) - scroller.scrollTop, 300, 20);
    });
    const anchor = captureAnchor(scroller);
    expect(anchor).toEqual({
      date: '2026-10-27',
      offset: 30,
      character: { diary: 'b', client: 2, clock: 4 },
    });

    // Three lines more above: the line moves down 60px, the scroller follows it.
    tops['正在读的这一行'] = 90;
    restoreAnchor(scroller, anchor!);
    expect(scroller.scrollTop).toBe(60);
    expect(captureAnchor(scroller)?.offset).toBe(30);
  });
});
