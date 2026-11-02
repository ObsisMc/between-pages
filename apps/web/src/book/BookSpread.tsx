import type { ReactNode } from 'react';
import { Bookmark } from './Bookmark.tsx';
import { BookSurface } from './BookSurface.tsx';
import './fonts.css';
import './book.css';

/**
 * Two independent page containers on the shared book surface (book-surface D1,
 * book-frontend-workspace D1): nothing in one page reaches into the other, and the text is
 * never warped. `window`: the book is the window's height and each page scrolls inside
 * itself; `aspect` (the home page): the book keeps the reference's 3:2 and is as large as
 * fits the window, its pages scrolling inside when longer (book-fit-and-bookmark D1). Below
 * the width two pages need, they read as one sheet, left content first. The 「目录」
 * bookmark, when `ContentsBookmark` gives it one, is drawn on this book (D2).
 */
export function BookSpread({
  left,
  right,
  fit = 'window',
  className,
}: {
  left: ReactNode;
  right: ReactNode;
  fit?: 'window' | 'aspect';
  className?: string;
}) {
  return (
    <div className={['book-desk', fit, className].filter(Boolean).join(' ')}>
      <div className="book">
        <BookSurface />
        <div className="book-page book-left">
          <div className="book-scroll">{left}</div>
        </div>
        <div className="book-page book-right">
          <div className="book-scroll">{right}</div>
        </div>
        <Bookmark />
      </div>
    </div>
  );
}
