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
      <p className={offer ? 'unread-banner' : 'unread-banner idle'} aria-hidden={!offer}>
        {offer && (
          <>
            有 {unread.atOpen} 处新内容 ·{' '}
            <button type="button" className="link" onClick={() => onJump('first')}>
              跳到第一处
            </button>
          </>
        )}
      </p>
      {left > 0 && (
        <div className="unread-tools">
          {unread?.above && (
            <p className="unread-direction above" role="status">
              ↑ 上面有新内容
            </p>
          )}
          {unread?.below && (
            <p className="unread-direction below" role="status">
              ↓ 下面有新内容
            </p>
          )}
          <button type="button" onClick={() => onJump('next')}>
            下一处未读
          </button>
        </div>
      )}
    </>
  );
}
