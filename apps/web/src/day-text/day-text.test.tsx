import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { stateOf } from '../../test/day-text.ts';
import { DayText, decodeText, visibleOthers } from './index.ts';

const ME = 'me';
const THEM = 'them';
const authorClass = (author: string) => (author === ME ? 'author-slot-1' : 'author-slot-2');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Boxes by text: a piece is drawn where its first character says, 20px a line. */
function layOut(lines: Record<string, number>) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const line = lines[this.textContent ?? ''];
    return line === undefined
      ? new DOMRect(0, 0, 0, 0)
      : new DOMRect(0, line * 20, 300, (this.textContent ?? '').length * 20);
  });
}

describe('decodeText', () => {
  it('gives the server’s text as author runs with their text index', () => {
    const runs = decodeText(
      stateOf([
        [1, ME, '早上好'],
        [2, THEM, '晚安'],
        [1, ME, '!'],
      ]),
    );
    expect(runs).toEqual([
      { author: ME, client: 1, clock: 0, text: '早上好', index: 0 },
      { author: THEM, client: 2, clock: 0, text: '晚安', index: 3 },
      { author: ME, client: 1, clock: 3, text: '!', index: 5 },
    ]);
  });
});

describe('DayText', () => {
  it('colors each author and marks unread passages, cutting runs where they start and end', () => {
    const runs = decodeText(
      stateOf([
        [1, ME, '我的'],
        [2, THEM, '你的字'],
      ]),
    );
    const { container } = render(
      <DayText runs={runs} readerId={ME} authorClass={authorClass} unread={[{ from: 3, to: 5 }]} />,
    );
    const pieces = [...container.querySelectorAll('[data-client]')].map((el) => ({
      tag: el.tagName,
      text: el.textContent,
      className: el.className,
      clock: el.getAttribute('data-clock'),
      other: el.hasAttribute('data-other'),
    }));
    expect(pieces).toEqual([
      { tag: 'SPAN', text: '我的', className: 'author-slot-1', clock: '0', other: false },
      { tag: 'SPAN', text: '你', className: 'author-slot-2', clock: '0', other: true },
      {
        tag: 'MARK',
        text: '的字',
        className: 'author-slot-2 day-text-unread',
        clock: '1',
        other: true,
      },
    ]);
  });

  it('marks passages read during the visit light, as marks too', () => {
    const runs = decodeText(stateOf([[2, THEM, '一二三四']]));
    const { container } = render(
      <DayText
        runs={runs}
        readerId={ME}
        authorClass={authorClass}
        unread={[{ from: 3, to: 4 }]}
        kept={[{ from: 1, to: 3 }]}
      />,
    );
    expect(
      [...container.querySelectorAll('[data-client]')].map((el) => [el.tagName, el.className]),
    ).toEqual([
      ['SPAN', 'author-slot-2'],
      ['MARK', 'author-slot-2 day-text-kept'],
      ['MARK', 'author-slot-2 day-text-unread'],
    ]);
  });
});

describe('margin bars', () => {
  /** Each piece's boxes, one per line it runs over: 一 on line 0, 二三 over lines 1 and 2. */
  const LINES: Record<string, number[]> = { 一: [0], 二三: [1, 2], 四: [2], 五: [4] };
  const bars = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('.unread-bar')].map((bar) => [
      bar.style.top,
      bar.style.height,
    ]);

  it('draws one bar beside each line that holds unread text, none for kept text', () => {
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      const lines = LINES[this.textContent ?? ''] ?? [];
      return lines.map((line) => new DOMRect(0, line * 30 + 5, 40, 20)) as unknown as DOMRectList;
    });
    const runs = decodeText(stateOf([[2, THEM, '一二三四五']]));
    const marks = (
      unread: { from: number; to: number }[],
      kept: { from: number; to: number }[],
    ) => (
      <DayText runs={runs} readerId={ME} authorClass={authorClass} unread={unread} kept={kept} />
    );
    const { container, rerender } = render(
      marks(
        [
          { from: 1, to: 3 },
          { from: 3, to: 4 },
        ],
        [{ from: 4, to: 5 }],
      ),
    );
    // 二三 and 四 share line 2: one bar there.
    expect(bars(container)).toEqual([
      ['35px', '20px'],
      ['65px', '20px'],
    ]);
    // Read on: what is left unread moves the bars with it.
    rerender(marks([{ from: 0, to: 1 }], [{ from: 1, to: 5 }]));
    expect(bars(container)).toEqual([['5px', '20px']]);
    expect(container.querySelector('.unread-bars')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('visibleOthers', () => {
  it('[adr:book-frontend-workspace#5] names only the other person’s characters inside the clip', () => {
    const runs = decodeText(
      stateOf([
        [2, THEM, '看得见'],
        [1, ME, '我自己'],
        [2, THEM, '在下面'],
      ]),
    );
    const { container } = render(<DayText runs={runs} readerId={ME} authorClass={authorClass} />);
    // The first piece is on screen, the own one too, the last one below the clip.
    layOut({ 看得见: 1, 我自己: 4, 在下面: 40 });
    expect(visibleOthers(container, { top: 0, bottom: 300 })).toEqual([
      { client: 2, clock: 0, length: 3 },
    ]);
    // Nothing is shown where the clip has no height (a hidden page).
    expect(visibleOthers(container, { top: 0, bottom: 0 })).toEqual([]);
  });

  it('counts only the characters of a long piece that are inside the clip', () => {
    const runs = decodeText(stateOf([[2, THEM, '一二三四五六']]));
    const { container } = render(<DayText runs={runs} readerId={ME} authorClass={authorClass} />);
    layOut({ 一二三四五六: 0 });
    // One character a line: lines 2–3 (characters 三, 四) are inside 40–80.
    // jsdom has no text geometry; without it a partly shown piece counts for nothing.
    expect(visibleOthers(container, { top: 40, bottom: 80 })).toEqual([]);
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        return new DOMRect(0, this.startOffset * 20, 20, 20);
      },
    });
    try {
      expect(visibleOthers(container, { top: 40, bottom: 80 })).toEqual([
        { client: 2, clock: 2, length: 2 },
      ]);
    } finally {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    }
  });
});
