import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../api/auth.ts';
import { useMe } from '../auth/me.ts';
import { BackupBanner } from '../backup/index.ts';
import { BookSpread } from '../book/index.ts';
import { clearPendingInvite, pendingInvite } from '../join/index.ts';
import { RelationshipPanel, useBinding } from '../relationship/index.ts';
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

/** Two lit windows, one per person; the second stays empty while there is no partner. */
function Windows({ together }: { together: boolean }) {
  return (
    <div className="home-windows" aria-hidden="true">
      <span className="home-window warm">
        <span className="home-figure" />
      </span>
      <span className="home-window cool">{together && <span className="home-figure" />}</span>
    </div>
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
        left={
          <>
            <p className="home-brand">
              <span className="home-pair" aria-hidden="true" />
              Between Pages
            </p>
            <p className="home-preface">序言</p>
            <h1 className="home-date">
              {date.month} 月 {date.day} 日<span className="home-weekday">{date.weekday}</span>
            </h1>
            <p className="home-line">不同的地方，同一片天空。</p>
            <Windows together={bound} />
          </>
        }
        right={
          <>
            <BackupBanner />
            <HomeClocks />
            <nav className="home-entries" aria-label="日记">
              <Link to={`/days/${localToday()}`} className="home-entry today">
                打开今天的日记
              </Link>
              <Link to="/days" className="home-entry all">
                浏览所有日记
              </Link>
            </nav>
            {me.data && <RelationshipPanel userId={me.data.user.id} />}
            <p className="home-account">
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
