import { useSyncExternalStore } from 'react';

/** Below this width the book is one page (book.css), and so is the diary screen (D6). */
const NARROW = '(max-width: 56rem)';

function onWidthChange(changed: () => void) {
  const query = globalThis.matchMedia?.(NARROW);
  query?.addEventListener('change', changed);
  return () => query?.removeEventListener('change', changed);
}
// Without matchMedia (jsdom) the window counts as wide.
const isNarrow = () => globalThis.matchMedia?.(NARROW).matches ?? false;
export const useNarrow = () => useSyncExternalStore(onWidthChange, isNarrow);
