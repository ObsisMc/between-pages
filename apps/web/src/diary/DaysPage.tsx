import { Link } from 'react-router';
import { useMe } from '../auth/me.ts';
import { DayFeed } from '../day-feed/index.ts';
import { usePeople } from './DiaryPage.tsx';
import './DaysPage.css';

/**
 * `/days`: all diaries, newest first, in one column (book-frontend-workspace D3). The
 * two-page workspace puts the same feed in the right page next to the editor.
 */
export function DaysPage() {
  const user = useMe().data?.user;
  const { people } = usePeople();
  if (!user) return null;
  const partnerId = [...people.keys()].find((id) => id !== user.id);
  const partner = partnerId && people.get(partnerId);
  return (
    <main className="page days-page">
      <header className="days-page-head">
        <Link to="/">返回主页</Link>
        <h1>所有日记</h1>
      </header>
      <DayFeed
        me={{ id: user.id, name: user.displayName, slot: people.get(user.id)?.slot ?? null }}
        partner={
          partner && partnerId
            ? { id: partnerId, name: partner.name, slot: partner.slot }
            : { id: '', name: 'TA', slot: null }
        }
      />
    </main>
  );
}
