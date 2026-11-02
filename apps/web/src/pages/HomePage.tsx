import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../api/auth.ts';
import { useMe } from '../auth/me.ts';
import { BackupBanner } from '../backup/index.ts';
import { BookOpening, BookSpread } from '../book/index.ts';
import { clearPendingInvite, pendingInvite } from '../join/index.ts';
import { partnerOf, RelationshipPanel, useBinding } from '../relationship/index.ts';
import { HomeClocks } from '../two-clocks/index.ts';
import { localToday } from './today.ts';
import './home.css';

// The opening of the book (opening-book-home): the date, both clocks and the two diary
// entries, with no diary text anywhere (D1, invariant 1). Unbound, the invitation takes the
// partner's place (D5).

const dateParts = () =>
  Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  ) as Record<'month' | 'day' | 'weekday', string>;

function EntryIcon({ all = false }: { all?: boolean }) {
  return (
    <span className="home-entry-icon" aria-hidden="true">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      >
        {all ? (
          <>
            <path d="M6 6h21l-4 7H3zM6 6v6M3 13v6h21v-6M6 19l-3 7h21l4-7M24 26v-7M7 9h15" />
            <path d="M7 16h13M7 22h13" />
          </>
        ) : (
          <path d="M16 8C12 5 7 5 3 7v19c4-2 9-2 13 1 4-3 9-3 13-1V7c-4-2-9-2-13 1Zm0 0v19" />
        )}
      </svg>
    </span>
  );
}

export function HomePage() {
  const me = useMe();
  const binding = useBinding();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const bound = !!binding.data?.binding;
  const date = dateParts();

  // Login always lands here; an invitation opened before signing in continues at /join.
  useEffect(() => {
    if (pendingInvite()) void navigate('/join', { replace: true });
  }, [navigate]);

  const onSignOut = async () => {
    setFailed(false);
    try {
      await signOut();
      // Drop every cached answer and a kept invitation of the old session before showing
      // the login page.
      queryClient.clear();
      clearPendingInvite();
      await navigate('/login', { replace: true });
    } catch {
      setFailed(true);
    }
  };

  return (
    <main className="home">
      <BookSpread
        fit="aspect"
        left={
          <BookOpening together={bound}>
            <p className="home-preface">序言</p>
            <h1 className="home-date">
              <span className="home-date-month">
                {date.month}
                <span>月</span>
              </span>{' '}
              <span className="home-date-day">
                {date.day}
                <span>日</span>
              </span>
              <span className="home-weekday">{date.weekday}</span>
            </h1>
          </BookOpening>
        }
        right={
          <>
            <BackupBanner />
            <HomeClocks />
            <nav className="home-entries" aria-label="日记">
              <Link to={`/days/${localToday()}`} className="home-entry today">
                <EntryIcon />
                <span>打开今天的日记</span>
                <span className="home-entry-leader" aria-hidden="true" />
                <span className="home-entry-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
              <Link to="/days" className="home-entry all">
                <EntryIcon all />
                <span>浏览所有日记</span>
                <span className="home-entry-leader" aria-hidden="true" />
                <span className="home-entry-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </nav>
            {me.data && !bound && <RelationshipPanel userId={me.data.user.id} />}
            <p className="home-account">
              {me.data && binding.data?.binding && (
                <Link className="home-space" to={`/spaces/${binding.data.binding.space.id}`}>
                  与 {partnerOf(binding.data.binding.space, me.data.user.id).displayName} 的空间
                </Link>
              )}
              <span>已登录为 {me.data?.user.displayName}</span> ·{' '}
              <button type="button" className="home-sign-out" onClick={() => void onSignOut()}>
                退出
              </button>
            </p>
            {failed && (
              <p className="notice" role="alert">
                退出失败，请重试
              </p>
            )}
          </>
        }
      />
    </main>
  );
}
