/** One bar: where a line holding unread text runs, from the bars' origin, in px. */
type Bar = { top: number; height: number };

/**
 * The lines the elements' boxes lie on, as bars from `origin`: each box of an inline
 * element is one line's part of it, and boxes that overlap vertically share a line.
 */
export function linesOf(elements: Iterable<Element>, origin: number): Bar[] {
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
 * The editor's margin bars (#112): a 3px ochre bar (`unread-bar`) left of every line that
 * holds unread text (`day-text-unread`), never kept or arriving text. They sit in a block
 * of no height just before the editor, so they never move the text, and are measured a
 * frame after every update of the view and whenever its box changes size.
 */
export function createMarginBars(view: { dom: HTMLElement }) {
  const box = document.createElement('div');
  box.className = 'unread-bars';
  box.setAttribute('aria-hidden', 'true');
  view.dom.before(box);
  let frame: number | undefined;
  let drawn = '';

  function draw() {
    frame = undefined;
    const bars = linesOf(
      view.dom.querySelectorAll('.day-text-unread'),
      box.getBoundingClientRect().top,
    );
    const key = JSON.stringify(bars);
    if (key === drawn) return;
    drawn = key;
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
  const schedule = () => {
    frame ??= requestAnimationFrame(draw);
  };
  const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resized?.observe(view.dom);

  return {
    /** The view changed: the bars are measured again on the next frame. */
    update: schedule,
    destroy() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resized?.disconnect();
      box.remove();
    },
  };
}
