import { createContext, useContext } from 'react';

/**
 * The bookmark a `BookSpread` draws on its book (book-fit-and-bookmark D2), given by
 * `ContentsBookmark`: to the page's book while the contents is closed, to the contents' book
 * while it is open, so there is one at a time and none without a book. Null: no bookmark.
 */
export type BookmarkState = {
  open: boolean;
  panelId: string;
  toggle: () => void;
  /** Called with the button drawn, and null when it goes, so focus can return to it. */
  attach: (button: HTMLButtonElement | null) => void;
};

export const BookmarkContext = createContext<BookmarkState | null>(null);

/** The 「目录」 ribbon on the book this renders in, if it was given one. */
export function Bookmark() {
  const bookmark = useContext(BookmarkContext);
  if (!bookmark) return null;
  const { open, panelId, toggle, attach } = bookmark;
  return (
    <div className="bookmark-rail">
      <button
        ref={attach}
        type="button"
        className="bookmark"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        目录
      </button>
    </div>
  );
}
