import type { ReactNode } from 'react';
import './book.css';

/**
 * Two independent page containers with a gutter drawn by spacing and shadow
 * (book-frontend-workspace D1): nothing in one page reaches into the other, and the text is
 * never warped. Below the width two pages need, they read as one page, left content first.
 */
export function BookSpread({
  left,
  right,
  className,
}: {
  left: ReactNode;
  right: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `book ${className}` : 'book'}>
      <div className="book-page book-left">{left}</div>
      <div className="book-page book-right">{right}</div>
    </div>
  );
}
