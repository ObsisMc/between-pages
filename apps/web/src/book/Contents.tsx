import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { BookSpread } from './BookSpread.tsx';
import './book.css';

// The 「目录」 bookmark and the contents it opens (book-frontend-workspace D2,
// opening-book-home D4). The contents is a history entry of its own: opening it pushes the
// current address again with `contents` in its state, so the browser's back button closes
// it, and an entry replaces it, so back from the destination returns to the page the
// contents was opened on. The caller decides which entries exist; this module knows no data.

export type ContentsEntry = { to: string; label: string; badge?: ReactNode };
export type ContentsGroup = { title: string; entries: readonly ContentsEntry[] };

const ContentsContext = createContext<{ close: () => void; titleId: string } | null>(null);

const useContents = () => {
  const contents = useContext(ContentsContext);
  if (!contents) throw new Error('ContentsPages renders only inside ContentsBookmark');
  return contents;
};

const isOpen = (state: unknown) =>
  typeof state === 'object' && state !== null && 'contents' in state && state.contents === true;

/**
 * The bookmark, always on screen, and while open the contents as a modal layer holding
 * `children`, which mount only then. Focus moves into the contents on opening, Tab stays in
 * it, Escape, the close button, a click beside the book or back close it and focus returns
 * to the bookmark, unless an entry led to another page.
 */
export function ContentsBookmark({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const open = isOpen(location.state);
  const titleId = useId();
  const panelId = useId();
  const bookmark = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const openedOn = useRef<string | null>(null);
  // A second Escape before the first close lands must not go back one more page.
  const closing = useRef(false);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    void navigate(-1);
  }, [navigate]);

  useEffect(() => {
    closing.current = false;
    if (open) {
      openedOn.current = location.pathname;
      dialog.current?.focus();
      return;
    }
    if (openedOn.current === location.pathname) bookmark.current?.focus();
    openedOn.current = null;
  }, [open, location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const toggle = () => {
    if (open) return close();
    const { pathname, search, hash } = location;
    const state = typeof location.state === 'object' ? location.state : null;
    void navigate({ pathname, search, hash }, { state: { ...state, contents: true } });
  };

  return (
    <>
      {open && (
        <div
          className="contents-layer"
          onClick={(event: MouseEvent) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialog}
            id={panelId}
            className="contents"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={keepFocusInside}
          >
            <ContentsContext value={{ close, titleId }}>{children}</ContentsContext>
          </div>
        </div>
      )}
      <button
        ref={bookmark}
        type="button"
        className="bookmark"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        目录
      </button>
    </>
  );
}

/** Tab and Shift+Tab wrap around inside the open contents (it is modal). */
function keepFocusInside(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
  ];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** An entry; the page already showing is marked current and only closes the contents. */
function Entry({
  to,
  className,
  children,
}: {
  to: string;
  className: string;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const { close } = useContents();
  const current = to === pathname;
  return (
    <Link
      to={to}
      replace
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={
        current
          ? (event) => {
              event.preventDefault();
              close();
            }
          : undefined
      }
    >
      {children}
    </Link>
  );
}

function Groups({ groups }: { groups: readonly ContentsGroup[] }) {
  return groups.map((group) => (
    <section key={group.title} className="contents-group" aria-label={group.title}>
      <h3>{group.title}</h3>
      <ul>
        {group.entries.map((entry) => (
          <li key={entry.to}>
            <Entry to={entry.to} className="contents-entry">
              <span className="contents-label">{entry.label}</span>
              {entry.badge}
              <span className="contents-leader" aria-hidden="true" />
              <span className="contents-arrow" aria-hidden="true">
                →
              </span>
            </Entry>
          </li>
        ))}
      </ul>
    </section>
  ));
}

/**
 * The contents as a spread: 「返回序言」, the title and the first half of the groups on the
 * left page, the rest on the right; one page in narrow windows. Only inside the bookmark.
 */
export function ContentsPages({ groups }: { groups: readonly ContentsGroup[] }) {
  const { close, titleId } = useContents();
  const split = Math.ceil(groups.length / 2);
  return (
    <BookSpread
      className="contents-book"
      left={
        <>
          <Entry to="/" className="contents-home">
            <span aria-hidden="true">← </span>返回序言
          </Entry>
          <h2 id={titleId} className="contents-title">
            目录
          </h2>
          <Groups groups={groups.slice(0, split)} />
        </>
      }
      right={
        <>
          <Groups groups={groups.slice(split)} />
          <button type="button" className="contents-close" onClick={close}>
            合上目录
          </button>
        </>
      }
    />
  );
}
