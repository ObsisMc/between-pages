import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { signOut } from '../api/auth.ts';
import { ApiError, callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { DiaryList } from '../diary-list/index.ts';
import { clearPendingInvite, pendingInvite } from '../join/index.ts';
import { RelationshipPanel, partnerOf, useSpaces } from '../relationship/index.ts';
import { SharedDiaryList } from '../shared-diaries/index.ts';

/** The device's IANA zone decides which date "today" is (spec §4); the server checks it. */
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Today in `zone` as YYYY-MM-DD; only bounds the date picker, the server decides. */
const todayIn = (zone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());

/** Home behind RequireAuth: write today, open or back-fill a past day, the diary cards, sign out. */
export function HomePage() {
  const me = useMe();
  const spaces = useSpaces();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [date, setDate] = useState('');

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

  // Offline there is no way to know whether the diary exists, so nothing is created
  // locally and nothing claims to be (DATE-06).
  const openDiary = async (past?: string) => {
    setOpenError(null);
    setOpening(true);
    try {
      const { diary } = await callApi('openDiary', {
        body: { timezone: timezone(), ...(past ? { date: past } : {}) },
      });
      await navigate(`/diaries/${diary.diaryId}`);
    } catch (error) {
      setOpenError(
        !(error instanceof ApiError)
          ? '离线时无法确认要打开的日记，请联网后再试'
          : error.code === 'VALIDATION_FAILED'
            ? '只能打开今天或过去的日期'
            : '打开失败，请稍后再试',
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <main className="page home">
      <header>
        <button type="button" onClick={() => void onSignOut()}>
          退出
        </button>
      </header>
      <p className="greeting">已登录为 {me.data?.user.displayName}</p>
      <button type="button" className="primary" disabled={opening} onClick={() => void openDiary()}>
        写今天
      </button>
      <form
        className="past-date"
        onSubmit={(event) => {
          event.preventDefault();
          if (date) void openDiary(date);
        }}
      >
        <label htmlFor="past-date">打开或补写过去的日期</label>
        <input
          id="past-date"
          type="date"
          max={todayIn(timezone())}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <button type="submit" disabled={opening || !date}>
          打开
        </button>
      </form>
      {openError && (
        <p className="notice" role="alert">
          {openError}
        </p>
      )}
      {failed && (
        <p className="notice" role="alert">
          退出失败，请重试
        </p>
      )}
      {me.data && <RelationshipPanel userId={me.data.user.id} />}
      <DiaryList />
      {me.data &&
        spaces.data?.spaces.map((space) => (
          <SharedDiaryList
            key={space.id}
            spaceId={space.id}
            partner={partnerOf(space, me.data.user.id).displayName}
          />
        ))}
    </main>
  );
}
