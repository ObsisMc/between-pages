import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { callApi } from '../api/client.ts';
import type { Clip } from '../day-text/index.ts';
import type { FeedWindow } from './model.ts';
import {
  landing,
  nextUnread,
  type Answer,
  type Ask,
  type Direction,
  type Spot,
} from './next-unread.ts';

/** As long as the `unread-flash` animation in `styles.css` runs (editor-binding's `FLASH_MS`). */
const FLASH_MS = 3_000;

const names: Record<Direction, string> = { newer: '上一处未读', older: '下一处未读' };
const arrows: Record<Direction, string> = { newer: '↑', older: '↓' };

/**
 * The unread on the shown dates, in page order, with their elements: unread passages of
 * loaded text, and the diaries `FeedDiary` and the collapsed rows mark with `data-unread`.
 */
function spotsIn(root: HTMLElement, clip: Clip) {
  const elements = [
    ...root.querySelectorAll<HTMLElement>('[data-date] mark.day-text-unread, [data-unread]'),
  ];
  const spots = elements.map((el): Spot => {
    const { top, bottom } = el.getBoundingClientRect();
    return {
      date: el.closest<HTMLElement>('[data-date]')?.dataset.date ?? '',
      place: bottom <= clip.top ? 'above' : top >= clip.bottom ? 'below' : 'inside',
      settled: el.dataset.unread !== 'loading',
    };
  });
  return { spots, elements };
}

/**
 * Highlights `el` for `FLASH_MS` with `data-flash`, an attribute React never sets, so the
 * flash lasts while `DayText` redraws the piece from unread to kept (#112).
 */
function flash(el: HTMLElement) {
  el.dataset.flash = '';
  setTimeout(() => delete el.dataset.flash, FLASH_MS);
}

const keyOf = (ask: Ask) => JSON.stringify(ask);

/**
 * The feed's round unread buttons (book-frontend-workspace D5): whether ↑ / ↓ shows, and
 * `go` to follow one. `nextUnread` decides from what the feed shows, again whenever it
 * changes (the dates, an unread mark, the scroll); `next-unread` is asked once for each end
 * of every new window (entry, a page, a jump, each refresh), so a click needs no wait, and
 * an answer is kept until the next one for the same ask arrives. A date not loaded is
 * jumped to, then its first unread passage, or collapsed row, is shown once loaded unless
 * the reader moved the list meanwhile (`cancel`). Nothing scrolls but `go`.
 */
export function useUnreadArrows({
  scroller,
  clip,
  feedWindow,
  jump,
  show,
}: {
  scroller: RefObject<HTMLElement | null>;
  clip: () => Clip;
  feedWindow: FeedWindow | null;
  jump: (date: string) => void;
  /** Scrolls the feed so `el` is in view; never moves the focus. */
  show: (el: HTMLElement) => void;
}) {
  const [shown, setShown] = useState<Record<Direction, boolean>>({ newer: false, older: false });
  const answers = useRef(new Map<string, { answer: Answer; generation: number }>());
  const asking = useRef(new Map<string, number>());
  const generation = useRef(0);
  const landingAt = useRef<string | null>(null);
  const live = useRef(true);
  const latest = useRef({ clip, jump, show, feedWindow });
  useEffect(() => {
    latest.current = { clip, jump, show, feedWindow };
  });

  const decide = useCallback((direction: Direction, spots: Spot[]) => {
    const answer = (ask: Ask) => answers.current.get(keyOf(ask))?.answer;
    return nextUnread(direction, spots, latest.current.feedWindow, answer);
  }, []);

  const evaluate = useCallback(
    function evaluate() {
      const root = scroller.current;
      if (!live.current || !root) return;
      const at = landingAt.current;
      if (at && root.querySelector(`[data-date="${at}"]`)) {
        const { spots, elements } = spotsIn(root, latest.current.clip());
        const index = landing(at, spots);
        if (index !== 'wait') landingAt.current = null;
        if (typeof index === 'number') {
          latest.current.show(elements[index]!);
          flash(elements[index]!);
        }
      }
      const { spots } = spotsIn(root, latest.current.clip());
      const next = { newer: decide('newer', spots), older: decide('older', spots) };
      setShown((was) =>
        was.newer === !!next.newer.next && was.older === !!next.older.next
          ? was
          : { newer: !!next.newer.next, older: !!next.older.next },
      );
      for (const { ask } of [next.newer, next.older]) {
        if (!ask) continue;
        const key = keyOf(ask);
        const asked = generation.current;
        if (answers.current.get(key)?.generation === asked || asking.current.get(key) === asked)
          continue;
        asking.current.set(key, asked);
        // A failure hides the button until the next window asks again (失败与恢复).
        callApi('nextUnread', { query: ask })
          .then(
            ({ date }) => ({ date }),
            (): Answer => 'failed',
          )
          .then((answer) => {
            if (asking.current.get(key) === asked) asking.current.delete(key);
            answers.current.set(key, { answer, generation: asked });
            evaluate();
          });
      }
    },
    [scroller, decide],
  );

  useEffect(() => {
    live.current = true;
    const root = scroller.current;
    if (!root) return;
    const observer = new MutationObserver(evaluate);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-unread'],
    });
    root.addEventListener('scroll', evaluate, { passive: true });
    globalThis.addEventListener('resize', evaluate);
    return () => {
      live.current = false;
      observer.disconnect();
      root.removeEventListener('scroll', evaluate);
      globalThis.removeEventListener('resize', evaluate);
    };
  }, [scroller, evaluate]);

  useEffect(() => {
    generation.current++;
    evaluate();
  }, [feedWindow, evaluate]);

  const go = useCallback(
    (direction: Direction) => {
      const root = scroller.current;
      if (!root) return;
      const { spots, elements } = spotsIn(root, latest.current.clip());
      const { next } = decide(direction, spots);
      if (next && 'spot' in next) {
        landingAt.current = null;
        latest.current.show(elements[next.spot]!);
        flash(elements[next.spot]!);
      } else if (next) {
        landingAt.current = next.date;
        latest.current.jump(next.date);
      }
      evaluate();
    },
    [scroller, decide, evaluate],
  );

  const cancel = useCallback(() => {
    landingAt.current = null;
  }, []);

  return { shown, go, cancel };
}

/**
 * A round arrow over the feed's box, named "上一处未读" (↑) / "下一处未读" (↓), the name also
 * showing on hover and focus. Pressing it leaves the focus where it was, so an editor or
 * input keeps it (D5).
 */
export function UnreadArrow({
  direction,
  onGo,
}: {
  direction: Direction;
  onGo: (direction: Direction) => void;
}) {
  return (
    <button
      type="button"
      className={`group absolute left-1/2 z-10 size-11 min-h-0 -translate-x-1/2 rounded-full border border-line bg-paper p-0 text-xl leading-none text-warm shadow-md ${direction === 'newer' ? 'top-2' : 'bottom-2'}`}
      aria-label={names[direction]}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onGo(direction)}
    >
      <span aria-hidden="true">{arrows[direction]}</span>
      <span
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 rounded bg-ink px-2 py-0.5 text-xs whitespace-nowrap text-paper opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 ${direction === 'newer' ? 'top-[calc(100%+0.25rem)]' : 'bottom-[calc(100%+0.25rem)]'}`}
        aria-hidden="true"
      >
        {names[direction]}
      </span>
    </button>
  );
}
