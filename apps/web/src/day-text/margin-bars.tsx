import { useLayoutEffect, useRef } from 'react';

/** One bar: where a line holding unread text runs, from the bars' box, in px. */
type Bar = { top: number; height: number };

/**
 * The lines the elements' boxes lie on, as bars from `origin`: each box of an inline
 * element is one line's part of it, and boxes that overlap vertically share a line.
 */
function linesOf(elements: Iterable<Element>, origin: number): Bar[] {
  const boxes = [...elements]
    .flatMap((el) => [...el.getClientRects()])
    .filter((box) => box.height > 0)
    .sort((a, b) => a.top - b.top);
  const lines: { top: number; bottom: number }[] = [];
  for (const { top, bottom } of boxes) {
    const last = lines.at(-1);
    if (last && top < last.bottom) last.bottom = Math.max(last.bottom, bottom);
    else lines.push({ top, bottom });
  }
  return lines.map(({ top, bottom }) => ({ top: top - origin, height: bottom - top }));
}

/**
 * Draws the bars for the text right after `box`, replacing them only when they changed.
 * The box is the bars' own: React renders it empty and never touches what is drawn in it.
 */
function draw(box: HTMLElement) {
  const text = box.nextElementSibling;
  const bars = text
    ? linesOf(text.querySelectorAll('mark.day-text-unread'), box.getBoundingClientRect().top)
    : [];
  const key = JSON.stringify(bars);
  if (box.dataset.bars === key) return;
  box.dataset.bars = key;
  box.replaceChildren(
    ...bars.map(({ top, height }) => {
      const bar = document.createElement('span');
      bar.className = 'unread-bar';
      bar.style.top = `${top}px`;
      bar.style.height = `${height}px`;
      return bar;
    }),
  );
}

/**
 * The margin bars of a rendered `DayText` (#112): a 3px ochre bar (`unread-bar`) left of
 * every line of the text right after it that holds an unread piece, never a kept one, in
 * a box of no height. Measured after every render and whenever the text's box changes
 * size (a narrower window wraps it again).
 */
export function MarginBars() {
  const box = useRef<HTMLDivElement>(null);
  // After every render: the text or its marks may have changed.
  useLayoutEffect(() => {
    if (box.current) draw(box.current);
  });
  useLayoutEffect(() => {
    const text = box.current?.nextElementSibling;
    if (!text || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => box.current && draw(box.current));
    observer.observe(text);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} className="unread-bars" aria-hidden="true" />;
}
