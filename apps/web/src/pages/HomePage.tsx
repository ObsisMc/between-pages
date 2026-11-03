import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowUpRight, PenLine } from 'lucide-react';
import { callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { BackupBanner } from '../backup/index.ts';
import { pendingInvite } from '../join/index.ts';
import { RelationshipPanel, useBinding, useSpaces } from '../relationship/index.ts';
import { browserZone, dayPeriod, HomeClocks, useClocks, useNow } from '../two-clocks/index.ts';
import { Button } from '../ui/index.ts';
import { PairedWindows } from '../windows/index.ts';
import { RecentDays, type HomePerson } from './RecentDays.tsx';
import { localToday } from './today.ts';

// The home (digital-paper-interface D2): the paired windows, a greeting, "继续写今天" and the
// partner's new content, the recent dates without any diary text, and both local times with
// their waking overlap (opening-book-home D2). Unbound, the invitation takes the partner's
// place (opening-book-home D5).

const dateLine = (now: number) => {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'long',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<'year' | 'month' | 'day' | 'weekday', string>;
  return `${part.year} 年 ${part.month} 月 ${part.day} 日 · ${part.weekday}`;
};

const greeting = (hour: number) =>
  hour >= 5 && hour < 11
    ? '早上好'
    : hour >= 11 && hour < 14
      ? '中午好'
      : hour >= 14 && hour < 18
        ? '下午好'
        : hour >= 18 && hour < 23
          ? '晚上好'
          : '夜深了';

export function HomePage() {
  const me = useMe();
  const binding = useBinding();
  const spaces = useSpaces();
  const clocks = useClocks();
  const now = useNow();
  const navigate = useNavigate();
  // The nearest date the partner left something the viewer has not read, from the newest.
  const unread = useQuery({
    queryKey: ['home', 'next-unread'],
    queryFn: () => callApi('nextUnread', { query: {} }),
  });

  // Login always lands here; an invitation opened before signing in continues at /join.
  useEffect(() => {
    if (pendingInvite()) void navigate('/join', { replace: true });
  }, [navigate]);

  if (!me.data) return null;
  const user = me.data.user;
  const bound = !!binding.data?.binding;
  // One fixed partner in the first release: the current space, else the archived one.
  const space = binding.data?.binding?.space ?? spaces.data?.spaces[0];
  const slotOf = (id: string) => space?.participants.find((p) => p.user.id === id)?.authorSlot;
  const partnerUser = space?.participants.find((p) => p.user.id !== user.id)?.user;
  const self: HomePerson = { name: user.displayName, tone: slotOf(user.id) ?? null };
  const partner: HomePerson = {
    name: partnerUser?.displayName ?? 'TA',
    tone: partnerUser ? (slotOf(partnerUser.id) ?? null) : null,
  };
  // The partner's sky only while bound, from the zone their browser reported (null: unknown).
  const partnerZone = clocks.data?.partner?.timezone ?? null;
  const unreadDate = unread.data?.date;

  return (
    <main className="mx-auto w-full max-w-6xl px-5 pt-8 pb-16 font-sans text-ink wrap-anywhere sm:px-8 sm:pt-12">
      <BackupBanner />
      <section className="grid items-center gap-10 md:grid-cols-[1.1fr_1fr] md:gap-14">
        <div>
          <p className="text-sm tracking-[0.2em] text-ink-soft">{dateLine(now)}</p>
          <h1 className="mt-4 font-serif text-4xl leading-tight font-medium sm:text-5xl">
            {user.displayName}，{greeting(new Date(now).getHours())}。
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-ink-soft">
            {bound ? '不同的地方，同一片天空。' : '先写给自己，也可以邀请 TA 一起。'}
            <br />
            今天，也有想留给彼此的话吗？
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button asChild className="h-12 px-6 text-base">
              <Link to={`/days/${localToday()}`} state={{ edit: true }}>
                <PenLine aria-hidden="true" />
                继续写今天
              </Link>
            </Button>
            {unreadDate && (
              <Link
                to="/days"
                state={{ feed: { date: unreadDate, offset: 0 } }}
                className="inline-flex items-center gap-1 text-base text-ink-soft underline-offset-4 hover:text-ink hover:underline"
              >
                读{partner.name}的新内容
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </Link>
            )}
          </div>
        </div>
        <div className="mx-auto w-full max-w-md">
          <PairedWindows
            left={{ tone: self.tone ?? 1, sky: dayPeriod(now, browserZone()) }}
            right={
              bound
                ? { tone: partner.tone ?? 2, sky: partnerZone ? dayPeriod(now, partnerZone) : null }
                : { tone: partner.tone ?? 2, sky: null, empty: true }
            }
          />
        </div>
      </section>

      <hr className="my-12 border-line" />

      <div className="grid gap-12 md:grid-cols-[1.15fr_1fr] md:gap-16">
        <RecentDays me={self} partner={partner} />
        <div className="space-y-10">
          <HomeClocks />
          {!bound && (
            <div className="legacy">
              <RelationshipPanel userId={user.id} />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
