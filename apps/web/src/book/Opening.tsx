import type { ReactNode } from 'react';

/**
 * The opening's left page (opening-book-home D3, book-surface D5): the name, `children`
 * (the home page's date), the line and the two lit watercolor windows, one per person; the
 * second window is empty without `together`. Decoration only: the image is not a control.
 */
export function BookOpening({ together, children }: { together: boolean; children?: ReactNode }) {
  return (
    <>
      <p className="opening-brand">
        <span className="opening-pair" aria-hidden="true" />
        Between Pages
      </p>
      {children}
      <p className="opening-line">不同的地方，同一片天空。</p>
      <img
        className="opening-windows"
        src={together ? '/home/windows-watercolor.webp' : '/home/windows-unbound.webp'}
        width="1536"
        height="1024"
        alt=""
      />
    </>
  );
}
