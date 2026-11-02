import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { BookSpread } from './BookSpread.tsx';
import './book.css';

// The 「目录」 bookmark and the contents it opens (contents-spread, opening-book-home D4).
// The contents is a spread of its own over the page it was opened on, which stays mounted,
// hidden and inert below, so nothing typed or scrolled there is lost. It is a history entry
// of its own: opening it pushes the current address again with `contents` in its state, so
// the browser's back button closes it, and an entry replaces it, so back from the
// destination returns to the page the contents was opened on. The caller decides which
// entries exist; this module knows no data.

/** An entry: numbered, or with `icon` (a `contents-icon-*` name) in a group of `icons`. */
export type ContentsEntry = { to: string; label: string; badge?: ReactNode; icon?: string };
/** A group; `side: 'right'` puts it on the right page, `icons` shows icons for numbers. */
export type ContentsGroup = {
  title: string;
  entries: readonly ContentsEntry[];
  side?: 'left' | 'right';
  icons?: boolean;
};

const ContentsContext = createContext<{ close: () => void; titleId: string } | null>(null);

const useContents = () => {
  const contents = useContext(ContentsContext);
  if (!contents) throw new Error('ContentsPages renders only inside ContentsBookmark');
  return contents;
};

const isOpen = (state: unknown) =>
  typeof state === 'object' && state !== null && 'contents' in state && state.contents === true;

/**
 * `children`, the page, and with `contents` (null while signed out) the bookmark, always on
 * screen, and while open the contents over the page, which mounts only then. Opening moves
 * the focus to the contents' title and makes the page inert; back, Escape, "合上目录" or
 * the bookmark close it and the focus returns to the bookmark, unless an entry led to
 * another page.
 */
export function ContentsBookmark({
  contents,
  children,
}: {
  contents: ReactNode | null;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const open = contents !== null && isOpen(location.state);
  const titleId = useId();
  const panelId = useId();
  const bookmark = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
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
      panel.current?.querySelector<HTMLElement>(`[id="${titleId}"]`)?.focus();
      return;
    }
    if (openedOn.current === location.pathname) bookmark.current?.focus();
    openedOn.current = null;
  }, [open, location.pathname, titleId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
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
      <div className="contents-origin" inert={open}>
        {children}
      </div>
      {open && (
        <main ref={panel} id={panelId} className="contents" aria-labelledby={titleId}>
          <ContentsContext value={{ close, titleId }}>{contents}</ContentsContext>
        </main>
      )}
      {contents !== null && (
        <button
          ref={bookmark}
          type="button"
          className="bookmark"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={toggle}
        >
          目录
        </button>
      )}
    </>
  );
}

/** An entry; the page the contents covers is marked current and only closes the contents. */
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

type Placed = ContentsGroup & { order: number; first: number };

/**
 * Groups as placed: `--order` keeps the reading order on the one narrow sheet, `first` is
 * the number of the group's first entry, counted across the spread's numbered groups.
 */
function Groups({ groups }: { groups: readonly Placed[] }) {
  return groups.map((group) => (
    <section
      key={group.title}
      className={group.icons ? 'contents-group icons' : 'contents-group'}
      aria-labelledby={`contents-${group.order}`}
      style={{ '--order': group.order } as CSSProperties}
    >
      <h2 id={`contents-${group.order}`}>{group.title}</h2>
      <ul>
        {group.entries.map((entry, index) => (
          <li key={entry.to}>
            <Entry to={entry.to} className="contents-entry">
              <span
                className={
                  group.icons ? `contents-icon contents-icon-${entry.icon}` : 'contents-no'
                }
                aria-hidden="true"
              >
                {group.icons ? null : String(group.first + index).padStart(2, '0')}
              </span>
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
 * The contents as a spread (contents-spread D3): 「返回序言」, the title and the left groups
 * on the left page, the right groups and "合上目录" on the right; on narrow windows one
 * sheet with the groups in the order given. Only inside the bookmark.
 */
export function ContentsPages({ groups }: { groups: readonly ContentsGroup[] }) {
  const { close, titleId } = useContents();
  const sides = [
    ...groups.filter((group) => group.side !== 'right'),
    ...groups.filter((group) => group.side === 'right'),
  ];
  let next = 1;
  const placed = new Map<ContentsGroup, Placed>();
  for (const group of sides) {
    placed.set(group, { ...group, order: groups.indexOf(group) + 1, first: next });
    if (!group.icons) next += group.entries.length;
  }
  const ordered = groups.map((group) => placed.get(group)!);
  return (
    <BookSpread
      className="contents-book"
      left={
        <>
          <Entry to="/" className="contents-home">
            <span aria-hidden="true">← </span>返回序言
          </Entry>
          <h1 id={titleId} className="contents-title" tabIndex={-1}>
            目录
          </h1>
          <Groups groups={ordered.filter((group) => group.side !== 'right')} />
          <span className="contents-folio" aria-hidden="true">
            01
          </span>
        </>
      }
      right={
        <>
          <Groups groups={ordered.filter((group) => group.side === 'right')} />
          <button type="button" className="contents-close" onClick={close}>
            合上目录
          </button>
          <span className="contents-folio" aria-hidden="true">
            02
          </span>
        </>
      }
    />
  );
}
