import { ArrowDown } from 'lucide-react';
import { Button, cn } from '../ui/index.ts';

const directionClass =
  'unread-direction fixed left-1/2 z-20 -translate-x-1/2 rounded-full bg-notice px-3 py-1 text-sm text-ink shadow-sm';
import type { Unread } from './session.ts';

/**
 * What the reader has not read yet (unread-and-day-page D4): on opening, "有 N 处新内容 ·
 * 跳到第一处" until used; "下一处未读" while any is left; and which way more lies outside
 * the window, without a count. None of it moves the page by itself, and none of it moves
 * the text either: the notice keeps its line while the diary is open, the rest floats over
 * the window's edge, so the reading position holds when they come and go (D5).
 */
export function UnreadNotices({
  unread,
  jumped,
  onJump,
}: {
  unread: Unread | undefined;
  jumped: boolean;
  onJump: (which: 'first' | 'next') => void;
}) {
  const left = unread?.left ?? 0;
  const offer = !!unread && left > 0 && unread.atOpen > 0 && !jumped;
  return (
    <>
      {/* As tall as its button whether offered or idle, so the text below never moves. */}
      <p
        className="unread-banner my-2 flex min-h-11 items-center gap-1 text-sm"
        aria-hidden={!offer}
      >
        {offer && (
          <>
            有 {unread.atOpen} 处新内容 ·{' '}
            <Button
              type="button"
              variant="link"
              className="text-warm underline"
              onClick={() => onJump('first')}
            >
              跳到第一处
            </Button>
          </>
        )}
      </p>
      {left > 0 && (
        // Fixed to the window; the wide page places them over the day's box (workspace.css).
        <div className="unread-tools fixed right-4 bottom-4 z-20">
          {unread?.above && (
            <p className={cn(directionClass, 'above top-2')} role="status">
              ↑ 上面有新内容
            </p>
          )}
          {unread?.below && (
            <p className={cn(directionClass, 'below bottom-2')} role="status">
              ↓ 下面有新内容
            </p>
          )}
          <Button type="button" className="rounded-full shadow-md" onClick={() => onJump('next')}>
            <ArrowDown aria-hidden="true" />
            下一处未读
          </Button>
        </div>
      )}
    </>
  );
}
